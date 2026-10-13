/**
 * Word Slice — progress, unlocking and achievements (pure module with an
 * injectable storage adapter; no DOM, no fetch).
 *
 * Storage shape (version 2):
 * {
 *   version: 2,
 *   levels: { [levelId]: { bestStars, bestScore, plays, passed, last: {…} } },
 *   achievements: { [id]: ISO date earned },
 *   tutorialDone: boolean
 * }
 *
 * Legacy v1 data ('word-slice:v1:progress', single lesson) is never
 * deleted or overwritten: the new version simply starts alongside it.
 * The old lesson is not a level, so nothing is carried over dishonestly.
 */
import { LEVELS, STAGES, nextLevel, levelById } from './levels.js';

export const STORAGE_KEY = 'word-slice:v2:progress';
export const LEGACY_KEY = 'word-slice:v1:progress';

/** Real, checkable achievements. No decorative unlocks. */
export const ACHIEVEMENTS = Object.freeze([
  { id: 'first-lesson', name: 'First Steps', description: 'Pass your first level.' },
  { id: 'first-three-star', name: 'Perfect Slice', description: 'Earn three stars on any level.' },
  { id: 'five-in-a-row', name: 'On Fire', description: 'Make five correct slices in a row.' },
  { id: 'five-levels', name: 'Level Collector', description: 'Pass five different levels.' },
  { id: 'beginner-stage', name: 'Beginner Graduate', description: 'Pass all four Beginner (A1) levels.' },
]);

/** @returns {object} a fresh, empty v2 progress record. */
export function emptyProgress() {
  return { version: 2, levels: {}, achievements: {}, tutorialDone: false };
}

/** True when the stored value has the v2 shape; anything else is ignored. */
function isV2Shape(data) {
  return Boolean(data && typeof data === 'object' && !Array.isArray(data) &&
    data.version === 2 && data.levels && typeof data.levels === 'object' &&
    data.achievements && typeof data.achievements === 'object');
}

/**
 * Reads progress from the injected storage. Corrupt data falls back to a
 * fresh record (the game stays playable without storage).
 */
export function readProgress(storage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return emptyProgress();
    const data = JSON.parse(raw);
    if (isV2Shape(data)) return data;
  } catch {
    /* corrupt or unavailable — play without it */
  }
  return emptyProgress();
}

/** Best-effort write; storage failures never break gameplay. */
export function writeProgress(storage, data) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* private mode / quota — ignore */
  }
}

/**
 * v1 → v2 migration policy: the legacy lesson was a single mixed lesson,
 * not a level, so its scores cannot honestly become level records. The
 * legacy key is preserved untouched; v2 simply starts fresh.
 * @returns {{progress: object, legacy: boolean}} legacy=true when v1 data exists.
 */
export function migrateLegacy() {
  return { progress: emptyProgress(), legacy: false };
}

/** Level 1 is always unlocked; every other level needs the previous one passed. */
export function isLevelUnlocked(progress, levelId) {
  const level = levelById(levelId);
  if (!level) return false;
  if (level.order === 1) return true;
  const prev = LEVELS.find((l) => l.order === level.order - 1);
  return Boolean(prev && progress.levels[prev.id] && progress.levels[prev.id].passed);
}

/** Highest unlocked-but-not-yet-passed level, falling back to level 1. */
export function continueTarget(progress) {
  const next = LEVELS.find((l) => isLevelUnlocked(progress, l.id) && !(progress.levels[l.id] && progress.levels[l.id].passed));
  return next || LEVELS[0];
}

export function totalStars(progress) {
  let stars = 0;
  for (const level of LEVELS) {
    const rec = progress.levels[level.id];
    if (rec) stars += rec.bestStars || 0;
  }
  return stars;
}

export function passedLevelCount(progress) {
  return LEVELS.filter((l) => progress.levels[l.id] && progress.levels[l.id].passed).length;
}

function stagePassed(progress, stageId) {
  return LEVELS
    .filter((l) => l.stageId === stageId)
    .every((l) => progress.levels[l.id] && progress.levels[l.id].passed);
}

/**
 * Records a finished session against its level and evaluates achievements.
 *
 * @param {object} progress current v2 record (mutated and returned)
 * @param {string} levelId
 * @param {{completed: boolean, passStatus: string|null, score: number, successfulRounds: number, endedEarly: boolean, bestStreak: number, stars: number}} report
 * @param {string} nowIso
 * @returns {{progress: object, newlyEarned: Array<{id: string, name: string}>}} a NEW progress object; the input is not mutated
 */
export function recordLevelResult(progress, levelId, report, nowIso) {
  const next = {
    version: 2,
    levels: { ...progress.levels },
    achievements: { ...progress.achievements },
    tutorialDone: progress.tutorialDone,
  };
  const passed = Boolean(report.completed && report.passStatus === 'passed');
  const prev = next.levels[levelId] || { bestStars: 0, bestScore: 0, plays: 0, passed: false, last: null };
  next.levels[levelId] = {
    bestStars: Math.max(prev.bestStars || 0, report.stars || 0),
    bestScore: Math.max(prev.bestScore || 0, report.score || 0),
    plays: (prev.plays || 0) + 1,
    passed: prev.passed || passed,
    last: {
      at: nowIso,
      score: report.score,
      stars: report.stars,
      successfulRounds: report.successfulRounds,
      endedEarly: report.endedEarly,
    },
  };

  const earned = [];
  const grant = (id) => {
    if (!next.achievements[id]) {
      next.achievements[id] = nowIso;
      const def = ACHIEVEMENTS.find((a) => a.id === id);
      if (def) earned.push({ id, name: def.name });
    }
  };

  if (passedLevelCount(next) >= 1) grant('first-lesson');
  if (LEVELS.some((l) => (next.levels[l.id] ? next.levels[l.id].bestStars : 0) >= 3)) grant('first-three-star');
  if ((report.bestStreak || 0) >= 5) grant('five-in-a-row');
  if (passedLevelCount(next) >= 5) grant('five-levels');
  if (stagePassed(next, 'stage-1')) grant('beginner-stage');

  return { progress: next, newlyEarned: earned };
}

export { STAGES, LEVELS };
