import { describe, expect, it } from 'vitest';
import { PlayerAssigner, playerAt, regionFor } from '@/vision/players';
import { ASPECT, handAt } from './helpers/hands';

const MID = ASPECT / 2;
const two = { count: 2, deadZone: 0.05 };

describe('player regions', () => {
  it('one player owns the whole frame, two own a half each, player 0 on the left', () => {
    expect(regionFor(0, 1)).toEqual({ x0: 0, x1: 1 });
    expect(regionFor(0, 2)).toEqual({ x0: 0, x1: 0.5 });
    expect(regionFor(1, 2)).toEqual({ x0: 0.5, x1: 1 });
    expect(playerAt(MID - 0.01, ASPECT, 2)).toBe(0);
    expect(playerAt(MID + 0.01, ASPECT, 2)).toBe(1);
    expect(playerAt(MID + 0.5, ASPECT, 1)).toBe(0);
  });
});

describe('PlayerAssigner', () => {
  it('with one player every hand is player 0', () => {
    const a = new PlayerAssigner(() => ({ count: 1, deadZone: 0.05 }));
    expect(a.update([{ trackId: 1, x: 0.1 }, { trackId: 2, x: ASPECT - 0.1 }], ASPECT, 0)).toEqual([0, 0]);
  });

  it('deals hands by the half they are born in and keeps them there when they drift over the line', () => {
    const a = new PlayerAssigner(() => two);
    expect(a.update([{ trackId: 1, x: 0.3 }, { trackId: 2, x: MID + 0.3 }], ASPECT, 0)).toEqual([0, 1]);
    // A big strum carries player 0's hand well into the right half, and player 1 reaches left.
    expect(a.update([{ trackId: 1, x: MID + 0.2 }, { trackId: 2, x: MID - 0.2 }], ASPECT, 33)).toEqual([0, 1]);
  });

  it('a hand born in the dead zone takes the side it is on, and locks once it is clearly inside a half', () => {
    const a = new PlayerAssigner(() => two);
    const near = 0.02 * ASPECT; // inside the 0.05 dead zone
    expect(a.update([{ trackId: 7, x: MID + near }], ASPECT, 0)).toEqual([1]);
    expect(a.update([{ trackId: 7, x: MID - near }], ASPECT, 33)).toEqual([0]); // still undecided
    expect(a.update([{ trackId: 7, x: MID - 0.2 }], ASPECT, 66)).toEqual([0]); // locked to player 0
    expect(a.update([{ trackId: 7, x: MID + 0.3 }], ASPECT, 99)).toEqual([0]);
  });

  it('changing the player count deals every hand again', () => {
    const players = { count: 1, deadZone: 0.05 };
    const a = new PlayerAssigner(() => players);
    expect(a.update([{ trackId: 1, x: MID + 0.3 }], ASPECT, 0)).toEqual([0]);
    players.count = 2;
    expect(a.update([{ trackId: 1, x: MID + 0.3 }], ASPECT, 33)).toEqual([1]);
    players.count = 1;
    expect(a.update([{ trackId: 1, x: MID + 0.3 }], ASPECT, 66)).toEqual([0]);
  });

  it('forgets a track that has been gone a while, or when the clock runs backwards (a looping replay)', () => {
    const a = new PlayerAssigner(() => two);
    a.update([{ trackId: 1, x: 0.3 }], ASPECT, 0);
    expect(a.update([{ trackId: 1, x: MID + 0.3 }], ASPECT, 500)).toEqual([0]); // a short dropout keeps the player
    expect(a.update([{ trackId: 1, x: MID + 0.3 }], ASPECT, 5000)).toEqual([1]);
    expect(a.update([{ trackId: 1, x: 0.3 }], ASPECT, 100)).toEqual([0]);
  });

  it('assign() re-deals a recorded frame without touching the original', () => {
    const a = new PlayerAssigner(() => two);
    const frame = { t: 0, aspect: ASPECT, inferenceMs: 0, hands: [handAt(1, { x: 0.3, y: 0.5 }, 0, 0), handAt(2, { x: MID + 0.3, y: 0.5 }, 0, 0)] };
    const dealt = a.assign(frame);
    expect(dealt.hands.map((h) => h.playerId)).toEqual([0, 1]);
    expect(frame.hands.map((h) => h.playerId)).toEqual([0, 0]);
    const one = new PlayerAssigner(() => ({ count: 1, deadZone: 0.05 }));
    expect(one.assign(frame)).toBe(frame); // nothing to change: the same object
  });
});
