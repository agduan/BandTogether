import { describe, expect, it, vi } from 'vitest';
import type { VisionFrame } from '@/core/types';
import { Recorder, Replayer, parseRecording, serializeRecording } from '@/vision/recorder';
import { loadFixture } from './helpers/fixtures';

const frame = (t: number): VisionFrame => ({ t, aspect: 4 / 3, hands: [], inferenceMs: 10.123456 });

describe('Recorder + serialization', () => {
  it('captures frames only while recording and round-trips through JSON', () => {
    const rec = new Recorder();
    rec.push(frame(0)); // ignored: not recording yet
    rec.start();
    rec.push(frame(100));
    rec.push(frame(133.33333));
    const out = rec.stop('two frames');
    expect(out.frames).toHaveLength(2);

    const parsed = parseRecording(serializeRecording(out));
    expect(parsed.note).toBe('two frames');
    expect(parsed.frames[1].t).toBe(133.3333); // rounded to 4 decimals
    expect(parsed.frames[0].inferenceMs).toBe(10.1235);
  });

  it('rejects files that are not recordings', () => {
    expect(() => parseRecording('{"version":2,"frames":[]}')).toThrow(/version-1/);
    expect(() => parseRecording('{"version":1,"aspect":1.33,"frames":[{"hands":[]}]}')).toThrow(/frame 0/);
  });
});

describe('Replayer', () => {
  it('emits frames at the original intervals, re-based onto the live clock', () => {
    vi.useFakeTimers();
    let now = 5000;
    const received: number[] = [];
    const rec = { version: 1 as const, createdAt: '', aspect: 4 / 3, frames: [frame(1000), frame(1033), frame(1099)] };
    const replayer = new Replayer(rec, (f) => received.push(f.t), {
      now: () => now,
      setTimeout: (fn, ms) => {
        const h = setTimeout(() => {
          now += ms;
          fn();
        }, ms);
        return h as unknown as number;
      },
      clearTimeout: (h) => clearTimeout(h),
    });

    replayer.start();
    expect(received).toEqual([5000]);
    vi.advanceTimersByTime(33);
    expect(received).toEqual([5000, 5033]);
    vi.advanceTimersByTime(66);
    expect(received).toEqual([5000, 5033, 5099]);
    expect(replayer.isRunning).toBe(false); // no loop: stops after the last frame
    vi.useRealTimers();
  });

  it('stops cleanly mid-way', () => {
    vi.useFakeTimers();
    const received: number[] = [];
    const rec = { version: 1 as const, createdAt: '', aspect: 4 / 3, frames: [frame(0), frame(33), frame(66)] };
    const replayer = new Replayer(rec, (f) => received.push(f.t), { now: () => 0 });
    replayer.start();
    replayer.stop();
    vi.advanceTimersByTime(500);
    expect(received).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe('fixture: drums_5hits', () => {
  it('loads with two tracked hands, 30 fps timing, and five annotated hits', () => {
    const rec = loadFixture('drums_5hits');
    expect(rec.frames.length).toBeGreaterThan(150);
    expect(rec.frames[0].hands.map((h) => h.trackId)).toEqual([1, 2]);
    expect(rec.frames[1].t - rec.frames[0].t).toBeCloseTo(1000 / 30, 2);
    expect(rec.frames[1].hands[0].dt).toBeCloseTo(1000 / 30, 2);
    expect(rec.annotations?.filter((a) => a.label === 'hit')).toHaveLength(5);

    // The right hand really plunges: peak downward palm velocity is above 1 h/s.
    const peak = Math.max(...rec.frames.map((f) => f.hands[0].palmVel.y));
    expect(peak).toBeGreaterThan(1);
    for (const f of rec.frames) for (const h of f.hands) expect(h.raw).toHaveLength(21);
  });
});
