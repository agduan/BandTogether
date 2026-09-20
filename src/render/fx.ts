import type { Config } from '@/app/config';
import { bus } from '@/core/bus';
import type { DrumHitEvent, OverlayLayer, PadId, StrumEvent, Vec2, VisionFrame } from '@/core/types';
import type { GuitarView, InstrumentView } from '@/core/views';
import { kitGeometry, stickTip, type PadGeometry } from '@/detectors/drumHitDetector';

/**
 * Drum kit overlay: pads with their strike lines, a stick from each palm to
 * its virtual tip, a flash on the struck pad, and a small particle burst.
 * All timing uses the frame clock, so replays animate exactly as live play.
 */

const PAD_COLORS: Record<string, string> = {
  hihat: '#ffd75c',
  snare: '#ff5c8a',
  tom1: '#5cd6ff',
  tom2: '#5cd6ff',
  crash: '#8aff5c',
  kick: '#b48cff',
};
const DEFAULT_PAD_COLOR = '#ffffff';
const FLASH_MS = 150;
const PARTICLE_LIFE_MS = 450;

interface Particle {
  p: Vec2;
  v: Vec2;
  born: number;
  color: string;
}

export class DrumsFx implements OverlayLayer {
  private readonly flashes = new Map<PadId, { t: number; velocity: number }>();
  private particles: Particle[] = [];
  private readonly tips = new Map<number, Vec2>();
  private lastT = 0;
  private aspect = 4 / 3;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly config: Pick<Config, 'drum'>,
    private readonly playerId = 0,
  ) {
    this.unsubscribe = bus.on('drum.hit', (e) => this.onHit(e));
  }

  dispose(): void {
    this.unsubscribe();
  }

  onHit(e: DrumHitEvent): void {
    if (e.playerId !== this.playerId) return;
    const pad = kitGeometry(this.config.drum, this.aspect).find((p) => p.id === e.pad);
    if (!pad) return;
    this.flashes.set(e.pad, { t: e.t, velocity: e.velocity });

    // Burst where the stick actually landed: the tip nearest the strike line.
    let origin: Vec2 = { x: (pad.x0 + pad.x1) / 2, y: pad.y };
    let best = Infinity;
    for (const tip of this.tips.values()) {
      const d = Math.abs(tip.y - pad.y) + (tip.x < pad.x0 || tip.x > pad.x1 ? 1 : 0);
      if (d < best) {
        best = d;
        origin = { x: tip.x, y: pad.y };
      }
    }
    const color = PAD_COLORS[e.pad] ?? DEFAULT_PAD_COLOR;
    const n = 8 + Math.round(10 * e.velocity);
    for (let i = 0; i < n; i++) {
      const a = -Math.PI * (0.15 + 0.7 * Math.random()); // upward fan
      const s = (0.4 + 0.8 * Math.random()) * (0.5 + e.velocity);
      this.particles.push({ p: { ...origin }, v: { x: Math.cos(a) * s, y: Math.sin(a) * s }, born: e.t, color });
    }
  }

  draw(ctx: CanvasRenderingContext2D, frame: VisionFrame, toPx: (v: Vec2) => Vec2): void {
    const { drum } = this.config;
    this.aspect = frame.aspect;
    const dt = this.lastT ? Math.min(100, frame.t - this.lastT) / 1000 : 0;
    this.lastT = frame.t;

    const unit = toPx({ x: 0, y: 1 }).y - toPx({ x: 0, y: 0 }).y; // px per h
    const scale = unit / 480;

    for (const pad of kitGeometry(drum, frame.aspect)) this.drawPad(ctx, pad, frame.t, toPx, unit, scale);

    // Sticks: palm → tip on the smooth stream, so they don't jitter.
    this.tips.clear();
    for (const hand of frame.hands) {
      if (hand.playerId !== this.playerId) continue;
      const tip =
        drum.trackedPoint === 'palm' ? hand.palm : stickTip(hand.smooth, hand.palm, hand.palmSize, drum.stickLen);
      this.tips.set(hand.trackId, tip);
      const a = toPx(hand.palm);
      const b = toPx(tip);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 5 * scale;
      ctx.lineCap = 'round';
      ctx.shadowColor = '#fff';
      ctx.shadowBlur = 10 * scale;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(b.x, b.y, 6 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    this.stepParticles(ctx, frame.t, dt, toPx, scale);
  }

  private drawPad(
    ctx: CanvasRenderingContext2D,
    pad: PadGeometry,
    t: number,
    toPx: (v: Vec2) => Vec2,
    unit: number,
    scale: number,
  ): void {
    const { drum } = this.config;
    const color = PAD_COLORS[pad.id] ?? DEFAULT_PAD_COLOR;
    const flash = this.flashes.get(pad.id);
    const u = flash ? Math.min(1, (t - flash.t) / FLASH_MS) : 1;
    const pop = 1 + 0.18 * (1 - u) * (flash?.velocity ?? 0);
    const glow = 1 - u;

    const c = toPx({ x: (pad.x0 + pad.x1) / 2, y: pad.y });
    const rx = ((toPx({ x: pad.x1, y: 0 }).x - toPx({ x: pad.x0, y: 0 }).x) / 2) * pop;
    const ry = drum.padHalfHeight * unit * pop;

    ctx.save();
    ctx.lineWidth = 2.5 * scale;
    ctx.strokeStyle = color;
    ctx.fillStyle = hexWithAlpha(color, 0.18 + 0.5 * glow);
    ctx.shadowColor = color;
    ctx.shadowBlur = (8 + 24 * glow) * scale;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Strike line (what the crossing core tests against).
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(c.x - rx, c.y);
    ctx.lineTo(c.x + rx, c.y);
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.font = `600 ${Math.round(13 * scale)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(pad.id === 'tom1' ? 'tom' : pad.id, c.x, c.y - ry - 10 * scale);
    ctx.restore();
  }

  private stepParticles(
    ctx: CanvasRenderingContext2D,
    t: number,
    dt: number,
    toPx: (v: Vec2) => Vec2,
    scale: number,
  ): void {
    const GRAVITY = 2.5; // h/s²
    this.particles = this.particles.filter((p) => t - p.born < PARTICLE_LIFE_MS);
    if (!this.particles.length) return;
    ctx.save();
    for (const p of this.particles) {
      p.v.y += GRAVITY * dt;
      p.p.x += p.v.x * dt;
      p.p.y += p.v.y * dt;
      const life = 1 - (t - p.born) / PARTICLE_LIFE_MS;
      const q = toPx(p.p);
      ctx.globalAlpha = life;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(q.x, q.y, (2 + 3 * life) * scale, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

const STRUM_GLOW_MS = 440;
const GUITAR_GOLD = '#ffd46a';
const GUITAR_CORAL = '#ef6a4c';

/** Compact string band for one player; intentionally leaves most of the camera unobscured. */
export class GuitarFx implements OverlayLayer {
  private lastStrum: StrumEvent | null = null;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly playerId: number,
    private readonly view: () => InstrumentView | null,
  ) {
    this.unsubscribe = bus.on('guitar.strum', (event) => this.onStrum(event));
  }

  dispose(): void {
    this.unsubscribe();
  }

  onStrum(event: StrumEvent): void {
    if (event.playerId === this.playerId) this.lastStrum = event;
  }

  draw(ctx: CanvasRenderingContext2D, frame: VisionFrame, toPx: (v: Vec2) => Vec2): void {
    const view = this.guitarView();
    if (!view) return;

    const unit = toPx({ x: 0, y: 1 }).y - toPx({ x: 0, y: 0 }).y;
    const scale = unit / 480;
    const { band } = view;
    const age = this.lastStrum ? frame.t - this.lastStrum.t : Infinity;
    const glow = Math.max(0, 1 - age / STRUM_GLOW_MS);
    const velocity = this.lastStrum?.velocity ?? 0;

    this.drawStrings(ctx, toPx, band.x0, band.x1, band.y, frame.t, glow, velocity, scale);
    this.drawStrumZone(ctx, toPx, view, glow, velocity, scale);
    this.drawChordPill(ctx, toPx, view, glow, scale);
  }

  private guitarView(): GuitarView | null {
    const current = this.view();
    return current?.instrument === 'guitar' ? current : null;
  }

  private drawStrings(
    ctx: CanvasRenderingContext2D,
    toPx: (v: Vec2) => Vec2,
    x0: number,
    x1: number,
    y: number,
    t: number,
    glow: number,
    velocity: number,
    scale: number,
  ): void {
    const direction = this.lastStrum?.direction === 'up' ? -1 : 1;
    const elapsed = this.lastStrum ? Math.max(0, t - this.lastStrum.t) : 0;
    const phase = elapsed * 0.045 * direction;
    const amplitude = 0.006 * glow * Math.max(0.35, velocity);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.shadowColor = GUITAR_GOLD;
    ctx.shadowBlur = 12 * glow * scale;
    for (let string = 0; string < 6; string++) {
      const offset = (string - 2.5) * 0.014;
      ctx.strokeStyle = `rgba(255, 239, 194, ${0.48 + string * 0.07})`;
      ctx.lineWidth = (0.8 + string * 0.18) * scale;
      ctx.beginPath();
      const points = 28;
      for (let point = 0; point <= points; point++) {
        const u = point / points;
        const envelope = Math.sin(Math.PI * u);
        const wave = amplitude * envelope * Math.sin(u * Math.PI * 8 + phase + string * 0.55);
        const p = toPx({ x: x0 + (x1 - x0) * u, y: y + offset + wave });
        if (point === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawStrumZone(
    ctx: CanvasRenderingContext2D,
    toPx: (v: Vec2) => Vec2,
    view: GuitarView,
    glow: number,
    velocity: number,
    scale: number,
  ): void {
    const { band } = view;
    const a = toPx({ x: band.x0, y: band.y - band.halfHeight });
    const b = toPx({ x: band.x1, y: band.y + band.halfHeight });
    const centerA = toPx({ x: band.x0, y: band.y });
    const centerB = toPx({ x: band.x1, y: band.y });

    ctx.save();
    ctx.setLineDash([7 * scale, 7 * scale]);
    ctx.lineWidth = (1.2 + glow * 1.8) * scale;
    ctx.strokeStyle = `rgba(255, 212, 106, ${0.4 + 0.5 * glow})`;
    ctx.fillStyle = `rgba(255, 212, 106, ${0.035 + 0.12 * glow})`;
    ctx.shadowColor = GUITAR_GOLD;
    ctx.shadowBlur = 20 * glow * scale;
    ctx.beginPath();
    ctx.roundRect(a.x, a.y, b.x - a.x, b.y - a.y, 8 * scale);
    ctx.fill();
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.globalAlpha = 0.45 + glow * 0.55;
    ctx.beginPath();
    ctx.moveTo(centerA.x, centerA.y);
    ctx.lineTo(centerB.x, centerB.y);
    ctx.stroke();

    if (glow > 0 && this.lastStrum) {
      const down = this.lastStrum.direction === 'down';
      const x = centerA.x + (centerB.x - centerA.x) * 0.5;
      const y0 = down ? a.y : b.y;
      const y1 = down ? b.y : a.y;
      ctx.strokeStyle = GUITAR_CORAL;
      ctx.lineWidth = (3 + velocity * 7) * scale;
      ctx.globalAlpha = glow;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
      ctx.stroke();
      ctx.fillStyle = GUITAR_CORAL;
      ctx.beginPath();
      ctx.moveTo(x, y1);
      ctx.lineTo(x - 6 * scale, y1 + (down ? -8 : 8) * scale);
      ctx.lineTo(x + 6 * scale, y1 + (down ? -8 : 8) * scale);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.globalAlpha = 0.72;
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${Math.round(10 * scale)}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('STRUM HERE', (a.x + b.x) / 2, b.y + 7 * scale);
    }
    ctx.restore();
  }

  private drawChordPill(
    ctx: CanvasRenderingContext2D,
    toPx: (v: Vec2) => Vec2,
    view: GuitarView,
    glow: number,
    scale: number,
  ): void {
    const anchor = toPx({ x: view.band.x0, y: view.band.y - view.band.halfHeight });
    const label = view.chord ?? '—';
    const width = Math.max(54, 28 + label.length * 10) * scale;
    const height = 24 * scale;
    const x = anchor.x;
    const y = anchor.y - height - 7 * scale;

    ctx.save();
    ctx.fillStyle = 'rgba(16, 16, 14, 0.76)';
    ctx.strokeStyle = GUITAR_GOLD;
    ctx.lineWidth = (1.2 + glow) * scale;
    ctx.shadowColor = GUITAR_GOLD;
    ctx.shadowBlur = 10 * glow * scale;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, height / 2);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#fff5dc';
    ctx.font = `750 ${Math.round(12 * scale)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + width / 2, y + height / 2 + scale);
    ctx.restore();
  }

}

function hexWithAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}
