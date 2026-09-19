# Air Band

A browser "air instrument" karaoke band for HackMIT 2026. A webcam and an on-device hand-tracking model let anyone play guitar and drums in the air, with the instruments and the song chart drawn over the live video.

- **Hard mode:** your hand shape decides the notes (a chord-shape classifier trained on hand landmarks; drum pads with hit velocity).
- **Easy mode:** the same strums and hits play the notes the song wants, so people who can't play still sound good.

## Stack

Vite + React + TypeScript · [`@mediapipe/tasks-vision`](https://www.npmjs.com/package/@mediapipe/tasks-vision) hand landmarker (in-browser, GPU) · [Tone.js](https://tonejs.github.io/) audio · Canvas 2D overlay · Vitest. No backend; everything runs offline once loaded.

## Setup

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest
npm run build      # typecheck + production build
```

Tunable thresholds can be overridden from the URL without a rebuild, e.g. `http://localhost:5173/?drum.vMin=1.4&debug.panel=true`. See `src/app/config.ts` for every key.

## Layout

```
public/      vendored MediaPipe wasm + model, samples, songs, landmark recordings, training data
src/app      React chrome, config, per-player instrument wiring
src/core     shared types + conventions, typed event bus, frame loop
src/vision   camera, hand landmarker, frame adapter (mirror once, h-units), identity tracker, filters, recorder
src/detectors gesture state machines (crossing core, drum hits, strums, chord classifier)
src/audio    Tone.js engine, instrument voices, easy/hard note resolvers, song clock
src/song     song schema, charts, chord voicings
src/render   canvas overlay, effects, HUD, debug + training panels
test/        vitest specs, including fixture-driven detector tests
```

## Conventions

- Geometry is in frame-height units ("h"): `y ∈ [0,1]`, `x ∈ [0, aspect]`; velocities in h/s.
- The frame adapter mirrors x once into screen space. Nothing downstream mirrors again.
- One clock: `performance.now()`. Never `Date.now()`.
- Detectors are pure `update(frame) → events[]` state machines, so they can be replayed from recordings and unit-tested.
- MediaPipe's handedness label is a prior only; hand roles come from geometry.

## Development flow

The build is split into small PRs in a fixed order (scaffold → assets → camera → tracker → recorder → audio → drums → song clock → guitar → classifier → chrome → deploy → multiplayer → stretch). Each PR ends with a check that can be run live or on a recorded landmark fixture.
