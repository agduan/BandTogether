/**
 * MediaPipe result → VisionFrame.
 *
 * Commit 3 provides only the coordinate convention; commit 4 adds the identity
 * tracker, raw/smooth streams, palm metrics and the handedness vote.
 */
import type { Vec2 } from '@/core/types';

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
