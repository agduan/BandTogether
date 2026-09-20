import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';
import type { Config } from '@/app/config';

export type { HandLandmarkerResult };

export interface LandmarkerPaths {
  /** Directory holding vision_wasm_internal.* and vision_wasm_nosimd_internal.* */
  wasmDir: string;
  modelPath: string;
}

/** Vendored copies under public/, prefixed with Vite's base URL for sub-path deploys. */
export const DEFAULT_LANDMARKER_PATHS: LandmarkerPaths = {
  wasmDir: `${import.meta.env.BASE_URL}wasm`,
  modelPath: `${import.meta.env.BASE_URL}models/hand_landmarker.task`,
};

export interface DetectOutput {
  result: HandLandmarkerResult;
  /** Wall time spent inside detectForVideo, ms. */
  inferenceMs: number;
}

/**
 * MediaPipe HandLandmarker in VIDEO mode.
 *
 * - Tries the GPU delegate first and falls back to CPU if creation fails.
 * - detectForVideo is synchronous and requires strictly increasing timestamps;
 *   `detect()` enforces that so a duplicated frame time never throws.
 * - The first GPU inference compiles shaders (1–3 s), so `warmUp()` runs one
 *   detection on a blank canvas before the camera loop starts.
 */
export class HandTracker {
  readonly delegate: 'GPU' | 'CPU';
  private readonly landmarker: HandLandmarker;
  private lastT = -1;
  private closed = false;
  private numHands: number;

  private constructor(landmarker: HandLandmarker, delegate: 'GPU' | 'CPU', numHands: number) {
    this.landmarker = landmarker;
    this.delegate = delegate;
    this.numHands = numHands;
  }

  static async create(
    vision: Config['vision'],
    paths: LandmarkerPaths = DEFAULT_LANDMARKER_PATHS,
  ): Promise<HandTracker> {
    const fileset = await FilesetResolver.forVisionTasks(paths.wasmDir);
    const build = (delegate: 'GPU' | 'CPU') =>
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: paths.modelPath, delegate },
        runningMode: 'VIDEO',
        numHands: vision.numHands,
        minHandDetectionConfidence: vision.minDetectionConfidence,
        minHandPresenceConfidence: vision.minPresenceConfidence,
        minTrackingConfidence: vision.minTrackingConfidence,
      });

    if (vision.delegate === 'GPU') {
      try {
        return new HandTracker(await build('GPU'), 'GPU', vision.numHands);
      } catch (err) {
        console.warn('[handLandmarker] GPU delegate failed, falling back to CPU', err);
      }
    }
    return new HandTracker(await build('CPU'), 'CPU', vision.numHands);
  }

  /** Run one detection on a blank frame so shader compilation happens before the live loop. */
  warmUp(): number {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 64, 64);
    }
    return this.detect(canvas, performance.now()).inferenceMs;
  }

  detect(source: HTMLVideoElement | HTMLCanvasElement, t: number): DetectOutput {
    if (this.closed) throw new Error('HandTracker is closed');
    // MediaPipe throws on non-increasing timestamps (ms); nudge duplicates forward.
    const stamp = t > this.lastT ? t : this.lastT + 1;
    this.lastT = stamp;
    const start = performance.now();
    const result = this.landmarker.detectForVideo(source, stamp);
    return { result, inferenceMs: performance.now() - start };
  }

  /**
   * Track more or fewer hands from now on (two per player). Kept as low as the
   * players need: while fewer than `numHands` hands are in view MediaPipe
   * re-runs its palm detector on every frame, which costs a lone player fps.
   */
  async setNumHands(n: number): Promise<void> {
    if (this.closed || n === this.numHands) return;
    const before = this.numHands;
    this.numHands = n;
    try {
      await this.landmarker.setOptions({ numHands: n });
    } catch (err) {
      this.numHands = before;
      console.warn(`[handLandmarker] could not switch to ${n} hands`, err);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.landmarker.close();
  }
}
