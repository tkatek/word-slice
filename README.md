# Word Slice

An English-learning browser game inspired by fruit-slicing arcade mechanics. The player
reads an English instruction ("Slice the animal words."), watches fruits carrying words
fly upward, and slices only the words that match the instruction.

**This is the foundation phase**: reliable gameplay logic, a clean placeholder interface,
and automated engine tests. Final artwork, backgrounds, sound effects, and visual polish
are intentionally deferred.

## Run the game

Requires Node.js ≥ 18.11 (only for the dev server and tests — the game itself has zero
runtime dependencies).

```bash
npm start        # serves the project at http://localhost:3000
```

Then open <http://localhost:3000>. The question data is fetched over HTTP, so opening
`index.html` directly from disk will show the recoverable loading error (use Retry after
starting the server).

## Run the tests

```bash
npm test
```

Uses Node's built-in test runner (`node --test`); no test framework to install. The suite
covers data validation, scoring, waves, collision geometry, lifecycle (pause/restart/
duplicate commands/timing), and results/checkpoint rules — all DOM-free with deterministic
randomness and simulated time.

## Controls

- **Desktop**: hold the primary mouse button and drag across a fruit to slice it.
- **Mobile**: touch and swipe.
- Only moves count — a stationary pointer never slices.
- **Pause** button (or switching tabs) freezes the game; the whole scene turns
  black-and-white and blurs behind a single centered Play button. Switching back
  to the tab never auto-resumes.
- `touch-action: none` is applied only to the playfield, so page scrolling still works
  on menus, feedback, and results screens.

## Scoring and round-success rules

- Session: 10 randomly selected questions, 3 hearts, score 0, streak 0.
- Correct slice: +10 base points × multiplier. Streak 1–2 → ×1, 3–5 → ×2, 6+ → ×3.
  Streaks continue across questions.
- Wrong slice: −1 heart, streak/multiplier reset. Score is never subtracted.
- Missed correct fruit (falls off the board): streak reset, **no** heart lost.
- Untouched distractor: no penalty, streak preserved.
- A round is **successful** only when every correct word was sliced *and* no distractor
  was sliced.
- Lesson complete = all 10 rounds finished. Passing requires ≥ 8 successful rounds; a
  high score never compensates for wrong answers.
- Hearts reaching 0 ends the session early: it is an **incomplete session**, not a
  completed lesson. Remaining airborne options are marked *interrupted*, unlaunched
  options *not presented* — neither counts as a mistake or a miss.

## Question-data format

`data/questions.json` (schema version 1):

```json
{
  "schemaVersion": 1,
  "lessons": [{
    "id": "everyday-word-groups",
    "title": "Everyday Word Groups",
    "proposedCefrLevel": "A1",
    "questions": [{
      "id": "animals-01",
      "type": "category",
      "prompt": "Slice the animal words.",
      "options": [
        { "id": "cat", "text": "cat" },
        { "id": "dog", "text": "dog" },
        { "id": "chair", "text": "chair" },
        { "id": "book", "text": "book" }
      ],
      "correctOptionIds": ["cat", "dog"],
      "explanation": "Cat and dog are animal words. Chair and book are not."
    }]
  }]
}
```

The bank ships one lesson with 17 category-selection questions (2–3 correct answers
each). `validateQuestionBank()` in `js/engine.js` gates the Play button: schema version,
question types, unique IDs, non-empty content, correct-id references, at least one
distractor, no duplicate display text after normalization, and enough questions for a
session. Load failures (network, timeout, invalid JSON, invalid structure) show a
Retry button.

## Where gameplay tuning lives

Everything is in the `TUNING` object at the top of `js/engine.js`: simulation step and
frame clamps, session size, hearts, base points, pass threshold, desktop/mobile active
fruit limits, wave gap, spawn stagger, flight time, apex, radii, drift, and the
placeholder appearance list. UI-only timings (trail lifetime, animation cleanup) live at
the top of the corresponding sections in `js/game.js`.

## Architecture

- `js/engine.js` — the authoritative gameplay state: explicit state machine
  (IDLE → ROUND_READY → PLAYING → ROUND_FEEDBACK → … → RESULTS, plus PAUSED which
  remembers the interrupted state), question selection, wave scheduling, fruit motion,
  segment-to-circle collision with deterministic hit ordering, scoring, hearts, round
  checkpoints, and a bounded drainable event queue. Pure logic: no DOM, no timers, no
  storage; randomness is injected (`rng`/`seed`) and time advances only through
  `update(dt)` (fixed 1/60 s steps behind a bounded accumulator).
- `js/game.js` — browser layer: fetch/validate data, build the interface, pointer
  handling (single active pointer, coordinate conversion), one animation loop,
  rendering, feedback/results screens, pause/visibility, resize recovery, and guarded
  local progress storage. Never infers game state from the DOM.
- `js/audio.js` — central audio manager (see **Audio** below): one lazily created
  Web Audio context, a manifest mapping game events to sound files with per-event
  gain/cooldown/priority/bus, cached decoding, cooldowns, a voice cap with priority
  stealing, a master compressor, and versioned audio settings in localStorage.
  Missing files, unsupported Web Audio and storage failures degrade to silence —
  never to errors.
- `css/game.css` — responsive layouts, fruit sprites + upright calibrated
  word labels, two-piece cut-half animation styles, overlays, restrained
  feedback, reduced-motion support.
- `tests/engine.test.js` — 53 tests / 13 suites (see above).
  `tests/audio.test.js` — 23 tests / 3 suites (settings store, manifest integrity,
  manager behavior with an injected fake AudioContext).
- `serve.mjs` — minimal zero-dependency static dev server.

Notable behaviors:
- **Collision order**: one swipe segment can cut several fruits; hits are processed in
  order along the swipe direction and stop immediately when the final heart is lost.
- **Round completion**: a round ends only when every scheduled option reached a
  terminal outcome — never right after the last correct slice; decorative death
  animations are visual-only and cannot block completion.
- **Resize recovery**: a substantial resize/orientation flip (area change > 30 % or
  portrait/landscape flip) during a launched round pauses nothing silently — it restores
  the pre-launch score/hearts/streak/metrics from the round checkpoint, recalculates the
  playfield and wave size, shows a notice, and lets the player relaunch the same
  question. Small toolbar-height changes are ignored.
- **Occluded-webview watchdog**: `js/game.js` includes a small watchdog that drives the
  single loop body from a timer *only* if `requestAnimationFrame` callbacks stall for
  > 500 ms while the page is visible (some embedded webviews stop producing frames).
  Normal browsers never trigger it.
- **Local progress**: `word-slice:v1:progress` in localStorage stores best score per
  lesson and the last session summary; read/write failures never block play. No sync,
  no analytics, no personal data.

## Implemented features

### Level progression (2.0)

- 12 playable levels in 3 stages: Beginner (A1, levels 1–4), Elementary (A2,
  5–8), Intermediate (B1, 9–12). Stage CEFR labels are design targets, not
  certified assessment.
- Every level ships ≥ 15 questions; a regular session selects 10 without
  repetition (180 questions total in `data/levels/stage-{1,2,3}.json`).
- Four validated question types: `category`, `grammar-identify`,
  `sentence-completion`, `word-meaning`. Correctness is always explicit via
  `correctOptionIds` — never inferred from word strings or fruit art.
- Per-level difficulty profiles (`DIFFICULTY` in `js/levels.js`) scale flight
  time, wave gap and spawn stagger modestly (1.30× slower at level 1 down to
  0.92× at level 12). Fruit size never shrinks with level; mobile keeps its
  2-fruit waves at every difficulty.
- Stars come from successful rounds only: 10 → 3★, 9 → 2★, 8 → 1★, fewer or
  an unfinished session → 0. Passing a level unlocks the next; unlocked
  levels never re-lock. Results offer Next level / Play again / Level map.
- Progress v2 (`word-slice:v2:progress`) stores per-level best stars/score,
  plays, last session, achievements and tutorial completion. The legacy v1
  key is preserved untouched; nothing is carried over dishonestly.
- Five real achievements (first pass, first 3★, 5-in-a-row, five levels,
  beginner stage) with toasts and a Settings list.
- Interactive tutorial overlay (skippable, real fruit sprites, one practice
  swipe): built and wired internally, but currently **not reachable from
  the UI** — the approved flow starts straight into gameplay (see
  "Intentionally deferred").

### Gameplay

- Loading → menu → level select → question-ready → gameplay → round
  feedback → results, all without page reloads.
- Desktop: up to 4 active answer fruits per wave. Mobile (coarse pointer or
  < 640 px): 2 per wave; every option still appears exactly once per round.
- Mouse and touch slicing via Pointer Events with pointer capture; canvas
  swipe trail and juice FX layers.
- Score, streak/multiplier, hearts, question progress, and wave numbering in
  the HUD. Pause overlay (blurred backdrop), tab-hidden auto-pause, safe
  resume, resize recovery.
- Answer fruits use the 10 round-bodied fruits of the current sprite pack
  (watermelon, apple, orange, tomato, peach, melon, pomegranate, lemon,
  plum, coconut). Each 256×256 sprite carries transparent padding, so the
  render box scales from the engine's collision radius divided by the
  body's canvas fraction (`bodyFrac`, calibrated from
  `assets/fruits/manifest.json` content bounds) — every visible fruit body
  spans the same pixel size. Word labels anchor to a per-fruit calibrated
  point nudged below stems/leaves, stay upright via counter-rotation and
  auto-shrink for long words (validated to ≤ 12 characters in the data
  pack).
- Slicing FX — real two-piece split: when the engine confirms a hit, the
  whole sprite (word included) disappears and TWO independent DOM pieces
  take over from the same position/rotation — the fruit's own
  `<fruit>_left.png` and `<fruit>_right.png` cut halves. Each piece carries
  its own velocity (the fruit's last motion + a separation impulse along
  the swipe's perpendicular, damped toward the artwork's vertical cut
  plane), independent spin (left CCW, right CW), shared time-based gravity
  and a bounded lifetime with an end fade — all integrated inside the
  single rAF loop (`stepCutPieces`), frozen while paused, hard-capped at 24
  live halves. A per-fruit-colored juice splash (canvas layer,
  `js/juice.js`) and a points popup complete the feedback.
- Compact question-ready parchment panel (the scenery stays visible behind
  it), compact in-game control bar with only working buttons (Help, Settings
  — no fake locked power-ups in the gameplay HUD).

### Presentation

- Wooden signboard logo ("Word" gold / "Slice" blue, ropes and leaves) on
  every screen. Arcade first page with nav (Home / Levels / How to Play /
  Settings), hero headline, Play/Continue · Levels · How to play buttons and
  a real progress summary.
- Level select styled as a progression map: three stage banners, 12
  parchment level cards with number badge, topic, stars, best score, lock
  state and a "Next" marker on the continue target.
- Game HUD: logo top-left, navy round-progress bar with green fill and
  level subtitle top-center, points/timer/hearts chips and circular pause
  top-right, wooden Score/Combo/Best panels on the desktop left edge,
  hanging parchment question banner (ropes + leaves + helper line).
- Scenic responsive backgrounds: `assets/backgrounds/desktop.webp` /
  `mobile.webp` behind a fixed background layer; orientation picks the
  artwork and only that file is preloaded.
- App-level overlays (How to play, Settings) pause live gameplay while
  open. Results show earned stars plus mistake review grouped by question.
- The HUD timer shows the session's elapsed play time (engine simulation
  seconds — it only advances while the round is actually running).
- `tools/prep-fruits.mjs` is the historical pipeline for the retired
  first-generation sprite set (it reads machine-local downloads that no
  longer exist). The current fruit pack under `assets/fruits/` ships
  game-ready 256×256 RGBA PNGs (10 whole fruits in `uncuted/`, 20 cut
  halves in `cuted/`, plus `manifest.json` with pixel-exact content bounds
  used to calibrate rendering); `tools/build-fruit-sprites.mjs` can
  re-normalize that pack, and `tools/convert-images-to-webp.html` re-encodes
  it if a WebP variant is ever wanted (the PNGs are used directly — ~1.4 MB
  total, decoded once at startup).

## Audio

All 29 sound effects are **original, procedurally synthesized** by
`tools/make-audio.mjs` (deterministic, seeded — re-running it produces identical
files). No third-party samples are used, so there are no attribution
requirements. Format: 16-bit mono PCM **WAV at 22.05 kHz** (~650 KB total) —
this environment has no OGG encoder, so the manifest honestly references
`.wav`; nothing is mislabeled.

Regenerate/validate the assets:

```bash
node tools/make-audio.mjs          # render + validate all files
node tools/make-audio.mjs --check  # validate existing files only
```

Layout under `assets/audio/`: `slicing/` (3 blade whooshes + 3 juicy fruit
cuts), `feedback/` (correct, incorrect, heart-lost, fruit-missed, combo-2/3/
high), `progression/` (countdown tick, round intro/start/success/failed, level
win/failed/unlocked, star-earned, three-stars, achievement) and `ui/`
(button click/hover, menu-open, pause, resume).

### How it plays

`js/audio.js` owns every sound (one `audioManager` singleton; the browser layer
never creates `Audio` elements or audio nodes). Sounds are mapped in the
`AUDIO_MANIFEST` — per event: file pool, mix gain, cooldown, priority, bus
(`gameplay` vs `ui`), and pitch-variation range. Files are fetched once,
decoded once, cached, and reused; each play picks a variation and a small
bounded pitch offset so repeated slices never sound identical.

Event wiring (all driven by **real engine events** — never by fruit art or
DOM guesswork):

| Event | Sound(s) |
| --- | --- |
| Meaningful swipe begins (first qualifying move per gesture + cooldown) | `bladeWhoosh` |
| Any successful fruit collision (`correctSlice`/`wrongSlice`) | `fruitCut` |
| Correct answer | `correct` (+ combo cues by real streak: 2 → `combo2`, 3–4 → `combo3`, every 5th → `comboHigh`) |
| Wrong answer | `incorrect` + quieter `heartLost` |
| A correct target falls un-sliced | soft `fruitMissed` (avoided distractors stay **silent**) |
| Question card appears / each countdown second / fruits launch | `roundIntro` / `countdownTick` / `roundStart` |
| Round feedback card | `roundSuccess` or `roundFailed` (from `report.successful`) |
| Results | sequenced celebration: `levelWin`/`levelFailed` → stars (`starEarned`/`threeStars`) → `levelUnlocked` (only when genuinely newly unlocked) → `achievement` per new achievement — spaced, never stacked |
| Buttons (all, incl. live-built level cards; keyboard too) | `buttonClick` |
| Pointer hover on buttons (precise pointers only, rate-limited) | `buttonHover` |
| Overlays open / pause / resume | `menuOpen` / `pause` / `resume` |

### Autoplay policy, pause and performance

- The `AudioContext` is created/resumed **only from real user gestures**
  (capture-phase `pointerdown`/`keydown`; the listeners detach once running).
  Before that the game plays silently — no rejected-promise spam. Essential
  files are *fetched* at load but only *decoded* after unlock.
- Pausing (button, tab hidden, overlay) suspends the **gameplay bus**: no
  slice/combo/countdown sounds fire while paused, pending sequenced items are
  cancelled, nothing replays on resume. UI sounds stay audible on pause
  screens. Short in-flight effects finish naturally.
- Mixing safety: per-event cooldowns, a 14-voice cap with priority-based
  stealing (a quiet hover is dropped before a slice is), and a master
  `DynamicsCompressor` so stacked rapid slices cannot clip. Ended voices
  disconnect their nodes.

### Settings

Settings → **Sound effects On/Off** and **Effects volume 0–100 %**, persisted
in a dedicated versioned record (`word-slice:v1:audio`) separate from progress
and achievements (`word-slice:v2:progress`) — audio changes never touch level
data. Mute applies instantly. Defaults: on, 80 %. Background music is
intentionally not shipped (no suitable original track); no fake music
controls exist.

`window.wordSliceAudio` exposes the manager (stats/mute/volume) for
debugging and automated verification.

`window.__wordSlice` exposes a second read-only verification handle
(`engine`, `intro`, `appState()`, `currentLevel()`, `progress()`,
`refreshView`, `applyLayout`, `stepIntro`, `renderFrame`,
`processEngineEvents`). It lets automated tests inspect the live engine
and drive presentation steps in environments where rAF/timers are
throttled; the game never mutates it.

## Intentionally deferred

- Background music (no suitable original track; no fake music controls) and
  further art polish of the generated backgrounds/sprites.
- Power-ups (removed from the gameplay HUD rather than faked), coins, and
  any meta-game systems. If assisted-answer power-ups arrive later, they
  must not count toward learning mastery.
- An untimed practice mode and broader accessibility work for timed slicing.
- B2/C1 level content — the architecture (manifest + stage files + type
  validation) supports adding stages without engine changes, but no large
  unreviewed advanced bank is shipped.
- The interactive tutorial overlay (markup + logic, `openTutorial()` in
  `js/game.js`) currently has **no entry point**: the approved flow starts
  straight into gameplay, and first-time help is served by the How to play
  overlay from the menu navigation. Wiring it to the first-ever play is a
  content decision, not a code gap.

## Draft-content review requirement

The lesson content is **draft teaching material** and has not been reviewed or approved
by a teacher. It must be reviewed before being used with real learners.

## Known limitations

- The rAF watchdog (see above) exists only for embedded/occluded webviews; on such
  views the game also runs slower because browser timers are throttled.
- Real-device (phone) behavior — touch latency, safe-area insets, mobile browser
  toolbar changes — has not been verified on hardware. All mobile checks so far
  are browser-emulated (see **Verification** below).
- Timed slicing is inherently difficult for some players; no accessibility claim is
  made for the timed mode.

## Verification (2026-10 audit)

Automated: 112 tests / 16 suites pass (`npm test`), covering engine state
transitions, scoring/hearts, collision geometry, waves, pause/resume,
intro scheduling, level unlocking, stars, achievements, progress
persistence, question-data validation and the audio manager.

Browser-emulated (ZCode in-app Chromium, driven via real DOM clicks and
PointerEvents): zero horizontal overflow at 320/360/375/390/414/430/768/
1024/1366/1920 px plus phone-landscape sizes, across loading, intro,
gameplay, feedback, results, level map, menu, settings, how-to and the
mistake-review overlay; page-scroll only on intentionally scrollable
screens; pause freezes the countdown and airborne fruits; orientation
flip mid-round recovers to the same question; a completed 10-round
perfect session (3★, unlock, Next level), an early-heart-loss session
and a completed-but-failed session (mistake previews + full review
overlay) were each driven end-to-end. Measured JS frame cost at
1920×1080 with a full board: ~0.1 ms average / 0.2 ms p95 per frame
(60 fps budget = 16.7 ms); DOM effect nodes are bounded and pruned.

Fixed during the audit: the compact question banner hid its
"Wave N of M" line whenever a long prompt wrapped to 3+ lines (the fit
measured the wave line after the over-full flex column had already
crushed it to zero height — now measured by content with a
no-flex-shrink guard), and Settings → Reset best score previously wiped
the whole level record (re-locking earned levels); it now calls
`resetLevelBestScore()`, which clears only the best score.

Not verifiable in this environment and still outstanding: audible audio
quality on real speakers (covered by unit tests only) and real-device
touch behavior.
