#!/usr/bin/env bash
# Re-vendors every runtime asset into public/ so the app runs fully offline
# (venue WiFi and CDNs are not on the critical path at demo time).
#
# Usage: npm install && ./scripts/vendor-assets.sh
# Safe to re-run; it overwrites the files in place.
#
# What it fetches and from where (see public/samples/LICENSES.md for licenses):
#   public/wasm/                    @mediapipe/tasks-vision from node_modules (pinned in package.json)
#   public/models/hand_landmarker.task  Google's hosted MediaPipe model, versioned path (float16/1)
#   public/samples/drums/           Tone.js "acoustic-kit" one-shots + a Berklee crash cymbal
#   public/samples/guitar-acoustic/ nbrosowsky/tonejs-instruments acoustic guitar (Univ. of Iowa recordings)
set -euo pipefail
cd "$(dirname "$0")/.."

MP=node_modules/@mediapipe/tasks-vision
if [ ! -d "$MP/wasm" ]; then
  echo "error: $MP/wasm not found; run npm install first" >&2
  exit 1
fi

CURL="curl -fsSL --retry 3 --retry-delay 2"

mkdir -p public/wasm public/models public/samples/drums public/samples/guitar-acoustic

# 1. MediaPipe WASM. FilesetResolver.forVisionTasks(basePath) loads
#    `${basePath}/vision_wasm_internal.*` (SIMD) or `vision_wasm_nosimd_internal.*`.
#    The `vision_wasm_module_internal.*` files are only used when forVisionTasks is
#    called with useModule=true, which this app does not do, so they are skipped.
for f in vision_wasm_internal.js vision_wasm_internal.wasm \
         vision_wasm_nosimd_internal.js vision_wasm_nosimd_internal.wasm; do
  cp "$MP/wasm/$f" public/wasm/
done
echo "mediapipe tasks-vision $(node -p "require('./$MP/package.json').version")"

# 2. Hand landmarker model (float16, model version 1).
$CURL -o public/models/hand_landmarker.task \
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"

# 3. Drum kit: Tone.js acoustic-kit (kick, snare, hihat, tom1..3) + Berklee crash cymbal.
TONE_AUDIO="https://tonejs.github.io/audio"
for f in kick snare hihat tom1 tom2 tom3; do
  $CURL -o "public/samples/drums/$f.mp3" "$TONE_AUDIO/drum-samples/acoustic-kit/$f.mp3"
done
$CURL -o public/samples/drums/crash.mp3 "$TONE_AUDIO/berklee/crash_cymbal1.mp3"

# 4. Acoustic guitar, all 37 samples (D2..C5; sharps are spelled "s", e.g. Fs3 = F#3).
GUITAR="https://raw.githubusercontent.com/nbrosowsky/tonejs-instruments/master/samples/guitar-acoustic"
for n in A2 A3 A4 As2 As3 As4 B2 B3 B4 C3 C4 C5 Cs3 Cs4 Cs5 D2 D3 D4 D5 Ds2 Ds3 Ds4 \
         E2 E3 E4 F2 F3 F4 Fs2 Fs3 Fs4 G2 G3 G4 Gs2 Gs3 Gs4; do
  $CURL -o "public/samples/guitar-acoustic/$n.mp3" "$GUITAR/$n.mp3"
done

echo "--- vendored ---"
du -sh public/wasm public/models public/samples/drums public/samples/guitar-acoustic
shasum -a 256 public/models/hand_landmarker.task
