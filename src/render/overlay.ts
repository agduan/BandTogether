import { HAND_CONNECTIONS, type Vec2 } from '@/core/types';

/** Display space (h-units, x in [0, aspect]) → canvas pixels. */
export function displayToPx(v: Vec2, aspect: number, width: number, height: number): Vec2 {
  return { x: (v.x / aspect) * width, y: v.y * height };
}

export interface HandStyle {
  color: string;
  lineWidth?: number;
  jointRadius?: number;
}

/**
 * Transparent canvas layered over the (CSS-mirrored) video. Everything drawn
 * here is in display space; the video underneath is already mirrored by CSS,
 * so this canvas is NOT mirrored again.
 */
export class Overlay {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  aspect = 4 / 3;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
  }

  /** Match the backing store to the element's CSS size × devicePixelRatio. Cheap when unchanged. */
  syncSize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (w > 0 && h > 0 && (this.canvas.width !== w || this.canvas.height !== h)) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  toPx = (v: Vec2): Vec2 => displayToPx(v, this.aspect, this.canvas.width, this.canvas.height);

  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Bones + joints for one hand given its 21 display-space points. */
  drawHand(points: ReadonlyArray<Vec2>, style: HandStyle): void {
    const { ctx } = this;
    const scale = this.canvas.height / 480;
    const lineWidth = (style.lineWidth ?? 3) * scale;
    const radius = (style.jointRadius ?? 4) * scale;

    ctx.save();
    ctx.strokeStyle = style.color;
    ctx.fillStyle = style.color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.shadowColor = style.color;
    ctx.shadowBlur = 8 * scale;

    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      const pa = this.toPx(points[a]);
      const pb = this.toPx(points[b]);
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
    }
    ctx.stroke();

    for (const p of points) {
      const q = this.toPx(p);
      ctx.beginPath();
      ctx.arc(q.x, q.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Small label anchored at a display-space point (e.g. handedness at the wrist). */
  drawLabel(text: string, at: Vec2, color = '#fff'): void {
    const { ctx } = this;
    const p = this.toPx(at);
    const scale = this.canvas.height / 480;
    ctx.save();
    ctx.font = `${Math.round(14 * scale)}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const pad = 4 * scale;
    const w = ctx.measureText(text).width + pad * 2;
    const h = 18 * scale;
    const centerY = p.y - 6 * scale - h / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(p.x - w / 2, p.y - h - 6 * scale, w, h);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(text, p.x, centerY);
    ctx.restore();
  }
}
