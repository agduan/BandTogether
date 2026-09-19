import type { Detector, OverlayLayer, Vec2, VisionFrame } from '@/core/types';
import type { BandGeometry } from '@/core/views';

/**
 * Fallback overlay for an instrument that has no art registered in
 * render/fxRegistry.ts yet: draws whatever each detector's `debugDraw` shows,
 * so a new instrument is playable (and tunable) before its FX exist.
 */
export class DebugOverlay implements OverlayLayer {
  constructor(private readonly detectors: ReadonlyArray<Detector>) {}

  draw(ctx: CanvasRenderingContext2D, _frame: VisionFrame, toPx: (v: Vec2) => Vec2): void {
    for (const det of this.detectors) det.debugDraw?.(ctx, toPx);
  }
}

/** Plain strum/pluck band: translucent box, dashed centreline, a label. For `debugDraw`. */
export function drawBand(
  ctx: CanvasRenderingContext2D,
  toPx: (v: Vec2) => Vec2,
  band: BandGeometry,
  color: string,
  label: string,
): void {
  const a = toPx({ x: band.x0, y: band.y - band.halfHeight });
  const b = toPx({ x: band.x1, y: band.y + band.halfHeight });
  const mid = toPx({ x: band.x0, y: band.y }).y;
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = color;
  ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(a.x, mid);
  ctx.lineTo(b.x, mid);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  ctx.fillText(label, a.x, a.y - 3);
  ctx.restore();
}
