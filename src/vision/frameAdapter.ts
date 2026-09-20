/**
 * MediaPipe result → VisionFrame.
 *
 * This is where the app's coordinate conventions are enforced (see
 * core/types.ts): display space in frame-height units, x mirrored exactly once
 * here, one clock. It also owns the per-hand state that must survive across
 * frames: identity tracks, the render-stream One-Euro filters, the palm
 * velocity buffers and the hand's player (by screen half, see players.ts), all
 * keyed by trackId.
 */
import type { Config } from '@/app/config';
import { HAND_LANDMARK_COUNT, LM, type HandFrame, type Handedness, type Vec2, type Vec3, type VisionFrame } from '@/core/types';
import type { HandLandmarkerResult } from '@/vision/handLandmarker';
import { OneEuro2D, VelocityBuffer } from './filters';
import { PlayerAssigner } from './players';
import { IdentityTracker } from './tracker';

/**
 * Convert one MediaPipe normalized landmark (x, y in [0,1] of the un-mirrored
 * camera image) into display space: mirrored so it matches what the player sees,
 * in frame-height units with x in [0, aspect]. This is the ONE place x is mirrored.
 */
export function toDisplaySpace(x: number, y: number, aspect: number): Vec2 {
  return { x: (1 - x) * aspect, y };
}

export function landmarksToDisplay(
  landmarks: ReadonlyArray<{ x: number; y: number }>,
  aspect: number,
): Vec2[] {
  return landmarks.map((lm) => toDisplaySpace(lm.x, lm.y, aspect));
}

const PALM_INDICES = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];

export function palmCenter(points: ReadonlyArray<Vec2>): Vec2 {
  let x = 0;
  let y = 0;
  for (const i of PALM_INDICES) {
    x += points[i].x;
    y += points[i].y;
  }
  return { x: x / PALM_INDICES.length, y: y / PALM_INDICES.length };
}

export function palmSizeOf(points: ReadonlyArray<Vec2>): number {
  const a = points[LM.WRIST];
  const b = points[LM.MIDDLE_MCP];
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export type AdapterConfig = Pick<Config, 'vision' | 'tracker' | 'filter' | 'players'>;

interface TrackState {
  smooth: OneEuro2D[];
  palmVel: VelocityBuffer;
}

export class FrameAdapter {
  private readonly tracker: IdentityTracker;
  private readonly states = new Map<number, TrackState>();
  private readonly players: PlayerAssigner;

  constructor(private readonly config: AdapterConfig) {
    this.tracker = new IdentityTracker(config.tracker);
    this.players = new PlayerAssigner(() => this.config.players);
  }

  adapt(result: HandLandmarkerResult, t: number, aspect: number, inferenceMs: number): VisionFrame {
    const { vision } = this.config;

    // Per-detection geometry, filtering out hands too small to be the player's.
    const candidates = result.landmarks
      .map((lms, i) => {
        const raw = landmarksToDisplay(lms, aspect);
        const label = result.handedness[i]?.[0];
        const rawLabel: Handedness = label?.categoryName === 'Left' ? 'Left' : 'Right';
        return {
          raw,
          world: (result.worldLandmarks[i] ?? []).map((w) => ({ x: w.x, y: w.y, z: w.z })) as Vec3[],
          handedness: vision.swapHandedness ? flip(rawLabel) : rawLabel,
          score: label?.score ?? 0,
          palm: palmCenter(raw),
          palmSize: palmSizeOf(raw),
        };
      })
      .filter((c) => c.raw.length === HAND_LANDMARK_COUNT && c.palmSize >= vision.minPalmSize);

    const assignments = this.tracker.update(
      candidates.map((c) => ({ wrist: c.raw[LM.WRIST], handedness: c.handedness, score: c.score })),
      t,
    );

    const playerIds = this.players.update(
      assignments.map((a) => ({ trackId: a.trackId, x: candidates[a.inputIndex].palm.x })),
      aspect,
      t,
    );

    const hands: HandFrame[] = assignments.map((a, n) => {
      const c = candidates[a.inputIndex];
      const state = this.stateFor(a.trackId);
      if (a.dt === 0) {
        for (const f of state.smooth) f.reset();
        state.palmVel.reset();
      }
      const smooth = c.raw.map((p, i) => state.smooth[i].filter(p, t));
      state.palmVel.push(c.palm, t);
      return {
        t,
        dt: a.dt,
        trackId: a.trackId,
        playerId: playerIds[n],
        handedness: a.handedness,
        handednessScore: a.handednessScore,
        raw: c.raw,
        smooth,
        world: c.world,
        palm: c.palm,
        palmVel: state.palmVel.vInst,
        palmSize: c.palmSize,
      };
    });

    for (const id of this.tracker.prune(this.states.keys())) this.states.delete(id);

    return { t, aspect, hands, inferenceMs };
  }

  reset(): void {
    this.tracker.reset();
    this.states.clear();
    this.players.reset();
  }

  private stateFor(trackId: number): TrackState {
    let state = this.states.get(trackId);
    if (!state) {
      const { filter } = this.config;
      state = {
        smooth: Array.from(
          { length: HAND_LANDMARK_COUNT },
          () => new OneEuro2D(filter.minCutoff, filter.beta, filter.dCutoff),
        ),
        palmVel: new VelocityBuffer({
          dtMinMs: filter.dtMinMs,
          dtGapMs: filter.dtGapMs,
          glitchClamp: filter.glitchClamp,
        }),
      };
      this.states.set(trackId, state);
    }
    return state;
  }
}

function flip(h: Handedness): Handedness {
  return h === 'Left' ? 'Right' : 'Left';
}
