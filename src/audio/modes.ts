import type { BassPluckEvent, DrumHitEvent, NoteResolver, PlayMode, PressEvent, SongContext, StrumEvent } from '@/core/types';
import { grooveRole } from './groove';

/**
 * Note resolvers ("modes"). A resolver turns a gesture event into the concrete
 * sound to play. Swapping the resolver is how easy and hard mode differ; the
 * detectors and voices never know which one is active.
 */

/** Song context when no song clock is running: free play, no chart. */
export const FREEPLAY_CONTEXT: SongContext = { bpm: 0, beatsPerBar: 4, bar: 0, beat: 0, beatPhase: 0, chord: null, key: 'G' };

type Notes = { notes: (string | null)[]; velocities: number[] };
const SILENT: Notes = { notes: [], velocities: [] };

/**
 * Guitar is easy only (there is no chord classifier): both modes strum the
 * chart chord, so the guitar never goes silent if the toggle is left on hard.
 * Voicings arrive with the guitar voice (row 11); until then a strum is silent.
 */
function chartStrum(_e: StrumEvent, _song: SongContext): Notes {
  return SILENT;
}

/**
 * Hard mode: what you did is what you hear. Drums play the pad that was struck
 * at the struck velocity; the bass plays the neck bin under the fret hand (K5).
 */
export class HardMode implements NoteResolver {
  readonly id: PlayMode = 'hard';

  resolveDrum(e: DrumHitEvent, _song: SongContext): { sample: string; velocity: number } {
    return { sample: e.pad, velocity: e.velocity };
  }

  resolveStrum(e: StrumEvent, song: SongContext): Notes {
    return chartStrum(e, song);
  }

  resolvePress(e: PressEvent, _song: SongContext): { note: string; velocity: number } {
    return { note: 'C4', velocity: e.velocity };
  }

  resolveBass(_e: BassPluckEvent, _song: SongContext): Notes {
    // Pitch from `pitchBin` arrives with the bass voice (K5).
    return SILENT;
  }
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

  resolveDrum(e: DrumHitEvent, song: SongContext): { sample: string; velocity: number } {
    if (e.pad === 'kick' || song.bpm <= 0) return { sample: e.pad, velocity: e.velocity };
    return { sample: grooveRole(song.beat + song.beatPhase, song.beatsPerBar, song.bar), velocity: e.velocity };
  }

  resolveStrum(e: StrumEvent, song: SongContext): Notes {
    return chartStrum(e, song);
  }

  resolvePress(e: PressEvent, _song: SongContext): { note: string; velocity: number } {
    return { note: 'C4', velocity: e.velocity };
  }

  resolveBass(_e: BassPluckEvent, _song: SongContext): Notes {
    // Root of the chart chord arrives with the bass voice (K5).
    return SILENT;
  }
}

export function createResolver(mode: PlayMode): NoteResolver & { id: PlayMode } {
  return mode === 'easy' ? new EasyMode() : new HardMode();
}
