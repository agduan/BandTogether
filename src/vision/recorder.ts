import type { VisionFrame } from '@/core/types';

/**
 * Record and replay VisionFrame streams.
 *
 * A recording is the post-adapter frame stream (display-space landmarks, track
 * ids, palm metrics), so replaying it exercises every detector exactly as the
 * live camera would, at the original frame timing. Recordings are the unit
 * test fixtures under public/recordings/ and the demo fallback if the camera
 * fails on stage.
 */

export interface RecordingAnnotation {
  /** Original frame timestamp (ms) the annotation refers to. */
  t: number;
  label: string;
  /** Free-form detail, e.g. the pad that should have fired. */
  detail?: string;
}

export interface Recording {
  version: 1;
  createdAt: string;
  /** Free-form description, e.g. "5 snare hits, right hand". */
  note?: string;
  aspect: number;
  frames: VisionFrame[];
  annotations?: RecordingAnnotation[];
}

export class Recorder {
  private frames: VisionFrame[] = [];
  private aspect = 4 / 3;
  private active = false;

  get isRecording(): boolean {
    return this.active;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  start(): void {
    this.frames = [];
    this.active = true;
  }

  push(frame: VisionFrame): void {
    if (!this.active) return;
    this.aspect = frame.aspect;
    this.frames.push(frame);
  }

  stop(note?: string): Recording {
    this.active = false;
    return {
      version: 1,
      createdAt: new Date().toISOString(),
      note,
      aspect: this.aspect,
      frames: this.frames,
    };
  }
}

/** JSON with numbers rounded to 4 decimals: ~1 KB per hand-frame instead of ~3 KB. */
export function serializeRecording(rec: Recording): string {
  return JSON.stringify(rec, (_key, value) =>
    typeof value === 'number' && !Number.isInteger(value) ? Math.round(value * 1e4) / 1e4 : value,
  );
}

export function parseRecording(json: string): Recording {
  const rec = JSON.parse(json) as Partial<Recording>;
  if (rec.version !== 1 || !Array.isArray(rec.frames) || typeof rec.aspect !== 'number') {
    throw new Error('not a version-1 Air Band recording');
  }
  for (const [i, f] of rec.frames.entries()) {
    if (typeof f.t !== 'number' || !Array.isArray(f.hands)) throw new Error(`frame ${i} is malformed`);
  }
  return rec as Recording;
}

/** Trigger a browser download of the recording. */
export function downloadRecording(rec: Recording, filename = `recording-${Date.now()}.json`): void {
  const blob = new Blob([serializeRecording(rec)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface ReplayerOptions {
  loop?: boolean;
  /** Playback speed multiplier; 1 = original timing. */
  speed?: number;
  /** Clock used for re-basing timestamps; defaults to performance.now. */
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => number;
  clearTimeout?: (handle: number) => void;
}

/**
 * Plays frames back at their original cadence, re-basing timestamps onto the
 * live clock so downstream velocity buffers and monotonic checks behave as
 * they would with the camera. `dt` inside each frame is preserved as recorded.
 */
export class Replayer {
  private index = 0;
  private handle = 0;
  private running = false;
  private offset = 0;
  private readonly now: () => number;
  private readonly setT: (fn: () => void, ms: number) => number;
  private readonly clearT: (handle: number) => void;

  constructor(
    private readonly rec: Recording,
    private readonly onFrame: (frame: VisionFrame) => void,
    private readonly opts: ReplayerOptions = {},
  ) {
    // globalThis timers work in the browser and in Node-based tests alike.
    this.now = opts.now ?? (() => performance.now());
    this.setT = opts.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number);
    this.clearT = opts.clearTimeout ?? ((h) => globalThis.clearTimeout(h as unknown as ReturnType<typeof setTimeout>));
  }

  get isRunning(): boolean {
    return this.running;
  }

  get progress(): number {
    return this.rec.frames.length ? this.index / this.rec.frames.length : 0;
  }

  start(): void {
    if (this.running || this.rec.frames.length === 0) return;
    this.running = true;
    this.index = 0;
    this.rebase();
    this.emitCurrent();
  }

  stop(): void {
    this.running = false;
    this.clearT(this.handle);
  }

  private rebase(): void {
    this.offset = this.now() - this.rec.frames[0].t;
  }

  private emitCurrent(): void {
    if (!this.running) return;
    const frame = this.rec.frames[this.index];
    const shifted: VisionFrame = {
      ...frame,
      t: frame.t + this.offset,
      hands: frame.hands.map((h) => ({ ...h, t: h.t + this.offset })),
    };
    this.onFrame(shifted);

    const nextIndex = this.index + 1;
    if (nextIndex >= this.rec.frames.length) {
      if (!this.opts.loop) {
        this.running = false;
        return;
      }
      // Loop: continue from the first frame after the same gap as one median-ish interval.
      const gap = this.rec.frames.length > 1 ? this.rec.frames[1].t - this.rec.frames[0].t : 33;
      this.handle = this.setT(() => {
        this.index = 0;
        this.rebase();
        this.emitCurrent();
      }, gap / (this.opts.speed ?? 1));
      return;
    }

    const delay = (this.rec.frames[nextIndex].t - frame.t) / (this.opts.speed ?? 1);
    this.handle = this.setT(() => {
      this.index = nextIndex;
      this.emitCurrent();
    }, Math.max(0, delay));
  }
}
