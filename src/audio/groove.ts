import type { PadId } from '@/core/types';

/**
 * Pure beat-grid arithmetic shared by the song clock and easy mode. Kept free
 * of Tone.js so it runs in unit tests.
 */

export interface BeatPosition {
  bar: number;
  beat: number;
  /** 0..1 inside the beat. */
  beatPhase: number;
  /** Beats elapsed since the song started, fractional. */
  beatsTotal: number;
}

export function positionAt(seconds: number, bpm: number, beatsPerBar: number): BeatPosition {
  const beatsTotal = Math.max(0, (seconds * bpm) / 60);
  const bar = Math.floor(beatsTotal / beatsPerBar);
  const inBar = beatsTotal - bar * beatsPerBar;
  const beat = Math.floor(inBar);
  return { bar, beat, beatPhase: inBar - beat, beatsTotal };
}

export interface CountedPosition extends BeatPosition {
  /** true while the count-in runs; then `bar` is 0 and `beat` counts inside the count-in. */
  countIn: boolean;
}

/**
 * Position on a clock that plays `countInBeats` clicks before bar 0 of the
 * chart. The count-in is whole beats, so `beatPhase` runs straight through it.
 */
export function positionWithCountIn(seconds: number, bpm: number, beatsPerBar: number, countInBeats: number): CountedPosition {
  const lead = Math.max(0, Math.round(countInBeats));
  const raw = positionAt(seconds, bpm, beatsPerBar);
  if (raw.beatsTotal < lead) {
    const beat = Math.floor(raw.beatsTotal);
    return { bar: 0, beat, beatPhase: raw.beatsTotal - beat, beatsTotal: 0, countIn: true };
  }
  return { ...positionAt(seconds - (lead * 60) / bpm, bpm, beatsPerBar), countIn: false };
}

export interface GridStep {
  bar: number;
  beat: number;
  /** 0 = on the beat, 1 = the eighth after it. */
  sub: 0 | 1;
  countIn: boolean;
}

/** The `n`-th eighth-note step since the clock started, count-in first. */
export function stepAt(n: number, beatsPerBar: number, countInBeats: number): GridStep {
  const lead = Math.max(0, Math.round(countInBeats));
  const sub = (n % 2) as 0 | 1;
  const beats = Math.floor(n / 2);
  if (beats < lead) return { bar: 0, beat: beats, sub, countIn: true };
  const count = beats - lead;
  return { bar: Math.floor(count / beatsPerBar), beat: count % beatsPerBar, sub, countIn: false };
}

/**
 * Easy-mode drum groove: which drum a hit "wants" at a position in the bar.
 * The hit is quantized to the nearest eighth note only to pick the sound; it
 * still plays immediately.
 *
 *   on-beat, odd beats (1, 3)  → kick
 *   on-beat, even beats (2, 4) → snare
 *   off-beats (the "and"s)     → hi-hat
 *   last beat of every 4th bar → crash
 *
 * `beatInBar` is fractional (beat + phase); a value that rounds past the end
 * of the bar counts as beat 1 of the next bar.
 */
export function grooveRole(beatInBar: number, beatsPerBar: number, bar: number): PadId {
  const slots = beatsPerBar * 2;
  const slot = Math.round(beatInBar * 2);
  const wrapped = ((slot % slots) + slots) % slots;
  const barAdj = slot >= slots ? bar + 1 : bar;
  if (wrapped % 2 === 1) return 'hihat';
  const beat = wrapped / 2;
  if (barAdj % 4 === 3 && beat === beatsPerBar - 1) return 'crash';
  return beat % 2 === 0 ? 'kick' : 'snare';
}

/** Beats the song clock plays the kick on by itself in easy mode (0-based: 1 and 3). */
export function isAutoKickBeat(beat: number): boolean {
  return beat % 2 === 0;
}

/** The eighth-note slot a position in the bar is nearest to, and how far off it is. */
export interface GridSlot {
  /** Eighth-note index inside the bar; equals `beatsPerBar * 2` when the hit rounds up to beat 1 of the next bar. */
  slot: number;
  /** Signed distance to that slot in eighths, -0.5..0.5; negative = the hit is early. */
  offset: number;
}

export function nearestSlot(beatInBar: number): GridSlot {
  const pos = beatInBar * 2;
  const slot = Math.round(pos);
  return { slot, offset: pos - slot };
}

/** A hit is "in time" when it lands within `window` eighths of an eighth-note slot (0.5 = everything passes). */
export function isInTime(beatInBar: number, window: number): boolean {
  return Math.abs(nearestSlot(beatInBar).offset) <= window;
}

/** A song position as a beat count from bar 0 (the count-in is all beat 0 and below; see `absoluteSlot`). */
export interface GridPosition {
  bar: number;
  beat: number;
  beatPhase: number;
  beatsPerBar: number;
  countIn?: boolean;
}

/**
 * The eighth-note slot nearest a song position, counted from bar 0 of the
 * chart. During the count-in only the very last slot maps onto the chart (a
 * hit just before the downbeat belongs to beat 1 of bar 0); earlier ones are
 * null.
 */
export function absoluteSlot(p: GridPosition): number | null {
  const slots = p.beatsPerBar * 2;
  const { slot } = nearestSlot(p.beat + p.beatPhase);
  if (p.countIn) return slot >= slots ? 0 : null;
  return p.bar * slots + slot;
}

/**
 * Who plays the kick on 1 and 3 in easy mode. The clock's auto kick is a
 * stand-in for a drummer who is not playing it; once the player lands their
 * own kick on one of those beats, the auto kick steps aside so the hit is
 * heard as theirs:
 * - a hit that comes just before the beat claims that beat (the auto kick for
 *   it has not sounded yet, so it is skipped);
 * - a hit on the previous kick beat, early or late, claims the next one too
 *   (most camera hits land a few ms late, after the auto kick has gone).
 * When the player stops, one kick is missing and then the auto kick is back.
 */
export class KickCover {
  private lastBeat = -Infinity;

  /** The player's hit sounded a kick at this position. */
  notePlayerKick(p: GridPosition): void {
    const slot = absoluteSlot(p);
    if (slot === null || slot % 2 !== 0) return;
    const beat = slot / 2;
    if (!isAutoKickBeat(((beat % p.beatsPerBar) + p.beatsPerBar) % p.beatsPerBar)) return;
    this.lastBeat = Math.max(this.lastBeat, beat);
  }

  /** Should the auto kick on (`bar`, `beat`) stay silent? */
  covers(bar: number, beat: number, beatsPerBar: number): boolean {
    const now = bar * beatsPerBar + beat;
    let prev = now - 1;
    while (prev >= 0 && !isAutoKickBeat(prev % beatsPerBar)) prev--;
    return this.lastBeat >= Math.max(prev, 0) && this.lastBeat <= now;
  }

  reset(): void {
    this.lastBeat = -Infinity;
  }
}
