/**
 * One-off educational data audit for the final production review.
 * Structural checks + content metrics + potential linguistic ambiguity list.
 * Run: node tools/audit-data.mjs
 */
import { readFileSync } from 'node:fs';
import { LEVELS, DIFFICULTY, validateLevelsPack } from '../js/levels.js';

const packs = {
  'stage-1.json': JSON.parse(readFileSync(new URL('../data/levels/stage-1.json', import.meta.url))),
  'stage-2.json': JSON.parse(readFileSync(new URL('../data/levels/stage-2.json', import.meta.url))),
  'stage-3.json': JSON.parse(readFileSync(new URL('../data/levels/stage-3.json', import.meta.url))),
};
const legacyBank = JSON.parse(readFileSync(new URL('../data/questions.json', import.meta.url)));

// 1. Structural validation of the merged pack (game.js merges the three
// stage files into one { schemaVersion: 2, stages: [...] } before validating)
let allOk = true;
const merged = { schemaVersion: 2, stages: Object.values(packs).flatMap((p) => p.stages) };
{
  const res = validateLevelsPack(merged);
  console.log(`[structure] merged pack: ${res.ok ? 'OK' : 'FAIL'}`);
  if (!res.ok) { allOk = false; res.errors.forEach((e) => console.log('   ', e)); }
}

// 2. Cross-file duplicate question ids / near-duplicate content
const levelQuestions = new Map();
const globalIds = new Map();
const prompts = new Map();
for (const [file, data] of Object.entries(packs)) {
  for (const stage of data.stages) {
    for (const level of stage.levels) {
      const qs = [];
      for (const q of level.questions) {
        qs.push(q);
        if (globalIds.has(q.id)) console.log(`[dup-id] ${q.id} in ${globalIds.get(q.id)} AND ${level.id}`);
        globalIds.set(q.id, level.id);
        const key = `${q.type}::${q.prompt.trim().toLowerCase()}`;
        if (prompts.has(key) && prompts.get(key) !== level.id) {
          console.log(`[dup-prompt] "${q.prompt}" appears in ${prompts.get(key)} and ${level.id} (${q.id})`);
        }
        prompts.set(key, level.id);
      }
      levelQuestions.set(level.id, qs);
    }
  }
}
const totalQ = [...levelQuestions.values()].reduce((n, qs) => n + qs.length, 0);
console.log(`\n[total] questions across 12 levels: ${totalQ} (expected 180)`);
for (const lvl of LEVELS) {
  const qs = levelQuestions.get(lvl.id) || [];
  console.log(`  ${lvl.id} ${lvl.title.padEnd(34)} n=${qs.length}`);
}

// 3. Per-level content metrics: type mix, options, distractor similarity
console.log('\n[per-level metrics]');
const rows = [];
for (const lvl of LEVELS) {
  const qs = levelQuestions.get(lvl.id) || [];
  const types = {};
  let optSum = 0, correctSum = 0, wordLenSum = 0, wordCount = 0, maxOpts = 0;
  let promptLenSum = 0, explLenSum = 0;
  for (const q of qs) {
    types[q.type] = (types[q.type] || 0) + 1;
    optSum += q.options.length; maxOpts = Math.max(maxOpts, q.options.length);
    correctSum += q.correctOptionIds.length;
    promptLenSum += q.prompt.length; explLenSum += q.explanation.length;
    for (const o of q.options) {
      if (q.correctOptionIds.includes(o.id)) { wordLenSum += o.text.length; wordCount++; }
    }
  }
  rows.push({
    id: lvl.id, n: qs.length, types,
    avgOpts: (optSum / qs.length).toFixed(1),
    maxOpts,
    avgCorrect: (correctSum / qs.length).toFixed(1),
    avgWordLen: (wordLenSum / Math.max(1, wordCount)).toFixed(1),
    avgPromptLen: (promptLenSum / qs.length).toFixed(0),
    avgExplLen: (explLenSum / qs.length).toFixed(0),
  });
}
for (const r of rows) {
  console.log(`  ${r.id} opts=${r.avgOpts}(max ${r.maxOpts}) correct=${r.avgCorrect} wordLen=${r.avgWordLen} promptLen=${r.avgPromptLen} explLen=${r.avgExplLen} types=${JSON.stringify(r.types)}`);
}

// 4. Difficulty profile sanity
console.log('\n[difficulty multipliers]');
for (const [id, d] of Object.entries(DIFFICULTY)) {
  console.log(`  ${id}: flight=${d.flightScale} gap=${d.waveGapScale} stagger=${d.staggerScale} (fruit time=${(3.4 * d.flightScale).toFixed(2)}s)`);
}

// 5. Legacy bank check (data/questions.json) — is it still referenced anywhere?
console.log(`\n[legacy] data/questions.json: schema=${legacyBank.schemaVersion}, lessons=${legacyBank.lessons?.length}, questions=${legacyBank.lessons?.reduce((n, l) => n + l.questions.length, 0)}`);

// 6. Potential linguistic ambiguity: noun/verb dual-role single words in category questions
console.log('\n[potential ambiguity candidates — category questions with bare-word options]');
let flagged = 0;
for (const lvl of LEVELS) {
  for (const q of levelQuestions.get(lvl.id) || []) {
    if (q.type !== 'category') continue;
    // heuristic: prompt asks to slice "the animals" etc. but options include words with dual POS
    const dualWords = new Set(['book', 'play', 'watch', 'drink', 'fish', 'fly', 'cook', 'walk', 'run', 'read', 'write', 'wash', 'water', 'plant', 'orange', 'chicken', 'egg', 'ice', 'light', 'match', 'ring', 'train', 'letter', 'mail', 'call', 'work', 'study', 'paint', 'dance', 'sing', 'jump', 'ride', 'drive', 'draw', 'shop', 'visit', 'rest', 'dream', 'watch']);
    const suspicious = q.options.filter((o) => dualWords.has(o.text.trim().toLowerCase()));
    if (suspicious.length) {
      flagged++;
      console.log(`  ${q.id} (${lvl.id}) "${q.prompt}" -> ${suspicious.map((o) => o.text).join(', ')}`);
    }
  }
}
console.log(`  flagged: ${flagged}`);

// 7. Grammar/sentence questions: verify exactly one correct unless multiple intended
console.log('\n[multi-correct grammar/sentence/meaning questions]');
for (const lvl of LEVELS) {
  for (const q of levelQuestions.get(lvl.id) || []) {
    if (q.type !== 'category' && q.correctOptionIds.length > 1) {
      console.log(`  ${q.id} (${lvl.id}) ${q.type} has ${q.correctOptionIds.length} correct`);
    }
  }
}

console.log(`\n[result] structural validation ${allOk ? 'PASSED' : 'FAILED'}`);
