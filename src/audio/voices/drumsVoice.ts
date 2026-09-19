import * as Tone from 'tone';
import type { Voice } from '@/core/types';
import { velocityToGain } from '../latencyMeter';

export const DRUM_PADS = ['kick', 'snare', 'hihat', 'tom1', 'tom2', 'tom3', 'crash'] as const;
export type DrumPad = (typeof DRUM_PADS)[number];

/**
 * Drum kit one-shots. Each hit spawns its own buffer source through its own
 * gain node, so fast rolls and simultaneous pads never cut each other off
 * (a shared Tone.Player would restart on every retrigger).
 */
export class DrumsVoice implements Voice {
  readonly id = 'drums' as const;
  private buffers: Tone.ToneAudioBuffers | null = null;
  private readonly live = new Set<Tone.ToneBufferSource>();

  constructor(
    private readonly output: () => Tone.ToneAudioNode,
    private readonly baseUrl = `${import.meta.env.BASE_URL}samples/drums/`,
  ) {}

  get loaded(): boolean {
    return this.buffers?.loaded ?? false;
  }

  load(): Promise<void> {
    if (this.buffers) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const urls = Object.fromEntries(DRUM_PADS.map((p) => [p, `${p}.mp3`]));
      this.buffers = new Tone.ToneAudioBuffers({ urls, baseUrl: this.baseUrl, onload: () => resolve(), onerror: reject });
    });
  }

  trigger(sound: { sample?: string; velocity?: number }, when?: number): void {
    const pad = sound.sample ?? 'snare';
    if (!this.buffers?.has(pad)) return;
    const gain = new Tone.Gain(velocityToGain(sound.velocity ?? 0.8)).connect(this.output());
    const source = new Tone.ToneBufferSource({
      url: this.buffers.get(pad),
      onended: () => {
        this.live.delete(source);
        source.dispose();
        gain.dispose();
      },
    }).connect(gain);
    this.live.add(source);
    source.start(when ?? Tone.now());
  }

  releaseAll(): void {
    for (const s of this.live) s.stop();
  }
}
