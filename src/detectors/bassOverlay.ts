import { bus } from '@/core/bus';
import type { BassPluckEvent, OverlayLayer, PlayerId, Vec2, VisionFrame } from '@/core/types';
import type { BassView, InstrumentView } from '@/core/views';

const STRUM_GLOW_MS = 440;
/** A stroke may be stamped this far ahead of the frame clock and still show (ms). */
const CLOCK_SLACK_MS = 500;
const BASS_VIOLET = '#b48cff';
const BASS_CORAL = '#ef6a4c';

/** How far a full-velocity stroke swings the string (h), and how many half-waves stand on it. */
const SWING = 0.022;
const HALF_WAVES = 3;

/**
 * The bass as the player sees it, until render/fxRegistry.ts registers art of
 * its own for `bass` (that art then replaces this with no edit here). It is
 * the guitar's overlay with one string: the strum zone, a thick string that
 * swings and glows on every stroke, an arrow in the stroke's direction, and a
 * pill with the root that a stroke plays. Drawn from the instrument view, so
 * each bassist gets their own, wherever they placed it.
 */
export class BassOverlay implements OverlayLayer {
  private last: BassPluckEvent | null = null;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly playerId: PlayerId,
    private readonly view: () => InstrumentView | null,
  ) {
    this.unsubscribe = bus.on('bass.pluck', (e) => {
      if (e.playerId === this.playerId) this.last = e;
    });
  }

  dispose(): void {
    this.unsubscribe();
  }

  /** 0..1: how brightly the latest stroke still shows at `t`. */
  glowAt(t: number): number {
    if (!this.last) return 0;
    const age = t - this.last.t;
    // An injected stroke is stamped a little ahead of the camera frame being drawn: that is age 0.
    // A clock that really ran backwards (looping replay) must not leave the glow stuck on.
    if (age < -CLOCK_SLACK_MS) return 0;
    return Math.max(0, 1 - Math.max(0, age) / STRUM_GLOW_MS);
  }

  draw(ctx: CanvasRenderingContext2D, frame: VisionFrame, toPx: (v: Vec2) => Vec2): void {
    const view = this.view();
    if (view?.instrument !== 'bass') return;
    const scale = (toPx({ x: 0, y: 1 }).y - toPx({ x: 0, y: 0 }).y) / 480;
    const glow = this.glowAt(frame.t);
    const velocity = this.last?.velocity ?? 0;
    this.drawZone(ctx, toPx, view, glow, velocity, scale);
    this.drawString(ctx, toPx, view, frame.t, glow, velocity, scale);
    this.drawPill(ctx, toPx, view, glow, scale);
  }

  private drawZone(ctx: CanvasRenderingContext2D, toPx: (v: Vec2) => Vec2, { band }: BassView, glow: number, velocity: number, scale: number): void {
    const a = toPx({ x: band.x0, y: band.y - band.halfHeight });
    const b = toPx({ x: band.x1, y: band.y + band.halfHeight });
    ctx.save();
    ctx.setLineDash([7 * scale, 7 * scale]);
    ctx.lineWidth = (1.2 + glow * 1.8) * scale;
    ctx.strokeStyle = `rgba(180, 140, 255, ${0.4 + 0.5 * glow})`;
    ctx.fillStyle = `rgba(180, 140, 255, ${0.035 + 0.12 * glow})`;
    ctx.shadowColor = BASS_VIOLET;
    ctx.shadowBlur = 20 * glow * scale;
    ctx.beginPath();
    ctx.roundRect(a.x, a.y, b.x - a.x, b.y - a.y, 8 * scale);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);

    if (glow > 0 && this.last) {
      const down = this.last.direction === 'down';
      const x = (a.x + b.x) / 2;
      const y0 = down ? a.y : b.y;
      const y1 = down ? b.y : a.y;
      ctx.strokeStyle = BASS_CORAL;
      ctx.fillStyle = BASS_CORAL;
      ctx.lineWidth = (3 + velocity * 7) * scale;
      ctx.globalAlpha = glow;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y1);
      ctx.lineTo(x - 6 * scale, y1 + (down ? -8 : 8) * scale);
      ctx.lineTo(x + 6 * scale, y1 + (down ? -8 : 8) * scale);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 0.72;
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${Math.round(10 * scale)}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('STRUM HERE', (a.x + b.x) / 2, a.y - 7 * scale);
    }
    ctx.restore();
  }

  /** One heavy string on the band's centreline; a stroke sets it swinging, and the swing dies with the glow. */
  private drawString(ctx: CanvasRenderingContext2D, toPx: (v: Vec2) => Vec2, { band }: BassView, t: number, glow: number, velocity: number, scale: number): void {
    const direction = this.last?.direction === 'up' ? -1 : 1;
    const elapsed = this.last ? Math.max(0, t - this.last.t) : 0;
    const amplitude = SWING * glow * Math.max(0.35, velocity) * direction * Math.cos(elapsed * 0.045);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.shadowColor = BASS_VIOLET;
    ctx.shadowBlur = (4 + 18 * glow) * scale;
    ctx.strokeStyle = `rgba(233, 222, 255, ${0.7 + 0.3 * glow})`;
    ctx.lineWidth = (3 + 2 * glow) * scale;
    ctx.beginPath();
    const points = 28;
    for (let i = 0; i <= points; i++) {
      const u = i / points;
      // A standing wave: fixed at both ends, a few slow half-waves in between (a bass string is long and heavy).
      const p = toPx({ x: band.x0 + (band.x1 - band.x0) * u, y: band.y + amplitude * Math.sin(Math.PI * u) * Math.cos(Math.PI * (HALF_WAVES - 1) * u) });
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawPill(ctx: CanvasRenderingContext2D, toPx: (v: Vec2) => Vec2, view: BassView, glow: number, scale: number): void {
    const anchor = toPx({ x: view.band.x0, y: view.band.y - view.band.halfHeight });
    const label = view.root ?? '—';
    const width = Math.max(54, 28 + label.length * 10) * scale;
    const height = 24 * scale;
    const x = anchor.x;
    const y = anchor.y - height - 7 * scale;
    ctx.save();
    ctx.fillStyle = 'rgba(16, 16, 14, 0.76)';
    ctx.strokeStyle = BASS_VIOLET;
    ctx.lineWidth = (1.2 + glow) * scale;
    ctx.shadowColor = BASS_VIOLET;
    ctx.shadowBlur = 10 * glow * scale;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, height / 2);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#f1e9ff';
    ctx.font = `750 ${Math.round(12 * scale)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + width / 2, y + height / 2 + scale);
    ctx.restore();
  }
}
