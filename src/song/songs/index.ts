import type { Song } from '@/core/types';
import { parseSong } from '../types';

/**
 * Built-in charts. One chord per bar, and every chord needs a voicing in
 * `song/chords.ts` (G C D Em Am A). The demo charts are chord progressions
 * only, typed by hand: no lyrics, no recordings, no scraped chord data. Lyrics
 * appear on public-domain songs only. Add a chart here or drop a JSON file
 * into public/songs/ and load it through `parseSong`.
 */

/** `times` passes through a progression, one chord per bar. */
function loop(progression: string, times: number): { chord: string }[] {
  const chords = progression.trim().split(/\s+/);
  return Array.from({ length: times * chords.length }, (_, i) => ({ chord: chords[i % chords.length] }));
}

/** IV V I vi in G, the same four bars all the way through. */
const VIVA_LA_VIDA: Song = parseSong({
  title: 'Viva la Vida',
  bpm: 138,
  key: 'G',
  timeSig: [4, 4],
  sections: [
    { name: 'intro', bars: loop('C D G Em', 1) },
    { name: 'verse', bars: loop('C D G Em', 2) },
    { name: 'chorus', bars: loop('C D G Em', 2) },
  ],
});

/** i III VII VI, transposed from A minor to E minor so every chord has an easy guitar voicing (no F). */
const COUNTING_STARS: Song = parseSong({
  title: 'Counting Stars',
  bpm: 122,
  key: 'G',
  timeSig: [4, 4],
  sections: [
    { name: 'intro', bars: loop('Em G D C', 1) },
    { name: 'verse', bars: loop('Em G D C', 2) },
    { name: 'chorus', bars: loop('Em G D C', 2) },
  ],
});

/**
 * The record is in 12/8; here each dotted-quarter pulse is one beat of 4/4,
 * so the chords change where they should and the swing is straightened.
 */
const PERFECT: Song = parseSong({
  title: 'Perfect',
  bpm: 63,
  key: 'G',
  timeSig: [4, 4],
  sections: [
    { name: 'verse', bars: loop('G Em C D', 2) },
    { name: 'chorus', bars: loop('Em C G D', 2) },
    { name: 'turnaround', bars: loop('G Em C D', 1) },
  ],
});

const SAINTS: Song = parseSong({
  title: 'When the Saints Go Marching In',
  bpm: 120,
  key: 'G',
  timeSig: [4, 4],
  sections: [
    {
      name: 'verse',
      bars: [
        { chord: 'G', lyric: 'Oh when the saints' },
        { chord: 'G', lyric: 'go marching in' },
        { chord: 'G', lyric: 'oh when the saints go' },
        { chord: 'D', lyric: 'marching in' },
        { chord: 'G', lyric: 'oh Lord I want' },
        { chord: 'C', lyric: 'to be in that number' },
        { chord: 'G', lyric: 'when the saints go' },
        { chord: 'D', lyric: 'marching' },
        { chord: 'G', lyric: 'in' },
        { chord: 'G' },
        { chord: 'C' },
        { chord: 'G' },
        { chord: 'Em' },
        { chord: 'Am' },
        { chord: 'D' },
        { chord: 'G' },
      ],
    },
  ],
});

/** Original I–V–vi–IV loop in G: the "sounds like a song" fallback for free play. */
const CAMPFIRE: Song = parseSong({
  title: 'Campfire Loop',
  bpm: 100,
  key: 'G',
  timeSig: [4, 4],
  sections: [
    { name: 'loop', bars: [{ chord: 'G' }, { chord: 'D' }, { chord: 'Em' }, { chord: 'C' }] },
    { name: 'turnaround', bars: [{ chord: 'G' }, { chord: 'D' }, { chord: 'Am' }, { chord: 'D' }] },
  ],
});

/** Ids are what the song deck in the UI looks up; insertion order is the picker order. */
export const SONGS: Record<string, Song> = {
  'viva-la-vida': VIVA_LA_VIDA,
  'counting-stars': COUNTING_STARS,
  perfect: PERFECT,
  saints: SAINTS,
  campfire: CAMPFIRE,
};

export const DEFAULT_SONG_ID = 'viva-la-vida';

export function getSong(id: string): Song {
  return SONGS[id] ?? SONGS[DEFAULT_SONG_ID];
}
