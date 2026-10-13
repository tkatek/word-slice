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
- **Pause** button (or switching tabs) freezes the game; resume deliberately via the
  Resume button. Switching back to the tab never auto-resumes.
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
- `css/game.css` — responsive layouts, placeholder fruits (CSS shapes + real text
  labels), overlays, restrained feedback, reduced-motion support.
- `tests/engine.test.js` — 53 tests / 13 suites (see above).
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
- First-time interactive tutorial (skippable): read the question → practice
  swipe on a real fruit (cut artwork feedback) → leave distractors → play.

### Gameplay

- Loading → menu → level select → question-ready → gameplay → round
  feedback → results, all without page reloads.
- Desktop: up to 4 active answer fruits per wave. Mobile (coarse pointer or
  < 640 px): 2 per wave; every option still appears exactly once per round.
- Mouse and touch slicing via Pointer Events with pointer capture; SVG swipe
  trail with glow.
- Score, streak/multiplier, hearts, question progress, and wave numbering in
  the HUD. Pause overlay (blurred backdrop), tab-hidden auto-pause, safe
  resume, resize recovery.
- Answer fruits use only body shapes that can carry a readable word
  (watermelon, apple, orange, blueberry, strawberry, kiwi). Sprites are
  body-trimmed and scaled from the engine's collision radius; labels stay
  upright via counter-rotation and auto-shrink for long words (validated to
  ≤ 12 characters in the data pack). Narrow shapes (banana, pear, pineapple,
  lemon) are excluded from the answer pool and remain decoration art.
- Slicing FX: the whole sprite is replaced by two clipped copies of the cut
  artwork that fly apart along the swipe direction, plus a per-fruit-colored
  juice burst (9 droplets biased along the blade) and a points popup.
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
- `tools/prep-fruits.mjs` regenerates the sprite set from the raw generated
  PNGs (trims margins, clamps near-opaque alpha, downsamples to ≤ 480 px).

## Intentionally deferred

- Sound effects (the Settings toggle is visibly disabled and labeled as
  such) and further art polish of the generated backgrounds/sprites.
- Power-ups (removed from the gameplay HUD rather than faked), coins, and
  any meta-game systems. If assisted-answer power-ups arrive later, they
  must not count toward learning mastery.
- An untimed practice mode and broader accessibility work for timed slicing.
- B2/C1 level content — the architecture (manifest + stage files + type
  validation) supports adding stages without engine changes, but no large
  unreviewed advanced bank is shipped.

## Draft-content review requirement

The lesson content is **draft teaching material** and has not been reviewed or approved
by a teacher. It must be reviewed before being used with real learners.

## Known limitations

- The rAF watchdog (see above) exists only for embedded/occluded webviews; on such
  views the game also runs slower because browser timers are throttled.
- Real-device (phone) behavior — touch latency, safe-area insets, mobile browser
  toolbar changes — has not been verified on hardware.
- Timed slicing is inherently difficult for some players; no accessibility claim is
  made for the timed mode.

## Remaining manual browser/device checks

- Full 10-round lesson completion on a normal desktop browser at 60 fps.
- Real touch swipes on a phone (iOS Safari + Android Chrome), including orientation
  change mid-round.
- Keyboard-only navigation of menus/overlays (buttons are real buttons with focus
  states, but a full keyboard pass has not been done).
- Performance check with final artwork once assets exist.
