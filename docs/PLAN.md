# HackMIT 2026 — ML/AR "Air Band" Karaoke Machine — Staged Plan

## Context

**What:** A web app that films players with a laptop webcam, tracks their hands with an ML model, and lets each person play a virtual instrument (guitar, drums, later keyboard) or sing. Visuals of the instruments, hits, chords and the song chart are overlaid on the live camera feed (AR-on-screen). Two modes per instrument:

- **HARD MODE** — realistic play. Drums: pad position + hit velocity decide the sound. (Guitar hard mode via a trained chord-shape classifier was **dropped on Sep 19** to keep the scope to what two people can ship; guitar is easy mode only. See "Scope change" below.)
- **EASY MODE** — the same trigger gestures (strum, hit) play musically-correct notes taken from a song's chord chart / beat grid, so someone who can't play still sounds good.

**Scope change (Sep 19, team decision):** no k-NN / chord classifier, no training panel, no training data. Guitar ships in easy mode only (the chart picks the chord, the strum plays it). The commit table below is renumbered accordingly; Stage 3 is gone. If time is left, a rule-based guitar hard mode (e.g. number of extended fingers picks the chord) is a single optional commit, not a stage.

**Team split (two people):** one owns UI/render, one owns instrument tech. File ownership and the shared-file rules are in "Collaboration" under the commit table.

**Why staged:** 24-hour hackathon. Each stage below ends in something demo-able, so the team always has a working product to show, and later stages are additive.

**Decisions confirmed with the team:** browser web app · React + Vite · drums-first MVP · Meta is the only sponsor integration that gets work items (Long Lake and Ramp are free submissions; Deepgram/OpenAI are optional add-ons only if ahead of schedule).

**Event facts pulled from the folder (HackerGuide.md, ChallengePrizes.md, SponsorChallenges.md):**

| Fact | Detail |
|---|---|
| Hacking window | Sat Sep 19, 11:00 → Sun Sep 20, 11:00 (24h). Venue closes 1am, reopens 7am. |
| **Track name** | Tracks are Sustainability, **Interactive Media**, Education, Healthcare. There is no "Entertainment" track — submit to **Interactive Media**. |
| **Hard deadline 1** | Create + join a project on Plume **before midnight Saturday** or you can't be judged. |
| **Hard deadline 2** | Submit project details on Plume by **11:00 Sunday**. |
| Judging | Expo 12:00–2:30 (5–7 min table demos), panel 2:45–4:45. Criteria: Innovation 30%, Technical Complexity 30%, Impact 30%, Learning & Collaboration 10%. |
| Track prize | 1st ≈ $375/person (Switch, Ray-Ban Meta, DDJ-FLX4 DJ controller...), 2nd ≈ $250, 3rd ≈ $125. |
| Hardware Hub | hardware.hackmit.org — stock was depleted by early Saturday afternoon (only an Arducam OV2640 SPI camera shield and a Raspberry Pi mini display remained; neither is usable here: the Arducam can't feed the browser and the mini display needs a Pi). Demo gear comes from the team's own devices. ASUS hardware is at the ASUS booth, not the hub. |

---

## Stack (all free / open source)

**Why a web app:** MediaPipe hand tracking runs in-browser at 30+ fps on a laptop GPU, Web Audio gives <20 ms trigger latency, the AR overlay is a canvas over a `<video>`, nothing to install for judges, a static deploy gives a public URL (QR on the table), and phone-as-microphone is natural in a browser (WebRTC).

| Layer | Choice | Notes |
|---|---|---|
| Build / UI | **Vite + TypeScript + React** | React only for chrome (pickers, HUD, panels). The camera→ML→audio loop is a plain video-frame-callback loop outside React. |
| Hand tracking | **`@mediapipe/tasks-vision`** (v1.0.1 pinned) `HandLandmarker`, GPU delegate, VIDEO mode | 21 landmarks/hand: normalized x,y,z + `worldLandmarks` (meters) + handedness. `detectForVideo(video, timestampMs)` is synchronous and needs monotonic timestamps. Vendor the `.task` model + WASM folder into `public/` so venue WiFi can't break the demo. |
| Body tracking (Stage 5) | `PoseLandmarker` lite, same package | Torso-anchored guitar + hand→player assignment. Run every 2nd–3rd frame. |
| Audio | **Tone.js** | `Sampler` for instruments, `Players` for drum one-shots, `Transport` for the song clock, `FeedbackDelay`/`Reverb`/`PitchShift` for singer FX. **Set `Tone.getContext().lookAhead = 0.01`** — the default 0.1 s is a hidden 100 ms of lag. |
| Samples | `nbrosowsky/tonejs-instruments` (guitar-acoustic/electric/nylon, piano; CC-BY 3.0 samples, MIT code) + Tone.js drum kits (`tonejs.github.io/audio/drum-samples/<Kit>/{kick,snare,hihat,tom1..3}.mp3`) | Both verified reachable today. Copy into `public/samples/`. |
| Overlay | **Canvas 2D** | Glow via `shadowBlur`, particles are a small array. Three.js only if someone specifically wants 3D. |
| Chord classifier | **Dropped (Sep 19).** | Guitar is easy mode only. An in-browser k-NN was the original plan; it can be revived later if wanted. |
| Tests | Vitest on recorded landmark fixtures | Detectors are pure `update(frame) → events`, so fixtures give deterministic tests. |
| Deploy | Vercel / Netlify / GitHub Pages (static) | HTTPS is required for `getUserMedia` off localhost. Demo in Chrome (best video-frame callback + audio latency). |
| Backend | **None.** | Public repo required by Meta → never commit keys (`.env` + `.gitignore`) if an optional add-on needs one. |
| Singer mic (stretch) | Wired earbuds-with-mic via `getUserMedia` first; PeerJS (free public signaling) + `qrcode` for phone-as-mic | Browser audio processing off for music. The phone option needs same-WiFi WebRTC, which the venue may block. |
| Pitch detection (stretch) | `pitchy` (McLeod) | Autotune-lite for the singer. |

---

## Architecture

```
webcam ─► <video> ─► HandLandmarker (GPU) ─► frameAdapter ─► VisionFrame {t, aspect, hands[]}
                                              (mirror once, h-units, identity tracker,
                                               raw+smooth streams, roles, playerId)
                    ┌─────────────────────────────────────────┤ per player
                    ▼                                         ▼
      InstrumentController (guitar | drums | keys)       Renderer (canvas overlay + HUD)
      ├─ detectors: crossingCore-based hit/strum
      └─ InstrumentEvents ──► EventBus ──► NoteResolver (EasyMode | HardMode) ──► Voice (Tone.js)
                                  │                                └─ SongClock (Transport, chart, beat grid)
                                  └──► recorder / latency meter / HUD
```

**Conventions (write these down in `core/types.ts` and never break them):**
- Geometry is in **frame-height units ("h")**: `y ∈ [0,1]`, `x ∈ [0, aspect]`. Velocities in h/s. Thresholds are then resolution-independent and isotropic. Layout configs are written as fractions of width/height and converted once.
- The frame adapter mirrors x **once** into what the player sees on screen. Nothing downstream mirrors again.
- One clock: `performance.now()` (or the video-frame-callback `now`). Never `Date.now()` or a frame counter.
- Detectors are pure state machines over frames → replayable, testable, tunable at a desk.
- Handedness labels are a **prior only**; roles (strum/fret) come from geometry.

### Repo layout (repo root; created in Stage 0 with stubs so 3–4 people can work in parallel)

```
public/
  models/hand_landmarker.task          (+ pose_landmarker_lite.task in Stage 5)
  wasm/                                (copied from node_modules/@mediapipe/tasks-vision/wasm)
  samples/{guitar-acoustic,drums,piano}/*.mp3
  songs/*.json
  recordings/*.json                    (landmark fixtures: tests, tuning, demo fallback)
src/
  app/        main.tsx, App.tsx (React chrome), config.ts (single Config object + URL overrides like ?drum.vMin=1.4),
              controller.ts (per player + instrument wiring), instruments.ts (registry)
  core/       types.ts, bus.ts (typed emitter via mitt), loop.ts (requestVideoFrameCallback loop, rAF fallback)
  vision/     camera.ts, handLandmarker.ts (init + warm-up), frameAdapter.ts (result → VisionFrame),
              tracker.ts (hand identity), filters.ts (OneEuro, VelocityBuffer), recorder.ts (record/replay),
              poseTracker.ts (Stage 5)
  detectors/  detector.ts (interface), crossingCore.ts (shared segment-vs-line state machine),
              drumHitDetector.ts, strumDetector.ts, roles.ts (fret/strum + player assignment),
              keyPressDetector.ts (stretch)
  audio/      engine.ts (Tone context, lookAhead, preload), voices/{guitar,drums,piano}Voice.ts,
              modes.ts (NoteResolver: EasyMode, HardMode), songClock.ts (Transport, chart, beat grid),
              groove.ts (beat-role table), effects.ts (stretch)
  song/       types.ts, songs/*.ts, chords.ts (voicings)
  render/     overlay.ts, fx.ts, hud.ts, DebugPanel.tsx
  integrations/ (optional add-ons only: deepgram.ts, llmChart.ts)
test/         vitest specs over public/recordings fixtures
```

### Core interfaces (write these first; everything codes against them)

```ts
type Vec2 = { x: number; y: number }; type Vec3 = { x: number; y: number; z: number };

interface HandFrame {
  t: number; dt: number;                       // ms; dt = 0 on a new or gapped track
  trackId: number; playerId: number;           // identity tracker / player assigner
  handedness: 'Left' | 'Right'; handednessScore: number;   // corrected + majority-voted; PRIOR only
  role?: 'strum' | 'fret' | 'drum' | 'piano';
  raw: Vec2[]; smooth: Vec2[]; world: Vec3[];  // 21 each. Triggers read raw; rendering/hover reads smooth
  palm: Vec2; palmVel: Vec2; palmSize: number; // palm = mean(lm 0,5,9,13,17); palmSize = |lm9 − lm0|
}
interface VisionFrame { t: number; aspect: number; hands: HandFrame[]; inferenceMs: number }

type InstrumentEvent =
  | { type: 'drum.hit';     t: number; playerId: number; pad: string; velocity: number }
  | { type: 'guitar.strum'; t: number; playerId: number; direction: 'down' | 'up'; velocity: number;
                            chord: string | null; chordConfidence: number }
  | { type: 'guitar.chord'; t: number; playerId: number; chord: string | null; confidence: number } // on change only
  | { type: 'piano.press' | 'piano.release'; t: number; playerId: number; finger: number; keyZone?: number; velocity?: number };

interface Detector<E extends InstrumentEvent = InstrumentEvent> {
  readonly id: string;
  update(frame: VisionFrame): E[];             // pure: replayable and unit-testable
  reset(): void;
  debugDraw?(ctx: CanvasRenderingContext2D, toPx: (v: Vec2) => Vec2): void;
}

interface NoteResolver {                       // "the mode": EasyMode | HardMode
  resolveStrum(e: StrumEvent, song: SongContext): { notes: (string | null)[]; velocities: number[] };
  resolveDrum(e: DrumHitEvent, song: SongContext): { sample: string; velocity: number };
  resolvePress(e: PressEvent, song: SongContext): { note: string; velocity: number };
}
interface Instrument { id: string; detectors: Detector[]; voice: Voice; zones: Zone[]; overlay: OverlayLayer }

interface Song {
  title: string; bpm: number; key: string; timeSig: [number, number];
  sections: { name: string; bars: { chord: ChordName; lyric?: string }[] }[];
  backingTrackUrl?: string;
}
```

Pipeline: `camera.onFrame(video, t)` → `landmarker.detectForVideo(video, t)` → `frameAdapter` → each `InstrumentController(playerId, instrument, mode)` filters to its player's hands, runs `detector.update`, publishes events → resolver → voice; renderer, HUD, recorder subscribe. Modes swap by replacing the resolver; multiplayer is additive (a player assigner sets `playerId`, a second controller binds to it).

**Session API the UI codes against** (in `app/session.ts`; the instrument owner fills these in, the UI owner calls them): `start(onPhase)`, `stop()`, `setInstrument(id)`, `setMode(mode)`, `startSong(id?)`, `stopSong()`, `songRunning`, `songTitle`, `mode`, `switchCamera(id)`, `replay(rec)` / `stopReplay()`, `startRecording()` / `stopRecording()`, `stats`, `audio.latency.stats`. Everything else the UI needs arrives as bus events (`drum.hit`, `guitar.strum`, `guitar.chord`, `song.beat`, `audio.played`, `vision.frame`).

---

## Stages

Estimates assume 3–4 people in parallel from ~1pm Saturday. Each stage ends with a "done when" so nobody over-builds. Starting threshold values are in the appendix; all of them will be tuned on recordings and on-site.

### Stage 0 — Scaffold, pipeline proof, hour-one tooling (≈1.5–2 h, all hands)
**Goal:** camera → landmarks → canvas overlay → a Tone.js note, at ≥25 fps, with the tooling every later stage depends on.

- `npm create vite@latest` (react-ts) at the repo root. Deps: `@mediapipe/tasks-vision`, `tone`, `mitt`, `zod`, `vitest`. Copy WASM + model into `public/`.
- `camera.ts`: request **640×480** (MediaPipe resizes to 224² internally; 720p buys nothing and costs exposure time), `frameRate: { ideal: 60 }`. Drive the loop with `requestVideoFrameCallback` (rAF fallback). Include a camera device picker (`enumerateDevices`, `deviceId` in Config) so an iPhone via macOS Continuity Camera, or any borrowed webcam, can replace the lid camera with no code change.
- `handLandmarker.ts`: GPU delegate, VIDEO mode, `numHands: 2`, confidences 0.5 (drop to 0.4 in bad light). **Warm up with a dummy frame** — the first GPU inference compiles shaders (1–3 s) — before showing "ready".
- `frameAdapter.ts`: convert to display space once (mirror x, h-units); run the **identity tracker** (`tracker.ts`: match hands to last frame's tracks by nearest wrist, max jump 0.25 h, dedupe wrists < 0.03 h apart — one hand seen twice —, expire after 300 ms; MediaPipe's hand order is *not* stable across frames, so all per-hand state keys on `trackId`); attach `raw` + One-Euro `smooth` streams; palm/palmSize/palmVel; handedness majority-voted over 15 frames after a `SWAP_HANDEDNESS` flag you **verify empirically in this hour** (raise only your right hand; if it reads Left, flip the flag).
- `engine.ts`: "Start Band" button → `Tone.start()`; `lookAhead = 0.01`, `latencyHint: 'interactive'`; preload one drum kit + the acoustic guitar sampler; keys 1–6 play chords to confirm latency feels instant.
- **Hour-one tooling (build before any instrument):**
  1. `recorder.ts`: a key records the `VisionFrame` stream to JSON (optionally with a `MediaRecorder` clip); replay feeds frames to detectors at original timestamps → Vitest fixtures and the demo fallback.
  2. Debug HUD: fps, inference ms, per-track id/role/label/state, velocity vectors, zones, last event, **latency meter** (stamp frameTime/detectTime/audioTime on each event, rolling means).
  3. Live config panel bound to one `Config` object with URL overrides, so on-site tuning needs no rebuild.
  4. Keyboard event injector: fire any `InstrumentEvent` from a key to test audio without a camera.
- Commit the interfaces + stub modules, then split up.

**Done when:** hands tracked and drawn at ≥25 fps; key press plays a sound instantly; a recording replays and one fixture test passes.

### Stage 1 — MVP: Air Drums, single player (≈2.5 h)
**Why drums first:** whole-hand motion, large targets, no classifier, no role assignment, no handedness dependence, survives blur and bad light; judges succeed on the first try; it exercises every shared piece (tracker, velocity, crossing core, bus, Tone latency, overlay, recorder) so the shared thresholds are tuned before guitar needs them. The strum detector then reuses ~80% of this code.

- **Tracked point: a virtual stick tip, not a fingertip** (in a fist the fingertips are curled, occluded and noisiest): `tip = palm + normalize(lm9 − lm0) · 1.5 · palmSize`. Draw palm→tip as a stick on the overlay so the mechanic is self-explanatory. Config fallback `trackedPoint: 'palm'`.
- **Velocity** (`filters.ts` VelocityBuffer, per track, last 4 samples): `vInst` = one-frame backward difference over real `dt` (the trigger signal, lowest latency); `vPeak` = max downward component over the last 3 samples (the intensity signal — people decelerate into the imaginary surface). Skip `dt < 8 ms`; treat `dt > 120 ms` as a gap (no velocity, state re-derived from position); discard `|v| > 12 h/s` (tracker identity-swap glitch) and reset the buffer.
- **Crossing, not containment.** At 4 h/s a hit moves 0.13 h per frame — bigger than a pad — so "inside pad + moving down" misses fast hits and double-fires on slow ones. Each pad has a horizontal **strike line** at its vertical center; fire when the segment `tip_prev → tip_now` crosses it downward and the interpolated crossing x is within the pad's x-range ± 0.03 h. Put this in `crossingCore.ts` (segment-vs-line test, hysteresis, refractory, gap handling, optional anticipation) — the strum detector instantiates the same core bidirectionally.
- **State machine per (track, pad):** `ARMED → [downward crossing ∧ vInst.y ≥ V_MIN ∧ velocity within ~53° of vertical] → emit hit → STRUCK → [y < strikeY − 0.04 h] → ARMED`. Upstrokes cannot fire (only downward crossings are tested); the re-arm margin absorbs the rebound bounce. Refractory 80 ms per (track, pad) + 30 ms per pad across tracks. Track lost >120 ms → on re-acquire, ARMED if above the line else STRUCK (no phantom hit). Optional **anticipation** (fire when the predicted position crosses within 30–40 ms) cancels most pipeline latency; start at 0, try on-site.
- **Velocity → volume:** `u = clamp((vPeak − V_MIN)/(V_MAX − V_MIN), 0, 1)`, `vel = 0.3 + 0.7·u^0.7`. Use velocity layers if the kit has them.
- **Kit layout** (fractions of width × strike-line y in h; arranged like a kit from the drummer's seat, mirrored view): hi-hat x 0.17–0.34 / y 0.50; snare 0.31–0.51 / 0.68; hi tom 0.53–0.70 / 0.50; mid tom 0.73–0.87 / 0.55; crash 0.79–0.96 / 0.40; kick 0.48–0.65 / 0.85. Pads 0.25–0.35 h wide (big, for judges); no x-overlap; a crossing in a gap resolves to the nearest pad within 0.05 h. **Kick by hand is awkward: easy mode plays the kick from the beat grid automatically; hard mode allows the kick pad or the spacebar — any USB keyboard on the floor works as a foot pedal.**
- **Audio:** `Tone.Players` one-shots; velocity → gain.
- **Easy mode (zero latency, no quantization lag):** a hit *anywhere* plays the drum the song's groove wants at the current beat position (beats 1,3 → kick, 2,4 → snare, off-beats → hi-hat, bar 4 beat 4 → crash) from `songClock`, plus the auto-kick. Flailing produces a groove. **Hard mode:** raw pad + velocity.
- **Overlay:** pad flash (scale + alpha tween 150 ms), particle burst, stick drawing, skeleton toggle.
- **Tests:** fixture `drums_5hits.json` → exactly 5 hits within ±1 frame of annotated times; `drums_upstrokes.json` → 0 hits.

**Done when:** ≥18/20 deliberate hits trigger, ≤1 false trigger, feels instant, easy mode grooves to a metronome.

### Stage 2 — Guitar EASY MODE (≈3 h)
- **Guitar as a local frame** `GuitarFrame { origin, angleDeg, scale }`; the strum detector works in `(u along the strings, w perpendicular, w increasing toward the floor)`. Anchoring later (Stage 5, torso via Pose) changes one producer, not the detector. **MVP: fixed on screen** with a "stand here" silhouette and a one-key "put the guitar where my strumming hand is" calibration. Angle 0; band center at y ≈ 0.62, half-height 0.05 h; u-range x ≈ 0.53–0.81 of width (right-center of the mirrored view; the neck points screen-left for a right-handed player). Anchoring to the fretting hand is rejected: it is the flakiest track, so the strings would jump exactly when the classifier struggles.
- **Roles from geometry, not labels** (`roles.ts`): `score_strum = 0.4·[label==Right] + 0.4·(1 − dist to band) + 0.2·[x on the strumming side]`; argmax = strummer, the other = fretter; sticky (swap only if the ordering persists 500 ms). One hand near the band = strummer, so easy mode works with no fretting hand. A "lefty" toggle mirrors the drawing and the prior.
- **Strum trigger: Schmitt trigger on the band centerline.** Track the palm center. `side = w > +HYST ? BELOW : w < −HYST ? ABOVE : previous` with `HYST = 0.02 h`; strum when the side changes ∧ `|vInst.w| ≥ V_MIN` ∧ u inside the band ± 0.05 h; became BELOW → down-strum, else up. A hand oscillating ±0.05 h around the strings still alternates down/up, which is what sloppy air-strumming looks like. Refractory 60 ms same direction, 40 ms opposite. Config fallback (not default): velocity-onset trigger inside the band (+0.1 h) if judges make tiny motions that never cross the centerline.
- **Intensity:** same mapping as drums with `V_MIN 0.5`, `V_MAX 3.0 h/s`, floor 0.35.
- **Chord voicings** (`song/chords.ts`, 6 slots low→high, `null` = muted): G `[G2,B2,D3,G3,B3,G4]`, C `[–,C3,E3,G3,C4,E4]`, D `[–,–,D3,A3,D4,F#4]`, Em `[E2,B2,E3,G3,B3,E4]`, Am `[–,A2,E3,A3,C4,E4]`, A `[–,A2,E3,A3,C#4,E4]`, E `[E2,B2,E3,G#3,B3,E4]`. Add more freely: with no classifier, any chord a chart names just needs a voicing here.
- **Strum sound** (`guitarVoice.ts`): the camera can't resolve individual string crossings, so synthesize them from one event. Down-strum plays strings 6→1, up 1→6; spacing `Δ = clamp(15 / v, 4, 20) ms` (v in h/s) ± 1.5 ms humanize; schedule string i at `Tone.now() + i·Δ`. Up-strums play strings 1–4 only at 0.85× velocity (unless the hand is near the neck side); down-strums accent the bass string. Each string rings one note: `triggerRelease` (30 ms) the old note before re-attacking; a new chord quick-releases the old notes. A percussive "chuck" mute sample plays when there is no chord (song stopped in freeplay with no loop).
- **Song clock** (`songClock.ts`): `Tone.Transport` at the song's BPM, optional click/backing loop, `currentChord()` from the chart. Easy-mode chord = `currentChord()`. Freeplay fallback (no transport): advance through a I–V–vi–IV loop every 2 strums.
- **Built-in songs:** 2–3 JSON charts (done in commit 9: "When the Saints Go Marching In" in G, "Campfire Loop"). Public-domain material for anything with displayed lyrics; chord progressions themselves are fine. Any chord is allowed now, as long as `song/chords.ts` has a voicing for it.
- **Overlay:** strings wiggle (decaying sine, ~400 ms) on the strummed strings; chord badge; chart timeline with a "now" cursor.

**Done when:** direction correct ≥90% of strums, random flailing over a chart sounds like a song.

### Stage 3 — (dropped Sep 19) Guitar hard mode / chord classifier
Removed from scope: no k-NN, no features, no training panel, no training data. The "ML story" for judges is the real-time hand-tracking pipeline, the crossing/strum detectors, and the easy-mode musical mapping. Optional, only if everything else is done: a rule-based guitar hard mode where the number of extended fingers on the fretting hand picks a chord from a fixed list (one small commit, no data).

### Stage 4 — Karaoke layer + AR polish + product chrome (≈3 h, UI owner, in parallel with Stage 2)
- Instrument picker, easy/hard toggle, song picker, "Start Band" flow, calibration flow, one-key reset.
- HUD: chord chart timeline, beat pulse, score, lyric line (for the future singer), latency meter hidden behind a debug toggle.
- AR: guitar/drum-kit art with gradients and glow; hit particles; chord badge follows the fretting hand; "stand here" silhouette; confetti on a clean 8 bars.
- **Create the Plume project before midnight** (name + team is enough).
- Deploy the static build (HTTPS URL + QR code for the table).

### Stage 5 — Multiplayer band (≈2–3 h) — the Meta "bringing people together" story
- `numHands: 4` (inference time roughly doubles; stay at 480p, accept ~24 fps). **Assignment v1:** vertical screen halves with a 0.1 h dead zone — guitarist left half, drummer right half, zones laid out so natural motion never crosses the midline. Each `Player` holds its own instrument, mode, classifier state and score; pan each player's mixer channel left/right. Groundwork (`Player`, `roles.ts` player assignment) can start during Stage 3/4 by the 4th person.
- **Assignment v2 + body-anchored AR** (only if players must overlap): `PoseLandmarker` (`numPoses: 2`, lite, every 2nd–3rd frame): match each hand to the nearest pose wrist (landmarks 15/16, within 0.08 h); draw the guitar strap-style across the torso (shoulders 11/12, hips 23/24); the drum kit sits in front of the drummer.
- **Band UX:** "Player 2 joined on drums" toast, per-player score, a shared "band tightness" meter (fraction of hits/strums on the beat) so two people have a common goal on screen.

**Done when:** two people stand in their halves, each gets their own instrument, ≥20 fps, scores update per player.

### Stage 6 — Stretch (only after Stage 5 is stable)
- **Keyboard (easy mode only):** per-finger **curl-based Schmitt trigger** — `curl = MCP + PIP flexion` (degrees, 0 = straight) from world landmarks; baseline = slow EMA (τ 2 s) updated only while not pressed; press when `curl > baseline + 25°` with rate ≥ 200°/s; release below `baseline + 10°`; per-finger refractory 100 ms; ≥4 fingers within 50 ms = whole-hand drop → reject. Key chosen by the smoothed fingertip x over a fixed key strip; easy mode plays the next melody note / nearest chord tone. Fingertip velocity and z-depth were considered and rejected (motion is 10–50× smaller than a drum hit, so jitter dominates).
- **Singer:** simplest mic = wired earbuds with an inline mic in the laptop's headphone jack, opened with `getUserMedia` audio with browser echo cancellation / noise suppression / auto-gain **off** (otherwise the browser suppresses the singing whenever the backing track plays); phone as mic (PeerJS room + QR) is the wireless upgrade. Incoming stream → Tone chain: `FeedbackDelay` (echo) → `Reverb` → out; autotune-lite = `pitchy` pitch → nearest scale note of the song key → `PitchShift`; lyric line on the HUD. If a lyric-accuracy score is wanted, Meta's Muse Voice Transcribe ($50 free credits/participant, OpenAI-SDK-compatible streaming STT) fits the Meta submission better than Deepgram.
- **Optional sponsor add-ons (each <1 h, only if genuinely ahead):** Deepgram push-to-talk voice commands ("switch to drums"); OpenAI song-name → chord-chart JSON (needs Codex usage too). Not planned work.

### Stage 7 — Demo prep + Meta deliverables (≈2 h, Sunday 8–11am; do not skip)
- Full run-through on the actual demo laptop in the venue lighting (Saturday evening too). The Hardware Hub is empty, so: **camera** = an iPhone on macOS Continuity Camera (or a borrowed webcam) propped at chest height, else the laptop on a box so the lid camera sits at chest height; **light** = a desk lamp or a second laptop showing a white screen as fill; **sound** = a *wired* speaker if anyone has one (Bluetooth adds 100–200 ms and is unusable for instruments), else laptop speakers at full volume with judges standing close; a **cardboard prop guitar** (no electronics) gives the fretting hand a stable reference and looks good on camera. Record every judge session for later tuning.
- **Meta requires:** a working prototype, a **2–3 min demo video** of two people playing together, a **public repo** (no keys committed), and a **short write-up**: who it's for (friends/parties/people who never learned an instrument), how it strengthens connection (you form a band in 10 seconds), why AI is essential (real-time hand tracking *is* the instrument; there is nothing to hold). Draft the write-up Saturday night; shoot the video Sunday morning when the build is stable.
- README (setup + architecture + the ML story), 6-slide deck: problem → demo → how the ML works → easy/hard → what's next.
- **Submit on Plume by 11:00** (track: Interactive Media; sponsor challenges: Long Lake, Ramp, Meta), freeze code, keep the replay recording as fallback.
- Demo script (5 min): judge presses Start → easy-mode drum flail grooves to the click → switch to guitar, flail over the chart and it sounds like the song → hard-mode drums show the pads responding to where and how hard they hit → teammate joins on the other instrument (the Meta moment) → (stretch) sing with echo. Default to easy mode with a 20 s song loop between judges.

### Suggested ownership (parallel from Stage 0)
- **Instrument tech (partner):** strum detector + roles, guitar voice + voicings, easy-mode strum resolution, multiplayer player model, on-site threshold tuning, recordings.
- **UI/render (you):** pickers + Start Band flow, HUD score, particles/confetti/kit art, guitar art + chart timeline, band UX, deploy + QR, README/video/write-up/slides, Plume.

### Timeline (two people; sleep in shifts 3–7am)
| When | Instrument tech | UI/render |
|---|---|---|
| now–8:00pm | 10 strum detector → 11 guitar voice + easy mode | 13 app chrome → 15 particles/kit art/score |
| 8:00pm–12:00am | 16 two players → 17 band UX | 12 guitar overlay + chart timeline → 14 deploy — **Plume project before midnight** |
| 12:00–3:00am | tuning, bug bash, recordings | 23 README/write-up draft, demo script |
| 3:00–7:00am | sleep shifts / stretch (19–22) | sleep shifts |
| 7:00–9:00am | 24 demo fallback recording, on-site config | **video**, slides, README final |
| 9:00–11:00am | rehearse, submit, freeze | rehearse, submit, freeze |

---

## Commit order (implement one commit at a time)

**Conventions.** `main` is always runnable, so every commit lands on `main` in a working state. One commit per row below, in Conventional Commits style (`feat: crossing detector core`). Every commit body says what it adds, how to test it (command + fixture), and which config keys it introduces. Each commit is sized for 30–90 minutes of work. The first commit bootstraps the app so later commits stay small.

**Claude implements, the team commits.** After finishing one commit's code, Claude **pauses** and hands over. The user reviews the diff, writes the commit message, and commits. Claude never runs `git commit` or `git push` unless explicitly asked in that moment.

**Lanes.** Commits 1–9 are on `main`. From here two lanes run in parallel: instrument tech (10 → 11 → 16 → 17, then 18–22 as stretch) and UI/render (13 → 15 → 12 → 14 → 23). The "Depends on" column is the commit order constraint: a row's dependencies must already be on `main` before its work starts. (Renumbered Sep 19 after dropping the classifier commits; old 17–28 are now 13–24.)

| # | Commit message | Stage | Scope | Depends on | Done when |
|---|---|---|---|---|---|
| 1 | `chore: scaffold Vite + React + TS app with stub modules` | 0 | Vite + React + TS app; deps (`@mediapipe/tasks-vision`, `tone`, `mitt`, `zod`, `vitest`); folder layout with stub modules; `core/types.ts` (all interfaces from this plan), `core/bus.ts`, `app/config.ts` with URL overrides; `.gitignore` incl. `.env`; README skeleton; one trivial vitest. | — | `npm run dev` shows a "Start Band" page; `npm test` passes. |
| 2 | `chore: vendor MediaPipe wasm, hand model, and audio samples` | 0 | `public/wasm/` (copied from node_modules), `public/models/hand_landmarker.task`, `public/samples/` (one Tone.js drum kit, acoustic guitar from tonejs-instruments, license notes). Assets only, no logic. | 1 | Files load from `/wasm`, `/models`, `/samples` in dev with WiFi off. |
| 3 | `feat: camera capture, hand landmarker, and skeleton overlay` | 0 | `vision/camera.ts` (640×480, device picker), `vision/handLandmarker.ts` (GPU, VIDEO, warm-up), `core/loop.ts` (video-frame-callback loop, rAF fallback), `render/overlay.ts` (mirrored video + raw skeleton), fps readout. | 2 | ≥25 fps with a skeleton on both hands. |
| 4 | `feat: frame adapter, tracker, and One-Euro/velocity filters` | 0 | `vision/frameAdapter.ts` (mirror once, h-units, palm/palmSize/palmVel, raw + One-Euro smooth, handedness majority vote + `SWAP_HANDEDNESS`), `vision/tracker.ts`, `vision/filters.ts` (OneEuro, VelocityBuffer with dt guards + glitch clamp). Tests: irregular-dt velocity, glitch clamp, track ids survive a hand crossing. | 3 | Track ids stay stable when hands cross; tests pass; handedness flag verified live. |
| 5 | `feat: vision recorder, replay, and debug panel` | 0 | `vision/recorder.ts` (record/replay `VisionFrame` JSON at original timing), `render/DebugPanel.tsx` (fps, inference ms, per-track state, config sliders, record/replay), keyboard event injector, first fixture in `public/recordings/`, a vitest helper that loads fixtures. | 4 | A recording replays and drives the overlay; a fixture loads in a test. |
| 6 | `feat: Tone.js audio engine, drums voice, and latency meter` | 0 | `audio/engine.ts` (Tone.start on click, `lookAhead 0.01`, latencyHint), `audio/voices/drumsVoice.ts` (one-shots), latency meter stamps (frame/detect/audio) shown in the debug panel; event injector keys play drums. | 2, 5 | Key press → drum sound with no perceptible lag; meter shows numbers. |
| 7 | `feat: crossing detector core with tests` | 1 | `detectors/detector.ts`, `detectors/crossingCore.ts` (segment-vs-line, ARMED/STRUCK, re-arm margin, refractory, direction cone, gap handling, anticipation option). Tests on synthetic segments: fast hit that jumps the line fires once; jitter at the line fires once; upstroke never fires. | 4 | Tests pass; no UI change. |
| 8 | `feat: drums instrument in hard mode with pad and stick FX` | 1 | `detectors/drumHitDetector.ts` (virtual stick tip, per-pad cores), `app/instruments.ts` + `app/controller.ts` (frame → detectors → bus → resolver → voice), `audio/modes.ts` with HardMode for drums, kit layout in config, pad + stick + flash FX in `render/fx.ts`. Fixture `drums_5hits.json`, `drums_upstrokes.json`. | 6, 7 | Live hits play drums; fixtures give 5 hits / 0 hits. |
| 9 | `feat: song clock, easy-mode drums, and click track` | 1 | `song/types.ts` (zod schema), `song/songs/` (2 charts), `audio/songClock.ts` (Transport, bar/beat/chord, beat-role), EasyMode drums (groove mapping + auto-kick), click track, spacebar kick, HUD beat pulse. Tests: chord lookup, beat-role table. | 8 | Flailing grooves to the click. **MVP milestone.** |
| 10 | `feat: strum detector and hand role assignment` | 2 | `detectors/strumDetector.ts` (`GuitarFrame`, Schmitt trigger on the centerline, refractory, velocity-onset fallback flag), `detectors/roles.ts` (strum/fret scoring, sticky, lefty toggle), debug draw of the band. Fixture `strum_alternating.json`. | 7 | Direction correct ≥90% on the fixture. |
| 11 | `feat: guitar voice and easy-mode strum resolution` | 2 | `song/chords.ts` (voicings), `audio/voices/guitarVoice.ts` (Sampler, stagger model, up-strum rules, per-string release, chuck sample), EasyMode.resolveStrum (chord from song clock; freeplay loop), guitar instrument registration, one-key guitar placement. | 9, 10 | Flailing over a chart sounds like a song. |
| 12 | `feat: guitar overlay, chord badge, and chart timeline` | 2 | Guitar art (body/neck/strings), string wiggle FX, chord badge (chart chord), chart timeline with now-cursor, "stand here" silhouette. Rendering only. **UI lane.** | 11 | Visual pass; no logic change. |
| 13 | `feat: app chrome with instrument, mode, and song pickers` | 4 | Instrument / mode / song pickers, Start Band flow, one-key reset, config persisted in the URL. Codes against `session.setInstrument(id)` (stubbed until 11 lands). **UI lane.** | 9 | A judge can pick an instrument and mode without the debug panel. |
| 14 | `chore: static deploy config and offline audit` | 4 | Static deploy config (Vercel/Netlify/Pages), base path, offline audit (no CDN references), README setup section, QR image for the table. **UI lane.** | 13 | HTTPS URL works from a phone-scanned QR. |
| 15 | `feat: particles, confetti, kit art, and HUD score` | 4 | Particles, confetti on 8 clean bars, kit art, HUD score (hits on the beat). Rendering only; may be split into several tiny commits. **UI lane.** | 9 | Visual pass. |
| 16 | `feat: two players with screen-half assignment` | 5 | `Player` model, screen-half assignment with dead zone, `numHands: 4`, two controllers, per-player pan and score. | 11, 13 | Two people, two instruments, ≥20 fps. |
| 17 | `feat: band UX with join toast, scores, and tightness meter` | 5 | Join toast, per-player score, band tightness meter. **UI lane** once 16 lands. | 16 | Meta demo video can be shot. |
| 18 | `feat: pose anchor for overlapping players` (optional) | 5 | `vision/poseTracker.ts`, hand→pose wrist matching, torso-anchored `GuitarFrame`. | 16 | Only if players must overlap. |
| 19 | `feat: singer mic input with echo and reverb` (stretch) | 6 | Wired-mic input with browser processing off, echo/reverb chain, lyric line. | 13 | Singing with echo through the app. |
| 20 | `feat: autotune-lite via pitchy and PitchShift` (stretch) | 6 | `pitchy` → nearest scale note → `PitchShift`. | 19 | |
| 21 | `feat: keyboard instrument with curl-based press detector` (stretch) | 6 | Curl-based press detector, key strip, easy-mode keys. | 9 | |
| 22 | `feat: rule-based guitar hard mode` (optional) | 6 | Extended-finger count on the fretting hand picks a chord from a fixed list; HardMode.resolveStrum; chord badge shows it. No training data. | 11 | Holding 1–4 fingers changes the chord live. |
| 23 | `docs: README, Meta write-up, demo script, and slides link` | 7 | README (architecture + the real-time ML pipeline story), Meta write-up, demo script, slides link. **UI lane.** | 17 | Ready to paste into Plume and the Meta form. |
| 24 | `chore: demo fallback recording and on-site config tuning` | 7 | Demo fallback recording, fixtures recorded from judges, on-site tuned config defaults. | 14 | Replay mode runs the whole demo with the camera covered. |

### Collaboration (two people, both committing to `main`)

**Ownership (one owner per file; the other person asks before editing):**
- *Instrument tech:* `src/detectors/`, `src/audio/`, `src/song/`, `src/vision/`, `src/app/instruments.ts`, `src/core/types.ts`, `scripts/`, `public/recordings/`, `test/` for those modules.
- *UI/render:* `src/app/App.tsx`, `src/app/styles.css`, `src/render/hud.ts`, `src/render/fx.ts`, `src/render/DebugPanel.tsx`, `index.html`, deploy config, `README.md`, `docs/`.
- *Shared (additive edits only):* `src/app/session.ts` (instrument owner adds instruments/clock; UI owner adds nothing, it only calls the Session API), `src/app/config.ts` (each adds keys in their own section: `strum`/`guitar`/`player` vs `play`/`ui`/`debug`).

**Rules:** commit small and often, straight to `main`; `git pull --rebase` before every push; `npm test` green before pushing; new tuning knobs go in the debug panel's `CONTROLS` list, not in App; new UI needs go through Session methods or bus events, never by importing a detector. Tell your Claude session which files are yours.

**Per-commit workflow when implementing (one commit per request):**
1. Claude starts from the current `main` and implements only that commit's scope.
2. Claude runs `npm test` and the commit's "done when" check (live or on a fixture) and fixes what fails.
3. **Claude stops here** and reports: files changed, what was verified and the test output, config keys added, how to test it by hand, and a *suggested* commit message and body.
4. The user reviews the diff, writes the commit message, and commits.
5. The user then asks Claude for the next commit; Claude starts it from the updated `main`.

If a commit grows past ~90 minutes, Claude splits it and pauses at the first natural boundary instead. Claude does not commit or push on its own.

---

## Sponsor prizes that fit (from SponsorChallenges.md)

Sponsor challenges are separate from the track; confirm on Plume how many you can submit to (usually several).

| Sponsor / challenge | Fit | What to add | Effort | Prize |
|---|---|---|---|---|
| **Long Lake — "Convince a Non-Believer"** (AI experience a skeptic would try, love, want again) | ★★★ This *is* the pitch. | Nothing. Frame the demo that way; have the public URL for judges to try. | 0 | Top 3 |
| **Meta — "Bringing People Closer Together with AI"** | ★★★ Multiplayer band = human connection; the AI is essential. Any stack allowed. | Stage 5 + video, public repo, write-up (Stage 7). Optional: Muse Voice Transcribe / Muse Spark ($50 credits). | video 1 h + write-up 20 min | Round-2 hackathon at Menlo Park, travel paid |
| **Ramp — "build anything that saves time and money"** | ★ Generic; spin = "a full band with no instruments or lessons". | Nothing. | 0 | Switch + Oura Ring + $100/member |
| Deepgram — "must call a Deepgram API" | ★★★ fit, **not chosen** | Push-to-talk voice commands. $200 credit, on-site audio help. | ~1 h | Nintendo Switch per member |
| OpenAI Challenge (API in product + Codex in process) | ★★, **not chosen** | Song name → chord chart JSON via the API; use Codex and name one concrete way it helped. | ~45 min | 1 yr ChatGPT Pro etc. |
| ASUS — "Build What's Next with ASUS" | ★ | Run the demo on a checked-out ASUS laptop/webcam; bonus for Zenni Claw (ASUS's Windows agentic-AI app). | 30 min if hardware available | Top 3 |
| Cognition — Best Use of Devin | ★ tool-based | Use Devin for a self-contained module and show it. | depends on access | $5K |
| ElevenLabs | ★ favors conversational agents | Eleven Music backing tracks / Voice Changer for the singer. | 1–2 h | ? |
| The Token Company | only with an LLM feature | — | — | $500 |
| Runpod — "to be announced" | ? | Ask at the booth; our inference is in-browser. | — | TBA |
| Arduino UNO Q | ✗ unless someone wants hardware (piezo pad / IMU stick over WebSerial) | | 3 h+ | Top 2 |
| Maximor, Voloridge, Visa, Warp, Espressif, Dimensional, Elastic, GiveCampus, SpaceXAI, Dropbox, Arrowstreet, Hackster, Regeneron | ✗ no fit | | | |

**Chosen set (team decision):** Long Lake + Ramp (free submissions) + **Meta** (multiplayer, video, public repo, write-up). Deepgram and OpenAI stay in the table as <1 h add-ons if the team is ahead; not planned work.

### Mapping to the HackMIT rubric
- Innovation 30%: air instruments with a real "easy mode" that makes non-musicians sound good.
- Technical complexity 30%: real-time in-browser ML pipeline (hand landmarks → identity tracking → crossing detectors), multi-person tracking, sub-100 ms motion-to-sound, fixture-driven detector tests.
- Impact 30%: anyone can play music together, no instrument, no lessons; social/party use; accessibility angle.
- Learning & collaboration 10%: say what each person learned (MediaPipe, Web Audio, ML feature design).

---

## Design decisions (1–4 decided by the team; 5–10 open with a default in bold)

1. ✅ **Web app.**
2. ✅ **React + Vite.**
3. ✅ MVP order: **drums → guitar easy → guitar hard.**
4. ✅ Sponsors: **Long Lake + Ramp (free) + Meta.** Deepgram/OpenAI optional add-ons only.
5. ✅ Classifier: **dropped** (Sep 19). Guitar is easy mode only; optional rule-based hard mode in commit 22.
6. Multiplayer assignment: **screen halves first**, Pose-based only if players must overlap.
7. Overlay: **Canvas 2D** vs Three.js.
8. Singer priority: **last**; wired earbuds mic first, phone mic via PeerJS second.
9. Chord set: **any chord with a voicing in `song/chords.ts`** (no classifier constraint any more).
10. Guitar anchoring: **fixed on screen with one-key placement** → torso-anchored via Pose in Stage 5.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Browser autoplay blocks audio | "Start Band" button calls `Tone.start()`; never auto-start. |
| Venue WiFi / CDN outage | Vendor model, WASM, samples, songs into `public/`; the app must run fully offline. |
| Low light / busy background at the expo | Desk lamp or white-screen fill light, Continuity Camera or a borrowed webcam, test in the hall Saturday evening; confidences 0.5→0.4; gap-tolerant crossing (hand above the line reappears below within 120 ms in the pad's x-range → hit with clamped velocity). |
| MediaPipe hand order changes between frames | Identity tracker in the frame adapter; all state keyed by `trackId`. |
| Handedness label swapped or flipping | `SWAP_HANDEDNESS` verified in Stage 0; majority vote over 15 frames; roles from geometry; "lefty" toggle. |
| First GPU inference stalls 1–3 s | Warm-up dummy frame before "ready". |
| Tone.js feels laggy | `lookAhead = 0.01`, `latencyHint: 'interactive'`, preloaded decoded buffers, optional 30–40 ms anticipation for drums. |
| Fast hits skip over pads / slow hits double-fire | Segment-vs-strike-line crossing + re-arm margin + refractory (crossing core). |
| Hands too far / background people | "Stand here" silhouette; ignore hands with `palmSize < 0.05 h`; prefer larger hands when `numHands` is saturated. |
| Multiplayer fps drop | 480p, GPU delegate, pose every 3rd frame, `numHands` 4 max. |
| Camera dies on stage | Replay mode with a saved recording drives the whole app. |
| Public repo leaks a key | `.env` + `.gitignore`; keys only in local/deploy env. |

---

## Verification (end-to-end)

- **Automated (Vitest):** velocity buffer with irregular `dt` and glitch clamp; crossing core on synthetic segments (fast hit that jumps over the line still fires; jitter at the line fires once); drum/strum fixtures (`drums_5hits.json` → 5 hits ±1 frame, `drums_upstrokes.json` → 0, `strum_alternating.json` → correct directions); song clock chord lookup and beat-role table; `Song` schema validation.
- **Stage checks:** the "done when" line in each stage, measured on recordings and live.
- **Live checklist before submission:** fresh clone → `npm i && npm run dev` works offline; Start → camera permission → ≥25 fps single player, ≥20 fps two players; easy-mode drums groove; easy-mode guitar follows the chart; hard-mode drums play the pad you hit; two players get separate instruments and scores; latency meter reads <100 ms motion-to-sound; deployed HTTPS URL works from a phone-scanned QR; replay fallback works with the camera covered; repo is public with no secrets; video and write-up attached to the Meta submission.
- **Demo rehearsal:** two full 5-minute run-throughs on the demo laptop in the judging zone.

---

## Appendix — starting values (all in h-units / h/s unless noted; tune on recordings, then on-site)

| Parameter | Start | Tune range / note |
|---|---|---|
| Capture | 640×480, ideal 60 fps | 720p buys nothing (224² internal resize) |
| MediaPipe confidences | 0.5 / 0.5 / 0.5 | 0.4 in bad light |
| Tracker max jump / dedupe / expiry | 0.25 h / 0.03 h / 300 ms | |
| Velocity dt guards / glitch clamp | skip <8 ms, gap >120 ms / 12 h/s | |
| One Euro (render stream only) | minCutoff 1.0 Hz, beta 3.0, dCutoff 1.0 | never smooth trigger inputs |
| Stick length | 1.5 × palmSize | 1.0–2.5 |
| Drum V_MIN / V_MAX | 1.0 / 4.0 | 0.7–1.6 (lower for timid judges, higher if lateral sweeps false-trigger) |
| Drum re-arm margin / refractory | 0.04 h / 80 ms per (track,pad) + 30 ms per pad | |
| Drum direction cone | cos ≥ 0.6 (~53° of vertical) | |
| Anticipation | 0 ms | try 30–40 ms on-site |
| Strum HYST / V_MIN / V_MAX | 0.02 h / 0.5 / 3.0 | V_MIN 0.3–1.0 |
| Strum refractory | 60 ms same dir, 40 ms opposite | |
| Strum stagger | Δ = clamp(15/v, 4, 20) ms, ±1.5 ms | up-strum strings 1–4 at 0.85× |
| Tone.js | lookAhead 0.01, latencyHint interactive | |
| Min hand size | palmSize ≥ 0.05 h | |
| Latency budget | camera ~20 + delivery ~8 + inference 15–25 + audio 10–15 ≈ 60–70 ms | worst ~120 ms in low light / weak iGPU |

Sources checked today: MediaPipe hand landmarker web guide (developers.google.com/edge/mediapipe), `@mediapipe/tasks-vision` on npm (0.10.35), nbrosowsky/tonejs-instruments README, Tone.js drum-sample host, Meta Muse Voice Transcribe developer page, Deepgram JS SDK docs, ASUS Zenni Claw press pages, Arduino UNO Q docs, ElevenLabs API changelog.
