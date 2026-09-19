import * as Tone from 'tone';
import { bus } from '@/core/bus';
import type { BeatEvent, Song, SongContext, Voice } from '@/core/types';
import { chordAtBar } from '@/song/types';
import { isAutoKickBeat, positionAt } from './groove';

export interface SongClockOptions {
  /** Metronome click on every beat, accented on beat 1. */
  click: boolean;
  /** Play the kick drum on beats 1 and 3 automatically (easy mode). */
  autoKick: boolean;
  /** Voice that plays the auto kick; nothing plays if missing. */
  kickVoice?: Voice | null;
  kickVelocity?: number;
}

/**
 * Song position on Tone's Transport. Publishes `song.beat` on every beat,
 * plays the click and the auto kick sample-accurately from the Transport
 * callback, and answers `context()` for the note resolvers.
 *
 * Create it after the audio engine started (the Transport belongs to the
 * engine's context). Beats are counted from the callback rather than read
 * back from the Transport so bar/beat can never drift from what was heard.
 */
export class SongClock {
  readonly song: Song;
  readonly opts: SongClockOptions;
  private repeatId: number | null = null;
  private click: Tone.Synth | null = null;
  private beatCount = 0;
  private startedAt = 0;
  running = false;
  lastBeat: BeatEvent | null = null;

  constructor(song: Song, opts: SongClockOptions) {
    this.song = song;
    this.opts = opts;
  }

  get beatsPerBar(): number {
    return this.song.timeSig[0];
  }

  start(): void {
    if (this.running) return;
    const transport = Tone.getTransport();
    transport.stop();
    transport.cancel();
    transport.position = 0;
    transport.bpm.value = this.song.bpm;
    transport.timeSignature = this.song.timeSig[0];
    if (this.opts.click && !this.click) {
      this.click = new Tone.Synth({
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.02 },
        volume: -8,
      }).toDestination();
    }
    this.beatCount = 0;
    this.repeatId = transport.scheduleRepeat((time) => this.onBeat(time), '4n', 0);
    this.running = true;
    this.startedAt = performance.now();
    transport.start();
  }

  stop(): void {
    if (!this.running) return;
    const transport = Tone.getTransport();
    if (this.repeatId !== null) transport.clear(this.repeatId);
    this.repeatId = null;
    transport.stop();
    transport.cancel();
    this.running = false;
  }

  /** Hold the Transport where it is; `resume()` continues from the same beat. */
  pause(): void {
    if (this.running) Tone.getTransport().pause();
  }

  resume(): void {
    if (this.running && Tone.getTransport().state !== 'started') Tone.getTransport().start();
  }

  dispose(): void {
    this.stop();
    this.click?.dispose();
    this.click = null;
  }

  /** Seconds since the song started, on the Transport clock. */
  get seconds(): number {
    return this.running ? Tone.getTransport().seconds : 0;
  }

  context(): SongContext {
    const { song } = this;
    if (!this.running) {
      return { bpm: 0, beatsPerBar: this.beatsPerBar, bar: 0, beat: 0, beatPhase: 0, chord: null, key: song.key };
    }
    const p = positionAt(this.seconds, song.bpm, this.beatsPerBar);
    return {
      bpm: song.bpm,
      beatsPerBar: this.beatsPerBar,
      bar: p.bar,
      beat: p.beat,
      beatPhase: p.beatPhase,
      chord: chordAtBar(song, p.bar),
      key: song.key,
    };
  }

  private onBeat(time: number): void {
    const count = this.beatCount++;
    const bar = Math.floor(count / this.beatsPerBar);
    const beat = count % this.beatsPerBar;

    if (this.click) this.click.triggerAttackRelease(beat === 0 ? 'C6' : 'G5', '32n', time, beat === 0 ? 0.6 : 0.35);
    if (this.opts.autoKick && isAutoKickBeat(beat)) {
      this.opts.kickVoice?.trigger({ sample: 'kick', velocity: this.opts.kickVelocity ?? 0.85 }, time);
    }

    // The callback runs `lookAhead` before the beat sounds; stamp the audible time.
    const t = performance.now() + (time - Tone.now()) * 1000;
    const ev: BeatEvent = { type: 'song.beat', t, bar, beat, chord: chordAtBar(this.song, bar) };
    this.lastBeat = ev;
    bus.emit(ev);
  }

  /** Wall-clock ms since start, for HUD fallbacks. */
  get elapsedMs(): number {
    return this.running ? performance.now() - this.startedAt : 0;
  }
}
