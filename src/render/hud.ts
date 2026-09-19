import { bus } from '@/core/bus';
import type { BeatEvent, OverlayLayer, PlayMode, Vec2, VisionFrame } from '@/core/types';

export interface HudInfo {
  mode: PlayMode;
  songTitle: string | null;
  songRunning: boolean;
  beatsPerBar: number;
}

const PULSE_MS = 220;

/**
 * Heads-up display drawn on the overlay canvas: mode badge, song title, a
 * beat pulse with one dot per beat of the bar, and the current chord. The
 * chart timeline, score and chord badge arrive in commits 12 and 19.
 */
export class Hud implements OverlayLayer {
  private lastBeat: BeatEvent | null = null;
  private readonly unsubscribe: () => void;

  constructor(private readonly info: () => HudInfo) {
    this.unsubscribe = bus.on('song.beat', (e) => (this.lastBeat = e));
  }

  dispose(): void {
    this.unsubscribe();
  }

  draw(ctx: CanvasRenderingContext2D, frame: VisionFrame, toPx: (v: Vec2) => Vec2): void {
    const info = this.info();
    const unit = toPx({ x: 0, y: 1 }).y - toPx({ x: 0, y: 0 }).y; // px per h
    const s = unit / 480;
    const margin = 12 * s;

    ctx.save();
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    // Mode badge, top-left.
    const badge = info.mode === 'easy' ? 'EASY' : 'HARD';
    ctx.font = `700 ${Math.round(13 * s)}px system-ui, sans-serif`;
    const bw = ctx.measureText(badge).width + 14 * s;
    ctx.fillStyle = info.mode === 'easy' ? 'rgba(227,243,236,0.92)' : 'rgba(251,230,227,0.92)';
    roundRect(ctx, margin, margin, bw, 20 * s, 6 * s);
    ctx.fill();
    ctx.fillStyle = info.mode === 'easy' ? '#0f6b4c' : '#a8321f';
    ctx.fillText(badge, margin + 7 * s, margin + 4 * s);

    if (!info.songTitle) {
      ctx.restore();
      return;
    }

    // Song line under the badge.
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = `600 ${Math.round(13 * s)}px system-ui, sans-serif`;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 4 * s;
    const status = info.songRunning ? '' : ' · paused (press ▶)';
    ctx.fillText(`${info.songTitle}${status}`, margin, margin + 26 * s);

    if (!info.songRunning) {
      ctx.restore();
      return;
    }

    // Beat dots + pulse.
    const beat = this.lastBeat?.beat ?? -1;
    const age = this.lastBeat ? frame.t - this.lastBeat.t : Infinity;
    const pulse = Math.max(0, 1 - age / PULSE_MS);
    const dotR = 5 * s;
    const gap = 16 * s;
    const y0 = margin + 52 * s;
    for (let i = 0; i < info.beatsPerBar; i++) {
      const x = margin + dotR + i * gap;
      const active = i === beat;
      const r = active ? dotR * (1 + 0.8 * pulse) : dotR;
      ctx.beginPath();
      ctx.arc(x, y0, r, 0, Math.PI * 2);
      ctx.fillStyle = active ? (i === 0 ? '#ffd75c' : '#ffffff') : 'rgba(255,255,255,0.35)';
      ctx.shadowColor = active ? ctx.fillStyle : 'transparent';
      ctx.shadowBlur = active ? 12 * pulse * s : 0;
      ctx.fill();
    }

    // Bar / chord readout.
    if (this.lastBeat) {
      ctx.shadowBlur = 4 * s;
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = `${Math.round(12 * s)}px system-ui, sans-serif`;
      ctx.fillText(`bar ${this.lastBeat.bar + 1} · beat ${beat + 1}`, margin + info.beatsPerBar * gap + 4 * s, y0 - 7 * s);
      if (this.lastBeat.chord) {
        ctx.font = `700 ${Math.round(26 * s)}px system-ui, sans-serif`;
        ctx.fillStyle = '#ffd75c';
        ctx.fillText(this.lastBeat.chord, margin, y0 + 14 * s);
      }
    }
    ctx.restore();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
