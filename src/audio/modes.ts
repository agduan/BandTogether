import type { DrumHitEvent, NoteResolver, PressEvent, SongContext, StrumEvent } from '@/core/types';

/**
 * Note resolvers ("modes"). A resolver turns a gesture event into the concrete
 * sound to play. Swapping the resolver is how easy and hard mode differ; the
 * detectors and voices never know which one is active.
 */

/** Song context when no song clock is running: free play, no chart. */
export const FREEPLAY_CONTEXT: SongContext = { bpm: 0, bar: 0, beat: 0, beatPhase: 0, chord: null, key: 'G' };

/**
 * Hard mode: what you did is what you hear. Drums play the pad that was struck
 * at the struck velocity. Strums (commit 16) play the classified chord;
 * presses (commit 25) play the key under the finger.
 */
export class HardMode implements NoteResolver {
  readonly id = 'hard' as const;

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
