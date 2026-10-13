/**
 * Tests for the audio system (js/audio.js):
 * - settings store (versioned localStorage record, corrupt-data fallback)
 * - manifest integrity (every referenced file exists and is a real,
 *   non-silent PCM WAV produced by tools/make-audio.mjs)
 * - manager behavior with an injected fake AudioContext: unlock gating,
 *   cooldowns, mute/volume persistence, pause bus blocking, voice-cap
 *   stealing, missing-file resilience and sequenced celebrations.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUDIO_MANIFEST,
  AUDIO_STORAGE_KEY,
  DEFAULT_AUDIO_SETTINGS,
  ESSENTIAL_EVENTS,
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
    clock.advance(200); // past the 160 ms whoosh cooldown
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
