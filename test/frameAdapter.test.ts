import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@/app/config';
import { LM } from '@/core/types';
import { FrameAdapter, palmCenter, palmSizeOf } from '@/vision/frameAdapter';
import type { HandLandmarkerResult } from '@/vision/handLandmarker';

/** A synthetic hand: wrist at (cx, cy) in image coords, fingers pointing up, `size` = wrist→middle-MCP. */
function fakeHand(cx: number, cy: number, size: number) {
  const lm = Array.from({ length: 21 }, (_, i) => ({ x: cx, y: cy - (i / 20) * size * 2, z: 0, visibility: 1 }));
  lm[LM.MIDDLE_MCP] = { x: cx, y: cy - size, z: 0, visibility: 1 };
  return lm;
}

function result(hands: { x: number; y: number; size: number; label: 'Left' | 'Right' }[]): HandLandmarkerResult {
  return {
    landmarks: hands.map((h) => fakeHand(h.x, h.y, h.size)),
    worldLandmarks: hands.map(() => Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }))),
    handedness: hands.map((h) => [{ categoryName: h.label, score: 0.95, index: 0, displayName: h.label }]),
    handednesses: [],
  };
}

const aspect = 4 / 3;

describe('FrameAdapter', () => {
  it('mirrors into display space, computes palm metrics, and assigns a track', () => {
    const adapter = new FrameAdapter(DEFAULT_CONFIG);
    const frame = adapter.adapt(result([{ x: 0.25, y: 0.8, size: 0.1, label: 'Right' }]), 1000, aspect, 12);

    expect(frame.t).toBe(1000);
    expect(frame.aspect).toBe(aspect);
    expect(frame.inferenceMs).toBe(12);
    expect(frame.hands).toHaveLength(1);

    const hand = frame.hands[0];
    expect(hand.raw[LM.WRIST].x).toBeCloseTo(0.75 * aspect, 10); // mirrored once
    expect(hand.raw[LM.WRIST].y).toBeCloseTo(0.8, 10);
    expect(hand.palmSize).toBeCloseTo(0.1, 10);
    expect(hand.palm).toEqual(palmCenter(hand.raw));
    expect(palmSizeOf(hand.raw)).toBeCloseTo(0.1, 10);
    expect(hand.trackId).toBe(1);
    expect(hand.dt).toBe(0);
    expect(hand.handedness).toBe('Right');
    expect(hand.smooth).toEqual(hand.raw); // first sample passes through the filter unchanged
    expect(hand.palmVel).toEqual({ x: 0, y: 0 });
  });

  it('reports dt and palm velocity on the next frame of the same track', () => {
    const adapter = new FrameAdapter(DEFAULT_CONFIG);
    adapter.adapt(result([{ x: 0.5, y: 0.5, size: 0.1, label: 'Right' }]), 1000, aspect, 10);
    const frame = adapter.adapt(result([{ x: 0.5, y: 0.55, size: 0.1, label: 'Right' }]), 1033, aspect, 10);
    const hand = frame.hands[0];
    expect(hand.trackId).toBe(1);
    expect(hand.dt).toBe(33);
    expect(hand.palmVel.y).toBeCloseTo(0.05 / 0.033, 3); // ~1.5 h/s downward
    expect(hand.palmVel.x).toBeCloseTo(0, 6);
  });

  it('drops hands smaller than vision.minPalmSize (background people)', () => {
    const adapter = new FrameAdapter(DEFAULT_CONFIG);
    const frame = adapter.adapt(
      result([
        { x: 0.5, y: 0.5, size: 0.1, label: 'Right' },
        { x: 0.9, y: 0.3, size: 0.02, label: 'Left' },
      ]),
      0,
      aspect,
      10,
    );
    expect(frame.hands).toHaveLength(1);
    expect(frame.hands[0].palmSize).toBeCloseTo(0.1, 10);
  });

  it('applies vision.swapHandedness before the vote', () => {
    const swapped = { ...DEFAULT_CONFIG, vision: { ...DEFAULT_CONFIG.vision, swapHandedness: true } };
    const adapter = new FrameAdapter(swapped);
    const frame = adapter.adapt(result([{ x: 0.5, y: 0.5, size: 0.1, label: 'Left' }]), 0, aspect, 10);
    expect(frame.hands[0].handedness).toBe('Right');
  });

  it('forgets filter state for tracks that expire', () => {
    const adapter = new FrameAdapter(DEFAULT_CONFIG);
    adapter.adapt(result([{ x: 0.5, y: 0.5, size: 0.1, label: 'Right' }]), 0, aspect, 10);
    adapter.adapt(result([]), 100, aspect, 10);
    const frame = adapter.adapt(result([{ x: 0.5, y: 0.5, size: 0.1, label: 'Right' }]), 1000, aspect, 10);
    expect(frame.hands[0].trackId).toBe(2);
    expect(frame.hands[0].dt).toBe(0);
  });
  it('two players: a hand gets the player of the screen half it is born in (image x is mirrored) and keeps it', () => {
    const config = { ...DEFAULT_CONFIG, players: { ...DEFAULT_CONFIG.players, count: 2 } };
    const adapter = new FrameAdapter(config);
    // Image x 0.8 is screen-left after the mirror: player 0. Image x 0.2 is screen-right: player 1.
    const born = adapter.adapt(result([{ x: 0.8, y: 0.5, size: 0.1, label: 'Right' }, { x: 0.2, y: 0.5, size: 0.1, label: 'Left' }]), 0, aspect, 10);
    expect(born.hands.map((h) => h.playerId)).toEqual([0, 1]);
    // Player 0's hand drifts over the line in small steps: same track, same player.
    let frame = born;
    for (let i = 1; i <= 8; i++) {
      frame = adapter.adapt(result([{ x: 0.8 - i * 0.05, y: 0.5, size: 0.1, label: 'Right' }, { x: 0.2, y: 0.5, size: 0.1, label: 'Left' }]), i * 33, aspect, 10);
    }
    expect(frame.hands[0].raw[LM.WRIST].x).toBeGreaterThan(aspect / 2);
    expect(frame.hands.map((h) => h.trackId)).toEqual(born.hands.map((h) => h.trackId));
    expect(frame.hands.map((h) => h.playerId)).toEqual([0, 1]);
  });

  it('one player: every hand is player 0, wherever it is', () => {
    const adapter = new FrameAdapter(DEFAULT_CONFIG);
    const frame = adapter.adapt(result([{ x: 0.8, y: 0.5, size: 0.1, label: 'Right' }, { x: 0.2, y: 0.5, size: 0.1, label: 'Left' }]), 0, aspect, 10);
    expect(frame.hands.map((h) => h.playerId)).toEqual([0, 0]);
  });
});
