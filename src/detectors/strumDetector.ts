import type { Config } from '@/app/config';
import type { Detector, PlayerId, StrumDirection, StrumEvent, TrackId, Vec2, VisionFrame } from '@/core/types';
import type { BandGeometry } from '@/core/views';
import { VelocityBuffer, type VelocityOptions } from '@/vision/filters';
import { CrossingDetector, type CrossingOptions } from './crossingCore';
import { drawBand } from './debugOverlay';
import { clamp, speedToIntensity } from './detector';
import { DEFAULT_ROLE_OPTIONS, RoleAssigner, type RoleAssignment } from './roles';

/** Band layout as written in the config: fractions of the player's region. */
export interface BandLayout {
  bandY: number;
  bandHalfHeight: number;
  bandXMin: number;
  bandXMax: number;
  /** Left-handed player: the band is mirrored inside the region. */
  lefty?: boolean;
}

/**
 * The slice of the frame one player owns, as fractions of the width. One
 * player owns all of it; row 16 hands each of two players a half, so a band
 * written as 0.53–0.81 lands inside the guitarist's half instead of the drummer's.
 */
export interface PlayerRegion {
  x0: number;
  x1: number;
}

export const FULL_FRAME: PlayerRegion = { x0: 0, x1: 1 };

/** Config band → display space for a given aspect. Shared by the guitar and the bass. */
export function bandGeometry(layout: BandLayout, aspect: number, region: PlayerRegion = FULL_FRAME): BandGeometry {
  const lo = layout.lefty ? 1 - layout.bandXMax : layout.bandXMin;
  const hi = layout.lefty ? 1 - layout.bandXMin : layout.bandXMax;
  const width = region.x1 - region.x0;
  return {
    x0: (region.x0 + lo * width) * aspect,
    x1: (region.x0 + hi * width) * aspect,
    y: layout.bandY,
    halfHeight: layout.bandHalfHeight,
  };
}

/** Everything a stroke detector tunes. `config.strum` and `config.bass` both satisfy it; read live every frame. */
export interface StrokeOptions extends BandLayout {
  /** Schmitt half-band around the centreline (h). */
  hyst: number;
  vMin: number;
  vMax: number;
  /** Intensity of the softest stroke that still fires. */
  floor: number;
  refractorySameMs: number;
  refractoryOppositeMs: number;
  /** Fire on a speed onset inside the band instead of on a centreline crossing (for tiny motions). */
  useVelocityOnset?: boolean;
  /** Only the hand holding the strum role fires (default true). */
  strummerOnly?: boolean;
  /** Role stickiness (ms), default 500. */
  roleSwapMs?: number;
}

/** One stroke across the band, before it becomes a strum or a pluck. */
export interface Stroke {
  t: number;
  trackId: TrackId;
  direction: StrumDirection;
  /** 0..1 */
  velocity: number;
  /** Where along the strings it crossed: 0 = neck end of the band, 1 = bridge end. */
  u: number;
}

/** Slack past either end of the band that still counts (h). */
const BAND_X_TOLERANCE = 0.05;
/** Velocity-onset fallback: how far above and below the band a stroke may start (h). */
const ONSET_MARGIN = 0.1;
/** Velocity-onset fallback: the hand must slow to this fraction of vMin (or reverse) to re-arm. */
const ONSET_REARM = 0.5;
const TRACK_TTL_MS = 1000;

interface TrackState {
  lastSeen: number;
  palm: VelocityBuffer;
  core: { det: CrossingDetector; opts: CrossingOptions };
  /** Velocity-onset fallback: direction of the stroke in flight, null = armed. */
  onsetDir: StrumDirection | null;
}

/**
 * Strokes across a horizontal strings band, shared by the guitar (strums) and
 * the bass (plucks). The palm centre of each hand feeds one CrossingDetector in
 * 'both' mode: a Schmitt trigger on the band's centreline, so a hand wobbling
 * ±0.05 h around the strings still alternates down / up, which is what sloppy
 * air-strumming looks like.
 *
 * On top of the crossing core:
 * - roles (detectors/roles.ts): every hand is tracked so its side is always
 *   warm, but only the strummer fires unless `strummerOnly` is off. A stroke
 *   from the other hand while the strummer is idle takes the role and fires,
 *   so a wrong handedness label can never silence the guitar;
 * - the speed gate reads the peak of the last few samples in the stroke's
 *   direction, because a small stroke is already slowing down by the time it
 *   clears the hysteresis band;
 * - refractories are per band, not per hand, so two flailing hands cannot
 *   machine-gun the same direction;
 * - `useVelocityOnset` swaps the trigger for a speed onset inside the band,
 *   for players whose strokes never reach the centreline.
 */
export class StrumDetector {
  private readonly tracks = new Map<TrackId, TrackState>();
  private readonly roleAssigner: RoleAssigner;
  private lastFire: Record<StrumDirection, number> = { down: -Infinity, up: -Infinity };
  private aspect = 4 / 3;

  constructor(
    private readonly opts: () => StrokeOptions,
    private readonly velocity: VelocityOptions,
    readonly playerId: PlayerId = 0,
    private readonly region: () => PlayerRegion = () => FULL_FRAME,
  ) {
    this.roleAssigner = new RoleAssigner(() => {
      const o = this.opts();
      return { ...DEFAULT_ROLE_OPTIONS, lefty: o.lefty ?? false, swapMs: o.roleSwapMs ?? DEFAULT_ROLE_OPTIONS.swapMs };
    });
  }

  /** The band in display space at the latest frame's aspect (4:3 before the first frame). */
  get band(): BandGeometry {
    return bandGeometry(this.opts(), this.aspect, this.region());
  }

  get roles(): RoleAssignment {
    return this.roleAssigner.roles;
  }

  update(frame: VisionFrame): Stroke[] {
    this.aspect = frame.aspect;
    const o = this.opts();
    const band = this.band;
    const hands = frame.hands.filter((h) => h.playerId === this.playerId);
    this.roleAssigner.assign(hands, band, frame.t);

    const strokes: Stroke[] = [];
    for (const hand of hands) {
      const state = this.stateFor(hand.trackId, band, o);
      state.lastSeen = frame.t;

      if (hand.dt === 0) state.palm.reset();
      const status = state.palm.push(hand.palm, hand.t);
      if (status === 'skipped') continue; // duplicate timestamp: keep the previous sample
      const ok = status === 'ok';
      const dt = ok ? state.palm.dt : 0;
      const vInst = ok ? state.palm.vInst : { x: 0, y: 0 };
      // Peak speed of the last few samples in the direction of travel (h/s).
      const peak = vInst.y >= 0 ? state.palm.peakDown(3) : state.palm.peakUp(3);

      // The trigger not in use is kept reset, so flipping the flag live cannot fire from stale state.
      if (o.useVelocityOnset) state.core.det.reset();
      else state.onsetDir = null;
      const hit = o.useVelocityOnset
        ? this.onset(state, hand.palm, vInst, ok, band, o)
        : this.crossing(state, hand.palm, { x: vInst.x, y: Math.sign(vInst.y) * peak }, dt, hand.t);
      if (!hit) continue;
      if ((o.strummerOnly ?? true) && !this.roleAssigner.claim(hand.trackId, hand.t)) continue;

      const other: StrumDirection = hit.direction === 'down' ? 'up' : 'down';
      if (hand.t - this.lastFire[hit.direction] < o.refractorySameMs) continue;
      if (hand.t - this.lastFire[other] < o.refractoryOppositeMs) continue;
      this.lastFire[hit.direction] = hand.t;
      this.roleAssigner.noteStroke(hand.trackId, hand.t);

      const along = clamp((hit.x - band.x0) / Math.max(1e-6, band.x1 - band.x0), 0, 1);
      strokes.push({
        t: hand.t,
        trackId: hand.trackId,
        direction: hit.direction,
        velocity: speedToIntensity(peak, o.vMin, o.vMax, o.floor),
        u: o.lefty ? 1 - along : along,
      });
    }

    for (const [id, s] of this.tracks) if (frame.t - s.lastSeen > TRACK_TTL_MS) this.tracks.delete(id);
    return strokes;
  }

  reset(): void {
    this.tracks.clear();
    this.roleAssigner.reset();
    this.lastFire = { down: -Infinity, up: -Infinity };
  }

  /** Which side of the centreline a track is on, for the debug panel. */
  side(trackId: TrackId): 'above' | 'below' | 'unknown' {
    return this.tracks.get(trackId)?.core.det.currentSide ?? 'unknown';
  }

  /** Default trigger: the palm crosses the centreline (Schmitt, both directions). */
  private crossing(state: TrackState, p: Vec2, v: Vec2, dt: number, t: number): { direction: StrumDirection; x: number } | null {
    const hit = state.core.det.update(p, v, dt, t);
    return hit ? { direction: hit.direction, x: hit.xAtCross } : null;
  }

  /** Fallback trigger: vertical speed rises past vMin while the palm is inside the (padded) band. */
  private onset(state: TrackState, p: Vec2, v: Vec2, ok: boolean, band: BandGeometry, o: StrokeOptions): { direction: StrumDirection; x: number } | null {
    if (!ok) {
      state.onsetDir = null;
      return null;
    }
    const speed = Math.abs(v.y);
    const dir: StrumDirection = v.y >= 0 ? 'down' : 'up';
    if (state.onsetDir !== null && (speed < o.vMin * ONSET_REARM || dir !== state.onsetDir)) state.onsetDir = null;
    if (state.onsetDir !== null || speed < o.vMin) return null;

    const reach = band.halfHeight + ONSET_MARGIN;
    const inside = Math.abs(p.y - band.y) <= reach && p.x >= band.x0 - BAND_X_TOLERANCE && p.x <= band.x1 + BAND_X_TOLERANCE;
    if (!inside) return null;
    state.onsetDir = dir;
    return { direction: dir, x: p.x };
  }

  private stateFor(trackId: TrackId, band: BandGeometry, o: StrokeOptions): TrackState {
    let s = this.tracks.get(trackId);
    if (!s) {
      const opts: CrossingOptions = {
        lineY: band.y,
        x0: band.x0,
        x1: band.x1,
        xTolerance: BAND_X_TOLERANCE,
        direction: 'both',
        vMin: o.vMin,
        // No direction cone: a strum is an arc, and the band is wide on purpose.
        dirCos: 0,
        rearmMargin: o.hyst,
        // Refractories are applied per band in `update`, across hands.
        refractoryMs: 0,
        refractoryOppositeMs: 0,
        anticipateMs: 0,
      };
      s = { lastSeen: 0, palm: new VelocityBuffer(this.velocity), core: { det: new CrossingDetector(opts), opts }, onsetDir: null };
      this.tracks.set(trackId, s);
    }
    // Sync live-tunable thresholds and the band (the core reads its options object by reference).
    const c = s.core.opts;
    c.lineY = band.y;
    c.x0 = band.x0;
    c.x1 = band.x1;
    c.vMin = o.vMin;
    c.rearmMargin = o.hyst;
    return s;
  }
}

export type StrumConfig = Pick<Config, 'strum' | 'filter'>;

/**
 * Guitar strums: the shared stroke detector over `config.strum`. There is no
 * chord classifier, so `chord` is always null and the mode resolves the chart
 * chord from the song clock.
 */
export class GuitarStrumDetector implements Detector<StrumEvent> {
  readonly id = 'guitar.strum';
  private readonly strokes: StrumDetector;

  constructor(
    private readonly config: StrumConfig,
    readonly playerId: PlayerId = 0,
    region?: () => PlayerRegion,
  ) {
    const { filter } = config;
    this.strokes = new StrumDetector(
      () => this.config.strum,
      { dtMinMs: filter.dtMinMs, dtGapMs: filter.dtGapMs, glitchClamp: filter.glitchClamp },
      playerId,
      region,
    );
  }

  get band(): BandGeometry {
    return this.strokes.band;
  }

  /** Track ids of the strumming and fretting hands (null = not seen). */
  get roles(): RoleAssignment {
    return this.strokes.roles;
  }

  update(frame: VisionFrame): StrumEvent[] {
    return this.strokes.update(frame).map((s) => ({
      type: 'guitar.strum',
      t: s.t,
      playerId: this.playerId,
      direction: s.direction,
      velocity: s.velocity,
      chord: null,
      u: s.u,
    }));
  }

  reset(): void {
    this.strokes.reset();
  }

  side(trackId: TrackId): 'above' | 'below' | 'unknown' {
    return this.strokes.side(trackId);
  }

  debugDraw(ctx: CanvasRenderingContext2D, toPx: (v: Vec2) => Vec2): void {
    drawBand(ctx, toPx, this.band, '#ffd75c', 'guitar · strum here');
  }
}
