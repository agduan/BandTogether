import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@/app/config';
import { createInstrument, INSTRUMENT_IDS, INSTRUMENT_MODES } from '@/app/instruments';
import type { ToneAudioNode } from 'tone';
import type { Vec2, VisionFrame } from '@/core/types';

const deps = () => ({ config: structuredClone(DEFAULT_CONFIG), output: () => ({}) as ToneAudioNode });

/** Canvas stand-in that records the rectangles stroked on it. */
function fakeCtx() {
  const rects: number[][] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, prop) => (prop === 'strokeRect' ? (...a: number[]) => rects.push(a) : (target[prop as string] ?? (() => {}))),
    set: (target, prop, value) => ((target[prop as string] = value), true),
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rects };
}

describe('instrument registry', () => {
  it('every pickable instrument builds and lists its modes', () => {
    for (const id of INSTRUMENT_IDS) {
      const inst = createInstrument(id, deps());
      expect(inst.id).toBe(id);
      expect(inst.view?.()?.instrument).toBe(id);
      expect(INSTRUMENT_MODES[id]).toContain('easy');
      inst.dispose?.();
    }
    expect(INSTRUMENT_MODES.guitar).toEqual(['easy']);
  });

  it('an instrument without registered art draws its detector band at the frame aspect', () => {
    const d = deps();
    const guitar = createInstrument('guitar', d);
    const frame: VisionFrame = { t: 0, aspect: 16 / 9, hands: [], inferenceMs: 0 };
    expect(guitar.detectors[0].update(frame)).toEqual([]);

    const { ctx, rects } = fakeCtx();
    const toPx = (v: Vec2): Vec2 => ({ x: v.x * 100, y: v.y * 100 });
    guitar.overlay.draw(ctx, frame, toPx);

    const { strum } = d.config;
    const [x, y, w, h] = rects[0];
    expect(x).toBeCloseTo(strum.bandXMin * (16 / 9) * 100);
    expect(y).toBeCloseTo((strum.bandY - strum.bandHalfHeight) * 100);
    expect(w).toBeCloseTo((strum.bandXMax - strum.bandXMin) * (16 / 9) * 100);
    expect(h).toBeCloseTo(2 * strum.bandHalfHeight * 100);
  });
});
