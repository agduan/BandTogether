import type { Config } from '@/app/config';
import type { BassPluckEvent, Detector, PlayerId, TrackId, Vec2, VisionFrame } from '@/core/types';
import type { BandGeometry, NeckGeometry } from '@/core/views';
import { drawBand } from './debugOverlay';
import type { RoleAssignment } from './roles';
import { FULL_FRAME, StrumDetector, type PlayerRegion, type StrokeOptions } from './strumDetector';

export type BassConfig = Pick<Config, 'bass' | 'strum' | 'filter'>;

/**
 * Bass: the shared stroke detector over `config.bass`. The guitar family has
 * one gesture, the strum, so every stroke across the bass band is one note;
 * there is no pluck gesture and no fret-hand tracking. The event keeps the
 * wire name `bass.pluck` (with `pitchBin: null`) until the K9b rename.
 */
export class BassPluckDetector implements Detector<BassPluckEvent> {
  readonly id = 'bass.pluck';
  private readonly strokes: StrumDetector;
  private aspect = 4 / 3;

  constructor(
    private readonly config: BassConfig,
    readonly playerId: PlayerId = 0,
    private readonly region: () => PlayerRegion = () => FULL_FRAME,
  ) {
    const { filter } = config;
    // Handedness and the role rules belong to the player, not the instrument: one set of keys, in `strum`.
    const strum = (k: 'lefty' | 'strummerOnly' | 'roleSwapMs') => ({ get: () => this.config.strum[k], enumerable: true });
    const opts: StrokeOptions = Object.create(config.bass, { lefty: strum('lefty'), strummerOnly: strum('strummerOnly'), roleSwapMs: strum('roleSwapMs') });
    this.strokes = new StrumDetector(() => opts, { dtMinMs: filter.dtMinMs, dtGapMs: filter.dtGapMs, glitchClamp: filter.glitchClamp }, playerId, region);
  }

  get band(): BandGeometry {
    return this.strokes.band;
  }

  /** Track ids of the strumming and fretting hands (null = not seen). */
  get roles(): RoleAssignment {
    return this.strokes.roles;
  }

  /** Unused since the bass became strum only; kept for `BassView` until K9b. */
  get neck(): NeckGeometry {
    const { bass } = this.config;
    const { x0, y } = this.band;
    const { x0: left, x1: right } = this.region();
    return { body: { x: x0, y }, nut: { x: (left + bass.neckX * (right - left)) * this.aspect, y: bass.neckY }, bins: bass.bins };
  }

  update(frame: VisionFrame): BassPluckEvent[] {
    this.aspect = frame.aspect;
    return this.strokes.update(frame).map((s) => ({
      type: 'bass.pluck',
      t: s.t,
      playerId: this.playerId,
      direction: s.direction,
      velocity: s.velocity,
      pitchBin: null,
    }));
  }

  reset(): void {
    this.strokes.reset();
  }

  side(trackId: TrackId): 'above' | 'below' | 'unknown' {
    return this.strokes.side(trackId);
  }

  debugDraw(ctx: CanvasRenderingContext2D, toPx: (v: Vec2) => Vec2): void {
    drawBand(ctx, toPx, this.band, '#b48cff', 'bass · strum here');
  }
}
