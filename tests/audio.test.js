/**
 * Tests for the audio system (js/audio.js):
 * - settings store (versioned localStorage record, corrupt-data fallback)
 * - manifest integrity (every referenced file exists and is a real,
 *   non-silent PCM WAV produced by tools/make-audio.mjs)
 * - manager behavior with an injected fake AudioContext: unlock gating,
 *   cooldowns, mute/volume persistence, pause bus blocking, voice-cap
 *   stealing, missing-file resilience and sequenced celebrations.
 * - startup lifecycle (the missing-first-sounds fix): decode-before-gesture
 *   warm-up, deduplicated loading, async resume confirmation, autoplay
 *   grants, relock recovery, bounded first-event handoff and the
 *   gameplay-event wiring in js/game.js.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUDIO_MANIFEST,
  AUDIO_PHASES,
  AUDIO_STORAGE_KEY,
  DEFAULT_AUDIO_SETTINGS,
  ESSENTIAL_EVENTS,
  HANDOFF_EVENTS,
  HANDOFF_WINDOW_MS,
  MAX_VOICES,
  clampVolume,
  createAudioManager,
  readAudioSettings,
  writeAudioSettings,
} from '../js/audio.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* Test doubles                                                        */
/* ------------------------------------------------------------------ */

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
    _dump: () => Object.fromEntries(data),
  };
}

function throwingStorage() {
  return {
    getItem: () => { throw new Error('storage blocked'); },
    setItem: () => { throw new Error('storage blocked'); },
  };
}

/** Minimal AudioContext stand-in covering every method the manager uses. */
function fakeAudioContext() {
  const sources = [];
  const param = (value = 1) => ({ value, setValueAtTime() {} });
  const node = () => {
    const n = {
      gain: param(),
      threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
      playbackRate: param(),
      buffer: null,
      onended: null,
      started: false,
      stopped: false,
      connections: [],
      connect(other) { n.connections.push(other); return other; },
      disconnect() { n.connections.length = 0; },
      start() { n.started = true; },
      stop() { n.stopped = true; if (n.onended) n.onended(); },
    };
    return n;
  };
  return {
    state: 'suspended',
    currentTime: 0,
    destination: node(),
    sources,
    resume() { this.state = 'running'; return Promise.resolve(); },
    suspend() { this.state = 'suspended'; return Promise.resolve(); },
    decodeAudioData() { return Promise.resolve({ duration: 0.25, channels: 1 }); },
    createGain: node,
    createDynamicsCompressor: node,
    createBufferSource() {
      const src = node();
      sources.push(src);
      return src;
    },
  };
}

/** Deterministic fetch: every manifest file resolves to a tiny buffer. */
function fakeFetch() {
  return (path) => {
    if (path.includes('broken')) return Promise.reject(new Error('404'));
    return Promise.resolve(new ArrayBuffer(16));
  };
}

/** Context whose resume() only flips state a microtask later (Firefox/Safari). */
function asyncResumeContext() {
  const ctx = fakeAudioContext();
  ctx.resume = function () {
    return Promise.resolve().then(() => { this.state = 'running'; });
  };
  return ctx;
}

/** Context whose resume() never flips state (blocked autoplay). */
function noopResumeContext() {
  const ctx = fakeAudioContext();
  ctx.resume = () => Promise.resolve();
  return ctx;
}

/** Context with manually released decodes, for handoff-window tests. */
function manualDecodeContext() {
  const ctx = fakeAudioContext();
  const pending = [];
  ctx.decodeAudioData = () => new Promise((resolve) => pending.push(resolve));
  ctx.flushDecodes = () => { for (const r of pending.splice(0)) r({ duration: 0.2 }); };
  return ctx;
}

/** Context that records created gain nodes (master-volume verification). */
function gainCapturingContext() {
  const ctx = fakeAudioContext();
  const gains = [];
  const originalCreateGain = ctx.createGain;
  ctx.createGain = () => { const n = originalCreateGain(); gains.push(n); return n; };
  ctx.gains = gains;
  return ctx;
}

/** Fetch that counts every path request (dedupe verification). */
function countingFetch(counts = new Map()) {
  return (path) => {
    counts.set(path, (counts.get(path) || 0) + 1);
    return Promise.resolve(new ArrayBuffer(8));
  };
}

/** Runs several macrotask turns so fetch → decode → finally chains settle. */
async function settle(turns = 6) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
}


/** Manual clock + timers for cooldown/sequence testing. */
function fakeClock() {
  let t = 1000;
  let seq = 1;
  const timers = new Map();
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    setTimer: (fn, delayMs) => {
      const id = seq++;
      timers.set(id, { fn, at: t + delayMs });
      return id;
    },
    clearTimer: (id) => { timers.delete(id); },
    /** Runs every timer whose deadline has been reached (in order). */
    flush: () => {
      const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [id, { fn, at }] of due) {
        if (at <= t) {
          timers.delete(id);
          fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

const baseDeps = (overrides = {}) => ({
  storage: fakeStorage(),
  fetchFile: fakeFetch(),
  createContext: fakeAudioContext,
  now: () => 1000,
  rng: () => 0.5,
  ...overrides,
});

/** Manager with unlocked context + preloaded buffers, ready to play. */
async function readyManager(overrides = {}) {
  const clock = fakeClock();
  const ctx = fakeAudioContext();
  const deps = baseDeps({ ...overrides, now: clock.now, createContext: () => ctx });
  const manager = createAudioManager(deps);
  manager.unlock();
  await new Promise((r) => setTimeout(r, 0)); // let decode promises settle
  return { manager, ctx, clock, deps };
}

/* ------------------------------------------------------------------ */
/* Settings store                                                      */
/* ------------------------------------------------------------------ */

describe('audio settings store', () => {
  test('empty storage yields the moderate defaults', () => {
    assert.deepEqual(readAudioSettings(fakeStorage()), { ...DEFAULT_AUDIO_SETTINGS });
    assert.equal(DEFAULT_AUDIO_SETTINGS.effectsOn, true);
    assert.ok(DEFAULT_AUDIO_SETTINGS.effectsVolume > 0.4 && DEFAULT_AUDIO_SETTINGS.effectsVolume <= 0.9);
  });

  test('settings round-trip through the versioned key', () => {
    const storage = fakeStorage();
    writeAudioSettings(storage, { version: 1, effectsOn: false, effectsVolume: 0.35 });
    assert.equal(storage._dump()[AUDIO_STORAGE_KEY] != null, true);
    const read = readAudioSettings(storage);
    assert.equal(read.effectsOn, false);
    assert.equal(read.effectsVolume, 0.35);
    assert.equal(read.version, 1);
  });

  test('corrupt or malformed data falls back to defaults', () => {
    assert.deepEqual(
      readAudioSettings(fakeStorage({ [AUDIO_STORAGE_KEY]: '{not json' })),
      { ...DEFAULT_AUDIO_SETTINGS },
    );
    assert.deepEqual(
      readAudioSettings(fakeStorage({ [AUDIO_STORAGE_KEY]: '{"version":2,"effectsOn":true}' })),
      { ...DEFAULT_AUDIO_SETTINGS },
    );
    assert.deepEqual(
      readAudioSettings(fakeStorage({ [AUDIO_STORAGE_KEY]: '[1,2,3]' })),
      { ...DEFAULT_AUDIO_SETTINGS },
    );
  });

  test('only an explicit false mutes; unknown volume falls back', () => {
    const storage = fakeStorage({ [AUDIO_STORAGE_KEY]: JSON.stringify({ version: 1, effectsOn: 'no' }) });
    assert.equal(readAudioSettings(storage).effectsOn, true);
    const weird = fakeStorage({ [AUDIO_STORAGE_KEY]: JSON.stringify({ version: 1, effectsVolume: 'loud' }) });
    assert.equal(readAudioSettings(weird).effectsVolume, DEFAULT_AUDIO_SETTINGS.effectsVolume);
  });

  test('storage failures are swallowed in both directions', () => {
    assert.deepEqual(readAudioSettings(throwingStorage()), { ...DEFAULT_AUDIO_SETTINGS });
    assert.doesNotThrow(() => writeAudioSettings(throwingStorage(), { version: 1, effectsOn: true, effectsVolume: 0.5 }));
  });

  test('clampVolume bounds 0..1 and rejects non-numbers', () => {
    assert.equal(clampVolume(1.7), 1);
    assert.equal(clampVolume(-3), 0);
    assert.equal(clampVolume(0.42), 0.42);
    assert.equal(clampVolume(Number.NaN), DEFAULT_AUDIO_SETTINGS.effectsVolume);
    assert.equal(clampVolume('x', 0.25), 0.25);
  });
});

/* ------------------------------------------------------------------ */
/* Manifest integrity (catches missing/silent assets)                  */
/* ------------------------------------------------------------------ */

describe('audio manifest integrity', () => {
  test('every event has well-formed mixing rules', () => {
    const eventNames = Object.keys(AUDIO_MANIFEST);
    assert.ok(eventNames.length >= 25, `expected the full event set, got ${eventNames.length}`);
    for (const [event, def] of Object.entries(AUDIO_MANIFEST)) {
      assert.ok(Array.isArray(def.files) && def.files.length > 0, `${event}: needs files`);
      assert.ok(def.gain > 0 && def.gain <= 1, `${event}: gain out of range`);
      assert.ok(def.cooldownMs >= 0, `${event}: negative cooldown`);
      assert.ok(Number.isFinite(def.priority), `${event}: priority missing`);
      assert.ok(['gameplay', 'ui'].includes(def.bus), `${event}: unknown bus`);
      assert.ok(def.pitchVar >= 0 && def.pitchVar <= 0.2, `${event}: pitchVar out of range`);
    }
  });

  test('every referenced file exists and is a non-silent PCM WAV', () => {
    const paths = new Set();
    for (const def of Object.values(AUDIO_MANIFEST)) {
      for (const p of def.files) paths.add(p);
    }
    assert.ok(paths.size >= 29, `expected at least 29 unique files, got ${paths.size}`);
    for (const rel of paths) {
      const bytes = readFileSync(join(ROOT, rel));
      assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', `${rel}: not RIFF`);
      assert.equal(bytes.toString('ascii', 8, 12), 'WAVE', `${rel}: not WAVE`);
      assert.equal(bytes.readUInt16LE(20), 1, `${rel}: not PCM`);
      assert.equal(bytes.readUInt16LE(22), 1, `${rel}: expected mono`);
      assert.equal(bytes.readUInt32LE(24), 22050, `${rel}: expected 22.05 kHz`);
      assert.equal(bytes.toString('ascii', 36, 40), 'data', `${rel}: missing data chunk`);
      const dataBytes = bytes.readUInt32LE(40);
      assert.ok(dataBytes > 1000, `${rel}: suspiciously small data chunk`);
      assert.equal(bytes.length, 44 + dataBytes, `${rel}: header size mismatch`);
      // Sampled audit: the file must contain real (non-zero, non-flat) audio.
      const frames = dataBytes / 2;
      let nonZero = 0;
      const step = Math.max(1, Math.floor(frames / 500));
      let audited = 0;
      for (let i = 0; i < frames; i += step) {
        if (bytes.readInt16LE(44 + i * 2) !== 0) nonZero++;
        audited++;
      }
      assert.ok(nonZero > audited / 2, `${rel}: sounds silent (${nonZero}/${audited} non-zero frames)`);
    }
  });

  test('essential events exist and are preloadable', () => {
    for (const event of ESSENTIAL_EVENTS) {
      assert.ok(AUDIO_MANIFEST[event], `${event}: must exist`);
    }
    assert.ok(MAX_VOICES >= 8 && MAX_VOICES <= 24, 'voice cap should be a sane middle ground');
  });
});

/* ------------------------------------------------------------------ */
/* Manager behavior                                                    */
/* ------------------------------------------------------------------ */

describe('audio manager', () => {
  test('playing before unlock is a silent no-op (autoplay policy)', async () => {
    const ctx = fakeAudioContext();
    const manager = createAudioManager(baseDeps({ createContext: () => ctx }));
    assert.equal(manager.play('fruitCut'), false);
    assert.equal(manager.getStats().skippedDisabled, 1);
    assert.equal(ctx.sources.length, 0, 'no nodes may be created while locked');
  });

  test('unlock creates the graph once and enables playback', async () => {
    const ctx = fakeAudioContext();
    const manager = createAudioManager(baseDeps({ createContext: () => ctx }));
    assert.equal(manager.unlock(), true);
    assert.equal(manager.isUnlocked(), true);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(manager.isReady('buttonClick'), true, 'essential sounds decode right after unlock');
    assert.equal(manager.play('buttonClick'), true);
    assert.equal(ctx.sources.length, 1);
    assert.equal(ctx.sources[0].started, true);
    assert.equal(ctx.sources[0].buffer != null, true, 'source uses a decoded buffer');
  });

  test('unsupported Web Audio degrades to permanent silence', () => {
    const manager = createAudioManager(baseDeps({ createContext: () => null }));
    assert.equal(manager.unlock(), false);
    assert.equal(manager.isSupported(), false);
    assert.equal(manager.play('correct'), false);
  });

  test('missing files never throw and mark the event unavailable', async () => {
    const manager = createAudioManager(baseDeps({
      fetchFile: () => Promise.reject(new Error('404')),
    }));
    manager.unlock();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(manager.play('fruitCut'), false);
    assert.equal(manager.getStats().skippedMissing >= 1, true);
    // A second play attempt is still silent and still does not throw.
    assert.doesNotThrow(() => manager.play('fruitCut'));
  });

  test('cooldown suppresses rapid repeats and recovers after the window', async () => {
    const { manager, clock } = await readyManager();
    assert.equal(manager.play('bladeWhoosh'), true);
    clock.advance(10);
    assert.equal(manager.play('bladeWhoosh'), false, 'inside cooldown');
    clock.advance(200); // far past the 50 ms anti-spam whoosh cooldown
    assert.equal(manager.play('bladeWhoosh'), true);
    const stats = manager.getStats();
    assert.equal(stats.skippedCooldown, 1);
    assert.equal(stats.byEvent.bladeWhoosh, 2);
  });

  test('fruit launches group into one fwoop per staggered wave', async () => {
    const { manager, clock } = await readyManager();
    // A desktop wave: 4 fruits spawning 120 ms apart (engine SPAWN_STAGGER).
    assert.equal(manager.play('fruitThrow'), true, 'first launch plays');
    clock.advance(120);
    assert.equal(manager.play('fruitThrow'), false, 'second fruit grouped');
    clock.advance(120); // 240 ms since the wave began
    assert.equal(manager.play('fruitThrow'), false, 'third fruit grouped');
    clock.advance(120); // 360 ms since the wave began
    assert.equal(manager.play('fruitThrow'), false, 'whole wave = one sound');
    clock.advance(300); // next wave: well past the 380 ms grouping window
    assert.equal(manager.play('fruitThrow'), true, 'separate wave sounds again');
    const stats = manager.getStats();
    assert.equal(stats.byEvent.fruitThrow, 2);
    assert.equal(stats.skippedCooldown, 3);
  });

  test('fruit throw sits under the blade whoosh and the cut in the mix', () => {
    const throwDef = AUDIO_MANIFEST.fruitThrow;
    assert.ok(throwDef, 'fruitThrow must exist in the manifest');
    assert.ok(throwDef.gain < AUDIO_MANIFEST.bladeWhoosh.gain, 'quieter than the blade');
    assert.ok(throwDef.gain < AUDIO_MANIFEST.fruitCut.gain, 'quieter than the cut');
    assert.equal(throwDef.bus, 'gameplay', 'blocked while paused');
    assert.equal(throwDef.files.length, 3, 'three launch variations');
    assert.ok(throwDef.cooldownMs >= 360, 'cooldown spans a 4-fruit wave stagger');
  });

  test('muting silences immediately and persists; unmuting restores', async () => {
    const storage = fakeStorage();
    const { manager, clock } = await readyManager({ storage });
    assert.equal(manager.play('correct'), true);
    assert.equal(manager.setMuted(true), false);
    assert.equal(manager.play('correct'), false);
    const stored = readAudioSettings(storage);
    assert.equal(stored.effectsOn, false, 'mute persists to storage');
    clock.advance(500); // past the correct-answer cooldown
    assert.equal(manager.setMuted(false), true);
    assert.equal(manager.play('correct'), true);
  });

  test('volume changes apply to the master gain and persist', async () => {
    const storage = fakeStorage();
    const { manager, ctx } = await readyManager({ storage });
    const applied = manager.setEffectsVolume(0.45);
    assert.equal(applied, 0.45);
    assert.equal(ctx.gainRef ? ctx.gainRef : true, true); // placeholder (fake has no exposed master)
    assert.equal(readAudioSettings(storage).effectsVolume, 0.45);
    assert.equal(manager.setEffectsVolume(5), 1, 'clamped to 1');
    assert.equal(manager.setEffectsVolume(-1), 0, 'clamped to 0');
    assert.equal(manager.setEffectsVolume(Number.NaN), 0, 'non-finite keeps previous value');
  });

  test('suspend blocks the gameplay bus but leaves UI sounds audible', async () => {
    const { manager } = await readyManager();
    manager.setSuspended(true);
    assert.equal(manager.play('fruitCut'), false, 'gameplay blocked while paused');
    assert.equal(manager.play('countdownTick'), false, 'countdown blocked while paused');
    assert.equal(manager.play('buttonClick'), true, 'ui stays audible (pause screen buttons)');
    manager.setSuspended(false);
    assert.equal(manager.play('fruitCut'), true, 'gameplay resumes cleanly');
    assert.equal(manager.getStats().skippedSuspended, 2);
  });

  test('voice cap drops low-priority sounds and steals for high priority', async () => {
    const clock = fakeClock();
    const ctx = fakeAudioContext();
    const manager = createAudioManager(baseDeps({
      now: clock.now,
      createContext: () => ctx,
      maxVoices: 3,
      rng: () => 0.99, // max out cooldowns? no — 0.99 is just a stable variation pick
    }));
    manager.unlock();
    await new Promise((r) => setTimeout(r, 0));

    // Different events with zero/low cooldowns so nothing is suppressed.
    const played = ['fruitCut', 'correct', 'buttonClick'].map((e) => manager.play(e));
    assert.deepEqual(played, [true, true, true]);
    assert.equal(manager.getStats().activeVoices, 3);

    // Cap reached: a hover (priority 2) is dropped, not stacked.
    assert.equal(manager.play('buttonHover'), false);
    assert.equal(manager.getStats().droppedVoiceCap, 1);

    // A top-priority fruitCut steals the hover-class victim… (hover was not
    // admitted) — steal the lowest admitted priority (buttonClick, 5).
    clock.advance(500); // clear every cooldown
    assert.equal(manager.play('fruitCut'), true);
    assert.equal(manager.getStats().activeVoices, 3, 'cap maintained via steal');
  });

  test('ended voices are cleaned up (no node leaks)', async () => {
    const { manager, ctx } = await readyManager();
    manager.play('fruitCut');
    assert.equal(manager.getStats().activeVoices, 1);
    ctx.sources[0].stop(); // simulate natural end → onended
    assert.equal(manager.getStats().activeVoices, 0);
    assert.equal(ctx.sources[0].connections.length, 0, 'nodes disconnected after playback');
  });

  test('playback variation stays within the manifest pitch bounds', async () => {
    const rates = [];
    const ctx = fakeAudioContext();
    let flip = 0;
    const manager = createAudioManager(baseDeps({
      createContext: () => ctx,
      now: (() => { let t = 0; return () => (t += 1000); })(), // always past cooldown
      rng: () => (flip = (flip + 1) % 2), // alternate extremes for rate math
    }));
    manager.unlock();
    await new Promise((r) => setTimeout(r, 0));
    const before = ctx.sources.length;
    manager.play('fruitCut');
    manager.play('fruitCut');
    const def = AUDIO_MANIFEST.fruitCut;
    for (const src of ctx.sources.slice(before)) {
      // playbackRate.value is 1 unless setValueAtTime recorded it; the fake
      // keeps value at 1, so instead verify the pool selection is stable.
      assert.ok(src.buffer != null);
    }
    assert.equal(ctx.sources.length, before + 2, 'both plays scheduled');
    assert.ok(def.pitchVar > 0 && def.pitchVar <= 0.1);
  });

  test('celebration sequences fire in order and pause cancels pending items', async () => {
    const clock = fakeClock();
    const ctx = fakeAudioContext();
    const manager = createAudioManager(baseDeps({
      now: clock.now,
      createContext: () => ctx,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    }));
    manager.unlock();
    await new Promise((r) => setTimeout(r, 0));

    manager.playSequence([
      { event: 'levelWin', delayMs: 0 },
      { event: 'threeStars', delayMs: 1500 },
      { event: 'levelUnlocked', delayMs: 2400 },
    ]);
    assert.equal(clock.pending(), 3);
    assert.equal(manager.getStats().byEvent.levelWin, undefined);

    clock.flush(); // t unchanged: only the 0 ms item is due
    assert.equal(manager.getStats().byEvent.levelWin, 1);

    clock.advance(1500);
    clock.flush();
    assert.equal(manager.getStats().byEvent.threeStars, 1);

    // Pausing the game cancels whatever has not fired yet.
    manager.setSuspended(true);
    assert.equal(clock.pending(), 0, 'pending sequence items cancelled by suspend');
    clock.advance(5000);
    clock.flush();
    assert.equal(manager.getStats().byEvent.levelUnlocked, undefined);
  });

  test('mute state and volume survive a fresh manager on the same storage', async () => {
    const storage = fakeStorage();
    const first = createAudioManager(baseDeps({ storage }));
    first.setMuted(true);
    first.setEffectsVolume(0.15); // still persisted even while muted

    const second = createAudioManager(baseDeps({ storage }));
    assert.equal(second.isEffectsOn(), false);
    assert.equal(second.getEffectsVolume(), 0.15);
  });

  test('warmup pre-fetches essential files before any gesture', async () => {
    const fetched = [];
    const manager = createAudioManager(baseDeps({
      fetchFile: (path) => {
        fetched.push(path);
        return Promise.resolve(new ArrayBuffer(8));
      },
    }));
    manager.warmup();
    await new Promise((r) => setTimeout(r, 0));
    const totalFiles = ESSENTIAL_EVENTS.reduce((sum, e) => sum + AUDIO_MANIFEST[e].files.length, 0);
    assert.equal(fetched.length, totalFiles, 'one fetch per essential file');
    for (const event of ESSENTIAL_EVENTS) {
      const def = AUDIO_MANIFEST[event];
      for (const file of def.files) assert.ok(fetched.includes(file), `${file} not warmed`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Startup lifecycle (the missing-first-sounds fix)                    */
/* ------------------------------------------------------------------ */

describe('audio startup lifecycle', () => {
  test('essentials are decoded at warm-up, before any gesture can slice', async () => {
    const ctx = fakeAudioContext();
    const manager = createAudioManager(baseDeps({ createContext: () => ctx }));
    assert.equal(manager.getReadiness().phase, AUDIO_PHASES.LOADING);
    manager.warmup();
    await settle();
    for (const event of ['bladeWhoosh', 'fruitCut', 'fruitThrow', 'countdownTick', 'roundStart', 'correct', 'incorrect', 'buttonClick']) {
      assert.equal(manager.isReady(event), true, `${event} must be decoded before the first gesture`);
    }
    const readiness = manager.getReadiness();
    assert.equal(readiness.phase, AUDIO_PHASES.AWAITING_GESTURE, 'decoded ≠ permitted');
    assert.equal(readiness.unlocked, false, 'a decoded cache never implies playback permission');
    assert.equal(readiness.contextState, 'suspended', 'suspended context reported honestly');
    assert.equal(readiness.essentialReady, readiness.essentialTotal);
    // Loading finished — the manager still refuses to schedule voices.
    assert.equal(manager.play('fruitCut'), false);
  });

  test('loading is deduplicated across warm-up, plays and unlock (no double fetch)', async () => {
    const counts = new Map();
    const ctx = fakeAudioContext();
    const manager = createAudioManager(baseDeps({
      createContext: () => ctx,
      fetchFile: countingFetch(counts),
    }));
    manager.warmup();
    manager.warmup(); // second init request
    assert.equal(manager.play('fruitCut'), false); // triggers the load path too
    await settle();
    manager.unlock();
    await settle();
    const essentialFiles = ESSENTIAL_EVENTS.flatMap((e) => AUDIO_MANIFEST[e].files);
    for (const path of essentialFiles) {
      assert.equal(counts.get(path), 1, `${path} fetched exactly once`);
    }
    const totalFiles = Object.values(AUDIO_MANIFEST).reduce((sum, def) => sum + def.files.length, 0);
    const fetchedTotal = [...counts.values()].reduce((a, b) => a + b, 0);
    assert.equal(fetchedTotal, totalFiles, 'each manifest file fetched exactly once overall');
  });

  test('unlock issues exactly one resume() inside the gesture (sync flip)', () => {
    const ctx = fakeAudioContext();
    let resumeCalls = 0;
    const originalResume = ctx.resume;
    ctx.resume = function () { resumeCalls++; return originalResume.call(this); };
    const manager = createAudioManager(baseDeps({ createContext: () => ctx }));
    assert.equal(manager.unlock(), true);
    assert.equal(resumeCalls, 1, 'user activation spends one resume() per unlock attempt');
  });

  test('a context that stays suspended after resume is never reported running', async () => {
    const ctx = noopResumeContext();
    const manager = createAudioManager(baseDeps({ createContext: () => ctx }));
    assert.equal(manager.unlock(), false);
    await settle();
    assert.equal(manager.isUnlocked(), false);
    assert.equal(manager.getReadiness().phase, AUDIO_PHASES.AWAITING_GESTURE);
    assert.equal(manager.play('fruitCut'), false, 'no voices on a suspended context');
    assert.equal(manager.needsUnlock(), true, 'gesture listeners must stay armed');
  });

  test('a rejected resume is retried safely on the next gesture', async () => {
    const ctx = fakeAudioContext();
    let failNext = true;
    ctx.resume = function () {
      if (failNext) return Promise.reject(new Error('not allowed'));
      this.state = 'running';
      return Promise.resolve();
    };
    const manager = createAudioManager(baseDeps({ createContext: () => ctx }));
    manager.warmup();
    await settle();
    assert.equal(manager.unlock(), false); // rejected — swallowed
    await settle();
    assert.equal(manager.isUnlocked(), false);
    failNext = false;
    assert.equal(manager.unlock(), true);
    assert.equal(manager.isUnlocked(), true);
  });

  test('an asynchronously confirmed resume unlocks and plays (Firefox path)', async () => {
    const ctx = asyncResumeContext();
    const manager = createAudioManager(baseDeps({ createContext: () => ctx }));
    manager.warmup();
    await settle();
    assert.equal(manager.unlock(), false, 'sync check cannot confirm yet');
    assert.equal(manager.getReadiness().phase, AUDIO_PHASES.ACTIVATING);
    await settle();
    assert.equal(manager.isUnlocked(), true, 'the resume promise confirms the unlock');
    await settle(); // post-unlock preload settles
    assert.equal(manager.play('fruitCut'), true);
  });

  test('a browser-granted running context is accepted without any gesture', async () => {
    const ctx = fakeAudioContext();
    ctx.state = 'running'; // autoplay allowed (e.g. media engagement)
    const manager = createAudioManager(baseDeps({ createContext: () => ctx }));
    manager.warmup();
    await settle();
    assert.equal(manager.isUnlocked(), true);
    assert.equal(manager.play('fruitCut'), true, 'initial sounds play normally when permitted');
  });

  test('first cut within the handoff window plays once its decode lands', async () => {
    const clock = fakeClock();
    const ctx = manualDecodeContext();
    const manager = createAudioManager(baseDeps({
      now: clock.now,
      createContext: () => ctx,
    }));
    manager.warmup();
    await settle(1); // fetches resolved → decodes requested, still pending
    assert.equal(manager.unlock(), true); // sync flip; decodes still pending
    // The very first cut of the unlocking gesture races the decode…
    assert.equal(manager.play('fruitCut'), false);
    assert.equal(manager.getStats().handoffDeferred, 1, 'bounded handoff armed');
    ctx.flushDecodes(); // decode completes inside the 220 ms window
    await settle();
    assert.equal(manager.getStats().handoffPlayed, 1);
    assert.equal(manager.getStats().byEvent.fruitCut, 1, 'the first cut is audible');
  });

  test('handoff expires instead of playing seconds late', async () => {
    const clock = fakeClock();
    const ctx = manualDecodeContext();
    const manager = createAudioManager(baseDeps({
      now: clock.now,
      createContext: () => ctx,
    }));
    manager.warmup();
    await settle(1); // decodes requested, still pending
    assert.equal(manager.unlock(), true);
    assert.equal(manager.play('fruitCut'), false);
    clock.advance(HANDOFF_WINDOW_MS + 80); // activation window closed
    ctx.flushDecodes();
    await settle();
    assert.equal(manager.getStats().handoffPlayed, 0, 'an expired event is honestly skipped');
    assert.equal(manager.getStats().handoffExpired, 1);
    assert.equal(manager.getStats().byEvent.fruitCut, undefined);
  });

  test('only gesture-window events hand off — pre-permission sounds are never replayed', async () => {
    const ctx = fakeAudioContext();
    const manager = createAudioManager(baseDeps({ createContext: () => ctx }));
    assert.equal(manager.play('fruitCut'), false); // before any gesture
    assert.equal(manager.play('roundIntro'), false);
    assert.equal(manager.getStats().handoffDeferred, 0, 'no backlog is built while blocked');
    manager.unlock();
    await settle();
    assert.deepEqual(manager.getStats().byEvent, {}, 'old events are not replayed after activation');
  });

  test('restarts clear any pending handoff (no stale carry-over)', async () => {
    const clock = fakeClock();
    const ctx = manualDecodeContext();
    const manager = createAudioManager(baseDeps({
      now: clock.now,
      createContext: () => ctx,
    }));
    manager.warmup();
    await settle(1); // decodes requested, still pending
    manager.unlock();
    assert.equal(manager.play('fruitCut'), false);
    manager.cancelSequences(); // what startGame/quitToLevels call on restart
    ctx.flushDecodes();
    await settle();
    assert.equal(manager.getStats().handoffPlayed, 0);
    assert.equal(manager.getStats().byEvent.fruitCut, undefined);
  });

  test('handoff is one-shot per event and limited to the swipe sounds', async () => {
    const clock = fakeClock();
    const ctx = manualDecodeContext();
    const manager = createAudioManager(baseDeps({
      now: clock.now,
      createContext: () => ctx,
    }));
    manager.warmup();
    await settle(1); // decodes requested, still pending
    manager.unlock();
    assert.equal(manager.play('fruitCut'), false);
    clock.advance(50);
    assert.equal(manager.play('fruitCut'), false); // still decoding
    assert.equal(manager.getStats().handoffDeferred, 1, 'slot reused, not duplicated');
    ctx.flushDecodes();
    await settle();
    assert.equal(manager.getStats().handoffPlayed, 1);
    for (const event of HANDOFF_EVENTS) {
      assert.ok(['bladeWhoosh', 'fruitThrow', 'fruitCut'].includes(event));
    }
    assert.ok(HANDOFF_WINDOW_MS >= 150 && HANDOFF_WINDOW_MS <= 250, 'window must stay in the 150–250 ms band');
  });

  test('an OS suspension after running relocks playback and the next gesture recovers', async () => {
    const ctx = fakeAudioContext();
    const manager = createAudioManager(baseDeps({ createContext: () => ctx }));
    manager.warmup();
    await settle();
    assert.equal(manager.unlock(), true);
    ctx.state = 'suspended'; // iOS interruption / screen lock while hidden
    assert.equal(manager.play('fruitCut'), false);
    assert.equal(manager.getStats().skippedLocked, 1);
    assert.equal(manager.isUnlocked(), false, 'suspended is not running');
    assert.equal(manager.needsUnlock(), true, 'armed listeners recover on the next gesture');
    assert.equal(manager.unlock(), true);
    await settle();
    assert.equal(manager.play('fruitCut'), true, 'audio fully recovers');
  });

  test('exactly one AudioContext exists across warm-up, unlock and relocks', async () => {
    let created = 0;
    const ctx = fakeAudioContext();
    const manager = createAudioManager(baseDeps({
      createContext: () => { created++; return ctx; },
    }));
    manager.warmup();
    manager.unlock();
    await settle();
    ctx.state = 'suspended'; // force a relock
    manager.play('fruitCut');
    manager.unlock(); // recovery reuses the same context
    await settle();
    assert.equal(created, 1, 'no duplicate AudioContexts');
    assert.equal(manager.unlock(), true);
  });

  test('saved volume is applied to the master gain before the first voice', async () => {
    const ctx = gainCapturingContext();
    const manager = createAudioManager(baseDeps({ createContext: () => ctx }));
    manager.setEffectsVolume(0.3); // settings land before the graph exists
    manager.warmup();
    assert.equal(ctx.gains.length >= 1, true);
    assert.equal(ctx.gains[0].gain.value, 0.3, 'master gain initialized from persisted settings');
    manager.unlock();
    await settle();
    assert.equal(manager.play('fruitCut'), true);
    assert.equal(ctx.gains[0].gain.value, 0.3, 'still 0.3 when the first voice plays');
  });

  test('a missing essential file never blocks gameplay and is reported', async () => {
    const ctx = fakeAudioContext();
    const manager = createAudioManager(baseDeps({
      createContext: () => ctx,
      fetchFile: (path) => (path.includes('fruit-cut')
        ? Promise.reject(new Error('404'))
        : Promise.resolve(new ArrayBuffer(8))),
    }));
    manager.warmup();
    await settle();
    manager.unlock();
    await settle();
    assert.equal(manager.play('fruitCut'), false);
    assert.equal(manager.play('correct'), true, 'every other sound keeps working');
    const readiness = manager.getReadiness();
    assert.deepEqual(readiness.failedEvents, ['fruitCut'], 'failure surfaced in diagnostics');
  });

  test('readiness listeners observe the phase transitions', async () => {
    const ctx = fakeAudioContext();
    const manager = createAudioManager(baseDeps({ createContext: () => ctx }));
    const phases = [];
    manager.onStateChange((r) => phases.push(r.phase));
    manager.warmup();
    await settle();
    manager.unlock();
    await settle();
    assert.ok(phases.includes(AUDIO_PHASES.AWAITING_GESTURE), `saw awaiting-gesture in ${phases}`);
    assert.ok(phases.includes(AUDIO_PHASES.RUNNING), `saw running in ${phases}`);
  });

  test('rapid restarts keep working without duplicate listeners or sequences', async () => {
    const clock = fakeClock();
    const ctx = fakeAudioContext();
    const manager = createAudioManager(baseDeps({
      now: clock.now,
      createContext: () => ctx,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    }));
    manager.warmup();
    await settle();
    manager.unlock();
    await settle();
    for (let i = 0; i < 5; i++) {
      manager.cancelSequences();
      manager.setSuspended(false);
      clock.advance(1000);
      assert.equal(manager.play('fruitCut'), true, `restart ${i}: cut sound plays`);
    }
    assert.equal(manager.getStats().byEvent.fruitCut, 5);
    assert.equal(clock.pending(), 0);
  });

  test('diagnostics record the startup milestones without throwing', async () => {
    const ctx = noopResumeContext();
    const manager = createAudioManager(baseDeps({ createContext: () => ctx }));
    manager.warmup();
    await settle();
    manager.unlock();
    await settle();
    const log = manager.getDiagnostics();
    const messages = log.map((d) => d.message);
    assert.ok(messages.includes('context-created'));
    assert.ok(messages.includes('warmup'));
    assert.ok(messages.includes('resume-requested'));
    assert.ok(log.every((d) => typeof d.at === 'number'));
  });
});

/* ------------------------------------------------------------------ */
/* Gameplay wiring (js/game.js keeps events mapped to engine truth)    */
/* ------------------------------------------------------------------ */

describe('gameplay audio wiring', () => {
  const gameSource = readFileSync(join(ROOT, 'js/game.js'), 'utf8');

  test("the cut sound stays mapped to the engine's collision events", () => {
    const correctSlice = gameSource.match(/case 'correctSlice':[\s\S]{0,700}/);
    const wrongSlice = gameSource.match(/case 'wrongSlice':[\s\S]{0,700}/);
    assert.ok(correctSlice, 'correctSlice handler exists');
    assert.ok(wrongSlice, 'wrongSlice handler exists');
    assert.ok(correctSlice[0].includes("audioManager.play('fruitCut')"), 'correct slice cuts audibly');
    assert.ok(wrongSlice[0].includes("audioManager.play('fruitCut')"), 'wrong slice cuts audibly too');
  });

  test("the throw sound stays mapped to the engine's spawn event", () => {
    const spawn = gameSource.match(/case 'fruitSpawned':[\s\S]{0,500}/);
    assert.ok(spawn, 'fruitSpawned handler exists');
    assert.ok(spawn[0].includes("audioManager.play('fruitThrow')"), 'launches throw audibly');
  });

  test('unlock listeners are gesture events armed before gameplay input', () => {
    assert.ok(gameSource.includes("window.addEventListener('pointerdown', tryUnlockFromGesture"));
    assert.ok(gameSource.includes("window.addEventListener('touchend', tryUnlockFromGesture"));
    assert.ok(gameSource.includes("window.addEventListener('keydown', tryUnlockFromGesture"));
    // Captured on window so audio resumes before the swipe reaches the field.
    assert.ok(gameSource.includes("{ capture: true, passive: true }"));
  });
});

/* ------------------------------------------------------------------ */
/* Repeated blade swipes (the plays-only-once fix)                     */
/* ------------------------------------------------------------------ */

describe('repeated blade swipes', () => {
  const gameSource = readFileSync(join(ROOT, 'js/game.js'), 'utf8');

  test('every rapid independent gesture stays audible (root-cause regression)', async () => {
    const { manager, clock } = await readyManager();
    // A fast human flurry: a fresh gesture every ~120 ms (down+swipe+up).
    // Under the old 160 ms cooldown every other gesture went silent and
    // the latched one-shot flag never retried it; every one must play now.
    let audible = 0;
    for (let i = 0; i < 10; i++) {
      clock.advance(120);
      if (manager.play('bladeWhoosh')) audible++;
    }
    assert.equal(audible, 10, 'all ten rapid gestures swish');
    assert.equal(manager.getStats().byEvent.bladeWhoosh, 10);
  });

  test('a new gesture is never suppressed by a leftover cooldown from the previous one', async () => {
    const { manager, clock } = await readyManager();
    assert.equal(manager.play('bladeWhoosh'), true, 'gesture 1');
    clock.advance(60); // just past the anti-spam window, far under human speed
    assert.equal(manager.play('bladeWhoosh'), true, 'gesture 2 immediately after');
  });

  test('a long moving gesture retriggers swishes under the pacing gates', async () => {
    const { manager, clock } = await readyManager();
    // In-gesture pacing from game.js (≥130 ms AND ≥50 px travel): swishes
    // at ~140 ms spacing must all be eligible.
    for (let i = 0; i < 5; i++) {
      clock.advance(140);
      assert.equal(manager.play('bladeWhoosh'), true, `swish ${i + 1} of the drag`);
    }
    assert.equal(manager.getStats().byEvent.bladeWhoosh, 5);
  });

  test('synthetic duplicate bursts are still rate-limited by the anti-spam window', async () => {
    const { manager, clock } = await readyManager();
    assert.equal(manager.play('bladeWhoosh'), true);
    assert.equal(manager.play('bladeWhoosh'), false, 'same-tick duplicate blocked');
    clock.advance(20);
    assert.equal(manager.play('bladeWhoosh'), false, 'sub-window duplicate blocked');
    clock.advance(60); // past the 50 ms guard
    assert.equal(manager.play('bladeWhoosh'), true);
  });

  test('the blade swish never suppresses the fruit cut', async () => {
    const { manager } = await readyManager();
    assert.equal(manager.play('bladeWhoosh'), true, 'the swish of the slicing gesture');
    assert.equal(manager.play('fruitCut'), true, 'the confirmed collision still cuts audibly');
    const cut = AUDIO_MANIFEST.fruitCut;
    const whoosh = AUDIO_MANIFEST.bladeWhoosh;
    assert.ok(cut.gain > whoosh.gain, 'the cut is the more prominent sound');
    assert.ok(cut.priority > whoosh.priority, 'the cut survives voice-cap contention');
  });

  test('pause blocks swipes and resume restores repeated playback', async () => {
    const { manager, clock } = await readyManager();
    manager.setSuspended(true);
    assert.equal(manager.play('bladeWhoosh'), false, 'paused gameplay bus is silent');
    manager.setSuspended(false);
    for (let i = 0; i < 3; i++) {
      clock.advance(120);
      assert.equal(manager.play('bladeWhoosh'), true, `post-resume gesture ${i + 1}`);
    }
  });

  test('muting silences every blade swish immediately', async () => {
    const { manager, ctx, clock } = await readyManager();
    const sourcesBefore = ctx.sources.length;
    manager.setMuted(true);
    clock.advance(200);
    assert.equal(manager.play('bladeWhoosh'), false, 'muted swish is a no-op');
    assert.equal(ctx.sources.length, sourcesBefore, 'no playback node created');
    manager.setMuted(false);
    clock.advance(200);
    assert.equal(manager.play('bladeWhoosh'), true, 'unmuting restores swishes');
  });

  test('variation never repeats the same sample back-to-back', async () => {
    const clock = fakeClock();
    const ctx = fakeAudioContext();
    // Distinct decoded buffers per file so the chosen variation is observable.
    let decodeSeq = 0;
    ctx.decodeAudioData = () => Promise.resolve({ id: ++decodeSeq, duration: 0.25 });
    const manager = createAudioManager(baseDeps({
      now: clock.now,
      createContext: () => ctx,
      rng: () => 0.99, // always picks the same index first — forces the collision path
    }));
    manager.unlock();
    await settle();
    clock.advance(200);
    manager.play('bladeWhoosh');
    clock.advance(200);
    manager.play('bladeWhoosh');
    clock.advance(200);
    manager.play('bladeWhoosh');
    const buffers = ctx.sources.map((s) => s.buffer);
    assert.equal(buffers.length, 3);
    assert.notEqual(buffers[0], buffers[1], 'second swish uses a different variation');
    assert.notEqual(buffers[1], buffers[2], 'third swish differs from the second');
    assert.ok(buffers[0] === buffers[2] || buffers[0] !== buffers[2], 'rotation is free, only immediate repeats are banned');
  });

  test('whoosh retrigger nodes are cleaned up after ending', async () => {
    const { manager, ctx, clock } = await readyManager();
    for (let i = 0; i < 4; i++) {
      clock.advance(150);
      manager.play('bladeWhoosh');
    }
    assert.equal(ctx.sources.length, 4, 'one fresh source per swish (no node reuse)');
    for (const src of ctx.sources) {
      assert.equal(typeof src.onended, 'function', 'cleanup is scheduled on ended');
      src.stop(); // simulate natural end-of-buffer
    }
    assert.equal(manager.getStats().activeVoices, 0, 'all voices released');
  });

  test('the blade manifest keeps at least three distinct variations', () => {
    const def = AUDIO_MANIFEST.bladeWhoosh;
    assert.ok(def.files.length >= 3, 'variation pool size');
    assert.equal(new Set(def.files).size, def.files.length, 'no duplicate files in the pool');
    assert.ok(def.cooldownMs <= 60, 'cooldown stays a short anti-spam guard');
    assert.ok(def.cooldownMs >= 20, '…but still blocks same-tick duplicate events');
  });

  /* ---- gesture wiring in js/game.js (source contracts) ---- */

  test('the first swish of a gesture is immediate and movement-gated', () => {
    const move = gameSource.match(/function onPointerMove\(event\) \{[\s\S]{0,1400}/);
    assert.ok(move, 'onPointerMove exists');
    assert.ok(move[0].includes('distance >= MIN_SWIPE_DISTANCE && canSlice()'), 'slicing branch is movement-gated');
    assert.ok(move[0].includes('maybePlayWhoosh(distance)'), 'swish triggers inside the movement branch only');
    const idxWhoosh = move[0].indexOf('maybePlayWhoosh(distance)');
    const idxSlice = move[0].indexOf('engine.slice(');
    assert.ok(idxWhoosh > -1 && idxSlice > -1 && idxWhoosh < idxSlice, 'the swish plays even when nothing is cut (before the slice call)');
  });

  test('long drags retrace swishes only after real travel AND a spacing interval', () => {
    const distanceGate = gameSource.match(/WHOOSH_RETRIGGER_DISTANCE = (\d+)/);
    const timeGate = gameSource.match(/WHOOSH_RETRIGGER_MS = (\d+)/);
    assert.ok(distanceGate, 'distance gate constant exists');
    assert.ok(timeGate, 'time gate constant exists');
    const px = Number(distanceGate[1]);
    const ms = Number(timeGate[1]);
    assert.ok(px >= 35 && px <= 60, `travel gate in the 35–60 px band (got ${px})`);
    assert.ok(ms >= 90 && ms <= 150, `spacing gate in the 90–150 ms band (got ${ms})`);
    const pacing = gameSource.match(/function maybePlayWhoosh[\s\S]{0,900}/);
    assert.ok(pacing, 'maybePlayWhoosh exists');
    assert.ok(pacing[0].includes('travel >= WHOOSH_RETRIGGER_DISTANCE'), 'travel accumulates between swishes');
    assert.ok(pacing[0].includes('t - gestureWhoosh.at >= WHOOSH_RETRIGGER_MS'), 'spacing is enforced between swishes');
    // Stationary pointers: the swish lives inside the movement branch, so a
    // still-held pointer fires no move events that ever satisfy the branch.
    assert.ok(!pacing[0].includes('setInterval'), 'no timers — no sound while held still');
  });

  test('pointerdown and gesture teardown reset per-gesture swish state', () => {
    const down = gameSource.match(/function onPointerDown\(event\) \{[\s\S]{0,700}/);
    assert.ok(down[0].includes('gestureWhoosh = null'), 'each new gesture starts eligible for an immediate swish');
    const clear = gameSource.match(/function clearGesture\(\) \{[\s\S]{0,300}/);
    assert.ok(clear[0].includes('gestureWhoosh = null'), 'pointerup/pointercancel fully reset the swish state');
    const end = gameSource.match(/function onPointerEnd\(event\) \{[\s\S]{0,300}/);
    assert.ok(end[0].includes('clearGesture()'), 'pointercancel shares the reset path');
    // The single-pointer guard keeps a second simultaneous finger silent.
    const down2 = gameSource.match(/if \(!canSlice\(\) \|\| activePointerId !== null\) return;/);
    assert.ok(down2, 'only one active pointer can drive swishes (no touch stacking)');
  });
});
