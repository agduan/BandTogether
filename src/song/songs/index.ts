import type { Song } from '@/core/types';
import { parseSong } from '../types';

/**
 * Built-in charts. Chords stay inside the classifier's set (G C D Em Am A);
 * lyrics are public domain only. Add a chart here or drop a JSON file into
 * public/songs/ and load it through `parseSong`.
 */

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

export const SONGS: Record<string, Song> = {
  saints: SAINTS,
  campfire: CAMPFIRE,
};

export const DEFAULT_SONG_ID = 'saints';

export function getSong(id: string): Song {
  return SONGS[id] ?? SONGS[DEFAULT_SONG_ID];
}
