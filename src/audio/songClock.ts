import * as Tone from 'tone';
import { bus } from '@/core/bus';
import type { BeatEvent, ChordName, Song, SongContext, Voice } from '@/core/types';
import { chordAtBar } from '@/song/types';
import { isAutoKickBeat, positionWithCountIn, stepAt, type GridStep } from './groove';

export interface SongClockOptions {
  /**
   * Metronome click on every beat, accented on beat 1. The count-in always
   * clicks; this only decides what happens after it.
   */
  click: boolean;
  /** Beats of click before bar 0 of the chart; default one bar, 0 = none. */
  countInBeats?: number;
  /** true while something else (the backing band) carries the beat: the click goes quiet once the count-in is over. */
  carried?: () => boolean;
  /** Play the kick drum on beats 1 and 3 automatically (easy mode). */
  autoKick: boolean;
  /** Voice that plays the auto kick, read on every kick so it can follow an instrument swap; nothing plays if it returns null. */
  kickVoice?: () => Voice | null;
  /** Read on every kick, so it can be tuned live. */
  kickVelocity?: () => number;
}

/** One eighth-note step of the clock, handed to `onStep` listeners with the audio time it sounds at. */
export interface ClockStep extends GridStep {
  beatsPerBar: number;
  chord: ChordName;
  /** Chord of the next bar. */
  nextChord: ChordName;
  /** Seconds per eighth note. */
  stepSec: number;
}

export type StepListener = (step: ClockStep, time: number) => void;

/**
 * Song position on Tone's Transport. Publishes `song.beat` on every beat,
 * plays the click and the auto kick sample-accurately from the Transport
 * callback, and answers `context()` for the note resolvers. The chart starts
 * after a count-in (one bar of clicks unless told otherwise): until then
 * `context().countIn` is set, the chord is the chart's first and the auto kick
 * and the `onStep` listeners' parts wait.
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
  private stepCount = 0;
  private startedAt = 0;
  private readonly listeners = new Set<StepListener>();
  running = false;
  lastBeat: BeatEvent | null = null;

  constructor(song: Song, opts: SongClockOptions) {
    this.song = song;
    this.opts = opts;
  }

  get beatsPerBar(): number {
    return this.song.timeSig[0];
  }

  /** Length of the count-in, beats. */
  get countInBeats(): number {
    return Math.max(0, Math.round(this.opts.countInBeats ?? this.beatsPerBar));
  }

  /**
   * Call `cb` on every eighth note (count-in included) from the Transport
   * callback, with the audio time to schedule at. Eighths rather than beats so
   * a listener never schedules further ahead than the engine's lookAhead, and a
   * pause cannot leave a stray note behind.
   */
  onStep(cb: StepListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  start(): void {
    if (this.running) return;
    const transport = Tone.getTransport();
    transport.stop();
    transport.cancel();
    transport.position = 0;
    transport.bpm.value = this.song.bpm;
    transport.timeSignature = this.song.timeSig[0];
    if (!this.click) {
      this.click = new Tone.Synth({
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.02 },
        volume: -8,
      }).toDestination();
    }
    this.stepCount = 0;
    this.repeatId = transport.scheduleRepeat((time) => this.step(time), '8n', 0);
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
    this.listeners.clear();
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
    const p = positionWithCountIn(this.seconds, song.bpm, this.beatsPerBar, this.countInBeats);
    return {
      bpm: song.bpm,
      beatsPerBar: this.beatsPerBar,
      bar: p.bar,
      beat: p.beat,
      beatPhase: p.beatPhase,
      chord: chordAtBar(song, p.bar),
      key: song.key,
      countIn: p.countIn,
    };
  }

  private step(time: number): void {
    const s = stepAt(this.stepCount++, this.beatsPerBar, this.countInBeats);
    const chord = chordAtBar(this.song, s.bar);
    if (s.sub === 0) this.onBeat(time, s, chord);
    if (this.listeners.size === 0) return;
    const step: ClockStep = {
      ...s,
      beatsPerBar: this.beatsPerBar,
      chord,
      nextChord: chordAtBar(this.song, s.countIn ? 0 : s.bar + 1),
      stepSec: 30 / this.song.bpm,
    };
    for (const cb of this.listeners) cb(step, time);
  }

  private onBeat(time: number, { bar, beat, countIn }: GridStep, chord: ChordName): void {
    const clicks = countIn || (this.opts.click && !this.opts.carried?.());
    if (clicks) this.click?.triggerAttackRelease(beat === 0 ? 'C6' : 'G5', '32n', time, beat === 0 ? 0.6 : 0.35);
    if (!countIn && this.opts.autoKick && isAutoKickBeat(beat)) {
      this.opts.kickVoice?.()?.trigger({ sample: 'kick', velocity: this.opts.kickVelocity?.() ?? 0.85 }, time);
    }

    // The callback runs `lookAhead` before the beat sounds; stamp the audible time.
    const t = performance.now() + (time - Tone.now()) * 1000;
    const ev: BeatEvent = { type: 'song.beat', t, bar, beat, chord, ...(countIn ? { countIn } : {}) };
    this.lastBeat = ev;
    bus.emit(ev);
  }

  /** Wall-clock ms since start, for HUD fallbacks. */
  get elapsedMs(): number {
    return this.running ? performance.now() - this.startedAt : 0;
  }
}
