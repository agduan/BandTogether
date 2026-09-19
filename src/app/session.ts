import type { Config } from './config';
import { FpsMeter, FrameLoop } from '@/core/loop';
import { Camera, type CameraInfo } from '@/vision/camera';
import { HandTracker } from '@/vision/handLandmarker';
import { FrameAdapter } from '@/vision/frameAdapter';
import { LM, type VisionFrame } from '@/core/types';
import { bus } from '@/core/bus';
import { Overlay } from '@/render/overlay';
import { Recorder, Replayer, type Recording, type ReplayerOptions } from '@/vision/recorder';
import { AudioEngine } from '@/audio/engine';
import { createResolver, FREEPLAY_CONTEXT } from '@/audio/modes';
import { BandScore, isScoredEvent } from '@/audio/score';
import { SingerChannel } from '@/audio/singer';
import { SongClock } from '@/audio/songClock';
import type { InstrumentEvent, InstrumentId, PlayerId, PlayMode, SongContext } from '@/core/types';
import { Hud } from '@/render/hud';
import { getSong } from '@/song/songs';
import { barAt, barCount } from '@/song/types';
import { InstrumentController } from './controller';
import { createInstrument } from './instruments';
import type { PlayerInfo, SessionInfo, SongInfo } from './sessionInfo';

export interface SessionStats {
  fps: number;
  inferenceMs: number;
  hands: number;
  delegate: 'GPU' | 'CPU' | '-';
  width: number;
  height: number;
  usingVideoFrameCallback: boolean;
}

export type SessionPhase = 'idle' | 'camera' | 'model' | 'audio' | 'running' | 'error';

const HAND_COLORS = ['#ff5c8a', '#5cd6ff', '#ffd75c', '#8aff5c'];

/**
 * Top-level runtime: camera → hand landmarker → frame adapter → instrument
 * controllers (detectors → bus → mode → voice) → overlay, on the video frame
 * loop. One controller per player; player 0 starts on drums and the UI swaps
 * instruments with `setInstrument`. The UI reads state from `info()`.
 */
export class Session {
  readonly camera: Camera;
  readonly overlay: Overlay;
  readonly audio: AudioEngine;
  readonly singer: SingerChannel;
  readonly hud: Hud;
  /** One per player, index = player id. */
  private readonly players: InstrumentController[] = [];
  private songClock: SongClock | null = null;
  private readonly score: BandScore;
  private readonly unsubscribeScore: () => void;
  readonly stats: SessionStats = {
    fps: 0,
    inferenceMs: 0,
    hands: 0,
    delegate: '-',
    width: 0,
    height: 0,
    usingVideoFrameCallback: false,
  };

  /** Shared, mutable at runtime by the debug panel. */
  readonly config: Config;
  private tracker: HandTracker | null = null;
  private adapter: FrameAdapter;
  private loop: FrameLoop | null = null;
  private readonly recorder = new Recorder();
  private replayer: Replayer | null = null;
  /** Most recent adapted frame, for consumers that poll instead of subscribing. */
  lastFrame: VisionFrame | null = null;
  private readonly fpsMeter = new FpsMeter();
  private disposed = false;
  private isPaused = false;
  private onPhase: (phase: SessionPhase, detail?: string) => void = () => {};

  constructor(video: HTMLVideoElement, canvas: HTMLCanvasElement, config: Config) {
    this.camera = new Camera(video);
    this.overlay = new Overlay(canvas);
    this.config = config;
    this.adapter = new FrameAdapter(config);
    this.audio = new AudioEngine(config.audio);
    this.singer = new SingerChannel(config.singer, () => this.audio.output);
    this.players.push(this.createController('drums', 0));
    this.score = new BandScore(config.score, () => this.songContext());
    this.unsubscribeScore = bus.onAny((e) => {
      if ('playerId' in e) this.judge(e);
    });
    this.hud = new Hud(() => this.info());
  }

  // --- players and instruments ---------------------------------------------

  get controllers(): ReadonlyArray<InstrumentController> {
    return this.players;
  }

  private createController(id: InstrumentId, playerId: PlayerId): InstrumentController {
    const instrument = createInstrument(id, {
      config: this.config,
      output: () => this.audio.output,
      playerId,
      song: () => this.songContext(),
    });
    void this.audio.addVoice(instrument.voice);
    return new InstrumentController({
      playerId,
      instrument,
      resolver: createResolver(this.config.play.mode),
      audio: this.audio,
      song: () => this.songContext(),
    });
  }

  /** Swap a player's instrument. Safe while running, paused or mid-song. */
  setInstrument(id: InstrumentId, playerId: PlayerId = 0): void {
    const old = this.players[playerId];
    if (!old || old.instrument.id === id) return;
    const next = this.createController(id, playerId); // throws on an unknown id before anything is torn down
    old.dispose();
    this.audio.removeVoice(old.instrument.voice);
    this.players[playerId] = next;
    this.score.resetPlayer(playerId); // a new instrument starts from zero
    // The auto kick plays through a drummer's voice: follow the swap.
    if (this.songClock) this.songClock.opts.kickVoice = this.drumsVoice();
  }

  /** Stub until row 16 (two players by screen half): records the count, still one player. */
  setNumPlayers(n: number): void {
    this.config.players.count = Math.min(2, Math.max(1, Math.round(n)));
  }

  /** Snap a player's instrument to where they are right now (the C key). Always answers with a toast. */
  calibrate(playerId: PlayerId = 0): boolean {
    const instrument = this.players[playerId]?.instrument;
    let ok = false;
    let text: string;
    if (!instrument?.calibrate) text = `Nothing to calibrate on ${instrument?.id ?? 'that player'}`;
    else if (!this.lastFrame) text = 'Start the camera first';
    else {
      ok = instrument.calibrate(this.lastFrame);
      text = ok ? 'Calibrated' : 'Hold your hands where you want to play, then calibrate';
    }
    bus.emit({ type: 'ui.toast', t: performance.now(), text, kind: ok ? 'success' : 'warn' });
    return ok;
  }

  resetCalibration(): void {
    for (const c of this.players) c.instrument.resetCalibration?.();
  }

  /** Stub until K2 (generated backing band): records the choice. */
  setBacking(on: boolean): void {
    this.config.backing.enabled = on;
  }

  /** The foot: play the kick for whoever is on drums (spacebar). Goes through the bus like a real hit. */
  kick(velocity = 0.9): void {
    const drummer = this.players.find((c) => c.instrument.id === 'drums');
    if (!drummer) return;
    bus.emit({ type: 'drum.hit', t: performance.now(), playerId: drummer.playerId, pad: 'kick', velocity });
  }

  /** Score a sounding event against the song clock. Free play and a paused band are not judged. */
  private judge(e: InstrumentEvent): void {
    if (this.isPaused) return;
    const instrument = this.players[e.playerId]?.instrument.id;
    if (instrument && isScoredEvent(e, instrument)) this.score.hit(e.playerId);
  }

  /** Zero every player's score and the tightness meter. `startSong` does this too; `setInstrument` zeroes that player. */
  resetScore(): void {
    this.score.reset();
  }

  private drumsVoice() {
    return this.players.find((c) => c.instrument.id === 'drums')?.instrument.voice ?? null;
  }

  /** Snapshot of everything the UI and HUD show. Cheap: poll it every frame or on a timer. */
  info(): SessionInfo {
    const hands = this.lastFrame?.hands ?? [];
    const players: PlayerInfo[] = this.players.map((c) => {
      const view = c.instrument.view?.() ?? null;
      return {
        id: c.playerId,
        instrument: c.instrument.id,
        hands: hands.filter((h) => h.playerId === c.playerId).length,
        calibration: view?.instrument === 'drums' ? view.calibration : 'none',
        score: this.score.info(c.playerId),
      };
    });
    return {
      mode: this.mode,
      songTitle: this.songClock?.song.title ?? null,
      songRunning: this.songRunning,
      beatsPerBar: this.songClock?.beatsPerBar ?? 4,
      instrument: this.players[0].instrument.id,
      paused: this.isPaused,
      song: this.songInfo(),
      backing: { enabled: this.config.backing.enabled },
      singer: this.singer.info(),
      players,
      band: { tightness: this.score.tightness },
    };
  }

  private songInfo(): SongInfo {
    const id = this.config.play.song;
    const song = this.songClock?.song ?? getSong(id);
    const ctx = this.songContext();
    const running = this.songRunning;
    const bar = running ? barAt(song, ctx.bar) : null;
    return {
      id,
      title: song.title,
      bpm: song.bpm,
      bar: ctx.bar,
      beat: ctx.beat,
      beatPhase: ctx.beatPhase,
      chord: ctx.chord,
      lyric: bar?.lyric ?? null,
      nextLyric: running ? (barAt(song, ctx.bar + 1).lyric ?? null) : null,
      section: bar?.section ?? null,
      barCount: barCount(song),
      running,
    };
  }

  // --- mode and song -------------------------------------------------------

  get mode(): PlayMode {
    return this.config.play.mode;
  }

  setMode(mode: PlayMode): void {
    this.config.play.mode = mode;
    for (const c of this.players) c.resolver = createResolver(mode);
  }

  get songRunning(): boolean {
    return this.songClock?.running ?? false;
  }

  get songTitle(): string | null {
    return this.songClock?.song.title ?? getSong(this.config.play.song).title;
  }

  /** Start (or restart) the song clock; needs the audio engine running. */
  startSong(songId = this.config.play.song): void {
    if (this.audio.state !== 'running') return;
    this.stopSong();
    this.score.reset();
    this.config.play.song = songId;
    const { play } = this.config;
    this.songClock = new SongClock(getSong(songId), {
      click: play.click,
      autoKick: play.autoKick && this.mode === 'easy',
      kickVoice: this.drumsVoice(),
    });
    this.songClock.start();
    if (this.isPaused) this.songClock.pause();
  }

  stopSong(): void {
    this.songClock?.dispose();
    this.songClock = null;
  }

  private songContext(): SongContext {
    return this.songClock?.context() ?? FREEPLAY_CONTEXT;
  }

  async start(onPhase?: (phase: SessionPhase, detail?: string) => void): Promise<void> {
    const report = onPhase ?? (() => {});
    this.onPhase = (phase, detail) => {
      // A stopped session stays silent so it can't overwrite a newer session's UI state.
      if (this.disposed && phase !== 'idle') return;
      console.info(`[session] ${phase}${detail ? ` — ${detail}` : ''}`);
      report(phase, detail);
    };
    try {
      // Audio first: it is quick, and the Start click that got us here counts
      // as the user gesture the browser wants for resuming the context.
      this.onPhase('audio');
      await this.audio.start();
      if (this.disposed) return this.teardown();

      this.onPhase('camera');
      await this.camera.start(this.config.camera);
      if (this.disposed) return this.teardown();

      this.onPhase('model');
      this.tracker = await HandTracker.create(this.config.vision);
      if (this.disposed) return this.teardown();
      const warmMs = this.tracker.warmUp();
      this.stats.delegate = this.tracker.delegate;
      this.onPhase('model', `warm-up ${warmMs.toFixed(0)} ms on ${this.tracker.delegate}`);

      this.overlay.aspect = this.camera.aspect;
      this.stats.width = this.camera.width;
      this.stats.height = this.camera.height;

      this.loop = new FrameLoop(this.camera.video, (video, t) => this.onFrame(video, t));
      this.stats.usingVideoFrameCallback = this.loop.usingVideoFrameCallback;
      this.fpsMeter.reset();
      this.loop.start();
      this.onPhase('running');
      if (this.config.play.autostartSong) this.startSong();
    } catch (err) {
      this.teardown();
      if (this.disposed) return;
      this.onPhase('error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  // --- pause ---------------------------------------------------------------

  get paused(): boolean {
    return this.isPaused;
  }

  /**
   * Freeze the band: the picture holds its last frame, no frames are tracked,
   * detected, recorded or drawn, the song holds its beat and ringing notes are
   * cut. The camera stream and the model stay open so `resume()` is instant.
   */
  pause(): void {
    if (this.isPaused || !this.loop) return;
    this.isPaused = true;
    this.loop.stop();
    if (this.replayer) {
      this.replayer.stop();
      this.replayer = null;
    }
    this.camera.video.pause();
    this.songClock?.pause();
    for (const c of this.players) c.instrument.voice.releaseAll();
    const aspect = this.lastFrame?.aspect ?? this.camera.aspect;
    this.overlay.drawLabel('PAUSED', { x: aspect / 2, y: 0.08 }, '#ffd75c');
  }

  resume(): void {
    if (!this.isPaused) return;
    this.clearPause();
    if (!this.loop || this.disposed) return;
    // Tracks and detector state are stale after a freeze: start clean so the
    // first frame back can't fire a phantom hit.
    this.adapter.reset();
    this.resetControllers();
    this.fpsMeter.reset();
    this.loop.start();
  }

  private resetControllers(): void {
    for (const c of this.players) c.reset();
  }

  /** Leave the paused state without touching the frame loop (callers restart it themselves). */
  private clearPause(): void {
    if (!this.isPaused) return;
    this.isPaused = false;
    void this.camera.video.play().catch(() => {});
    this.songClock?.resume();
  }

  /** 'camera' while the live loop feeds frames, 'replay' while a recording does. */
  get source(): 'camera' | 'replay' {
    return this.replayer ? 'replay' : 'camera';
  }

  get isRecording(): boolean {
    return this.recorder.isRecording;
  }

  get recordedFrames(): number {
    return this.recorder.frameCount;
  }

  startRecording(): void {
    this.recorder.start();
  }

  stopRecording(note?: string): Recording {
    return this.recorder.stop(note);
  }

  /** Pause the camera loop and drive the pipeline from a recording instead. */
  replay(rec: Recording, opts: ReplayerOptions = {}): void {
    this.clearPause();
    this.stopReplay();
    this.loop?.stop();
    this.replayer = new Replayer(rec, (frame) => this.consume(frame), opts);
    this.overlay.aspect = rec.aspect;
    this.replayer.start();
  }

  stopReplay(): void {
    if (!this.replayer) return;
    this.replayer.stop();
    this.replayer = null;
    this.adapter.reset();
    this.resetControllers();
    this.fpsMeter.reset();
    if (this.loop && !this.disposed) this.loop.start();
  }

  /** Restart the camera on another device; the model stays loaded. */
  async switchCamera(deviceId: string): Promise<void> {
    this.config.camera.deviceId = deviceId;
    if (!this.loop) return;
    this.clearPause();
    this.stopReplay();
    this.loop.stop();
    await this.camera.start(this.config.camera);
    this.overlay.aspect = this.camera.aspect;
    this.stats.width = this.camera.width;
    this.stats.height = this.camera.height;
    this.fpsMeter.reset();
    this.adapter.reset();
    this.resetControllers();
    this.loop.start();
  }

  listCameras(): Promise<CameraInfo[]> {
    return Camera.list();
  }

  get currentDeviceId(): string {
    return this.camera.deviceId;
  }

  stop(): void {
    this.disposed = true;
    this.teardown();
    for (const c of this.players) c.dispose();
    this.unsubscribeScore();
    this.singer.dispose();
    this.hud.dispose();
    this.onPhase('idle');
  }

  private teardown(): void {
    this.isPaused = false;
    this.stopSong();
    this.audio.stop();
    this.replayer?.stop();
    this.replayer = null;
    this.loop?.stop();
    this.loop = null;
    this.tracker?.close();
    this.tracker = null;
    this.camera.stop();
  }

  private onFrame(video: HTMLVideoElement, t: number): void {
    if (!this.tracker) return;
    const { result, inferenceMs } = this.tracker.detect(video, t);
    const frame = this.adapter.adapt(result, t, this.camera.aspect, inferenceMs);
    this.consume(frame);
  }

  /** Everything downstream of the frame adapter; fed by the camera loop or a replay. */
  private consume(frame: VisionFrame): void {
    this.lastFrame = frame;
    // Sound first: the controller triggers the voice synchronously, so nothing
    // below (recording, drawing) adds to the motion-to-sound latency.
    for (const c of this.players) c.onFrame(frame);
    this.recorder.push(frame);
    bus.emit({ type: 'vision.frame', frame });

    this.overlay.syncSize();
    this.overlay.aspect = frame.aspect;
    this.overlay.clear();
    for (const c of this.players) c.instrument.overlay.draw(this.overlay.ctx, frame, this.overlay.toPx);
    this.hud.draw(this.overlay.ctx, frame, this.overlay.toPx);

    if (this.config.debug.skeleton) {
      for (const hand of frame.hands) {
        // Colour by track id so a stable identity is visible at a glance.
        const color = HAND_COLORS[(hand.trackId - 1) % HAND_COLORS.length];
        this.overlay.drawHand(hand.smooth, { color });
        // Corrected + voted label. Raise only your right hand: it must read "R".
        // If it reads "L", set vision.swapHandedness=true (URL: ?vision.swapHandedness=true).
        const label = `#${hand.trackId} ${hand.handedness === 'Left' ? 'L' : 'R'} ${hand.handednessScore.toFixed(2)}`;
        this.overlay.drawLabel(label, hand.smooth[LM.WRIST], color);
      }
    }
    if (this.replayer) this.overlay.drawLabel('REPLAY', { x: frame.aspect / 2, y: 0.08 }, '#ffd75c');

    this.stats.fps = this.fpsMeter.tick(frame.t);
    this.stats.inferenceMs = this.stats.inferenceMs
      ? this.stats.inferenceMs + 0.1 * (frame.inferenceMs - this.stats.inferenceMs)
      : frame.inferenceMs;
    this.stats.hands = frame.hands.length;
  }
}
