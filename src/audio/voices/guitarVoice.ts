import * as Tone from 'tone';
import type { Config } from '@/app/config';
import type { ChordName, StringSound, Voice } from '@/core/types';
import { STRING_COUNT } from '@/song/chords';
import { velocityToGain } from '../latencyMeter';

/**
 * Every third semitone of the vendored acoustic guitar, E2..A#4: the sampler
 * repitches by at most one semitone, and the guitar loads 11 files (~2 MB)
 * instead of all 37 (~7 MB).
 */
const SAMPLE_NOTES = ['E2', 'G2', 'A#2', 'C#3', 'E3', 'G3', 'A#3', 'C#4', 'E4', 'G4', 'A#4'] as const;

/** Fade when a string is damped: re-struck, muted by a chord change, or cut by `releaseAll` (s). */
const DAMP_S = 0.05;

export type GuitarVoiceOptions = Config['guitar'];

export interface StrumPlan {
  /** Notes to damp. Run these before the attacks: a release silences every ringing copy of its note. */
  releases: { string: number; note: string; at: number }[];
  /** `at` is seconds after the strum; `string` is the slot, 0 = low E. */
  attacks: { string: number; note: string; at: number; velocity: number }[];
}

/**
 * One strum event becomes six staggered string attacks, because the camera
 * cannot see individual strings. Down-strums run low to high, up-strums high
 * to low; a fast stroke is tight (`spreadMinMs` between strings) and a lazy
 * one is loose (`spreadMaxMs`). Each string rings one note at a time, so it
 * is damped as it is re-struck. Strings the stroke does not reach keep ringing
 * while the chord stays the same and are damped when it changes.
 *
 * Pure, so the rules are unit-tested without an audio context.
 */
export function planStrum(
  ringing: ReadonlyArray<string | null>,
  lastChord: ChordName | null | undefined,
  sound: StringSound,
  opts: Pick<GuitarVoiceOptions, 'spreadMinMs' | 'spreadMaxMs' | 'humanizeMs'>,
  random: () => number = Math.random,
): StrumPlan {
  const plan: StrumPlan = { releases: [], attacks: [] };
  const struck: number[] = [];
  for (let i = 0; i < STRING_COUNT; i++) if (sound.notes[i] != null) struck.push(i);
  if (sound.direction === 'up') struck.reverse();

  const chordChanged = sound.chord == null || sound.chord !== lastChord;
  if (chordChanged) {
    for (let i = 0; i < STRING_COUNT; i++) {
      const old = ringing[i];
      if (old != null && !struck.includes(i)) plan.releases.push({ string: i, note: old, at: 0 });
    }
  }

  const speed = Math.max(0, ...struck.map((i) => sound.velocities[i] ?? 0));
  const spacing = (opts.spreadMaxMs + (opts.spreadMinMs - opts.spreadMaxMs) * Math.min(1, speed)) / 1000;
  struck.forEach((i, k) => {
    // The first string is never delayed: it is the one the player's hand is timed against.
    const jitter = k === 0 ? 0 : ((random() * 2 - 1) * opts.humanizeMs) / 1000;
    const at = Math.max(0, k * spacing + jitter);
    const old = ringing[i];
    if (old != null) plan.releases.push({ string: i, note: old, at });
    plan.attacks.push({ string: i, note: sound.notes[i] as string, at, velocity: sound.velocities[i] ?? 0.8 });
  });
  return plan;
}

/** Acoustic guitar: a Tone.Sampler over the vendored samples, played one string at a time (see `planStrum`). */
export class GuitarVoice implements Voice {
  readonly id = 'guitar' as const;
  private sampler: Tone.Sampler | null = null;
  private loading: Promise<void> | null = null;
  private readonly ringing: (string | null)[] = new Array(STRING_COUNT).fill(null);
  private lastChord: ChordName | null = null;

  constructor(
    private readonly output: () => Tone.ToneAudioNode,
    private readonly opts: () => GuitarVoiceOptions,
    private readonly baseUrl = `${import.meta.env.BASE_URL}samples/guitar-acoustic/`,
  ) {}

  get loaded(): boolean {
    return this.sampler?.loaded ?? false;
  }

  /** The chord of the latest strum (the free-play loop has no chart to read it from). */
  get chord(): ChordName | null {
    return this.lastChord;
  }

  load(): Promise<void> {
    this.loading ??= new Promise((resolve, reject) => {
      // File names spell sharps with an "s": A#2 is As2.mp3.
      const urls = Object.fromEntries(SAMPLE_NOTES.map((n) => [n, `${n.replace('#', 's')}.mp3`]));
      this.sampler = new Tone.Sampler({
        urls,
        baseUrl: this.baseUrl,
        release: DAMP_S,
        volume: this.opts().volume,
        onload: () => resolve(),
        onerror: reject,
      }).connect(this.output());
    });
    return this.loading;
  }

  trigger(sound: Partial<StringSound>, when?: number): void {
    const sampler = this.sampler;
    if (!sampler?.loaded || !sound.notes) return; // strums before the samples arrive are dropped, not queued
    const opts = this.opts();
    sampler.volume.value = opts.volume;
    const t0 = when ?? Tone.now();
    const plan = planStrum(this.ringing, this.lastChord, { ...sound, notes: sound.notes, velocities: sound.velocities ?? [] }, opts);
    for (const r of plan.releases) {
      sampler.triggerRelease(r.note, t0 + r.at);
      this.ringing[r.string] = null;
    }
    for (const a of plan.attacks) {
      sampler.triggerAttack(a.note, t0 + a.at, velocityToGain(a.velocity));
      this.ringing[a.string] = a.note;
    }
    this.lastChord = sound.chord ?? null;
  }

  releaseAll(): void {
    this.sampler?.releaseAll();
    this.ringing.fill(null);
  }

  dispose(): void {
    this.releaseAll();
    this.sampler?.dispose();
    this.sampler = null;
    this.loading = null;
  }
}
