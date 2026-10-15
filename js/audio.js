/**
 * Word Slice — central audio manager.
 *
 * Owns every sound the game makes. The browser layer (js/game.js) maps
 * engine + UI events to `audioManager.play('<eventName>')` and never
 * creates Audio elements or nodes itself.
 *
 * Startup lifecycle (the fix for missing first sounds):
 * - The single AudioContext is created at page load, already suspended.
 *   `decodeAudioData` is NOT gated by autoplay policy, so the essential
 *   buffers are fetched and decoded during the round introduction — before
 *   the first gesture can possibly slice anything.
 * - `resume()` is only ever called synchronously inside a trusted user
 *   gesture handler (registered in game.js). Nothing is awaited before it.
 * - A context the browser itself puts into 'running' (autoplay granted)
 *   is accepted without a gesture; blocked playback is reported honestly
 *   through the readiness model so the browser layer can arm or disarm
 *   its gesture-unlock listeners (no button, no modal, no extra action).
 * - A bounded first-event handoff (≤ HANDOFF_WINDOW_MS) lets the very
 *   first cut/throw after activation survive a decode that is still in
 *   flight; anything older or later is dropped, never replayed.
 * - If the OS suspends a running context (iOS tab switch, screen lock),
 *   playback is marked locked again and the next gesture re-resumes it.
 *
 * Other design constraints:
 * - Sounds are fetched and decoded once, cached per event, and reused —
 *   no per-slice decoding, no `new Audio()`. Every load goes through the
 *   same deduplicating `loading` map, so warm-up, post-unlock preload and
 *   first-play triggers can never double-fetch or overwrite valid buffers.
 * - Per-event cooldowns prevent whoosh/hover spam; a voice cap with
 *   priority stealing plus a master compressor prevents clipping and
 *   runaway layering during rapid swipes.
 * - Two buses: 'gameplay' (silenced while the game is paused via
 *   setSuspended) and 'ui' (buttons stay audible on pause screens).
 * - Missing files, unsupported Web Audio and storage failures never
 *   throw: the affected event (or all audio) simply stays silent and the
 *   failure is recorded in the readiness diagnostics.
 *
 * Playback timing/deck: pitch + sample variation keeps repeated slices
 * from sounding identical (small, bounded detune per play).
 *
 * The pure parts (settings store, manifest) and the manager factory
 * (dependency-injectable context/fetch/clock) are exercised by
 * tests/audio.test.js under Node without a real AudioContext.
 */

/* ------------------------------------------------------------------ */
/* Settings (versioned localStorage record, separate from progress)    */
/* ------------------------------------------------------------------ */

export const AUDIO_STORAGE_KEY = 'word-slice:v1:audio';
/** Development-only diagnostics switch (?audiodebug=1 also works). */
export const AUDIO_DEBUG_KEY = 'word-slice:v1:audio-debug';

/** Moderate default level; persisted per user choice. */
export const DEFAULT_AUDIO_SETTINGS = Object.freeze({
  version: 1,
  effectsOn: true,
  effectsVolume: 0.8,
});

/** Clamps to 0..1; anything not a finite number becomes `fallback`. */
export function clampVolume(value, fallback = DEFAULT_AUDIO_SETTINGS.effectsVolume) {
  const v = Number(value);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(1, Math.max(0, v));
}

function normalizeSettings(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.version !== 1) return null;
  return {
    version: 1,
    effectsOn: data.effectsOn !== false, // only an explicit false mutes
    effectsVolume: clampVolume(data.effectsVolume),
  };
}

/** Reads audio settings; corrupt/missing data falls back to defaults. */
export function readAudioSettings(storage) {
  try {
    const raw = storage.getItem(AUDIO_STORAGE_KEY);
    if (raw) {
      const parsed = normalizeSettings(JSON.parse(raw));
      if (parsed) return parsed;
    }
  } catch {
    /* unavailable or corrupt — defaults */
  }
  return { ...DEFAULT_AUDIO_SETTINGS };
}

/** Best-effort write; storage failures never break gameplay. */
export function writeAudioSettings(storage, settings) {
  try {
    storage.setItem(AUDIO_STORAGE_KEY, JSON.stringify(normalizeSettings(settings) || DEFAULT_AUDIO_SETTINGS));
  } catch {
    /* private mode / quota — keep playing with in-memory settings */
  }
}

/* ------------------------------------------------------------------ */
/* Manifest: gameplay/UI events → sound files + mixing rules          */
/* ------------------------------------------------------------------ */

/**
 * Fields per event:
 * - files:   variation pool (one is picked per play)
 * - gain:    mixing level relative to the master effects volume
 * - cooldownMs: minimum spacing between plays of this event
 * - priority: 0..10 — higher survives voice-cap contention
 * - bus:     'gameplay' (blocked while paused) or 'ui' (always allowed)
 * - pitchVar: ± fraction of playback-rate variation per play
 *
 * Files are 16-bit mono 22.05 kHz PCM WAV, generated by
 * tools/make-audio.mjs (no OGG encoder available in this environment).
 */
export const AUDIO_MANIFEST = Object.freeze({
  bladeWhoosh: {
    // Movement only — always clearly quieter than an actual fruit cut.
    // The cooldown here is a short anti-spam guard for synthetic/duplicate
    // input bursts, NOT the gesture rhythm: normal rapid swiping is paced
    // by the movement gates in game.js (first swish immediate, further
    // swishes after real pointer travel + ~130 ms), so it must never be
    // held back by a cooldown left over from an earlier gesture.
    bus: 'gameplay', gain: 0.5, cooldownMs: 50, priority: 6, pitchVar: 0.08,
    files: [
      'assets/audio/slicing/blade-whoosh-1.wav',
      'assets/audio/slicing/blade-whoosh-2.wav',
      'assets/audio/slicing/blade-whoosh-3.wav',
      'assets/audio/slicing/blade-whoosh-4.wav',
    ],
  },
  fruitCut: {
    // The hero effect: sharpest sound, highest priority, minimal cooldown so
    // rapid multi-fruit swipes stay distinct. ±3% pitch keeps repetition
    // natural without shifting the character of the cut.
    bus: 'gameplay', gain: 0.95, cooldownMs: 24, priority: 10, pitchVar: 0.03,
    files: [
      'assets/audio/slicing/fruit-cut-1.wav',
      'assets/audio/slicing/fruit-cut-2.wav',
      'assets/audio/slicing/fruit-cut-3.wav',
    ],
  },
  fruitThrow: {
    // Fruits launching from below: a quick rising fwoop, medium-low in the
    // mix so the blade and the cut always dominate. The 380 ms cooldown
    // groups one wave's staggered launches (engine SPAWN_STAGGER is 120 ms
    // with up to 4 fruits ≈ 360 ms span) into a single combined sound,
    // while separate waves (≥ WAVE_GAP + flight, seconds apart) retrigger.
    bus: 'gameplay', gain: 0.38, cooldownMs: 380, priority: 4, pitchVar: 0.06,
    files: [
      'assets/audio/slicing/fruit-throw-1.wav',
      'assets/audio/slicing/fruit-throw-2.wav',
      'assets/audio/slicing/fruit-throw-3.wav',
    ],
  },
  correct: {
    bus: 'gameplay', gain: 0.7, cooldownMs: 60, priority: 9, pitchVar: 0.02,
    files: ['assets/audio/feedback/correct.wav'],
  },
  incorrect: {
    bus: 'gameplay', gain: 0.62, cooldownMs: 120, priority: 9, pitchVar: 0,
    files: ['assets/audio/feedback/incorrect.wav'],
  },
  heartLost: {
    bus: 'gameplay', gain: 0.4, cooldownMs: 200, priority: 7, pitchVar: 0,
    files: ['assets/audio/feedback/heart-lost.wav'],
  },
  fruitMissed: {
    bus: 'gameplay', gain: 0.3, cooldownMs: 150, priority: 3, pitchVar: 0,
    files: ['assets/audio/feedback/fruit-missed.wav'],
  },
  combo2: {
    bus: 'gameplay', gain: 0.55, cooldownMs: 500, priority: 8, pitchVar: 0.02,
    files: ['assets/audio/feedback/combo-2.wav'],
  },
  combo3: {
    bus: 'gameplay', gain: 0.6, cooldownMs: 600, priority: 8, pitchVar: 0.02,
    files: ['assets/audio/feedback/combo-3.wav'],
  },
  comboHigh: {
    bus: 'gameplay', gain: 0.7, cooldownMs: 2500, priority: 8, pitchVar: 0.02,
    files: ['assets/audio/feedback/combo-high.wav'],
  },
  roundIntro: {
    bus: 'gameplay', gain: 0.5, cooldownMs: 100, priority: 5, pitchVar: 0,
    files: ['assets/audio/progression/round-intro.wav'],
  },
  countdownTick: {
    bus: 'gameplay', gain: 0.32, cooldownMs: 200, priority: 3, pitchVar: 0,
    files: ['assets/audio/progression/countdown-tick.wav'],
  },
  roundStart: {
    bus: 'gameplay', gain: 0.6, cooldownMs: 100, priority: 6, pitchVar: 0.03,
    files: ['assets/audio/progression/round-start.wav'],
  },
  roundSuccess: {
    bus: 'gameplay', gain: 0.62, cooldownMs: 100, priority: 8, pitchVar: 0,
    files: ['assets/audio/progression/round-success.wav'],
  },
  roundFailed: {
    bus: 'gameplay', gain: 0.55, cooldownMs: 100, priority: 8, pitchVar: 0,
    files: ['assets/audio/progression/round-failed.wav'],
  },
  levelWin: {
    bus: 'gameplay', gain: 0.85, cooldownMs: 100, priority: 10, pitchVar: 0,
    files: ['assets/audio/progression/level-win.wav'],
  },
  levelFailed: {
    bus: 'gameplay', gain: 0.6, cooldownMs: 100, priority: 9, pitchVar: 0,
    files: ['assets/audio/progression/level-failed.wav'],
  },
  levelUnlocked: {
    bus: 'gameplay', gain: 0.7, cooldownMs: 100, priority: 8, pitchVar: 0,
    files: ['assets/audio/progression/level-unlocked.wav'],
  },
  starEarned: {
    bus: 'gameplay', gain: 0.6, cooldownMs: 120, priority: 8, pitchVar: 0.02,
    files: ['assets/audio/progression/star-earned.wav'],
  },
  threeStars: {
    bus: 'gameplay', gain: 0.8, cooldownMs: 300, priority: 9, pitchVar: 0,
    files: ['assets/audio/progression/three-stars.wav'],
  },
  achievement: {
    bus: 'gameplay', gain: 0.7, cooldownMs: 400, priority: 8, pitchVar: 0,
    files: ['assets/audio/progression/achievement.wav'],
  },
  buttonClick: {
    bus: 'ui', gain: 0.5, cooldownMs: 40, priority: 5, pitchVar: 0.04,
    files: ['assets/audio/ui/button-click.wav'],
  },
  buttonHover: {
    bus: 'ui', gain: 0.25, cooldownMs: 150, priority: 2, pitchVar: 0.03,
    files: ['assets/audio/ui/button-hover.wav'],
  },
  menuOpen: {
    bus: 'ui', gain: 0.45, cooldownMs: 100, priority: 5, pitchVar: 0,
    files: ['assets/audio/ui/menu-open.wav'],
  },
  pause: {
    bus: 'ui', gain: 0.5, cooldownMs: 200, priority: 6, pitchVar: 0,
    files: ['assets/audio/ui/pause.wav'],
  },
  resume: {
    bus: 'ui', gain: 0.5, cooldownMs: 200, priority: 6, pitchVar: 0,
    files: ['assets/audio/ui/resume.wav'],
  },
});

/**
 * Critical sounds, fetched AND decoded at page load (before the first
 * round can possibly need them): slicing, throwing, blade movement,
 * answer feedback, the round-intro presentation cues and the UI click.
 * Rare celebration jingles are preloaded only after playback unlocks.
 */
export const ESSENTIAL_EVENTS = Object.freeze([
  'bladeWhoosh',
  'fruitCut',
  'fruitThrow',
  'correct',
  'incorrect',
  'roundIntro',
  'countdownTick',
  'roundStart',
  'buttonClick',
]);

/**
 * Events eligible for the bounded first-event handoff: the sounds of the
 * very swipe/wave that activates audio. Each may wait at most
 * HANDOFF_WINDOW_MS (measured from the gesture) for its decode to finish;
 * after that the event is honestly skipped. Countdown/feedback never
 * hand off — a late tick is worse than a missing one.
 */
export const HANDOFF_EVENTS = Object.freeze(['bladeWhoosh', 'fruitThrow', 'fruitCut']);
export const HANDOFF_WINDOW_MS = 220;

/**
 * Distinct readiness phases. Loading assets, having them decoded and
 * being ALLOWED to play are separate concerns; a suspended context is
 * never conflated with a running one.
 */
export const AUDIO_PHASES = Object.freeze({
  UNSUPPORTED: 'unsupported',           // no Web Audio — permanently silent
  LOADING: 'loading',                   // essential assets still fetching/decoding
  AWAITING_GESTURE: 'awaiting-gesture', // decoded, but the browser blocks playback
  ACTIVATING: 'activating',             // resume() issued inside a gesture, pending
  RUNNING: 'running',                   // context running — playback permitted
});

export const MAX_VOICES = 14;

/* ------------------------------------------------------------------ */
/* Manager                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {{
 *   storage?: Storage,
 *   fetchFile?: (path: string) => Promise<ArrayBuffer>,
 *   createContext?: () => AudioContext | null,
 *   now?: () => number,
 *   rng?: () => number,
 *   maxVoices?: number,
 *   setTimer?: (fn: () => void, delayMs: number) => number,
 *   clearTimer?: (id: number) => void,
 * }} [deps] injectable for tests; browser defaults otherwise
 */
export function createAudioManager(deps = {}) {
  const hasWindow = typeof window !== 'undefined';
  const storage = deps.storage || (hasWindow ? window.localStorage : null);
  const fetchFile = deps.fetchFile || ((path) => fetch(path).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
    return r.arrayBuffer();
  }));
  const createContext = deps.createContext || (() => {
    const Ctor = hasWindow ? (window.AudioContext || window.webkitAudioContext) : null;
    return Ctor ? new Ctor() : null;
  });
  const now = deps.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const rng = deps.rng || Math.random;
  const maxVoices = Math.max(1, Math.round(deps.maxVoices ?? MAX_VOICES));
  const setTimer = deps.setTimer || ((fn, delayMs) => setTimeout(fn, delayMs));
  const clearTimer = deps.clearTimer || ((id) => clearTimeout(id));

  // Development-only console diagnostics (?audiodebug=1 or the storage
  // key). The ring buffer always records; the flag only adds console
  // output so production stays quiet.
  const debugEnabled = (() => {
    if (!hasWindow) return false;
    try {
      return new URLSearchParams(window.location.search).has('audiodebug')
        || window.localStorage.getItem(AUDIO_DEBUG_KEY) === '1';
    } catch {
      return false;
    }
  })();

  /** @type {AudioContext|null} */
  let ctx = null;
  let masterGain = null;
  let unlocked = false;          // context confirmed running (playback permitted)
  let activationPending = false; // resume() issued inside a gesture, unconfirmed
  let suspended = false;         // gameplay bus blocked (game paused)
  let supported = true;          // false when Web Audio is unavailable
  let phase = AUDIO_PHASES.LOADING;
  let gestureAt = -Infinity;     // timestamp of the last unlock() (always gesture-driven)
  let settings = storage ? readAudioSettings(storage) : { ...DEFAULT_AUDIO_SETTINGS };

  /** event -> AudioBuffer[] (successfully decoded variations). */
  const buffers = new Map();
  /** events whose files failed to load/decode — never retried in-session. */
  const unavailable = new Set();
  /** in-flight load+decode jobs: event -> Promise (single dedupe point). */
  const loading = new Map();
  /** bounded first-event handoff: event -> { expiresAt }. */
  const handoff = new Map();
  /** events that already used (or lost) their handoff — one shot each. */
  const handoffUsed = new Set();
  const lastPlayedAt = new Map();
  /** event -> index of the variation played last (no immediate repeats). */
  const lastVariant = new Map();
  const activeVoices = new Set();
  const sequenceTimers = new Set();
  const stateListeners = new Set();
  const diagnostics = [];

  const stats = {
    played: 0, skippedDisabled: 0, skippedLocked: 0, skippedSuspended: 0,
    skippedCooldown: 0, skippedMissing: 0, droppedVoiceCap: 0,
    handoffDeferred: 0, handoffPlayed: 0, handoffExpired: 0, byEvent: {},
  };

  /* ---------------- diagnostics + readiness ---------------- */

  function diagnose(message, info) {
    diagnostics.push({ at: now(), message, ...(info !== undefined ? { info } : {}) });
    if (diagnostics.length > 60) diagnostics.shift();
    if (debugEnabled) {
      try { console.info(`[audio] ${message}`, info === undefined ? '' : info); } catch { /* never throw */ }
    }
  }

  /** Snapshot of the full readiness model (never a single Boolean). */
  function getReadiness() {
    return {
      supported,
      phase,
      unlocked,
      contextState: ctx ? ctx.state : null,
      effectsOn: settings.effectsOn,
      volume: settings.effectsVolume,
      loadedEvents: buffers.size,
      essentialReady: ESSENTIAL_EVENTS.filter((e) => buffers.has(e)).length,
      essentialTotal: ESSENTIAL_EVENTS.length,
      failedEvents: [...unavailable],
    };
  }

  function notify() {
    for (const listener of stateListeners) {
      try { listener(getReadiness()); } catch { /* listeners must not break audio */ }
    }
  }

  function setPhase(next) {
    if (phase === next) return;
    phase = next;
    diagnose('phase', next);
    notify();
  }

  function phaseWhileBlocked() {
    return loading.size > 0 ? AUDIO_PHASES.LOADING : AUDIO_PHASES.AWAITING_GESTURE;
  }

  /* ---------------- graph ---------------- */

  function ensureGraph() {
    if (ctx || !supported) return;
    try {
      ctx = createContext();
    } catch {
      ctx = null;
    }
    if (!ctx) {
      supported = false;
      setPhase(AUDIO_PHASES.UNSUPPORTED);
      diagnose('unsupported');
      return;
    }
    try {
      masterGain = ctx.createGain();
      const limiter = ctx.createDynamicsCompressor();
      // Gentle limiting so stacked slices/feedback cannot clip.
      limiter.threshold.value = -10;
      limiter.knee.value = 6;
      limiter.ratio.value = 8;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.12;
      masterGain.connect(limiter);
      limiter.connect(ctx.destination);
      // Saved settings (mute/volume) apply before any voice can be heard.
      masterGain.gain.value = settings.effectsOn ? settings.effectsVolume : 0;
    } catch {
      supported = false;
      ctx = null;
      setPhase(AUDIO_PHASES.UNSUPPORTED);
      diagnose('graph-failed');
      return;
    }
    // Optional hook (not on very old Safari): accept a context the browser
    // grants 'running' on its own (autoplay allowed) and flag OS-level
    // suspensions of a previously running context.
    try {
      ctx.onstatechange = () => {
        if (!ctx) return;
        if (ctx.state === 'running') {
          if (activationPending) confirmRunning('statechange');
          else acceptIfRunning();
        } else if (unlocked) {
          markRelocked(`statechange:${ctx.state}`);
        }
      };
    } catch {
      /* optional API — gestures remain the primary recovery path */
    }
    diagnose('context-created', { state: ctx.state });
  }

  /**
   * Accepts a context the browser itself put into 'running' (autoplay
   * granted / media engagement threshold). This never calls resume(), so
   * no autoplay policy is bypassed — it only honors permission already
   * given, which is exactly the "play the initial sounds normally" case.
   */
  function acceptIfRunning() {
    if (unlocked || !supported || !ctx) return;
    if (ctx.state === 'running') confirmRunning('autoplay-allowed');
  }

  function confirmRunning(via) {
    activationPending = false;
    const firstTime = !unlocked;
    unlocked = true;
    setPhase(AUDIO_PHASES.RUNNING);
    diagnose('running', { via });
    if (firstTime) {
      preloadAll();      // optional sounds only — essentials decoded at load
      flushHandoff(false);
    }
  }

  /** A previously running context got suspended by the OS/browser. */
  function markRelocked(reason) {
    unlocked = false;
    activationPending = false;
    diagnose('relocked', reason);
    setPhase(phaseWhileBlocked());
  }

  /* ---------------- unlock ---------------- */

  /**
   * Must be called from a real user gesture (game.js registers the trusted
   * listeners). `ctx.resume()` is invoked synchronously — before any asset
   * work — so the gesture's user activation is spent on the context
   * itself. Returns true only when playback is confirmed permitted right
   * now; a pending async resume returns false and the caller keeps its
   * gesture listeners armed for the next interaction.
   */
  function unlock() {
    if (!supported) return false;
    ensureGraph();
    if (!ctx) return false;
    gestureAt = now();
    if (ctx.state === 'running') {
      confirmRunning('gesture');
      return true;
    }
    activationPending = true;
    setPhase(AUDIO_PHASES.ACTIVATING);
    diagnose('resume-requested', { contextState: ctx.state });
    let resumePromise = null;
    try {
      resumePromise = ctx.resume();
    } catch (err) {
      activationPending = false;
      setPhase(phaseWhileBlocked());
      diagnose('resume-threw', String(err));
      return false;
    }
    // Chrome flips the state synchronously inside resume(); accept that
    // immediately so the same gesture's gameplay sounds are not delayed.
    if (ctx.state === 'running') {
      confirmRunning('gesture-sync');
      return true;
    }
    if (resumePromise && typeof resumePromise.then === 'function') {
      resumePromise.then(() => {
        if (ctx && ctx.state === 'running') {
          confirmRunning('gesture-async');
        } else if (activationPending) {
          activationPending = false;
          diagnose('resume-noop', { contextState: ctx ? ctx.state : null });
          setPhase(phaseWhileBlocked());
          flushHandoff(true);
        }
      }).catch(() => {
        activationPending = false;
        diagnose('resume-rejected');
        setPhase(phaseWhileBlocked());
        flushHandoff(true); // never replay events whose activation failed
      });
      return false; // not confirmed yet — stay armed for the next gesture
    }
    // Legacy webkitAudioContext without promise-based resume(): the
    // onstatechange hook or the next gesture confirms the transition.
    return false;
  }

  /** Cheap check for the gesture-arm/disarm logic in game.js. */
  function needsUnlock() {
    return supported && !unlocked;
  }

  /** Re-checks the live context state (used on visibility changes). */
  function checkContext() {
    if (!supported || !ctx) return;
    if (ctx.state === 'running') acceptIfRunning();
    else if (unlocked) markRelocked(`check:${ctx.state}`);
  }

  /* ---------------- loading ---------------- */

  /**
   * Page-load preparation: creates the (suspended) context and fetches +
   * decodes the essential sounds. Decoding is not gated by autoplay
   * policy, so this runs during the round introduction — buffers are
   * ready before the first slice can happen.
   */
  function warmup() {
    if (!supported) return;
    ensureGraph();
    acceptIfRunning();
    diagnose('warmup');
    for (const event of ESSENTIAL_EVENTS) loadEventFiles(event);
  }

  /** Single deduplicated load+decode pipeline for every event. */
  function loadEventFiles(event) {
    const def = AUDIO_MANIFEST[event];
    if (!def) return Promise.resolve([]);
    if (buffers.has(event) || unavailable.has(event) || loading.has(event)) {
      return loading.get(event) || Promise.resolve([]);
    }
    const job = Promise.all(def.files.map((path) => fetchFile(path)))
      .then((arrayBuffers) => decodeBuffers(event, arrayBuffers))
      .catch(() => {
        unavailable.add(event); // missing audio never breaks the game
        diagnose('load-failed', event);
        return [];
      })
      .finally(() => {
        loading.delete(event);
        if (phase === AUDIO_PHASES.LOADING && loading.size === 0 && !unlocked) {
          setPhase(AUDIO_PHASES.AWAITING_GESTURE);
        }
      });
    loading.set(event, job);
    return job;
  }

  function decodeBuffers(event, arrayBuffers) {
    if (!ctx || !arrayBuffers.length) return [];
    return Promise.all(arrayBuffers.map((buf) => {
      // decodeAudioData detaches the ArrayBuffer; clone for determinism tests.
      return ctx.decodeAudioData(buf.slice(0)).catch(() => null);
    })).then((decoded) => {
      const ok = decoded.filter(Boolean);
      if (ok.length) {
        buffers.set(event, ok);
        if (handoff.has(event)) attemptHandoff(event);
      } else {
        unavailable.add(event);
        diagnose('decode-failed', event);
      }
      return ok;
    });
  }

  /** Loads every not-yet-loaded event (called once playback is allowed). */
  function preloadAll() {
    for (const event of Object.keys(AUDIO_MANIFEST)) {
      loadEventFiles(event); // dedupe: essentials already decoded at load
    }
  }

  /* ---------------- bounded first-event handoff ---------------- */

  function canHandoff(event) {
    if (!HANDOFF_EVENTS.includes(event)) return false;
    if (handoff.has(event) || handoffUsed.has(event)) return false;
    if (!supported || !settings.effectsOn) return false;
    // Only events arriving inside a real gesture-driven activation window
    // qualify; pre-gesture events are dropped, never queued for replay.
    return activationPending || now() - gestureAt <= HANDOFF_WINDOW_MS;
  }

  function stashHandoff(event) {
    handoff.set(event, { expiresAt: gestureAt + HANDOFF_WINDOW_MS });
    stats.handoffDeferred++;
    diagnose('handoff-deferred', event);
  }

  /**
   * Plays one handed-off event once its buffers exist. Consumption is
   * one-shot: the slot survives only while the decode is genuinely in
   * flight and the expiry has not passed.
   */
  function attemptHandoff(event) {
    const slot = handoff.get(event);
    if (!slot) return;
    if (unavailable.has(event)) {
      handoff.delete(event);
      handoffUsed.add(event);
      stats.handoffExpired++;
      return;
    }
    if (!buffers.has(event)) return; // still decoding — retried on completion
    handoff.delete(event);
    handoffUsed.add(event);
    if (!unlocked || now() > slot.expiresAt) {
      stats.handoffExpired++;
      diagnose('handoff-expired', event);
      return;
    }
    if (suspended && AUDIO_MANIFEST[event].bus === 'gameplay') return;
    if (play(event)) stats.handoffPlayed++;
  }

  function flushHandoff(expireAll) {
    for (const event of [...handoff.keys()]) {
      if (expireAll) {
        handoff.delete(event);
        handoffUsed.add(event);
        stats.handoffExpired++;
      } else {
        attemptHandoff(event);
      }
    }
  }

  /* ---------------- playback ---------------- */

  function enabled() {
    return supported && unlocked && settings.effectsOn && masterGain !== null;
  }

  /**
   * Plays one event. Returns true when a voice was actually scheduled.
   * All rejection reasons are counted in `stats` instead of throwing.
   */
  function play(event) {
    const def = AUDIO_MANIFEST[event];
    if (!def) return false;
    // A context the browser already permits (autoplay granted) counts as
    // playable even before any gesture — checked lazily here because the
    // permission can arrive at any time.
    acceptIfRunning();
    if (!enabled()) {
      if (canHandoff(event) && !(suspended && def.bus === 'gameplay')) stashHandoff(event);
      stats.skippedDisabled++;
      return false;
    }
    if (ctx.state !== 'running') {
      // The OS/browser suspended a previously running context (iOS tab
      // switch, screen lock). Sounds scheduled now would be silently lost
      // down an inactive output, so mark the relock; the gesture listeners
      // in game.js re-arm through the readiness model and re-resume on the
      // next interaction.
      markRelocked(`play:${ctx.state}`);
      stats.skippedLocked++;
      return false;
    }
    if (suspended && def.bus === 'gameplay') {
      stats.skippedSuspended++;
      return false;
    }
    if (!buffers.has(event)) {
      // Not decoded yet (or failed): start the deduped load so the next
      // occurrence can play, and let a qualifying first event hand off.
      if (canHandoff(event) && !(suspended && def.bus === 'gameplay')) stashHandoff(event);
      loadEventFiles(event);
      stats.skippedMissing++;
      return false;
    }
    const t = now();
    const last = lastPlayedAt.get(event) ?? -Infinity;
    if (t - last < def.cooldownMs) {
      stats.skippedCooldown++;
      return false;
    }
    lastPlayedAt.set(event, t);

    const pool = buffers.get(event);
    // Controlled randomness: any variation may follow, except the one that
    // just played — rapid repeated swishes never echo the same sample twice
    // in a row (rotation-style variety without a predictable order).
    const prev = pool.length > 1 ? lastVariant.get(event) : undefined;
    let index = Math.floor(rng() * pool.length) % pool.length;
    if (prev !== undefined && index === prev) {
      index = (index + 1 + Math.floor(rng() * (pool.length - 1))) % pool.length;
    }
    lastVariant.set(event, index);
    const buffer = pool[index];
    const rate = 1 + (rng() * 2 - 1) * (def.pitchVar || 0);

    let source;
    let voiceGain;
    try {
      source = ctx.createBufferSource();
      voiceGain = ctx.createGain();
    } catch {
      return false;
    }
    source.buffer = buffer;
    if (def.pitchVar) {
      try { source.playbackRate.setValueAtTime(rate, ctx.currentTime); } catch { /* default rate */ }
    }
    voiceGain.gain.value = def.gain;
    try {
      source.connect(voiceGain);
      voiceGain.connect(masterGain);
    } catch {
      /* partial graph — attempt to play anyway */
    }

    if (activeVoices.size >= maxVoices) {
      // Steal the lowest-priority (ties: oldest) voice only if this sound
      // outranks it; otherwise drop the new one to cap loudness buildup.
      let victim = null;
      for (const voice of activeVoices) {
        if (!victim
          || AUDIO_MANIFEST[voice.event].priority < AUDIO_MANIFEST[victim.event].priority
          || (AUDIO_MANIFEST[voice.event].priority === AUDIO_MANIFEST[victim.event].priority && voice.startedAt < victim.startedAt)) {
          victim = voice;
        }
      }
      const victimPriority = victim ? AUDIO_MANIFEST[victim.event].priority : 0;
      if (victim && def.priority > victimPriority) stopVoice(victim);
      else {
        stats.droppedVoiceCap++;
        try { source.disconnect(); voiceGain.disconnect(); } catch { /* already gone */ }
        return false;
      }
    }

    const voice = { event, source, voiceGain, startedAt: t };
    const cleanup = () => {
      activeVoices.delete(voice);
      try { source.disconnect(); } catch { /* already disconnected */ }
      try { voiceGain.disconnect(); } catch { /* already disconnected */ }
    };
    source.onended = cleanup;
    activeVoices.add(voice);
    try {
      source.start();
    } catch {
      cleanup();
      return false;
    }
    stats.played++;
    stats.byEvent[event] = (stats.byEvent[event] || 0) + 1;
    return true;
  }

  function stopVoice(voice) {
    try { voice.source.stop(); } catch { /* already stopped */ }
    try { voice.source.disconnect(); voice.voiceGain.disconnect(); } catch { /* already gone */ }
    activeVoices.delete(voice);
  }

  /**
   * Plays events in order with delays — used for level-end celebrations
   * (win jingle → stars → unlock → achievements) so they never stack
   * into an incoherent mush. Pending gameplay items are cancelled by
   * setSuspended(true); every item re-checks mute/pause at fire time.
   * @param {Array<{event: string, delayMs: number}>} items
   */
  function playSequence(items) {
    for (const item of items) {
      const def = AUDIO_MANIFEST[item.event];
      if (!def) continue;
      const timerId = setTimer(() => {
        sequenceTimers.delete(timerId);
        play(item.event);
      }, Math.max(0, item.delayMs || 0));
      sequenceTimers.add(timerId);
    }
  }

  /* ---------------- state ---------------- */

  /** Blocks the gameplay bus (pause). UI sounds remain allowed. */
  function setSuspended(flag) {
    suspended = Boolean(flag);
    if (suspended) cancelSequences();
  }

  /**
   * Cancels every pending playSequence item (level-end celebrations that
   * would otherwise keep firing over a session restarted from the results
   * screen, or after quitting to the map) plus any bounded first-event
   * handoff — stale sounds never carry across a restart. Already-playing
   * voices finish naturally (they are under a second long).
   */
  function cancelSequences() {
    for (const id of sequenceTimers) {
      clearTimer(id);
    }
    sequenceTimers.clear();
    flushHandoff(true);
  }

  function applyMasterGain() {
    if (masterGain) masterGain.gain.value = settings.effectsOn ? settings.effectsVolume : 0;
  }

  /** mutes/unmutes effects (persisted). Returns the new state. */
  function setMuted(muted) {
    settings = { ...settings, effectsOn: !muted };
    applyMasterGain();
    if (storage) writeAudioSettings(storage, settings);
    notify(); // state watchers stay in sync with intentional mute
    return !muted;
  }

  /** Sets the effects volume 0..1 (persisted). Returns the applied value. */
  function setEffectsVolume(volume) {
    settings = { ...settings, effectsVolume: clampVolume(volume, settings.effectsVolume) };
    applyMasterGain();
    if (storage) writeAudioSettings(storage, settings);
    return settings.effectsVolume;
  }

  return {
    play,
    playSequence,
    cancelSequences,
    unlock,
    warmup,
    needsUnlock,
    checkContext,
    onStateChange: (listener) => { stateListeners.add(listener); },
    setSuspended,
    setMuted,
    setEffectsVolume,
    isUnlocked: () => unlocked,
    isSuspended: () => suspended,
    isSupported: () => supported,
    isEffectsOn: () => settings.effectsOn,
    getEffectsVolume: () => settings.effectsVolume,
    getStats: () => ({ ...stats, phase, activeVoices: activeVoices.size, loadedEvents: buffers.size }),
    getReadiness,
    getDiagnostics: () => [...diagnostics],
    /** True when the event's buffers are decoded and playable right now. */
    isReady: (event) => buffers.has(event),
    _getSettings: () => ({ ...settings }),
  };
}

/** Browser singleton; Node (tests) imports the factory instead. */
export const audioManager = typeof window !== 'undefined'
  ? createAudioManager()
  : null;
