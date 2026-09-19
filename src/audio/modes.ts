import type { DrumHitEvent, NoteResolver, PlayMode, PressEvent, SongContext, StrumEvent } from '@/core/types';
import { grooveRole } from './groove';

/**
 * Note resolvers ("modes"). A resolver turns a gesture event into the concrete
 * sound to play. Swapping the resolver is how easy and hard mode differ; the
 * detectors and voices never know which one is active.
 */

/** Song context when no song clock is running: free play, no chart. */
export const FREEPLAY_CONTEXT: SongContext = { bpm: 0, beatsPerBar: 4, bar: 0, beat: 0, beatPhase: 0, chord: null, key: 'G' };

/**
 * Hard mode: what you did is what you hear. Drums play the pad that was struck
 * at the struck velocity. Strums (commit 16) play the classified chord;
 * presses (commit 25) play the key under the finger.
 */
export class HardMode implements NoteResolver {
  readonly id: PlayMode = 'hard';

  resolveDrum(e: DrumHitEvent, _song: SongContext): { sample: string; velocity: number } {
    return { sample: e.pad, velocity: e.velocity };
  }

  resolveStrum(e: StrumEvent, _song: SongContext): { notes: (string | null)[]; velocities: number[] } {
    // Voicings arrive with the guitar voice (commit 11); until then a strum is silent.
    void e;
    return { notes: [], velocities: [] };
  }

  resolvePress(e: PressEvent, _song: SongContext): { note: string; velocity: number } {
    return { note: 'C4', velocity: e.velocity };
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

  resolveStrum(e: StrumEvent, _song: SongContext): { notes: (string | null)[]; velocities: number[] } {
    // Chord from the chart → voicing arrives with the guitar voice (commit 11).
    void e;
    return { notes: [], velocities: [] };
  }

  resolvePress(e: PressEvent, _song: SongContext): { note: string; velocity: number } {
    return { note: 'C4', velocity: e.velocity };
  }
}

export function createResolver(mode: PlayMode): NoteResolver & { id: PlayMode } {
  return mode === 'easy' ? new EasyMode() : new HardMode();
}
