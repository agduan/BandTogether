import * as Tone from 'tone';
import type { Config } from '@/app/config';
import type { ChordName, StringSound, Voice } from '@/core/types';
import { midiToNote, noteToMidi } from '@/song/chords';
import { velocityToGain } from '../latencyMeter';

/**
 * The guitar's own files (every third semitone, E2..E4: the ones the guitar
 * voice loads, so the browser has them cached). Zero new bytes, works offline.
 */
const SAMPLE_MIDI = [40, 43, 46, 49, 52, 55, 58, 61, 64] as const;
/** A bass note is the guitar sample an octave above it at half speed: darker and longer, which is what reads as a bass. */
const DROP = 12;
/** Fade when the string is damped: re-struck, or cut by `releaseAll` (s). */
const DAMP_S = 0.05;

export type BassVoiceOptions = Pick<Config['bass'], 'volume' | 'octave'>;

export interface BassNotePlan {
  /** The note that sounds, after the octave shift. */
  note: string;
  /** Sample to play, named as the guitar files are labelled (sharps with '#'). */
  sample: string;
  playbackRate: number;
}

/**
 * Which file to play, and how fast, for one bass note. `octave` shifts the
 * whole instrument (0 = as resolved, E2..D#3, which laptop speakers carry;
 * -1 = a real bass register for a PA). Pure, so it is tested without audio.
 */
export function planBassNote(note: string, octave = 0): BassNotePlan | null {
  const asked = noteToMidi(note);
  if (asked === null) return null;
  const midi = asked + 12 * Math.round(octave);
  const source = SAMPLE_MIDI.reduce((best, m) => (Math.abs(m - (midi + DROP)) < Math.abs(best - (midi + DROP)) ? m : best));
  return { note: midiToNote(midi), sample: midiToNote(source), playbackRate: 2 ** ((midi - source) / 12) };
}

/**
 * Bass: one string, one note at a time. Each new note damps the one before.
 * Not a Tone.Sampler, because a sampler always repitches from the nearest
 * file, and the bass wants the file an octave up (see `DROP`).
 */
export class BassVoice implements Voice {
  readonly id = 'bass' as const;
  private buffers: Tone.ToneAudioBuffers | null = null;
  private out: Tone.Volume | null = null;
  private loading: Promise<void> | null = null;
  private ringing: Tone.ToneBufferSource | null = null;
  private lastNote: string | null = null;
  private lastChord: ChordName | null = null;

  constructor(
    private readonly output: () => Tone.ToneAudioNode,
    private readonly opts: () => BassVoiceOptions,
    private readonly baseUrl = `${import.meta.env.BASE_URL}samples/guitar-acoustic/`,
  ) {}

  get loaded(): boolean {
    return this.buffers?.loaded ?? false;
  }

  /** The note that last sounded, e.g. 'G2'. */
  get note(): string | null {
    return this.lastNote;
  }

  /** The chord of the latest note (the free-play loop has no chart to read it from). */
  get chord(): ChordName | null {
    return this.lastChord;
  }

  load(): Promise<void> {
    this.loading ??= new Promise((resolve, reject) => {
      this.out = new Tone.Volume(this.opts().volume).connect(this.output());
      // File names spell sharps with an "s": A#2 is As2.mp3.
      const urls = Object.fromEntries(SAMPLE_MIDI.map((m) => [midiToNote(m), `${midiToNote(m).replace('#', 's')}.mp3`]));
      this.buffers = new Tone.ToneAudioBuffers({ urls, baseUrl: this.baseUrl, onload: () => resolve(), onerror: reject });
    });
    return this.loading;
  }

  trigger(sound: Partial<StringSound>, when?: number): void {
    const i = sound.notes?.findIndex((n) => n != null) ?? -1;
    if (!this.buffers?.loaded || !this.out || i < 0) return; // notes before the samples arrive are dropped, not queued
    const opts = this.opts();
    const plan = planBassNote(sound.notes![i] as string, opts.octave);
    if (!plan) return;
    this.out.volume.value = opts.volume;
    const t0 = when ?? Tone.now();
    this.ringing?.stop(t0);
    const source = new Tone.ToneBufferSource({ url: this.buffers.get(plan.sample), playbackRate: plan.playbackRate, fadeOut: DAMP_S }).connect(this.out);
    // Tone disposes a one-shot source once it has ended.
    source.onended = () => {
      if (this.ringing === source) this.ringing = null;
    };
    source.start(t0, 0, undefined, velocityToGain(sound.velocities?.[i] ?? 0.8));
    this.ringing = source;
    this.lastNote = plan.note;
    this.lastChord = sound.chord ?? null;
  }

  releaseAll(): void {
    this.ringing?.stop();
    this.ringing = null;
  }

  dispose(): void {
    this.releaseAll();
    this.buffers?.dispose();
    this.out?.dispose();
    this.buffers = null;
    this.out = null;
    this.loading = null;
  }
}
