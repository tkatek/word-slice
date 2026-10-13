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

1. `node tools/prep-fruits.mjs` — regenerates the PNG sprites from the
   original AI-generated downloads (machine-specific paths are listed in
   the script header; originals are never modified).
2. Serve the project (`npm start`) and open
   `http://localhost:3000/tools/convert-images-to-webp.html` — downloads the
   WebP versions produced with the same dimensions and quality settings.
3. Replace the `.webp` files under `assets/fruits/sprites/` and
   `assets/ui/question-card.webp`, then delete the superseded `.png` files.

`tools/build-fruit-sprites.mjs` predates `prep-fruits.mjs` and expects source
packs under `assets/fruits/uncuted` + `assets/fruits/cuted`, which no longer
exist; it is kept only as historical reference.
