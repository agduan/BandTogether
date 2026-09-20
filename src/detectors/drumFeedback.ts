import type { Config } from '@/app/config';
import { isInTime } from '@/audio/groove';
import { easyDrumSample } from '@/audio/modes';
import { bus } from '@/core/bus';
import type { DrumHitEvent, OverlayLayer, PlayerId, PlayMode, SongContext, Vec2, VisionFrame } from '@/core/types';
import type { PadGeometry } from './drumHitDetector';
import { FULL_FRAME, type PlayerRegion } from './strumDetector';

/**
 * What a drummer is told about their hits, drawn over the kit art and only
 * inside that player's part of the screen (a half when two play):
 * - an outline that flashes green for a hit in time and red for one that is
 *   not, while a song runs;
 * - a kick drum that lights up when an easy-mode hit sounds the kick (the
 *   body-relative kit has no kick pad for the art to light).
 * What the mode does is explained in words under the Mode toggle (App.tsx).
 * Lives here, not in src/render, for the same reason as `BassOverlay`.
 */

const GOOD = '#3dff8a';
const BAD = '#ff4d5e';
const KICK = '#b48cff';
const KICK_FLASH_MS = 180;
/** The kick drum is drawn under the kit, but never lower than this (the player badge sits below). */
const KICK_Y_MAX = 0.79;

export type HitVerdict = 'good' | 'bad';

/** Is this hit judged, and how? Null when there is nothing to be in time with, or the mode is not judged. */
export function judgeHit(song: SongContext, mode: PlayMode, feedback: Config['drum']['feedback']): HitVerdict | null {
  if (!feedback.enabled || song.bpm <= 0) return null;
  if (mode === 'hard' && !feedback.hardMode) return null;
  return isInTime(song.beat + song.beatPhase, feedback.window) ? 'good' : 'bad';
}

export interface DrumFeedbackDeps {
  config: Pick<Config, 'drum'>;
  playerId: PlayerId;
  song: () => SongContext;
  mode: () => PlayMode;
  region: () => PlayerRegion;
  /** The player's placed pads, display space. */
  pads: () => PadGeometry[];
  padHalfHeight: () => number;
}

export class DrumFeedbackOverlay implements OverlayLayer {
  private verdict: { kind: HitVerdict; t: number } | null = null;
  private kick: { t: number; velocity: number } | null = null;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: DrumFeedbackDeps) {
    this.unsubscribe = bus.on('drum.hit', (e) => this.onHit(e));
  }

  dispose(): void {
    this.unsubscribe();
  }

  /** The last verdict, for tests and the debug panel. */
  get lastVerdict(): HitVerdict | null {
    return this.verdict?.kind ?? null;
  }

  onHit(e: DrumHitEvent): void {
    if (e.playerId !== this.deps.playerId) return;
    const song = this.deps.song();
    const mode = this.deps.mode();
    const kind = judgeHit(song, mode, this.deps.config.drum.feedback);
    if (kind) this.verdict = { kind, t: e.t };
    const sounded = mode === 'easy' ? easyDrumSample(e.pad, song) : e.pad;
    if (sounded === 'kick' && !this.deps.pads().some((p) => p.id === 'kick')) this.kick = { t: e.t, velocity: e.velocity };
  }

  draw(ctx: CanvasRenderingContext2D, frame: VisionFrame, toPx: (v: Vec2) => Vec2): void {
    const region = this.deps.region() ?? FULL_FRAME;
    const a = toPx({ x: region.x0 * frame.aspect, y: 0 });
    const b = toPx({ x: region.x1 * frame.aspect, y: 1 });
    const scale = (b.y - a.y) / 480;
    this.drawOutline(ctx, frame.t, a, b, scale);
    this.drawKick(ctx, frame.t, toPx, scale);
  }

  private drawOutline(ctx: CanvasRenderingContext2D, t: number, a: Vec2, b: Vec2, scale: number): void {
    if (!this.verdict) return;
    const { flashMs } = this.deps.config.drum.feedback;
    const u = (t - this.verdict.t) / flashMs;
    if (u < 0 || u >= 1) return;
    const color = this.verdict.kind === 'good' ? GOOD : BAD;
    const width = 10 * scale;
    ctx.save();
    ctx.globalAlpha = (1 - u) * 0.95;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.shadowColor = color;
    ctx.shadowBlur = 28 * scale;
    ctx.beginPath();
    ctx.roundRect(a.x + width / 2, a.y + width / 2, b.x - a.x - width, b.y - a.y - width, 14 * scale);
    ctx.stroke();
    ctx.restore();
  }

  /** A kick drum under the middle of the kit, visible only while it rings. */
  private drawKick(ctx: CanvasRenderingContext2D, t: number, toPx: (v: Vec2) => Vec2, scale: number): void {
    if (!this.kick) return;
    const u = (t - this.kick.t) / KICK_FLASH_MS;
    const pads = this.deps.pads();
    if (u < 0 || u >= 1 || pads.length === 0) return;
    const half = this.deps.padHalfHeight();
    const x0 = Math.min(...pads.map((p) => p.x0));
    const x1 = Math.max(...pads.map((p) => p.x1));
    const low = Math.max(...pads.map((p) => p.y));
    const kickY = Math.min(KICK_Y_MAX, low + half * 2.6);
    const c = toPx({ x: (x0 + x1) / 2, y: kickY });
    const edge = toPx({ x: (x0 + x1) / 2 + (x1 - x0) / 8, y: kickY + half });
    const pop = 1 + 0.18 * (1 - u) * this.kick.velocity;
    ctx.save();
    ctx.globalAlpha = 1 - u;
    ctx.lineWidth = 2.5 * scale;
    ctx.strokeStyle = KICK;
    ctx.fillStyle = 'rgba(180, 140, 255, 0.55)';
    ctx.shadowColor = KICK;
    ctx.shadowBlur = 28 * scale;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, Math.abs(edge.x - c.x) * pop, Math.abs(edge.y - c.y) * pop, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${Math.round(13 * scale)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('kick', c.x, c.y);
    ctx.restore();
  }
}
