/**
 * Word Slice — central image asset manager.
 *
 * Single source of truth for every gameplay-critical image URL (the 30
 * fruit sprites, the viewport-matching background, the question-card
 * artwork) plus the loader that makes them genuinely READY before the
 * first round can launch:
 *
 *   - decode-verified loading (an asset counts as loaded only once its
 *     HTMLImageElement has pixels AND finished `decode()`),
 *   - a small concurrency pool with bounded in-call retries and backoff,
 *   - no duplicate network requests (one Image per asset; a second
 *     `loadEssentialAssets()` call joins the in-flight load),
 *   - real progress reporting for the loading screen,
 *   - failure tracking + `Retry` that reloads ONLY the failed assets
 *     (successful ones keep their decoded Image),
 *   - startup gating via `isEssentialReady()`.
 *
 * The manager owns resources only. Fruit movement, collision, scoring and
 * answer correctness stay in js/engine.js; the browser layer decides when
 * gameplay may start.
 */

/* ------------------------------------------------------------------ */
/* Fruit image manifest                                                */
/* ------------------------------------------------------------------ */

/** The ten fruit appearance ids, same order as engine TUNING.APPEARANCES. */
export const FRUIT_IDS = Object.freeze([
  'watermelon', 'apple', 'orange', 'tomato', 'peach',
  'melon', 'pomegranate', 'lemon', 'plum', 'coconut',
]);

/**
 * The ONLY place fruit file paths are declared. Keys match the ids in
 * assets/fruits/manifest.json (uncuted/ + cuted/ directories); tests
 * assert the two never drift apart.
 */
export const FRUIT_IMAGE_PATHS = Object.freeze({
  watermelon: {
    whole: 'assets/fruits/uncuted/watermelon.png',
    left: 'assets/fruits/cuted/watermelon_left.png',
    right: 'assets/fruits/cuted/watermelon_right.png',
  },
  apple: {
    whole: 'assets/fruits/uncuted/apple.png',
    left: 'assets/fruits/cuted/apple_left.png',
    right: 'assets/fruits/cuted/apple_right.png',
  },
  orange: {
    whole: 'assets/fruits/uncuted/orange.png',
    left: 'assets/fruits/cuted/orange_left.png',
    right: 'assets/fruits/cuted/orange_right.png',
  },
  tomato: {
    whole: 'assets/fruits/uncuted/tomato.png',
    left: 'assets/fruits/cuted/tomato_left.png',
    right: 'assets/fruits/cuted/tomato_right.png',
  },
  peach: {
    whole: 'assets/fruits/uncuted/peach.png',
    left: 'assets/fruits/cuted/peach_left.png',
    right: 'assets/fruits/cuted/peach_right.png',
  },
  melon: {
    whole: 'assets/fruits/uncuted/melon.png',
    left: 'assets/fruits/cuted/melon_left.png',
    right: 'assets/fruits/cuted/melon_right.png',
  },
  pomegranate: {
    whole: 'assets/fruits/uncuted/pomegranate.png',
    left: 'assets/fruits/cuted/pomegranate_left.png',
    right: 'assets/fruits/cuted/pomegranate_right.png',
  },
  lemon: {
    whole: 'assets/fruits/uncuted/lemon.png',
    left: 'assets/fruits/cuted/lemon_left.png',
    right: 'assets/fruits/cuted/lemon_right.png',
  },
  plum: {
    whole: 'assets/fruits/uncuted/plum.png',
    left: 'assets/fruits/cuted/plum_left.png',
    right: 'assets/fruits/cuted/plum_right.png',
  },
  coconut: {
    whole: 'assets/fruits/uncuted/coconut.png',
    left: 'assets/fruits/cuted/coconut_left.png',
    right: 'assets/fruits/cuted/coconut_right.png',
  },
});

/** Sprite variants every fruit must provide. */
export const FRUIT_KINDS = Object.freeze(['whole', 'left', 'right']);

/**
 * Stable asset version for the fruit pack. Bumped once per published
 * fruit-artwork change so a new pack never collides with a stale cache
 * entry — deterministic (never a random per-request query), and applied
 * in this one funnel so the decoded Image and every DOM <img> share the
 * same URL (one request per asset).
 */
const FRUIT_ASSET_VERSION = 2;

function fruitUrl(id, kind) {
  const path = FRUIT_IMAGE_PATHS[id] && FRUIT_IMAGE_PATHS[id][kind];
  if (!path) throw new Error(`unknown fruit asset: ${id}/${kind}`);
  return `${path}?v=${FRUIT_ASSET_VERSION}`;
}

/** Question-card artwork (shared URLs with the CSS — never versioned,
 *  so the stylesheet, its preload hint and the manager dedupe to a
 *  single request). */
const QUESTION_CARD_PATHS = Object.freeze({
  intro: 'assets/ui/question-card.webp',
  compact: 'assets/ui/question-card-compact.png',
});

/** Background variant that matches the CURRENT viewport orientation —
 *  mirrors the CSS media query, so the manager warms exactly the file
 *  the scenery layer will paint (the other variant is never fetched). */
export function backgroundPathForViewport() {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(orientation: portrait)').matches
      ? 'assets/backgrounds/mobile.webp'
      : 'assets/backgrounds/desktop.webp';
  }
  return 'assets/backgrounds/desktop.webp';
}

/** [{key, src}] for every essential gameplay image. */
export function essentialStartupAssets() {
  const list = [];
  for (const id of FRUIT_IDS) {
    for (const kind of FRUIT_KINDS) {
      list.push({ key: fruitKey(id, kind), src: fruitUrl(id, kind) });
    }
  }
  list.push({ key: 'background', src: backgroundPathForViewport() });
  list.push({ key: 'question-card-intro', src: QUESTION_CARD_PATHS.intro });
  list.push({ key: 'question-card-compact', src: QUESTION_CARD_PATHS.compact });
  return list;
}

function fruitKey(id, kind) {
  return `fruit:${id}:${kind}`;
}

/* ------------------------------------------------------------------ */
/* Browser image loader (decode-verified)                              */
/* ------------------------------------------------------------------ */

/**
 * Loads one URL and resolves with a fully usable HTMLImageElement:
 * the request succeeded, the image has pixels, and `decode()` finished
 * (where supported), so first paint never stalls inside a frame.
 * `createAssetManager({ loadImage })` lets tests substitute a fake.
 */
function browserLoadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    const fail = (reason) => {
      img.onload = img.onerror = null;
      reject(new Error(`${reason}: ${src}`));
    };
    img.onload = () => {
      if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
        fail('image decoded to no pixels');
        return;
      }
      if (typeof img.decode === 'function') {
        // decode() rejects on corrupt data — treat that as a real failure
        // so a retry (or the player's Retry button) gets a chance at it.
        img.decode().then(() => resolve(img), () => fail('image failed to decode'));
      } else {
        resolve(img);
      }
    };
    img.onerror = () => fail('image request failed');
    img.src = src;
  });
}

/* ------------------------------------------------------------------ */
/* AssetManager                                                        */
/* ------------------------------------------------------------------ */

/** Simultaneous network requests for essential images (mobile-friendly). */
const MAX_CONCURRENT_LOADS = 6;
/** Attempts per asset within ONE loadEssentialAssets() run. */
const ATTEMPTS_PER_RUN = 2;
/** Backoff between in-run attempts (transient mobile-network hiccups). */
const RETRY_BACKOFF_MS = 500;

/**
 * @param {{ loadImage?: (src: string) => Promise<HTMLImageElement> }} opts
 *        loadImage swaps the browser loader for a test double.
 */
export function createAssetManager(opts = {}) {
  const loadImage = opts.loadImage || browserLoadImage;

  /** key -> { key, src, img, status: 'idle'|'loading'|'done'|'failed', error } */
  const assets = new Map();
  /** In-flight loadEssentialAssets() promise — joins duplicate callers. */
  let running = null;

  const register = (key, src) => {
    const existing = assets.get(key);
    if (existing && existing.src === src) return; // keep progress/status
    assets.set(key, { key, src, img: null, status: 'idle', error: null });
  };

  const assetEntries = () => [...assets.values()];

  const notify = (onProgress) => {
    if (typeof onProgress !== 'function') return;
    const { loaded, total, fraction } = manager.getProgress();
    onProgress({ loaded, total, fraction });
  };

  const loadOne = async (asset) => {
    asset.status = 'loading';
    for (let attempt = 1; attempt <= ATTEMPTS_PER_RUN; attempt++) {
      try {
        asset.img = await loadImage(asset.src);
        asset.status = 'done';
        asset.error = null;
        return;
      } catch (err) {
        asset.error = err;
        if (attempt < ATTEMPTS_PER_RUN) {
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * attempt));
        }
      }
    }
    asset.status = 'failed';
  };

  const runLoad = async (onProgress) => {
    const pending = assetEntries().filter((a) => a.status !== 'done');
    if (pending.length === 0) return { ok: manager.isEssentialReady(), failed: [] };
    notify(onProgress); // the bar can start moving from its true baseline

    const queue = pending.slice();
    const worker = async () => {
      while (queue.length > 0) {
        const asset = queue.shift();
        await loadOne(asset);
        notify(onProgress);
      }
    };
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT_LOADS, queue.length) },
      worker,
    );
    await Promise.all(workers);

    const failed = assetEntries().filter((a) => a.status === 'failed');
    return { ok: failed.length === 0, failed: failed.map(({ key, src, error }) => ({ key, src, error })) };
  };

  const manager = {
    /** Registers (or re-confirms) essential images; idempotent per key+src. */
    registerEssentialImages(list) {
      for (const { key, src } of list) register(key, src);
    },

    /**
     * Loads every registered essential image that is not done yet
     * (fresh loads, in-run retries, and explicit retries of previously
     * failed assets — successes are never re-downloaded). Duplicate
     * calls while running join the same load. Resolves with
     * { ok, failed: [{key, src, error}] }; never rejects.
     */
    loadEssentialAssets({ onProgress } = {}) {
      if (!running) {
        running = runLoad(onProgress).finally(() => { running = null; });
      }
      return running;
    },

    /** Decoded image for a key — undefined unless genuinely ready. */
    get(key) {
      const asset = assets.get(key);
      return asset && asset.status === 'done' ? asset.img : undefined;
    },

    /** Decoded image for a fruit sprite (e.g. getFruit('apple','left')). */
    getFruit(id, kind) {
      return manager.get(fruitKey(id, kind));
    },

    /** {whole, left, right} decoded images for a fruit, or undefined. */
    fruitImages(id) {
      const whole = manager.getFruit(id, 'whole');
      const left = manager.getFruit(id, 'left');
      const right = manager.getFruit(id, 'right');
      return whole && left && right ? { whole, left, right } : undefined;
    },

    /** Versioned URL a DOM element should use for a fruit sprite. */
    getPath(id, kind) {
      return fruitUrl(id, kind);
    },

    /** { loaded, total, fraction } over every registered asset. */
    getProgress() {
      const total = assets.size;
      const loaded = total === 0 ? 0
        : assetEntries().filter((a) => a.status === 'done').length;
      return { loaded, total, fraction: total === 0 ? 1 : loaded / total };
    },

    /** [{key, src}] for every asset that is not ready (loading or failed). */
    getMissingAssets() {
      return assetEntries()
        .filter((a) => a.status !== 'done')
        .map(({ key, src }) => ({ key, src }));
    },

    /** [{key, src}] for assets that definitively failed their attempts. */
    getFailedAssets() {
      return assetEntries()
        .filter((a) => a.status === 'failed')
        .map(({ key, src }) => ({ key, src }));
    },

    /** True only when EVERY registered asset is decoded and cached. */
    isEssentialReady() {
      return assets.size > 0 && assetEntries().every((a) => a.status === 'done');
    },

    /** Number of registered assets (30 fruits + 3 extras in production). */
    get size() {
      return assets.size;
    },

    /** Test/debug hook: live status of one asset. */
    statusOf(key) {
      const asset = assets.get(key);
      return asset ? asset.status : 'unknown';
    },
  };

  return manager;
}

/** Shared production manager (browser loader, real Image objects). */
export const assetManager = createAssetManager();
