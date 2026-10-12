/**
 * Word Slice — gameplay engine.
 *
 * Pure logic module: no DOM, no CSS, no storage, no images, no browser
 * timers, no event objects. The browser layer (js/game.js) feeds pointer
 * segments and frame deltas in, and renders snapshots out.
 *
 * Time is advanced exclusively through `update(dtSeconds)`, which runs a
 * fixed-timestep simulation (SIM_STEP) behind a bounded accumulator, so
 * 30/60/120 fps frame partitions of the same elapsed time produce
 * equivalent motion.
 *
 * Randomness comes from an injected `rng` function or a `seed`
 * (mulberry32). Nothing in this file calls Math.random or Date.now.
 */

export const ENGINE_STATES = Object.freeze({
  IDLE: 'IDLE',
  ROUND_READY: 'ROUND_READY',
  PLAYING: 'PLAYING',
  ROUND_FEEDBACK: 'ROUND_FEEDBACK',
  PAUSED: 'PAUSED',
  RESULTS: 'RESULTS',
});

/** Lifecycle of a question option (and of its fruit once spawned). */
export const FRUIT_STATES = Object.freeze({
  QUEUED: 'QUEUED',
  ACTIVE: 'ACTIVE',
  HIT_CORRECT: 'HIT_CORRECT',
  HIT_WRONG: 'HIT_WRONG',
  MISSED_CORRECT: 'MISSED_CORRECT',
  AVOIDED_DISTRACTOR: 'AVOIDED_DISTRACTOR',
  INTERRUPTED: 'INTERRUPTED',
  NOT_PRESENTED: 'NOT_PRESENTED',
});

/** Outcomes that end an option's participation in a round. */
const TERMINAL_STATES = new Set([
  FRUIT_STATES.HIT_CORRECT,
  FRUIT_STATES.HIT_WRONG,
  FRUIT_STATES.MISSED_CORRECT,
  FRUIT_STATES.AVOIDED_DISTRACTOR,
  FRUIT_STATES.INTERRUPTED,
  FRUIT_STATES.NOT_PRESENTED,
]);

/**
 * All gameplay tuning in one place. Override per instance via the engine
 * constructor's `tuning` option (merged shallowly); tests use this to run
 * fast simulations.
 */
export const TUNING = Object.freeze({
  // Simulation timing.
  SIM_STEP: 1 / 60,             // fixed simulation step (seconds)
  MAX_FRAME_DELTA: 0.25,        // clamp for one update() call (stalled frame)
  MAX_STEPS_PER_FRAME: 16,      // bound on catch-up work per update() call

  // Session shape.
  SESSION_QUESTIONS: 10,
  STARTING_HEARTS: 3,
  BASE_POINTS: 10,
  PASS_SUCCESSFUL_ROUNDS: 8,    // out of SESSION_QUESTIONS

  // Waves.
  DESKTOP_MAX_ACTIVE: 4,        // max simultaneous answer fruits (desktop)
  MOBILE_MAX_ACTIVE: 2,         // max simultaneous answer fruits (mobile)
  WAVE_GAP: 0.45,               // seconds after a wave clears before the next
  SPAWN_STAGGER: 0.12,          // seconds between fruits inside one wave

  // Fruit motion (all derived from playfield size at spawn time).
  FLIGHT_SECONDS: 3.4,          // target useful visibility per fruit
  FLIGHT_JITTER_RATIO: 0.08,    // ± fraction of FLIGHT_SECONDS
  APEX_TARGET_RATIO: 0.26,      // apex at this fraction of playfield height
  APEX_JITTER_RATIO: 0.05,      // ± fraction of playfield height
  EXIT_MARGIN_RATIO: 0.05,      // extra depth below the board before exit resolves
  LANE_RADIUS_RATIO: 0.42,      // fruit radius = lane width × this
  RADIUS_MIN: 30,
  RADIUS_MAX: 62,
  LANE_JITTER_RATIO: 0.05,      // spawn x jitter, fraction of lane width
  MAX_DRIFT_RATIO: 0.05,        // |vx| ≤ lane width × this per second
  SPIN_DEG_PER_S: 80,           // max |angular velocity|

  // Placeholder appearances (independent of correctness).
  APPEARANCES: ['watermelon', 'pineapple', 'apple', 'orange', 'strawberry', 'blueberry', 'banana', 'pear', 'lemon', 'kiwi'],

  MAX_EVENTS: 64,               // bounded event queue
});

/**
 * Deterministic PRNG (mulberry32). Returns floats in [0, 1).
 * @param {number} seed
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher–Yates shuffle of a copy. Never mutates the input list.
 * @template T
 * @param {readonly T[]} list
 * @param {() => number} rng
 * @returns {T[]}
 */
export function shuffleCopy(list, rng) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}

/**
 * Score multiplier for the streak AFTER the current correct answer.
 * Streak 1–2 → ×1, 3–5 → ×2, 6+ → ×3.
 * @param {number} streak
 */
export function calcMultiplier(streak) {
  if (streak >= 6) return 3;
  if (streak >= 3) return 2;
  return 1;
}

/**
 * Segment-to-circle intersection.
 *
 * Finds the closest point on segment (x1,y1)→(x2,y2) to the circle center
 * and compares squared distance with the squared radius. `t` is the
 * position of that closest point along the segment (0 at the start, 1 at
 * the end), used to order multiple hits along the swipe direction.
 * Zero-length segments are handled as point-in-circle tests.
 *
 * @returns {{t: number, x: number, y: number} | null} null when no hit.
 */
export function segmentCircle(x1, y1, x2, y2, cx, cy, r) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((cx - x1) * dx + (cy - y1) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const px = x1 + t * dx;
  const py = y1 + t * dy;
  const ddx = cx - px;
  const ddy = cy - py;
  if (ddx * ddx + ddy * ddy > r * r) return null;
  return { t, x: px, y: py };
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/**
 * Validates a question bank structure before Play is enabled.
 *
 * @param {unknown} data parsed JSON
 * @param {{supportedSchemaVersions?: number[], supportedQuestionTypes?: string[], sessionQuestionCount?: number}} [opts]
 * @returns {{ok: boolean, errors: string[]}} errors identify the affected lesson/question.
 */
export function validateQuestionBank(data, opts = {}) {
  const supportedSchemaVersions = opts.supportedSchemaVersions ?? [1];
  const supportedQuestionTypes = opts.supportedQuestionTypes ?? ['category'];
  const sessionQuestionCount = opts.sessionQuestionCount ?? TUNING.SESSION_QUESTIONS;
  const errors = [];
  const fail = (msg) => errors.push(msg);

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, errors: ['Question bank: top level is not an object.'] };
  }
  const schema = /** @type {any} */ (data).schemaVersion;
  if (!supportedSchemaVersions.includes(schema)) {
    fail(`Question bank: unsupported schemaVersion ${JSON.stringify(schema)} (supported: ${supportedSchemaVersions.join(', ')}).`);
  }
  const lessons = /** @type {any} */ (data).lessons;
  if (!Array.isArray(lessons) || lessons.length === 0) {
    fail('Question bank: "lessons" must be a non-empty array.');
    return { ok: false, errors };
  }

  const lessonIds = new Set();
  lessons.forEach((lesson, li) => {
    const where = `lessons[${li}]`;
    if (!lesson || typeof lesson !== 'object') {
      fail(`${where}: not an object.`);
      return;
    }
    if (typeof lesson.id !== 'string' || !lesson.id.trim()) {
      fail(`${where}: missing lesson id.`);
    } else if (lessonIds.has(lesson.id)) {
      fail(`${where} (id="${lesson.id}"): duplicate lesson id.`);
    } else {
      lessonIds.add(lesson.id);
    }
    if (typeof lesson.title !== 'string' || !lesson.title.trim()) {
      fail(`${where} (id="${lesson.id}"): missing lesson title.`);
    }
    if (!Array.isArray(lesson.questions)) {
      fail(`${where} (id="${lesson.id}"): "questions" must be an array.`);
      return;
    }
    if (lesson.questions.length < sessionQuestionCount) {
      fail(`${where} (id="${lesson.id}"): needs at least ${sessionQuestionCount} questions for a session, found ${lesson.questions.length}.`);
    }
  });

  const questionIds = new Set();
  lessons.forEach((lesson, li) => {
    if (!lesson || !Array.isArray(lesson.questions)) return;
    lesson.questions.forEach((question, qi) => {
      const where = `lessons[${li}].questions[${qi}]`;
      if (!question || typeof question !== 'object') {
        fail(`${where}: not an object.`);
        return;
      }
      const qid = typeof question.id === 'string' && question.id.trim() ? question.id : '(missing)';
      if (typeof question.id !== 'string' || !question.id.trim()) {
        fail(`${where}: missing question id.`);
      } else if (questionIds.has(question.id)) {
        fail(`${where} (id="${question.id}"): duplicate question id.`);
      } else {
        questionIds.add(question.id);
      }
      if (!supportedQuestionTypes.includes(question.type)) {
        fail(`${where} (id="${qid}"): unsupported question type ${JSON.stringify(question.type)} (supported: ${supportedQuestionTypes.join(', ')}).`);
      }
      if (typeof question.prompt !== 'string' || !question.prompt.trim()) {
        fail(`${where} (id="${qid}"): empty prompt.`);
      }
      if (typeof question.explanation !== 'string' || !question.explanation.trim()) {
        fail(`${where} (id="${qid}"): empty explanation.`);
      }

      if (!Array.isArray(question.options) || question.options.length < 2) {
        fail(`${where} (id="${qid}"): needs at least 2 options.`);
        return;
      }
      const optionIds = new Set();
      const optionTexts = new Set();
      question.options.forEach((option, oi) => {
        const ow = `${where}.options[${oi}]`;
        if (!option || typeof option !== 'object') {
          fail(`${ow}: not an object.`);
          return;
        }
        if (typeof option.id !== 'string' || !option.id.trim()) {
          fail(`${ow}: missing option id.`);
        } else if (optionIds.has(option.id)) {
          fail(`${ow} (id="${option.id}"): duplicate option id in question "${qid}".`);
        } else {
          optionIds.add(option.id);
        }
        if (typeof option.text !== 'string' || !option.text.trim()) {
          fail(`${ow} (id="${option.id}"): empty option text.`);
        } else {
          const normalized = option.text.trim().toLowerCase();
          if (optionTexts.has(normalized)) {
            fail(`${ow}: duplicate option text "${option.text}" after trimming/normalizing.`);
          }
          optionTexts.add(normalized);
        }
      });

      const correct = question.correctOptionIds;
      if (!Array.isArray(correct) || correct.length === 0) {
        fail(`${where} (id="${qid}"): needs at least one correct option id.`);
        return;
      }
      const correctSet = new Set(correct);
      if (correctSet.size !== correct.length) {
        fail(`${where} (id="${qid}"): duplicate correct option ids.`);
      }
      for (const id of correct) {
        if (!optionIds.has(id)) {
          fail(`${where} (id="${qid}"): correct option id "${id}" does not match any option.`);
        }
      }
      if (correctSet.size >= question.options.length) {
        fail(`${where} (id="${qid}"): needs at least one distractor option.`);
      }
    });
  });

  return { ok: errors.length === 0, errors };
}

/**
 * The gameplay engine. See file docs. All coordinates are playfield-local
 * CSS pixels with the origin at the top-left of the playable rectangle;
 * the browser layer supplies the actual size.
 */
export class WordSliceEngine {
  /**
   * @param {{rng?: () => number, seed?: number, maxActiveFruits?: number, playW?: number, playH?: number, tuning?: object}} [options]
   */
  constructor(options = {}) {
    this.tuning = { ...TUNING, ...(options.tuning || {}) };
    this.rng = typeof options.rng === 'function' ? options.rng : mulberry32((options.seed ?? 1) >>> 0);
    this.playW = 0;
    this.playH = 0;
    this.maxActiveFruits = clamp(Math.round(options.maxActiveFruits ?? this.tuning.DESKTOP_MAX_ACTIVE), 1, 6);
    this.state = ENGINE_STATES.IDLE;
    this.session = null;
    this.round = null;
    this.simTime = 0;
    this.accumulator = 0;
    this.events = [];
    this._lesson = null;
    this._pausedFrom = null;
    this._ids = { session: 0, fruit: 0 };
    if (Number.isFinite(options.playW) && Number.isFinite(options.playH)) {
      this.setPlayfield(options.playW, options.playH);
    }
  }

  /** @returns {{w: number, h: number}} current playfield size in CSS pixels. */
  get playfield() {
    return { w: this.playW, h: this.playH };
  }

  /**
   * Set the playable rectangle. Ignored when the values are not finite
   * positive numbers; a zero-sized playfield never receives spawns.
   */
  setPlayfield(w, h) {
    const W = Number(w);
    const H = Number(h);
    if (Number.isFinite(W) && W >= 0) this.playW = W;
    if (Number.isFinite(H) && H >= 0) this.playH = H;
  }

  /** Sets the maximum simultaneously active answer fruits (2 mobile / 4 desktop). */
  setMaxActiveFruits(n) {
    const v = Math.round(Number(n));
    if (Number.isFinite(v)) this.maxActiveFruits = clamp(v, 1, 6);
  }

  /** @private */
  emit(type, payload = {}) {
    this.events.push({ type, ...payload });
    if (this.events.length > this.tuning.MAX_EVENTS) {
      this.events.splice(0, this.events.length - this.tuning.MAX_EVENTS);
    }
  }

  /** Returns and clears queued events (bounded, drainable). */
  drainEvents() {
    return this.events.splice(0);
  }

  /**
   * Starts a session of `SESSION_QUESTIONS` questions selected without
   * replacement from the lesson. Returns a session snapshot, or null when
   * a session is already active (starting twice never creates two).
   */
  startSession(lesson) {
    if (this.state !== ENGINE_STATES.IDLE && this.state !== ENGINE_STATES.RESULTS) return null;
    if (!lesson || !Array.isArray(lesson.questions) || lesson.questions.length < this.tuning.SESSION_QUESTIONS) {
      throw new Error(`Lesson "${lesson && lesson.id}" needs at least ${this.tuning.SESSION_QUESTIONS} questions.`);
    }
    this._lesson = lesson;
    this.session = {
      id: `s${++this._ids.session}`,
      lessonId: lesson.id,
      lessonTitle: lesson.title,
      questions: shuffleCopy(lesson.questions, this.rng).slice(0, this.tuning.SESSION_QUESTIONS),
      questionIndex: 0,
      score: 0,
      hearts: this.tuning.STARTING_HEARTS,
      streak: 0,
      multiplier: 1,
      bestStreak: 0,
      metrics: { correctSlices: 0, wrongSlices: 0, missedTargets: 0, avoidedDistractors: 0 },
      successfulRounds: 0,
      completedRounds: 0,
      rounds: [],
      endedEarly: false,
      completed: false,
      resultsFinalized: false,
    };
    this.round = null;
    this.events = [];
    this.accumulator = 0;
    this.simTime = 0;
    this._prepareRound();
    this.emit('sessionStarted', { sessionId: this.session.id, questionCount: this.session.questions.length });
    return this.snapshotSession();
  }

  /**
   * Abandons any active session and immediately starts a fresh one from
   * the same lesson. Clears fruits, pending schedules and events; input
   * history lives in the browser layer, which clears it on this event.
   */
  restartSession() {
    if (!this._lesson) return null;
    this.state = ENGINE_STATES.IDLE;
    this.session = null;
    this.round = null;
    this.events = [];
    this.accumulator = 0;
    return this.startSession(this._lesson);
  }

  /** Leaves gameplay entirely: no active session, no active objects. */
  abandonToMenu() {
    this.state = ENGINE_STATES.IDLE;
    this.session = null;
    this.round = null;
    this.events = [];
    this.accumulator = 0;
    this._pausedFrom = null;
  }

  /** @private */
  _prepareRound() {
    const s = this.session;
    const question = s.questions[s.questionIndex];
    const round = {
      id: `r-${s.id}-${s.questionIndex + 1}`,
      question,
      roundIndex: s.questionIndex,
      correctIds: new Set(question.correctOptionIds),
      // Full option list shuffled ONCE at preparation; waves are chunks of it.
      optionOrder: shuffleCopy(question.options, this.rng),
      outcomes: new Map(question.options.map((o) => [o.id, FRUIT_STATES.QUEUED])),
      waves: [],
      pending: [],
      fruits: new Map(),
      waveIndex: -1,
      waveClearAt: null,
      launched: false,
      completed: false,
      successful: false,
      checkpoint: null,
    };
    this.round = round;
    this.state = ENGINE_STATES.ROUND_READY;
    this.emit('roundReady', {
      roundId: round.id,
      questionId: question.id,
      roundIndex: round.roundIndex,
      questionNumber: s.questionIndex + 1,
      questionTotal: s.questions.length,
      prompt: question.prompt,
      plannedWaveCount: Math.ceil(question.options.length / this.maxActiveFruits),
    });
  }

  /**
   * Launches the prepared round: takes the resize checkpoint, chunks the
   * shuffled options into waves and schedules wave 1. Only valid from
   * ROUND_READY with a non-degenerate playfield; a second call is a no-op.
   */
  launchRound() {
    if (this.state !== ENGINE_STATES.ROUND_READY || !this.round) return false;
    if (this.playW <= 0 || this.playH <= 0) return false;
    const s = this.session;
    const r = this.round;
    // Checkpoint: pre-launch score/hearts/streak/metrics for resize recovery.
    r.checkpoint = {
      score: s.score,
      hearts: s.hearts,
      streak: s.streak,
      multiplier: s.multiplier,
      bestStreak: s.bestStreak,
      metrics: { ...s.metrics },
    };
    r.waves = chunk(r.optionOrder, this.maxActiveFruits);
    r.launched = true;
    this.state = ENGINE_STATES.PLAYING;
    this._scheduleWave(0);
    this.emit('roundLaunched', { roundId: r.id, waveCount: r.waves.length });
    return true;
  }

  /** @private */
  _scheduleWave(index) {
    const r = this.round;
    r.waveIndex = index;
    r.waveClearAt = null;
    // Lane geometry adapts if maxActiveFruits changed after the waves were
    // chunked (e.g. a resize happened without round recovery).
    const laneCount = Math.max(this.maxActiveFruits, r.waves[index].length);
    const lanes = shuffleCopy(Array.from({ length: laneCount }, (_, i) => i), this.rng);
    r.waves[index].forEach((option, k) => {
      r.pending.push({
        option,
        waveIndex: index,
        lane: lanes[k],
        at: this.simTime + k * this.tuning.SPAWN_STAGGER,
      });
    });
    this.emit('waveStarted', { roundId: r.id, wave: index + 1, total: r.waves.length });
  }

  /** @private */
  _spawnFruit(entry) {
    const t = this.tuning;
    const r = this.round;
    const laneW = this.playW / this.maxActiveFruits;
    const laneCx = (entry.lane + 0.5) * laneW;
    const radius = clamp(laneW * t.LANE_RADIUS_RATIO, t.RADIUS_MIN, t.RADIUS_MAX);
    const jitter = (this.rng() * 2 - 1) * t.LANE_JITTER_RATIO * laneW;
    const x = clamp(laneCx + jitter, radius, Math.max(radius, this.playW - radius));
    const y0 = this.playH + radius + 6;
    const apex = clamp(
      this.playH * t.APEX_TARGET_RATIO + (this.rng() * 2 - 1) * t.APEX_JITTER_RATIO * this.playH,
      radius * 1.35,
      this.playH * 0.55
    );
    const flight = t.FLIGHT_SECONDS * (1 + (this.rng() * 2 - 1) * t.FLIGHT_JITTER_RATIO);
    const rise = Math.max(1, y0 - apex);
    const id = `f${++this._ids.fruit}`;
    const fruit = {
      id,
      sessionId: this.session.id,
      roundId: r.id,
      optionId: entry.option.id,
      optionText: entry.option.text,
      appearanceId: t.APPEARANCES[this._ids.fruit % t.APPEARANCES.length],
      x,
      y: y0,
      prevX: x,
      prevY: y0,
      vx: (this.rng() * 2 - 1) * laneW * t.MAX_DRIFT_RATIO,
      vy: -4 * rise / flight,
      gravity: 8 * rise / (flight * flight),
      radius,
      rotation: 0,
      angularVelocity: (this.rng() * 2 - 1) * t.SPIN_DEG_PER_S,
      state: FRUIT_STATES.ACTIVE,
      entered: false,
      waveIndex: entry.waveIndex,
    };
    r.fruits.set(id, fruit);
    r.outcomes.set(entry.option.id, FRUIT_STATES.ACTIVE);
    this.emit('fruitSpawned', {
      fruitId: id,
      optionId: entry.option.id,
      optionText: entry.option.text,
      roundId: r.id,
      waveIndex: entry.waveIndex,
      x,
      y: y0,
      radius,
    });
  }

  /**
   * Advances simulation time by `dtSeconds` using fixed SIM_STEP steps
   * behind a bounded accumulator. Paused/hidden time never enters the
   * simulation: while the engine is not PLAYING, dt is discarded.
   * Non-finite or negative deltas are ignored; oversized deltas are
   * clamped to MAX_FRAME_DELTA so a stalled frame cannot spiral.
   */
  update(dtSeconds) {
    if (this.state !== ENGINE_STATES.PLAYING) return;
    let dt = Number(dtSeconds);
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    if (dt > this.tuning.MAX_FRAME_DELTA) dt = this.tuning.MAX_FRAME_DELTA;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= this.tuning.SIM_STEP && steps < this.tuning.MAX_STEPS_PER_FRAME) {
      this._step(this.tuning.SIM_STEP);
      steps++;
      if (this.state !== ENGINE_STATES.PLAYING) {
        this.accumulator = 0;
        return;
      }
      this.accumulator -= this.tuning.SIM_STEP;
    }
    if (steps >= this.tuning.MAX_STEPS_PER_FRAME) this.accumulator = 0;
  }

  /** @private one fixed simulation step */
  _step(dt) {
    this.simTime += dt;
    const r = this.round;
    if (!r) return;
    const t = this.tuning;

    // Spawn scheduled fruits.
    for (let i = r.pending.length - 1; i >= 0; i--) {
      if (r.pending[i].at <= this.simTime) {
        const entry = r.pending.splice(i, 1)[0];
        this._spawnFruit(entry);
      }
    }

    // Integrate active fruits.
    const exitLine = this.playH + this.playH * t.EXIT_MARGIN_RATIO;
    for (const f of r.fruits.values()) {
      if (f.state !== FRUIT_STATES.ACTIVE) continue;
      f.prevX = f.x;
      f.prevY = f.y;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.vy += f.gravity * dt;
      f.rotation = (f.rotation + f.angularVelocity * dt) % 360;
      if (f.x - f.radius < 0 && f.vx < 0) {
        f.x = f.radius;
        f.vx = -f.vx;
      } else if (f.x + f.radius > this.playW && f.vx > 0) {
        f.x = this.playW - f.radius;
        f.vx = -f.vx;
      }
      if (!f.entered && f.y <= this.playH) f.entered = true;
      // A falling exit resolves only after the fruit has entered the
      // playfield — the initial off-screen launch position is never a miss.
      if (f.vy > 0 && f.y - f.radius > exitLine && f.entered) {
        this._resolveExit(f);
      }
    }

    // Wave clearing and scheduling.
    if (r.waveIndex >= 0 && r.waveClearAt === null) {
      const cleared = r.waves[r.waveIndex].every((o) => TERMINAL_STATES.has(r.outcomes.get(o.id)));
      if (cleared) r.waveClearAt = this.simTime;
    }
    if (
      r.waveClearAt !== null &&
      this.simTime >= r.waveClearAt + t.WAVE_GAP &&
      r.waveIndex + 1 < r.waves.length
    ) {
      this._scheduleWave(r.waveIndex + 1);
    }

    // A round completes only when every scheduled option reached a
    // terminal outcome (never immediately after the last correct slice).
    if (r.pending.length === 0 && [...r.outcomes.values()].every((st) => TERMINAL_STATES.has(st))) {
      this._finishRound();
    }
  }

  /** @private fruit fell out of the board without being sliced */
  _resolveExit(f) {
    const r = this.round;
    const s = this.session;
    if (r.correctIds.has(f.optionId)) {
      f.state = FRUIT_STATES.MISSED_CORRECT;
      r.outcomes.set(f.optionId, FRUIT_STATES.MISSED_CORRECT);
      s.streak = 0;
      s.multiplier = 1;
      s.metrics.missedTargets++;
      this.emit('targetMissed', { fruitId: f.id, optionId: f.optionId, optionText: f.optionText, x: f.x, y: f.y });
    } else {
      f.state = FRUIT_STATES.AVOIDED_DISTRACTOR;
      r.outcomes.set(f.optionId, FRUIT_STATES.AVOIDED_DISTRACTOR);
      s.metrics.avoidedDistractors++;
      this.emit('distractorAvoided', { fruitId: f.id, optionId: f.optionId, optionText: f.optionText, x: f.x, y: f.y });
    }
  }

  /**
   * Processes a swipe segment (playfield-local coordinates). Hits are
   * collected against every ACTIVE fruit of the current round, then
   * resolved deterministically in order along the swipe direction (t
   * ascending). Processing stops immediately when the final heart is
   * lost. Returns the resolutions that were applied (possibly empty).
   *
   * @returns {Array<{fruitId: string, optionId: string, optionText: string, correct: boolean, points: number, hearts: number, streak: number, multiplier: number}>}
   */
  slice(x1, y1, x2, y2) {
    if (this.state !== ENGINE_STATES.PLAYING || !this.round) return [];
    const hits = [];
    for (const f of this.round.fruits.values()) {
      if (f.state !== FRUIT_STATES.ACTIVE) continue;
      const hit = segmentCircle(x1, y1, x2, y2, f.x, f.y, f.radius);
      if (hit) hits.push({ f, t: hit.t });
    }
    if (hits.length === 0) return [];
    hits.sort((a, b) => a.t - b.t);
    const results = [];
    for (const { f } of hits) {
      if (this.state !== ENGINE_STATES.PLAYING) break;
      if (f.state !== FRUIT_STATES.ACTIVE) continue;
      results.push(this._resolveHit(f));
    }
    return results;
  }

  /** @private */
  _resolveHit(f) {
    const s = this.session;
    const r = this.round;
    if (r.correctIds.has(f.optionId)) {
      f.state = FRUIT_STATES.HIT_CORRECT;
      r.outcomes.set(f.optionId, FRUIT_STATES.HIT_CORRECT);
      s.streak++;
      if (s.streak > s.bestStreak) s.bestStreak = s.streak;
      s.multiplier = calcMultiplier(s.streak);
      const points = this.tuning.BASE_POINTS * s.multiplier;
      s.score += points;
      s.metrics.correctSlices++;
      this.emit('correctSlice', {
        fruitId: f.id,
        optionId: f.optionId,
        optionText: f.optionText,
        points,
        streak: s.streak,
        multiplier: s.multiplier,
        score: s.score,
        x: f.x,
        y: f.y,
      });
      return {
        fruitId: f.id,
        optionId: f.optionId,
        optionText: f.optionText,
        correct: true,
        points,
        hearts: s.hearts,
        streak: s.streak,
        multiplier: s.multiplier,
      };
    }
    f.state = FRUIT_STATES.HIT_WRONG;
    r.outcomes.set(f.optionId, FRUIT_STATES.HIT_WRONG);
    s.hearts = Math.max(0, s.hearts - 1);
    s.streak = 0;
    s.multiplier = 1;
    s.metrics.wrongSlices++;
    this.emit('wrongSlice', {
      fruitId: f.id,
      optionId: f.optionId,
      optionText: f.optionText,
      hearts: s.hearts,
      score: s.score,
      x: f.x,
      y: f.y,
    });
    if (s.hearts === 0) this._gameOverFromHearts();
    return {
      fruitId: f.id,
      optionId: f.optionId,
      optionText: f.optionText,
      correct: false,
      points: 0,
      hearts: s.hearts,
      streak: s.streak,
      multiplier: s.multiplier,
    };
  }

  /**
   * Hearts reached zero: the heart penalty has already been applied once.
   * Stops spawning and slicing, keeps resolved outcomes, marks remaining
   * ACTIVE options INTERRUPTED and never-launched options NOT_PRESENTED
   * (neither counts as missed), then finalizes results once.
   * @private
   */
  _gameOverFromHearts() {
    const r = this.round;
    r.pending.length = 0;
    for (const f of r.fruits.values()) {
      if (f.state === FRUIT_STATES.ACTIVE) {
        f.state = FRUIT_STATES.INTERRUPTED;
        r.outcomes.set(f.optionId, FRUIT_STATES.INTERRUPTED);
      }
    }
    for (const [id, st] of r.outcomes) {
      if (st === FRUIT_STATES.QUEUED) r.outcomes.set(id, FRUIT_STATES.NOT_PRESENTED);
    }
    r.completed = false;
    r.successful = false;
    this.session.endedEarly = true;
    this._finalize();
  }

  /** @private */
  _finishRound() {
    const r = this.round;
    const s = this.session;
    r.completed = true;
    r.successful =
      r.question.correctOptionIds.every((id) => r.outcomes.get(id) === FRUIT_STATES.HIT_CORRECT) &&
      ![...r.outcomes.values()].some((st) => st === FRUIT_STATES.HIT_WRONG);
    s.completedRounds++;
    if (r.successful) s.successfulRounds++;
    s.rounds.push(this.getRoundReport());
    this.state = ENGINE_STATES.ROUND_FEEDBACK;
    this.emit('roundCompleted', { roundId: r.id, roundIndex: r.roundIndex, successful: r.successful, report: this.getRoundReport() });
  }

  /**
   * Continues from ROUND_FEEDBACK to the next question, or finalizes the
   * session when the last question is done. Repeated calls are no-ops.
   * @returns {boolean} true when an advance happened.
   */
  continueToNextRound() {
    if (this.state !== ENGINE_STATES.ROUND_FEEDBACK) return false;
    const s = this.session;
    s.questionIndex++;
    if (s.questionIndex >= s.questions.length) {
      this._finalize();
      return true;
    }
    this._prepareRound();
    return true;
  }

  /** @private */
  _finalize() {
    const s = this.session;
    if (s.resultsFinalized) return;
    s.resultsFinalized = true;
    if (!s.endedEarly) s.completed = true;
    this.state = ENGINE_STATES.RESULTS;
    this.emit('sessionEnded', {
      sessionId: s.id,
      endedEarly: s.endedEarly,
      completed: s.completed,
      report: this.getSessionReport(),
    });
  }

  /**
   * Pauses from PLAYING or ROUND_READY, remembering the interrupted
   * state. While paused, update() discards time (no catch-up on resume).
   */
  pause(reason = 'user') {
    if (this.state === ENGINE_STATES.PLAYING || this.state === ENGINE_STATES.ROUND_READY) {
      this._pausedFrom = this.state;
      this.state = ENGINE_STATES.PAUSED;
      this.emit('paused', { reason });
      return true;
    }
    return false;
  }

  /** Resumes into the remembered state. Only meaningful after pause(). */
  resume() {
    if (this.state !== ENGINE_STATES.PAUSED) return false;
    this.state = this._pausedFrom || ENGINE_STATES.ROUND_READY;
    this._pausedFrom = null;
    this.emit('resumed', {});
    return true;
  }

  /**
   * Resize recovery for a launched round: restores the pre-launch score,
   * hearts, streak, multiplier and metrics from the round checkpoint,
   * clears fruits/schedules/answer records and returns to ROUND_READY so
   * the player can relaunch the same question on the new playfield.
   * Completed rounds are untouched. No points or penalties from the
   * discarded attempt survive.
   */
  recoverRound() {
    if (!this.session || !this.round) return false;
    const launched = this.round.launched;
    const inFlight =
      this.state === ENGINE_STATES.PLAYING ||
      (this.state === ENGINE_STATES.PAUSED && this._pausedFrom === ENGINE_STATES.PLAYING);
    if (!launched || !inFlight) return false;
    if (this.state === ENGINE_STATES.PAUSED) this.state = this._pausedFrom;
    this._pausedFrom = null;
    const s = this.session;
    const r = this.round;
    const cp = r.checkpoint;
    s.score = cp.score;
    s.hearts = cp.hearts;
    s.streak = cp.streak;
    s.multiplier = cp.multiplier;
    s.bestStreak = cp.bestStreak;
    s.metrics = { ...cp.metrics };
    r.fruits.clear();
    r.pending.length = 0;
    r.waves = [];
    r.waveIndex = -1;
    r.waveClearAt = null;
    r.launched = false;
    for (const id of r.outcomes.keys()) r.outcomes.set(id, FRUIT_STATES.QUEUED);
    this.accumulator = 0;
    this.state = ENGINE_STATES.ROUND_READY;
    this.emit('roundRecovered', { roundId: r.id, roundIndex: r.roundIndex });
    return true;
  }

  /** ACTIVE fruits of the current round, copied for rendering. */
  getFruitsSnapshot() {
    if (!this.round) return [];
    const out = [];
    for (const f of this.round.fruits.values()) {
      if (f.state !== FRUIT_STATES.ACTIVE) continue;
      out.push({
        id: f.id,
        optionId: f.optionId,
        x: f.x,
        y: f.y,
        radius: f.radius,
        rotation: f.rotation,
        appearanceId: f.appearanceId,
        optionText: f.optionText,
      });
    }
    return out;
  }

  /** HUD-facing state. */
  getHudState() {
    if (!this.session) {
      return { state: this.state, questionNumber: 0, questionTotal: 0, prompt: '', score: 0, hearts: 0, maxHearts: this.tuning.STARTING_HEARTS, streak: 0, multiplier: 1, wave: null };
    }
    const s = this.session;
    const r = this.round;
    return {
      state: this.state,
      questionNumber: Math.min(s.questionIndex + 1, s.questions.length),
      questionTotal: s.questions.length,
      prompt: r ? r.question.prompt : '',
      score: s.score,
      hearts: s.hearts,
      maxHearts: this.tuning.STARTING_HEARTS,
      streak: s.streak,
      multiplier: s.multiplier,
      elapsed: this.simTime,
      wave:
        r && r.launched && r.waves.length > 1 && this.state === ENGINE_STATES.PLAYING
          ? { current: Math.max(1, r.waveIndex + 1), total: r.waves.length }
          : null,
    };
  }

  /** Plain copy of session-level state for tests and persistence. */
  snapshotSession() {
    if (!this.session) return null;
    const s = this.session;
    return {
      id: s.id,
      lessonId: s.lessonId,
      lessonTitle: s.lessonTitle,
      questionIds: s.questions.map((q) => q.id),
      questionIndex: s.questionIndex,
      score: s.score,
      hearts: s.hearts,
      streak: s.streak,
      multiplier: s.multiplier,
      bestStreak: s.bestStreak,
      metrics: { ...s.metrics },
      successfulRounds: s.successfulRounds,
      completedRounds: s.completedRounds,
      endedEarly: s.endedEarly,
      completed: s.completed,
      resultsFinalized: s.resultsFinalized,
    };
  }

  /** Current round's optionId → outcome map (read-only copy). */
  getOptionOutcomes() {
    if (!this.round) return null;
    return Object.fromEntries(this.round.outcomes);
  }

  /** Structured report for the round feedback screen. */
  getRoundReport() {
    if (!this.round) return null;
    const r = this.round;
    const q = r.question;
    const textOf = (id) => {
      const o = q.options.find((opt) => opt.id === id);
      return o ? o.text : id;
    };
    const byOutcome = (st) => [...r.outcomes.entries()].filter(([, s]) => s === st).map(([id]) => textOf(id));
    return {
      roundId: r.id,
      questionId: q.id,
      prompt: q.prompt,
      explanation: q.explanation,
      roundIndex: r.roundIndex,
      questionNumber: r.roundIndex + 1,
      questionTotal: this.session.questions.length,
      completed: !!r.completed,
      successful: !!r.successful,
      launched: !!r.launched,
      slicedCorrect: byOutcome(FRUIT_STATES.HIT_CORRECT),
      missedCorrect: byOutcome(FRUIT_STATES.MISSED_CORRECT),
      wrongSelections: byOutcome(FRUIT_STATES.HIT_WRONG),
      avoidedCount: byOutcome(FRUIT_STATES.AVOIDED_DISTRACTOR).length,
      interrupted: byOutcome(FRUIT_STATES.INTERRUPTED),
      notPresented: byOutcome(FRUIT_STATES.NOT_PRESENTED),
    };
  }

  /**
   * Final session report. `accuracy` and `roundSuccessRate` are null when
   * the denominator is zero (render as "—"). `passStatus` is null for
   * early game overs. Mistakes are grouped per completed round with the
   * explanation shown once; interrupted/unpresented options never appear.
   */
  getSessionReport() {
    if (!this.session) return null;
    const s = this.session;
    const attempted = s.metrics.correctSlices + s.metrics.wrongSlices;
    const mistakes = [];
    for (const rep of s.rounds) {
      if (rep.wrongSelections.length > 0 || rep.missedCorrect.length > 0) {
        mistakes.push({
          questionId: rep.questionId,
          prompt: rep.prompt,
          wrongSelections: rep.wrongSelections,
          missedCorrect: rep.missedCorrect,
          explanation: rep.explanation,
        });
      }
    }
    return {
      sessionId: s.id,
      lessonId: s.lessonId,
      lessonTitle: s.lessonTitle,
      completed: s.completed,
      endedEarly: s.endedEarly,
      passStatus: s.completed ? (s.successfulRounds >= this.tuning.PASS_SUCCESSFUL_ROUNDS ? 'passed' : 'not-passed') : null,
      score: s.score,
      successfulRounds: s.successfulRounds,
      completedRounds: s.completedRounds,
      totalRounds: s.questions.length,
      correctSlices: s.metrics.correctSlices,
      wrongSlices: s.metrics.wrongSlices,
      missedTargets: s.metrics.missedTargets,
      avoidedDistractors: s.metrics.avoidedDistractors,
      bestStreak: s.bestStreak,
      accuracy: attempted > 0 ? s.metrics.correctSlices / attempted : null,
      roundSuccessRate: s.completedRounds > 0 ? s.successfulRounds / s.completedRounds : null,
      mistakes,
    };
  }
}
