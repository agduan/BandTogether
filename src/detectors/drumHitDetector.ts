import type { Config, KitPad } from '@/app/config';
import { LM, type Detector, type DrumHitEvent, type HandFrame, type PadId, type Vec2, type VisionFrame, type Zone } from '@/core/types';
import type { CalibrationState, KitAnchor, PadGeometry } from '@/core/views';
import { VelocityBuffer } from '@/vision/filters';
import { KitAnchorTracker, kitScale, placeKit, type AnchorSample } from './anchor';
import { CrossingDetector, type CrossingOptions } from './crossingCore';
import { speedToIntensity } from './detector';
import { FULL_FRAME, type PlayerRegion } from './strumDetector';

export type DrumConfig = Pick<Config, 'drum' | 'filter'>;

/**
 * The point that strikes the pads. A virtual stick tip extends from the palm
 * along the wrist → middle-MCP direction by `stickLen · palmSize`: in a fist
 * the fingertips are curled and occluded, so the palm frame is the most
 * stable thing to build on, and the stick makes the mechanic self-explanatory
 * once it is drawn. `trackedPoint: 'palm'` is the config fallback.
 */
export function stickTip(points: ReadonlyArray<Vec2>, palm: Vec2, palmSize: number, stickLen: number): Vec2 {
  const wrist = points[LM.WRIST];
  const mcp = points[LM.MIDDLE_MCP];
  const dx = mcp.x - wrist.x;
  const dy = mcp.y - wrist.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { ...palm };
  const reach = stickLen * palmSize;
  return { x: palm.x + (dx / len) * reach, y: palm.y + (dy / len) * reach };
}

/** Strike point for one hand under the current config, from the raw stream. */
export function trackedPoint(hand: HandFrame, drum: Config['drum']): Vec2 {
  return drum.trackedPoint === 'palm' ? hand.palm : stickTip(hand.raw, hand.palm, hand.palmSize, drum.stickLen);
}

/** Pad geometry in display space for a given aspect (defined in core/views.ts). */
export type { PadGeometry };

/**
 * The fixed kit (`drum.kit`) in display space. The overlay draws from this, so
 * for a body-relative kit it is handed a config whose `kit` is the placed one
 * (see `DrumHitDetector.kit` and app/instruments.ts).
 */
export function kitGeometry(drum: Config['drum'], aspect: number): PadGeometry[] {
  return Object.entries(drum.kit).map(([id, p]) => ({ id, x0: p.x0 * aspect, x1: p.x1 * aspect, y: p.y }));
}

/** The fixed kit squeezed into a player's region (the whole frame for one player). */
function fixedKit(drum: Config['drum'], aspect: number, region: PlayerRegion): PadGeometry[] {
  const width = region.x1 - region.x0;
  return Object.entries(drum.kit).map(([id, p]) => ({
    id,
    x0: (region.x0 + p.x0 * width) * aspect,
    x1: (region.x0 + p.x1 * width) * aspect,
    y: p.y,
  }));
}

export function kitZones(drum: Config['drum'], aspect: number): Zone[] {
  return kitGeometry(drum, aspect).map((p) => ({
    id: p.id,
    x0: p.x0,
    x1: p.x1,
    y0: p.y - drum.padHalfHeight,
    y1: p.y + drum.padHalfHeight,
  }));
}

interface TrackState {
  lastSeen: number;
  /** Last hit by this hand on any pad. */
  lastFire: number;
  tip: VelocityBuffer;
  /** One crossing core per pad, keyed by pad id. */
  cores: Map<PadId, { det: CrossingDetector; opts: CrossingOptions }>;
}

const TRACK_TTL_MS = 1000;

/**
 * Drum hits: for every hand, the stick tip is fed to one CrossingDetector per
 * pad (downward only). Thresholds are read from the shared config every frame
 * so the debug panel's sliders take effect live.
 *
 * The kit is body-relative by default: a `KitAnchorTracker` places
 * `drum.layout` at a default spot inside the player's `region`; it never moves
 * by itself, `calibrate()` toggles placing it on the drummer. Every threshold
 * written in h-units scales with the kit. `drum.bodyRelative = false` is the
 * fixed `drum.kit`. Two drummers are two detectors with their own anchors.
 *
 * Extra rules on top of the crossing core:
 * - per-pad refractory across tracks (`padRefractoryMs`): two sticks landing on
 *   one pad within a few ms is one hit, not two;
 * - per-hand refractory across pads (`trackRefractoryMs`): one big stroke
 *   through two stacked lines is one hit;
 * - a segment that crosses two overlapping pads' lines in one frame resolves to
 *   the pad whose x-centre is nearest to the crossing;
 * - intensity uses the peak downward speed of the last few samples, because a
 *   hand decelerates into the imaginary surface and under-reads at contact.
 */
export class DrumHitDetector implements Detector<DrumHitEvent> {
  readonly id = 'drums.hit';
  private readonly tracks = new Map<number, TrackState>();
  private readonly lastPadFire = new Map<PadId, number>();
  private readonly tracker: KitAnchorTracker;
  private aspect = 0;
  private pads: PadGeometry[] = [];
  private placed: KitAnchor | null = null;
  /** Factor on the h-unit thresholds; 1 for the fixed kit. */
  private scale = 1;

  constructor(
    private readonly config: DrumConfig,
    private readonly playerId = 0,
    private readonly region: () => PlayerRegion = () => FULL_FRAME,
  ) {
    this.tracker = new KitAnchorTracker(() => this.config.drum.anchor);
  }

  update(frame: VisionFrame): DrumHitEvent[] {
    const { drum } = this.config;
    if (frame.aspect !== this.aspect) {
      this.aspect = frame.aspect;
      this.dropCores();
    }

    const hands = frame.hands.filter((h) => h.playerId === this.playerId);
    const tips = hands.map((h) => trackedPoint(h, drum));
    // The kit settles before the hits are read: it only moves while it is being placed, and then only while the hands rest.
    this.tracker.update(hands.map((h, i) => sampleOf(h, tips[i])), frame.t);
    this.layOut();

    const events: DrumHitEvent[] = [];
    hands.forEach((hand, i) => {
      const state = this.stateFor(hand.trackId);
      state.lastSeen = frame.t;

      const p = tips[i];
      if (hand.dt === 0) state.tip.reset();
      const status = state.tip.push(p, hand.t);
      // 'skipped' keeps the previous sample; anything but 'ok' means no usable velocity.
      const dt = status === 'ok' ? state.tip.dt : 0;
      const v = status === 'ok' ? state.tip.vInst : { x: 0, y: 0 };

      let best: { pad: PadGeometry; speed: number; dist: number } | null = null;
      for (const pad of this.pads) {
        const core = this.coreFor(state, pad);
        const hit = core.det.update(p, v, dt, hand.t);
        if (!hit) continue;
        const dist = Math.abs(hit.xAtCross - (pad.x0 + pad.x1) / 2);
        if (!best || dist < best.dist) best = { pad, speed: hit.speed, dist };
      }
      if (!best) return;

      if (hand.t - state.lastFire < drum.trackRefractoryMs) return;
      const lastFire = this.lastPadFire.get(best.pad.id) ?? -Infinity;
      if (hand.t - lastFire < drum.padRefractoryMs) return;
      this.lastPadFire.set(best.pad.id, hand.t);
      state.lastFire = hand.t;
      this.tracker.noteHit(hand.t);

      const vPeak = Math.max(best.speed, state.tip.peakDown(3));
      events.push({
        type: 'drum.hit',
        t: hand.t,
        playerId: this.playerId,
        pad: best.pad.id,
        velocity: speedToIntensity(vPeak, drum.vMin * this.scale, drum.vMax * this.scale, 0.3),
      });
    });

    for (const [id, s] of this.tracks) if (frame.t - s.lastSeen > TRACK_TTL_MS) this.tracks.delete(id);
    return events;
  }

  /** Forgets the hands, not the kit: a calibrated kit survives standby and a replay. */
  reset(): void {
    this.tracks.clear();
    this.lastPadFire.clear();
  }

  /**
   * The C key is a toggle: the first press starts placing the kit (it follows
   * the resting hands), the next pins it where it is drawn, and it never moves
   * again by itself. False with the fixed kit.
   */
  calibrate(_frame?: VisionFrame): boolean {
    if (!this.config.drum.bodyRelative) return false;
    this.tracker.toggle();
    return true;
  }

  /** Forget the placement: back to the default kit. */
  resetCalibration(): void {
    this.tracker.reset();
    this.dropCores();
    this.layOut();
  }

  /** Pads as the detector sees them right now (default 4:3 before the first frame). */
  get geometry(): PadGeometry[] {
    if (this.pads.length === 0) this.layOut();
    return this.pads;
  }

  /** Where the body-relative kit sits; null for the fixed kit. */
  get anchor(): KitAnchor | null {
    if (this.pads.length === 0) this.layOut();
    return this.placed;
  }

  get calibration(): CalibrationState {
    return this.config.drum.bodyRelative ? this.tracker.state : 'none';
  }

  /** The placed pads in `drum.kit`'s shape (x as fractions of the frame width), which is what the overlay reads. */
  get kit(): Record<string, KitPad> {
    const aspect = this.aspect || 4 / 3;
    return Object.fromEntries(this.geometry.map((p) => [p.id, { x0: p.x0 / aspect, x1: p.x1 / aspect, y: p.y }]));
  }

  /** Drawn half-height of a pad, scaled with the kit. */
  get padHalfHeight(): number {
    if (this.pads.length === 0) this.layOut();
    return this.config.drum.padHalfHeight * this.scale;
  }

  /** Current side of each pad core for a track, for the debug panel. */
  sides(trackId: number): Record<PadId, 'above' | 'below' | 'unknown'> {
    const out: Record<PadId, 'above' | 'below' | 'unknown'> = {};
    const s = this.tracks.get(trackId);
    if (s) for (const [pad, c] of s.cores) out[pad] = c.det.currentSide;
    return out;
  }

  private layOut(): void {
    const { drum } = this.config;
    const aspect = this.aspect || 4 / 3;
    if (drum.bodyRelative) {
      this.placed = this.tracker.anchor(drum.layout, aspect, this.region());
      this.pads = placeKit(this.placed, drum.layout);
      this.scale = kitScale(this.placed.unit, drum.anchor);
    } else {
      this.placed = null;
      this.pads = fixedKit(drum, aspect, this.region());
      this.scale = 1;
    }
  }

  private dropCores(): void {
    for (const s of this.tracks.values()) s.cores.clear();
  }

  private stateFor(trackId: number): TrackState {
    let s = this.tracks.get(trackId);
    if (!s) {
      const { filter } = this.config;
      s = {
        lastSeen: 0,
        lastFire: -Infinity,
        tip: new VelocityBuffer({ dtMinMs: filter.dtMinMs, dtGapMs: filter.dtGapMs, glitchClamp: filter.glitchClamp }),
        cores: new Map(),
      };
      this.tracks.set(trackId, s);
    }
    return s;
  }

  private coreFor(state: TrackState, pad: PadGeometry): { det: CrossingDetector; opts: CrossingOptions } {
    const { drum } = this.config;
    let core = state.cores.get(pad.id);
    if (!core) {
      const opts: CrossingOptions = {
        lineY: pad.y,
        x0: pad.x0,
        x1: pad.x1,
        xTolerance: drum.padTolerance * this.scale,
        direction: 'down',
        vMin: drum.vMin * this.scale,
        dirCos: drum.dirCos,
        rearmMargin: drum.rearmMargin * this.scale,
        refractoryMs: drum.refractoryMs,
        refractoryOppositeMs: 0,
        anticipateMs: drum.anticipateMs,
      };
      core = { det: new CrossingDetector(opts), opts };
      state.cores.set(pad.id, core);
    }
    // Sync live-tunable thresholds (the core reads its options object by reference).
    const o = core.opts;
    o.lineY = pad.y;
    o.x0 = pad.x0;
    o.x1 = pad.x1;
    o.xTolerance = drum.padTolerance * this.scale;
    o.vMin = drum.vMin * this.scale;
    o.dirCos = drum.dirCos;
    o.rearmMargin = drum.rearmMargin * this.scale;
    o.refractoryMs = drum.refractoryMs;
    o.anticipateMs = drum.anticipateMs;
    return core;
  }
}

function sampleOf(hand: HandFrame, tip: Vec2): AnchorSample {
  return { tip, speed: Math.hypot(hand.palmVel.x, hand.palmVel.y), palmSize: hand.palmSize };
}
