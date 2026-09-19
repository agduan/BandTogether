import type { Config } from '@/app/config';
import type { Detector, StrumEvent, Vec2, VisionFrame } from '@/core/types';
import type { BandGeometry } from '@/core/views';
import { drawBand } from './debugOverlay';

/** Band layout as written in the config: fractions of the frame. */
export interface BandLayout {
  bandY: number;
  bandHalfHeight: number;
  bandXMin: number;
  bandXMax: number;
}

/** Config band → display space for a given aspect. Shared by the guitar and the bass. */
export function bandGeometry(layout: BandLayout, aspect: number): BandGeometry {
  return { x0: layout.bandXMin * aspect, x1: layout.bandXMax * aspect, y: layout.bandY, halfHeight: layout.bandHalfHeight };
}

/**
 * Guitar strums across the strings band.
 *
 * K0 seam: the band is placed and drawn, nothing is detected yet. Row 10
 * fills in the stroke detection on the crossing core (direction 'both').
 */
export class GuitarStrumDetector implements Detector<StrumEvent> {
  readonly id = 'guitar.strum';
  private aspect = 4 / 3;

  constructor(
    private readonly config: Pick<Config, 'strum' | 'filter'>,
    readonly playerId = 0,
  ) {}

  get band(): BandGeometry {
    return bandGeometry(this.config.strum, this.aspect);
  }

  update(frame: VisionFrame): StrumEvent[] {
    this.aspect = frame.aspect;
    return [];
  }

  reset(): void {}

  debugDraw(ctx: CanvasRenderingContext2D, toPx: (v: Vec2) => Vec2): void {
    drawBand(ctx, toPx, this.band, '#ffd75c', 'guitar · strum here');
  }
}
