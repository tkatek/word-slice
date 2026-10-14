/**
 * Juice FX tests — the canvas splash/droplet system behind every slice.
 * Pure Node: a mock 2D context records draws, a seeded rng (mulberry32
 * from the engine, same spirit as the engine tests) makes every spawn
 * deterministic. Run with: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JuiceFx, JUICE_TUNING, hexToRgb } from '../js/juice.js';
import { mulberry32 } from '../js/engine.js';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function makeFx(seed = 7, opts = {}) {
  return new JuiceFx({ rng: mulberry32(seed), ...opts });
}

/** Minimal 2D-context stand-in that records interesting calls. */
function mockCtx() {
  const calls = { arc: 0, ellipse: 0, fill: 0 };
  return {
    calls,
    globalAlpha: 1,
    fillStyle: '',
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    scale() {},
    beginPath() {},
    moveTo() {},
    arc() { calls.arc++; },
    ellipse() { calls.ellipse++; },
    fill() { calls.fill++; },
  };
}

const SPAWN = {
  x: 300,
  y: 200,
  size: 110,
  juice: '#e5484d',
  dirX: 0.8,
  dirY: 0.6,
  speedPxMs: 1.2,
  gravity: 800,
};

/* ------------------------------------------------------------------ */
/* Color parsing                                                       */
/* ------------------------------------------------------------------ */

describe('JUICE: hexToRgb', () => {
  it('parses #rrggbb juice colors', () => {
    assert.deepEqual(hexToRgb('#e5484d'), [229, 72, 77]);
    assert.deepEqual(hexToRgb('#f2e8c9'), [242, 232, 201]);
  });

  it('falls back to a visible red on malformed input', () => {
    const rgb = hexToRgb('not-a-color');
    assert.equal(rgb.length, 3);
    assert.ok(rgb.every((v) => v >= 0 && v <= 255));
  });
});

/* ------------------------------------------------------------------ */
/* Spawn budgets and structure                                         */
/* ------------------------------------------------------------------ */

describe('JUICE: spawn budgets', () => {
  it('creates 8–16 droplets per slice (desktop budget)', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const fx = makeFx(seed);
      const burst = fx.spawn(SPAWN.x, SPAWN.y, SPAWN);
      assert.ok(
        burst.drops.length >= JUICE_TUNING.DROPS_MIN && burst.drops.length <= JUICE_TUNING.DROPS_MAX,
        `seed ${seed}: ${burst.drops.length} droplets outside [${JUICE_TUNING.DROPS_MIN}, ${JUICE_TUNING.DROPS_MAX}]`,
      );
    }
  });

  it('uses the smaller mobile budget on construction', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const fx = makeFx(seed, { mobile: true });
      const burst = fx.spawn(SPAWN.x, SPAWN.y, SPAWN);
      assert.ok(
        burst.drops.length >= JUICE_TUNING.DROPS_MIN_MOBILE && burst.drops.length <= JUICE_TUNING.DROPS_MAX_MOBILE,
        `seed ${seed}: mobile droplets outside budget`,
      );
    }
  });

  it('caps simultaneous bursts (oldest dropped first)', () => {
    const fx = makeFx(3);
    const cap = JUICE_TUNING.MAX_BURSTS;
    for (let i = 0; i < cap + 10; i++) fx.spawn(i * 10, 50, SPAWN);
    assert.equal(fx.count, cap);
    assert.ok(fx.dropletCount <= cap * JUICE_TUNING.DROPS_MAX);
  });

  it('splash duration stays within the 180–350 ms window', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const burst = makeFx(seed).spawn(SPAWN.x, SPAWN.y, SPAWN);
      assert.ok(burst.splashMs >= 180 && burst.splashMs <= 350, `seed ${seed}: ${burst.splashMs}ms`);
    }
  });

  it('droplet lifetimes stay within 300–650 ms', () => {
    const burst = makeFx(11).spawn(SPAWN.x, SPAWN.y, SPAWN);
    for (const d of burst.drops) {
      assert.ok(d.life >= 0.3 && d.life <= 0.65, `lifetime ${d.life}s outside bounds`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Droplet variety, directions and bias                                */
/* ------------------------------------------------------------------ */

describe('JUICE: droplet physics setup', () => {
  const burst = makeFx(42).spawn(SPAWN.x, SPAWN.y, SPAWN);

  it('varies droplet sizes and speeds', () => {
    const sizes = new Set(burst.drops.map((d) => d.rad));
    const speeds = new Set(burst.drops.map((d) => Math.hypot(d.vx, d.vy)));
    assert.ok(sizes.size >= 5, 'droplet sizes are too uniform');
    assert.ok(speeds.size >= 5, 'droplet speeds are too uniform');
  });

  it('spreads droplets across natural outward directions', () => {
    const quadrants = new Set(burst.drops.map((d) => Math.sign(Math.atan2(d.vy, d.vx))));
    assert.ok(quadrants.size >= 2, 'all droplets fly the same way');
  });

  it('biases droplets along the swipe direction', () => {
    // Mean velocity should lean toward (dirX, dirY) more than an unbiased
    // ring would: project the mean onto the swipe unit vector.
    const len = Math.hypot(SPAWN.dirX, SPAWN.dirY);
    const ux = SPAWN.dirX / len;
    const uy = SPAWN.dirY / len;
    let proj = 0;
    for (const d of burst.drops) proj += d.vx * ux + d.vy * uy;
    proj /= burst.drops.length;
    assert.ok(proj > 0, 'droplets are not biased along the swipe');
  });

  it('keeps the speed scaling bounded', () => {
    const slow = makeFx(42).spawn(0, 0, { ...SPAWN, speedPxMs: 0 });
    const fast = makeFx(42).spawn(0, 0, { ...SPAWN, speedPxMs: 99 });
    const ratio = fast.base / slow.base;
    assert.ok(
      ratio <= JUICE_TUNING.SPEED_SCALE_MAX / JUICE_TUNING.SPEED_SCALE_MIN + 1e-9,
      `speed scaling unbounded: ${ratio}`,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Simulation                                                          */
/* ------------------------------------------------------------------ */

describe('JUICE: step', () => {
  it('applies gravity and moves droplets by their velocity', () => {
    const fx = makeFx(5);
    const burst = fx.spawn(SPAWN.x, SPAWN.y, { ...SPAWN, gravity: 800 });
    const before = burst.drops.map((d) => ({ x: d.x, y: d.y, vy: d.vy }));
    fx.step(0.05);
    burst.drops.forEach((d, i) => {
      const b = before[i];
      assert.ok(Math.abs(d.x - (b.x + d.vx * 0.05)) < 1e-9 || d.x !== b.x, 'x should advance');
      assert.ok(d.vy > b.vy, 'gravity must pull droplets down');
      assert.ok(d.age > 0, 'age advances');
    });
  });

  it('clamps stalled-frame deltas so droplets never teleport', () => {
    const fx = makeFx(6);
    const burst = fx.spawn(SPAWN.x, SPAWN.y, SPAWN);
    const maxVx = Math.max(...burst.drops.map((d) => Math.abs(d.vx)));
    fx.step(1); // one full second in a single step
    const moved = Math.max(...burst.drops.map((d) => Math.abs(d.x - SPAWN.x)));
    assert.ok(moved <= maxVx * 0.06 + SPAWN.x * 0.06 + 60, `droplet teleported: moved ${moved}px`);
  });

  it('expires every effect within the max droplet lifetime', () => {
    const fx = makeFx(8);
    fx.spawn(SPAWN.x, SPAWN.y, SPAWN);
    assert.ok(fx.count === 1);
    // 20 × 50 ms = 1 s > 650 ms max life; bursts must be gone.
    for (let i = 0; i < 20; i++) fx.step(0.05);
    assert.equal(fx.count, 0, 'expired bursts must be removed immediately');
  });

  it('ignores non-finite and negative deltas', () => {
    const fx = makeFx(9);
    const burst = fx.spawn(SPAWN.x, SPAWN.y, SPAWN);
    const y = burst.drops[0].y;
    fx.step(NaN);
    fx.step(-1);
    assert.equal(burst.drops[0].y, y);
    assert.equal(fx.count, 1);
  });

  it('clear() empties everything', () => {
    const fx = makeFx(10);
    fx.spawn(1, 1, SPAWN);
    fx.spawn(2, 2, SPAWN);
    fx.clear();
    assert.equal(fx.count, 0);
    assert.equal(fx.dropletCount, 0);
  });
});

/* ------------------------------------------------------------------ */
/* Determinism                                                         */
/* ------------------------------------------------------------------ */

describe('JUICE: determinism', () => {
  it('identical seeds produce identical bursts', () => {
    const a = makeFx(123).spawn(SPAWN.x, SPAWN.y, SPAWN);
    const b = makeFx(123).spawn(SPAWN.x, SPAWN.y, SPAWN);
    assert.deepEqual(a.drops, b.drops);
    assert.deepEqual(a.lobes, b.lobes);
    assert.equal(a.splashMs, b.splashMs);
  });
});

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

describe('JUICE: draw', () => {
  it('paints splash lobes, gloss and droplets, then restores alpha', () => {
    const fx = makeFx(21);
    fx.spawn(SPAWN.x, SPAWN.y, SPAWN);
    const ctx = mockCtx();
    fx.draw(ctx);
    assert.ok(ctx.calls.arc > 0, 'no circles drawn');
    assert.ok(ctx.calls.ellipse > 0, 'gloss highlight missing');
    assert.ok(ctx.calls.fill > 0, 'nothing filled');
    assert.equal(ctx.globalAlpha, 1, 'globalAlpha must be restored');
  });

  it('draws nothing once everything expired', () => {
    const fx = makeFx(22);
    fx.spawn(SPAWN.x, SPAWN.y, SPAWN);
    for (let i = 0; i < 20; i++) fx.step(0.05);
    const ctx = mockCtx();
    fx.draw(ctx);
    assert.equal(ctx.calls.fill, 0);
  });
});
