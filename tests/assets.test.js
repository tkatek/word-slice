/**
 * Asset manager tests — pure Node, no DOM: the browser image loader is
 * replaced by test doubles via createAssetManager({ loadImage }).
 * The path-manifest tests read the real files on disk so a missing or
 * renamed fruit sprite fails the suite before it can ship.
 * Run with: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  FRUIT_IDS,
  FRUIT_KINDS,
  FRUIT_IMAGE_PATHS,
  essentialStartupAssets,
  createAssetManager,
} from '../js/assets.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* Manifest completeness — the 30 fruit files the game depends on      */
/* ------------------------------------------------------------------ */

describe('fruit image manifest', () => {
  it('declares exactly the ten fruit ids with whole/left/right sprites', () => {
    assert.deepEqual(
      FRUIT_IDS,
      ['watermelon', 'apple', 'orange', 'tomato', 'peach', 'melon', 'pomegranate', 'lemon', 'plum', 'coconut'],
    );
    assert.deepEqual(FRUIT_KINDS, ['whole', 'left', 'right']);
    assert.deepEqual(Object.keys(FRUIT_IMAGE_PATHS).sort(), [...FRUIT_IDS].sort());
    for (const id of FRUIT_IDS) {
      assert.deepEqual(
        Object.keys(FRUIT_IMAGE_PATHS[id]).sort(),
        ['left', 'right', 'whole'],
        `${id} must define whole/left/right`,
      );
    }
  });

  it('uses the uncuted/ + cuted/ naming convention for every path', () => {
    for (const id of FRUIT_IDS) {
      const paths = FRUIT_IMAGE_PATHS[id];
      assert.equal(paths.whole, `assets/fruits/uncuted/${id}.png`);
      assert.equal(paths.left, `assets/fruits/cuted/${id}_left.png`);
      assert.equal(paths.right, `assets/fruits/cuted/${id}_right.png`);
    }
  });

  it('matches assets/fruits/manifest.json exactly (no second naming system)', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'assets/fruits/manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.fruits).sort(), [...FRUIT_IDS].sort());
    for (const id of FRUIT_IDS) {
      for (const kind of FRUIT_KINDS) {
        // The manifest's basePath is "./" relative to assets/fruits/.
        assert.equal(
          FRUIT_IMAGE_PATHS[id][kind],
          join('assets/fruits', manifest.fruits[id][kind].path).replaceAll('\\', '/'),
          `${id}/${kind} drifted from the on-disk manifest`,
        );
      }
    }
  });

  it('has all 30 files present on disk (case-sensitive, deployment-safe)', () => {
    for (const id of FRUIT_IDS) {
      for (const kind of FRUIT_KINDS) {
        const rel = FRUIT_IMAGE_PATHS[id][kind];
        assert.ok(
          existsSync(join(repoRoot, rel)),
          `missing fruit sprite: ${rel}`,
        );
      }
    }
  });

  it('covers the engine appearance pool (every spawnable fruit has art)', async () => {
    const { TUNING } = await import('../js/engine.js');
    for (const id of TUNING.APPEARANCES) {
      assert.ok(FRUIT_IMAGE_PATHS[id], `engine appearance "${id}" has no sprite manifest entry`);
    }
  });
});

describe('essential startup asset list', () => {
  it('contains the 30 fruit sprites plus background and question-card art', () => {
    const list = essentialStartupAssets();
    assert.equal(list.length, 33);
    assert.equal(new Set(list.map((a) => a.key)).size, 33, 'keys must be unique');
    assert.equal(new Set(list.map((a) => a.src)).size, 33, 'srcs must be unique');

    const fruitKeys = list.filter((a) => a.key.startsWith('fruit:'));
    assert.equal(fruitKeys.length, 30);
    assert.ok(list.some((a) => a.key === 'background' && a.src.startsWith('assets/backgrounds/')));
    assert.ok(list.some((a) => a.src === 'assets/ui/question-card.webp'));
    assert.ok(list.some((a) => a.src === 'assets/ui/question-card-compact.png'));
  });

  it('only warms the orientation-matching background (never both)', () => {
    const list = essentialStartupAssets();
    const backgrounds = list.filter((a) => a.key === 'background');
    assert.equal(backgrounds.length, 1);
    assert.ok(
      backgrounds[0].src === 'assets/backgrounds/desktop.webp'
      || backgrounds[0].src === 'assets/backgrounds/mobile.webp',
    );
  });
});

/* ------------------------------------------------------------------ */
/* Manager behavior with a fake loader                                 */
/* ------------------------------------------------------------------ */

/** Fake image stand-in: the manager treats it as the decoded element. */
const fakeImage = (src) => ({ src, complete: true, naturalWidth: 256, naturalHeight: 256 });

function makeLoader() {
  const calls = []; // { src, resolve }
  let failPred = () => false;
  let delayMs = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const loader = (src) => {
    calls.push(src);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        inFlight -= 1;
        if (failPred(src)) reject(new Error(`boom: ${src}`));
        else resolve(fakeImage(src));
      }, delayMs);
    });
  };
  return {
    loader,
    get calls() { return calls; },
    get maxInFlight() { return maxInFlight; },
    failWhen(pred) { failPred = pred; },
    setDelay(ms) { delayMs = ms; },
  };
}

function freshManager(harness) {
  const manager = createAssetManager({ loadImage: harness.loader });
  manager.registerEssentialImages([
    { key: 'fruit:apple:whole', src: 'apple.png' },
    { key: 'fruit:apple:left', src: 'apple_left.png' },
    { key: 'fruit:apple:right', src: 'apple_right.png' },
    { key: 'background', src: 'bg.webp' },
  ]);
  return manager;
}

describe('asset manager: successful load', () => {
  it('loads every asset, reports real progress and gates readiness', async () => {
    const harness = makeLoader();
    harness.setDelay(2);
    const manager = freshManager(harness);

    const events = [];
    const result = await manager.loadEssentialAssets({
      onProgress: (p) => events.push({ ...p }),
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.failed, []);
    assert.equal(manager.isEssentialReady(), true);
    assert.equal(manager.statusOf('fruit:apple:whole'), 'done');

    // Real progress: starts below 1, climbs monotonically, ends exactly 1.
    assert.ok(events.length >= 2, 'progress must be reported per asset');
    let prev = -1;
    for (const ev of events) {
      assert.ok(ev.fraction >= prev, 'progress must never go backwards');
      assert.ok(ev.fraction <= 1);
      prev = ev.fraction;
    }
    assert.equal(events[events.length - 1].fraction, 1);
    assert.deepEqual(manager.getProgress(), { loaded: 4, total: 4, fraction: 1 });
  });

  it('caches decoded images — get/getFruit/fruitImages return the same object', async () => {
    const harness = makeLoader();
    const manager = freshManager(harness);
    await manager.loadEssentialAssets();

    const whole = manager.get('fruit:apple:whole');
    assert.equal(whole.src, 'apple.png');
    assert.equal(manager.get('fruit:apple:whole'), whole, 'repeated get must reuse the cache');
    assert.equal(manager.getFruit('apple', 'whole'), whole);
    const trio = manager.fruitImages('apple');
    assert.equal(trio.whole, whole);
    assert.equal(trio.left.src, 'apple_left.png');
    assert.equal(trio.right.src, 'apple_right.png');
    // Unknown or partial fruits never expose half-ready art.
    assert.equal(manager.fruitImages('plum'), undefined);
    assert.equal(manager.get('fruit:plum:whole'), undefined);
  });

  it('skips re-loading entirely on a second run (repeat-init safety)', async () => {
    const harness = makeLoader();
    const manager = freshManager(harness);
    await manager.loadEssentialAssets();
    assert.equal(harness.calls.length, 4);

    const result = await manager.loadEssentialAssets();
    assert.equal(result.ok, true);
    assert.equal(harness.calls.length, 4, 'no new network requests after success');
  });
});

describe('asset manager: failures and retry', () => {
  it('retries a failing asset a bounded number of times, then reports it', async () => {
    const harness = makeLoader();
    harness.failWhen((src) => src === 'apple_left.png');
    const manager = freshManager(harness);

    const result = await manager.loadEssentialAssets();

    assert.equal(result.ok, false);
    assert.deepEqual(
      result.failed.map((f) => f.key),
      ['fruit:apple:left'],
    );
    assert.equal(manager.isEssentialReady(), false);
    assert.equal(manager.statusOf('fruit:apple:left'), 'failed');
    assert.equal(manager.get('fruit:apple:left'), undefined);
    // Exactly the two in-run attempts — no infinite retry loop.
    const leftCalls = harness.calls.filter((s) => s === 'apple_left.png');
    assert.equal(leftCalls.length, 2);
  });

  it('Retry reloads ONLY failed assets — successes keep their cache', async () => {
    const harness = makeLoader();
    harness.failWhen((src) => src === 'apple_left.png' || src === 'bg.webp');
    const manager = freshManager(harness);
    const first = await manager.loadEssentialAssets();
    assert.equal(first.ok, false);
    const cachedWhole = manager.get('fruit:apple:whole');

    harness.failWhen(() => false); // network "recovers"
    const second = await manager.loadEssentialAssets();

    assert.equal(second.ok, true);
    assert.equal(harness.calls.filter((s) => s === 'apple.png').length, 1,
      'the successful whole sprite must not be downloaded again');
    assert.equal(manager.get('fruit:apple:whole'), cachedWhole, 'same cached object survives');
    assert.equal(manager.isEssentialReady(), true);
  });

  it('keeps failed assets discoverable while loading and after failure', async () => {
    const harness = makeLoader();
    harness.setDelay(2);
    harness.failWhen((src) => src === 'apple.png');
    const manager = freshManager(harness);
    const promise = manager.loadEssentialAssets();
    assert.ok(manager.getMissingAssets().length > 0, 'assets are missing mid-flight');
    const result = await promise;
    assert.equal(result.ok, false);
    assert.deepEqual(
      manager.getFailedAssets().map((f) => f.key),
      ['fruit:apple:whole'],
    );
  });
});

describe('asset manager: duplicate request prevention', () => {
  it('joins concurrent loadEssentialAssets calls into ONE set of requests', async () => {
    const harness = makeLoader();
    harness.setDelay(3);
    const manager = freshManager(harness);

    const [a, b] = await Promise.all([
      manager.loadEssentialAssets(),
      manager.loadEssentialAssets(),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(harness.calls.length, 4, 'each asset requested exactly once');
  });

  it('bounds concurrent image loads for slow mobile networks', async () => {
    const harness = makeLoader();
    harness.setDelay(4);
    const manager = createAssetManager({ loadImage: harness.loader });
    const many = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, src: `f${i}.png` }));
    manager.registerEssentialImages(many);
    const result = await manager.loadEssentialAssets();
    assert.equal(result.ok, true);
    assert.ok(harness.maxInFlight <= 6, `concurrency cap exceeded: ${harness.maxInFlight}`);
    assert.ok(harness.maxInFlight > 1, 'loads should actually run in parallel');
  });
});

describe('asset manager: registration', () => {
  it('re-registering the same key+src keeps load progress', async () => {
    const harness = makeLoader();
    const manager = freshManager(harness);
    await manager.loadEssentialAssets();
    manager.registerEssentialImages([
      { key: 'fruit:apple:whole', src: 'apple.png' },
      { key: 'background', src: 'bg.webp' },
    ]);
    assert.equal(manager.statusOf('fruit:apple:whole'), 'done');
    assert.equal(manager.getProgress().loaded, 4);
  });

  it('re-registering with a changed src resets that asset (orientation swap)', async () => {
    const harness = makeLoader();
    const manager = freshManager(harness);
    await manager.loadEssentialAssets();
    manager.registerEssentialImages([{ key: 'background', src: 'bg-portrait.webp' }]);
    assert.equal(manager.statusOf('background'), 'idle');
    assert.equal(manager.isEssentialReady(), false);
    await manager.loadEssentialAssets();
    assert.equal(manager.statusOf('background'), 'done');
    assert.equal(manager.get('background').src, 'bg-portrait.webp');
    // Only the swapped asset re-fetched.
    assert.equal(harness.calls.filter((s) => s === 'bg.webp').length, 1);
    assert.equal(harness.calls.filter((s) => s === 'bg-portrait.webp').length, 1);
  });
});

/* ------------------------------------------------------------------ */
/* Startup gating contract (browser wiring is covered by the loader UI */
/* contract below; these assert the gating primitive itself)           */
/* ------------------------------------------------------------------ */

describe('startup gating primitive', () => {
  it('isEssentialReady() is false until every asset is genuinely done', async () => {
    const harness = makeLoader();
    harness.setDelay(2);
    const manager = freshManager(harness);
    assert.equal(manager.isEssentialReady(), false, 'nothing registered as done yet');
    const promise = manager.loadEssentialAssets();
    assert.equal(manager.isEssentialReady(), false, 'not ready while loading');
    await promise;
    assert.equal(manager.isEssentialReady(), true);
  });

  it('fruitImages() stays undefined until the whole trio is decoded', async () => {
    const harness = makeLoader();
    harness.setDelay(2);
    harness.failWhen((src) => src === 'apple_right.png');
    const manager = freshManager(harness);
    await manager.loadEssentialAssets();
    // Whole + left decoded, right failed → slicing art must NOT be exposed.
    assert.equal(manager.fruitImages('apple'), undefined);
    assert.ok(manager.get('fruit:apple:whole'), 'individual sprites still readable');
  });
});

/* ------------------------------------------------------------------ */
/* Loader UI contract (index.html ships the real-progress markup)      */
/* ------------------------------------------------------------------ */

describe('loading screen markup contract', () => {
  const html = readFileSync(join(repoRoot, 'index.html'), 'utf8');

  it('contains the progress bar, percent label and loader fruit elements', () => {
    for (const id of ['loader-bar', 'loader-bar-fill', 'loader-percent', 'loader-fruit', 'loader-note']) {
      assert.ok(html.includes(`id="${id}"`), `index.html must contain #${id}`);
    }
    assert.ok(html.includes('aria-valuemin="0"'));
    assert.ok(html.includes('aria-valuemax="100"'));
  });

  it('offers a Retry control on the error screen for failed loads', () => {
    assert.ok(html.includes('id="btn-retry"'));
    assert.ok(/Retry Loading/.test(html));
  });
});
