/**
 * Word Slice — level system (pure module: no DOM, no storage, no fetch).
 *
 * Defines the 12-level / 3-stage progression, the supported educational
 * question types, per-level difficulty profiles (expressed as multipliers
 * the browser layer converts into engine tuning overrides), the star
 * rules, and validation for loaded level data packs.
 *
 * Stage CEFR labels ("A1/A2/B1") are educational design targets for this
 * client-only release, not externally certified assessment levels.
 */
import { TUNING, validateQuestionBank } from './engine.js';

/** Explicitly supported question types. Correctness is never inferred:
 * every question carries `correctOptionIds`, whatever its type. */
export const QUESTION_TYPES = Object.freeze({
  CATEGORY: 'category',
  GRAMMAR_IDENTIFY: 'grammar-identify',
  SENTENCE_COMPLETION: 'sentence-completion',
  WORD_MEANING: 'word-meaning',
});

export const SUPPORTED_QUESTION_TYPES = Object.freeze([
  QUESTION_TYPES.CATEGORY,
  QUESTION_TYPES.GRAMMAR_IDENTIFY,
  QUESTION_TYPES.SENTENCE_COMPLETION,
  QUESTION_TYPES.WORD_MEANING,
]);

export const STAGES = Object.freeze([
  { id: 'stage-1', name: 'Beginner', cefr: 'A1', description: 'Everyday words and easy categories.' },
  { id: 'stage-2', name: 'Elementary', cefr: 'A2', description: 'Actions, descriptions and basic grammar.' },
  { id: 'stage-3', name: 'Intermediate', cefr: 'B1', description: 'Work, verb forms and richer contexts.' },
]);

/**
 * The 12-level manifest. `questionFile` is resolved by the browser layer
 * (all levels of one stage live in the same JSON file).
 */
export const LEVELS = Object.freeze([
  { id: 'level-01', order: 1, stageId: 'stage-1', title: 'Animals & Everyday Objects', topic: 'Animals and things around you', questionFile: 'stage-1.json' },
  { id: 'level-02', order: 2, stageId: 'stage-1', title: 'Food & Drinks', topic: 'Things we eat and drink', questionFile: 'stage-1.json' },
  { id: 'level-03', order: 3, stageId: 'stage-1', title: 'School Vocabulary', topic: 'Words for the classroom', questionFile: 'stage-1.json' },
  { id: 'level-04', order: 4, stageId: 'stage-1', title: 'House & Family', topic: 'Rooms, objects and family members', questionFile: 'stage-1.json' },
  { id: 'level-05', order: 5, stageId: 'stage-2', title: 'Action Verbs', topic: 'What people do', questionFile: 'stage-2.json' },
  { id: 'level-06', order: 6, stageId: 'stage-2', title: 'Adjectives & Descriptions', topic: 'Describing people and things', questionFile: 'stage-2.json' },
  { id: 'level-07', order: 7, stageId: 'stage-2', title: 'Daily Routines', topic: 'Habits and everyday activities', questionFile: 'stage-2.json' },
  { id: 'level-08', order: 8, stageId: 'stage-2', title: 'Basic Grammar', topic: 'Choose the correct form', questionFile: 'stage-2.json' },
  { id: 'level-09', order: 9, stageId: 'stage-3', title: 'Work & Study', topic: 'Jobs, offices and studying', questionFile: 'stage-3.json' },
  { id: 'level-10', order: 10, stageId: 'stage-3', title: 'Past Tense & Verb Forms', topic: 'Talk about the past', questionFile: 'stage-3.json' },
  { id: 'level-11', order: 11, stageId: 'stage-3', title: 'Collocations & Phrasal Verbs', topic: 'Words that go together', questionFile: 'stage-3.json' },
  { id: 'level-12', order: 12, stageId: 'stage-3', title: 'Grammar in Context', topic: 'Mixed challenges', questionFile: 'stage-3.json' },
]);

/** Levels grouped per stage, in order (for the level-select screen). */
export function levelsByStage() {
  return STAGES.map((stage) => ({
    stage,
    levels: LEVELS.filter((l) => l.stageId === stage.id),
  }));
}

/** @returns {object|null} the level after `levelId` in progression order. */
export function nextLevel(levelId) {
  const idx = LEVELS.findIndex((l) => l.id === levelId);
  if (idx === -1 || idx + 1 >= LEVELS.length) return null;
  return LEVELS[idx + 1];
}

export function levelById(levelId) {
  return LEVELS.find((l) => l.id === levelId) || null;
}

export function stageById(stageId) {
  return STAGES.find((s) => s.id === stageId) || null;
}

/**
 * Per-level difficulty as multipliers over the engine's base tuning.
 * The English challenge is the primary difficulty; movement changes stay
 * modest and never shrink fruit targets.
 *
 * flightScale multiplies TUNING.FLIGHT_SECONDS, which the engine treats as
 * the TARGET FULLY-VISIBLE seconds per fruit (the readable window inside
 * the playfield). The resulting visible-duration bands:
 *   levels 1–4  (A1): 6–7 s   → scales 1.16–1.22 (≈6.4–6.7 s)
 *   levels 5–8  (A2): 5–6 s   → scales 0.98–1.04 (≈5.4–5.7 s)
 *   levels 9–12 (B1): 4.5–5.5 s → scales 0.87–0.95 (≈4.8–5.2 s)
 * With FLIGHT_JITTER_RATIO ≤ 0.04 every jittered flight stays inside its
 * band. To retune reading time, change TUNING.FLIGHT_SECONDS (js/engine.js)
 * or these scales — the engine derives launch velocity and gravity itself.
 */
export const DIFFICULTY = Object.freeze({
  'level-01': { flightScale: 1.22, waveGapScale: 1.35, staggerScale: 1.50 },
  'level-02': { flightScale: 1.20, waveGapScale: 1.30, staggerScale: 1.40 },
  'level-03': { flightScale: 1.18, waveGapScale: 1.20, staggerScale: 1.30 },
  'level-04': { flightScale: 1.16, waveGapScale: 1.15, staggerScale: 1.20 },
  'level-05': { flightScale: 1.04, waveGapScale: 1.10, staggerScale: 1.10 },
  'level-06': { flightScale: 1.02, waveGapScale: 1.08, staggerScale: 1.05 },
  'level-07': { flightScale: 1.00, waveGapScale: 1.05, staggerScale: 1.00 },
  'level-08': { flightScale: 0.98, waveGapScale: 1.02, staggerScale: 1.00 },
  'level-09': { flightScale: 0.95, waveGapScale: 1.00, staggerScale: 0.95 },
  'level-10': { flightScale: 0.92, waveGapScale: 0.95, staggerScale: 0.92 },
  'level-11': { flightScale: 0.89, waveGapScale: 0.92, staggerScale: 0.90 },
  'level-12': { flightScale: 0.87, waveGapScale: 0.90, staggerScale: 0.88 },
});

/** Converts a level's difficulty profile into engine tuning overrides. */
export function tuningOverridesFor(levelId) {
  const d = DIFFICULTY[levelId] || { flightScale: 1, waveGapScale: 1, staggerScale: 1 };
  return {
    FLIGHT_SECONDS: TUNING.FLIGHT_SECONDS * d.flightScale,
    WAVE_GAP: TUNING.WAVE_GAP * d.waveGapScale,
    SPAWN_STAGGER: TUNING.SPAWN_STAGGER * d.staggerScale,
  };
}

/**
 * Stars come from successful question rounds, never from raw score:
 * 10 → 3 stars, 9 → 2, 8 → 1, fewer (or an unfinished session) → 0.
 * @param {{completed: boolean, passStatus: string|null, successfulRounds: number}} report session report
 */
export function starsFor(report) {
  if (!report || !report.completed || report.passStatus !== 'passed') return 0;
  if (report.successfulRounds >= 10) return 3;
  if (report.successfulRounds === 9) return 2;
  if (report.successfulRounds === 8) return 1;
  return 0;
}

/**
 * Longest option text allowed on a fruit. Longer answers shrink the label
 * too aggressively; such content belongs in a different presentation.
 */
export const MAX_OPTION_TEXT = 12;

/**
 * Validates a loaded data pack ({ schemaVersion: 2, stages: [{ stageId,
 * levels: [{ id, questions: [...] }] }] }) against the manifest:
 * every manifest level present exactly once, no extras, ≥ minQuestions
 * per level, every question valid (reuses the engine's bank validator
 * with the full type list), and option text within the fruit-fit limit.
 *
 * @param {unknown} data parsed JSON
 * @param {{minQuestions?: number}} [opts]
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateLevelsPack(data, opts = {}) {
  const minQuestions = opts.minQuestions ?? 15;
  const errors = [];
  const fail = (msg) => errors.push(msg);

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, errors: ['Levels pack: top level is not an object.'] };
  }
  if (data.schemaVersion !== 2) {
    fail(`Levels pack: unsupported schemaVersion ${JSON.stringify(data.schemaVersion)} (supported: 2).`);
  }
  if (!Array.isArray(data.stages) || data.stages.length === 0) {
    return { ok: false, errors: [...errors, 'Levels pack: "stages" must be a non-empty array.'] };
  }

  const seen = new Map(); // levelId -> question count
  const lessonShaped = []; // for the engine validator
  for (const stage of data.stages) {
    if (!stage || typeof stage !== 'object' || !Array.isArray(stage.levels)) {
      fail('Levels pack: each stage needs a "levels" array.');
      continue;
    }
    for (const level of stage.levels) {
      if (!level || typeof level !== 'object' || typeof level.id !== 'string') {
        fail('Levels pack: level entry is malformed.');
        continue;
      }
      if (seen.has(level.id)) {
        fail(`Levels pack: duplicate level id "${level.id}".`);
        continue;
      }
      const count = Array.isArray(level.questions) ? level.questions.length : 0;
      seen.set(level.id, count);
      lessonShaped.push({
        id: level.id,
        title: typeof level.title === 'string' ? level.title : level.id,
        questions: Array.isArray(level.questions) ? level.questions : [],
      });
    }
  }

  for (const level of LEVELS) {
    const count = seen.get(level.id);
    if (count === undefined) {
      fail(`Levels pack: manifest level "${level.id}" (${level.title}) is missing from the data.`);
    } else if (count < minQuestions) {
      fail(`Levels pack: level "${level.id}" needs at least ${minQuestions} questions, found ${count}.`);
    }
  }
  for (const id of seen.keys()) {
    if (!levelById(id)) {
      fail(`Levels pack: data contains unknown level "${id}" (not in the manifest).`);
    }
  }

  // Option-text fit: words carried by fruits must stay readable.
  for (const level of lessonShaped) {
    level.questions.forEach((question, qi) => {
      if (!question || !Array.isArray(question.options)) return;
      question.options.forEach((option, oi) => {
        if (option && typeof option.text === 'string' && option.text.trim().length > MAX_OPTION_TEXT) {
          fail(`Level "${level.id}" questions[${qi}].options[${oi}]: text "${option.text}" exceeds ${MAX_OPTION_TEXT} characters for fruit display.`);
        }
      });
    });
  }

  // Full structural validation through the engine's bank validator.
  const bank = validateQuestionBank(
    { schemaVersion: 1, lessons: lessonShaped },
    { supportedQuestionTypes: [...SUPPORTED_QUESTION_TYPES] }
  );
  errors.push(...bank.errors);

  return { ok: errors.length === 0, errors };
}
