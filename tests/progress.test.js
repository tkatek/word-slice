/**
 * Word Slice — progress/unlock/achievement tests (injectable storage).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STORAGE_KEY,
  ACHIEVEMENTS,
  emptyProgress,
  readProgress,
  writeProgress,
  isLevelUnlocked,
  continueTarget,
  totalStars,
  passedLevelCount,
  recordLevelResult,
  resetLevelBestScore,
} from '../js/progress.js';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function failingStorage() {
  return { getItem: () => { throw new Error('boom'); }, setItem: () => { throw new Error('boom'); }, removeItem: () => {} };
}

const NOW = '2026-10-13T12:00:00.000Z';

function passReport(overrides = {}) {
  return {
    completed: true,
    passStatus: 'passed',
    score: 100,
    successfulRounds: 9,
    endedEarly: false,
    bestStreak: 3,
    stars: 2,
    ...overrides,
  };
}

test('PROGRESS: empty storage yields a fresh v2 record', () => {
  assert.deepEqual(readProgress(memoryStorage()), emptyProgress());
});

test('PROGRESS: corrupt data falls back to a fresh record, never throws', () => {
  assert.deepEqual(readProgress(memoryStorage({ [STORAGE_KEY]: '{oops' })), emptyProgress());
  assert.deepEqual(readProgress(failingStorage()), emptyProgress());
});

test('PROGRESS: write/read round-trip preserves the v2 shape', () => {
  const store = memoryStorage();
  const { progress: p } = recordLevelResult(emptyProgress(), 'level-01', passReport(), NOW);
  writeProgress(store, p);
  assert.deepEqual(readProgress(store), p);
});

test('UNLOCK: level 1 is always unlocked; others need the previous pass', () => {
  const p = emptyProgress();
  assert.equal(isLevelUnlocked(p, 'level-01'), true);
  assert.equal(isLevelUnlocked(p, 'level-02'), false);
  assert.equal(isLevelUnlocked(p, 'level-12'), false);
  assert.equal(isLevelUnlocked(p, 'unknown'), false);

  const q = recordLevelResult(p, 'level-01', passReport(), NOW).progress;
  assert.equal(isLevelUnlocked(q, 'level-02'), true);
  assert.equal(isLevelUnlocked(q, 'level-03'), false, 'unlocking is one step at a time');
});

test('UNLOCK: a failed replay never removes access to later levels', () => {
  let p = emptyProgress();
  p = recordLevelResult(p, 'level-01', passReport(), NOW).progress;
  // Fail a replay of level 1 (out of hearts).
  p = recordLevelResult(p, 'level-01', passReport({ completed: false, passStatus: null, stars: 0, endedEarly: true }), NOW).progress;
  assert.equal(p.levels['level-01'].passed, true, 'passed flag is sticky');
  assert.equal(isLevelUnlocked(p, 'level-02'), true);
});

test('CONTINUE: targets the first unlocked, not-yet-passed level', () => {
  let p = emptyProgress();
  assert.equal(continueTarget(p).id, 'level-01');
  p = recordLevelResult(p, 'level-01', passReport(), NOW).progress;
  assert.equal(continueTarget(p).id, 'level-02');
  // All levels passed → back to level 1 for replay.
  for (const level of ['level-02', 'level-03', 'level-04', 'level-05', 'level-06', 'level-07',
    'level-08', 'level-09', 'level-10', 'level-11', 'level-12']) {
    p = recordLevelResult(p, level, passReport(), NOW).progress;
  }
  assert.equal(continueTarget(p).id, 'level-01');
});

test('RECORD: keeps best stars/score, counts plays, stores last session', () => {
  let p = emptyProgress();
  const first = recordLevelResult(p, 'level-01', passReport({ score: 60, stars: 1, successfulRounds: 8 }), NOW).progress;
  const second = recordLevelResult(first, 'level-01', passReport({ score: 90, stars: 2, successfulRounds: 9 }), NOW).progress;
  const rec = second.levels['level-01'];
  assert.equal(rec.bestStars, 2);
  assert.equal(rec.bestScore, 90);
  assert.equal(rec.plays, 2);
  assert.equal(rec.passed, true);
  assert.equal(rec.last.stars, 2);
  // A weaker run never lowers the records.
  const third = recordLevelResult(second, 'level-01', passReport({ score: 10, stars: 0, successfulRounds: 0, passStatus: 'not-passed' }), NOW).progress;
  assert.equal(third.levels['level-01'].bestStars, 2);
  assert.equal(third.levels['level-01'].bestScore, 90);
});

test('STARS TOTAL: sums per-level best stars across the manifest only', () => {
  let p = emptyProgress();
  assert.equal(totalStars(p), 0);
  p = recordLevelResult(p, 'level-01', passReport({ stars: 2 }), NOW).progress;
  p = recordLevelResult(p, 'level-02', passReport({ stars: 3 }), NOW).progress;
  // A junk record for an unknown level must not count.
  p = { ...p, levels: { ...p.levels, 'cheat': { bestStars: 5 } } };
  assert.equal(totalStars(p), 5);
  assert.equal(passedLevelCount(p), 2);
});

test('ACHIEVEMENTS: definitions are unique with real conditions', () => {
  const ids = ACHIEVEMENTS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const a of ACHIEVEMENTS) {
    assert.ok(a.name && a.description, `${a.id} described`);
  }
});

test('ACHIEVEMENTS: first pass grants First Steps once', () => {
  let p = emptyProgress();
  const r1 = recordLevelResult(p, 'level-01', passReport({ stars: 1, successfulRounds: 8 }), NOW);
  assert.deepEqual(r1.newlyEarned.map((a) => a.id), ['first-lesson']);
  const r2 = recordLevelResult(r1.progress, 'level-02', passReport({ stars: 1 }), NOW);
  assert.deepEqual(r2.newlyEarned, [], 'no duplicate award');
});

test('ACHIEVEMENTS: three stars, streaks, five levels and stage graduation', () => {
  let p = emptyProgress();
  p = recordLevelResult(p, 'level-01', passReport({ stars: 3 }), NOW).progress;
  assert.ok(p.achievements['first-three-star']);

  p = recordLevelResult(p, 'level-02', passReport({ stars: 2, bestStreak: 5 }), NOW).progress;
  assert.ok(p.achievements['five-in-a-row']);
  assert.ok(!p.achievements['five-levels']);
  assert.ok(!p.achievements['beginner-stage']);

  p = recordLevelResult(p, 'level-03', passReport(), NOW).progress;
  p = recordLevelResult(p, 'level-04', passReport(), NOW).progress;
  assert.ok(p.achievements['beginner-stage'], 'all four A1 levels passed');

  p = recordLevelResult(p, 'level-05', passReport(), NOW).progress;
  assert.ok(p.achievements['five-levels']);
});

test('RESET BEST: clears only the score — stars, pass state, plays and other levels survive', () => {
  let p = emptyProgress();
  p = recordLevelResult(p, 'level-01', passReport({ score: 90, stars: 2 }), NOW).progress;
  p = recordLevelResult(p, 'level-02', passReport({ score: 75, stars: 3 }), NOW).progress;
  const before = JSON.parse(JSON.stringify(p));

  const q = resetLevelBestScore(p, 'level-01');

  assert.equal(q.levels['level-01'].bestScore, 0, 'the target score is cleared');
  assert.equal(q.levels['level-01'].bestStars, 2, 'stars are kept');
  assert.equal(q.levels['level-01'].passed, true, 'pass state is kept');
  assert.equal(q.levels['level-01'].plays, 1, 'play count is kept');
  assert.deepEqual(q.levels['level-01'].last, before.levels['level-01'].last, 'last session is kept');
  assert.deepEqual(q.levels['level-02'], before.levels['level-02'], 'other levels are untouched');
  assert.deepEqual(q.achievements, before.achievements, 'achievements are untouched');
  assert.equal(q.tutorialDone, before.tutorialDone, 'tutorial flag is untouched');
  assert.equal(isLevelUnlocked(q, 'level-02'), true, 'unlocked levels stay unlocked');
  assert.equal(totalStars(q), totalStars(p), 'star totals are unchanged');
  assert.deepEqual(p, before, 'the input progress object is not mutated');
});

test('RESET BEST: unknown levels and already-zero records return the same record', () => {
  const p = recordLevelResult(emptyProgress(), 'level-01', passReport(), NOW).progress;
  assert.equal(resetLevelBestScore(p, 'level-99'), p, 'no record is created for unknown levels');
  const zeroed = resetLevelBestScore(p, 'level-01');
  assert.equal(resetLevelBestScore(zeroed, 'level-01'), zeroed, 'a second reset is a no-op');
  const empty = emptyProgress();
  assert.equal(resetLevelBestScore(empty, 'level-01'), empty, 'empty progress stays empty');
});

test('MIGRATION: v1 legacy data is untouched and v2 starts clean', () => {
  const legacy = JSON.stringify({ lessons: { 'everyday-word-groups': { bestScore: 60, plays: 9, last: null } } });
  const store = memoryStorage({ 'word-slice:v1:progress': legacy });
  const p = readProgress(store);
  assert.deepEqual(p, emptyProgress(), 'no dishonest carry-over');
  writeProgress(store, p);
  assert.equal(store.getItem('word-slice:v1:progress'), legacy, 'legacy key preserved byte-for-byte');
});
