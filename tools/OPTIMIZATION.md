# Asset optimization notes

Runtime images are WebP; the browser already required WebP support because
the scenic backgrounds (`assets/backgrounds/*.webp`) have always used it.

## What was optimized

| Asset group | Before | After | Method |
| --- | --- | --- | --- |
| `assets/fruits/sprites/uncuted/*.png` (10 files) | ≈ 3.7 MB | ≈ 365 kB | WebP q0.90, downscaled to ≤ 384 px long edge |
| `assets/fruits/sprites/cuted/*.png` (10 files) | ≈ 3.9 MB | ≈ 371 kB | WebP q0.90, downscaled to ≤ 384 px long edge |
| `assets/ui/question-card.png` | 2.18 MB | 101 kB | WebP q0.85, original 1672×941 kept |
| `assets/ui/question-card-reference.png` | 2.08 MB | deleted | unreferenced development artifact |

Fruits render at ≤ 62 px collision radius (≈ 146 CSS px box, ≈ 292 px at 2×
DPR), so 384 px sprites still oversample every supported display. The
question-card artwork keeps its full resolution because the intro card can
scale up to ~1.3× of its ~780 px layout width.

Total initial page weight dropped from ≈ 9.6 MB to ≈ 2.3 MB (includes the
~600 kB WebP backgrounds and ~750 kB of WAV audio fetched after the first
user gesture).

## Regenerating the pipeline

The current fruit pack (October 2026) replaced the first-generation set: 30
game-ready 256×256 RGBA PNGs under `assets/fruits/uncuted/` + `cuted/` are
served directly (~1.4 MB, decoded once at startup via `img.decode()`), so
the old prep/webp chain is no longer required for fruits.

1. If a WebP variant is wanted, serve the project (`npm start`) and open
   `http://localhost:3000/tools/convert-images-to-webp.html` — it encodes
   the current pack (and the question card) with the browser's canvas
   encoder.
2. Replace the `.png` files under `assets/fruits/` and
   `assets/ui/question-card.webp`, then update the paths in
   `js/game.js` (`FRUIT_ASSETS`) to match.

`tools/prep-fruits.mjs` mapped the retired first-generation set from
machine-local downloads that no longer exist; it is kept only as historical
reference. `tools/build-fruit-sprites.mjs` reads the current pack layout
(`assets/fruits/uncuted` + `cuted`) and can re-normalize it if a future
source pack ever needs chroma-keying or trimming.

