import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@/app/config';
import { createInstrument, INSTRUMENT_IDS, INSTRUMENT_MODES } from '@/app/instruments';
import type { ToneAudioNode } from 'tone';
import type { Vec2, VisionFrame } from '@/core/types';
import { GuitarFx } from '@/render/fx';

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

  it('guitar uses its registered compact overlay at the frame aspect', () => {
    const d = deps();
    const guitar = createInstrument('guitar', d);
    const frame: VisionFrame = { t: 0, aspect: 16 / 9, hands: [], inferenceMs: 0 };
    expect(guitar.detectors[0].update(frame)).toEqual([]);
    expect(guitar.overlay).toBeInstanceOf(GuitarFx);

    const { ctx } = fakeCtx();
    const toPx = (v: Vec2): Vec2 => ({ x: v.x * 100, y: v.y * 100 });
    expect(() => guitar.overlay.draw(ctx, frame, toPx)).not.toThrow();
  });
});
