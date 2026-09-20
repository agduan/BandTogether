import { z } from 'zod';
import type { ChordName, Song, SongBar } from '@/core/types';

/**
 * Song chart schema and lookups. A chart is sections of bars, one chord per
 * bar (plus an optional lyric). Runtime data (JSON from public/songs or the
 * built-ins) goes through `parseSong` so a typo fails loudly at load time,
 * not silently mid-demo.
 */

export const SongBarSchema = z.object({
  chord: z.string().min(1),
  lyric: z.string().optional(),
});

export const SongSectionSchema = z.object({
  name: z.string().min(1),
  bars: z.array(SongBarSchema).min(1),
});

export const VocalCueSchema = z.object({
  pitch: z.string().regex(/^[A-G](?:#|b)?-?\d+$/),
  lyric: z.string().min(1),
  chord: z.string().min(1),
});

export const SongSchema = z.object({
  title: z.string().min(1),
  bpm: z.number().positive().max(300),
  key: z.string().min(1),
  timeSig: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  sections: z.array(SongSectionSchema).min(1),
  vocalCue: VocalCueSchema.optional(),
  backingTrackUrl: z.string().optional(),
});

export function parseSong(input: unknown): Song {
  return SongSchema.parse(input);
}

export interface FlatBar extends SongBar {
  /** 0-based index in the flattened chart. */
  index: number;
  section: string;
}

/** All bars of all sections in playing order. */
export function flattenBars(song: Song): FlatBar[] {
  const out: FlatBar[] = [];
  for (const s of song.sections) for (const b of s.bars) out.push({ ...b, index: out.length, section: s.name });
  return out;
}

export function barCount(song: Song): number {
  return song.sections.reduce((n, s) => n + s.bars.length, 0);
}

/** The chart loops: bar N maps to N mod length. Negative bars clamp to the first. */
export function barAt(song: Song, bar: number): FlatBar {
  const bars = flattenBars(song);
  const i = bar < 0 ? 0 : bar % bars.length;
  return bars[i];
}

export function chordAtBar(song: Song, bar: number): ChordName {
  return barAt(song, bar).chord;
}
