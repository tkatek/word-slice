/**
 * Word Slice — level system tests.
 * Covers the manifest, difficulty profiles, star rules and validation of
 * the real shipped data pack.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  LEVELS,
  STAGES,
  QUESTION_TYPES,
  SUPPORTED_QUESTION_TYPES,
  levelsByStage,
  levelById,
  nextLevel,
  stageById,
  tuningOverridesFor,
  starsFor,
  validateLevelsPack,
  MAX_OPTION_TEXT,
} from '../js/levels.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function loadPack() {
  const pack = { schemaVersion: 2, stages: [] };
  for (const f of ['stage-1.json', 'stage-2.json', 'stage-3.json']) {
    const data = JSON.parse(readFileSync(join(root, 'data', 'levels', f), 'utf8'));
    pack.stages.push(...data.stages);
  }
  return pack;
}

test('LEVELS: manifest has 12 sequential levels across 3 stages', () => {
  assert.equal(LEVELS.length, 12);
  assert.equal(STAGES.length, 3);
  for (let i = 0; i < LEVELS.length; i++) {
    assert.equal(LEVELS[i].order, i + 1, `level ${i + 1} order`);
    assert.equal(LEVELS[i].id, `level-${String(i + 1).padStart(2, '0')}`);
    assert.ok(stageById(LEVELS[i].stageId), 'stage exists');
    assert.ok(LEVELS[i].title, 'has title');
  }
});

test('LEVELS: stages group exactly their 4 levels each', () => {
  const groups = levelsByStage();
  assert.equal(groups.length, 3);
  for (const { stage, levels } of groups) {
    assert.equal(levels.length, 4, `${stage.id} has 4 levels`);
    assert.ok(levels.every((l, i) => l.order === levels[0].order + i), 'ordered');
  }
});

test('LEVELS: nextLevel walks the chain and stops at the end', () => {
  assert.equal(nextLevel('level-01').id, 'level-02');
  assert.equal(nextLevel('level-11').id, 'level-12');
  assert.equal(nextLevel('level-12'), null);
  assert.equal(nextLevel('unknown'), null);
});

test('LEVELS: levelById finds and rejects', () => {
  assert.equal(levelById('level-07').order, 7);
  assert.equal(levelById('nope'), null);
});

test('DIFFICULTY: every level has finite positive overrides within bounds', () => {
  // Target fully-visible reading windows per stage (seconds). FLIGHT_SECONDS
  // IS the readable window (the engine derives total flight from it), and the
  // ±4% flight jitter must keep every flight inside its band.
  const bands = { 'stage-1': [6, 7], 'stage-2': [5, 6], 'stage-3': [4.5, 5.5] };
  for (const level of LEVELS) {
    const t = tuningOverridesFor(level.id);
    for (const key of ['FLIGHT_SECONDS', 'WAVE_GAP', 'SPAWN_STAGGER']) {
      assert.ok(Number.isFinite(t[key]) && t[key] > 0, `${level.id} ${key}`);
    }
    // The configured window plus its full jitter spread stays in the band.
    const [lo, hi] = bands[level.stageId];
    const jittered = [1 - 0.04, 1 + 0.04].map((j) => t.FLIGHT_SECONDS * j);
    assert.ok(
      jittered[0] >= lo && jittered[1] <= hi,
      `${level.id} visible window ${jittered[0].toFixed(2)}–${jittered[1].toFixed(2)}s outside [${lo}, ${hi}]`
    );
  }
  // Difficulty genuinely decreases flight time from level 1 to level 12.
  const first = tuningOverridesFor('level-01').FLIGHT_SECONDS;
  const last = tuningOverridesFor('level-12').FLIGHT_SECONDS;
  assert.ok(first > last, 'later levels are slightly faster');
});

test('STARS: earned from successful rounds only', () => {
  const mk = (completed, passStatus, successfulRounds) => ({ completed, passStatus, successfulRounds });
  assert.equal(starsFor(mk(true, 'passed', 10)), 3);
  assert.equal(starsFor(mk(true, 'passed', 9)), 2);
  assert.equal(starsFor(mk(true, 'passed', 8)), 1);
  assert.equal(starsFor(mk(true, 'passed', 7)), 0);
  assert.equal(starsFor(mk(true, 'not-passed', 7)), 0);
  assert.equal(starsFor(mk(false, null, 8)), 0); // ended early: no stars
  assert.equal(starsFor(null), 0);
});

test('VALIDATION: the shipped data pack passes with 12 × ≥15 questions', () => {
  const pack = loadPack();
  const result = validateLevelsPack(pack);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  const counts = pack.stages.flatMap((s) => s.levels).map((l) => l.questions.length);
  assert.equal(counts.length, 12);
  assert.ok(counts.every((c) => c >= 15), 'every level has at least 15 questions');
});

test('VALIDATION: shipped pack uses all four supported question types', () => {
  const pack = loadPack();
  const types = new Set(pack.stages.flatMap((s) => s.levels).flatMap((l) => l.questions.map((q) => q.type)));
  for (const type of SUPPORTED_QUESTION_TYPES) {
    assert.ok(types.has(type), `type ${type} is used`);
  }
  assert.equal(QUESTION_TYPES.CATEGORY, 'category');
});

test('VALIDATION: every question answers via explicit correctOptionIds', () => {
  const pack = loadPack();
  for (const { levels } of pack.stages) {
    for (const level of levels) {
      for (const q of level.questions) {
        assert.ok(Array.isArray(q.correctOptionIds) && q.correctOptionIds.length > 0, `${q.id} explicit answers`);
        const ids = new Set(q.options.map((o) => o.id));
        for (const id of q.correctOptionIds) assert.ok(ids.has(id), `${q.id} answer ${id} exists`);
        assert.ok(q.correctOptionIds.length < q.options.length, `${q.id} has distractors`);
      }
    }
  }
});

test('VALIDATION: option text fits the fruit label limit', () => {
  const pack = loadPack();
  for (const { levels } of pack.stages) {
    for (const level of levels) {
      for (const q of level.questions) {
        for (const o of q.options) {
          assert.ok(o.text.trim().length <= MAX_OPTION_TEXT, `${q.id}/${o.id} "${o.text}" fits`);
        }
      }
    }
  }
});

test('VALIDATION: rejects missing levels, short banks and unknown extras', () => {
  const pack = loadPack();
  // Drop one level entirely.
  const missing = structuredClone(pack);
  missing.stages[0].levels.pop();
  assert.equal(validateLevelsPack(missing).ok, false);

  // Starve a level below the minimum.
  const short = structuredClone(pack);
  short.stages[0].levels[0].questions = short.stages[0].levels[0].questions.slice(0, 3);
  assert.equal(validateLevelsPack(short).ok, false);

  // Add an unknown level.
  const extra = structuredClone(pack);
  extra.stages[0].levels.push({ id: 'level-99', title: 'X', questions: [] });
  assert.equal(validateLevelsPack(extra).ok, false);

  // Duplicate level entries.
  const dup = structuredClone(pack);
  dup.stages[0].levels.push(structuredClone(dup.stages[0].levels[0]));
  assert.equal(validateLevelsPack(dup).ok, false);

  // Oversized option text.
  const long = structuredClone(pack);
  const q = long.stages[0].levels[0].questions[0];
  q.options[0] = { id: 'huge', text: 'extraordinarily' };
  q.correctOptionIds = ['huge'];
  const r = validateLevelsPack(long);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('exceeds')));
});

test('VALIDATION: rejects a malformed pack outright', () => {
  assert.equal(validateLevelsPack(null).ok, false);
  assert.equal(validateLevelsPack({}).ok, false);
  assert.equal(validateLevelsPack({ schemaVersion: 1, stages: [] }).ok, false);
});
