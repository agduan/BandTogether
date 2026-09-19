import { describe, expect, it } from 'vitest';
import { IdentityTracker, type TrackerInput } from '@/vision/tracker';

const opts = { maxJump: 0.25, dedupeDist: 0.03, expiryMs: 300, handednessVoteFrames: 15 };
const hand = (x: number, y: number, handedness: 'Left' | 'Right' = 'Right', score = 0.9): TrackerInput => ({
  wrist: { x, y },
  handedness,
  score,
});

describe('IdentityTracker', () => {
  it('keeps ids stable when two hands cross paths and MediaPipe reorders them', () => {
    const tr = new IdentityTracker(opts);
    // Hand A starts left moving right; hand B starts right moving left, on a
    // slightly different height so they pass close (0.12 h) without coinciding.
    const first = tr.update([hand(0.2, 0.5, 'Left'), hand(1.1, 0.62, 'Right')], 0);
    const [idA, idB] = [first[0].trackId, first[1].trackId];
    expect(idA).not.toBe(idB);

    for (let i = 1; i <= 20; i++) {
      const ax = 0.2 + i * 0.045;
      const bx = 1.1 - i * 0.045;
      // Alternate the array order to mimic MediaPipe's unstable ordering.
      const inputs = i % 2 ? [hand(bx, 0.62, 'Right'), hand(ax, 0.5, 'Left')] : [hand(ax, 0.5, 'Left'), hand(bx, 0.62, 'Right')];
      const out = tr.update(inputs, i * 33);
      const byLabel = Object.fromEntries(out.map((o) => [inputs[o.inputIndex].handedness, o.trackId]));
      expect(byLabel.Left).toBe(idA);
      expect(byLabel.Right).toBe(idB);
    }
  });

  it('reports dt from real timestamps and 0 for a new track', () => {
    const tr = new IdentityTracker(opts);
    expect(tr.update([hand(0.5, 0.5)], 1000)[0].dt).toBe(0);
    expect(tr.update([hand(0.51, 0.5)], 1066)[0].dt).toBe(66);
  });

  it('survives a short dropout but assigns a new id after expiry', () => {
    const tr = new IdentityTracker(opts);
    const id = tr.update([hand(0.5, 0.5)], 0)[0].trackId;
    tr.update([], 100);
    expect(tr.update([hand(0.52, 0.5)], 250)[0].trackId).toBe(id);
    tr.update([], 400);
    expect(tr.update([hand(0.52, 0.5)], 700)[0].trackId).not.toBe(id);
  });

  it('does not re-use a track across an impossible jump', () => {
    const tr = new IdentityTracker(opts);
    const id = tr.update([hand(0.2, 0.5)], 0)[0].trackId;
    expect(tr.update([hand(1.0, 0.5)], 33)[0].trackId).not.toBe(id);
  });

  it('collapses one hand detected twice into a single track', () => {
    const tr = new IdentityTracker(opts);
    const out = tr.update([hand(0.5, 0.5, 'Right', 0.6), hand(0.51, 0.505, 'Right', 0.9)], 0);
    expect(out).toHaveLength(1);
    expect(out[0].inputIndex).toBe(1); // the higher-score detection wins
  });

  it('majority-votes the handedness label so single-frame flips do not show', () => {
    const tr = new IdentityTracker(opts);
    let last = tr.update([hand(0.5, 0.5, 'Right')], 0)[0];
    for (let i = 1; i <= 8; i++) last = tr.update([hand(0.5, 0.5, 'Right')], i * 33)[0];
    last = tr.update([hand(0.5, 0.5, 'Left')], 9 * 33)[0];
    expect(last.handedness).toBe('Right');
    expect(last.handednessScore).toBeCloseTo(9 / 10, 6);
  });
});
