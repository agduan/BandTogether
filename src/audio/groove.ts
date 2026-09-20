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
