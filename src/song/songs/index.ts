import type { Song } from '@/core/types';
import { parseSong } from '../types';

/** Compact, lyric-free charts for the three songs offered by the product UI. */
const VIVA_LA_VIDA: Song = parseSong({
  title: 'Viva la Vida',
  bpm: 138,
  key: 'G',
  timeSig: [4, 4],
  sections: [
    { name: 'verse', bars: [{ chord: 'C' }, { chord: 'D' }, { chord: 'G' }, { chord: 'Em' }] },
    { name: 'chorus', bars: [{ chord: 'C' }, { chord: 'D' }, { chord: 'G' }, { chord: 'Em' }] },
  ],
});

/** Transposed to G so every chord has an easy guitar voicing. */
const COUNTING_STARS: Song = parseSong({
  title: 'Counting Stars',
  bpm: 122,
  key: 'G',
  timeSig: [4, 4],
  sections: [
    { name: 'verse', bars: [{ chord: 'Em' }, { chord: 'G' }, { chord: 'D' }, { chord: 'C' }] },
    { name: 'chorus', bars: [{ chord: 'Em' }, { chord: 'G' }, { chord: 'D' }, { chord: 'C' }] },
  ],
});

const PERFECT: Song = parseSong({
  title: 'Perfect',
  bpm: 95,
  key: 'G',
  timeSig: [4, 4],
  sections: [
    { name: 'verse', bars: [{ chord: 'G' }, { chord: 'Em' }, { chord: 'C' }, { chord: 'D' }] },
    { name: 'chorus', bars: [{ chord: 'G' }, { chord: 'Em' }, { chord: 'C' }, { chord: 'D' }] },
  ],
});

export const SONGS: Record<string, Song> = {
  'viva-la-vida': VIVA_LA_VIDA,
  'counting-stars': COUNTING_STARS,
  perfect: PERFECT,
};

export const DEFAULT_SONG_ID = 'viva-la-vida';

export function getSong(id: string): Song {
  return SONGS[id] ?? SONGS[DEFAULT_SONG_ID];
}
