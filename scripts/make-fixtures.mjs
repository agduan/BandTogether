#!/usr/bin/env node
// Generates deterministic VisionFrame recordings under public/recordings/ for
// unit tests and for the debug panel's replay before any real recording exists:
//
//   drums_5hits.json      right hand (#1) plunges through the snare line five times
//   drums_upstrokes.json  right hand (#1) whips UP five times and drifts back down slowly
//
// Both have a resting left hand (#2) over the hi-hat. Hands are drawn in a
// drumming pose: knuckles forward, fingers pointing down, so the virtual stick
// tip (palm + wrist→middle-MCP · 1.5 · palmSize) is BELOW the wrist.
// Real recordings from the camera supersede these.
//
// Usage: node scripts/make-fixtures.mjs
import { writeFileSync, mkdirSync } from 'node:fs';

const ASPECT = 4 / 3;
const FPS = 30;
const DT = 1000 / FPS;
const DURATION_MS = 6000;
const PALM_SIZE = 0.11; // h; wrist -> middle MCP
const HIT_TIMES = [1000, 2000, 3000, 4000, 5000];

// 21 landmarks relative to the wrist, fingers pointing DOWN (+y), in h-units.
function handPoints(wrist, mirror = 1) {
  const f = (dx, dy) => ({ x: wrist.x + mirror * dx * PALM_SIZE, y: wrist.y + dy * PALM_SIZE });
  return [
    f(0, 0), // 0 wrist
    f(-0.35, 0.3), f(-0.65, 0.6), f(-0.85, 0.85), f(-1.0, 1.05), // thumb
    f(-0.3, 1.0), f(-0.32, 1.45), f(-0.33, 1.75), f(-0.34, 2.0), // index
    f(0, 1.0), f(0, 1.5), f(0, 1.85), f(0, 2.15), // middle
    f(0.3, 0.95), f(0.32, 1.4), f(0.33, 1.7), f(0.34, 1.95), // ring
    f(0.58, 0.85), f(0.62, 1.2), f(0.64, 1.45), f(0.66, 1.65), // pinky
  ];
}

function palmCenter(pts) {
  const idx = [0, 5, 9, 13, 17];
  const s = idx.reduce((a, i) => ({ x: a.x + pts[i].x, y: a.y + pts[i].y }), { x: 0, y: 0 });
  return { x: s.x / idx.length, y: s.y / idx.length };
}

// Wrist y over time for a "stroke": `fast` frames from `from` to `to`, then
// `slow` frames back. Tip = wrist + ~0.249 h, so wrist 0.20 → tip 0.45 (above
// every strike line) and wrist 0.50 → tip 0.75 (through the snare line at 0.68).
function strokeY(t, { from, to, fast, slow }) {
  for (const h of HIT_TIMES) {
    const d = t - h;
    if (d >= 0 && d < fast * DT) return from + ((to - from) * (d + DT)) / (fast * DT);
    if (d >= fast * DT && d < (fast + slow) * DT) return to - ((to - from) * (d - fast * DT + DT)) / (slow * DT);
  }
  return from;
}

const FIXTURES = {
  // 4-frame plunge ≈ 2.25 h/s (above vMin 1.0); 10-frame return.
  drums_5hits: {
    note: 'Synthetic: right hand (#1) plunges its stick tip through the snare line five times; left hand (#2) rests over the hi-hat.',
    stroke: { from: 0.2, to: 0.5, fast: 4, slow: 10 },
    // The crossing is observed on the 4th plunge frame (tip 0.674 → 0.749 across 0.68).
    annotations: HIT_TIMES.map((t) => ({ t: t + 3 * DT, label: 'hit', detail: 'snare' })),
  },
  // 4-frame whip UP ≈ 2.25 h/s, then a 20-frame drift back down ≈ 0.45 h/s (below vMin).
  drums_upstrokes: {
    note: 'Synthetic: right hand (#1) starts below the snare line, whips up five times and drifts back slowly. Must produce zero hits.',
    stroke: { from: 0.5, to: 0.2, fast: 4, slow: 20 },
    annotations: HIT_TIMES.map((t) => ({ t, label: 'upstroke', detail: 'no hit expected' })),
  },
};

function build(spec) {
  const frames = [];
  const prevPalm = { 1: null, 2: null };
  for (let i = 0, t = 0; t <= DURATION_MS; i++, t = i * DT) {
    const specs = [
      { trackId: 1, handedness: 'Right', wrist: { x: 0.41 * ASPECT, y: strokeY(t, spec.stroke) }, mirror: 1 },
      { trackId: 2, handedness: 'Left', wrist: { x: 0.2 * ASPECT + 0.01 * Math.sin(t / 700), y: 0.35 }, mirror: -1 },
    ];
    const hands = specs.map((s) => {
      const raw = handPoints(s.wrist, s.mirror);
      const palm = palmCenter(raw);
      const prev = prevPalm[s.trackId];
      const palmVel = prev ? { x: ((palm.x - prev.x) * 1000) / DT, y: ((palm.y - prev.y) * 1000) / DT } : { x: 0, y: 0 };
      prevPalm[s.trackId] = palm;
      return {
        t,
        dt: i === 0 ? 0 : DT,
        trackId: s.trackId,
        playerId: 0,
        handedness: s.handedness,
        handednessScore: 1,
        raw,
        smooth: raw,
        world: raw.map((p) => ({ x: (p.x - s.wrist.x) * 0.8, y: (p.y - s.wrist.y) * 0.8, z: 0 })),
        palm,
        palmVel,
        palmSize: PALM_SIZE,
      };
    });
    frames.push({ t, aspect: ASPECT, hands, inferenceMs: 12 });
  }
  return { version: 1, createdAt: '2026-09-19T00:00:00.000Z', note: spec.note, aspect: ASPECT, frames, annotations: spec.annotations };
}

mkdirSync('public/recordings', { recursive: true });
for (const [name, spec] of Object.entries(FIXTURES)) {
  const rec = build(spec);
  const json = JSON.stringify(rec, (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v));
  writeFileSync(`public/recordings/${name}.json`, json);
  console.log(`wrote public/recordings/${name}.json: ${rec.frames.length} frames, ${(json.length / 1024).toFixed(0)} KB`);
}
