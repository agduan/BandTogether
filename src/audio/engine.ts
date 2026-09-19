import * as Tone from 'tone';
import type { Config } from '@/app/config';
import { bus } from '@/core/bus';
import type { AudioPlayedEvent, InstrumentEvent, Voice } from '@/core/types';
import { LatencyMeter } from './latencyMeter';

export type AudioState = 'idle' | 'loading' | 'suspended' | 'running' | 'error';

/**
 * Owns the Tone.js context and the master output.
 *
 * Latency matters more than anything else here: the context is created with
 * latencyHint 'interactive' and Tone's scheduler lookAhead set to 10 ms
 * (the default 100 ms would be a hidden tenth of a second between a hit and
 * its sound). Browsers keep the context suspended until a user gesture, so
 * `start()` is called from the Start button flow and again on the first
 * pointer/key event as a fallback.
 */
export class AudioEngine {
  state: AudioState = 'idle';
  readonly latency = new LatencyMeter();
  private master: Tone.Gain | null = null;
  private readonly voices = new Map<string, Voice>();
  private gestureCleanup: (() => void) | null = null;

  constructor(private readonly config: Config['audio']) {}

  /** Create the context (once), resume it, and load registered voices. */
  async start(): Promise<void> {
    if (this.state === 'idle' || this.state === 'error') {
      this.state = 'loading';
      Tone.setContext(new Tone.Context({ latencyHint: this.config.latencyHint, lookAhead: this.config.lookAhead }));
      this.master = new Tone.Gain(0.9).toDestination();
      await Promise.all([...this.voices.values()].map((v) => v.load()));
    }
    try {
      await Tone.start();
    } catch (err) {
      console.warn('[audio] context resume failed; waiting for a user gesture', err);
    }
    this.syncState();
    if (this.state !== 'running') this.resumeOnGesture();
  }

  /** Register a voice; call before or after start (it loads either way). */
  async addVoice(voice: Voice): Promise<void> {
    this.voices.set(voice.id, voice);
    if (this.state !== 'idle' && this.state !== 'error') await voice.load();
  }

  get output(): Tone.Gain {
    if (!this.master) throw new Error('AudioEngine not started');
    return this.master;
  }

  /** Reported hardware/buffer output latency, ms (0 where the browser hides it). */
  get outputLatencyMs(): number {
    const raw = Tone.getContext().rawContext as AudioContext;
    return ((raw.outputLatency ?? 0) + (raw.baseLatency ?? 0)) * 1000;
  }

  now(): number {
    return Tone.now();
  }

  stop(): void {
    this.gestureCleanup?.();
    this.gestureCleanup = null;
    for (const v of this.voices.values()) v.releaseAll();
    this.master?.dispose();
    this.master = null;
    this.state = 'idle';
  }

  private syncState(): void {
    const s = Tone.getContext().state;
    this.state = s === 'running' ? 'running' : 'suspended';
  }

  private resumeOnGesture(): void {
    if (this.gestureCleanup) return;
    const handler = () => {
      void Tone.start().then(() => {
        this.syncState();
        if (this.state === 'running') {
          this.gestureCleanup?.();
          this.gestureCleanup = null;
        }
      });
    };
    window.addEventListener('pointerdown', handler);
    window.addEventListener('keydown', handler);
    this.gestureCleanup = () => {
      window.removeEventListener('pointerdown', handler);
      window.removeEventListener('keydown', handler);
    };
  }

  /** Publish a latency sample for a sound just scheduled (called by the instrument controllers). */
  stamp(source: InstrumentEvent, detectT: number): void {
    const ev: AudioPlayedEvent = { type: 'audio.played', frameT: source.t, detectT, audioT: performance.now(), source: source.type };
    this.latency.record(ev, this.outputLatencyMs);
    bus.emit(ev);
  }
}
