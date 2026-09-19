import type { Handedness, TrackId, Vec2 } from '@/core/types';

export interface TrackerOptions {
  /** Max wrist movement between consecutive frames for the same track (h). */
  maxJump: number;
  /** Two detections with wrists closer than this are one hand seen twice (h). */
  dedupeDist: number;
  /** Tracks unseen for longer than this are dropped (ms). */
  expiryMs: number;
  /** Frames of handedness labels kept for the majority vote. */
  handednessVoteFrames: number;
}

export interface TrackerInput {
  wrist: Vec2;
  /** Raw (already swap-corrected) MediaPipe label for this frame. */
  handedness: Handedness;
  /** Detection/handedness confidence, used to break dedupe ties. */
  score: number;
}

export interface TrackerOutput {
  /** Index into the inputs array this output describes. */
  inputIndex: number;
  trackId: TrackId;
  /** ms since this track's previous frame; 0 for a new track. */
  dt: number;
  /** Majority vote over recent frames. */
  handedness: Handedness;
  /** Fraction of recent frames agreeing with the vote, 0..1. */
  handednessScore: number;
}

interface Track {
  id: TrackId;
  wrist: Vec2;
  lastT: number;
  votes: Handedness[];
}

/**
 * Hand identity across frames. MediaPipe returns hands in an unstable order,
 * so every piece of per-hand state (velocity buffers, filters, detector state
 * machines) keys on the trackId assigned here, never on the array index.
 *
 * Matching is greedy nearest-wrist within `maxJump`; with at most four hands
 * this is equivalent to optimal assignment in practice and easy to reason about.
 */
export class IdentityTracker {
  private tracks: Track[] = [];
  private nextId = 1;

  constructor(private readonly opts: TrackerOptions) {}

  get activeIds(): TrackId[] {
    return this.tracks.map((t) => t.id);
  }

  update(inputs: TrackerInput[], t: number): TrackerOutput[] {
    // 1. Drop expired tracks.
    this.tracks = this.tracks.filter((tr) => t - tr.lastT <= this.opts.expiryMs);

    // 2. Dedupe near-identical detections (keep the higher score).
    const keep: number[] = [];
    inputs.forEach((input, i) => {
      const dup = keep.find((j) => dist(inputs[j].wrist, input.wrist) < this.opts.dedupeDist);
      if (dup === undefined) keep.push(i);
      else if (input.score > inputs[dup].score) keep[keep.indexOf(dup)] = i;
    });

    // 3. Greedy nearest-wrist matching.
    const pairs: { i: number; track: Track; d: number }[] = [];
    for (const i of keep) {
      for (const track of this.tracks) {
        const d = dist(track.wrist, inputs[i].wrist);
        if (d <= this.opts.maxJump) pairs.push({ i, track, d });
      }
    }
    pairs.sort((a, b) => a.d - b.d);

    const usedInputs = new Set<number>();
    const usedTracks = new Set<Track>();
    const outputs: TrackerOutput[] = [];

    for (const { i, track } of pairs) {
      if (usedInputs.has(i) || usedTracks.has(track)) continue;
      usedInputs.add(i);
      usedTracks.add(track);
      outputs.push(this.advance(track, inputs[i], t, i));
    }

    // 4. Unmatched detections start new tracks.
    for (const i of keep) {
      if (usedInputs.has(i)) continue;
      const track: Track = { id: this.nextId++, wrist: inputs[i].wrist, lastT: t, votes: [] };
      this.tracks.push(track);
      outputs.push(this.advance(track, inputs[i], t, i, true));
    }

    outputs.sort((a, b) => a.inputIndex - b.inputIndex);
    return outputs;
  }

  /** Ids that were active at some point but are not any more (for state cleanup). */
  prune(known: Iterable<TrackId>): TrackId[] {
    const active = new Set(this.activeIds);
    const gone: TrackId[] = [];
    for (const id of known) if (!active.has(id)) gone.push(id);
    return gone;
  }

  reset(): void {
    this.tracks = [];
  }

  private advance(track: Track, input: TrackerInput, t: number, inputIndex: number, isNew = false): TrackerOutput {
    const dt = isNew ? 0 : t - track.lastT;
    track.wrist = input.wrist;
    track.lastT = t;
    track.votes.push(input.handedness);
    if (track.votes.length > this.opts.handednessVoteFrames) track.votes.shift();

    const left = track.votes.filter((v) => v === 'Left').length;
    const right = track.votes.length - left;
    const handedness: Handedness = left > right ? 'Left' : right > left ? 'Right' : input.handedness;
    const agreeing = handedness === 'Left' ? left : right;

    return {
      inputIndex,
      trackId: track.id,
      dt,
      handedness,
      handednessScore: track.votes.length ? agreeing / track.votes.length : 0,
    };
  }
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
