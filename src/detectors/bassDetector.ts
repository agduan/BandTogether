import type { Config } from '@/app/config';
import type { BassPluckEvent, Detector, Vec2, VisionFrame } from '@/core/types';
import type { BandGeometry, NeckGeometry } from '@/core/views';
import { drawBand } from './debugOverlay';
import { bandGeometry } from './strumDetector';

/**
 * Bass plucks: the guitar's stroke across its own band, one note at a time.
 *
 * K0 seam: the band is placed and drawn, nothing is detected yet. K5 wraps
 * the shared strum detector (row 10) with the `bass` config.
 */
export class BassPluckDetector implements Detector<BassPluckEvent> {
  readonly id = 'bass.pluck';
  private aspect = 4 / 3;

  constructor(
    private readonly config: Pick<Config, 'bass' | 'filter'>,
    readonly playerId = 0,
  ) {}

  get band(): BandGeometry {
    return bandGeometry(this.config.bass, this.aspect);
  }

  get neck(): NeckGeometry {
    const { bass } = this.config;
    const { x0, y } = this.band;
    return { body: { x: x0, y }, nut: { x: bass.neckX * this.aspect, y: bass.neckY }, bins: bass.bins };
  }

  update(frame: VisionFrame): BassPluckEvent[] {
    this.aspect = frame.aspect;
    return [];
  }

  reset(): void {}

  debugDraw(ctx: CanvasRenderingContext2D, toPx: (v: Vec2) => Vec2): void {
    drawBand(ctx, toPx, this.band, '#b48cff', 'bass · pluck here');
    const { nut, body } = this.neck;
    const a = toPx(body);
    const b = toPx(nut);
    ctx.save();
    ctx.strokeStyle = 'rgba(180,140,255,0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }
}
