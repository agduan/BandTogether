# Band Together

**Play it in the browser: https://agduan.github.io/BandTogether/** (Chrome on a laptop with a webcam works best)

A browser air band for HackMIT 2026. A webcam and an on-device hand-tracking model let one or two people play guitar, bass and drums in the air, with instruments and the song's chords drawn over the live video. Anyone can sing along through the microphone. If you are lonely, a generated backing band fills in every part nobody is playing :)

Everything runs in the page: no instrument, no controller, no account, and no backend!

## How it plays

1. Pick one or two players. With two, each player gets their own half of the screen.
2. Give each player an instrument: drums, guitar, bass, or none for vocals only.
3. Pick a song and press Play. A one-bar count-in leads into the chart.

- **Guitar and bass:** strum across the band drawn on your body. The song chart picks the chord, so every strum sounds right. The guitar strums the full chord and reacts to stroke direction and speed. The bass plays the root.
- **Drums, easy mode:** hit anywhere in time and the song picks the drum the groove wants. Your side of the screen flashes green for a hit in time and red for one off the beat, and the kit lights the drum that sounded. The kick plays itself and steps aside when you take over.
- **Drums, hard mode:** each pad plays its own drum at the speed you hit it. The spacebar is the kick pedal.
- **Calibrate:** places the kit or the strum band on your resting hands, per player, so it fits where you stand.
- **Vocals:** turn on the microphone for echo and reverb, with a microphone picker. Each song shows its starting note, and a click plays it.
- **Sing freely:** no chart at all. The app listens to the pitch you sing, works out the key, and the band follows with chords that fit.
- **Backing mix:** generated bass, pad and drums with a toggle per part and a volume per player. The part a human is playing drops out of the backing.

Songs: Viva la Vida, Counting Stars, Stand By Me, Rolling in the Deep, Someone Like You, Mr. Brightside, I Will Survive, plus Sing freely. Charts are chords only, with no lyrics or recordings.

## Stack

Vite + React + TypeScript · [`@mediapipe/tasks-vision`](https://www.npmjs.com/package/@mediapipe/tasks-vision) hand landmarker (in-browser, GPU) · [Tone.js](https://tonejs.github.io/) audio · Canvas 2D overlay · Zod config and song schemas · Vitest. No backend; everything runs offline once loaded. Pitch detection for the singer is a dependency-free YIN implementation, so the microphone audio never leaves the page.

## Setup

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest
npm run build      # typecheck + production build
```

Every push to `main` builds and deploys to GitHub Pages (`.github/workflows/deploy-pages.yml`).

Tunable thresholds can be overridden from the URL without a rebuild, e.g. `http://localhost:5173/?drum.vMin=1.4&debug.panel=true`. See `src/app/config.ts` for every key. The backtick key toggles the debug panel. While it is open, keys `1` to `6` fire drum hits and `j` / `k` fire strums, so the audio path can be tested without a camera.

The MediaPipe WASM runtime, the hand-landmark model and all audio samples are committed under `public/` so the app runs with no network access. `npm run vendor` re-fetches them (sources and licenses in `public/samples/LICENSES.md`).

## Layout

```
public/       vendored MediaPipe wasm + model, drum and guitar samples, landmark recordings
src/app       React UI, config, session (the one object the UI calls), per-player instrument wiring
src/core      shared types + conventions, typed event bus, frame loop
src/vision    camera, hand landmarker, frame adapter (mirror once, h-units), identity tracker, player regions, filters, recorder
src/detectors gesture state machines (crossing core, drum hits, guitar and bass strums, hand roles, body anchor, drum feedback)
src/audio     Tone.js engine, instrument voices, easy/hard note resolvers, song clock, backing band, singer, harmonizer
src/song      song schema, charts, chord voicings
src/render    canvas overlay, instrument art and effects, HUD, debug panel
test/         vitest specs, including fixture-driven detector tests replayed from recordings
```

## Conventions

- Geometry is in frame-height units ("h"): `y ∈ [0,1]`, `x ∈ [0, aspect]`; velocities in h/s.
- The frame adapter mirrors x once into screen space. Nothing downstream mirrors again.
- One clock: `performance.now()`. Never `Date.now()`.
- Detectors are pure `update(frame) → events[]` state machines, so they can be replayed from recordings and unit-tested.
- MediaPipe's handedness label is a prior only; hand roles come from geometry.
- Easy and hard mode differ only in the note resolver. Detectors and voices never know which one is active.

## Credits

Built at HackMIT 2026 by Keona Tang (hand tracking, gesture detectors, audio) and Alex, [@agduan](https://github.com/agduan) (UI, rendering, vocals). Sample and model licenses are in `public/samples/LICENSES.md`.
