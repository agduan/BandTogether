/**
 * Frame loop driven by the video element's own frame cadence.
 *
 * Uses requestVideoFrameCallback where available (Chrome, Safari): the
 * callback fires once per decoded camera frame with a timestamp on the
 * performance.now() clock, which is the single clock the whole app uses.
 * Falls back to requestAnimationFrame and only calls the handler when
 * video.currentTime has advanced, so a 30 fps camera on a 120 Hz display
 * does not run inference four times per frame.
 */

export type FrameHandler = (video: HTMLVideoElement, t: number) => void;

/** Ensure timestamps handed downstream never repeat or go backwards. */
export function monotonicTimestamp(t: number, last: number): number {
  return t > last ? t : last + 1;
}

/** Exponentially smoothed frames-per-second estimate. */
export class FpsMeter {
  fps = 0;
  private lastT = -1;
  private readonly alpha: number;

  constructor(alpha = 0.1) {
    this.alpha = alpha;
  }

  tick(t: number): number {
    if (this.lastT >= 0) {
      const dt = t - this.lastT;
      if (dt > 0) {
        const inst = 1000 / dt;
        this.fps = this.fps === 0 ? inst : this.fps + this.alpha * (inst - this.fps);
      }
    }
    this.lastT = t;
    return this.fps;
  }

  reset(): void {
    this.fps = 0;
    this.lastT = -1;
  }
}

export class FrameLoop {
  readonly usingVideoFrameCallback: boolean;
  private readonly video: HTMLVideoElement;
  private readonly onFrame: FrameHandler;
  private running = false;
  private handle = 0;
  private lastT = -1;
  private lastMediaTime = -1;

  constructor(video: HTMLVideoElement, onFrame: FrameHandler) {
    this.video = video;
    this.onFrame = onFrame;
    this.usingVideoFrameCallback = typeof video.requestVideoFrameCallback === 'function';
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastT = -1;
    this.lastMediaTime = -1;
    this.schedule();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.usingVideoFrameCallback) this.video.cancelVideoFrameCallback(this.handle);
    else cancelAnimationFrame(this.handle);
    this.handle = 0;
  }

  private schedule(): void {
    if (!this.running) return;
    if (this.usingVideoFrameCallback) {
      this.handle = this.video.requestVideoFrameCallback((now) => this.tick(now));
    } else {
      this.handle = requestAnimationFrame((now) => this.tick(now));
    }
  }

  private tick(now: number): void {
    if (!this.running) return;
    const advanced = this.usingVideoFrameCallback || this.video.currentTime !== this.lastMediaTime;
    if (advanced && this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.lastMediaTime = this.video.currentTime;
      const t = monotonicTimestamp(now, this.lastT);
      this.lastT = t;
      try {
        this.onFrame(this.video, t);
      } catch (err) {
        console.error('[loop] frame handler threw', err);
      }
    }
    this.schedule();
  }
}
