/**
 * Word Slice — browser layer.
 *
 * Connects the pure engine (js/engine.js) to the DOM through the level
 * system (js/levels.js) and progress store (js/progress.js): loads and
 * validates the level data pack, renders the menu / level select / game
 * screens, draws engine state with PNG fruit sprites and slicing FX,
 * converts pointer input into slice segments, runs the single animation
 * loop, and handles pause/visibility/resize recovery plus local progress
 * persistence. The engine remains the only source of gameplay truth.
 */
import {
  WordSliceEngine,
  validateQuestionBank,
  TUNING,
  ENGINE_STATES,
} from './engine.js';
import {
  LEVELS,
  STAGES,
  levelsByStage,
  levelById,
  stageById,
  nextLevel,
  tuningOverridesFor,
  starsFor,
  validateLevelsPack,
} from './levels.js';
import {
  ACHIEVEMENTS,
  STORAGE_KEY,
  readProgress,
  writeProgress,
  isLevelUnlocked,
  continueTarget,
  totalStars,
  passedLevelCount,
  recordLevelResult,
} from './progress.js';

/* ------------------------------------------------------------------ */
/* DOM references                                                      */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const screens = {
  loading: $('screen-loading'),
  error: $('screen-error'),
  menu: $('screen-menu'),
  levels: $('screen-levels'),
  game: $('screen-game'),
  feedback: $('screen-feedback'),
  results: $('screen-results'),
};

const els = {
  errorText: $('error-text'),
  btnRetry: $('btn-retry'),
  menuBest: $('menu-best'),
  btnPlay: $('btn-play'),
  btnPlayLabel: $('btn-play-label'),
  btnMenuHome: $('btn-menu-home'),
  btnMenuLevels: $('btn-menu-levels'),
  btnMenuHow: $('btn-menu-how'),
  btnMenuSettings: $('btn-menu-settings'),
  btnHeroLevels: $('btn-hero-levels'),
  btnHeroHow: $('btn-hero-how'),
  btnLevelsHome: $('btn-levels-home'),
  btnLevelsLevels: $('btn-levels-levels'),
  btnLevelsHow: $('btn-levels-how'),
  btnLevelsSettings: $('btn-levels-settings'),
  levelsProgress: $('levels-progress'),
  levelsList: $('levels-list'),
  menuHowOverlay: $('menu-how-overlay'),
  btnMenuHowClose: $('btn-menu-how-close'),
  settingsOverlay: $('settings-overlay'),
  btnSettingsClose: $('btn-settings-close'),
  btnSettingsHow: $('btn-settings-how'),
  btnResetBest: $('btn-reset-best'),
  achievementsList: $('achievements-list'),
  tutorialOverlay: $('tutorial-overlay'),
  tutorialSteps: $('tutorial-steps'),
  btnTutorialSkip: $('btn-tutorial-skip'),
  btnTutorialNext: $('btn-tutorial-next'),
  gameToast: $('game-toast'),
  hudQuestion: $('hud-question'),
  hudProgressFill: $('hud-progress-fill'),
  hudLessonSub: $('hud-lesson-sub'),
  hudScoreValue: $('hud-score-value'),
  hudHearts: $('hud-hearts'),
  hudTimerValue: $('hud-timer-value'),
  panelScore: $('panel-score'),
  panelStreak: $('panel-streak'),
  panelBest: $('panel-best'),
  btnPause: $('btn-pause'),
  questionPrompt: $('question-prompt'),
  questionWave: $('question-wave'),
  playfield: $('playfield'),
  fruitsLayer: $('fruits-layer'),
  trailSvg: $('trail'),
  trailLine: $('trail-line'),
  trailGlow: $('trail-glow'),
  readyOverlay: $('ready-overlay'),
  readyProgress: $('ready-progress'),
  readyPrompt: $('ready-prompt'),
  readyWaves: $('ready-waves'),
  btnLaunch: $('btn-launch'),
  resizeNotice: $('resize-notice'),
  pauseOverlay: $('pause-overlay'),
  btnResume: $('btn-resume'),
  btnRestart: $('btn-restart'),
  btnQuit: $('btn-quit'),
  pwHelp: $('pw-help'),
  pwSettings: $('pw-settings'),
  fbProgress: $('fb-progress'),
  fbTitle: $('fb-title'),
  fbPrompt: $('fb-prompt'),
  fbCorrect: $('fb-correct'),
  fbWrong: $('fb-wrong'),
  fbMissed: $('fb-missed'),
  fbExplanation: $('fb-explanation'),
  btnContinue: $('btn-continue'),
  rsTitle: $('rs-title'),
  rsStars: $('rs-stars'),
  rsSubtitle: $('rs-subtitle'),
  rsStats: $('rs-stats'),
  rsReview: $('rs-review'),
  btnNextLevel: $('btn-next-level'),
  btnAgain: $('btn-again'),
  btnMenu: $('btn-menu'),
};

/* ------------------------------------------------------------------ */
/* Fruit sprites: whole + cut PNGs with per-fruit juice color          */
/* ------------------------------------------------------------------ */

const FRUIT_APPEARANCES = {
  watermelon: { whole: 'assets/fruits/sprites/uncuted/watermelon.png', cut: 'assets/fruits/sprites/cuted/watermelon.png', juice: '#e5484d', scale: 1.04 },
  pineapple: { whole: 'assets/fruits/sprites/uncuted/pineapple.png', cut: 'assets/fruits/sprites/cuted/pineapple.png', juice: '#ffcf3d', scale: 1.08 },
  apple: { whole: 'assets/fruits/sprites/uncuted/apple.png', cut: 'assets/fruits/sprites/cuted/apple.png', juice: '#f2e8c9', scale: 1.04 },
  orange: { whole: 'assets/fruits/sprites/uncuted/orange.png', cut: 'assets/fruits/sprites/cuted/orange.png', juice: '#ffa53d', scale: 1.04 },
  strawberry: { whole: 'assets/fruits/sprites/uncuted/strawberry.png', cut: 'assets/fruits/sprites/cuted/strawberry.png', juice: '#e63950', scale: 1.06 },
  blueberry: { whole: 'assets/fruits/sprites/uncuted/blueberry.png', cut: 'assets/fruits/sprites/cuted/blueberry.png', juice: '#5a8dee', scale: 1.04 },
  banana: { whole: 'assets/fruits/sprites/uncuted/banana.png', cut: 'assets/fruits/sprites/cuted/banana.png', juice: '#ffe97a', scale: 1.18 },
  pear: { whole: 'assets/fruits/sprites/uncuted/pear.png', cut: 'assets/fruits/sprites/cuted/pear.png', juice: '#d9e8a6', scale: 1.06 },
  lemon: { whole: 'assets/fruits/sprites/uncuted/lemon.png', cut: 'assets/fruits/sprites/cuted/lemon.png', juice: '#ffd94d', scale: 1.04 },
  kiwi: { whole: 'assets/fruits/sprites/uncuted/kiwi.png', cut: 'assets/fruits/sprites/cuted/kiwi.png', juice: '#9bcf3f', scale: 1.04 },
};

/** appearanceId -> { whole: Image, cut: Image } (only successfully loaded). */
const appearanceImages = new Map();

function preloadAppearanceImages() {
  // Only the engine's answer pool needs decode-warm sprites; the rest of
  // the map stays available for menu/tutorial decoration art.
  for (const id of TUNING.APPEARANCES) {
    const files = FRUIT_APPEARANCES[id];
    if (!files) continue;
    const entry = {};
    for (const kind of ['whole', 'cut']) {
      const img = new Image();
      img.decoding = 'async';
      entry[kind] = img;
      img.src = files[kind];
      // Warm decode so the first slice of each fruit never stutters.
      if (typeof img.decode === 'function') img.decode().catch(() => {});
    }
    appearanceImages.set(id, entry);
  }
}

/* ------------------------------------------------------------------ */
/* Application state                                                   */
/* ------------------------------------------------------------------ */

/** LOADING → MENU ⇄ LEVELS ⇄ GAME (with ERROR recoverable from loading). */
let appState = 'LOADING';
let levelQuestions = null; // levelId -> questions array (validated pack)
let currentLevel = null;   // manifest entry of the level being played
let engine = null;
/** Live v2 progress cache; the single source for unlock/star UI. */
let progress = null;
/** Best stored score for the current level (side panel). */
let sessionBestScore = 0;
/** Set when an app-level overlay (how-to / settings) paused the engine. */
let overlayPausedByUs = false;

function setScreen(name) {
  for (const [key, section] of Object.entries(screens)) {
    section.hidden = key !== name;
  }
  appState = ['game', 'feedback', 'results'].includes(name) ? 'GAME' : name.toUpperCase();
}

/* ------------------------------------------------------------------ */
/* Toast + app-level overlays                                          */
/* ------------------------------------------------------------------ */

let toastTimerId = null;
let toastQueue = [];

function showToast(text) {
  els.gameToast.textContent = text;
  els.gameToast.hidden = false;
  if (toastTimerId !== null) clearTimeout(toastTimerId);
  toastTimerId = setTimeout(() => {
    els.gameToast.hidden = true;
    toastTimerId = null;
    playNextQueuedToast();
  }, 2400);
}

/** Achievement toasts arrive in a burst; show them one after another. */
function queueAchievementToasts(list) {
  toastQueue.push(...list.map((a) => `🏆 Achievement: ${a.name}`));
  if (toastTimerId === null && els.gameToast.hidden) playNextQueuedToast();
}

function playNextQueuedToast() {
  const next = toastQueue.shift();
  if (next) showToast(next);
}

/** App overlays pause live gameplay while they are open. */
function openAppOverlay(overlayEl) {
  overlayEl.hidden = false;
  // Keep an existing overlay-owned pause (settings → how-to stacking).
  if (!overlayPausedByUs && engine && (engine.state === ENGINE_STATES.PLAYING || engine.state === ENGINE_STATES.ROUND_READY)) {
    overlayPausedByUs = engine.pause('overlay');
  }
  clearGesture();
  clearTransientFx();
  refreshView();
}

function closeAppOverlay(overlayEl) {
  overlayEl.hidden = true;
  if (overlayPausedByUs && engine && engine.state === ENGINE_STATES.PAUSED) {
    engine.resume();
  }
  overlayPausedByUs = false;
  processEngineEvents();
  refreshView();
}

/* ------------------------------------------------------------------ */
/* Level data loading                                                  */
/* ------------------------------------------------------------------ */

let loadAttempt = 0;

async function loadLevelPack() {
  const attempt = ++loadAttempt;
  setScreen('loading');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const files = ['stage-1.json', 'stage-2.json', 'stage-3.json'];
    const responses = await Promise.all(files.map((f) =>
      fetch(`data/levels/${f}`, { signal: controller.signal, cache: 'no-store' })));
    if (attempt !== loadAttempt) return; // superseded by a newer retry
    for (const response of responses) {
      if (!response.ok) throw new Error(`server returned ${response.status} for a level file`);
    }
    const pack = { schemaVersion: 2, stages: [] };
    for (const response of responses) {
      const data = await response.json();
      if (attempt !== loadAttempt) return;
      pack.stages.push(...data.stages);
    }
    const validation = validateLevelsPack(pack);
    if (!validation.ok) {
      throw new Error(`level data is invalid — ${validation.errors.slice(0, 3).join(' | ')}`);
    }
    levelQuestions = new Map();
    for (const stage of pack.stages) {
      for (const level of stage.levels) {
        levelQuestions.set(level.id, level.questions);
      }
    }
    renderMenu();
  } catch (err) {
    if (attempt !== loadAttempt) return;
    levelQuestions = null;
    const reason = err && err.name === 'AbortError' ? 'the request timed out' : err.message || 'network error';
    els.errorText.textContent = `Could not load the levels (${reason}). Check that the dev server is running, then retry.`;
    setScreen('error');
  } finally {
    clearTimeout(timeout);
  }
}

/** Manifest entry + questions combined into an engine-ready lesson. */
function lessonFor(level) {
  const questions = levelQuestions && levelQuestions.get(level.id);
  if (!questions) return null;
  return { id: level.id, title: level.title, questions };
}

/* ------------------------------------------------------------------ */
/* Menu + level select                                                 */
/* ------------------------------------------------------------------ */

function renderMenu() {
  if (!levelQuestions) {
    els.errorText.textContent = 'No levels available.';
    setScreen('error');
    return;
  }
  const target = continueTarget(progress);
  const playedAny = passedLevelCount(progress) > 0 || Object.keys(progress.levels).length > 0;
  els.btnPlayLabel.textContent = playedAny ? `Continue · Level ${target.order}` : 'Play';
  const stars = totalStars(progress);
  const passed = passedLevelCount(progress);
  els.menuBest.textContent = `${passed}/${LEVELS.length} levels passed · ${stars}/${LEVELS.length * 3} stars`;
  setScreen('menu');
}

function starRow(bestStars) {
  let out = '';
  for (let i = 0; i < 3; i++) {
    out += i < bestStars ? '⭐' : '<span class="star-off">⭐</span>';
  }
  return out;
}

function renderLevels() {
  if (!levelQuestions) return;
  const target = continueTarget(progress);
  els.levelsProgress.textContent = `${passedLevelCount(progress)}/${LEVELS.length} passed · ${totalStars(progress)} stars`;
  els.levelsList.replaceChildren();

  for (const { stage, levels } of levelsByStage()) {
    const block = document.createElement('div');
    block.className = 'stage-block';

    const header = document.createElement('div');
    header.className = 'stage-header';
    const name = document.createElement('span');
    name.className = 'stage-name';
    name.textContent = stage.name;
    const cefr = document.createElement('span');
    cefr.className = 'stage-cefr';
    cefr.textContent = stage.cefr;
    const desc = document.createElement('span');
    desc.className = 'stage-desc';
    desc.textContent = stage.description;
    header.append(name, cefr, desc);

    const grid = document.createElement('div');
    grid.className = 'stage-grid';

    for (const level of levels) {
      const rec = progress.levels[level.id];
      const unlocked = isLevelUnlocked(progress, level.id);
      const passed = Boolean(rec && rec.passed);

      const card = document.createElement('div');
      card.className = 'level-card' + (unlocked ? '' : ' is-locked') + (level.id === target.id ? ' is-next' : '');

      const top = document.createElement('div');
      top.className = 'level-top';
      const num = document.createElement('span');
      num.className = 'level-number';
      num.textContent = String(level.order);
      const title = document.createElement('span');
      title.className = 'level-title';
      title.textContent = level.title;
      top.append(num, title);

      const topic = document.createElement('p');
      topic.className = 'level-topic';
      topic.textContent = level.topic;

      const starsEl = document.createElement('div');
      starsEl.className = 'level-stars';
      starsEl.innerHTML = starRow(rec ? rec.bestStars : 0);

      card.append(top, topic, starsEl);

      if (unlocked) {
        const best = document.createElement('div');
        best.className = 'level-best';
        best.textContent = rec && rec.bestScore > 0 ? `Best score: ${rec.bestScore}` : 'Not played yet';
        card.append(best);
        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'level-play';
        play.textContent = passed ? 'Play again' : 'Play';
        play.setAttribute('aria-label', `Play level ${level.order}: ${level.title}`);
        play.addEventListener('click', () => beginLevel(level));
        card.append(play);
        if (level.id === target.id) {
          const badge = document.createElement('span');
          badge.className = 'level-badge-next';
          badge.textContent = 'Next';
          card.append(badge);
        }
      } else {
        const lock = document.createElement('div');
        lock.className = 'level-lock';
        lock.textContent = '🔒 Pass the previous level to unlock';
        card.append(lock);
      }
      grid.append(card);
    }
    block.append(header, grid);
    els.levelsList.append(block);
  }
  setScreen('levels');
}

function openLevelsScreen() {
  renderLevels();
}

/* ------------------------------------------------------------------ */
/* Tutorial (first play; skippable; one practice swipe)                */
/* ------------------------------------------------------------------ */

const TUTORIAL_STEPS = [
  {
    title: '1 · Read the question',
    img: 'assets/fruits/sprites/uncuted/watermelon.png',
    text: 'Every round shows a challenge on the parchment banner, like "Slice the fruits.".',
  },
  {
    practice: true,
    title: '2 · Slice the matching fruit',
    fruit: 'apple',
    fruitImg: 'assets/fruits/sprites/uncuted/apple.png',
    cutImg: 'assets/fruits/sprites/cuted/apple.png',
    text: 'Drag across the fruit carrying a word that matches. Try it: swipe through this apple!',
  },
  {
    title: '3 · Leave other fruits alone',
    img: 'assets/fruits/sprites/uncuted/strawberry.png',
    label: 'table',
    text: 'This strawberry says "table" — not a fruit. Slicing wrong words costs a heart, so let it fly by.',
  },
  {
    title: 'Ready to play!',
    text: 'You have 3 hearts, 10 questions per level, and stars for 8–10 clear rounds. Good luck!',
  },
];

let tutorialIndex = 0;
let tutorialPracticeDone = false;
let tutorialPendingLevel = null;

function renderTutorialStep() {
  const step = TUTORIAL_STEPS[tutorialIndex];
  els.tutorialSteps.replaceChildren();
  tutorialPracticeDone = false;
  els.btnTutorialNext.textContent = tutorialIndex === TUTORIAL_STEPS.length - 1 ? 'Start playing' : 'Next';

  const view = document.createElement('div');
  view.className = 'tutorial-step is-active';

  const h3 = document.createElement('h3');
  h3.textContent = step.title;
  view.append(h3);

  if (step.practice) {
    const demo = document.createElement('div');
    demo.className = 'tutorial-fruit-demo';
    const img = document.createElement('img');
    img.src = step.fruitImg;
    img.alt = '';
    img.draggable = false;
    const label = document.createElement('span');
    label.className = 'fruit-label';
    label.textContent = step.fruit;
    const blade = document.createElement('i');
    blade.className = 'demo-blade';
    demo.append(img, label, blade);

    let startX = null;
    let startY = null;
    const MIN = 24;
    const onDown = (ev) => {
      startX = ev.clientX;
      startY = ev.clientY;
      ev.preventDefault();
    };
    const onMove = (ev) => {
      if (startX === null || tutorialPracticeDone) return;
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) >= MIN) {
        tutorialPracticeDone = true;
        img.src = step.cutImg; // the same cut artwork used in gameplay
        blade.remove();
        const hint = document.createElement('p');
        hint.className = 'tutorial-hint';
        hint.textContent = 'Nice slice! Tap Next.';
        view.append(hint);
      }
    };
    const onUp = () => { startX = null; };
    demo.addEventListener('pointerdown', onDown);
    demo.addEventListener('pointermove', onMove);
    demo.addEventListener('pointerup', onUp);
    demo.addEventListener('pointerleave', onUp);
    view.append(demo);
  } else if (step.img) {
    const img = document.createElement('img');
    img.src = step.img;
    img.alt = '';
    const wrap = document.createElement('div');
    wrap.className = 'tutorial-fruit-demo';
    wrap.style.cursor = 'default';
    wrap.append(img);
    if (step.label) {
      const label = document.createElement('span');
      label.className = 'fruit-label';
      label.textContent = step.label;
      wrap.append(label);
    }
    view.append(wrap);
  }

  const p = document.createElement('p');
  p.textContent = step.text;
  view.append(p);
  els.tutorialSteps.append(view);
}

function openTutorial(pendingLevel) {
  tutorialPendingLevel = pendingLevel;
  tutorialIndex = 0;
  renderTutorialStep();
  els.tutorialOverlay.hidden = false;
}

function finishTutorial() {
  els.tutorialOverlay.hidden = true;
  if (!progress.tutorialDone) {
    progress = { ...progress, tutorialDone: true };
    writeProgress(window.localStorage, progress);
  }
  const level = tutorialPendingLevel;
  tutorialPendingLevel = null;
  if (level) startGame(level);
}

/* ------------------------------------------------------------------ */
/* Animation loop (exactly one, restart-safe)                          */
/* ------------------------------------------------------------------ */

let rafId = null;
let watchdogId = null;
let lastTimestamp = null;
let lastFrameWallClock = 0;

/**
 * Some embedded/occluded webviews stop producing requestAnimationFrame
 * callbacks while the page stays "visible". This watchdog drives the
 * SAME loop body from a timer, but only when frames have stalled for
 * RAFA_STALL_MS — normal browsers never trigger it. It is still one
 * loop with one timeline: tick() is idempotent per wall-clock timestamp
 * and the engine clamps oversized deltas.
 */
const RAF_STALL_MS = 500;

function startLoop() {
  if (rafId !== null) return;
  lastTimestamp = null;
  lastFrameWallClock = performance.now();
  rafId = requestAnimationFrame(tick);
  if (watchdogId === null) {
    watchdogId = setInterval(() => {
      if (rafId !== null && performance.now() - lastFrameWallClock > RAF_STALL_MS) {
        tick(performance.now());
      }
    }, 200);
  }
}

function stopLoop() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (watchdogId !== null) {
    clearInterval(watchdogId);
    watchdogId = null;
  }
  lastTimestamp = null;
}

function tick(timestamp) {
  rafId = requestAnimationFrame(tick);
  lastFrameWallClock = performance.now();
  if (lastTimestamp === null) {
    lastTimestamp = timestamp;
    return;
  }
  const dt = (timestamp - lastTimestamp) / 1000;
  lastTimestamp = timestamp;
  if (engine && engine.state === ENGINE_STATES.PLAYING) {
    engine.update(dt); // engine clamps/bounds internally
  }
  processEngineEvents();
  renderFrame();
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/** fruitId -> {root, img, label, x, y, appearanceId}; ACTIVE fruits only. */
const fruitEls = new Map();
/** Terminal fruit ids -> {kind, dirX, dirY} for the death animation. */
const deathDetails = new Map();
/** [{el, until}] DOM cleanup list processed each frame (no timers). */
let dyingFruits = [];
let floatNotes = [];
let juiceBursts = [];
/** Swipe trail points in playfield coordinates, pruned by age. */
let trailPoints = [];
/** Last swipe segment direction (unit vector) for slice FX bias. */
let lastSliceDir = { x: 1, y: 0 };

/**
 * Sprites are trimmed to the fruit body, so the box scales from the
 * engine's collision radius. Each fruit carries its own `scale`: round
 * fruits sit at ~1.04 (a hair larger than the collision circle so the
 * silhouette reads cleanly), while elongated shapes go larger so their
 * thin axes still feel sliceable — the circle itself always comes from
 * the engine and is never inflated here.
 */
function spriteBoxFor(fruit) {
  const art = FRUIT_APPEARANCES[fruit.appearanceId];
  const images = appearanceImages.get(fruit.appearanceId);
  const whole = images && images.whole;
  const aspect = whole && whole.naturalWidth > 0 ? whole.naturalHeight / whole.naturalWidth : 1;
  const scale = art && Number.isFinite(art.scale) ? art.scale : 1.04;
  const w = Math.round(fruit.radius * 2 * scale);
  const h = Math.round(w * aspect);
  return { w, h };
}

function renderFrame() {
  if (!engine || screens.game.hidden) {
    pruneDecorations();
    return;
  }
  const snapshot = engine.getFruitsSnapshot();
  const seen = new Set();

  for (const fruit of snapshot) {
    seen.add(fruit.id);
    let entry = fruitEls.get(fruit.id);
    if (!entry) {
      entry = createFruitElement(fruit);
      fruitEls.set(fruit.id, entry);
    }
    syncFruitSprite(fruit, entry);
    entry.x = fruit.x;
    entry.y = fruit.y;
    // Pixel math (not translate(-50%)) keeps the center exact at any size.
    entry.root.style.transform =
      `translate(${fruit.x - entry.w / 2}px, ${fruit.y - entry.h / 2}px) rotate(${fruit.rotation}deg)`;
    entry.root.style.setProperty('--rot', `${fruit.rotation}deg`); // label counter-rotation
  }

  // Fruits that vanished from the snapshot were resolved by the engine.
  for (const [id, entry] of fruitEls) {
    if (!seen.has(id)) {
      fruitEls.delete(id);
      startDeathAnimation(id, entry);
    }
  }

  renderTrail();
  pruneDecorations();
  renderHud();
}

function createFruitElement(fruit) {
  const root = document.createElement('div');
  root.className = 'fruit';
  root.dataset.appearance = fruit.appearanceId;
  const { w, h } = spriteBoxFor(fruit);
  root.style.width = `${w}px`;
  root.style.height = `${h}px`;

  // Both layers exist up front; the placeholder shows until the sprite
  // finishes loading (syncFruitSprite upgrades the fruit in place).
  const img = document.createElement('img');
  img.className = 'fruit-img';
  img.alt = '';
  img.draggable = false;
  const fallback = document.createElement('div');
  fallback.className = 'fruit-fallback';

  const label = document.createElement('span');
  label.className = 'fruit-label';
  label.textContent = fruit.optionText;
  // Base size from the collision radius, then shrink long words so they
  // stay on the fruit body instead of spilling past its silhouette.
  const base = Math.max(13, fruit.radius * 0.42);
  const chars = Math.max(2, fruit.optionText.length);
  const fit = (Math.min(w, h) * 0.78) / (0.62 * chars); // bold ≈ 0.62em per char
  root.style.fontSize = `${Math.max(11, Math.round(Math.min(base, fit)))}px`;
  root.append(img, fallback, label);
  els.fruitsLayer.append(root);
  return { root, img, w, h, x: fruit.x, y: fruit.y, appearanceId: fruit.appearanceId, artState: 'pending' };
}

/**
 * Shows the whole-fruit PNG as soon as it has loaded; until then the CSS
 * placeholder ball carries the fruit. A late load re-boxes the element to
 * the sprite's true aspect ratio (renderFrame re-centers from entry.w/h).
 */
function syncFruitSprite(fruit, entry) {
  if (entry.artState !== 'pending') return;
  const images = appearanceImages.get(fruit.appearanceId);
  const whole = images && images.whole;
  if (!whole || !whole.complete) return; // still in flight
  if (whole.naturalWidth > 0) {
    entry.artState = 'image';
    const box = spriteBoxFor(fruit); // aspect is now known
    entry.w = box.w;
    entry.h = box.h;
    entry.root.style.width = `${box.w}px`;
    entry.root.style.height = `${box.h}px`;
    entry.img.src = FRUIT_APPEARANCES[fruit.appearanceId].whole;
    entry.root.classList.add('has-img');
  } else {
    entry.artState = 'fallback'; // genuinely missing — keep the placeholder
  }
}

function startDeathAnimation(fruitId, entry) {
  const detail = deathDetails.get(fruitId) || { kind: 'miss', dirX: 1, dirY: 0 };
  deathDetails.delete(fruitId);
  const { kind, dirX, dirY } = detail;
  entry.root.classList.add('dying', kind === 'miss' ? 'dying-miss' : 'dying-hit');
  if (kind !== 'miss') {
    const files = FRUIT_APPEARANCES[entry.appearanceId];
    const images = appearanceImages.get(entry.appearanceId);
    const cut = images && images.cut;
    const cutLoaded = !!(files && cut && cut.complete && cut.naturalWidth > 0);
    if (cutLoaded) {
      // One cut artwork, clipped into two copies that fly apart along the swipe.
      for (const side of ['left', 'right']) {
        const half = document.createElement('img');
        half.className = `fruit-half-img half-${side}`;
        half.src = files.cut;
        half.alt = '';
        half.draggable = false;
        entry.root.append(half);
      }
      const spread = Math.max(34, entry.w * 0.22);
      entry.root.style.setProperty('--dx', `${Math.round(Math.abs(dirX) * spread + 12)}px`);
      entry.root.style.setProperty('--dy', `${Math.round(18 + Math.abs(dirY) * 18)}px`);
      entry.root.style.setProperty('--hrdeg', `${Math.round(46 + Math.abs(dirY) * 40)}deg`);
    } else {
      // Cut art unavailable: keep the whole fruit visible and fade it out
      // instead of leaving an empty gap where the fruit used to be.
      entry.root.classList.add('no-cut');
    }
    spawnJuiceBurst(entry.x, entry.y, entry.appearanceId, dirX, dirY, entry.w);
  }
  dyingFruits.push({ el: entry.root, until: performance.now() + 560 });
}

function spawnJuiceBurst(x, y, appearanceId, dirX, dirY, size) {
  const files = FRUIT_APPEARANCES[appearanceId];
  if (!files) return;
  const burst = document.createElement('div');
  burst.className = 'juice-burst';
  burst.style.left = `${Math.round(x)}px`;
  burst.style.top = `${Math.round(y)}px`;
  burst.style.setProperty('--jc', files.juice);
  const count = 9;
  const reach = Math.max(30, size * 0.55);
  for (let i = 0; i < count; i++) {
    const droplet = document.createElement('i');
    // Evenly around the circle, biased along the swipe direction.
    const angle = (i / count) * Math.PI * 2 + (dirX >= 0 ? 0 : Math.PI / count);
    const bias = 0.45; // fraction of reach added along the swipe
    const jx = Math.cos(angle) * reach + dirX * reach * bias;
    const jy = Math.sin(angle) * reach * 0.7 + dirY * reach * bias;
    droplet.style.setProperty('--jx', `${Math.round(jx)}px`);
    droplet.style.setProperty('--jy', `${Math.round(jy)}px`);
    droplet.style.setProperty('--ds', `${Math.round(6 + Math.random() * size * 0.06)}px`);
    burst.append(droplet);
  }
  els.fruitsLayer.append(burst);
  juiceBursts.push({ el: burst, until: performance.now() + 700 });
}

function addFloatNote(x, y, text, kind) {
  const note = document.createElement('div');
  note.className = `float-note ${kind}`;
  note.textContent = text;
  note.style.left = `${Math.round(x)}px`;
  note.style.top = `${Math.round(y)}px`;
  els.fruitsLayer.append(note);
  floatNotes.push({ el: note, until: performance.now() + 950 });
}

function pruneDecorations() {
  const now = performance.now();
  dyingFruits = dyingFruits.filter((item) => {
    if (item.until > now) return true;
    item.el.remove();
    return false;
  });
  floatNotes = floatNotes.filter((item) => {
    if (item.until > now) return true;
    item.el.remove();
    return false;
  });
  juiceBursts = juiceBursts.filter((item) => {
    if (item.until > now) return true;
    item.el.remove();
    return false;
  });
}

/**
 * Clears input-driven transient effects (swipe trail, juice, floating
 * notes). Used when pausing, hiding the tab, opening an overlay, and
 * when a round or session ends — resolution animations (dying fruits)
 * always run to completion and are pruned by pruneDecorations().
 */
function clearTransientFx() {
  trailPoints = [];
  els.trailLine.setAttribute('points', '');
  if (els.trailGlow) els.trailGlow.setAttribute('points', '');
  for (const item of juiceBursts) item.el.remove();
  juiceBursts = [];
  for (const item of floatNotes) item.el.remove();
  floatNotes = [];
}

/**
 * Drops resolved fruit visuals when leaving the game screen (feedback,
 * results). Without this, stale entries in fruitEls would replay their
 * death animations on screen when the next round becomes visible.
 */
function clearFruitVisuals() {
  for (const entry of fruitEls.values()) entry.root.remove();
  fruitEls.clear();
  deathDetails.clear();
}

const TRAIL_LIFETIME_MS = 240;
const TRAIL_MAX_POINTS = 24;

function renderTrail() {
  const now = performance.now();
  trailPoints = trailPoints.filter((p) => now - p.t < TRAIL_LIFETIME_MS);
  if (trailPoints.length > TRAIL_MAX_POINTS) {
    trailPoints = trailPoints.slice(-TRAIL_MAX_POINTS);
  }
  const points = trailPoints.map((p) => `${p.x},${p.y}`).join(' ');
  els.trailLine.setAttribute('points', points);
  if (els.trailGlow) els.trailGlow.setAttribute('points', points);
}

function pushTrailPoint(x, y) {
  trailPoints.push({ x, y, t: performance.now() });
}

/** "1:23" style elapsed-play-time label (engine simulation seconds). */
function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderHud() {
  if (!engine) return;
  const hud = engine.getHudState();
  els.hudQuestion.textContent = `Round ${hud.questionNumber}/${hud.questionTotal}`;
  els.hudProgressFill.style.width = `${Math.round((hud.questionNumber / hud.questionTotal) * 100)}%`;
  els.hudScoreValue.textContent = `${hud.score}`;
  els.hudTimerValue.textContent = formatTime(hud.elapsed);
  const hearts = [];
  for (let i = 0; i < hud.maxHearts; i++) {
    const className = i < hud.hearts ? 'heart' : 'heart empty';
    hearts.push(`<span class="${className}" aria-hidden="true">♥</span>`);
  }
  els.hudHearts.innerHTML = hearts.join('');
  els.hudHearts.setAttribute('aria-label', `Hearts ${hud.hearts} of ${hud.maxHearts}`);
  els.panelScore.textContent = `${hud.score}`;
  els.panelStreak.textContent = hud.streak > 0 ? `${hud.streak} ×${hud.multiplier}` : '—';
  els.panelStreak.classList.toggle('is-hot', hud.multiplier > 1);
  els.panelBest.textContent = `${Math.max(sessionBestScore, hud.score)}`;
  els.questionPrompt.textContent = hud.prompt;
  els.questionWave.textContent = hud.wave ? `Wave ${hud.wave.current} of ${hud.wave.total}` : '';
}

/* ------------------------------------------------------------------ */
/* Engine events → interface                                           */
/* ------------------------------------------------------------------ */

function processEngineEvents() {
  if (!engine) return;
  for (const event of engine.drainEvents()) {
    switch (event.type) {
      case 'correctSlice':
        deathDetails.set(event.fruitId, { kind: 'hit', dirX: lastSliceDir.x, dirY: lastSliceDir.y });
        addFloatNote(event.x, event.y, `+${event.points}`, 'good');
        break;
      case 'wrongSlice':
        deathDetails.set(event.fruitId, { kind: 'hit', dirX: lastSliceDir.x, dirY: lastSliceDir.y });
        addFloatNote(event.x, event.y, `${event.optionText} ✗ −1 heart`, 'bad');
        els.hudHearts.classList.remove('lost');
        void els.hudHearts.offsetWidth; // restart the animation
        els.hudHearts.classList.add('lost');
        break;
      case 'targetMissed':
        deathDetails.set(event.fruitId, { kind: 'miss', dirX: 0, dirY: 1 });
        addFloatNote(event.x, Math.min(event.y, (engine.playfield.h || 400) - 30), 'missed', 'miss-note');
        break;
      case 'roundCompleted':
        showFeedback(event.report);
        break;
      case 'sessionEnded':
        showResults(event.report);
        break;
      case 'roundRecovered':
        els.resizeNotice.hidden = false;
        clearGesture();
        break;
      case 'roundReady':
        els.resizeNotice.hidden = true;
        break;
      default:
        break;
    }
  }
  refreshView();
}

/** Syncs in-playfield overlays with the engine state. */
function refreshView() {
  if (!engine) return;
  const state = engine.state;
  const inGame = appState === 'GAME';
  // An open app overlay sits above everything and owns the pause.
  const appOverlayOpen = !els.menuHowOverlay.hidden || !els.settingsOverlay.hidden || !els.tutorialOverlay.hidden;
  els.readyOverlay.hidden = !(inGame && state === ENGINE_STATES.ROUND_READY && !appOverlayOpen);
  els.pauseOverlay.hidden = !(inGame && state === ENGINE_STATES.PAUSED && !appOverlayOpen);
  els.btnPause.disabled = state !== ENGINE_STATES.PLAYING;
  if (state === ENGINE_STATES.ROUND_READY) {
    const hud = engine.getHudState();
    els.readyProgress.textContent = `Question ${hud.questionNumber} of ${hud.questionTotal}`;
    els.readyPrompt.textContent = hud.prompt;
    const options = engine.getOptionOutcomes();
    const count = options ? Object.keys(options).length : 0;
    const waves = Math.ceil(count / engine.maxActiveFruits);
    els.readyWaves.textContent = waves > 1 ? `${count} words in ${waves} waves` : `${count} words in 1 wave`;
  }
  renderHud();
}

/* ------------------------------------------------------------------ */
/* Feedback and results screens                                        */
/* ------------------------------------------------------------------ */

function fillWordGroup(container, heading, words, itemClass, suffix) {
  container.textContent = '';
  if (!words || words.length === 0) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const h = document.createElement('h3');
  h.textContent = heading;
  const list = document.createElement('ul');
  list.className = 'fb-list';
  for (const word of words) {
    const li = document.createElement('li');
    li.className = itemClass;
    li.textContent = suffix ? `${word} ${suffix}` : word;
    list.append(li);
  }
  container.append(h, list);
}

function showFeedback(report) {
  els.fbProgress.textContent = `Question ${report.questionNumber} of ${report.questionTotal}`;
  els.fbTitle.textContent = report.successful ? '✓ Round clear!' : '✗ Round finished';
  els.fbTitle.className = report.successful ? 'fb-title-good' : 'fb-title-bad';
  els.fbPrompt.textContent = report.prompt;
  fillWordGroup(els.fbCorrect, 'Correct words', report.slicedCorrect, 'ok', '✓');
  fillWordGroup(els.fbWrong, 'Wrong slices', report.wrongSelections, 'err', '✗');
  fillWordGroup(els.fbMissed, 'Missed words', report.missedCorrect, 'err', '— missed');
  els.fbExplanation.textContent = report.explanation;
  clearTransientFx();
  clearFruitVisuals();
  setScreen('feedback');
  clearGesture();
}

function renderStars(stars) {
  els.rsStars.replaceChildren();
  for (let i = 0; i < 3; i++) {
    const star = document.createElement('span');
    star.className = i < stars ? 'star earned' : 'star';
    star.textContent = '⭐';
    els.rsStars.append(star);
  }
}

function showResults(report) {
  const stars = starsFor(report);
  els.rsTitle.textContent = report.completed ? 'Level complete!' : 'Session ended early';
  let subtitle;
  if (!report.completed) {
    subtitle = 'You ran out of hearts. The level was not completed.';
  } else if (report.passStatus === 'passed') {
    subtitle = `Passed — ${report.successfulRounds} of ${report.totalRounds} rounds clear.`;
  } else {
    subtitle = `Keep practicing — ${report.successfulRounds} of ${report.totalRounds} rounds clear. You need ${TUNING.PASS_SUCCESSFUL_ROUNDS} to pass.`;
  }
  els.rsSubtitle.textContent = subtitle;
  renderStars(stars);

  // Record progress (stars, unlocks, achievements) against the level.
  const { progress: updated, newlyEarned } = recordLevelResult(progress, report.lessonId, {
    completed: report.completed,
    passStatus: report.passStatus,
    score: report.score,
    successfulRounds: report.successfulRounds,
    endedEarly: report.endedEarly,
    bestStreak: report.bestStreak,
    stars,
  }, new Date().toISOString());
  progress = updated;
  writeProgress(window.localStorage, progress);
  sessionBestScore = Number(progress.levels[report.lessonId]?.bestScore) || 0;
  if (newlyEarned.length) queueAchievementToasts(newlyEarned);

  // Next level button: real unlock state only.
  const next = nextLevel(report.lessonId);
  els.btnNextLevel.hidden = !(next && isLevelUnlocked(progress, next.id));

  const percent = (value) => (value === null ? '—' : `${Math.round(value * 100)}%`);
  const rows = [
    ['Final score', report.score],
    ['Successful rounds', `${report.successfulRounds}/${report.totalRounds}`],
    ['Completed rounds', `${report.completedRounds}/${report.totalRounds}`],
    ['Correct slices', report.correctSlices],
    ['Wrong slices', report.wrongSlices],
    ['Missed correct targets', report.missedTargets],
    ['Avoided distractors', report.avoidedDistractors],
    ['Best streak', report.bestStreak],
    ['Slice accuracy', percent(report.accuracy)],
  ];
  els.rsStats.textContent = '';
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    els.rsStats.append(dt, dd);
  }

  els.rsReview.textContent = '';
  const heading = document.createElement('h3');
  heading.textContent = 'Mistake review';
  els.rsReview.append(heading);
  if (report.mistakes.length === 0) {
    const p = document.createElement('p');
    p.textContent = report.completed ? 'No mistakes — great run!' : 'No mistakes recorded.';
    els.rsReview.append(p);
  } else {
    for (const mistake of report.mistakes) {
      const item = document.createElement('div');
      item.className = 'review-item';
      const h = document.createElement('h3');
      h.textContent = mistake.prompt;
      item.append(h);
      if (mistake.wrongSelections.length) {
        const p = document.createElement('p');
        p.textContent = `Wrongly sliced: ${mistake.wrongSelections.join(', ')}`;
        item.append(p);
      }
      if (mistake.missedCorrect.length) {
        const p = document.createElement('p');
        p.textContent = `Missed: ${mistake.missedCorrect.join(', ')}`;
        item.append(p);
      }
      const why = document.createElement('p');
      why.className = 'muted';
      why.textContent = mistake.explanation;
      item.append(why);
      els.rsReview.append(item);
    }
  }
  clearTransientFx();
  clearFruitVisuals();
  setScreen('results');
  clearGesture();
}

/* ------------------------------------------------------------------ */
/* Pointer input (single active pointer, segment-based slicing)        */
/* ------------------------------------------------------------------ */

let activePointerId = null;
let lastPoint = null;
const MIN_SWIPE_DISTANCE = 3; // px; a stationary pointer must not cut

function canSlice() {
  return engine !== null && engine.state === ENGINE_STATES.PLAYING && appState === 'GAME';
}

/** Converts client coordinates into playfield-local coordinates. */
function toLocal(event) {
  const rect = els.playfield.getBoundingClientRect();
  const scaleX = rect.width > 0 && engine ? engine.playfield.w / rect.width : 1;
  const scaleY = rect.height > 0 && engine ? engine.playfield.h / rect.height : 1;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
  };
}

function clearGesture() {
  activePointerId = null;
  lastPoint = null;
}

function onPointerDown(event) {
  if (!canSlice() || activePointerId !== null) return;
  if (event.target.closest('button')) return; // never start a swipe from a control
  activePointerId = event.pointerId;
  try {
    els.playfield.setPointerCapture(event.pointerId);
  } catch {
    /* capture is best-effort */
  }
  lastPoint = toLocal(event);
  pushTrailPoint(lastPoint.x, lastPoint.y);
  event.preventDefault();
}

function onPointerMove(event) {
  if (activePointerId === null || event.pointerId !== activePointerId) return;
  const point = toLocal(event);
  if (lastPoint) {
    const distance = Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y);
    if (distance >= MIN_SWIPE_DISTANCE && canSlice()) {
      // Remember the swipe direction so slice FX follow the blade.
      lastSliceDir = { x: (point.x - lastPoint.x) / distance, y: (point.y - lastPoint.y) / distance };
      engine.slice(lastPoint.x, lastPoint.y, point.x, point.y);
      processEngineEvents();
    }
  }
  pushTrailPoint(point.x, point.y);
  lastPoint = point;
}

function onPointerEnd(event) {
  if (activePointerId !== null && event.pointerId === activePointerId) {
    clearGesture(); // gestures never connect across releases
  }
}

/* ------------------------------------------------------------------ */
/* Layout, resize recovery, visibility                                 */
/* ------------------------------------------------------------------ */

let lastLayout = { w: 0, h: 0 };
let layoutRaf = null;

function computeMaxActiveFruits() {
  const coarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  return coarsePointer || window.innerWidth < 640 ? TUNING.MOBILE_MAX_ACTIVE : TUNING.DESKTOP_MAX_ACTIVE;
}

/** Re-measures the playfield; significant changes trigger round recovery. */
function applyLayout() {
  layoutRaf = null;
  const w = els.playfield.clientWidth;
  const h = els.playfield.clientHeight;
  if (w <= 0 || h <= 0) return; // never spawn into a hidden playfield
  const hadLayout = lastLayout.w > 0 && lastLayout.h > 0;
  const areaChange = hadLayout ? Math.abs(w * h - lastLayout.w * lastLayout.h) / (lastLayout.w * lastLayout.h) : 0;
  const orientationFlipped = hadLayout && (w > h) !== (lastLayout.w > lastLayout.h);
  lastLayout = { w, h };
  els.trailSvg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  if (!engine) return;
  engine.setPlayfield(w, h);
  // Mid-flight rounds keep their wave chunking; only recalc limits between
  // rounds (significant changes go through recoverRound above/below).
  if (engine.state !== ENGINE_STATES.PLAYING && engine.state !== ENGINE_STATES.PAUSED) {
    engine.setMaxActiveFruits(computeMaxActiveFruits());
  }
  // Ignore small toolbar-height changes; recover only on real changes.
  if ((orientationFlipped || areaChange > 0.3) && engine.recoverRound()) {
    // recoverRound() put us back in ROUND_READY: waves are rebuilt at the
    // next launch, so the mobile/desktop limit can be recalculated safely.
    engine.setMaxActiveFruits(computeMaxActiveFruits());
    processEngineEvents(); // shows the resize notice via roundRecovered
  }
  refreshView();
}

function scheduleApplyLayout() {
  if (layoutRaf !== null) return;
  layoutRaf = requestAnimationFrame(applyLayout);
}

function onVisibilityChange() {
  if (document.hidden && engine && (engine.state === ENGINE_STATES.PLAYING || engine.state === ENGINE_STATES.ROUND_READY)) {
    engine.pause('hidden');
    clearGesture();
    clearTransientFx();
    processEngineEvents();
  }
  // Returning to the tab never auto-resumes; the player must click Resume.
}

/* ------------------------------------------------------------------ */
/* Session lifecycle                                                   */
/* ------------------------------------------------------------------ */

function cleanupGameDom() {
  els.fruitsLayer.replaceChildren();
  fruitEls.clear();
  deathDetails.clear();
  dyingFruits = [];
  floatNotes = [];
  juiceBursts = [];
  trailPoints = [];
  els.trailLine.setAttribute('points', '');
  if (els.trailGlow) els.trailGlow.setAttribute('points', '');
  els.resizeNotice.hidden = true;
  overlayPausedByUs = false;
  clearGesture();
}

function beginLevel(level) {
  if (!progress.tutorialDone) {
    openTutorial(level); // first ever play: interactive walkthrough first
    return;
  }
  startGame(level);
}

function startGame(level) {
  const lesson = lessonFor(level);
  if (!lesson) {
    showToast('Level data is missing — reloading.');
    loadLevelPack();
    return;
  }
  cleanupGameDom();
  setScreen('game'); // the playfield must be visible to be measurable
  currentLevel = level;
  sessionBestScore = Number(progress.levels[level.id]?.bestScore) || 0;
  const stage = stageById(level.stageId);
  els.hudLessonSub.textContent = `Level ${level.order} · ${level.title} · ${stage ? `${stage.name} (${stage.cefr})` : ''}`;
  engine = new WordSliceEngine({
    seed: ((Math.random() * 0xffffffff) >>> 0) || 1,
    maxActiveFruits: computeMaxActiveFruits(),
    tuning: tuningOverridesFor(level.id),
  });
  lastLayout = { w: 0, h: 0 };
  applyLayout();
  engine.startSession(lesson);
  processEngineEvents();
  refreshView();
  startLoop();
}

function quitToLevels() {
  if (engine) engine.abandonToMenu();
  engine = null;
  currentLevel = null;
  stopLoop();
  cleanupGameDom();
  openLevelsScreen();
}

/* ------------------------------------------------------------------ */
/* Achievements list (settings)                                        */
/* ------------------------------------------------------------------ */

function renderAchievements() {
  els.achievementsList.replaceChildren();
  for (const def of ACHIEVEMENTS) {
    const li = document.createElement('li');
    const earned = Boolean(progress.achievements[def.id]);
    if (earned) li.className = 'is-earned';
    const icon = document.createElement('span');
    icon.className = 'ach-icon';
    icon.textContent = '🏆';
    const name = document.createElement('span');
    name.className = 'ach-name';
    name.textContent = def.name;
    const desc = document.createElement('span');
    desc.className = 'ach-desc';
    desc.textContent = earned ? def.description : `? — ${def.description}`;
    li.append(icon, name, desc);
    els.achievementsList.append(li);
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function init() {
  progress = readProgress(window.localStorage);
  preloadAppearanceImages(); // fire-and-forget; menu previews warm the cache

  els.btnRetry.addEventListener('click', () => loadLevelPack());

  // Menu + levels navigation. Every visible button works.
  const goMenu = () => renderMenu();
  const goLevels = () => openLevelsScreen();
  els.btnMenuHome.addEventListener('click', goMenu);
  els.btnLevelsHome.addEventListener('click', goMenu);
  els.btnMenuLevels.addEventListener('click', goLevels);
  els.btnLevelsLevels.addEventListener('click', goLevels);
  els.btnHeroLevels.addEventListener('click', goLevels);
  els.btnPlay.addEventListener('click', () => beginLevel(continueTarget(progress)));

  const openHow = () => openAppOverlay(els.menuHowOverlay);
  els.btnMenuHow.addEventListener('click', openHow);
  els.btnLevelsHow.addEventListener('click', openHow);
  els.btnHeroHow.addEventListener('click', openHow);
  els.pwHelp.addEventListener('click', openHow);
  els.btnMenuHowClose.addEventListener('click', () => closeAppOverlay(els.menuHowOverlay));

  const openSettings = () => {
    renderAchievements();
    openAppOverlay(els.settingsOverlay);
  };
  els.btnMenuSettings.addEventListener('click', openSettings);
  els.btnLevelsSettings.addEventListener('click', openSettings);
  els.pwSettings.addEventListener('click', openSettings);
  els.btnSettingsClose.addEventListener('click', () => closeAppOverlay(els.settingsOverlay));
  els.btnSettingsHow.addEventListener('click', () => {
    els.settingsOverlay.hidden = true; // how-to stacks on top of settings
    openAppOverlay(els.menuHowOverlay);
  });
  els.btnResetBest.addEventListener('click', () => {
    if (!currentLevel) return;
    const next = {
      ...progress,
      levels: { ...progress.levels, [currentLevel.id]: { bestStars: 0, bestScore: 0, plays: 0, passed: false, last: null } },
    };
    progress = next;
    writeProgress(window.localStorage, progress);
    sessionBestScore = 0;
    closeAppOverlay(els.settingsOverlay);
    showToast('Best score for this level reset.');
  });

  // Tutorial flow.
  els.btnTutorialNext.addEventListener('click', () => {
    const step = TUTORIAL_STEPS[tutorialIndex];
    if (step && step.practice && !tutorialPracticeDone) return; // practice first (Skip stays available)
    if (tutorialIndex < TUTORIAL_STEPS.length - 1) {
      tutorialIndex++;
      renderTutorialStep();
    } else {
      finishTutorial();
    }
  });
  els.btnTutorialSkip.addEventListener('click', finishTutorial);

  // In-game controls.
  els.btnLaunch.addEventListener('click', () => {
    if (engine && engine.state === ENGINE_STATES.ROUND_READY) {
      els.resizeNotice.hidden = true;
      engine.launchRound();
      clearGesture(); // rebase pointer history at round start
      processEngineEvents();
    }
  });
  els.btnPause.addEventListener('click', () => {
    if (engine && engine.state === ENGINE_STATES.PLAYING) {
      engine.pause('user');
      clearGesture();
      clearTransientFx();
      processEngineEvents();
    }
  });
  els.btnResume.addEventListener('click', () => {
    if (engine && engine.state === ENGINE_STATES.PAUSED) {
      engine.resume(); // deliberate player input only
      processEngineEvents();
    }
  });
  els.btnRestart.addEventListener('click', () => currentLevel && startGame(currentLevel));
  els.btnQuit.addEventListener('click', quitToLevels);
  els.btnContinue.addEventListener('click', () => {
    if (engine && engine.state === ENGINE_STATES.ROUND_FEEDBACK) {
      engine.continueToNextRound(); // may finalize → sessionEnded event → results
      processEngineEvents();
      if (engine.state === ENGINE_STATES.ROUND_READY) {
        setScreen('game');
        applyLayout();
        refreshView();
      }
    }
  });

  // Results actions.
  els.btnAgain.addEventListener('click', () => currentLevel && startGame(currentLevel));
  els.btnNextLevel.addEventListener('click', () => {
    const next = currentLevel && nextLevel(currentLevel.id);
    if (next) beginLevel(next);
    else openLevelsScreen();
  });
  els.btnMenu.addEventListener('click', quitToLevels);

  els.playfield.addEventListener('pointerdown', onPointerDown);
  els.playfield.addEventListener('pointermove', onPointerMove);
  els.playfield.addEventListener('pointerup', onPointerEnd);
  els.playfield.addEventListener('pointercancel', onPointerEnd);
  els.playfield.addEventListener('lostpointercapture', onPointerEnd);
  els.playfield.addEventListener('pointerleave', () => {
    // Rebase only when the gesture is not captured: with capture the drag
    // legitimately continues; without it, leaving the board must not leave
    // a stale lastPoint that would draw an invisible diagonal on re-entry.
    if (activePointerId !== null) {
      let captured = false;
      try {
        captured = els.playfield.hasPointerCapture(activePointerId);
      } catch {
        captured = false;
      }
      if (!captured) clearGesture();
    }
  });
  window.addEventListener('blur', clearGesture);

  window.addEventListener('resize', scheduleApplyLayout);
  window.addEventListener('orientationchange', scheduleApplyLayout);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(scheduleApplyLayout).observe(els.playfield);
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  loadLevelPack();
}

init();
