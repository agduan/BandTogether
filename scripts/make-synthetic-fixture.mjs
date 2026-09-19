#!/usr/bin/env node
// Generates public/recordings/synthetic-hits.json: a deterministic VisionFrame
// recording of a right hand doing five downward "snare" hits at 30 fps while a
// left hand rests. Used by unit tests and by the debug panel's replay before any
// real recording exists. Real recordings from the camera supersede it.
//
// Usage: node scripts/make-synthetic-fixture.mjs
import { writeFileSync, mkdirSync } from 'node:fs';

const ASPECT = 4 / 3;
const FPS = 30;
const DT = 1000 / FPS;
const DURATION_MS = 6000;
const PALM_SIZE = 0.11; // h; wrist -> middle MCP

// Hand geometry: 21 landmarks relative to the wrist, fingers pointing up (−y), in h-units.
function handPoints(wrist, mirror = 1) {
  const f = (dx, dy) => ({ x: wrist.x + mirror * dx * PALM_SIZE, y: wrist.y - dy * PALM_SIZE });
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

// Right hand trajectory: rest at y=0.45 over the snare; a hit is a 4-frame plunge to 0.72
// (~2 h/s) then a 10-frame return. Hits start at 1.0 s, every 1.0 s.
const HIT_TIMES = [1000, 2000, 3000, 4000, 5000];
function rightWristY(t) {
  const REST = 0.45;
  const DEPTH = 0.72;
  for (const h of HIT_TIMES) {
    const dtHit = t - h;
    if (dtHit >= 0 && dtHit < 4 * DT) return REST + ((DEPTH - REST) * (dtHit + DT)) / (4 * DT);
    if (dtHit >= 4 * DT && dtHit < 14 * DT) return DEPTH - ((DEPTH - REST) * (dtHit - 4 * DT + DT)) / (10 * DT);
  }
  return REST;
}

const frames = [];
const prevPalm = { 1: null, 2: null };
for (let i = 0, t = 0; t <= DURATION_MS; i++, t = i * DT) {
  const hands = [];
  const specs = [
    { trackId: 1, handedness: 'Right', wrist: { x: 0.55 * ASPECT, y: rightWristY(t) }, mirror: 1 },
    { trackId: 2, handedness: 'Left', wrist: { x: 0.2 * ASPECT + 0.01 * Math.sin(t / 700), y: 0.6 }, mirror: -1 },
  ];
  for (const s of specs) {
    const raw = handPoints(s.wrist, s.mirror);
    const palm = palmCenter(raw);
    const prev = prevPalm[s.trackId];
    const palmVel = prev ? { x: ((palm.x - prev.x) * 1000) / DT, y: ((palm.y - prev.y) * 1000) / DT } : { x: 0, y: 0 };
    prevPalm[s.trackId] = palm;
    hands.push({
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
    });
  }
  frames.push({ t, aspect: ASPECT, hands, inferenceMs: 12 });
}

const recording = {
  version: 1,
  createdAt: '2026-09-19T00:00:00.000Z',
  note: 'Synthetic: right hand (#1) plunges to y=0.72 five times over the snare area; left hand (#2) rests at (0.27, 0.6).',
  aspect: ASPECT,
  frames,
  annotations: HIT_TIMES.map((t) => ({ t: t + 2 * DT, label: 'hit', detail: 'snare' })),
};

mkdirSync('public/recordings', { recursive: true });
const json = JSON.stringify(recording, (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v));
writeFileSync('public/recordings/synthetic-hits.json', json);
console.log(`wrote public/recordings/synthetic-hits.json: ${frames.length} frames, ${(json.length / 1024).toFixed(0)} KB`);
