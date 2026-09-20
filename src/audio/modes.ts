import type { BassStrumEvent, ChordName, DrumHitEvent, NoteResolver, PlayMode, SongContext, StringSound, StrumEvent } from '@/core/types';
import { chordTones, FREEPLAY_LOOP, midiToNote, STRING_COUNT, voicingFor } from '@/song/chords';
import { BASS_LOWEST } from './backing';
import { grooveRole, type KickCover } from './groove';

/**
 * Note resolvers ("modes"). A resolver turns a gesture event into the concrete
 * sound to play. Swapping the resolver is how easy and hard mode differ; the
 * detectors and voices never know which one is active.
 */

/** Song context when no song clock is running: free play, no chart. */
export const FREEPLAY_CONTEXT: SongContext = { bpm: 0, beatsPerBar: 4, bar: 0, beat: 0, beatPhase: 0, chord: null, key: 'G' };

const SILENT: StringSound = { notes: [], velocities: [] };

/** Free play: strokes on one chord of the loop before it moves on. */
const FREEPLAY_STRUMS_PER_CHORD = 4;
/** Free play: after this long without a strum the loop starts over on its first chord (ms). */
const FREEPLAY_RESTART_MS = 4000;
/** Up-strums reach only the top four strings, a little softer... */
const UP_STRUM_STRINGS = 4;
const UP_STRUM_GAIN = 0.85;
/** ...unless the hand crosses this close to the neck end of the band, where the stroke is a full one. */
const NECK_SIDE_U = 0.3;
/** Down-strums lean on the bass string; the others sit this far under it. */
const DOWN_STRUM_REST_GAIN = 0.85;

/** The chord loop the guitar plays when no song clock is running, advanced by the strums themselves. */
export class FreeplayChords {
  private strums = 0;
  private lastT = -Infinity;

  /** The chord for a strum at `t`; counts the strum. */
  next(t: number): ChordName {
    if (t - this.lastT > FREEPLAY_RESTART_MS) this.strums = 0;
    this.lastT = t;
    const chord = FREEPLAY_LOOP[Math.floor(this.strums / FREEPLAY_STRUMS_PER_CHORD) % FREEPLAY_LOOP.length];
    this.strums++;
    return chord;
  }
}

/** One strum of `chord`: which strings sound and how hard, from the stroke's direction, speed and position. */
export function strumChord(e: StrumEvent, chord: ChordName): StringSound {
  const voicing = voicingFor(chord);
  if (!voicing) return SILENT;
  const full = e.direction === 'down' || (e.u !== undefined && e.u < NECK_SIDE_U);
  const firstString = full ? 0 : STRING_COUNT - UP_STRUM_STRINGS;
  const bass = voicing.findIndex((n) => n !== null);
  const notes = voicing.map((n, i) => (i >= firstString ? n : null));
  const velocities = voicing.map((_, i) => {
    if (e.direction === 'up') return e.velocity * UP_STRUM_GAIN;
    return i === bass ? e.velocity : e.velocity * DOWN_STRUM_REST_GAIN;
  });
  return { notes, velocities, direction: e.direction, chord };
}

/**
 * Guitar is easy only (there is no chord classifier): both modes strum the
 * chart chord, so the guitar never goes silent if the toggle is left on hard.
 * With no song running the strums walk the free-play loop instead.
 */
function chartStrum(e: StrumEvent, song: SongContext, freeplay: FreeplayChords): StringSound {
  return strumChord(e, song.chord ?? freeplay.next(e.t));
}

/**
 * One bass note: the root of `chord`, in the register the backing band's bass
 * plays (it is the part the player takes over). Down and up sound alike.
 */
export function bassNote(e: BassStrumEvent, chord: ChordName): StringSound {
  const tones = chordTones(chord, BASS_LOWEST);
  if (!tones) return SILENT;
  return { notes: [midiToNote(tones.root)], velocities: [e.velocity], direction: e.direction, chord };
}

/** Bass is strum only, like the guitar: both modes play the chart root, or walk the free-play loop when no song runs. */
function chartBass(e: BassStrumEvent, song: SongContext, freeplay: FreeplayChords): StringSound {
  return bassNote(e, song.chord ?? freeplay.next(e.t));
}

/**
 * Hard mode: what you did is what you hear. Drums play the pad that was struck
 * at the struck velocity. Guitar and bass have no hard mode of their own.
 */
export class HardMode implements NoteResolver {
  readonly id: PlayMode = 'hard';
  private readonly freeplay = new FreeplayChords();

  resolveDrum(e: DrumHitEvent, _song: SongContext): { sample: string; velocity: number } {
    return { sample: e.pad, velocity: e.velocity };
  }

  resolveStrum(e: StrumEvent, song: SongContext): StringSound {
    return chartStrum(e, song, this.freeplay);
  }

  resolveBass(e: BassStrumEvent, song: SongContext): StringSound {
    return chartBass(e, song, this.freeplay);
  }
}

/** The drum an easy-mode hit on `pad` sounds at this song position. Pure, so the overlay can ask too. */
export function easyDrumSample(pad: string, song: SongContext): string {
  if (pad === 'kick' || song.bpm <= 0) return pad;
  return grooveRole(song.beat + song.beatPhase, song.beatsPerBar, song.bar);
}

/**
 * Easy mode: the song decides what you hear. A drum hit anywhere plays the
 * drum the groove wants at the current beat position (see `grooveRole`), so
 * flailing in time produces a beat. Two exceptions keep it playable:
 * - the kick pad (and the spacebar) always plays the kick, so a deliberate
 *   foot never turns into a hi-hat;
 * - with no song running there is no grid, so hits fall back to the pad.
 */
export class EasyMode implements NoteResolver {
  readonly id: PlayMode = 'easy';
  private readonly freeplay = new FreeplayChords();

  /** `kicks`: told about every kick the player lands, so the clock's auto kick can step aside (see `KickCover`). */
  constructor(private readonly kicks?: KickCover) {}

  resolveDrum(e: DrumHitEvent, song: SongContext): { sample: string; velocity: number } {
    const sample = easyDrumSample(e.pad, song);
    if (sample === 'kick' && song.bpm > 0) this.kicks?.notePlayerKick(song);
    return { sample, velocity: e.velocity };
  }

  resolveStrum(e: StrumEvent, song: SongContext): StringSound {
    return chartStrum(e, song, this.freeplay);
  }

  resolveBass(e: BassStrumEvent, song: SongContext): StringSound {
    return chartBass(e, song, this.freeplay);
  }
}

export function createResolver(mode: PlayMode, kicks?: KickCover): NoteResolver & { id: PlayMode } {
  return mode === 'easy' ? new EasyMode(kicks) : new HardMode();
}
