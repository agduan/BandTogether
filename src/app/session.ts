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
import { DrumsVoice } from '@/audio/voices/drumsVoice';

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
 * Top-level runtime: camera → hand landmarker → overlay, on the video frame
 * loop. Commit 4 inserts the frame adapter/tracker between landmarker and
 * overlay; commit 8 adds instrument controllers.
 */
export class Session {
  readonly camera: Camera;
  readonly overlay: Overlay;
  readonly audio: AudioEngine;
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
  private onPhase: (phase: SessionPhase, detail?: string) => void = () => {};

  constructor(video: HTMLVideoElement, canvas: HTMLCanvasElement, config: Config) {
    this.camera = new Camera(video);
    this.overlay = new Overlay(canvas);
    this.config = config;
    this.adapter = new FrameAdapter(config);
    this.audio = new AudioEngine(config.audio);
    void this.audio.addVoice(new DrumsVoice(() => this.audio.output));
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
    } catch (err) {
      this.teardown();
      if (this.disposed) return;
      this.onPhase('error', err instanceof Error ? err.message : String(err));
      throw err;
    }
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
    this.fpsMeter.reset();
    if (this.loop && !this.disposed) this.loop.start();
  }

  /** Restart the camera on another device; the model stays loaded. */
  async switchCamera(deviceId: string): Promise<void> {
    this.config.camera.deviceId = deviceId;
    if (!this.loop) return;
    this.stopReplay();
    this.loop.stop();
    await this.camera.start(this.config.camera);
    this.overlay.aspect = this.camera.aspect;
    this.stats.width = this.camera.width;
    this.stats.height = this.camera.height;
    this.fpsMeter.reset();
    this.adapter.reset();
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
    this.onPhase('idle');
  }

  private teardown(): void {
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
    this.recorder.push(frame);
    bus.emit({ type: 'vision.frame', frame });

    this.overlay.syncSize();
    this.overlay.aspect = frame.aspect;
    this.overlay.clear();

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
