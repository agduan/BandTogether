import type { ToneAudioNode } from 'tone';
import type { Config } from '@/app/config';
import { bus } from '@/core/bus';
import type { SingerInfo } from '@/app/sessionInfo';

/**
 * The singer: a microphone channel with echo and reverb into the master
 * output. Not an Instrument (no detectors, no gestures); the UI drives it
 * through `session.singer`.
 *
 * K0 seam: the API and its state are final, the mic is not opened yet. Row 19
 * adds getUserMedia → gain → FeedbackDelay → Reverb → master and the level meter.
 */
export class SingerChannel {
  private isEnabled = false;
  private lastError: string | null = null;

  constructor(
    private readonly config: Config['singer'],
    /** Master output to connect to (available once the audio engine started). */
    protected readonly output: () => ToneAudioNode,
  ) {}

  get enabled(): boolean {
    return this.isEnabled;
  }

  /** false when the browser has no microphone API (or the page is not on HTTPS/localhost). */
  get available(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
  }

  /** Input level, 0..1. */
  get level(): number {
    return 0;
  }

  get error(): string | null {
    return this.lastError;
  }

  /** Open or close the mic. Resolves once the change took effect; failures land in `error` and a toast. */
  async setEnabled(on: boolean): Promise<void> {
    this.config.enabled = on;
    if (!on) {
      this.isEnabled = false;
      this.lastError = null;
      return;
    }
    this.lastError = this.available ? 'The singer mic is not wired up yet' : 'No microphone available in this browser';
    bus.emit({ type: 'ui.toast', t: performance.now(), text: this.lastError, kind: 'warn' });
  }

  /** Echo wet amount, 0..1. */
  setEcho(amount: number): void {
    this.config.echo = Math.min(1, Math.max(0, amount));
  }

  /** Reverb wet amount, 0..1. */
  setReverb(amount: number): void {
    this.config.reverb = Math.min(1, Math.max(0, amount));
  }

  info(): SingerInfo {
    return {
      enabled: this.enabled,
      available: this.available,
      level: this.level,
      echo: this.config.echo,
      reverb: this.config.reverb,
      error: this.error,
    };
  }

  dispose(): void {
    this.isEnabled = false;
  }
}
