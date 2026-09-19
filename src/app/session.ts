import type { Config } from './config';
import { FpsMeter, FrameLoop } from '@/core/loop';
import { Camera, type CameraInfo } from '@/vision/camera';
import { HandTracker } from '@/vision/handLandmarker';
import { FrameAdapter } from '@/vision/frameAdapter';
import { LM, type VisionFrame } from '@/core/types';
import { bus } from '@/core/bus';
import { Overlay } from '@/render/overlay';

export interface SessionStats {
  fps: number;
  inferenceMs: number;
  hands: number;
  delegate: 'GPU' | 'CPU' | '-';
  width: number;
  height: number;
  usingVideoFrameCallback: boolean;
}

export type SessionPhase = 'idle' | 'camera' | 'model' | 'running' | 'error';

const HAND_COLORS = ['#ff5c8a', '#5cd6ff', '#ffd75c', '#8aff5c'];

/**
 * Top-level runtime: camera → hand landmarker → overlay, on the video frame
 * loop. Commit 4 inserts the frame adapter/tracker between landmarker and
 * overlay; commit 8 adds instrument controllers.
 */
export class Session {
  readonly camera: Camera;
  readonly overlay: Overlay;
  readonly stats: SessionStats = {
    fps: 0,
    inferenceMs: 0,
    hands: 0,
    delegate: '-',
    width: 0,
    height: 0,
    usingVideoFrameCallback: false,
  };

  private config: Config;
  private tracker: HandTracker | null = null;
  private adapter: FrameAdapter;
  private loop: FrameLoop | null = null;
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
      this.onPhase('camera');
      await this.camera.start(this.config.camera);
      if (this.disposed) return;

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

  /** Restart the camera on another device; the model stays loaded. */
  async switchCamera(deviceId: string): Promise<void> {
    this.config = { ...this.config, camera: { ...this.config.camera, deviceId } };
    if (!this.loop) return;
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
    this.loop?.stop();
    this.loop = null;
    this.tracker?.close();
    this.tracker = null;
    this.camera.stop();
  }

  private onFrame(video: HTMLVideoElement, t: number): void {
    if (!this.tracker) return;
    const { result, inferenceMs } = this.tracker.detect(video, t);
    const aspect = this.camera.aspect;
    const frame = this.adapter.adapt(result, t, aspect, inferenceMs);
    this.lastFrame = frame;
    bus.emit({ type: 'vision.frame', frame });

    this.overlay.syncSize();
    this.overlay.aspect = aspect;
    this.overlay.clear();

    for (const hand of frame.hands) {
      // Colour by track id so a stable identity is visible at a glance.
      const color = HAND_COLORS[(hand.trackId - 1) % HAND_COLORS.length];
      this.overlay.drawHand(hand.smooth, { color });
      // Corrected + voted label. Raise only your right hand: it must read "R".
      // If it reads "L", set vision.swapHandedness=true (URL: ?vision.swapHandedness=true).
      const label = `#${hand.trackId} ${hand.handedness === 'Left' ? 'L' : 'R'} ${hand.handednessScore.toFixed(2)}`;
      this.overlay.drawLabel(label, hand.smooth[LM.WRIST], color);
    }

    this.stats.fps = this.fpsMeter.tick(t);
    this.stats.inferenceMs = this.stats.inferenceMs
      ? this.stats.inferenceMs + 0.1 * (inferenceMs - this.stats.inferenceMs)
      : inferenceMs;
    this.stats.hands = frame.hands.length;
  }
}
