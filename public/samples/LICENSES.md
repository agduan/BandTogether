# Vendored asset sources and licenses

Everything under `public/` is served as-is so the app runs offline. Re-fetch with `npm run vendor` (see `scripts/vendor-assets.sh`).

| Path | Source | License |
|---|---|---|
| `public/wasm/*` | `@mediapipe/tasks-vision` npm package (Google MediaPipe), copied from `node_modules` | Apache-2.0 |
| `public/models/hand_landmarker.task` | Google MediaPipe hosted models, `hand_landmarker/float16/1` | Apache-2.0 |
| `public/samples/drums/{kick,snare,hihat,tom1,tom2,tom3}.mp3` | Tone.js audio collection (`tonejs.github.io/audio/drum-samples/acoustic-kit`), which credits `cwilso/web-audio-samples` | Redistributed by Tone.js for its examples; no explicit sample license is stated upstream |
| `public/samples/drums/crash.mp3` | Tone.js audio collection, `berklee/crash_cymbal1.mp3`, from the OLPC Berklee Sound Library | CC BY 3.0 |
| `public/samples/guitar-acoustic/*.mp3` | `nbrosowsky/tonejs-instruments` `samples/guitar-acoustic` (University of Iowa Electronic Music Studios recordings, edited by N. Brosowsky) | Samples CC BY 3.0; library code MIT |

Attribution for CC BY material: Berklee College of Music / One Laptop per Child Sound Library; University of Iowa Electronic Music Studios via Nicholaus P. Brosowsky (tonejs-instruments).

Guitar file naming: sharps are spelled with `s`, so `Fs3.mp3` is F#3. Range D2–C5.
