/**
 * One-off measurement: visible flight duration per level & viewport, run
 * against the CURRENT engine code. Deterministic (identity rng, no jitter).
 *
 * "Fully readable" = fruit entirely inside the playfield (y + r <= playH).
 * "Gone" = fruit entirely below the playfield (y - r >= playH).
 */
import { WordSliceEngine, ENGINE_STATES } from '../js/engine.js';
import { tuningOverridesFor } from '../js/levels.js';

const identityRng = () => 0.5;

function makeLesson(n = 10) {
  return {
    id: 'm', title: 'M',
    questions: Array.from({ length: n }, (_, i) => ({
      id: `q${i}`,
      type: 'category',
      prompt: `prompt ${i}`,
      explanation: 'e',
      options: [
        { id: 'a', text: 'aa' }, { id: 'b', text: 'bb' },
        { id: 'c', text: 'cc' }, { id: 'd', text: 'dd' },
      ],
      correctOptionIds: ['a', 'b'],
    })),
  };
}

/** Simulates one launch; returns per-fruit readable durations in seconds. */
function measure(playW, playH, maxActive, tuning) {
  const e = new WordSliceEngine({ rng: identityRng, maxActiveFruits: maxActive, playW, playH, tuning });
  e.startSession(makeLesson());
  e.launchRound();
  const step = 1 / 60;
  const fruits = new Map(); // id -> {tFullyIn: null, tGone: null, radius}
  for (let t = 0; t < 60; t += step) {
    for (const f of e.getFruitsSnapshot()) {
      if (!fruits.has(f.id)) fruits.set(f.id, { tFullyIn: null, tGone: null, radius: f.radius });
      const rec = fruits.get(f.id);
      if (rec.tFullyIn === null && f.y + f.radius <= playH) rec.tFullyIn = t;
      if (rec.tGone === null && rec.tFullyIn !== null && f.y - f.radius >= playH) rec.tGone = t;
    }
    e.update(step);
    if (e.state !== ENGINE_STATES.PLAYING) break;
  }
  return [...fruits.values()].filter((r) => r.tFullyIn !== null && r.tGone !== null)
    .map((r) => ({ readable: r.tGone - r.tFullyIn, radius: r.radius }));
}

// Representative playfields: {viewport, playW, playH, maxActive}
const VIEWPORTS = [
  { name: 'desktop 1920x1080 (play~1880x760)', w: 1880, h: 760, m: 4 },
  { name: 'desktop 1366x768  (play~1280x540)', w: 1280, h: 540, m: 4 },
  { name: 'phone 390x844     (play~370x600)', w: 370, h: 600, m: 2 },
  { name: 'phone 320x640     (play~300x430)', w: 300, h: 430, m: 2 },
];

console.log('=== CURRENT (pre-fix) fully-readable durations, seconds ===');
for (const vp of VIEWPORTS) {
  console.log(`\n-- ${vp.name} --`);
  for (let lvl = 1; lvl <= 12; lvl++) {
    const id = `level-${String(lvl).padStart(2, '0')}`;
    const res = measure(vp.w, vp.h, vp.m, tuningOverridesFor(id));
    const avg = res.reduce((s, r) => s + r.readable, 0) / res.length;
    console.log(`  ${id}: readable=${avg.toFixed(2)}s  (r=${res[0].radius})`);
  }
}
