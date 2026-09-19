import type { HandFrame, Handedness, Vec2, VisionFrame } from '@/core/types';

export const ASPECT = 4 / 3;
export const DT = 1000 / 30;
const PALM_SIZE = 0.11;

/** A hand whose PALM CENTRE is at `palm` (landmarks are a rigid offset pattern around it). */
export function handAt(trackId: number, palm: Vec2, t: number, dt: number, opts: { handedness?: Handedness; playerId?: number; prevPalm?: Vec2 } = {}): HandFrame {
  const raw = Array.from({ length: 21 }, (_, i) => ({ x: palm.x + ((i % 5) - 2) * 0.01, y: palm.y + (Math.floor(i / 5) - 2) * 0.02 }));
  const prev = opts.prevPalm;
  const palmVel = prev && dt > 0 ? { x: ((palm.x - prev.x) * 1000) / dt, y: ((palm.y - prev.y) * 1000) / dt } : { x: 0, y: 0 };
  return {
    t, dt, trackId, playerId: opts.playerId ?? 0, handedness: opts.handedness ?? 'Right', handednessScore: 1,
    raw, smooth: raw, world: raw.map((p) => ({ ...p, z: 0 })), palm: { ...palm }, palmVel, palmSize: PALM_SIZE,
  };
}

/** Frames for one hand whose palm follows `ys` at a fixed x, 30 fps. */
export function palmSequence(trackId: number, x: number, ys: number[], t0 = 1000, opts: { handedness?: Handedness; playerId?: number } = {}): VisionFrame[] {
  let prevPalm: Vec2 | undefined;
  return ys.map((y, i) => {
    const h = handAt(trackId, { x, y }, t0 + i * DT, i === 0 ? 0 : DT, { ...opts, prevPalm });
    prevPalm = h.palm;
    return { t: h.t, aspect: ASPECT, hands: [h], inferenceMs: 10 };
  });
}

/** Merge per-hand sequences that share timestamps into two-hand frames. */
export function mergeFrames(...sequences: VisionFrame[][]): VisionFrame[] {
  return sequences[0].map((f, i) => ({ ...f, hands: sequences.flatMap((s) => s[i].hands) }));
}
