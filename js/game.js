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
import { JuiceFx } from './juice.js';
import { audioManager } from './audio.js';
import {
  assetManager,
  essentialStartupAssets,
} from './assets.js';

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
  loaderBar: $('loader-bar'),
  loaderBarFill: $('loader-bar-fill'),
  loaderPercent: $('loader-percent'),
  loaderNote: $('loader-note'),
  loaderFruitImg: document.querySelector('#loader-fruit img'),
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
  btnHudLevels: $('btn-hud-levels'),
  leaveOverlay: $('leave-confirm-overlay'),
  btnLeaveCancel: $('btn-leave-cancel'),
  btnLeaveConfirm: $('btn-leave-confirm'),
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
  fxCanvas: $('fx'),
  trailCanvas: $('trail'),
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
  rsReviewScroll: $('rs-review-scroll'),
  rsDetailStats: $('rs-detail-stats'),
  rsReviewList: $('rs-review-list'),
  btnReviewClose: $('btn-review-close'),
  btnNextLevel: $('btn-next-level'),
  btnNextLevelLabel: $('btn-next-level-label'),
  btnDetails: $('btn-details'),
  btnMenu: $('btn-menu'),
};

/* ------------------------------------------------------------------ */
/* Fruit sprites: whole + left/right cut halves with per-fruit juice  */
/* color and calibrated label layout.                                  */
/*                                                                     */
/* Image PATHS live in js/assets.js (FRUIT_IMAGE_PATHS) — the single   */
/* manifest, preloaded and decode-verified by the asset manager before */
/* any round may launch. This table keeps only the per-fruit render    */
/* calibration derived from assets/fruits/manifest.json:               */
/*   bodyFrac  — largest visible body axis ÷ canvas (resizes the box   */
/*               so every fruit body spans the engine's collision      */
/*               circle: consistent visual scale across shapes)        */
/*   labelX/Y  — anchor of the word label, nudged below stems/leaves   */
/*   maxTextWidth — label budget as a fraction of the canvas width     */
/* ------------------------------------------------------------------ */

const FRUIT_ASSETS = {
  watermelon: {
    juice: '#e5484d', scale: 1.06, bodyFrac: 0.656,
    labelX: 0.50, labelY: 0.505, maxTextWidth: 0.58,
  },
  apple: {
    juice: '#f2e8c9', scale: 1.05, bodyFrac: 0.676,
    labelX: 0.50, labelY: 0.53, maxTextWidth: 0.60,
  },
  orange: {
    juice: '#ffa53d', scale: 1.05, bodyFrac: 0.637,
    labelX: 0.50, labelY: 0.51, maxTextWidth: 0.59,
  },
  tomato: {
    juice: '#e8402f', scale: 1.05, bodyFrac: 0.684,
    labelX: 0.50, labelY: 0.535, maxTextWidth: 0.60,
  },
  peach: {
    juice: '#ffb98a', scale: 1.04, bodyFrac: 0.703,
    labelX: 0.495, labelY: 0.52, maxTextWidth: 0.65,
  },
  melon: {
    juice: '#ffc178', scale: 1.05, bodyFrac: 0.684,
    labelX: 0.50, labelY: 0.515, maxTextWidth: 0.63,
  },
  pomegranate: {
    juice: '#c0283c', scale: 1.05, bodyFrac: 0.715,
    labelX: 0.50, labelY: 0.53, maxTextWidth: 0.63,
  },
  lemon: {
    juice: '#ffd94d', scale: 1.05, bodyFrac: 0.711,
    labelX: 0.495, labelY: 0.525, maxTextWidth: 0.61,
  },
  plum: {
    juice: '#8e3a6b', scale: 1.04, bodyFrac: 0.738,
    labelX: 0.50, labelY: 0.53, maxTextWidth: 0.63,
  },
  coconut: {
    juice: '#f5eddc', scale: 1.06, bodyFrac: 0.633,
    labelX: 0.50, labelY: 0.505, maxTextWidth: 0.58,
  },
};

/**
 * appearanceId -> decoded { whole, left, right } Images, owned and
 * preloaded by the asset manager (js/assets.js). Gameplay is gated on
 * these being genuinely ready, so a fruit spawn or slice never waits on
 * the network — every fruit of the same type reuses these cached
 * decoded images.
 */
function fruitImagesOf(appearanceId) {
  return assetManager.fruitImages(appearanceId) || null;
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

/* Leave-level confirmation (HUD Levels shortcut during an unfinished
   round). Rides the app-overlay pause contract: opening it pauses the
   live round and suspends gameplay audio; Stay resumes the exact
   interrupted state; Leave Level discards the session through
   quitToLevels(), which records no result — earned stars, best scores,
   unlocks and achievements in storage are never touched. */
let leaveReturnFocus = null;

function openLeaveConfirm(fromEl) {
  leaveReturnFocus = activeElementOr(fromEl);
  openAppOverlay(els.leaveOverlay);
  els.btnLeaveCancel.focus({ preventScroll: true }); // the safe choice first
}

function closeLeaveConfirm() {
  closeAppOverlay(els.leaveOverlay); // Stay: resume the paused round
  if (leaveReturnFocus) {
    leaveReturnFocus.focus({ preventScroll: true });
    leaveReturnFocus = null;
  }
}

/* ------------------------------------------------------------------ */
/* Level data loading                                                  */
/* ------------------------------------------------------------------ */

let loadAttempt = 0;
/** Level-fetch units already banked (0..3) — feeds the loading bar. */
let levelLoadUnits = 0;

async function loadLevelPack() {
  const attempt = ++loadAttempt;
  levelLoadUnits = 0;
  setScreen('loading');
  updateLoaderProgress();
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
      levelLoadUnits += 1; // real per-file progress for the loading bar
      updateLoaderProgress();
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
    maybeAutoStart(); // straight into gameplay — never before assets are ready
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

/**
 * Level data alone is never enough to start: rounds may only launch when
 * the essential fruit sprites are decoded and cached (the asset manager
 * gates this), so no fruit ever flies as a placeholder ball.
 */
function maybeAutoStart() {
  if (assetManager.isEssentialReady()) autoStartSession();
}

/* ------------------------------------------------------------------ */
/* Startup orchestration: loading screen with REAL progress           */
/* ------------------------------------------------------------------ */

/** The loading bar counts essential images + the three level files. */
const LEVEL_FETCH_UNITS = 3;
/** Startup run ticket — a Retry supersedes any still-running attempt. */
let startupRun = 0;

/**
 * Paints the loading bar from the ACTUAL state of loadable work: decoded
 * essential images + parsed level files. No timers, no simulated fill.
 */
function updateLoaderProgress() {
  const assets = assetManager.getProgress();
  const total = assets.total + LEVEL_FETCH_UNITS;
  const loaded = assets.loaded + levelLoadUnits;
  const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  if (els.loaderBar) {
    els.loaderBarFill.style.width = `${pct}%`;
    els.loaderBar.setAttribute('aria-valuenow', String(pct));
  }
  if (els.loaderPercent) els.loaderPercent.textContent = `Loading assets… ${pct}%`;
}

/**
 * Loads everything a first session needs — level data AND the essential
 * fruit/background/question-card images — in parallel, then (and only
 * then) starts gameplay. A failure shows the error screen with a Retry
 * that reloads only what is missing; successfully decoded assets are
 * never downloaded again.
 */
async function startup() {
  const run = ++startupRun;
  levelLoadUnits = 0;
  setScreen('loading');
  if (els.loaderFruitImg) {
    // Same versioned URL the manager preloads — one shared cache entry,
    // so the decorative loader fruit costs no extra request.
    const fruitSrc = assetManager.getPath('watermelon', 'whole');
    if (els.loaderFruitImg.getAttribute('src') !== fruitSrc) {
      els.loaderFruitImg.src = fruitSrc;
    }
  }
  updateLoaderProgress(); // honest 0% baseline before anything lands

  // Essential images for THIS viewport (the orientation-matching
  // background only — the other variant is never fetched).
  assetManager.registerEssentialImages(essentialStartupAssets());

  const levelsDone = loadLevelPack().then(() => true, () => false); // its errors show the error screen
  let result;
  try {
    result = await assetManager.loadEssentialAssets({ onProgress: updateLoaderProgress });
  } catch {
    result = { ok: false, failed: assetManager.getFailedAssets() };
  }
  await levelsDone;
  if (run !== startupRun) return; // superseded by a newer Retry

  if (!result.ok) {
    els.errorText.textContent =
      'Some game images couldn\u2019t load. Check your connection, then retry.';
    setScreen('error');
    return;
  }
  if (!levelQuestions) return; // loadLevelPack already showed the error screen
  if (appState === 'LOADING') autoStartSession(); // maybeAutoStart may have raced ahead
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
    img: assetManager.getPath('watermelon', 'whole'),
    text: 'Every round shows a challenge on the parchment banner, like "Slice the fruits.".',
  },
  {
    practice: true,
    title: '2 · Slice the matching fruit',
    fruit: 'apple',
    fruitImg: assetManager.getPath('apple', 'whole'),
    cutLeftImg: assetManager.getPath('apple', 'left'),
    cutRightImg: assetManager.getPath('apple', 'right'),
    text: 'Drag across the fruit carrying a word that matches. Try it: swipe through this apple!',
  },
  {
    title: '3 · Leave other fruits alone',
    img: assetManager.getPath('tomato', 'whole'),
    label: 'table',
    text: 'This tomato says "table" — not a fruit. Slicing wrong words costs a heart, so let it fly by.',
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
    // The two real cut halves, hidden until the practice swipe lands.
    const halves = ['Left', 'Right'].map((side) => {
      const half = document.createElement('img');
      half.className = `demo-half is-${side.toLowerCase()}`;
      half.src = step[`cut${side}Img`];
      half.alt = '';
      half.draggable = false;
      demo.append(half);
      return half;
    });
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
        // Same presentation swap as a real slice: the whole apple hides and
        // its two cut halves fly apart along the swipe.
        demo.classList.add('is-cut');
        label.remove();
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
    // Cut halves are presentation-only, but they share the engine's clock:
    // frozen while paused/hidden, never advanced by stale wall time.
    if (!screens.game.hidden) stepCutPieces(dt);
  }
  stepIntro(dt);
  processEngineEvents();
  renderFrame(dt);
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
    || !els.confirmOverlay.hidden || !els.tutorialOverlay.hidden
    || !els.leaveOverlay.hidden;
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
  lastWaveText = '';
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
  lastWaveText = waves > 1 ? `Wave 1 of ${waves}` : '';
  els.questionWave.textContent = lastWaveText;
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

/** fruitId -> {root, img, label, x, y, vx, vy, rotation, appearanceId}; ACTIVE fruits only. */
const fruitEls = new Map();
/** Terminal fruit ids -> {kind, dirX, dirY} for the death animation. */
const deathDetails = new Map();
/** [{el, until}] DOM cleanup list processed each frame (no timers). */
let dyingFruits = [];
let floatNotes = [];
/**
 * Live cut-half fragments: {el, x, y, vx, vy, rotation, spin, age, lifetime,
 * w, h}. Two per sliced fruit, each with independent motion, integrated by
 * stepCutPieces() inside the single animation loop (never per-piece timers).
 */
let cutPieces = [];
/** Hard ceiling for simultaneous cut halves (oldest dropped first). */
const MAX_CUT_PIECES = 24;
/** A cut half lives at most this many simulated seconds before fading out. */
const CUT_PIECE_LIFETIME = 1.9;
/** Live swipe blades ({points: [{x, y, t}], active}), newest last. Each
 *  gesture is its own blade so rapid repeated swipes never visually
 *  connect; blades fade and expire by age inside renderTrail(). */
let blades = [];
/** Tiny streak sparks shed by fast slashes (pooled, canvas-drawn). */
let bladeSparks = [];
/** Last swipe segment direction (unit vector) for slice FX bias. */
let lastSliceDir = { x: 1, y: 0 };
/** Recent swipe speed (px/ms) and the timestamp of the last pointer move —
 *  a fast slash scales the juice up (bounded inside js/juice.js). */
let lastSliceSpeed = 0;
let lastMoveAt = 0;

/**
 * Each fruit canvas carries transparent padding around the body, so the
 * box scales from the engine's collision radius divided by bodyFrac (the
 * body's largest axis ÷ canvas): every fruit's VISIBLE body then spans
 * radius × 2 × scale pixels, keeping visual scale consistent across
 * shapes. The circle itself always comes from the engine and is never
 * inflated here.
 */
function spriteBoxFor(fruit) {
  const art = FRUIT_ASSETS[fruit.appearanceId];
  const images = fruitImagesOf(fruit.appearanceId);
  const whole = images && images.whole;
  const aspect = whole && whole.naturalWidth > 0 ? whole.naturalHeight / whole.naturalWidth : 1;
  const bodyFrac = art && art.bodyFrac > 0 ? art.bodyFrac : 0.66;
  const scale = art && Number.isFinite(art.scale) ? art.scale : 1.05;
  const w = Math.round(fruit.radius * 2 * scale / bodyFrac);
  const h = Math.round(w * aspect);
  return { w, h };
}

function renderFrame(frameDt = 0) {
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
    // Per-frame motion estimate feeds the cut halves' inherited velocity.
    // Sane frame gaps only: throttled hidden-tab frames would produce a
    // wild estimate, so the last good velocity is kept instead.
    if (frameDt > 0 && frameDt <= 0.2) {
      entry.vx = (fruit.x - entry.x) / frameDt;
      entry.vy = (fruit.y - entry.y) / frameDt;
    }
    entry.x = fruit.x;
    entry.y = fruit.y;
    entry.rotation = fruit.rotation;
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

  renderTrail(frameDt);
  renderJuiceFx(frameDt);
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
  // stay on the fruit body instead of spilling past its silhouette. The
  // per-fruit layout anchor keeps the word centered on the visible body
  // (stems and leaves push the anchor down where needed).
  const art = FRUIT_ASSETS[fruit.appearanceId];
  const base = Math.max(13, fruit.radius * 0.44);
  const chars = Math.max(2, fruit.optionText.length);
  const maxTextWidth = art && art.maxTextWidth > 0 ? art.maxTextWidth : 0.6;
  const fit = (w * maxTextWidth) / (0.62 * chars); // bold ≈ 0.62em per char
  root.style.fontSize = `${Math.max(11, Math.round(Math.min(base, fit)))}px`;
  root.style.setProperty('--lx', `${((art && art.labelX != null ? art.labelX : 0.5) * 100).toFixed(1)}%`);
  root.style.setProperty('--ly', `${((art && art.labelY != null ? art.labelY : 0.52) * 100).toFixed(1)}%`);
  root.append(img, fallback, label);
  els.fruitsLayer.append(root);
  return { root, img, w, h, x: fruit.x, y: fruit.y, vx: 0, vy: 0, rotation: fruit.rotation, appearanceId: fruit.appearanceId, artState: 'pending' };
}

/**
 * Shows the whole-fruit PNG. Startup gating (js/assets.js + startup())
 * guarantees the decoded sprite is already cached, so this resolves on
 * the fruit's first rendered frame; the pending → image upgrade path is
 * kept as a defensive in-place upgrade for any late arrival. A late load
 * re-boxes the element to the sprite's true aspect ratio (renderFrame
 * re-centers from entry.w/h).
 */
function syncFruitSprite(fruit, entry) {
  if (entry.artState !== 'pending') return;
  const whole = assetManager.getFruit(fruit.appearanceId, 'whole');
  if (!whole || !whole.complete) return; // still in flight (defensive)
  if (whole.naturalWidth > 0) {
    entry.artState = 'image';
    const box = spriteBoxFor(fruit); // aspect is now known
    entry.w = box.w;
    entry.h = box.h;
    entry.root.style.width = `${box.w}px`;
    entry.root.style.height = `${box.h}px`;
    entry.img.src = assetManager.getPath(fruit.appearanceId, 'whole');
    entry.root.classList.add('has-img');
  } else {
    entry.artState = 'fallback'; // genuinely missing — keep the placeholder
  }
}

function startDeathAnimation(fruitId, entry) {
  const detail = deathDetails.get(fruitId) || { kind: 'miss', dirX: 1, dirY: 0 };
  deathDetails.delete(fruitId);
  const { kind, dirX, dirY } = detail;

  if (kind === 'miss') {
    entry.root.classList.add('dying', 'dying-miss');
    dyingFruits.push({ el: entry.root, until: performance.now() + 560 });
    return;
  }

  // Sliced: the whole sprite and its word vanish the instant the two real
  // cut halves take over from the same position and rotation.
  const spawned = spawnCutPieces(entry, dirX, dirY);
  if (spawned || prefersReducedMotion) {
    entry.root.remove();
  } else {
    // Cut art unavailable: keep the whole fruit visible and fade it out
    // instead of leaving an empty gap where the fruit used to be.
    entry.root.classList.add('dying', 'dying-hit', 'no-cut');
    dyingFruits.push({ el: entry.root, until: performance.now() + 560 });
  }
  spawnJuiceBurst(entry.x, entry.y, entry.appearanceId, dirX, dirY, entry.w, detail.speedPxMs || 0);
}

/**
 * Creates the two independently animated cut halves of a sliced fruit.
 * Both half canvases are registered on the same 256×256 grid as the whole
 * fruit (see assets/fruits/manifest.json), so drawing them in the whole
 * fruit's exact box reproduces the intact fruit at t=0 and the split reads
 * as one continuous object. Returns true when both halves were created.
 */
function spawnCutPieces(entry, dirX, dirY) {
  if (prefersReducedMotion) return true; // separation still instant, just still
  const art = FRUIT_ASSETS[entry.appearanceId];
  const images = fruitImagesOf(entry.appearanceId);
  const ready = (img) => !!(img && img.complete && img.naturalWidth > 0);
  if (!art || !ready(images && images.left) || !ready(images && images.right)) return false;

  // Separation axis: perpendicular of the actual swipe, damped toward the
  // artwork's vertical cut plane so the halves read as left/right pieces
  // whatever angle the blade crossed at.
  let sx = -dirY;
  let sy = dirX * 0.55;
  const len = Math.hypot(sx, sy) || 1;
  sx /= len;
  sy /= len;
  if (sx > 0) { sx = -sx; sy = -sy; } // the left half always departs toward -x

  const impulse = Math.max(110, entry.w * 0.75); // separation speed, px/s
  const kick = 24 + entry.h * 0.16;              // small upward energy at the cut
  const gravity = engine && engine.playfield.h > 0
    ? Math.max(520, engine.playfield.h * 0.95)
    : 650;
  const inheritX = Number.isFinite(entry.vx) ? entry.vx : 0;
  const inheritY = Number.isFinite(entry.vy) ? entry.vy : 0;

  for (const side of ['left', 'right']) {
    const sign = side === 'left' ? 1 : -1;
    const el = document.createElement('img');
    el.className = 'fruit-piece';
    el.src = assetManager.getPath(entry.appearanceId, side);
    el.alt = '';
    el.draggable = false;
    el.style.width = `${entry.w}px`;
    el.style.height = `${entry.h}px`;
    el.style.transform =
      `translate(${entry.x - entry.w / 2}px, ${entry.y - entry.h / 2}px) rotate(${entry.rotation || 0}deg)`;
    els.fruitsLayer.append(el);
    while (cutPieces.length >= MAX_CUT_PIECES) cutPieces.shift().el.remove();
    cutPieces.push({
      el,
      x: entry.x,
      y: entry.y,
      vx: inheritX + sign * sx * impulse,
      vy: inheritY + sign * sy * impulse - kick,
      rotation: entry.rotation || 0,
      // Left half rolls slightly counterclockwise, right half clockwise.
      spin: (side === 'left' ? -1 : 1) * (70 + Math.random() * 60),
      age: 0,
      lifetime: CUT_PIECE_LIFETIME,
      w: entry.w,
      h: entry.h,
    });
  }
  return true;
}

/**
 * Time-based motion for the cut halves: inherited velocity + separation
 * impulse, independent rotation, shared gravity, age-bounded lifetime with
 * a short end fade, and removal once a piece leaves the board. Runs inside
 * the single rAF loop only while the engine is PLAYING — gravity freezes
 * with the game, and pieces never outlive the playfield.
 */
function stepCutPieces(dt) {
  if (cutPieces.length === 0) return;
  // Clamp throttled/stalled frames (hidden tab, occluded webview): the
  // watchdog may drive the loop at ~1 fps, and an unclamped second would
  // teleport the halves instead of letting them fall.
  const step = Math.min(Math.max(dt, 0), 0.06);
  const gravity = engine && engine.playfield.h > 0
    ? Math.max(520, engine.playfield.h * 0.95)
    : 650;
  const bottom = engine ? engine.playfield.h : 800;
  cutPieces = cutPieces.filter((p) => {
    p.age += step;
    p.vy += gravity * step;
    p.x += p.vx * step;
    p.y += p.vy * step;
    p.rotation += p.spin * step;
    if (p.age >= p.lifetime || p.y - p.h > bottom + 40) {
      p.el.remove();
      return false;
    }
    const fade = Math.min(1, (p.lifetime - p.age) / 0.3);
    p.el.style.opacity = fade < 1 ? fade.toFixed(2) : '1';
    p.el.style.transform =
      `translate(${p.x - p.w / 2}px, ${p.y - p.h / 2}px) rotate(${p.rotation.toFixed(1)}deg)`;
    return true;
  });
}

/** Removes every live cut half (screen switch, restart, level change). */
function clearCutPieces() {
  for (const p of cutPieces) p.el.remove();
  cutPieces = [];
}

/** Decoration ceiling: float notes are pruned by age after ~1 s, but a
    rapid multi-fruit swipe could otherwise stack dozens of them at once
    on low-power devices. The oldest note is dropped first. (Juice bursts
    live on the #fx canvas with their own hard caps — see js/juice.js.) */
const MAX_FLOAT_NOTES = 24;

/* ------------------------------------------------------------------ */
/* Juice FX — organic splash + droplets on the #fx canvas.              */
/*                                                                     */
/* One JuiceFx instance owns every live burst (capped groups, capped    */
/* droplets, mobile budget). It is stepped and painted from the single  */
/* rAF loop via renderJuiceFx(): while the engine is paused the juice   */
/* freezes with the rest of the scene, and expired effects are dropped  */
/* inside step(). No DOM nodes, no timers, no blur filters.             */
/* ------------------------------------------------------------------ */

/** The juice system; created lazily so the mobile budget can read the
 *  actual pointer type at first slice instead of at script load. */
let juiceFx = null;
/** #fx canvas 2D context, fetched once on first use. */
let fxCtx = null;
/** True while the canvas may hold pixels — skips redundant clears. */
let fxCanvasDirty = false;

function fxContext() {
  if (fxCtx === null && els.fxCanvas && els.fxCanvas.getContext) {
    fxCtx = els.fxCanvas.getContext('2d');
  }
  return fxCtx;
}

/** Sizes the juice canvas to the playfield. DPR-aware and capped at 2×
 *  (same policy as the trail canvas). A fresh backing store is
 *  transparent, so this also wipes any stale juice. */
function fitFxCanvas(w, h) {
  const canvas = els.fxCanvas;
  if (!canvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  const ctx = fxContext();
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fxCanvasDirty = false;
}

function clearFxCanvas() {
  const ctx = fxContext();
  if (!ctx || !fxCanvasDirty) return;
  ctx.clearRect(0, 0, els.fxCanvas.width, els.fxCanvas.height);
  fxCanvasDirty = false;
}

/** Juice burst for one confirmed slice: the fruit's own juice color, the
 *  swipe direction/speed, and a playfield-scaled droplet gravity so the
 *  arc matches the falling cut halves. */
function spawnJuiceBurst(x, y, appearanceId, dirX, dirY, size, speedPxMs) {
  const files = FRUIT_ASSETS[appearanceId];
  if (!files || prefersReducedMotion) return;
  if (!juiceFx) {
    const coarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    juiceFx = new JuiceFx({ mobile: coarsePointer || window.innerWidth < 640 });
  }
  juiceFx.spawn(x, y, {
    size,
    juice: files.juice,
    dirX,
    dirY,
    speedPxMs,
    gravity: engine && engine.playfield.h > 0
      ? Math.max(420, engine.playfield.h * 0.75)
      : 700,
  });
}

/**
 * Steps (only while the engine is PLAYING — pausing freezes the juice
 * with the cut halves) and repaints the live bursts. With nothing live
 * the canvas is cleared once and the frame costs nothing.
 */
function renderJuiceFx(dtSeconds) {
  if (!juiceFx || juiceFx.count === 0) {
    clearFxCanvas();
    return;
  }
  if (engine && engine.state === ENGINE_STATES.PLAYING) {
    juiceFx.step(dtSeconds); // clamps stalled-frame deltas internally
  }
  const ctx = fxContext();
  if (!ctx) return;
  if (juiceFx.count === 0) {
    clearFxCanvas();
    return;
  }
  clearFxCanvas();
  juiceFx.draw(ctx);
  fxCanvasDirty = true;
}

/** Removes every live juice burst (screen switch, restart, level change). */
function clearJuiceFx() {
  if (juiceFx) juiceFx.clear();
  clearFxCanvas();
}

function addFloatNote(x, y, text, kind) {
  while (floatNotes.length >= MAX_FLOAT_NOTES) {
    floatNotes.shift().el.remove();
  }
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
}

/**
 * Clears input-driven transient effects (swipe trail, floating notes).
 * Used when pausing, hiding the tab, opening an overlay, and when a round
 * or session ends. Juice bursts are intentionally NOT cleared here: the
 * engine pause already freezes them, and full resets go through
 * clearJuiceFx() so pause/resume can freeze and continue them correctly.
 * Resolution animations (dying fruits) always run to completion and are
 * pruned by pruneDecorations().
 */
function clearTransientFx() {
  blades = [];
  bladeSparks = [];
  clearTrailCanvas();
  for (const item of floatNotes) item.el.remove();
  floatNotes = [];
}

/**
 * Drops resolved fruit visuals when leaving the game screen (feedback,
 * results). Without this, stale entries in fruitEls would replay their
 * death animations on screen when the next round becomes visible, and
 * mid-flight cut halves would come back frozen on the next screen.
 */
function clearFruitVisuals() {
  for (const entry of fruitEls.values()) entry.root.remove();
  fruitEls.clear();
  deathDetails.clear();
  clearCutPieces();
  clearJuiceFx();
}

/* ------------------------------------------------------------------ */
/* Blade trail — a canvas-drawn slash, not a stroked line.             */
/*                                                                     */
/* Each frame the live gesture samples are Catmull-Rom resampled into  */
/* a smooth centerline, then rendered as filled polygons whose width   */
/* follows a blade profile: a sharp rise behind the leading tip, a     */
/* slim body and a long taper to the tail. Three stacked widths        */
/* (cyan halo → icy sheen → white core) fake a glow without any blur   */
/* filter, which keeps mobile GPUs happy. Everything lives in one      */
/* canvas, cleared and repainted only while anything is visible.       */
/* ------------------------------------------------------------------ */

/** Sample lifetime: oldest points die first, so the trail shortens from
 *  the tail toward the tip while the swipe is held still or released. */
const BLADE_SAMPLE_MS = 260;
const BLADE_MAX_POINTS = 40;   // per-blade sample ceiling
const BLADE_MAX_ACTIVE = 3;    // simultaneous fading blades (rapid swipes)
const BLADE_IDLE_FADE_MS = 70; // grace before a released blade fades
const BLADE_FADE_MS = 170;     // released-blade fade duration
const BLADE_MAX_SAMPLES = 64;  // resampled centerline ceiling (cost bound)
const SPARK_MAX = 18;
const SPARK_MIN_SPEED = 1.0;   // px/ms a slash must reach to shed sparks

/** Glow layers, painted outermost first: {widthScale, fill}. widthScale
 *  multiplies the blade profile's half-width for that layer. */
const BLADE_LAYERS = [
  { widthScale: 2.2, fill: 'rgba(125, 205, 255, 0.20)' },  // soft cyan halo
  { widthScale: 1.35, fill: 'rgba(208, 238, 255, 0.50)' }, // icy sheen
  { widthScale: 0.62, fill: 'rgba(255, 255, 255, 0.97)' }, // bright core
];

/** Canvas 2D context, fetched once on first use. */
let trailCtx = null;
/** True while the canvas may hold pixels — skips redundant clears. */
let trailCanvasDirty = false;

function trailContext() {
  if (trailCtx === null && els.trailCanvas && els.trailCanvas.getContext) {
    trailCtx = els.trailCanvas.getContext('2d');
  }
  return trailCtx;
}

/** Sizes the trail canvas to the playfield. DPR-aware and capped at 2×
 *  so high-density phones never quadruple the fill cost. A fresh backing
 *  store is transparent, so this also wipes any stale trail. */
function fitTrailCanvas(w, h) {
  const canvas = els.trailCanvas;
  if (!canvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  const ctx = trailContext();
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  trailCanvasDirty = false;
}

function clearTrailCanvas() {
  const ctx = trailContext();
  if (!ctx || !trailCanvasDirty) return;
  ctx.clearRect(0, 0, els.trailCanvas.width, els.trailCanvas.height);
  trailCanvasDirty = false;
}

/** Begins a new blade at the swipe's exact start point (pointerdown). */
function startBlade(x, y) {
  const now = performance.now();
  blades = blades.filter(
    (b) => b.points.length > 0 && now - b.points[b.points.length - 1].t < BLADE_SAMPLE_MS,
  );
  if (blades.length >= BLADE_MAX_ACTIVE) blades.shift();
  blades.push({ points: [{ x, y, t: now }], active: true });
}

/** Appends a sample to the active blade (the newest blade still tied to
 *  a pressed pointer). Samples of released blades are dropped. */
function pushTrailPoint(x, y) {
  const blade = blades[blades.length - 1];
  if (blade && blade.active) blade.points.push({ x, y, t: performance.now() });
}

/** Marks every blade as released so each fades out instead of lingering. */
function releaseBlades() {
  for (const blade of blades) blade.active = false;
}

/** Recent pointer speed in px/ms (last few samples) — drives the blade's
 *  girth and spark shedding so fast slashes look heavier than slow ones. */
function bladeSpeed(blade) {
  const pts = blade.points;
  if (pts.length < 2) return 0;
  const a = pts[Math.max(0, pts.length - 4)];
  const b = pts[pts.length - 1];
  const dt = b.t - a.t;
  return dt > 0 ? Math.hypot(b.x - a.x, b.y - a.y) / dt : 0;
}

/** Width profile along the blade. f runs 0 (tail sample) → 1 (newest
 *  sample): the body holds a full-width plateau with a long power-curve
 *  taper to the tail, while needle() collapses the width over an ABSOLUTE
 *  distance (≈ 2.2 × max width) from the tip — so short flicks and long
 *  slashes both end in a crisp knife point instead of a blunt ramp. */
function bladeWidthAt(f, fromTip, maxW) {
  const BODY_START = 0.45;
  const body = f >= BODY_START
    ? 1
    : 1 - Math.pow((BODY_START - f) / BODY_START, 1.25);
  const needle = Math.pow(Math.min(1, fromTip / (maxW * 2.2)), 1.35);
  return body * needle;
}

/** Catmull-Rom resample of a blade's live samples into ~step-px points,
 *  oldest → newest. Smooths pointer jitter into an elegant curve and
 *  bounds the polygon cost regardless of how many move events fired. */
function resampleBlade(points, step) {
  const out = [];
  const n = points.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(n - 1, i + 2)];
    const divisions = Math.max(1, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / step));
    // The newest segment stops short of its end point: the pointed tip
    // vertex (extended past the last sample below) closes the polygon.
    const limit = i === n - 2 ? divisions - 1 : divisions;
    for (let j = 0; j <= limit; j++) {
      const t = j / divisions;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t
          + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2
          + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t
          + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2
          + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  return out;
}

/** Additive glow at the leading point — makes the motion direction
 *  obvious and gives a held-still touch an instant soft dot. */
function drawTipGlow(ctx, x, y, radius, env) {
  if (env <= 0) return;
  ctx.globalCompositeOperation = 'lighter';
  const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
  grad.addColorStop(0, `rgba(255, 255, 255, ${(0.55 * env).toFixed(3)})`);
  grad.addColorStop(0.35, `rgba(185, 228, 255, ${(0.22 * env).toFixed(3)})`);
  grad.addColorStop(1, 'rgba(185, 228, 255, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  ctx.globalCompositeOperation = 'source-over';
}

/** Paints one blade: three tapered polygon fills + a tip highlight, and
 *  sheds streak sparks on fast slashes. Returns nothing; visibility is
 *  handled by renderTrail(). */
function drawBlade(ctx, blade, now) {
  const pts = blade.points;
  const last = pts[pts.length - 1];
  const sinceLast = now - last.t;
  const env = blade.active
    ? 1
    : Math.max(0, 1 - (sinceLast - BLADE_IDLE_FADE_MS) / BLADE_FADE_MS);
  if (env <= 0) return;

  // Just touched (or all middle samples expired): a soft dot appears
  // instantly under the pointer, then grows into a slash as it moves.
  if (pts.length < 2) {
    drawTipGlow(ctx, last.x, last.y, 16, env);
    return;
  }

  const speed = bladeSpeed(blade);
  const maxW = Math.min(20, 10 + speed * 3.4); // speed-reactive girth

  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  const samples = resampleBlade(pts, Math.max(7, total / (BLADE_MAX_SAMPLES - 1)));
  const m = samples.length;
  if (m < 2) {
    drawTipGlow(ctx, last.x, last.y, 16, env);
    return;
  }

  // Leading direction and the pointed tip vertex, extended slightly past
  // the newest sample so the blade reads as cutting ahead of the finger.
  const tip = samples[m - 1];
  const before = samples[m - 2];
  let dx = tip.x - before.x;
  let dy = tip.y - before.y;
  const dl = Math.hypot(dx, dy) || 1;
  dx /= dl;
  dy /= dl;
  const tipX = tip.x + dx * maxW * 0.7;
  const tipY = tip.y + dy * maxW * 0.7;

  // Centerline + per-sample half-widths and normals, computed once and
  // reused by every glow layer.
  const spine = new Array(m);
  const stepLen = total / Math.max(1, m - 1); // ≈ uniform spacing after resampling
  for (let i = 0; i < m; i++) {
    const a = samples[Math.max(0, i - 1)];
    const b = samples[Math.min(m - 1, i + 1)];
    let tx = b.x - a.x;
    let ty = b.y - a.y;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    // f: 0 at the tail sample → 1 at the newest; fromTip: arc px to the tip.
    spine[i] = {
      x: samples[i].x,
      y: samples[i].y,
      nx: -ty,
      ny: tx,
      w: maxW * bladeWidthAt(i / (m - 1), (m - 1 - i) * stepLen, maxW),
    };
  }

  ctx.globalAlpha = env;
  for (const layer of BLADE_LAYERS) {
    const hw = layer.widthScale / 2;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    for (let i = m - 1; i >= 0; i--) { // left edge, newest → oldest
      const s = spine[i];
      ctx.lineTo(s.x + s.nx * s.w * hw, s.y + s.ny * s.w * hw);
    }
    for (let i = 0; i < m; i++) { // right edge, oldest → newest
      const s = spine[i];
      ctx.lineTo(s.x - s.nx * s.w * hw, s.y - s.ny * s.w * hw);
    }
    ctx.closePath();
    ctx.fillStyle = layer.fill;
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  drawTipGlow(ctx, tipX, tipY, maxW * 1.6, env);

  // Fast slashes shed a few short-lived streaks off the blade tip.
  if (blade.active && speed > SPARK_MIN_SPEED && !prefersReducedMotion
    && bladeSparks.length < SPARK_MAX && Math.random() < 0.5) {
    const spread = (Math.random() - 0.5) * 0.8;
    const back = 0.35 + Math.random() * 0.4; // ejection speed vs swipe speed
    bladeSparks.push({
      x: tipX,
      y: tipY,
      vx: (-dx * back - dy * spread) * speed * 0.5,
      vy: (-dy * back + dx * spread) * speed * 0.5,
      t: now,
      life: 140 + Math.random() * 160,
    });
  }
}

/** Advances and paints spark streaks; prunes expired ones in place. */
function drawBladeSparks(ctx, dtSeconds, now) {
  if (!bladeSparks.length) return;
  const dtMs = Math.min(64, dtSeconds * 1000 || 16); // clamp stale frames
  const surviving = [];
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineWidth = 1.8;
  for (const sp of bladeSparks) {
    const age = now - sp.t;
    if (age >= sp.life) continue;
    sp.x += sp.vx * dtMs;
    sp.y += sp.vy * dtMs;
    const f = 1 - age / sp.life;
    ctx.strokeStyle = `rgba(235, 248, 255, ${(0.75 * f * f).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(sp.x, sp.y);
    ctx.lineTo(sp.x - sp.vx * 34, sp.y - sp.vy * 34);
    ctx.stroke();
    surviving.push(sp);
  }
  ctx.globalCompositeOperation = 'source-over';
  bladeSparks = surviving;
}

function renderTrail(dtSeconds = 0) {
  const ctx = trailContext();
  if (!ctx) return;
  const now = performance.now();
  for (const blade of blades) {
    blade.points = blade.points.filter((p) => now - p.t < BLADE_SAMPLE_MS);
  }
  blades = blades.filter(
    (b) => b.points.length > 0 && now - b.points[b.points.length - 1].t < BLADE_SAMPLE_MS,
  );
  if (!blades.length && !bladeSparks.length) {
    clearTrailCanvas();
    return;
  }
  clearTrailCanvas();
  for (const blade of blades) drawBlade(ctx, blade, now);
  drawBladeSparks(ctx, dtSeconds, now);
  trailCanvasDirty = true;
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

/** Cached HUD strings — textContent/attr writes happen only on change, so a
    60 fps renderHud performs essentially zero DOM writes between events. */
let lastLevelOrder = 0;
let lastRoundText = '';
let lastLessonPercent = -1;
let lastComboText = '';
let lastTimerText = '';
let lastPromptText = '';
let lastWaveText = '';

function renderHud() {
  if (!engine) return;
  const hud = engine.getHudState();
  if (currentLevel && currentLevel.order !== lastLevelOrder) {
    lastLevelOrder = currentLevel.order;
    els.hudLevelValue.textContent = String(currentLevel.order);
  }
  const roundText = `${hud.questionNumber}/${hud.questionTotal}`;
  if (roundText !== lastRoundText) {
    lastRoundText = roundText;
    els.hudRoundValue.textContent = roundText;
  }
  const lessonPercent = hud.questionTotal > 0
    ? Math.round((hud.questionNumber / hud.questionTotal) * 100)
    : 0;
  if (lessonPercent !== lastLessonPercent) {
    lastLessonPercent = lessonPercent;
    els.hudProgressFill.style.width = `${lessonPercent}%`;
    els.hudProgressTrack.setAttribute('aria-valuenow', String(lessonPercent));
  }
  if (hud.score !== lastScore) {
    els.hudScoreValue.textContent = `${hud.score}`;
    if (lastScore >= 0 && hud.score > lastScore) retriggerAnimation(els.hudScore, 'is-bumped');
    lastScore = hud.score;
  }
  const comboText = hud.streak > 0 ? `${hud.streak} ×${hud.multiplier}` : '—';
  if (comboText !== lastComboText) {
    lastComboText = comboText;
    els.hudComboValue.textContent = comboText;
  }
  els.hudCombo.classList.toggle('is-hot', hud.multiplier > 1);
  if (hud.multiplier !== lastMultiplier) {
    if (lastMultiplier >= 0 && hud.multiplier > lastMultiplier) {
      retriggerAnimation(els.hudCombo, 'is-flare');
    }
    lastMultiplier = hud.multiplier;
  }
  const timerText = formatTime(hud.elapsed);
  if (timerText !== lastTimerText) {
    lastTimerText = timerText;
    els.hudTimerValue.textContent = timerText;
  }
  const heartsKey = `${hud.hearts}/${hud.maxHearts}`;
  if (heartsKey !== lastHeartsKey) {
    lastHeartsKey = heartsKey;
    let hearts = '';
    for (let i = 0; i < hud.maxHearts; i++) hearts += heartIcon(i < hud.hearts);
    els.hudHearts.innerHTML = hearts;
    els.hudHearts.setAttribute('aria-label', `Hearts ${hud.hearts} of ${hud.maxHearts}`);
  }
  if (hud.prompt !== lastPromptText) {
    lastPromptText = hud.prompt;
    els.questionPrompt.textContent = hud.prompt;
  }
  const waveText = hud.wave ? `Wave ${hud.wave.current} of ${hud.wave.total}` : '';
  if (waveText !== lastWaveText) {
    lastWaveText = waveText;
    els.questionWave.textContent = waveText;
  }
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
        deathDetails.set(event.fruitId, {
          kind: 'hit',
          dirX: lastSliceDir.x,
          dirY: lastSliceDir.y,
          speedPxMs: lastSliceSpeed,
        });
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
        deathDetails.set(event.fruitId, {
          kind: 'hit',
          dirX: lastSliceDir.x,
          dirY: lastSliceDir.y,
          speedPxMs: lastSliceSpeed,
        });
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

/** The session's statistics rows shared by the compact summary and the
    full Session Details overlay. Values come straight from the engine
    report; the four `essential` rows are the ones the compact mobile
    summary keeps (the rest move to the details view via CSS). */
function rsStatRows(report) {
  const percent = (value) => (value === null ? '—' : `${Math.round(value * 100)}%`);
  const errorTone = (count) => (count > 0 ? 'is-error' : 'is-plain');
  return [
    ['score', 'Final Score', `${report.score}`, 'is-positive is-score', true],
    ['rounds', 'Successful Rounds', `${report.successfulRounds}/${report.totalRounds}`, 'is-positive', true],
    ['completed', 'Completed Rounds', `${report.completedRounds}/${report.totalRounds}`, 'is-positive', false],
    ['correct', 'Correct Slices', `${report.correctSlices}`, 'is-positive', true],
    ['wrong', 'Wrong Slices', `${report.wrongSlices}`, errorTone(report.wrongSlices), false],
    ['missed', 'Missed Correct Targets', `${report.missedTargets}`, errorTone(report.missedTargets), false],
    ['avoided', 'Avoided Distractors', `${report.avoidedDistractors}`, 'is-positive', false],
    ['streak', 'Best Streak', `${report.bestStreak}`, 'is-positive', false],
    ['accuracy', 'Slice Accuracy', percent(report.accuracy), 'is-positive', true],
  ];
}

/** One statistics row: colored icon chip + dark-brown label + bold value. */
function rsStatRow(icon, label, value, tone, essential = false) {
  const row = document.createElement('div');
  row.className = 'rs-stat' + (essential ? ' is-essential' : '');
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

/* Session Details overlay state: the shown report feeds both the mistake
   list and the full statistics; switching views never loses data. */
let reviewMistakes = [];
let lastReport = null;
/** What the contextual gold button does for the shown result. */
let nextLevelAction = 'retry';

function openReviewOverlay() {
  if (!lastReport) return;
  // Full statistics block (all nine rows — nothing is dropped, the compact
  // summary only ever HID the secondary ones).
  els.rsDetailStats.replaceChildren();
  for (const [icon, label, value, tone] of rsStatRows(lastReport)) {
    els.rsDetailStats.append(rsStatRow(icon, label, value, tone));
  }
  // Every recorded mistake with the complete explanation text.
  els.rsReviewList.replaceChildren();
  if (reviewMistakes.length === 0) {
    const p = document.createElement('p');
    p.className = 'rs-review-perfect';
    p.textContent = 'Perfect! No mistakes this session.';
    els.rsReviewList.append(p);
  } else {
    const head = document.createElement('h3');
    head.className = 'rs-review-list-title';
    head.textContent = `All Mistakes (${reviewMistakes.length})`;
    els.rsReviewList.append(head);
    for (const [i, mistake] of reviewMistakes.entries()) {
      const card = rsMistakeCard(mistake);
      const num = document.createElement('span');
      num.className = 'rs-mistake-num';
      num.textContent = String(i + 1);
      card.querySelector('.rs-mistake-head').prepend(num);
      els.rsReviewList.append(card);
    }
  }
  els.rsReviewOverlay.hidden = false;
  els.rsReviewScroll.scrollTop = 0;
  els.btnReviewClose.focus({ preventScroll: true });
}

function closeReviewOverlay() {
  if (els.rsReviewOverlay.hidden) return;
  els.rsReviewOverlay.hidden = true;
  els.btnDetails.focus({ preventScroll: true });
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

  // Level Summary: every number comes straight from the engine report. The
  // compact mobile layout keeps only the four essential tiles (CSS); the
  // Session Details overlay always shows all nine.
  lastReport = report;
  els.rsStats.replaceChildren();
  for (const [icon, label, value, tone, essential] of rsStatRows(report)) {
    els.rsStats.append(rsStatRow(icon, label, value, tone, essential));
  }

  // Mistake Review: up to three compact previews on wide screens (one on
  // phones via CSS); everything stays reachable through Session Details.
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
    els.btnReviewAll.hidden = false;
    els.btnReviewAll.textContent = `Review Mistakes (${report.mistakes.length})`;
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
/**
 * Blade-swish pacing per gesture: the first swish of a gesture plays
 * immediately; a continued drag earns another swish only after BOTH real
 * pointer travel and a short interval have accumulated since the last one.
 * Never per move event — a stationary or slowly wiggling pointer stays
 * silent, while long fast slashes keep swishing like a moving blade.
 */
const WHOOSH_RETRIGGER_DISTANCE = 50; // px of pointer travel between swishes
const WHOOSH_RETRIGGER_MS = 130;      // …and at least this long since the last swish
/** Last swish of the current gesture: { at, travel } — null until the first. */
let gestureWhoosh = null;
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
  gestureWhoosh = null; // pointercancel/up fully resets swish eligibility
  releaseBlades(); // the slash fades out instead of lingering
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
  lastMoveAt = performance.now(); // rebase speed measurement for the gesture
  gestureWhoosh = null; // every new gesture starts with a fresh immediate swish
  startBlade(lastPoint.x, lastPoint.y);
  event.preventDefault();
}

/**
 * Swishes the blade for real movement: once at the start of a gesture and,
 * on long moving drags, again after WHOOSH_RETRIGGER_DISTANCE px of travel
 * and WHOOSH_RETRIGGER_MS — so the sound tracks the blade, not the event
 * stream. The audio manager's short anti-spam cooldown only guards against
 * synthetic duplicate bursts; it must never eat a genuine gesture (the old
 * one-shot latch permanently lost a gesture's swish whenever the manager
 * happened to reject it, which is why rapid swiping went silent).
 */
function maybePlayWhoosh(segmentDistance) {
  const t = performance.now();
  if (!gestureWhoosh) {
    gestureWhoosh = { at: t, travel: 0 };
    audioManager.play('bladeWhoosh');
    return;
  }
  gestureWhoosh.travel += segmentDistance;
  if (gestureWhoosh.travel >= WHOOSH_RETRIGGER_DISTANCE && t - gestureWhoosh.at >= WHOOSH_RETRIGGER_MS) {
    gestureWhoosh = { at: t, travel: 0 };
    audioManager.play('bladeWhoosh');
  }
}

function onPointerMove(event) {
  if (activePointerId === null || event.pointerId !== activePointerId) return;
  const now = performance.now();
  const point = toLocal(event);
  if (lastPoint) {
    const distance = Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y);
    if (distance >= MIN_SWIPE_DISTANCE && canSlice()) {
      // Remember the swipe direction and speed so slice FX follow the
      // blade (a fast slash bursts juicier — bounded in js/juice.js).
      lastSliceDir = { x: (point.x - lastPoint.x) / distance, y: (point.y - lastPoint.y) / distance };
      lastSliceSpeed = Math.min(3, distance / Math.max(4, now - lastMoveAt));
      maybePlayWhoosh(distance);
      engine.slice(lastPoint.x, lastPoint.y, point.x, point.y);
      // Slice results (cut sound, float notes, death animations) are applied
      // by the next animation tick's processEngineEvents() — at most one
      // frame later, imperceptible next to the next paint. Deferring keeps
      // DOM writes inside the render frame instead of interleaving them
      // with this input handler's layout reads.
    }
  }
  pushTrailPoint(point.x, point.y);
  lastPoint = point;
  lastMoveAt = now;
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
  fitTrailCanvas(w, h);
  fitFxCanvas(w, h);
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
  // The OS may have suspended a previously running AudioContext while
  // hidden (iOS) — recheck so the armed gesture listeners + pill recover.
  if (!document.hidden) audioManager.checkContext();
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
  clearJuiceFx(); // canvas juice layer must not leak across sessions
  cutPieces = [];
  blades = [];
  bladeSparks = [];
  clearTrailCanvas();
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
  audioManager.cancelSequences(); // stale celebration items must not fire over the new session
  audioManager.setSuspended(false); // a fresh session always starts audible
  setScreen('game'); // the playfield must be visible to be measurable
  currentLevel = level;
  sessionBestScore = Number(progress.levels[level.id]?.bestScore) || 0;
  lastHeartsKey = ''; // force the HUD hearts to redraw for the new session
  lastScore = -1; // no pop/flare when the fresh values first render
  lastMultiplier = -1;
  lastRoundText = '';
  lastLessonPercent = -1;
  lastComboText = '';
  lastTimerText = '';
  lastPromptText = '';
  lastWaveText = '';
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
  audioManager.cancelSequences(); // pending celebration items belong to the abandoned session
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

/**
 * Shows the unobtrusive "tap for sound" pill only while the browser (not
 * the player) is blocking playback: never for intentional mute, zero
 * volume or unsupported hardware, and never after activation succeeds.
 */
function syncAudioHint() {
  const readiness = audioManager.getReadiness();
  const blockedByBrowser = audioManager.needsUnlock() && readiness.supported;
  const intentionalSilence = !readiness.effectsOn || readiness.volume <= 0;
  els.btnAudioHint.hidden = !(blockedByBrowser && !intentionalSilence);
}

function initAudio() {
  // Debug/verification handle (stats, readiness, mute, volume — harmless
  // in production). ?audiodebug=1 adds console diagnostics.
  window.wordSliceAudio = audioManager;
  // Create the (suspended) context and fetch + decode the essential
  // sounds right now: decoding is not gated by autoplay policy, so the
  // buffers are ready before the first slice can possibly happen.
  audioManager.warmup();

  // Persistent, near-free unlock listeners. They early-exit whenever
  // playback is already permitted and stay armed after the first success
  // so an OS-level suspension (iOS tab switch, screen lock) recovers on
  // the next gesture. resume() runs synchronously inside the handler —
  // no fetch, timer or await may precede it (autoplay user activation).
  let lastUnlockAttemptAt = 0;
  const tryUnlockFromGesture = () => {
    if (!audioManager.needsUnlock()) return;
    const t = performance.now();
    // pointerdown + touchend of one tap describe the same interaction —
    // one unlock attempt per interaction.
    if (t - lastUnlockAttemptAt < 60) return;
    lastUnlockAttemptAt = t;
    audioManager.unlock();
  };
  window.addEventListener('pointerdown', tryUnlockFromGesture, { capture: true, passive: true });
  // Older iOS Safari does not treat pointerdown as audio user activation.
  window.addEventListener('touchend', tryUnlockFromGesture, { capture: true, passive: true });
  window.addEventListener('keydown', tryUnlockFromGesture, true);

  // The pill follows the readiness model (it also hides itself the moment
  // any gesture activates audio — not only via its own click).
  audioManager.onStateChange(syncAudioHint);
  els.btnAudioHint.addEventListener('click', () => {
    // The click's pointerdown already ran tryUnlockFromGesture via the
    // window capture listener; the direct call is a belt-and-braces
    // fallback for browsers that miss the capture phase.
    if (audioManager.needsUnlock()) audioManager.unlock();
    syncAudioHint();
  });
  syncAudioHint();

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
    syncAudioHint(); // muting must not leave a misleading "enable sound" pill
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
  initAudio();

  els.btnRetry.addEventListener('click', () => startup());

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
  for (const overlayEl of [els.settingsOverlay, els.menuHowOverlay, els.confirmOverlay, els.leaveOverlay]) {
    overlayEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        if (overlayEl === els.confirmOverlay) closeResetConfirm();
        else if (overlayEl === els.leaveOverlay) closeLeaveConfirm();
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

  // HUD Levels shortcut: mid-round (or mid-introduction) the leave
  // confirmation guards the unfinished session; with nothing live — the
  // HUD is only interactive on the game screen, so this branch is
  // defensive — it goes straight to the existing level-select screen.
  els.btnHudLevels.addEventListener('click', (ev) => {
    const liveRound = Boolean(engine)
      && (engine.state === ENGINE_STATES.PLAYING || engine.state === ENGINE_STATES.ROUND_READY);
    if (!liveRound) {
      quitToLevels();
      return;
    }
    openLeaveConfirm(ev.currentTarget);
  });
  els.btnLeaveCancel.addEventListener('click', closeLeaveConfirm);
  els.btnLeaveConfirm.addEventListener('click', () => {
    els.leaveOverlay.hidden = true;
    leaveReturnFocus = null;
    quitToLevels(); // discards the session; also clears the overlay pause + audio suspension
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

  // Results actions. One contextual gold primary (Try Again / Next Level /
  // Play Again — never a duplicate retry) plus Level Map and Details.
  // The gold button only advances when progression rules actually
  // unlocked the next level.
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
  els.btnDetails.addEventListener('click', openReviewOverlay);

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
        fx: () => juiceFx,
      };
    },
  });

  startup();
}

init();
