import type { Config } from '@/app/config';
import { LM, type Detector, type DrumHitEvent, type HandFrame, type PadId, type Vec2, type VisionFrame, type Zone } from '@/core/types';
import { VelocityBuffer } from '@/vision/filters';
import { CrossingDetector, type CrossingOptions } from './crossingCore';
import { speedToIntensity } from './detector';

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

/** Pad geometry in display space for a given aspect. */
export interface PadGeometry {
  id: PadId;
  x0: number;
  x1: number;
  y: number;
}

export function kitGeometry(drum: Config['drum'], aspect: number): PadGeometry[] {
  return Object.entries(drum.kit).map(([id, p]) => ({ id, x0: p.x0 * aspect, x1: p.x1 * aspect, y: p.y }));
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
 * Extra rules on top of the crossing core:
 * - per-pad refractory across tracks (`padRefractoryMs`): two sticks landing on
 *   one pad within a few ms is one hit, not two;
 * - a segment that crosses two overlapping pads' lines in one frame resolves to
 *   the pad whose x-centre is nearest to the crossing;
 * - intensity uses the peak downward speed of the last few samples, because a
 *   hand decelerates into the imaginary surface and under-reads at contact.
 */
export class DrumHitDetector implements Detector<DrumHitEvent> {
  readonly id = 'drums.hit';
  private readonly tracks = new Map<number, TrackState>();
  private readonly lastPadFire = new Map<PadId, number>();
  private aspect = 0;
  private pads: PadGeometry[] = [];

  constructor(
    private readonly config: DrumConfig,
    private readonly playerId = 0,
  ) {}

  update(frame: VisionFrame): DrumHitEvent[] {
    const { drum } = this.config;
    if (frame.aspect !== this.aspect) {
      this.aspect = frame.aspect;
      this.pads = kitGeometry(drum, frame.aspect);
      for (const s of this.tracks.values()) s.cores.clear();
    }

    const events: DrumHitEvent[] = [];
    for (const hand of frame.hands) {
      if (hand.playerId !== this.playerId) continue;
      const state = this.stateFor(hand.trackId);
      state.lastSeen = frame.t;

      const p = trackedPoint(hand, drum);
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
      if (!best) continue;

      const lastFire = this.lastPadFire.get(best.pad.id) ?? -Infinity;
      if (hand.t - lastFire < drum.padRefractoryMs) continue;
      this.lastPadFire.set(best.pad.id, hand.t);

      const vPeak = Math.max(best.speed, state.tip.peakDown(3));
      events.push({
        type: 'drum.hit',
        t: hand.t,
        playerId: this.playerId,
        pad: best.pad.id,
        velocity: speedToIntensity(vPeak, drum.vMin, drum.vMax, 0.3),
      });
    }

    for (const [id, s] of this.tracks) if (frame.t - s.lastSeen > TRACK_TTL_MS) this.tracks.delete(id);
    return events;
  }

  reset(): void {
    this.tracks.clear();
    this.lastPadFire.clear();
  }

  /** Current side of each pad core for a track, for the debug panel. */
  sides(trackId: number): Record<PadId, 'above' | 'below' | 'unknown'> {
    const out: Record<PadId, 'above' | 'below' | 'unknown'> = {};
    const s = this.tracks.get(trackId);
    if (s) for (const [pad, c] of s.cores) out[pad] = c.det.currentSide;
    return out;
  }

  private stateFor(trackId: number): TrackState {
    let s = this.tracks.get(trackId);
    if (!s) {
      const { filter } = this.config;
      s = {
        lastSeen: 0,
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
        xTolerance: drum.padTolerance,
        direction: 'down',
        vMin: drum.vMin,
        dirCos: drum.dirCos,
        rearmMargin: drum.rearmMargin,
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
    o.xTolerance = drum.padTolerance;
    o.vMin = drum.vMin;
    o.dirCos = drum.dirCos;
    o.rearmMargin = drum.rearmMargin;
    o.refractoryMs = drum.refractoryMs;
    o.anticipateMs = drum.anticipateMs;
    return core;
  }
}
