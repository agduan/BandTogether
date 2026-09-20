import type { ChordName } from '@/core/types';

/**
 * Chord voicings for the guitar: 6 slots, low string (6) to high string (1),
 * `null` = that string is muted. The seven listed here are open shapes, which
 * ring richer than a barre; charts prefer them where the key allows.
 *
 * With no classifier, any chord a chart names just needs a voicing. A chord
 * that is not listed here still sounds: `voicingFor` builds a barre shape from
 * its name, so a chart is free to stay in the song's own key.
 */
export type Voicing = readonly [string | null, string | null, string | null, string | null, string | null, string | null];

export const STRING_COUNT = 6;

export const VOICINGS: Readonly<Record<string, Voicing>> = {
  G: ['G2', 'B2', 'D3', 'G3', 'B3', 'G4'],
  C: [null, 'C3', 'E3', 'G3', 'C4', 'E4'],
  D: [null, null, 'D3', 'A3', 'D4', 'F#4'],
  Em: ['E2', 'B2', 'E3', 'G3', 'B3', 'E4'],
  Am: [null, 'A2', 'E3', 'A3', 'C4', 'E4'],
  A: [null, 'A2', 'E3', 'A3', 'C#4', 'E4'],
  E: ['E2', 'B2', 'E3', 'G#3', 'B3', 'E4'],
};

/** Free play (no song clock): I-V-vi-IV in G, every chord of which has a real voicing. */
export const FREEPLAY_LOOP: readonly ChordName[] = ['G', 'D', 'Em', 'C'];

const PITCH_CLASS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LOW_E = 40; // E2, the open sixth string

export interface ParsedChord {
  /** 0 = C ... 11 = B */
  root: number;
  minor: boolean;
}

/** Root and quality from a chord name. Extensions (7, sus4, add9, /B) are ignored; "maj" is major, "dim" counts as minor. */
export function parseChord(chord: ChordName): ParsedChord | null {
  const m = /^([A-G])([#b]?)(.*)$/.exec(chord.trim());
  if (!m) return null;
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  const rest = m[3];
  const minor = /^(m(?!aj)|min|dim)/.test(rest);
  return { root: (PITCH_CLASS[m[1]] + accidental + 12) % 12, minor };
}

export function midiToNote(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/** The inverse of `midiToNote`: 'F#2' is 42. Flats are read too; null for anything that is not a note name. */
export function noteToMidi(note: string): number | null {
  const m = /^([A-G])([#b]?)(-?\d+)$/.exec(note);
  if (!m) return null;
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return PITCH_CLASS[m[1]] + accidental + (Number(m[3]) + 1) * 12;
}

export interface ChordTones {
  root: number;
  third: number;
  fifth: number;
}

/**
 * Root, third and fifth of a chord as MIDI numbers, the root being the lowest
 * one at or above `lowest`. null for an unparseable name. The backing band and
 * the bass pick their register with `lowest`.
 */
export function chordTones(chord: ChordName, lowest: number): ChordTones | null {
  const p = parseChord(chord);
  if (!p) return null;
  const root = lowest + ((((p.root - lowest) % 12) + 12) % 12);
  return { root, third: root + (p.minor ? 3 : 4), fifth: root + 7 };
}

/** The root in the guitar's bottom octave, E2..D#3. */
function rootMidi(root: number): number {
  const e = 4; // pitch class of E
  return LOW_E + ((root - e + 12) % 12);
}

/** Highest root an E shape reaches (G#2) before the A shape sits lower on the neck. */
const E_SHAPE_MAX = LOW_E + 4;

/**
 * A barre shape, picked the way a guitarist picks one: an E shape up to G#
 * (six strings, root on the sixth) and an A shape from A up (five strings,
 * sixth muted). At the root of E this reproduces the open E in `VOICINGS`.
 */
function triadVoicing({ root, minor }: ParsedChord): Voicing {
  const r = rootMidi(root);
  const third = minor ? 3 : 4;
  const n = midiToNote;
  if (r <= E_SHAPE_MAX) return [n(r), n(r + 7), n(r + 12), n(r + 12 + third), n(r + 19), n(r + 24)];
  return [null, n(r), n(r + 7), n(r + 12), n(r + 12 + third), n(r + 19)];
}

const built = new Map<string, Voicing | null>();

/** The voicing for a chart chord: the hand-written one, else a triad built from the name, else null (unparseable). */
export function voicingFor(chord: ChordName): Voicing | null {
  const known = VOICINGS[chord];
  if (known) return known;
  let v = built.get(chord);
  if (v === undefined) {
    const p = parseChord(chord);
    // A plain "Em7" or "G/B" is closer to the open Em / G shape than to a barre triad.
    const base = p ? VOICINGS[`${NOTE_NAMES[p.root]}${p.minor ? 'm' : ''}`] : undefined;
    v = base ?? (p ? triadVoicing(p) : null);
    built.set(chord, v);
  }
  return v;
}
