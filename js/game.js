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
  resetLevelBestScore,
} from './progress.js';
import {
  RoundIntroScheduler,
  INTRO_STATES,
} from './round-intro.js';
import { audioManager } from './audio.js';

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

/** #app carries the cinematic pause class (scene grayscale + blur). */
const appRoot = $('app');

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
  btnSoundToggle: $('btn-sound-toggle'),
  rangeEffectsVolume: $('range-effects-volume'),
  volumeValue: $('volume-value'),
  btnResetBest: $('btn-reset-best'),
  achievementsList: $('achievements-list'),
  confirmOverlay: $('confirm-overlay'),
  confirmText: $('confirm-text'),
  btnConfirmCancel: $('btn-confirm-cancel'),
  btnConfirmReset: $('btn-confirm-reset'),
  tutorialOverlay: $('tutorial-overlay'),
  tutorialSteps: $('tutorial-steps'),
  btnTutorialSkip: $('btn-tutorial-skip'),
  btnTutorialNext: $('btn-tutorial-next'),
  gameToast: $('game-toast'),
  hudLevelValue: $('hud-level-value'),
  hudRoundValue: $('hud-round-value'),
  hudProgressTrack: $('hud-progress-track'),
  hudProgressFill: $('hud-progress-fill'),
  hudScore: $('hud-score'),
  hudScoreValue: $('hud-score-value'),
  hudCombo: $('hud-combo'),
  hudComboValue: $('hud-combo-value'),
  hudHearts: $('hud-hearts'),
  hudTimerValue: $('hud-timer-value'),
  btnPause: $('btn-pause'),
  questionCard: $('question-card'),
  qcBody: document.querySelector('#question-card .qc-body'),
  bannerSlotCard: $('banner-slot-card'),
  qcMeta: $('qc-meta'),
  qcInstruction: $('qc-instruction'),
  qcCountdown: $('qc-countdown'),
  qcCountdownLabel: $('qc-countdown-label'),
  qcCountdownFill: $('qc-countdown-fill'),
  questionPrompt: $('question-prompt'),
  questionWave: $('question-wave'),
  playfield: $('playfield'),
  fruitsLayer: $('fruits-layer'),
  trailSvg: $('trail'),
  trailLine: $('trail-line'),
  trailGlow: $('trail-glow'),
  resizeNotice: $('resize-notice'),
  pauseOverlay: $('pause-overlay'),
  btnResume: $('btn-resume'),
  fbProgress: $('fb-progress'),
  fbTitle: $('fb-title'),
  fbResultIcon: $('fb-result-icon'),
  fbPrompt: $('fb-prompt'),
  fbCorrect: $('fb-correct'),
  fbWrong: $('fb-wrong'),
  fbExplanation: $('fb-explanation'),
  fbFrame: document.querySelector('#screen-feedback .fb-frame'),
  btnContinue: $('btn-continue'),
  rsTitle: $('rs-title'),
  rsStars: $('rs-stars'),
  rsSubtitle: $('rs-subtitle'),
  rsStats: $('rs-stats'),
  rsReview: $('rs-review'),
  rsReviewSub: $('rs-review-sub'),
  rsReviewGrid: $('rs-review-grid'),
  btnReviewAll: $('btn-review-all'),
  rsReviewOverlay: $('rs-review-overlay'),
  rsReviewList: $('rs-review-list'),
  btnReviewClose: $('btn-review-close'),
  btnNextLevel: $('btn-next-level'),
  btnNextLevelLabel: $('btn-next-level-label'),
  btnAgain: $('btn-again'),
  btnMenu: $('btn-menu'),
};

/* ------------------------------------------------------------------ */
/* Fruit sprites: whole + cut PNGs with per-fruit juice color          */
/* ------------------------------------------------------------------ */

const FRUIT_APPEARANCES = {
  watermelon: { whole: 'assets/fruits/sprites/uncuted/watermelon.webp', cut: 'assets/fruits/sprites/cuted/watermelon.webp', juice: '#e5484d', scale: 1.04 },
  pineapple: { whole: 'assets/fruits/sprites/uncuted/pineapple.webp', cut: 'assets/fruits/sprites/cuted/pineapple.webp', juice: '#ffcf3d', scale: 1.08 },
  apple: { whole: 'assets/fruits/sprites/uncuted/apple.webp', cut: 'assets/fruits/sprites/cuted/apple.webp', juice: '#f2e8c9', scale: 1.04 },
  orange: { whole: 'assets/fruits/sprites/uncuted/orange.webp', cut: 'assets/fruits/sprites/cuted/orange.webp', juice: '#ffa53d', scale: 1.04 },
  strawberry: { whole: 'assets/fruits/sprites/uncuted/strawberry.webp', cut: 'assets/fruits/sprites/cuted/strawberry.webp', juice: '#e63950', scale: 1.06 },
  blueberry: { whole: 'assets/fruits/sprites/uncuted/blueberry.webp', cut: 'assets/fruits/sprites/cuted/blueberry.webp', juice: '#5a8dee', scale: 1.04 },
  banana: { whole: 'assets/fruits/sprites/uncuted/banana.webp', cut: 'assets/fruits/sprites/cuted/banana.webp', juice: '#ffe97a', scale: 1.18 },
  pear: { whole: 'assets/fruits/sprites/uncuted/pear.webp', cut: 'assets/fruits/sprites/cuted/pear.webp', juice: '#d9e8a6', scale: 1.06 },
  lemon: { whole: 'assets/fruits/sprites/uncuted/lemon.webp', cut: 'assets/fruits/sprites/cuted/lemon.webp', juice: '#ffd94d', scale: 1.04 },
  kiwi: { whole: 'assets/fruits/sprites/uncuted/kiwi.webp', cut: 'assets/fruits/sprites/cuted/kiwi.webp', juice: '#9bcf3f', scale: 1.04 },
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
  // The question card lives at the #app level (a filtered #screen-game must
  // not re-anchor its fixed positioning), so its visibility follows the
  // game screen explicitly.
  els.questionCard.hidden = name !== 'game';
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
    if (overlayPausedByUs) audioManager.setSuspended(true); // no gameplay audio under overlays
  }
  audioManager.play('menuOpen');
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
  audioManager.setSuspended(false); // safe either way: results/menus never suspend
  processEngineEvents();
  refreshView();
}

/* ------------------------------------------------------------------ */
/* Premium dialogs (Settings / How to Play / reset confirm): proper    */
/* dialog behavior — focus lands on the primary control, Tab cycles    */
/* inside the panel, Escape closes, and focus returns to the invoking  */
/* control. Settings and How to Play swap places (never stacked        */
/* interactively); Got it! returns to Settings when that was the       */
/* entry point. Single static elements — no duplicate instances.       */
/* ------------------------------------------------------------------ */

let overlayReturnFocus = null;
let howOpenedFromSettings = false;

function activeElementOr(el) {
  return el instanceof HTMLElement ? el
    : (document.activeElement instanceof HTMLElement ? document.activeElement : null);
}

function focusablesIn(root) {
  return [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled);
}

/** Keeps Tab inside the open panel (keydown on the overlay element). */
function trapOverlayTab(overlayEl, ev) {
  const focusables = focusablesIn(overlayEl);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (ev.shiftKey) {
    if (active === first || !overlayEl.contains(active)) {
      ev.preventDefault();
      last.focus();
    }
  } else if (active === last || !overlayEl.contains(active)) {
    ev.preventDefault();
    first.focus();
  }
}

function openSettingsPanel(fromEl) {
  overlayReturnFocus = activeElementOr(fromEl);
  howOpenedFromSettings = false;
  renderAchievements();
  syncAudioSettingsUi();
  openAppOverlay(els.settingsOverlay);
  els.btnSettingsClose.focus({ preventScroll: true });
}

function closeSettingsPanel() {
  closeAppOverlay(els.settingsOverlay);
  howOpenedFromSettings = false;
  if (overlayReturnFocus) {
    overlayReturnFocus.focus({ preventScroll: true });
    overlayReturnFocus = null;
  }
}

function openHowPanel(fromSettings) {
  if (!fromSettings) overlayReturnFocus = activeElementOr(null);
  howOpenedFromSettings = Boolean(fromSettings);
  if (fromSettings) els.settingsOverlay.hidden = true; // swap, not a stack
  openAppOverlay(els.menuHowOverlay);
  els.btnMenuHowClose.focus({ preventScroll: true });
}

function closeHowPanel() {
  closeAppOverlay(els.menuHowOverlay);
  if (howOpenedFromSettings) {
    howOpenedFromSettings = false;
    // Reading the rules from Settings returns to Settings afterwards.
    renderAchievements();
    syncAudioSettingsUi();
    openAppOverlay(els.settingsOverlay);
    els.btnSettingsHow.focus({ preventScroll: true });
    return;
  }
  if (overlayReturnFocus) {
    overlayReturnFocus.focus({ preventScroll: true });
    overlayReturnFocus = null;
  }
}

/* The reset target: the session's level when one is live, otherwise the
   level the player is currently working on (the same one the automatic
   session plays). Settings is only reachable from menu screens where no
   session is live, so without this fallback the control would be dead. */
function resetTargetLevel() {
  if (currentLevel) return currentLevel;
  return levelQuestions ? autoLevelChoice() : null;
}

/* The confirm alertdialog opens above Settings (settings stays open
   underneath but is fully covered — no interaction leaks through). */
function openResetConfirm() {
  const level = resetTargetLevel();
  if (!level) return;
  els.confirmText.textContent =
    `This clears the best score for Level ${level.order}: “${level.title}”. `
    + 'Stars, unlocked levels and achievements are kept.';
  els.confirmOverlay.hidden = false;
  els.btnConfirmCancel.focus({ preventScroll: true });
}

function closeResetConfirm() {
  els.confirmOverlay.hidden = true;
  els.btnResetBest.focus({ preventScroll: true });
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
    autoStartSession(); // straight into gameplay — the menu is not shown
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

/* ------------------------------------------------------------------ */
/* Automatic startup                                                   */
/* ------------------------------------------------------------------ */

/**
 * Level chosen for the automatic session: the first unlocked, not-yet-
 * passed level; when everything is passed, the most recently played
 * level (falling back to level 1). Saved progress is never reset.
 */
function autoLevelChoice() {
  if (passedLevelCount(progress) >= LEVELS.length) {
    let best = null;
    let bestAt = -1;
    for (const level of LEVELS) {
      const at = Date.parse(progress.levels[level.id]?.last?.at || '');
      if (Number.isFinite(at) && at > bestAt) {
        bestAt = at;
        best = level;
      }
    }
    return best || LEVELS[0];
  }
  return continueTarget(progress);
}

/** Startup entry point after the data pack loads: play immediately. */
function autoStartSession() {
  if (!levelQuestions) {
    els.errorText.textContent = 'No levels available.';
    setScreen('error');
    return;
  }
  startGame(autoLevelChoice());
}

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

/* Icon paths shared by the level map (stars, play triangle, padlock). */
const STAR_ICON_PATH = 'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z';
const PLAY_ICON_PATH = 'M8.6 5.2c0-1 1.1-1.6 1.9-1.1l9.6 5.9c.8.5.8 1.7 0 2.2l-9.6 5.9c-.8.5-1.9-.1-1.9-1.1V5.2z';
const LOCK_ICON_PATH = 'M12 2a5 5 0 0 0-5 5v3H6.5A2.5 2.5 0 0 0 4 12.5v6A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5v-6A2.5 2.5 0 0 0 17.5 10H17V7a5 5 0 0 0-5-5zm3 8H9V7a3 3 0 0 1 6 0v3z';

function icon(kind, cls) {
  const paths = { star: STAR_ICON_PATH, play: PLAY_ICON_PATH, lock: LOCK_ICON_PATH };
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${paths[kind]}"/></svg>`;
}

/** Three-star row for a level card: gold-filled earned, outlined rest. */
function starIcons(bestStars) {
  let out = '';
  for (let i = 0; i < 3; i++) {
    out += icon('star', `star${i < bestStars ? ' is-earned' : ''}`);
  }
  return out;
}

function renderLevels() {
  if (!levelQuestions) return;
  const target = continueTarget(progress);
  els.levelsProgress.textContent =
    `${passedLevelCount(progress)}/${LEVELS.length} levels passed · ${totalStars(progress)}/${LEVELS.length * 3} stars`;
  els.levelsList.replaceChildren();

  for (const { stage, levels } of levelsByStage()) {
    const block = document.createElement('div');
    block.className = 'stage-block';
    block.dataset.stageId = stage.id; // CSS colors the banner per stage

    const banner = document.createElement('header');
    banner.className = 'stage-banner';
    const heading = document.createElement('div');
    heading.className = 'stage-heading';
    const name = document.createElement('h2');
    name.className = 'stage-name';
    name.textContent = stage.name;
    const cefr = document.createElement('span');
    cefr.className = 'stage-cefr';
    cefr.textContent = stage.cefr;
    heading.append(name, cefr);
    const desc = document.createElement('p');
    desc.className = 'stage-desc';
    desc.textContent = stage.description;
    banner.append(heading, desc);

    const grid = document.createElement('div');
    grid.className = 'stage-grid';

    for (const level of levels) {
      const rec = progress.levels[level.id];
      const unlocked = isLevelUnlocked(progress, level.id);
      const passed = Boolean(rec && rec.passed);
      const bestStars = rec ? rec.bestStars || 0 : 0;
      // The recommended next challenge: the continue target, unless it is
      // already behind the player (every level passed → no Next badge).
      const isNext = level.id === target.id && !passed;

      const card = document.createElement('article');
      card.className = 'level-card' + (isNext ? ' is-next' : '') + (unlocked ? '' : ' is-locked');

      if (isNext) {
        const badge = document.createElement('span');
        badge.className = 'level-badge-next';
        badge.textContent = 'Next';
        card.append(badge);
      }

      const top = document.createElement('div');
      top.className = 'level-top';
      const num = document.createElement('span');
      num.className = 'level-number';
      num.textContent = String(level.order);
      const title = document.createElement('h3');
      title.className = 'level-title';
      title.textContent = level.title;
      top.append(num, title);

      const topic = document.createElement('p');
      topic.className = 'level-topic';
      topic.textContent = level.topic;

      const starsEl = document.createElement('div');
      starsEl.className = 'level-stars';
      starsEl.setAttribute('role', 'img');
      starsEl.setAttribute('aria-label', `${bestStars} of 3 stars`);
      starsEl.innerHTML = starIcons(bestStars);

      card.append(top, topic, starsEl);

      if (unlocked) {
        const best = document.createElement('p');
        best.className = 'level-best';
        best.textContent = rec && rec.bestScore > 0 ? `Best score: ${rec.bestScore}` : 'Not played yet';
        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'level-play';
        play.innerHTML = `${icon('play', 'level-play-icon')}<span>${passed ? 'Play again' : 'Play'}</span>`;
        play.setAttribute('aria-label', `Play level ${level.order}: ${level.title}`);
        play.addEventListener('click', () => beginLevel(level));
        card.append(best, play);
      } else {
        const lock = document.createElement('p');
        lock.className = 'level-lock';
        lock.innerHTML = `${icon('lock', 'level-lock-icon')}<span>Pass the previous level to unlock</span>`;
        card.append(lock);
      }
      grid.append(card);
    }
    block.append(banner, grid);
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
    img: 'assets/fruits/sprites/uncuted/watermelon.webp',
    text: 'Every round shows a challenge on the parchment banner, like "Slice the fruits.".',
  },
  {
    practice: true,
    title: '2 · Slice the matching fruit',
    fruit: 'apple',
    fruitImg: 'assets/fruits/sprites/uncuted/apple.webp',
    cutImg: 'assets/fruits/sprites/cuted/apple.webp',
    text: 'Drag across the fruit carrying a word that matches. Try it: swipe through this apple!',
  },
  {
    title: '3 · Leave other fruits alone',
    img: 'assets/fruits/sprites/uncuted/strawberry.webp',
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
        // Same layered feedback as a real slice: whoosh, instant cut, then
        // the correctness cue slightly behind the cutting transient.
        audioManager.play('bladeWhoosh');
        audioManager.play('fruitCut');
        audioManager.playSequence([{ event: 'correct', delayMs: 80 }]);
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

/**
 * Opens the interactive tutorial. `pendingLevel` starts that level when
 * the walkthrough finishes; null just returns to the current screen.
 * (The overlay and flow stay available to future entry points — the old
 * pause-menu entry was removed with the cinematic pause redesign.)
 */
function openTutorial(pendingLevel) {
  tutorialPendingLevel = pendingLevel;
  tutorialIndex = 0;
  renderTutorialStep();
  els.tutorialOverlay.hidden = false;
  audioManager.play('menuOpen');
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
  else refreshView();
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
  stepIntro(dt);
  processEngineEvents();
  renderFrame();
}

/* ------------------------------------------------------------------ */
/* Round introduction: centered question card → 4s countdown → the     */
/* same card flies to its top slot → the round launches automatically  */
/*                                                                     */
/* Presentation only — the engine stays the source of truth. Timing    */
/* comes from RoundIntroScheduler driven by the single rAF loop, so    */
/* pausing, hiding the tab, restarting or leaving the level freezes or */
/* cancels the countdown and can never double-launch a round.          */
/* ------------------------------------------------------------------ */

const prefersReducedMotion = Boolean(
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
);

const intro = new RoundIntroScheduler({
  flightMs: prefersReducedMotion ? 0 : 520,
});

/** Whole second last heard from the countdown (audio ticks on change). */
let lastCountdownSecond = -1;

function appOverlayOpen() {
  return !els.menuHowOverlay.hidden || !els.settingsOverlay.hidden
    || !els.confirmOverlay.hidden || !els.tutorialOverlay.hidden;
}

/** Countdown/flight may only advance on visible, unpaused gameplay. */
function introActive() {
  return Boolean(engine)
    && engine.state === ENGINE_STATES.ROUND_READY
    && !document.hidden
    && !screens.game.hidden
    && !appOverlayOpen();
}

/** Places the card's visual center at (cx, cy) with the given scale.
    Transform-origin is the top-left corner, so a later height change
    (intro → banner) never shifts the parked position. */
function placeCard(cx, cy, scale) {
  const w = els.questionCard.offsetWidth;
  const h = els.questionCard.offsetHeight;
  els.questionCard.style.transform =
    `translate(${Math.round(cx - (scale * w) / 2)}px, ${Math.round(cy - (scale * h) / 2)}px) scale(${scale})`;
}

/** Centers the card in the playable area (below the HUD), scaled up a
    notch for readability but never wider than the viewport. */
function centerCardInPlayfield() {
  const rect = els.playfield.getBoundingClientRect();
  const cardW = els.questionCard.offsetWidth;
  const maxScale = (window.innerWidth * 0.94) / cardW;
  const scale = Math.min(1.3, Math.max(1, maxScale));
  placeCard(rect.left + rect.width / 2, rect.top + rect.height / 2, scale);
}

/** Parks the card exactly over its reserved top slot: the flight lands
    the card's top-left corner on the slot's corner, so the shrinking
    height settles into the final banner box precisely. */
function parkCardAtSlot() {
  const rect = els.bannerSlotCard.getBoundingClientRect();
  els.questionCard.style.transform = `translate(${Math.round(rect.left)}px, ${Math.round(rect.top)}px) scale(1)`;
}

/* Keeps the compact banner tall enough for questions that wrap: the base
   --qc-compact-h holds one prompt line plus the wave line, and any extra
   wrapped lines grow the live card and its reserved slot in lock step
   (both derive their height from --qc-extra). Text is never shrunk or
   truncated. Presentation only — scoring/physics are untouched. */
let lastCompactFitKey = '';

function fitCompactQuestion(force = false) {
  const card = els.questionCard;
  // Only the settled compact banner is measured: mid-flight boxes are
  // still animating, and the intro card sizes itself from its artwork.
  if (card.hidden || card.classList.contains('is-intro') || card.classList.contains('is-flying')) return;
  const key = `${els.questionPrompt.textContent}|${els.questionWave.textContent}|${window.innerWidth}`;
  if (!force && key === lastCompactFitKey) return;
  lastCompactFitKey = key;
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--qc-extra', '0px'); // measure against the base height
  const gap = parseFloat(getComputedStyle(els.qcBody).rowGap) || 0;
  // The wave line must be measured by its CONTENT (scrollHeight): inside the
  // over-full flex column its offsetHeight is already crushed to 0 (its
  // overflow:hidden makes it shrinkable), which made the fit reserve no
  // space for it and permanently hid the wave line on wrapped prompts.
  const needed = els.questionPrompt.offsetHeight + els.questionWave.scrollHeight + gap;
  const available = els.qcBody.clientHeight; // forces layout at extra = 0
  const extra = Math.max(0, Math.ceil((needed - available) / 2) * 2);
  rootStyle.setProperty('--qc-extra', `${extra}px`);
}

function updateCountdownDom() {
  const seconds = Math.max(1, intro.remainingSeconds);
  els.qcCountdownLabel.textContent = `${seconds}`;
  // The amber bar starts full and drains to zero across the intro; the
  // unrounded percentage keeps the per-frame drain sub-pixel smooth.
  els.qcCountdownFill.style.width = `${((1 - intro.progress) * 100).toFixed(2)}%`;
  els.qcCountdown.setAttribute('aria-label', `Question starts in ${intro.remainingSeconds} seconds`);
}

/** Instruction line adapted to the active question's type. */
const INTRO_INSTRUCTIONS = {
  category: 'Slice only the matching words!',
  'grammar-identify': 'Slice the word that answers the question!',
  'sentence-completion': 'Slice the word that completes the sentence!',
  'word-meaning': 'Slice the word that matches the meaning!',
};

function introInstructionFor(prompt) {
  // The engine shuffles the lesson's questions, so match by prompt text
  // against the validated pack and fall back to the generic instruction.
  const questions = levelQuestions && currentLevel ? levelQuestions.get(currentLevel.id) : null;
  const question = questions && questions.find((item) => item.prompt === prompt);
  return (question && INTRO_INSTRUCTIONS[question.type]) || INTRO_INSTRUCTIONS.category;
}

/** Starts the introduction for the prepared round (from refreshView). */
function beginRoundIntro() {
  if (!engine || intro.state !== INTRO_STATES.IDLE) return;
  const hud = engine.getHudState();
  if (!hud.prompt) return;
  intro.begin();
  lastCountdownSecond = intro.remainingSeconds; // the first tick fires at 3
  audioManager.play('roundIntro');
  els.qcMeta.textContent = `LEVEL ${currentLevel ? currentLevel.order : 1} · ROUND ${hud.questionNumber}/${hud.questionTotal}`;
  els.qcInstruction.textContent = introInstructionFor(hud.prompt);
  els.questionWave.textContent = ''; // no stale wave line during the intro
  lastCompactFitKey = ''; // the next compact landing re-measures the wrap
  document.documentElement.style.setProperty('--qc-extra', '0px');
  els.questionCard.style.height = ''; // intro height comes from the artwork's aspect
  els.questionCard.classList.remove('is-flying');
  els.questionCard.classList.add('is-intro');
  screens.game.classList.add('is-intro');
  updateCountdownDom();
  centerCardInPlayfield(); // snap (no transition while holding)
}

/** Countdown finished: the same card flies from center to its slot. */
function startFlight() {
  const card = els.questionCard;
  // Lock the current intro height, then retarget the slot height so the
  // artwork card shrinks smoothly instead of snapping to banner size.
  card.style.height = `${card.offsetHeight}px`;
  void card.offsetWidth; // flush the locked height before retargeting
  card.classList.add('is-flying'); // enables transform + height transitions
  card.classList.remove('is-intro');
  screens.game.classList.remove('is-intro');
  card.style.height = `${Math.round(els.bannerSlotCard.getBoundingClientRect().height)}px`;
  parkCardAtSlot();
  if (prefersReducedMotion) {
    intro.settle();
    attemptIntroLaunch();
  }
}

/** Post-flight card state (wave preview line, no transition locks). */
function finishFlight() {
  els.questionCard.classList.remove('is-flying');
  els.questionCard.style.height = ''; // banner height takes over (same value)
  // Pre-launch wave preview; renderHud keeps it live once fruits fly.
  const waves = engine ? Math.ceil(Object.keys(engine.getOptionOutcomes() || {}).length / engine.maxActiveFruits) : 0;
  els.questionWave.textContent = waves > 1 ? `Wave 1 of ${waves}` : '';
  fitCompactQuestion(true); // grow for wrapped prompts before fruits launch
  // Re-check one paint later: fonts and the flight's retargeted size
  // transitions settle asynchronously, and throttled renderers can serve
  // stale mid-transition metrics to a same-tick measurement.
  requestAnimationFrame(() => fitCompactQuestion(true));
}

/** Launches the round through the existing engine API — exactly once. */
function attemptIntroLaunch() {
  if (intro.state !== INTRO_STATES.AWAIT_LAUNCH) return;
  finishFlight();
  if (intro.tryLaunch(introActive()) === 'launch') {
    if (!engine || engine.state !== ENGINE_STATES.ROUND_READY) return; // extra safety
    els.resizeNotice.hidden = true;
    engine.launchRound();
    audioManager.play('roundStart'); // presentation only — never drives the launch
    clearGesture(); // rebase pointer history at round start
    processEngineEvents();
  }
}

/** Cancels a running introduction (restart, level change, quit). */
function cancelIntro() {
  intro.cancel();
  els.questionCard.classList.remove('is-intro', 'is-flying');
  screens.game.classList.remove('is-intro');
}

/** Drives the scheduler from the single animation loop. */
function stepIntro(dtSeconds) {
  if (intro.state === INTRO_STATES.IDLE) return;
  const action = intro.step(Math.max(0, dtSeconds) * 1000, introActive());
  if (intro.state === INTRO_STATES.HOLD) {
    updateCountdownDom();
    centerCardInPlayfield(); // track the center across viewport changes
    const second = intro.remainingSeconds;
    if (second !== lastCountdownSecond) {
      lastCountdownSecond = second;
      audioManager.play('countdownTick'); // subtle: never louder than reading
    }
  }
  if (action === 'fly') startFlight();
  else if (action === 'settled') attemptIntroLaunch();
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

/* Hearts are drawn as outlined SVG icons so they stay big, crisp and
   color-stable on every platform (emoji/text hearts render too small).
   Full hearts use the shared #hud-heart-shine gradient for a glossy
   candy look; lost hearts keep their slot as dark hollows. */
const HEART_ICON_PATH =
  'M16 28.2C7.9 21.6 2.6 16.4 2.6 10.3 2.6 5.6 6.2 2.2 10.5 2.2c2.4 0 4.4 1.2 5.5 3 1.1-1.8 3.1-3 5.5-3 4.3 0 7.9 3.4 7.9 8.1 0 6.1-5.3 11.3-13.4 17.9Z';

function heartIcon(full) {
  if (!full) {
    return `<svg class="heart empty" viewBox="0 0 32 30" aria-hidden="true" focusable="false"><path d="${HEART_ICON_PATH}" fill="rgba(8,20,34,0.5)" stroke="rgba(213,225,232,0.42)"/></svg>`;
  }
  return `<svg class="heart" viewBox="0 0 32 30" aria-hidden="true" focusable="false"><path d="${HEART_ICON_PATH}" fill="url(#hud-heart-shine)" stroke="#ffd9df"/><ellipse cx="10.6" cy="9.2" rx="3.8" ry="2.3" fill="rgba(255,255,255,0.8)" transform="rotate(-28 10.6 9.2)"/></svg>`;
}

/** Hearts markup is only rebuilt when the count actually changes. */
let lastHeartsKey = '';

/** Restart a one-shot CSS animation class (score pop, combo flare). */
function retriggerAnimation(el, className) {
  el.classList.remove(className);
  void el.offsetWidth; // restart the animation
  el.classList.add(className);
}

let lastScore = -1;
let lastMultiplier = -1;

function renderHud() {
  if (!engine) return;
  const hud = engine.getHudState();
  if (currentLevel) els.hudLevelValue.textContent = String(currentLevel.order);
  els.hudRoundValue.textContent = `${hud.questionNumber}/${hud.questionTotal}`;
  const lessonPercent = hud.questionTotal > 0
    ? Math.round((hud.questionNumber / hud.questionTotal) * 100)
    : 0;
  els.hudProgressFill.style.width = `${lessonPercent}%`;
  els.hudProgressTrack.setAttribute('aria-valuenow', String(lessonPercent));
  if (hud.score !== lastScore) {
    els.hudScoreValue.textContent = `${hud.score}`;
    if (lastScore >= 0 && hud.score > lastScore) retriggerAnimation(els.hudScore, 'is-bumped');
    lastScore = hud.score;
  }
  els.hudComboValue.textContent = hud.streak > 0 ? `${hud.streak} ×${hud.multiplier}` : '—';
  els.hudCombo.classList.toggle('is-hot', hud.multiplier > 1);
  if (hud.multiplier !== lastMultiplier) {
    if (lastMultiplier >= 0 && hud.multiplier > lastMultiplier) {
      retriggerAnimation(els.hudCombo, 'is-flare');
    }
    lastMultiplier = hud.multiplier;
  }
  els.hudTimerValue.textContent = formatTime(hud.elapsed);
  const heartsKey = `${hud.hearts}/${hud.maxHearts}`;
  if (heartsKey !== lastHeartsKey) {
    lastHeartsKey = heartsKey;
    let hearts = '';
    for (let i = 0; i < hud.maxHearts; i++) hearts += heartIcon(i < hud.hearts);
    els.hudHearts.innerHTML = hearts;
    els.hudHearts.setAttribute('aria-label', `Hearts ${hud.hearts} of ${hud.maxHearts}`);
  }
  els.questionPrompt.textContent = hud.prompt;
  els.questionWave.textContent = hud.wave ? `Wave ${hud.wave.current} of ${hud.wave.total}` : '';
  fitCompactQuestion(); // re-fit only when the banner text actually changes
}

/* ------------------------------------------------------------------ */
/* Engine events → interface                                           */
/* ------------------------------------------------------------------ */

function processEngineEvents() {
  if (!engine) return;
  for (const event of engine.drainEvents()) {
    switch (event.type) {
      case 'correctSlice': {
        deathDetails.set(event.fruitId, { kind: 'hit', dirX: lastSliceDir.x, dirY: lastSliceDir.y });
        addFloatNote(event.x, event.y, `+${event.points}`, 'good');
        // The physical cut plays instantly at the hit; the educational cues
        // follow ~80ms later so the cutting transient stays unmistakable.
        audioManager.play('fruitCut');
        const correctCues = [{ event: 'correct', delayMs: 80 }];
        // Combo cues track the real streak (engine resets it on any miss).
        if (event.streak === 2) correctCues.push({ event: 'combo2', delayMs: 150 });
        else if (event.streak === 3 || event.streak === 4) correctCues.push({ event: 'combo3', delayMs: 150 });
        else if (event.streak >= 5 && event.streak % 5 === 0) correctCues.push({ event: 'comboHigh', delayMs: 150 });
        audioManager.playSequence(correctCues);
        break;
      }
      case 'wrongSlice': {
        deathDetails.set(event.fruitId, { kind: 'hit', dirX: lastSliceDir.x, dirY: lastSliceDir.y });
        addFloatNote(event.x, event.y, `${event.optionText} ✗ −1 heart`, 'bad');
        els.hudHearts.classList.remove('lost');
        void els.hudHearts.offsetWidth; // restart the animation
        els.hudHearts.classList.add('lost');
        audioManager.play('fruitCut');
        audioManager.playSequence([
          { event: 'incorrect', delayMs: 80 },
          { event: 'heartLost', delayMs: 170 }, // quieter layer — sequenced, not stacked loud
        ]);
        break;
      }
      case 'fruitSpawned':
        // One combined fwoop per launch group: the manifest cooldown swallows
        // the wave's 120 ms-spaced siblings, while clearly separate waves
        // retrigger with a fresh variation. Audio only — spawning itself is
        // owned entirely by the engine, and a paused gameplay bus (or a
        // failed audio load) simply skips the sound.
        audioManager.play('fruitThrow');
        break;
      case 'targetMissed':
        deathDetails.set(event.fruitId, { kind: 'miss', dirX: 0, dirY: 1 });
        addFloatNote(event.x, Math.min(event.y, (engine.playfield.h || 400) - 30), 'missed', 'miss-note');
        audioManager.play('fruitMissed'); // soft cue; avoided distractors stay silent
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
  const overlayOpen = appOverlayOpen();
  const showPause = inGame && state === ENGINE_STATES.PAUSED && !overlayOpen;
  const wasShown = !els.pauseOverlay.hidden;
  els.pauseOverlay.hidden = !showPause;
  // Cinematic pause: the whole frozen scene turns black-and-white and
  // blurs behind the one sharp, colorful Play button.
  appRoot.classList.toggle('is-paused', showPause);
  if (showPause && !wasShown) els.btnResume.focus({ preventScroll: true });
  // The pause button also covers the round introduction.
  const introPausable = state === ENGINE_STATES.ROUND_READY && intro.state !== INTRO_STATES.IDLE;
  els.btnPause.disabled = !(state === ENGINE_STATES.PLAYING || introPausable);
  // A prepared round on the visible game screen starts its introduction.
  if (inGame && state === ENGINE_STATES.ROUND_READY && !overlayOpen && intro.state === INTRO_STATES.IDLE) {
    beginRoundIntro();
  }
  // Flight finished while paused/hidden: launch as soon as it is safe.
  if (intro.state === INTRO_STATES.AWAIT_LAUNCH) {
    attemptIntroLaunch();
  }
  renderHud();
}

/* ------------------------------------------------------------------ */
/* Feedback and results screens                                        */
/* ------------------------------------------------------------------ */

/* Constant, trusted icon markup for the feedback card (never built from
   game data — words are always inserted via textContent). */
const FB_ICON_MARKUP = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4.8 12.6l4.4 4.4 10-10.4" fill="none" stroke="currentColor" stroke-width="3.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cross: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6.2 6.2l11.6 11.6M17.8 6.2L6.2 17.8" fill="none" stroke="currentColor" stroke-width="3.1" stroke-linecap="round"/></svg>',
  ring: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="7.2" fill="none" stroke="currentColor" stroke-width="2.6"/></svg>',
};

/**
 * Builds one answer chip. `variant` picks the styling and icon:
 * 'is-ok' (sliced correctly), 'is-err' (wrongly sliced) or 'is-missed'
 * (correct answer that was never sliced — visibly distinct so a miss is
 * never presented as a successful slice).
 */
function fbChip(word, variant) {
  const li = document.createElement('li');
  li.className = `fb-chip ${variant}`;
  const icon = document.createElement('span');
  icon.className = 'chip-ico';
  icon.innerHTML = variant === 'is-ok' ? FB_ICON_MARKUP.check
    : variant === 'is-err' ? FB_ICON_MARKUP.cross
    : FB_ICON_MARKUP.ring;
  const label = document.createElement('span');
  label.className = 'chip-word';
  label.textContent = word;
  li.append(icon, label);
  if (variant === 'is-missed') {
    const tag = document.createElement('span');
    tag.className = 'chip-tag';
    tag.textContent = 'missed';
    li.append(tag);
  }
  return li;
}

/** Renders one answer section; empty sections either show `emptyText` or hide. */
function fillFeedbackSection(container, heading, chips, emptyText) {
  container.replaceChildren();
  const h = document.createElement('h3');
  h.textContent = heading;
  container.append(h);
  if (chips.length === 0) {
    if (!emptyText) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    const p = document.createElement('p');
    p.className = 'fb-allgood';
    p.textContent = emptyText;
    container.append(p);
    return;
  }
  container.hidden = false;
  const list = document.createElement('ul');
  list.className = 'fb-chips';
  list.append(...chips);
  container.append(list);
}

function showFeedback(report) {
  els.fbProgress.textContent = `Question ${report.questionNumber} of ${report.questionTotal}`;
  const successful = Boolean(report.successful);
  audioManager.play(successful ? 'roundSuccess' : 'roundFailed');
  els.fbTitle.textContent = successful ? 'Great job!' : 'Round finished';
  els.fbResultIcon.className = `fb-result-icon ${successful ? 'is-good' : 'is-bad'}`;
  els.fbResultIcon.innerHTML = successful ? FB_ICON_MARKUP.check : FB_ICON_MARKUP.cross;
  els.fbPrompt.textContent = report.prompt;
  // Correct-answer section: sliced words as solid green chips, missed
  // correct answers as dashed "missed" chips (never mixed with wrong
  // slices, never claimed as sliced).
  const correctChips = [
    ...report.slicedCorrect.map((word) => fbChip(word, 'is-ok')),
    ...report.missedCorrect.map((word) => fbChip(word, 'is-missed')),
  ];
  fillFeedbackSection(els.fbCorrect, 'Correct words', correctChips);
  fillFeedbackSection(
    els.fbWrong,
    'Wrong slices',
    report.wrongSelections.map((word) => fbChip(word, 'is-err')),
    'No wrong slices — clean blade!',
  );
  els.fbExplanation.textContent = report.explanation;
  if (els.fbFrame) els.fbFrame.scrollTop = 0; // new round starts at the top
  clearTransientFx();
  clearFruitVisuals();
  setScreen('feedback');
  clearGesture();
}

/* Star shape shared by the results rating (level-map icon path). */
const RS_STAR_PATH = 'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z';

/** Three large SVG stars: earned ones in bright gold, the rest in muted
    stone gray. The gradients live in the #screen-results SVG defs. */
function renderStars(stars) {
  els.rsStars.replaceChildren();
  for (let i = 0; i < 3; i++) {
    const earned = i < stars;
    const star = document.createElement('span');
    star.className = earned ? 'rs-star is-earned' : 'rs-star';
    star.innerHTML =
      `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
      `<path d="${RS_STAR_PATH}" fill="url(#rs-star-${earned ? 'gold' : 'gray'})"` +
      ` stroke="${earned ? '#8a5a2b' : '#43545c'}" stroke-width="1.1" stroke-linejoin="round"/>` +
      (earned
        ? '<path d="M12 4.6 10.05 8.9l-4.6.42 3.5 3-1.05 4.5L12 14.7V4.6z" fill="rgba(255,255,255,0.42)"/>'
        : '') +
      `</svg>`;
    els.rsStars.append(star);
  }
  els.rsStars.setAttribute('aria-label', `${stars} of 3 stars`);
}

/* Constant, trusted icon markup for the statistics rows and mistake
   cards (never built from game data — words are always inserted via
   textContent). */
const RS_STAT_ICONS = {
  score: `<svg viewBox="0 0 24 24"><path d="${RS_STAR_PATH}" fill="currentColor"/></svg>`,
  rounds: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M8.2 12.4l2.6 2.6 5.2-5.6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  completed: '<svg viewBox="0 0 24 24"><path d="M6.4 21V3.6m0 .4c2-1.5 4-1.5 5.8 0s3.8 1.5 5.8 0v9c-2 1.5-4 1.5-5.8 0s-3.8-1.5-5.8 0" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  correct: '<svg viewBox="0 0 24 24"><path d="M4.8 12.6l4.4 4.4L19.2 6.6" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  wrong: '<svg viewBox="0 0 24 24"><path d="M6.6 6.6l10.8 10.8M17.4 6.6L6.6 17.4" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
  missed: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="12" r="4.1" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/></svg>',
  avoided: '<svg viewBox="0 0 24 24"><path d="M12 2.9 5.2 5.6v5c0 4.5 2.9 8 6.8 9.5 3.9-1.5 6.8-5 6.8-9.5v-5L12 2.9z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M9 12l2.2 2.2L15.4 10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  streak: '<svg viewBox="0 0 24 24"><path d="M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5.67z" fill="currentColor"/></svg>',
  accuracy: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.6" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 2.6v3.6M12 17.8v3.6M2.6 12h3.6M17.8 12h3.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/></svg>',
};

/** One statistics row: colored icon chip + dark-brown label + bold value. */
function rsStatRow(icon, label, value, tone) {
  const row = document.createElement('div');
  row.className = 'rs-stat';
  const ico = document.createElement('span');
  ico.className = `rs-stat-ico ${icon}`;
  ico.innerHTML = RS_STAT_ICONS[icon];
  const dt = document.createElement('dt');
  dt.className = 'rs-stat-label';
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.className = `rs-stat-value ${tone}`;
  dd.textContent = value;
  row.append(ico, dt, dd);
  return row;
}

/** Builds one compact mistake card. `clampText` shortens the preview
    explanation (the full-review overlay always shows everything). */
function rsMistakeCard(mistake, opts = {}) {
  const card = document.createElement('article');
  card.className = 'rs-mistake';

  const head = document.createElement('div');
  head.className = 'rs-mistake-head';
  const ico = document.createElement('span');
  ico.className = `rs-mistake-ico ${mistake.wrongSelections.length ? 'is-wrong' : 'is-missed'}`;
  ico.innerHTML = mistake.wrongSelections.length ? RS_STAT_ICONS.wrong : RS_STAT_ICONS.missed;
  const q = document.createElement('h4');
  q.className = 'rs-mistake-q';
  q.textContent = mistake.prompt;
  head.append(ico, q);
  card.append(head);

  const line = (kind, intro, words) => {
    const p = document.createElement('p');
    p.className = `rs-mistake-line ${kind}`;
    p.append(`${intro} `);
    for (const [i, word] of words.entries()) {
      if (i > 0) p.append(', ');
      const b = document.createElement('b');
      b.textContent = word;
      p.append(b);
    }
    card.append(p);
  };
  if (mistake.wrongSelections.length) line('is-wrong', 'Wrongly sliced:', mistake.wrongSelections);
  if (mistake.missedCorrect.length) line('is-missed', 'Missed:', mistake.missedCorrect);

  const why = document.createElement('p');
  why.className = 'rs-mistake-why';
  if (opts.clamp) why.classList.add('is-clamped');
  why.textContent = mistake.explanation;
  card.append(why);
  return card;
}

/**
 * Picks the most useful preview mistakes for the compact summary:
 * distinct prompts first (repeated question texts read as duplicates),
 * wrong slices ranked ahead of missed-only rounds, original order kept
 * within the selection.
 */
function pickMistakePreviews(mistakes, max = 3) {
  const rank = (m) => (m.wrongSelections.length > 0 ? 0 : 1);
  const withIndex = mistakes.map((m, index) => ({ m, index }));
  withIndex.sort((a, b) => rank(a.m) - rank(b.m) || a.index - b.index);
  const chosen = [];
  const usedPrompts = new Set();
  for (const entry of withIndex) {
    if (chosen.length >= max) break;
    if (usedPrompts.has(entry.m.prompt)) continue;
    usedPrompts.add(entry.m.prompt);
    chosen.push(entry);
  }
  for (const entry of withIndex) {
    if (chosen.length >= max) break;
    if (!chosen.includes(entry)) chosen.push(entry);
  }
  chosen.sort((a, b) => a.index - b.index);
  return chosen.map((entry) => entry.m);
}

/* Full-review overlay (every mistake, complete explanations). */
let reviewMistakes = [];
/** What the contextual gold button does for the shown result. */
let nextLevelAction = 'retry';

function openReviewOverlay() {
  if (!reviewMistakes.length) return;
  els.rsReviewList.replaceChildren();
  for (const [i, mistake] of reviewMistakes.entries()) {
    const card = rsMistakeCard(mistake);
    const num = document.createElement('span');
    num.className = 'rs-mistake-num';
    num.textContent = String(i + 1);
    card.querySelector('.rs-mistake-head').prepend(num);
    els.rsReviewList.append(card);
  }
  els.rsReviewOverlay.hidden = false;
  els.rsReviewList.scrollTop = 0;
  els.btnReviewClose.focus({ preventScroll: true });
}

function closeReviewOverlay() {
  if (els.rsReviewOverlay.hidden) return;
  els.rsReviewOverlay.hidden = true;
  if (!els.btnReviewAll.hidden) els.btnReviewAll.focus({ preventScroll: true });
}

function showResults(report) {
  const stars = starsFor(report);
  const passed = report.completed && report.passStatus === 'passed';
  // Was the next level still locked before this result was recorded? (for
  // the unlock cue — must be captured before recordLevelResult mutates it)
  const next = nextLevel(report.lessonId);
  const nextWasUnlocked = next ? isLevelUnlocked(progress, next.id) : false;

  // Banner + contextual message reflect the real outcome — never the same
  // title for every ending.
  els.rsTitle.textContent = !report.completed ? 'Session Ended Early'
    : passed ? 'Level Complete!' : 'Keep Practicing!';
  els.rsSubtitle.textContent = !report.completed
    ? 'You ran out of hearts. The level was not completed.'
    : passed
      ? 'Excellent work! You completed the level.'
      : `Keep practicing — ${report.successfulRounds} of ${report.totalRounds} rounds clear. You need ${TUNING.PASS_SUCCESSFUL_ROUNDS} to pass.`;
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

  // Coherent celebration: jingle → stars → unlock → achievements, spaced
  // instead of stacked (the manager drops anything that would mush).
  const nextNewlyUnlocked = Boolean(next && !nextWasUnlocked && isLevelUnlocked(progress, next.id));
  const celebration = [];
  let atMs = 200;
  if (!report.completed || report.passStatus !== 'passed') {
    celebration.push({ event: 'levelFailed', delayMs: atMs });
    atMs += 1400;
  } else {
    celebration.push({ event: 'levelWin', delayMs: atMs });
    atMs += 1900;
    if (stars >= 3) {
      celebration.push({ event: 'threeStars', delayMs: atMs });
      atMs += 1000;
    } else {
      for (let i = 0; i < stars; i++) {
        celebration.push({ event: 'starEarned', delayMs: atMs });
        atMs += 240;
      }
    }
    if (nextNewlyUnlocked) {
      celebration.push({ event: 'levelUnlocked', delayMs: atMs });
      atMs += 850;
    }
  }
  for (let i = 0; i < newlyEarned.length; i++) {
    celebration.push({ event: 'achievement', delayMs: atMs });
    atMs += 850;
  }
  audioManager.playSequence(celebration);

  // Level Summary: every number comes straight from the engine report.
  // Positive values read deep teal; meaningful error counts read red.
  const percent = (value) => (value === null ? '—' : `${Math.round(value * 100)}%`);
  const errorTone = (count) => (count > 0 ? 'is-error' : 'is-plain');
  const rows = [
    ['score', 'Final Score', `${report.score}`, 'is-positive is-score'],
    ['rounds', 'Successful Rounds', `${report.successfulRounds}/${report.totalRounds}`, 'is-positive'],
    ['completed', 'Completed Rounds', `${report.completedRounds}/${report.totalRounds}`, 'is-positive'],
    ['correct', 'Correct Slices', `${report.correctSlices}`, 'is-positive'],
    ['wrong', 'Wrong Slices', `${report.wrongSlices}`, errorTone(report.wrongSlices)],
    ['missed', 'Missed Correct Targets', `${report.missedTargets}`, errorTone(report.missedTargets)],
    ['avoided', 'Avoided Distractors', `${report.avoidedDistractors}`, 'is-positive'],
    ['streak', 'Best Streak', `${report.bestStreak}`, 'is-positive'],
    ['accuracy', 'Slice Accuracy', percent(report.accuracy), 'is-positive'],
  ];
  els.rsStats.replaceChildren();
  for (const [icon, label, value, tone] of rows) {
    els.rsStats.append(rsStatRow(icon, label, value, tone));
  }

  // Mistake Review: three compact previews; everything stays reachable
  // through the full-review overlay.
  reviewMistakes = report.mistakes;
  els.rsReviewGrid.replaceChildren();
  if (report.mistakes.length === 0) {
    els.rsReviewSub.hidden = true;
    els.btnReviewAll.hidden = true;
    const p = document.createElement('p');
    p.className = 'rs-review-perfect';
    p.textContent = 'Perfect! No mistakes to review.';
    els.rsReviewGrid.append(p);
  } else {
    els.rsReviewSub.hidden = false;
    const previews = pickMistakePreviews(report.mistakes, 3);
    for (const mistake of previews) {
      els.rsReviewGrid.append(rsMistakeCard(mistake, { clamp: true }));
    }
    els.btnReviewAll.hidden = report.mistakes.length <= previews.length;
    els.btnReviewAll.textContent = `Review All Mistakes (${report.mistakes.length})`;
  }

  // Contextual gold action: advance only when the next level is really
  // unlocked; never push a failed session forward.
  if (passed && next && isLevelUnlocked(progress, next.id)) {
    nextLevelAction = 'next';
    els.btnNextLevelLabel.textContent = 'Next Level';
  } else if (passed && !next) {
    nextLevelAction = 'replay';
    els.btnNextLevelLabel.textContent = 'Play Again';
  } else {
    nextLevelAction = 'retry';
    els.btnNextLevelLabel.textContent = 'Try Again';
  }

  closeReviewOverlay(); // a fresh result never inherits an open review
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
/** One blade whoosh per intentional slash gesture (never per move event). */
let gestureWhooshPlayed = false;
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
  gestureWhooshPlayed = false;
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
      if (!gestureWhooshPlayed) {
        gestureWhooshPlayed = true; // + the manager's cooldown blocks spam
        audioManager.play('bladeWhoosh');
      }
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
  fitCompactQuestion(); // wrapped prompts re-fit before the playfield is measured
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
    audioManager.setSuspended(true); // returning to the tab stays silent until Resume
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
  appRoot.classList.remove('is-paused'); // never carry the blur into a new screen
  els.pauseOverlay.hidden = true;
  clearGesture();
}

function beginLevel(level) {
  // Startup goes straight into the level; the interactive tutorial
  // overlay remains available through openTutorial() for future entry
  // points (its old pause-menu entry was removed with the cinematic
  // pause redesign).
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
  cancelIntro(); // any stale countdown/flight must never launch this session
  audioManager.setSuspended(false); // a fresh session always starts audible
  setScreen('game'); // the playfield must be visible to be measurable
  currentLevel = level;
  sessionBestScore = Number(progress.levels[level.id]?.bestScore) || 0;
  lastHeartsKey = ''; // force the HUD hearts to redraw for the new session
  lastScore = -1; // no pop/flare when the fresh values first render
  lastMultiplier = -1;
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
  cancelIntro();
  if (engine) engine.abandonToMenu();
  engine = null;
  currentLevel = null;
  stopLoop();
  cleanupGameDom();
  audioManager.setSuspended(false);
  openLevelsScreen();
}

/* ------------------------------------------------------------------ */
/* Achievements list (settings)                                        */
/* ------------------------------------------------------------------ */

/* One colorful hand-drawn-style icon per achievement (pure local SVG —
   no external artwork). Locked rows gray them via CSS. */
const ACHIEVEMENT_ICONS = {
  'first-lesson': '<svg viewBox="0 0 24 24"><path d="M6 21V3.5" fill="none" stroke="#2f7d32" stroke-width="2" stroke-linecap="round"/><path d="M6 4.5h10.5l-2.8 4 2.8 4H6z" fill="#66bb6a" stroke="#2f7d32" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  'first-three-star': '<svg viewBox="0 0 24 24"><path d="M12 3.2 14.8 9l6.2.6-4.7 4.1 1.4 6.1L12 16.6l-5.7 3.2 1.4-6.1L3 9.6 9.2 9z" fill="#ffcf3d" stroke="#b8860b" stroke-width="1.4" stroke-linejoin="round"/><path d="M12 5.6v10.2" stroke="rgba(255,255,255,0.5)" stroke-width="1.6" stroke-linecap="round"/></svg>',
  'five-in-a-row': '<svg viewBox="0 0 24 24"><path d="M13.5 1.5s.8 2.8.8 5c0 2.1-1.4 3.9-3.6 3.9-2.1 0-3.7-1.8-3.7-3.9l.03-.4C5.3 8 4 11.2 4 14.6c0 4.4 3.6 8 8 8s8-3.6 8-8c0-5.4-2.6-10.3-6.5-13.1z" fill="#ff8a2a" stroke="#c2410c" stroke-width="1.2"/><path d="M11.7 19c-1.5 0-2.7-1.2-2.7-2.6 0-1.3.9-2.2 2.3-2.6 1.5-.3 3-1 3.9-2.1.3 1.1.4 2.2.4 3.4 0 2.2-1.8 3.9-3.9 3.9z" fill="#ffe08a"/></svg>',
  'five-levels': '<svg viewBox="0 0 24 24"><g fill="none" stroke="#0f5f70" stroke-width="1.7"><rect x="3.5" y="4.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="4.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="14.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="14.5" width="7" height="7" rx="1.5"/></g><g fill="#3aa5b8"><rect x="5.5" y="6.5" width="3" height="3" rx="0.8"/><rect x="15.5" y="6.5" width="3" height="3" rx="0.8"/><rect x="5.5" y="16.5" width="3" height="3" rx="0.8"/><rect x="15.5" y="16.5" width="3" height="3" rx="0.8"/></g></svg>',
  'beginner-stage': '<svg viewBox="0 0 24 24"><path d="M12 3.5 1.8 8.4 12 13.3l10.2-4.9z" fill="#0f5f70" stroke="#0a4351" stroke-width="1.3" stroke-linejoin="round"/><path d="M6.6 11v4.3c0 1.5 2.4 2.7 5.4 2.7s5.4-1.2 5.4-2.7V11" fill="none" stroke="#0a4351" stroke-width="1.7" stroke-linecap="round"/><path d="M20.4 9v5.4" fill="none" stroke="#c9a24e" stroke-width="1.7" stroke-linecap="round"/><circle cx="20.4" cy="15.8" r="1.3" fill="#c9a24e"/></svg>',
};

const ACH_STATE_MARKUP = {
  earned: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4.5 12.5l5 5 10-10.5" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>Earned',
  locked: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2a5 5 0 0 0-5 5v3H6.5A2.5 2.5 0 0 0 4 12.5v6A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5v-6A2.5 2.5 0 0 0 17.5 10H17V7a5 5 0 0 0-5-5zm3 8H9V7a3 3 0 0 1 6 0v3z" fill="currentColor"/></svg>Locked',
};

function renderAchievements() {
  els.achievementsList.replaceChildren();
  for (const def of ACHIEVEMENTS) {
    const earned = Boolean(progress.achievements[def.id]);
    const li = document.createElement('li');
    if (earned) li.classList.add('is-earned');

    const medal = document.createElement('span');
    medal.className = 'ach-medal';
    medal.setAttribute('aria-hidden', 'true');
    medal.innerHTML = ACHIEVEMENT_ICONS[def.id] || ACHIEVEMENT_ICONS['first-three-star'];

    const info = document.createElement('span');
    info.className = 'ach-info';
    const name = document.createElement('span');
    name.className = 'ach-name';
    name.textContent = def.name;
    const desc = document.createElement('span');
    desc.className = 'ach-desc';
    desc.textContent = def.description; // same wording earned or locked — the medal shows the state
    info.append(name, desc);

    const state = document.createElement('span');
    state.className = 'ach-state';
    state.innerHTML = earned ? ACH_STATE_MARKUP.earned : ACH_STATE_MARKUP.locked;
    state.title = earned ? 'Achievement earned' : 'Not earned yet';

    li.append(medal, info, state);
    els.achievementsList.append(li);
  }
}

/* ------------------------------------------------------------------ */
/* Audio bootstrap                                                     */
/* ------------------------------------------------------------------ */

/** Reflects the manager's persisted settings into the settings overlay. */
function syncAudioSettingsUi() {
  const on = audioManager.isEffectsOn();
  els.btnSoundToggle.setAttribute('aria-checked', String(on));
  const percent = Math.round(audioManager.getEffectsVolume() * 100);
  els.rangeEffectsVolume.value = String(percent);
  els.rangeEffectsVolume.disabled = !on;
  // --vol drives the slider's gold fill so the track mirrors the value.
  els.rangeEffectsVolume.style.setProperty('--vol', `${percent}%`);
  els.volumeValue.textContent = `${percent}%`;
}

function initAudio() {
  // Debug/verification handle (stats, mute, volume — harmless in production).
  window.wordSliceAudio = audioManager;
  // Fetch (not decode) the essential files now; decoding waits for a
  // gesture, per browser autoplay policy.
  audioManager.warmup();

  // The context is created/resumed from real gestures only; once running,
  // the listeners detach. Until then the game simply plays silently.
  const unlockAudio = () => {
    if (audioManager.unlock()) {
      window.removeEventListener('pointerdown', unlockAudio, true);
      window.removeEventListener('keydown', unlockAudio, true);
    }
  };
  window.addEventListener('pointerdown', unlockAudio, { capture: true, passive: true });
  window.addEventListener('keydown', unlockAudio, true);

  // Every visible button (including live-built level cards) gets a subtle
  // click; keyboard activation fires click too, so this stays accessible.
  document.addEventListener('click', (ev) => {
    if (ev.target instanceof Element && ev.target.closest('button')) {
      audioManager.play('buttonClick');
    }
  }, true);
  // Hover blips: precise pointers (mouse/pen) only, never touch, and the
  // manager's cooldown rate-limits fast crossing.
  if (window.matchMedia && window.matchMedia('(pointer: fine)').matches) {
    document.addEventListener('pointerover', (ev) => {
      if (ev.pointerType === 'touch') return;
      if (ev.target instanceof Element && ev.target.closest('button')) {
        audioManager.play('buttonHover');
      }
    }, { passive: true });
  }

  els.btnSoundToggle.addEventListener('click', () => {
    audioManager.setMuted(audioManager.isEffectsOn()); // toggle
    syncAudioSettingsUi();
  });
  els.rangeEffectsVolume.addEventListener('input', () => {
    audioManager.setEffectsVolume(els.rangeEffectsVolume.valueAsNumber / 100);
    syncAudioSettingsUi();
  });
  syncAudioSettingsUi();
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function init() {
  progress = readProgress(window.localStorage);
  preloadAppearanceImages(); // fire-and-forget; menu previews warm the cache
  initAudio();

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

  els.btnMenuHow.addEventListener('click', () => openHowPanel(false));
  els.btnLevelsHow.addEventListener('click', () => openHowPanel(false));
  els.btnHeroHow.addEventListener('click', () => openHowPanel(false));
  els.btnMenuHowClose.addEventListener('click', closeHowPanel);

  els.btnMenuSettings.addEventListener('click', (ev) => openSettingsPanel(ev.currentTarget));
  els.btnLevelsSettings.addEventListener('click', (ev) => openSettingsPanel(ev.currentTarget));
  els.btnSettingsClose.addEventListener('click', closeSettingsPanel);
  els.btnSettingsHow.addEventListener('click', () => openHowPanel(true));
  els.btnResetBest.addEventListener('click', openResetConfirm);
  els.btnConfirmCancel.addEventListener('click', closeResetConfirm);
  els.btnConfirmReset.addEventListener('click', () => {
    const level = resetTargetLevel();
    if (!level) {
      closeResetConfirm();
      return;
    }
    // Surgical reset: only this level's best score. Stars, plays, the pass
    // flag (and therefore level unlocking), achievements and every other
    // level's record stay untouched — resetting a best score must never
    // re-lock levels the player already earned.
    progress = resetLevelBestScore(progress, level.id);
    writeProgress(window.localStorage, progress);
    if (currentLevel && currentLevel.id === level.id) sessionBestScore = 0;
    els.confirmOverlay.hidden = true;
    showToast('Best score for this level reset.');
    els.btnResetBest.focus({ preventScroll: true });
  });

  // Dialog keyboard behavior per open overlay: Escape closes that dialog,
  // Tab stays trapped inside it. (The tutorial overlay keeps its own
  // Skip-driven flow and is untouched here.)
  for (const overlayEl of [els.settingsOverlay, els.menuHowOverlay, els.confirmOverlay]) {
    overlayEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        if (overlayEl === els.confirmOverlay) closeResetConfirm();
        else if (overlayEl === els.menuHowOverlay) closeHowPanel();
        else closeSettingsPanel();
      } else if (ev.key === 'Tab') {
        trapOverlayTab(overlayEl, ev);
      }
    });
  }

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

  // In-game controls. (Rounds launch automatically after the intro —
  // there is no manual "Launch fruits" button anymore.)
  els.btnPause.addEventListener('click', () => {
    if (!engine) return;
    const s = engine.state;
    const introPausable = s === ENGINE_STATES.ROUND_READY && intro.state !== INTRO_STATES.IDLE;
    if (s === ENGINE_STATES.PLAYING || introPausable) {
      engine.pause('user'); // also freezes a running introduction
      audioManager.play('pause'); // ui bus: audible even after suspending gameplay
      audioManager.setSuspended(true);
      clearGesture();
      clearTransientFx();
      processEngineEvents();
    }
  });
  els.btnResume.addEventListener('click', () => {
    if (engine && engine.state === ENGINE_STATES.PAUSED) {
      audioManager.setSuspended(false);
      audioManager.play('resume'); // deliberate player input only
      engine.resume();
      processEngineEvents();
    }
  });
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

  // Results actions. Retry Level and Level Map always restart/map; the
  // gold button is contextual — it only advances when progression rules
  // actually unlocked the next level.
  els.btnAgain.addEventListener('click', () => currentLevel && startGame(currentLevel));
  els.btnNextLevel.addEventListener('click', () => {
    if (nextLevelAction === 'next') {
      const next = currentLevel && nextLevel(currentLevel.id);
      if (next) {
        beginLevel(next);
        return;
      }
    }
    if (currentLevel) startGame(currentLevel);
    else openLevelsScreen();
  });
  els.btnMenu.addEventListener('click', quitToLevels);

  // Full mistake review overlay (opened from the compact summary).
  els.btnReviewAll.addEventListener('click', openReviewOverlay);
  els.btnReviewClose.addEventListener('click', closeReviewOverlay);
  els.rsReviewOverlay.addEventListener('pointerdown', (ev) => {
    if (ev.target === els.rsReviewOverlay) closeReviewOverlay(); // backdrop click
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeReviewOverlay();
  });

  els.playfield.addEventListener('pointerdown', onPointerDown);
  els.playfield.addEventListener('pointermove', onPointerMove);
  els.playfield.addEventListener('pointerup', onPointerEnd);
  els.playfield.addEventListener('pointercancel', onPointerEnd);
  els.playfield.addEventListener('lostpointercapture', onPointerEnd);

  // The card's center→slot flight finishing hands over to the launch.
  els.questionCard.addEventListener('transitionend', (ev) => {
    if (ev.target !== els.questionCard || ev.propertyName !== 'transform') return;
    if (intro.state === INTRO_STATES.FLIGHT && intro.settle() === 'settled') {
      attemptIntroLaunch();
    }
  });
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

  // Read-only debug/verification handle (mirrors window.wordSliceAudio):
  // lets automated tests inspect the live engine and drive presentation
  // steps in environments where rAF/timers are throttled. Never mutated
  // by the game itself.
  Object.defineProperty(window, '__wordSlice', {
    configurable: true,
    get() {
      return {
        engine,
        intro,
        appState: () => appState,
        currentLevel: () => currentLevel,
        progress: () => progress,
        refreshView,
        applyLayout,
        stepIntro,
        renderFrame,
        processEngineEvents,
      };
    },
  });

  loadLevelPack();
}

init();
