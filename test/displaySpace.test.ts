import { describe, expect, it } from 'vitest';
import { landmarksToDisplay, toDisplaySpace } from '@/vision/frameAdapter';
import { displayToPx } from '@/render/overlay';

describe('display space conventions', () => {
  const aspect = 640 / 480;

  it('mirrors x and scales it by the aspect ratio; y stays in [0,1]', () => {
    // Camera-image left edge (x=0) is the player's right, so it lands at the screen's right edge.
    expect(toDisplaySpace(0, 0.25, aspect)).toEqual({ x: aspect, y: 0.25 });
    expect(toDisplaySpace(1, 0.9, aspect)).toEqual({ x: 0, y: 0.9 });
    expect(toDisplaySpace(0.5, 0.5, aspect).x).toBeCloseTo(aspect / 2, 10);
  });

  it('maps a whole landmark list', () => {
    const pts = landmarksToDisplay([{ x: 0.25, y: 0.5 }, { x: 0.75, y: 1 }], 2);
    expect(pts).toEqual([
      { x: 1.5, y: 0.5 },
      { x: 0.5, y: 1 },
    ]);
  });

  it('display space → pixels is resolution independent', () => {
    const p = { x: aspect / 2, y: 0.5 };
    expect(displayToPx(p, aspect, 640, 480)).toEqual({ x: 320, y: 240 });
    expect(displayToPx(p, aspect, 1280, 960)).toEqual({ x: 640, y: 480 });
    expect(displayToPx({ x: aspect, y: 1 }, aspect, 800, 600)).toEqual({ x: 800, y: 600 });
  });
});
