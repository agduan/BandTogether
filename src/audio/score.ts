import type { Config } from '@/app/config';
import { EMPTY_SCORE, type Judgement, type ScoreInfo } from '@/app/sessionInfo';
import type { InstrumentEvent, InstrumentId, PlayerId, SongContext } from '@/core/types';

/**
 * On-beat judging. Pure arithmetic plus two small bookkeeping classes, free of
 * Tone.js and the bus so everything here runs in unit tests. The session feeds
 * it every sounding event; the HUD only reads the numbers from `session.info()`.
 */

export type ScoreConfig = Config['score'];

export interface Judged {
  judgement: Judgement;
  /** Signed distance to the nearest grid line, ms (negative = early). */
  offsetMs: number;
}

/**
 * The windows never cover more than this share of the gap between two grid
 * lines. Without it a fast song makes `goodMs` wider than half the gap and
 * nothing can miss (120 bpm eighths are 250 ms apart; ±130 ms is all of it).
 */
export const MAX_PERFECT_FRAC = 0.2;
export const MAX_GOOD_FRAC = 0.36;

export const PERFECT_POINTS = 100;
export const GOOD_POINTS = 50;
/** The multiplier grows by one every COMBO_STEP on-beat events in a row, up to MAX_MULTIPLIER. */
export const COMBO_STEP = 8;
export const MAX_MULTIPLIER = 4;

/**
 * Judge one event against a beat grid. `beatT` is the time of any beat (past
 * or future) on the same clock as `tHit`; grid lines sit every
 * `beatMs / subdivision` from it (subdivision 2 = eighths count as on-beat).
 */
export function judge(
  tHit: number,
  beatT: number,
  beatMs: number,
  subdivision: number,
  perfectMs: number,
  goodMs: number,
): Judged {
  const gridMs = beatMs / Math.max(1, Math.round(subdivision));
  if (!(gridMs > 0) || !Number.isFinite(gridMs)) return { judgement: 'miss', offsetMs: 0 };
  const since = tHit - beatT;
  const offsetMs = since - Math.round(since / gridMs) * gridMs;
  const abs = Math.abs(offsetMs);
  const perfect = Math.min(perfectMs, MAX_PERFECT_FRAC * gridMs);
  const good = Math.max(perfect, Math.min(goodMs, MAX_GOOD_FRAC * gridMs));
  return { judgement: abs <= perfect ? 'perfect' : abs <= good ? 'good' : 'miss', offsetMs };
}

/**
 * Judge "right now" against the song clock. The clock's position is read on
 * the audio timeline at the moment the voice is triggered, so this compares
 * what the player hears with the click they hear; output latency cancels and a
 * paused or restarted song needs no special care. null = no song, no judging.
 */
export function judgeNow(song: SongContext, cfg: ScoreConfig): Judged | null {
  if (!(song.bpm > 0)) return null;
  const beatMs = 60000 / song.bpm;
  return judge(song.beatPhase * beatMs - cfg.latencyMs, 0, beatMs, cfg.subdivision, cfg.perfectMs, cfg.goodMs);
}

export function comboMultiplier(combo: number): number {
  return Math.min(MAX_MULTIPLIER, 1 + Math.floor(combo / COMBO_STEP));
}

/**
 * What one event is worth to the tightness meter. A "good" counts half: the
 * windows are generous so beginners keep scoring, which lets random flailing
 * land on-beat about 70% of the time; weighting pulls that down to about 0.55
 * while tight playing still reads near 1.
 */
export const TIGHTNESS_WEIGHT: Record<Judgement, number> = { perfect: 1, good: 0.5, miss: 0 };

/** Newest-last window of judgements, each tagged with the player who made it. */
class TightnessWindow {
  private entries: { playerId: PlayerId; weight: number }[] = [];

  push(judgement: Judgement, size: number, playerId: PlayerId = 0): void {
    this.entries.push({ playerId, weight: TIGHTNESS_WEIGHT[judgement] });
    const max = Math.max(1, Math.round(size));
    if (this.entries.length > max) this.entries.splice(0, this.entries.length - max);
  }

  /** Mean weight over the window, 0..1; 0 when empty. */
  get value(): number {
    if (this.entries.length === 0) return 0;
    return this.entries.reduce((sum, e) => sum + e.weight, 0) / this.entries.length;
  }

  /** Forget one player's events. */
  drop(playerId: PlayerId): void {
    this.entries = this.entries.filter((e) => e.playerId !== playerId);
  }

  clear(): void {
    this.entries.length = 0;
  }
}

/** One player's running score. */
export class ScoreKeeper {
  private score: ScoreInfo = { ...EMPTY_SCORE };
  private readonly recent = new TightnessWindow();

  constructor(private readonly cfg: ScoreConfig) {}

  add(j: Judged): void {
    const s = this.score;
    const onBeat = j.judgement !== 'miss';
    if (onBeat) {
      // The multiplier is the one earned before this event, so the first hit is worth face value.
      s.points += (j.judgement === 'perfect' ? PERFECT_POINTS : GOOD_POINTS) * comboMultiplier(s.combo);
      s.combo += 1;
      s.bestCombo = Math.max(s.bestCombo, s.combo);
    } else {
      s.combo = 0;
    }
    s[j.judgement] += 1;
    s.last = j.judgement;
    s.lastOffsetMs = j.offsetMs;
    this.recent.push(j.judgement, this.cfg.window);
    s.tightness = this.recent.value;
  }

  info(): ScoreInfo {
    return { ...this.score };
  }

  reset(): void {
    this.score = { ...EMPTY_SCORE };
    this.recent.clear();
  }
}

/** The event that makes a sound on each instrument; everything else is not judged. */
const SCORED_EVENT: Partial<Record<InstrumentId, InstrumentEvent['type']>> = {
  drums: 'drum.hit',
  guitar: 'guitar.strum',
  bass: 'bass.pluck',
};

export function isScoredEvent(e: InstrumentEvent, instrument: InstrumentId): boolean {
  return SCORED_EVENT[instrument] === e.type;
}

/** Every player's keeper plus the shared tightness meter. */
export class BandScore {
  private readonly keepers = new Map<PlayerId, ScoreKeeper>();
  private readonly recent = new TightnessWindow();

  constructor(
    private readonly cfg: ScoreConfig,
    private readonly song: () => SongContext,
  ) {}

  /** Judge one sounding event for a player, now. Returns null (and changes nothing) in free play. */
  hit(playerId: PlayerId): Judged | null {
    const j = judgeNow(this.song(), this.cfg);
    if (!j) return null;
    let keeper = this.keepers.get(playerId);
    if (!keeper) this.keepers.set(playerId, (keeper = new ScoreKeeper(this.cfg)));
    keeper.add(j);
    this.recent.push(j.judgement, this.cfg.window, playerId);
    return j;
  }

  info(playerId: PlayerId): ScoreInfo {
    return this.keepers.get(playerId)?.info() ?? { ...EMPTY_SCORE };
  }

  /** Timing quality over the last `window` events from anyone, 0..1 (see TIGHTNESS_WEIGHT). */
  get tightness(): number {
    return this.recent.value;
  }

  reset(): void {
    this.keepers.clear();
    this.recent.clear();
  }

  /** Zero one player (they swapped instruments); everyone else keeps their score and their share of the tightness. */
  resetPlayer(playerId: PlayerId): void {
    this.keepers.delete(playerId);
    this.recent.drop(playerId);
  }
}
