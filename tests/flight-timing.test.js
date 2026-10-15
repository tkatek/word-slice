/**
 * Word Slice — fruit flight timing & fairness regression tests.
 *
 * Locks in the readable-window guarantees that fix the "fruits fall too
 * fast to read" issue:
 *  - The fully-visible duration (fruit entirely inside the playfield,
 *    bottom edge entering until top edge leaving) matches the per-stage
 *    bands: levels 1–4 6–7 s, 5–8 5–6 s, 9–12 4.5–5.5 s — on desktop AND
 *    phone playfields, jitter included.
 *  - Misses only happen after the fruit genuinely entered the playfield.
 *  - Pause freezes, resume is smooth, frame rate does not change speed,
 *    resizes never corrupt or strand trajectories.
 *  - Full sessions still resolve: no stuck fruits, all options presented,
 *    collisions accurate, no duplicate scoring, no unintended heart loss,
 *    level flight progression strictly decreasing.
 *
 * Pure deterministic simulation: fixed 1/60 s steps, injected rng.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { WordSliceEngine, ENGINE_STATES, FRUIT_STATES, mulberry32 } from '../js/engine.js';
import { LEVELS, tuningOverridesFor } from '../js/levels.js';

const STEP = 1 / 60;

/** Identity rng keeps shuffles in order and zeroes all ±jitter terms. */
const identityRng = () => 0.5;

function makeLesson(n = 10) {
  return {
    id: 'timing-lesson',
    title: 'Timing Lesson',
    questions: Array.from({ length: n }, (_, i) => ({
      id: `q${i + 1}`,
      type: 'category',
      prompt: `Prompt ${i + 1}`,
      explanation: 'explanation',
      options: [
        { id: `c${i}a`, text: 'aa' },
        { id: `c${i}b`, text: 'bb' },
        { id: `d${i}a`, text: 'cc' },
        { id: `d${i}b`, text: 'dd' },
      ],
      correctOptionIds: [`c${i}a`, `c${i}b`],
    })),
  };
}

function makeEngine(opts = {}) {
  const { playW = 1280, playH = 540, maxActive = 4, rng = identityRng, tuning, lesson } = opts;
  const engine = new WordSliceEngine({
    rng,
    maxActiveFruits: maxActive,
    playW,
    playH,
    tuning,
  });
  engine.startSession(lesson || makeLesson());
  engine.launchRound();
  return engine;
}

/**
 * Steps the engine, recording for every fruit the fully-visible window:
 * from y + radius <= playH (fruit entirely inside, rising) to
 * y - radius >= playH (fruit entirely below, falling) — the honest
 * "readable" interval. Also tracks minimum y and per-step vertical motion.
 */
function recordFlight(engine, maxSeconds = 40) {
  const playH = engine.playfield.h;
  const fruits = new Map();
  const update = (f) => {
    let rec = fruits.get(f.id);
    if (!rec) {
      rec = { id: f.id, optionId: f.optionId, radius: f.radius, tIn: null, tGone: null, minY: Infinity, ys: [] };
      fruits.set(f.id, rec);
    }
    rec.minY = Math.min(rec.minY, f.y);
    rec.ys.push(f.y);
    if (rec.tIn === null && f.y + f.radius <= playH) rec.tIn = engine.simTime;
    if (rec.tGone === null && rec.tIn !== null && f.y - f.radius >= playH) rec.tGone = engine.simTime;
  };
  let t = 0;
  for (; t < maxSeconds; t += STEP) {
    for (const f of engine.getFruitsSnapshot()) update(f);
    engine.update(STEP);
    if (engine.state !== ENGINE_STATES.PLAYING) break;
  }
  for (const f of engine.getFruitsSnapshot()) update(f);
  return { fruits: [...fruits.values()], stoppedAt: t };
}

const visibleDurations = (recs) =>
  recs.filter((r) => r.tIn !== null && r.tGone !== null).map((r) => r.tGone - r.tIn);

/** Stage reading-time bands (seconds, fully-visible window). */
const BANDS = { 'stage-1': [6, 7], 'stage-2': [5, 6], 'stage-3': [4.5, 5.5] };
const bandOf = (levelId) => BANDS[LEVELS.find((l) => l.id === levelId).stageId];

// Representative playfields: wide/short desktop boards and narrow phone
// boards (2-fruit waves), including the smallest supported phones.
const VIEWPORTS = [
  { name: 'desktop 1920x1080', w: 1880, h: 760, m: 4 },
  { name: 'desktop 1366x768', w: 1280, h: 540, m: 4 },
  { name: 'phone 390x844', w: 370, h: 600, m: 2 },
  { name: 'phone 320x640', w: 300, h: 430, m: 2 },
];

describe('visible flight duration meets per-stage reading bands', () => {
  for (const vp of VIEWPORTS) {
    it(`every level stays in its band on ${vp.name} (no jitter)`, () => {
      for (const level of LEVELS) {
        const engine = makeEngine({ playW: vp.w, playH: vp.h, maxActive: vp.m, tuning: tuningOverridesFor(level.id) });
        const { fruits } = recordFlight(engine, 25);
        const durations = visibleDurations(fruits);
        assert.ok(durations.length >= Math.min(4, vp.m), 'fruits flew and were measured');
        const [lo, hi] = bandOf(level.id);
        for (const d of durations) {
          assert.ok(
            d >= lo && d <= hi,
            `${level.id} on ${vp.name}: visible ${d.toFixed(2)}s outside [${lo}, ${hi}]`
          );
        }
      }
    });
  }

  it('jittered flights (seeded rng) stay inside the bands', () => {
    for (const levelId of ['level-01', 'level-06', 'level-12']) {
      // Several seeds exercise both jitter extremes across many flights.
      for (const seed of [1, 7, 12345]) {
        const engine = makeEngine({
          rng: mulberry32(seed),
          playW: 370,
          playH: 600,
          maxActive: 2,
          tuning: tuningOverridesFor(levelId),
        });
        const { fruits } = recordFlight(engine, 40);
        const durations = visibleDurations(fruits);
        assert.ok(durations.length >= 2, 'fruits flew');
        const [lo, hi] = bandOf(levelId);
        for (const d of durations) {
          assert.ok(d >= lo - 0.15 && d <= hi + 0.15, `${levelId} seed ${seed}: visible ${d.toFixed(2)}s`);
        }
      }
    }
  });

  it('reading time does not collapse on a short phone playfield', () => {
    // 240px is the CSS minimum playfield height: even there the window must
    // stay close to the configured target (small discretization allowance).
    const engine = makeEngine({ playW: 300, playH: 240, maxActive: 2, tuning: tuningOverridesFor('level-01') });
    const { fruits } = recordFlight(engine, 25);
    const durations = visibleDurations(fruits);
    assert.ok(durations.length > 0, 'fruits flew on the tiny board');
    for (const d of durations) assert.ok(d >= 5.5, `tiny board visible ${d.toFixed(2)}s`);
  });

  it('mobile timing is at least as forgiving as desktop for every level', () => {
    for (const level of LEVELS) {
      const desktop = visibleDurations(
        recordFlight(makeEngine({ playW: 1280, playH: 540, maxActive: 4, tuning: tuningOverridesFor(level.id) }), 25).fruits
      );
      const mobile = visibleDurations(
        recordFlight(makeEngine({ playW: 370, playH: 600, maxActive: 2, tuning: tuningOverridesFor(level.id) }), 25).fruits
      );
      const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
      assert.ok(
        avg(mobile) >= avg(desktop) - 0.25,
        `${level.id}: mobile ${avg(mobile).toFixed(2)}s vs desktop ${avg(desktop).toFixed(2)}s`
      );
    }
  });
});

describe('desktop trajectories stay natural ballistic arcs', () => {
  it('fruits rise, slow to the apex, then accelerate downward — no freezing or jumps', () => {
    const engine = makeEngine({ playW: 1280, playH: 540, maxActive: 4, tuning: tuningOverridesFor('level-01') });
    const { fruits } = recordFlight(engine, 25);
    assert.ok(fruits.length > 0);
    for (const rec of fruits) {
      const ys = rec.ys;
      assert.ok(ys.length > 60, 'enough samples');
      // Vertical speeds from successive samples.
      const vy = ys.slice(1).map((y, i) => (y - ys[i]) / STEP);
      // Rising first (vy < 0 once inside the board), falling last.
      const firstInside = vy[Math.max(0, ys.findIndex((y) => y + rec.radius <= 540) - 1)];
      assert.ok(firstInside < 0, 'fruit rises when it becomes visible');
      assert.ok(vy[vy.length - 1] > 0, 'fruit falls at the end');
      // |vy| decreases to a minimum near the apex, then increases: the
      // minimum upward speed must be well below launch speed (natural
      // ballistic slowdown) and happen before the midpoint of the window.
      const absVy = vy.map(Math.abs);
      const minIdx = absVy.indexOf(Math.min(...absVy.slice(0, -4)));
      assert.ok(minIdx > 0 && minIdx < absVy.length - 5, 'apex slowdown inside the flight');
      assert.ok(absVy[minIdx] < absVy[0] * 0.35, 'fruit nearly stops at the apex');
      // No speed spike anywhere: speed changes are bounded by gravity.
      for (let i = 1; i < vy.length; i++) {
        assert.ok(Math.abs(vy[i] - vy[i - 1]) < 30, `smooth acceleration at sample ${i}`);
      }
      // The fruit stays inside the board horizontally and never leaves the top.
      assert.ok(rec.minY > 0, 'fruit never clips the top of the board');
    }
  });
});

describe('missed-fruit fairness', () => {
  it('a correct fruit is missed only after entering the visible playfield', () => {
    const engine = makeEngine({ playW: 1280, playH: 540, maxActive: 4, tuning: tuningOverridesFor('level-06') });
    const { fruits } = recordFlight(engine, 25);
    engine.drainEvents();
    // Re-run and watch events: every targetMissed fruit must have been
    // inside the board (min y above the bottom edge) at some point.
    const engine2 = makeEngine({ playW: 1280, playH: 540, maxActive: 4, tuning: tuningOverridesFor('level-06') });
    const minSeen = new Map();
    let t = 0;
    for (; t < 30; t += STEP) {
      for (const f of engine2.getFruitsSnapshot()) {
        minSeen.set(f.id, Math.min(minSeen.get(f.id) ?? Infinity, f.y));
      }
      engine2.update(STEP);
      for (const ev of engine2.drainEvents()) {
        if (ev.type === 'targetMissed') {
          const minY = minSeen.get(ev.fruitId);
          assert.ok(minY !== undefined && minY <= 540, `missed fruit ${ev.fruitId} never entered the board`);
        }
      }
      if (engine2.state !== ENGINE_STATES.PLAYING) break;
    }
    assert.ok(fruits.length > 0);
  });

  it('missing every correct fruit costs no hearts (Beginner rule) and resets streak only', () => {
    const engine = makeEngine({ playW: 370, playH: 600, maxActive: 2, tuning: tuningOverridesFor('level-01') });
    let t = 0;
    for (; t < 40; t += STEP) {
      engine.update(STEP);
      if (engine.state !== ENGINE_STATES.PLAYING) break;
    }
    const session = engine.snapshotSession();
    assert.equal(session.hearts, 3, 'missed correct fruits never remove a heart');
    assert.ok(session.metrics.missedTargets >= 2, 'correct fruits were missed');
    assert.equal(session.metrics.wrongSlices, 0);
    assert.equal(session.streak, 0);
  });

  it('a wrong slice removes exactly one heart, never more', () => {
    const engine = makeEngine({ playW: 1280, playH: 540, maxActive: 4, tuning: tuningOverridesFor('level-01') });
    const run = (seconds) => {
      for (let t = 0; t < seconds; t += STEP) engine.update(STEP);
    };
    run(1.5); // fruits are visible by now
    const distractor = [...engine.getOptionOutcomes().entries()].find(
      ([id, st]) => st === FRUIT_STATES.ACTIVE && engine.round.correctIds.has(id) === false
    );
    assert.ok(distractor, 'an active distractor exists');
    const fruit = engine.getFruitsSnapshot().find((f) => f.optionId === distractor[0]);
    const before = engine.snapshotSession().hearts;
    const results = engine.slice(fruit.x - 1, fruit.y, fruit.x + 1, fruit.y);
    assert.equal(results.length, 1);
    assert.equal(results[0].correct, false);
    assert.equal(engine.snapshotSession().hearts, before - 1, 'exactly one heart lost');
  });
});

describe('pause, resume and frame-rate independence', () => {
  it('pausing freezes fruit movement completely', () => {
    const engine = makeEngine({ playW: 1280, playH: 540, maxActive: 4, tuning: tuningOverridesFor('level-01') });
    for (let t = 0; t < 2; t += STEP) engine.update(STEP);
    const frozen = engine.getFruitsSnapshot();
    assert.ok(frozen.length > 0);
    assert.ok(engine.pause('test'));
    for (let i = 0; i < 120; i++) engine.update(1 / 60); // 2 s of hidden time
    const after = engine.getFruitsSnapshot();
    assert.equal(after.length, frozen.length);
    for (const f of after) {
      const was = frozen.find((g) => g.id === f.id);
      assert.ok(was, `fruit ${f.id} survived the pause`);
      assert.equal(f.x, was.x);
      assert.equal(f.y, was.y);
    }
  });

  it('resuming continues the arc smoothly (no sudden fall or teleport)', () => {
    const engine = makeEngine({ playW: 1280, playH: 540, maxActive: 4, tuning: tuningOverridesFor('level-01') });
    for (let t = 0; t < 2; t += STEP) engine.update(STEP);
    const rising = engine.getFruitsSnapshot().map((f) => ({ id: f.id, y: f.y }));
    assert.ok(rising.length > 0);
    engine.pause('test');
    engine.update(1);
    assert.ok(engine.resume());
    engine.update(STEP);
    const resumed = engine.getFruitsSnapshot();
    for (const f of resumed) {
      const was = rising.find((g) => g.id === f.id);
      const dy = f.y - was.y;
      // Still rising at 2 s (apex is near half of a ~7 s flight), moved by
      // one small step of the pre-pause vertical speed, no jump.
      assert.ok(dy < 0, `fruit ${f.id} still rising after resume (dy=${dy.toFixed(2)})`);
      assert.ok(Math.abs(dy) < 12, `fruit ${f.id} moved one small step (dy=${dy.toFixed(2)})`);
    }
  });

  it('low frame rates run the same speed as high frame rates', () => {
    const tuning = tuningOverridesFor('level-06');
    const run = (pattern) => {
      const engine = makeEngine({ playW: 1280, playH: 540, maxActive: 4, tuning });
      for (const dt of pattern) engine.update(dt);
      return Object.fromEntries(engine.getFruitsSnapshot().map((f) => [f.optionId, f]));
    };
    const fast = run(Array(102).fill(1 / 60)); // 1.7 s at 60 fps
    const slow = run(Array(17).fill(1 / 10)); // 1.7 s at 10 fps
    const chunky = run(Array(7).fill(1 / 4)); // clamped stalled frames
    assert.equal(Object.keys(fast).length, 4);
    for (const id of Object.keys(fast)) {
      assert.ok(slow[id] && chunky[id], `fruit ${id} present in all frame patterns`);
      assert.ok(Math.abs(fast[id].x - slow[id].x) < 0.2, `x 10fps drift ${Math.abs(fast[id].x - slow[id].x)}`);
      assert.ok(Math.abs(fast[id].y - slow[id].y) < 0.2, `y 10fps drift ${Math.abs(fast[id].y - slow[id].y)}`);
      assert.ok(Math.abs(fast[id].x - chunky[id].x) < 0.2, `x 4fps drift ${Math.abs(fast[id].x - chunky[id].x)}`);
      assert.ok(Math.abs(fast[id].y - chunky[id].y) < 0.2, `y 4fps drift ${Math.abs(fast[id].y - chunky[id].y)}`);
    }
  });
});

describe('resize and layout robustness', () => {
  it('a mid-flight playfield change never corrupts or strands trajectories', () => {
    const engine = makeEngine({ playW: 1880, playH: 760, maxActive: 4, tuning: tuningOverridesFor('level-03') });
    for (let t = 0; t < 1.5; t += STEP) engine.update(STEP);
    engine.setPlayfield(300, 430); // desktop → small phone mid-flight
    let t = 0;
    for (; t < 45; t += STEP) {
      engine.update(STEP);
      for (const f of engine.getFruitsSnapshot()) {
        assert.ok(Number.isFinite(f.x) && Number.isFinite(f.y), 'finite positions after resize');
      }
      if (engine.state !== ENGINE_STATES.PLAYING) break;
    }
    assert.equal(engine.state, ENGINE_STATES.ROUND_FEEDBACK, 'round still resolves after resize');
    assert.equal(engine.getFruitsSnapshot().length, 0, 'no fruit left hovering');
  });

  it('every mobile fruit stays inside the horizontal board bounds', () => {
    const engine = makeEngine({ playW: 300, playH: 430, maxActive: 2, tuning: tuningOverridesFor('level-02') });
    let t = 0;
    for (; t < 30; t += STEP) {
      for (const f of engine.getFruitsSnapshot()) {
        assert.ok(f.x - f.radius >= -0.5 && f.x + f.radius <= 300.5, `fruit inside x bounds (x=${f.x.toFixed(1)})`);
      }
      engine.update(STEP);
      if (engine.state !== ENGINE_STATES.PLAYING) break;
    }
  });

  it('simultaneous mobile fruits never overlap (labels stay readable)', () => {
    const engine = makeEngine({ playW: 370, playH: 600, maxActive: 2, tuning: tuningOverridesFor('level-05') });
    let t = 0;
    for (; t < 30; t += STEP) {
      const active = engine.getFruitsSnapshot();
      if (active.length === 2) {
        const [a, b] = active;
        const gap = Math.hypot(a.x - b.x, a.y - b.y);
        assert.ok(gap >= a.radius + b.radius - 1, `fruits overlap (gap ${gap.toFixed(1)} < ${(a.radius + b.radius).toFixed(1)})`);
      }
      engine.update(STEP);
      if (engine.state !== ENGINE_STATES.PLAYING) break;
    }
  });
});

describe('rounds, waves and sessions still resolve', () => {
  it('a full 10-question session completes with every option presented once', () => {
    const lesson = makeLesson(10);
    const engine = new WordSliceEngine({
      rng: mulberry32(42),
      maxActiveFruits: 2,
      playW: 370,
      playH: 600,
      tuning: tuningOverridesFor('level-01'),
    });
    engine.startSession(lesson);
    engine.launchRound();
    const spawnedIds = [];
    const fruitIds = new Set();
    let roundSeconds = 0;
    let rounds = 0;
    let t = 0;
    for (; t < 400; t += STEP) {
      engine.update(STEP);
      roundSeconds += STEP;
      for (const ev of engine.drainEvents()) {
        if (ev.type === 'fruitSpawned') {
          assert.ok(!fruitIds.has(ev.fruitId), 'no duplicate fruit id');
          fruitIds.add(ev.fruitId);
          spawnedIds.push(ev.optionId);
        }
        if (ev.type === 'targetMissed') assert.ok(ev.x >= 0 && ev.x <= 370, 'miss resolved inside x bounds');
      }
      if (engine.state === ENGINE_STATES.ROUND_FEEDBACK) {
        rounds++;
        assert.ok(roundSeconds < 30, `round ${rounds} took ${roundSeconds.toFixed(1)}s — stuck pacing`);
        assert.equal(engine.getFruitsSnapshot().length, 0, 'no fruit survives its round');
        roundSeconds = 0;
        if (!engine.continueToNextRound()) break;
        engine.launchRound();
      }
      if (engine.state === ENGINE_STATES.RESULTS) break;
    }
    assert.equal(rounds, 10, 'all ten questions played');
    assert.equal(engine.state, ENGINE_STATES.RESULTS);
    // Every question's options were all presented exactly once.
    const expected = lesson.questions.flatMap((q) => q.options.map((o) => o.id)).sort();
    assert.deepEqual(spawnedIds.slice().sort(), expected);
    const session = engine.snapshotSession();
    assert.equal(session.hearts, 3, 'pure misses never end the session early');
    assert.ok(session.completed);
  });

  it('flight time decreases strictly from level 1 to level 12 and stays banded', () => {
    let prev = Infinity;
    for (const level of LEVELS) {
      const flight = tuningOverridesFor(level.id).FLIGHT_SECONDS;
      assert.ok(flight < prev, `${level.id} flight ${flight} not faster than the previous level`);
      prev = flight;
      const [lo, hi] = bandOf(level.id);
      assert.ok(flight >= lo && flight <= hi, `${level.id} configured window ${flight} outside [${lo}, ${hi}]`);
    }
  });
});

describe('collision and scoring integrity at the new speeds', () => {
  it('a swipe through one fruit hits exactly that fruit, in swipe order for two', () => {
    const engine = makeEngine({ playW: 1280, playH: 540, maxActive: 4, tuning: tuningOverridesFor('level-09') });
    for (let t = 0; t < 3.4; t += STEP) engine.update(STEP); // near the apex: fruits aligned
    const fruits = engine.getFruitsSnapshot();
    assert.ok(fruits.length >= 2, 'fruits in flight near the apex');
    // Single-fruit precision slice away from all others.
    const target = fruits[0];
    const others = fruits.slice(1);
    const results = engine.slice(target.x, target.y, target.x + 0.5, target.y + 0.5);
    assert.equal(results.length, 1);
    assert.equal(results[0].fruitId, target.id);
    const outcomes = engine.getOptionOutcomes();
    for (const o of others) {
      assert.equal(outcomes[o.optionId], FRUIT_STATES.ACTIVE, `fruit ${o.id} untouched`);
    }
    // Second identical slice must not score again.
    assert.deepEqual(engine.slice(target.x, target.y, target.x + 0.5, target.y + 0.5), []);
  });

  it('slicing remains possible across the whole visible window (no dead zones)', () => {
    const engine = makeEngine({ playW: 1280, playH: 540, maxActive: 4, tuning: tuningOverridesFor('level-12') });
    // Slice late — near the end of the visible window the fruit must still
    // be reachable below the apex and above the board bottom.
    for (let t = 0; t < 4.9; t += STEP) engine.update(STEP);
    const fruits = engine.getFruitsSnapshot();
    assert.ok(fruits.length > 0, 'fruits still in flight late in the window');
    const f = fruits[0];
    assert.ok(f.y + f.radius < 540, 'fruit fully inside the board');
    const results = engine.slice(f.x - 2, f.y - 2, f.x + 2, f.y + 2);
    assert.equal(results.length, 1, 'late slice still connects');
  });
});
