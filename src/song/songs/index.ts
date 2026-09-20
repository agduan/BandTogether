import type { Song } from '@/core/types';
import { parseSong } from '../types';

/** Compact, lyric-free charts for the songs offered by the product UI. */
const VIVA_LA_VIDA: Song = parseSong({
  title: 'Viva la Vida',
  bpm: 138,
  key: 'G',
  timeSig: [4, 4],
  // The short “I” pickup lands over the intro loop's closing Em before the verse returns to C.
  vocalCue: { pitch: 'B3', lyric: 'I used to…', chord: 'Em' },
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
  vocalCue: { pitch: 'A3', lyric: 'Lately, I’ve been…', chord: 'Em' },
  sections: [
    { name: 'verse', bars: [{ chord: 'Em' }, { chord: 'G' }, { chord: 'D' }, { chord: 'C' }] },
    { name: 'chorus', bars: [{ chord: 'Em' }, { chord: 'G' }, { chord: 'D' }, { chord: 'C' }] },
  ],
});

/** Doo-wop I-vi-IV-V, the same loop from the first bar to the last. Transposed to G from the recorded A. */
const STAND_BY_ME: Song = parseSong({
  title: 'Stand By Me',
  bpm: 118,
  key: 'G',
  timeSig: [4, 4],
  vocalCue: { pitch: 'B3', lyric: 'When the night…', chord: 'G' },
  sections: [
    { name: 'verse', bars: [{ chord: 'G' }, { chord: 'Em' }, { chord: 'C' }, { chord: 'D' }] },
    { name: 'chorus', bars: [{ chord: 'G' }, { chord: 'Em' }, { chord: 'C' }, { chord: 'D' }] },
  ],
});

/** i-bVII-bVI in the recorded C minor. Every chord is a built barre shape; no transposition buys an open one. */
const ROLLING_IN_THE_DEEP: Song = parseSong({
  title: 'Rolling in the Deep',
  bpm: 105,
  key: 'Cm',
  timeSig: [4, 4],
  sections: [
    { name: 'verse', bars: [{ chord: 'Cm' }, { chord: 'Bb' }, { chord: 'Ab' }, { chord: 'Ab' }] },
    { name: 'chorus', bars: [{ chord: 'Cm' }, { chord: 'Bb' }, { chord: 'Ab' }, { chord: 'Ab' }] },
  ],
});

/** I-V-vi-IV in the recorded A, one chord per bar from the first to the last: the closest fit to this chart format there is. */
const SOMEONE_LIKE_YOU: Song = parseSong({
  title: 'Someone Like You',
  bpm: 67,
  key: 'A',
  timeSig: [4, 4],
  sections: [
    { name: 'verse', bars: [{ chord: 'A' }, { chord: 'E' }, { chord: 'F#m' }, { chord: 'D' }] },
    { name: 'chorus', bars: [{ chord: 'A' }, { chord: 'E' }, { chord: 'F#m' }, { chord: 'D' }] },
  ],
});

/** The record is in Db; C is the shape set guitarists actually play it in, a semitone down. */
const MR_BRIGHTSIDE: Song = parseSong({
  title: 'Mr. Brightside',
  bpm: 148,
  key: 'C',
  timeSig: [4, 4],
  sections: [
    { name: 'verse', bars: [{ chord: 'C' }, { chord: 'F' }, { chord: 'Am' }, { chord: 'G' }] },
    { name: 'chorus', bars: [{ chord: 'C' }, { chord: 'F' }, { chord: 'Am' }, { chord: 'G' }] },
  ],
});

/**
 * One 8-bar circle of fifths in the recorded A minor, start to finish. Bar 6 is
 * a Bm7b5 on the record; `chordTones` only builds major and minor triads, so it
 * is charted as the Dm that shares three of its four notes and keeps the F natural.
 */
const I_WILL_SURVIVE: Song = parseSong({
  title: 'I Will Survive',
  bpm: 117,
  key: 'Am',
  timeSig: [4, 4],
  sections: [
    {
      name: 'loop',
      bars: [
        { chord: 'Am' }, { chord: 'Dm' }, { chord: 'G' }, { chord: 'C' },
        { chord: 'F' }, { chord: 'Dm' }, { chord: 'E' }, { chord: 'E' },
      ],
    },
  ],
});

/** A clock shell for melody-driven harmony; its chord is replaced live by the singer. */
export const SING_FREELY_ID = 'sing-freely';
export const SING_FREELY_SONG: Song = parseSong({
  title: 'Sing freely',
  bpm: 96,
  key: 'G',
  timeSig: [4, 4],
  sections: [{ name: 'Live harmony', bars: [{ chord: 'G' }] }],
});

export const SONGS: Record<string, Song> = {
  'viva-la-vida': VIVA_LA_VIDA,
  'counting-stars': COUNTING_STARS,
  'stand-by-me': STAND_BY_ME,
  'rolling-in-the-deep': ROLLING_IN_THE_DEEP,
  'someone-like-you': SOMEONE_LIKE_YOU,
  'mr-brightside': MR_BRIGHTSIDE,
  'i-will-survive': I_WILL_SURVIVE,
};

export const DEFAULT_SONG_ID = 'viva-la-vida';

export function getSong(id: string): Song {
  return SONGS[id] ?? SONGS[DEFAULT_SONG_ID];
}
