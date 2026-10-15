/**
 * Word Slice engine tests — pure Node, no DOM, deterministic rng and
 * simulated time only. Run with: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  WordSliceEngine,
  validateQuestionBank,
  segmentCircle,
  calcMultiplier,
  mulberry32,
  ENGINE_STATES,
  FRUIT_STATES,
} from '../js/engine.js';

/* ------------------------------------------------------------------ */
/* Fixtures and helpers                                                */
/* ------------------------------------------------------------------ */

/**
 * Identity rng: always returns 0.9999, which keeps every Fisher–Yates
 * shuffle in its original order (floor(0.9999*(i+1)) === i), so tests
 * know the exact question, option and lane order.
 */
const identityRng = () => 0.9999;

function makeQuestion(id, correct, distractors) {
  return {
    id,
    type: 'category',
    prompt: `Slice the ${id} words.`,
    options: [...correct, ...distractors].map((w) => ({ id: w, text: w })),
    correctOptionIds: correct.slice(),
    explanation: `${correct.join(', ')} match. The others do not.`,
  };
}

/** Standard lesson: `n` questions, each 2 correct + 2 distractors. */
function makeLesson(n = 12) {
  return {
    id: 'test-lesson',
    title: 'Test Lesson',
    proposedCefrLevel: 'A1',
    questions: Array.from({ length: n }, (_, i) =>
      makeQuestion(`q${i + 1}`, [`c${i + 1}a`, `c${i + 1}b`], [`d${i + 1}a`, `d${i + 1}b`])
    ),
  };
}

function makeEngine(opts = {}) {
  return new WordSliceEngine({
    rng: identityRng,
    maxActiveFruits: 4,
    playW: 800,
    playH: 600,
    ...opts,
    tuning: {
      FLIGHT_SECONDS: 0.5,
      FLIGHT_JITTER_RATIO: 0,
      APEX_JITTER_RATIO: 0,
      WAVE_GAP: 0.05,
      SPAWN_STAGGER: 0.02,
      ...(opts.tuning || {}),
    },
  });
}

/** Advances the simulation until `pred()` is true (or fails the test). */
function runUntil(engine, pred, maxSeconds = 30) {
  const dt = 1 / 60;
  for (let t = 0; t < maxSeconds; t += dt) {
    engine.update(dt);
    if (pred()) return t;
  }
  assert.fail('runUntil: condition not reached within simulated time');
}

/** Waits until the option's fruit is ACTIVE, then slices through its center. */
function sliceOption(engine, optionId) {
  for (let guard = 0; guard < 60 * 60; guard++) {
    const f = engine.getFruitsSnapshot().find((fr) => fr.optionId === optionId);
    if (f) return engine.slice(f.x - f.radius, f.y, f.x + f.radius, f.y);
    engine.update(1 / 60);
    if (engine.state !== ENGINE_STATES.PLAYING) break;
  }
  throw new Error(`sliceOption: option ${optionId} never became sliceable`);
}

function startAndLaunch(engine, lesson) {
  engine.startSession(lesson);
  assert.equal(engine.launchRound(), true);
}

function eventsOfType(engine, type) {
  return engine.drainEvents().filter((e) => e.type === type);
}

/**
 * Drives a whole 10-round session. With identity rng the session selects
 * the lesson's first 10 questions in order, so round i uses
 * lesson.questions[i]. Rounds with index < failFirst are failed:
 *  - 'miss'  mode: leave the first correct option unsliced (no heart loss)
 *  - 'wrong' mode: slice one distractor (costs a heart)
 */
function playFullSession(engine, lesson, opts = {}) {
  const failFirst = opts.failFirst ?? 0;
  const failMode = opts.failMode ?? 'miss';
  engine.startSession(lesson);
  for (let i = 0; i < 10; i++) {
    engine.launchRound();
    const q = lesson.questions[i];
    const correct = q.correctOptionIds;
    const toSlice = failMode === 'miss' && i < failFirst ? correct.slice(1) : correct;
    for (const id of toSlice) sliceOption(engine, id);
    if (failMode === 'wrong' && i < failFirst) {
      const distractor = q.options.find((o) => !correct.includes(o.id));
      sliceOption(engine, distractor.id);
    }
    runUntil(engine, () => engine.state === ENGINE_STATES.ROUND_FEEDBACK, 60);
    engine.continueToNextRound();
  }
  return engine.getSessionReport();
}

/* ------------------------------------------------------------------ */
/* DATA                                                                */
/* ------------------------------------------------------------------ */

describe('DATA validation', () => {
  const realBank = JSON.parse(readFileSync(new URL('../data/questions.json', import.meta.url), 'utf8'));

  it('accepts the shipped question bank', () => {
    const result = validateQuestionBank(realBank);
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  });

  it('shipped bank has at least 15 distinct questions in one lesson', () => {
    assert.ok(realBank.lessons.length >= 1);
    const qs = realBank.lessons[0].questions;
    assert.ok(qs.length >= 15);
    assert.equal(new Set(qs.map((q) => q.id)).size, qs.length);
  });

  it('rejects an unsupported schema version', () => {
    const result = validateQuestionBank({ ...realBank, schemaVersion: 2 });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('schemaVersion')));
  });

  it('rejects an unsupported question type', () => {
    const bank = { schemaVersion: 1, lessons: [makeLesson()] };
    bank.lessons[0].questions[0].type = 'odd-one-out';
    const result = validateQuestionBank(bank);
    assert.ok(result.errors.some((e) => e.includes('unsupported question type')));
  });

  it('rejects duplicate lesson, question and option ids with useful paths', () => {
    const lesson = makeLesson();
    const bank = { schemaVersion: 1, lessons: [lesson, { ...lesson }] };
    lesson.questions[1].id = lesson.questions[0].id;
    lesson.questions[2].options[1].id = lesson.questions[2].options[0].id;
    const result = validateQuestionBank(bank);
    assert.ok(result.errors.some((e) => e.includes('duplicate lesson id')));
    assert.ok(result.errors.some((e) => e.includes('duplicate question id')));
    assert.ok(result.errors.some((e) => e.includes('duplicate option id')));
  });

  it('rejects correct-option ids that do not exist and empty correct lists', () => {
    const lesson = makeLesson();
    lesson.questions[0].correctOptionIds = ['ghost'];
    const lesson2 = makeLesson();
    lesson2.questions[0].correctOptionIds = [];
    const r1 = validateQuestionBank({ schemaVersion: 1, lessons: [lesson] });
    const r2 = validateQuestionBank({ schemaVersion: 1, lessons: [lesson2] });
    assert.ok(r1.errors.some((e) => e.includes('does not match any option')));
    assert.ok(r2.errors.some((e) => e.includes('at least one correct option')));
  });

  it('rejects empty prompts, option text and explanations', () => {
    const lesson = makeLesson();
    lesson.questions[0].prompt = '  ';
    lesson.questions[1].options[0].text = '';
    delete lesson.questions[2].explanation;
    const result = validateQuestionBank({ schemaVersion: 1, lessons: [lesson] });
    assert.ok(result.errors.some((e) => e.includes('empty prompt')));
    assert.ok(result.errors.some((e) => e.includes('empty option text')));
    assert.ok(result.errors.some((e) => e.includes('empty explanation')));
  });

  it('rejects questions without a distractor and duplicate displayed text', () => {
    const noDistractor = makeLesson();
    noDistractor.questions[0].correctOptionIds = ['c1a', 'c1b', 'd1a', 'd1b'];
    const dupText = makeLesson();
    dupText.questions[0].options[2].text = 'C1A';
    const r1 = validateQuestionBank({ schemaVersion: 1, lessons: [noDistractor] });
    const r2 = validateQuestionBank({ schemaVersion: 1, lessons: [dupText] });
    assert.ok(r1.errors.some((e) => e.includes('at least one distractor')));
    assert.ok(r2.errors.some((e) => e.includes('duplicate option text')));
  });

  it('rejects lessons with too few questions for a session', () => {
    const result = validateQuestionBank({ schemaVersion: 1, lessons: [makeLesson(9)] });
    assert.ok(result.errors.some((e) => e.includes('needs at least 10 questions')));
  });

  it('engine refuses to start a session from a too-small lesson', () => {
    const engine = makeEngine();
    assert.throws(() => engine.startSession(makeLesson(9)), /needs at least 10/);
  });
});

describe('DATA selection', () => {
  it('selects 10 distinct questions without mutating the lesson', () => {
    const lesson = makeLesson(12);
    const before = lesson.questions.map((q) => q.id);
    const engine = makeEngine();
    const session = engine.startSession(lesson);
    assert.equal(session.questionIds.length, 10);
    assert.equal(new Set(session.questionIds).size, 10);
    assert.deepEqual(lesson.questions.map((q) => q.id), before);
    for (const id of session.questionIds) {
      assert.ok(before.includes(id), `unknown question ${id} selected`);
    }
  });

  it('uses the seeded default rng deterministically', () => {
    const lesson = makeLesson();
    const a = new WordSliceEngine({ seed: 42, playW: 800, playH: 600 });
    const b = new WordSliceEngine({ seed: 42, playW: 800, playH: 600 });
    const sa = a.startSession(lesson);
    const sb = b.startSession(lesson);
    assert.deepEqual(sa.questionIds, sb.questionIds);
    const rng = mulberry32(42);
    assert.equal(typeof rng(), 'number');
  });
});

/* ------------------------------------------------------------------ */
/* SCORING                                                             */
/* ------------------------------------------------------------------ */

describe('SCORING', () => {
  it('calcMultiplier covers the streak boundaries', () => {
    assert.equal(calcMultiplier(0), 1);
    assert.equal(calcMultiplier(1), 1);
    assert.equal(calcMultiplier(2), 1);
    assert.equal(calcMultiplier(3), 2);
    assert.equal(calcMultiplier(5), 2);
    assert.equal(calcMultiplier(6), 3);
    assert.equal(calcMultiplier(20), 3);
  });

  it('awards base points × multiplier and tracks best streak across rounds', () => {
    const lesson = makeLesson();
    lesson.questions[0] = makeQuestion('q1', ['a1', 'a2', 'a3'], ['x1', 'x2']);
    lesson.questions[1] = makeQuestion('q2', ['b1', 'b2', 'b3'], ['y1', 'y2']);
    const engine = makeEngine();
    engine.startSession(lesson);

    engine.launchRound();
    for (const id of ['a1', 'a2', 'a3']) sliceOption(engine, id);
    runUntil(engine, () => engine.state === ENGINE_STATES.ROUND_FEEDBACK);
    engine.continueToNextRound();
    engine.launchRound();
    for (const id of ['b1', 'b2', 'b3']) sliceOption(engine, id);
    const events = engine.drainEvents().filter((e) => e.type === 'correctSlice');
    assert.deepEqual(events.map((e) => e.points), [10, 10, 20, 20, 20, 30]);
    const session = engine.snapshotSession();
    assert.equal(session.score, 10 + 10 + 20 + 20 + 20 + 30);
    assert.equal(session.bestStreak, 6);
  });

  it('wrong slice removes one heart, resets streak/multiplier, never subtracts score', () => {
    const engine = makeEngine();
    startAndLaunch(engine, makeLesson());
    sliceOption(engine, 'c1a'); // streak 1, +10
    sliceOption(engine, 'd1a'); // wrong
    const session = engine.snapshotSession();
    assert.equal(session.score, 10);
    assert.equal(session.hearts, 2);
    assert.equal(session.streak, 0);
    assert.equal(session.multiplier, 1);
    assert.equal(session.metrics.wrongSlices, 1);
  });

  it('missed correct target resets streak but costs no heart', () => {
    const engine = makeEngine();
    startAndLaunch(engine, makeLesson());
    sliceOption(engine, 'c1a'); // streak 1
    // let c1b and both distractors fall
    runUntil(engine, () => engine.state === ENGINE_STATES.ROUND_FEEDBACK);
    const session = engine.snapshotSession();
    assert.equal(session.hearts, 3);
    assert.equal(session.streak, 0);
    assert.equal(session.multiplier, 1);
    assert.equal(session.metrics.missedTargets, 1);
    assert.equal(session.metrics.avoidedDistractors, 2);
  });

  it('avoided distractor keeps the streak and costs nothing', () => {
    const engine = makeEngine();
    startAndLaunch(engine, makeLesson());
    sliceOption(engine, 'c1a');
    sliceOption(engine, 'c1b');
    runUntil(engine, () => engine.state === ENGINE_STATES.ROUND_FEEDBACK);
    const session = engine.snapshotSession();
    assert.equal(session.streak, 2);
    assert.equal(session.hearts, 3);
    assert.equal(session.score, 20);
  });

  it('a resolved fruit can never award points or a heart twice', () => {
    const engine = makeEngine();
    startAndLaunch(engine, makeLesson());
    const res = sliceOption(engine, 'c1a');
    assert.equal(res.length, 1);
    const f = { ...engine.getFruitsSnapshot()[0] };
    // same segment again over the (now resolved) fruit area
    const again = engine.slice(f.x - 200, f.y, f.x + 200, f.y);
    const session = engine.snapshotSession();
    assert.equal(session.score, 10);
    assert.equal(session.metrics.correctSlices, 1);
    assert.ok(again.every((r) => r.optionId !== 'c1a'));
  });

  it('hearts never go below zero and no scoring happens after game over', () => {
    const engine = makeEngine();
    const lesson = makeLesson();
    lesson.questions[0] = makeQuestion('q1', ['c1'], ['d1', 'd2', 'd3']);
    startAndLaunch(engine, lesson);
    sliceOption(engine, 'd1');
    sliceOption(engine, 'd2');
    sliceOption(engine, 'd3');
    const session = engine.snapshotSession();
    assert.equal(session.hearts, 0);
    assert.equal(engine.state, ENGINE_STATES.RESULTS);
    assert.deepEqual(engine.slice(300, 300, 500, 300), []);
    assert.equal(engine.snapshotSession().score, 0);
  });

  it('streak continues across question boundaries', () => {
    const engine = makeEngine();
    const lesson = makeLesson();
    engine.startSession(lesson);
    engine.launchRound();
    sliceOption(engine, 'c1a');
    sliceOption(engine, 'c1b');
    runUntil(engine, () => engine.state === ENGINE_STATES.ROUND_FEEDBACK);
    engine.continueToNextRound();
    engine.launchRound();
    sliceOption(engine, 'c2a');
    const session = engine.snapshotSession();
    assert.equal(session.streak, 3);
    assert.equal(session.metrics.correctSlices, 3);
  });
});

/* ------------------------------------------------------------------ */
/* WAVES                                                               */
/* ------------------------------------------------------------------ */

describe('WAVES', () => {
  it('desktop never exceeds 4 active fruits and presents every option once', () => {
    const engine = makeEngine({ maxActiveFruits: 4 });
    const lesson = makeLesson();
    lesson.questions[0] = makeQuestion('q1', ['c1', 'c2'], ['d1', 'd2', 'd3', 'd4']);
    startAndLaunch(engine, lesson);
    let maxActive = 0;
    runUntil(engine, () => engine.state === ENGINE_STATES.ROUND_FEEDBACK, 60);
    // re-run sampling by replaying: simpler — instrument during a fresh round
    const engine2 = makeEngine({ maxActiveFruits: 4 });
    startAndLaunch(engine2, lesson);
    while (engine2.state === ENGINE_STATES.PLAYING) {
      engine2.update(1 / 60);
      maxActive = Math.max(maxActive, engine2.getFruitsSnapshot().length);
    }
    assert.ok(maxActive <= 4, `max active ${maxActive} > 4`);
    assert.ok(maxActive >= 1);
    const spawned = eventsOfType(engine2, 'fruitSpawned').map((e) => e.optionId);
    assert.deepEqual([...spawned].sort(), ['c1', 'c2', 'd1', 'd2', 'd3', 'd4']);
    assert.equal(engine2.state, ENGINE_STATES.ROUND_FEEDBACK);
  });

  it('mobile batches into 2-fruit waves without losing options', () => {
    const engine = makeEngine({ maxActiveFruits: 2 });
    const lesson = makeLesson();
    lesson.questions[0] = makeQuestion('q1', ['c1', 'c2'], ['d1', 'd2', 'd3']);
    startAndLaunch(engine, lesson);
    let maxActive = 0;
    while (engine.state === ENGINE_STATES.PLAYING || engine.state === ENGINE_STATES.ROUND_READY) {
      if (engine.state !== ENGINE_STATES.PLAYING) break;
      engine.update(1 / 60);
      maxActive = Math.max(maxActive, engine.getFruitsSnapshot().length);
    }
    assert.ok(maxActive <= 2, `max active ${maxActive} > 2`);
    const spawned = eventsOfType(engine, 'fruitSpawned').map((e) => e.optionId);
    assert.equal(spawned.length, 5);
    assert.deepEqual([...spawned].sort(), ['c1', 'c2', 'd1', 'd2', 'd3']);
    assert.equal(engine.state, ENGINE_STATES.ROUND_FEEDBACK);
  });

  it('handles a distractor-only wave', () => {
    const engine = makeEngine({ maxActiveFruits: 2 });
    const lesson = makeLesson();
    // manual option order [d1, d2, c1]: wave 0 = [d1, d2] (distractors only), wave 1 = [c1]
    lesson.questions[0] = {
      id: 'q1',
      type: 'category',
      prompt: 'Slice the q1 words.',
      options: [{ id: 'd1', text: 'd1' }, { id: 'd2', text: 'd2' }, { id: 'c1', text: 'c1' }],
      correctOptionIds: ['c1'],
      explanation: 'c1 matches.',
    };
    startAndLaunch(engine, lesson);
    const events = [];
    let firstWaveOptionIds = null;
    for (;;) {
      engine.update(1 / 60);
      events.push(...engine.drainEvents());
      const wave1Fruits = events.filter((e) => e.type === 'fruitSpawned' && e.waveIndex === 0);
      if (wave1Fruits.length === 2 && firstWaveOptionIds === null) {
        firstWaveOptionIds = wave1Fruits.map((e) => e.optionId);
      }
      if (engine.state === ENGINE_STATES.ROUND_FEEDBACK) break;
    }
    assert.deepEqual(firstWaveOptionIds, ['d1', 'd2']);
    const waves = events.filter((e) => e.type === 'waveStarted');
    assert.equal(waves.length, 2);
    const outcomes = engine.getOptionOutcomes();
    assert.equal(outcomes.c1, FRUIT_STATES.MISSED_CORRECT);
    assert.equal(outcomes.d1, FRUIT_STATES.AVOIDED_DISTRACTOR);
    assert.equal(outcomes.d2, FRUIT_STATES.AVOIDED_DISTRACTOR);
  });

  it('does not change question right after the last correct slice', () => {
    const engine = makeEngine();
    startAndLaunch(engine, makeLesson());
    sliceOption(engine, 'c1a');
    sliceOption(engine, 'c1b');
    // both correct answers resolved; distractors still airborne
    assert.equal(engine.state, ENGINE_STATES.PLAYING);
    const hud = engine.getHudState();
    assert.equal(hud.questionNumber, 1);
    runUntil(engine, () => engine.state === ENGINE_STATES.ROUND_FEEDBACK);
    assert.equal(engine.getHudState().questionNumber, 1);
  });

  it('HUD exposes wave numbering only when multiple waves are planned', () => {
    const engine = makeEngine({ maxActiveFruits: 2 });
    const lesson = makeLesson();
    lesson.questions[0] = makeQuestion('q1', ['c1'], ['d1', 'd2']);
    startAndLaunch(engine, lesson);
    runUntil(engine, () => engine.getHudState().wave !== null);
    const wave = engine.getHudState().wave;
    assert.deepEqual(wave, { current: 1, total: 2 });
    const desktop = makeEngine();
    startAndLaunch(desktop, makeLesson());
    assert.equal(desktop.getHudState().wave, null);
  });
});

/* ------------------------------------------------------------------ */
/* COLLISIONS                                                          */
/* ------------------------------------------------------------------ */

describe('COLLISIONS segmentCircle', () => {
  it('detects a direct hit', () => {
    assert.ok(segmentCircle(0, 0, 10, 0, 5, 0, 1));
  });

  it('rejects a clear miss', () => {
    assert.equal(segmentCircle(0, 0, 10, 0, 5, 5, 1), null);
  });

  it('accepts an exact tangent', () => {
    const hit = segmentCircle(0, 0, 10, 0, 5, 1, 1);
    assert.ok(hit);
    assert.ok(Math.abs(hit.t - 0.5) < 1e-9);
  });

  it('detects a high-speed segment crossing a small circle', () => {
    const hit = segmentCircle(-500, 0, 500, 0, 0, 0.5, 1);
    assert.ok(hit);
  });

  it('handles a zero-length segment as a point test', () => {
    assert.ok(segmentCircle(5, 5, 5, 5, 5, 5, 1));
    assert.ok(segmentCircle(5, 5, 5, 5, 6, 5, 1));
    assert.equal(segmentCircle(5, 5, 5, 5, 7, 5, 1), null);
  });
});

describe('COLLISIONS engine slicing', () => {
  /**
   * Waits until all fruits of wave 0 are near the apex (low vertical
   * spread), then performs one long horizontal swipe across all lanes.
   */
  function swipeAllLanes(engine) {
    runUntil(engine, () => engine.getFruitsSnapshot().length >= 1);
    for (let i = 0; i < 19; i++) engine.update(1 / 60);
    const fruits = engine.getFruitsSnapshot();
    const midY = fruits.reduce((sum, f) => sum + f.y, 0) / fruits.length;
    return { results: engine.slice(-10, midY, 810, midY), fruits };
  }

  it('one segment can hit multiple fruits in deterministic order', () => {
    const engine = makeEngine();
    const lesson = makeLesson();
    lesson.questions[0] = makeQuestion('q1', ['a', 'b'], ['c', 'd']); // lane order a,b,c,d
    startAndLaunch(engine, lesson);
    const { results } = swipeAllLanes(engine);
    assert.equal(results.length, 4);
    // sorted by t along the swipe ⇒ left-to-right lane order = option order
    assert.deepEqual(
      results.map((r) => r.optionId),
      ['a', 'b', 'c', 'd']
    );
  });

  it('stops processing the segment when the final heart is lost', () => {
    const engine = makeEngine({ tuning: { STARTING_HEARTS: 1 } });
    const lesson = makeLesson();
    // lane order a(correct), b, c, d: swipe resolves a (still allowed at 1
    // heart), then b costs the final heart and c/d must stay untouched.
    lesson.questions[0] = makeQuestion('q1', ['a'], ['b', 'c', 'd']);
    startAndLaunch(engine, lesson);
    const { results } = swipeAllLanes(engine);
    assert.equal(results.length, 2);
    assert.equal(results[0].correct, true);
    assert.equal(results[1].correct, false);
    const outcomes = engine.getOptionOutcomes();
    assert.equal(outcomes.a, FRUIT_STATES.HIT_CORRECT);
    assert.equal(outcomes.b, FRUIT_STATES.HIT_WRONG);
    assert.equal(outcomes.c, FRUIT_STATES.INTERRUPTED);
    assert.equal(outcomes.d, FRUIT_STATES.INTERRUPTED);
  });

  it('rejects stale fruits from finished rounds', () => {
    const engine = makeEngine();
    startAndLaunch(engine, makeLesson());
    runUntil(engine, () => engine.state === ENGINE_STATES.ROUND_FEEDBACK);
    assert.deepEqual(engine.slice(0, 300, 800, 300), []);
    engine.continueToNextRound();
    engine.launchRound();
    assert.deepEqual(engine.slice(0, 300, 800, 300).length <= 4, true);
  });

  it('zero-length engine slice behaves as a point test', () => {
    const engine = makeEngine();
    startAndLaunch(engine, makeLesson());
    runUntil(engine, () => engine.getFruitsSnapshot().length > 0);
    const f = engine.getFruitsSnapshot()[0];
    const hit = engine.slice(f.x, f.y, f.x, f.y);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].optionId, f.optionText);
  });
});

/* ------------------------------------------------------------------ */
/* LIFECYCLE                                                           */
/* ------------------------------------------------------------------ */

describe('LIFECYCLE pause/resume', () => {
  it('pause freezes movement and wave scheduling; resume does not catch up', () => {
    const engine = makeEngine();
    const lesson = makeLesson();
    lesson.questions[0] = makeQuestion('q1', ['c1'], ['d1', 'd2', 'd3']);
    engine.startSession(lesson);
    engine.launchRound();
    engine.pause('test');
    // 5 seconds of hidden time must not spawn or move anything
    for (let i = 0; i < 60 * 5; i++) engine.update(1 / 60);
    assert.equal(engine.getFruitsSnapshot().length, 0);
    assert.equal(engine.drainEvents().filter((e) => e.type === 'fruitSpawned').length, 0);
    engine.resume();
    runUntil(engine, () => engine.getFruitsSnapshot().length > 0, 5);
    const before = engine.getFruitsSnapshot()[0];
    for (let i = 0; i < 6; i++) engine.update(1 / 60);
    const after = engine.getFruitsSnapshot()[0];
    assert.ok(after, 'fruit still active after 0.1s of resumed time');
    const moved = Math.hypot(after.x - before.x, after.y - before.y);
    assert.ok(moved > 0 && moved < 500, `moved ${moved}px — hidden time leaked into the sim`);
  });

  it('pause works from ROUND_READY too and remembers the interrupted state', () => {
    const engine = makeEngine();
    engine.startSession(makeLesson());
    assert.equal(engine.state, ENGINE_STATES.ROUND_READY);
    assert.equal(engine.pause(), true);
    assert.equal(engine.state, ENGINE_STATES.PAUSED);
    assert.equal(engine.launchRound(), false, 'cannot launch while paused');
    engine.resume();
    assert.equal(engine.state, ENGINE_STATES.ROUND_READY);
    assert.equal(engine.launchRound(), true);
  });
});

describe('LIFECYCLE duplicate commands', () => {
  it('starting twice does not create two sessions', () => {
    const engine = makeEngine();
    const first = engine.startSession(makeLesson());
    assert.equal(engine.startSession(makeLesson()), null);
    assert.equal(engine.snapshotSession().id, first.id);
    assert.equal(engine.getHudState().questionNumber, 1);
  });

  it('launching twice does not duplicate a wave', () => {
    const engine = makeEngine();
    const lesson = makeLesson();
    engine.startSession(lesson);
    assert.equal(engine.launchRound(), true);
    assert.equal(engine.launchRound(), false);
    runUntil(engine, () => engine.state === ENGINE_STATES.ROUND_FEEDBACK, 10);
    const spawned = eventsOfType(engine, 'fruitSpawned');
    assert.equal(spawned.length, lesson.questions[0].options.length);
  });

  it('continuing twice does not skip a question', () => {
    const engine = makeEngine();
    const lesson = makeLesson();
    engine.startSession(lesson);
    engine.launchRound();
    sliceOption(engine, 'c1a');
    sliceOption(engine, 'c1b');
    runUntil(engine, () => engine.state === ENGINE_STATES.ROUND_FEEDBACK);
    assert.equal(engine.continueToNextRound(), true);
    assert.equal(engine.continueToNextRound(), false);
    assert.equal(engine.getHudState().questionNumber, 2);
  });

  it('finalizes results exactly once', () => {
    const engine = makeEngine();
    playFullSession(engine, makeLesson());
    assert.equal(engine.state, ENGINE_STATES.RESULTS);
    const ended = eventsOfType(engine, 'sessionEnded');
    assert.equal(ended.length, 1);
    assert.equal(engine.continueToNextRound(), false);
    assert.equal(engine.drainEvents().filter((e) => e.type === 'sessionEnded').length, 0);
  });
});

describe('LIFECYCLE restart and menu', () => {
  it('restart clears active objects, records and input-facing state', () => {
    const engine = makeEngine();
    const lesson = makeLesson();
    engine.startSession(lesson);
    engine.launchRound();
    sliceOption(engine, 'c1a');
    sliceOption(engine, 'd1a');
    const oldId = engine.snapshotSession().id;
    const fresh = engine.restartSession();
    assert.notEqual(fresh.id, oldId);
    assert.equal(engine.state, ENGINE_STATES.ROUND_READY);
    assert.equal(engine.getFruitsSnapshot().length, 0);
    const session = engine.snapshotSession();
    assert.equal(session.score, 0);
    assert.equal(session.hearts, 3);
    assert.equal(session.streak, 0);
    assert.equal(new Set(session.questionIds).size, 10);
    assert.deepEqual(engine.slice(0, 300, 800, 300), []);
  });

  it('returning to menu leaves no active gameplay', () => {
    const engine = makeEngine();
    const lesson = makeLesson();
    engine.startSession(lesson);
    engine.launchRound();
    sliceOption(engine, 'c1a');
    engine.abandonToMenu();
    assert.equal(engine.state, ENGINE_STATES.IDLE);
    assert.equal(engine.snapshotSession(), null);
    assert.equal(engine.getFruitsSnapshot().length, 0);
    assert.deepEqual(engine.slice(0, 0, 100, 100), []);
  });
});

describe('LIFECYCLE timing robustness', () => {
  function engineAt(patternSeconds) {
    // default flight tuning so motion is gentle; compare near the apex
    const engine = new WordSliceEngine({
      rng: identityRng,
      maxActiveFruits: 4,
      playW: 800,
      playH: 600,
      tuning: { FLIGHT_JITTER_RATIO: 0, APEX_JITTER_RATIO: 0 },
    });
    startAndLaunch(engine, makeLesson());
    for (const dt of patternSeconds) engine.update(dt);
    return engine;
  }

  it('equivalent frame partitions produce equivalent motion', () => {
    const target = 1.7; // first fruit still rising (apex is near half of total flight)
    const p60 = engineAt(Array(102).fill(1 / 60)); // 1.7s at 60fps
    const p30 = engineAt(Array(51).fill(1 / 30)); // 1.7s at 30fps
    const p120 = engineAt(Array(204).fill(1 / 120)); // 1.7s at 120fps
    void target;
    const key = (e) => Object.fromEntries(e.getFruitsSnapshot().map((f) => [f.optionId, f]));
    const a = key(p60);
    const b = key(p30);
    const c = key(p120);
    assert.equal(Object.keys(a).length, 4);
    for (const id of Object.keys(a)) {
      assert.ok(b[id] && c[id], `fruit ${id} missing in a slower/faster pattern`);
      assert.ok(Math.abs(a[id].x - b[id].x) < 0.75, `x drift 30fps: ${Math.abs(a[id].x - b[id].x)}`);
      assert.ok(Math.abs(a[id].y - b[id].y) < 0.75, `y drift 30fps: ${Math.abs(a[id].y - b[id].y)}`);
      assert.ok(Math.abs(a[id].x - c[id].x) < 0.75, `x drift 120fps: ${Math.abs(a[id].x - c[id].x)}`);
      assert.ok(Math.abs(a[id].y - c[id].y) < 0.75, `y drift 120fps: ${Math.abs(a[id].y - c[id].y)}`);
    }
  });

  it('invalid deltas are ignored without corrupting numeric state', () => {
    const engine = makeEngine();
    startAndLaunch(engine, makeLesson());
    engine.update(NaN);
    engine.update(-5);
    engine.update(Infinity);
    engine.update(1e9); // clamped, bounded catch-up
    for (let i = 0; i < 30; i++) engine.update(1 / 60);
    const session = engine.snapshotSession();
    for (const v of [session.score, session.hearts, session.streak]) {
      assert.ok(Number.isFinite(v));
    }
    for (const f of engine.getFruitsSnapshot()) {
      assert.ok(Number.isFinite(f.x) && Number.isFinite(f.y));
    }
  });

  it('the event queue is bounded', () => {
    const engine = makeEngine();
    for (let i = 0; i < 300; i++) engine.emit('noise');
    assert.ok(engine.drainEvents().length <= 64);
  });
});

/* ------------------------------------------------------------------ */
/* RESULTS                                                             */
/* ------------------------------------------------------------------ */

describe('RESULTS round success rules', () => {
  it('a round is successful only with every correct sliced and no distractor sliced', () => {
    const perfect = makeEngine();
    const lesson = makeLesson();
    perfect.startSession(lesson);
    perfect.launchRound();
    sliceOption(perfect, 'c1a');
    sliceOption(perfect, 'c1b');
    runUntil(perfect, () => perfect.state === ENGINE_STATES.ROUND_FEEDBACK);
    assert.equal(perfect.getRoundReport().successful, true);

    const missedOne = makeEngine();
    missedOne.startSession(makeLesson());
    missedOne.launchRound();
    sliceOption(missedOne, 'c1a');
    runUntil(missedOne, () => missedOne.state === ENGINE_STATES.ROUND_FEEDBACK);
    assert.equal(missedOne.getRoundReport().successful, false);
    assert.equal(missedOne.getRoundReport().completed, true);

    const hitDistractor = makeEngine();
    hitDistractor.startSession(makeLesson());
    hitDistractor.launchRound();
    sliceOption(hitDistractor, 'c1a');
    sliceOption(hitDistractor, 'c1b');
    sliceOption(hitDistractor, 'd1a');
    runUntil(hitDistractor, () => hitDistractor.state === ENGINE_STATES.ROUND_FEEDBACK);
    assert.equal(hitDistractor.getRoundReport().successful, false);
  });
});

describe('RESULTS session outcomes', () => {
  it('passes with 8 of 10 successful rounds', () => {
    const engine = makeEngine();
    const report = playFullSession(engine, makeLesson(), { failFirst: 2 });
    assert.equal(report.completed, true);
    assert.equal(report.completedRounds, 10);
    assert.equal(report.successfulRounds, 8);
    assert.equal(report.passStatus, 'passed');
  });

  it('does not pass with 7 of 10 successful rounds', () => {
    const engine = makeEngine();
    const report = playFullSession(engine, makeLesson(), { failFirst: 3 });
    assert.equal(report.successfulRounds, 7);
    assert.equal(report.passStatus, 'not-passed');
  });

  it('early game over is an incomplete session, not a completed lesson', () => {
    const engine = makeEngine();
    const lesson = makeLesson();
    lesson.questions[0] = makeQuestion('q1', ['c1'], ['d1', 'd2', 'd3']);
    engine.startSession(lesson);
    engine.launchRound();
    sliceOption(engine, 'd1');
    sliceOption(engine, 'd2');
    sliceOption(engine, 'd3');
    const report = engine.getSessionReport();
    assert.equal(report.endedEarly, true);
    assert.equal(report.completed, false);
    assert.equal(report.completedRounds, 0);
    assert.equal(report.passStatus, null);
    assert.equal(engine.state, ENGINE_STATES.RESULTS);
    const ended = eventsOfType(engine, 'sessionEnded');
    assert.equal(ended.length, 1);
  });

  it('interrupted and not-presented options are not misses or mistakes', () => {
    const engine = makeEngine({ maxActiveFruits: 2, tuning: { STARTING_HEARTS: 1 } });
    const lesson = makeLesson();
    // manual order [d1, c1, d2]: wave 0 = [d1, c1], wave 1 = [d2] (never
    // launched). Slicing d1 at 1 heart ends the session while c1 is still
    // airborne (INTERRUPTED) and d2 is still queued (NOT_PRESENTED).
    lesson.questions[0] = {
      id: 'q1',
      type: 'category',
      prompt: 'Slice the q1 words.',
      options: [{ id: 'd1', text: 'd1' }, { id: 'c1', text: 'c1' }, { id: 'd2', text: 'd2' }],
      correctOptionIds: ['c1'],
      explanation: 'c1 matches.',
    };
    engine.startSession(lesson);
    engine.launchRound();
    // wait until both wave-0 fruits are airborne, then slice the distractor
    runUntil(engine, () => engine.getFruitsSnapshot().length >= 2, 5);
    const d1 = engine.getFruitsSnapshot().find((f) => f.optionId === 'd1');
    engine.slice(d1.x - d1.radius, d1.y, d1.x + d1.radius, d1.y); // hearts 0 → session ends mid-wave
    const outcomes = engine.getOptionOutcomes();
    assert.equal(outcomes.d1, FRUIT_STATES.HIT_WRONG);
    assert.equal(outcomes.c1, FRUIT_STATES.INTERRUPTED);
    assert.equal(outcomes.d2, FRUIT_STATES.NOT_PRESENTED);
    const report = engine.getSessionReport();
    assert.equal(report.missedTargets, 0);
    assert.deepEqual(report.mistakes, []);
    assert.equal(report.endedEarly, true);
  });

  it('safe empty metrics: accuracy and rates are null, never NaN', () => {
    const engine = makeEngine();
    engine.startSession(makeLesson());
    for (let i = 0; i < 10; i++) {
      engine.launchRound();
      runUntil(engine, () => engine.state === ENGINE_STATES.ROUND_FEEDBACK, 60);
      engine.continueToNextRound();
    }
    const report = engine.getSessionReport();
    assert.equal(report.correctSlices, 0);
    assert.equal(report.wrongSlices, 0);
    assert.equal(report.accuracy, null);
    assert.equal(report.roundSuccessRate, 0);
    assert.equal(report.completed, true);
    assert.equal(report.mistakes.length, 10); // every round missed its corrects
    for (const m of report.mistakes) {
      assert.equal(typeof m.explanation, 'string');
      assert.equal(m.wrongSelections.length, 0);
      assert.equal(m.missedCorrect.length, 2);
    }
  });
});

describe('RESULTS resize checkpoint', () => {
  it('restores pre-launch state without duplicating score or penalties', () => {
    const engine = makeEngine();
    const lesson = makeLesson();
    engine.startSession(lesson);

    // round 1: build a streak of 2 and 20 points
    engine.launchRound();
    sliceOption(engine, 'c1a');
    sliceOption(engine, 'c1b');
    runUntil(engine, () => engine.state === ENGINE_STATES.ROUND_FEEDBACK);
    engine.continueToNextRound();

    // round 2: slice a correct (+20) and a wrong (-1 heart), then resize
    engine.launchRound();
    sliceOption(engine, 'c2a');
    sliceOption(engine, 'd2a');
    assert.equal(engine.recoverRound(), true);
    const session = engine.snapshotSession();
    assert.equal(engine.state, ENGINE_STATES.ROUND_READY);
    assert.equal(session.score, 20);
    assert.equal(session.hearts, 3);
    assert.equal(session.streak, 2);
    assert.equal(session.metrics.correctSlices, 2);
    assert.equal(session.metrics.wrongSlices, 0);
    assert.deepEqual(Object.values(engine.getOptionOutcomes()), [FRUIT_STATES.QUEUED, FRUIT_STATES.QUEUED, FRUIT_STATES.QUEUED, FRUIT_STATES.QUEUED]);
    assert.equal(engine.getFruitsSnapshot().length, 0);

    // relaunch the same question and let it resolve untouched
    engine.setPlayfield(400, 700); // simulated orientation change
    engine.setMaxActiveFruits(2);
    assert.equal(engine.launchRound(), true);
    runUntil(engine, () => engine.state === ENGINE_STATES.ROUND_FEEDBACK, 60);
    const after = engine.snapshotSession();
    assert.equal(after.score, 20);
    assert.equal(after.hearts, 3);
    assert.equal(after.completedRounds, 2);
    assert.equal(after.successfulRounds, 1);
    assert.equal(after.metrics.correctSlices, 2);
    assert.equal(after.metrics.wrongSlices, 0);
    assert.equal(engine.getHudState().questionNumber, 2);
  });

  it('ignores recovery when no launched round is in flight', () => {
    const engine = makeEngine();
    engine.startSession(makeLesson());
    assert.equal(engine.recoverRound(), false);
    assert.equal(engine.state, ENGINE_STATES.ROUND_READY);
  });
});
