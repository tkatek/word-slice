#!/usr/bin/env node
/**
 * Word Slice — deterministic procedural sound-effect generator.
 *
 * Renders every gameplay/UI sound effect as a 16-bit mono PCM WAV file
 * (22.05 kHz) under assets/audio/. No external samples are used: all
 * sounds are synthesized from oscillators, filtered noise, frequency
 * envelopes, layered transients and a small Schroeder reverb, driven by a
 * seeded PRNG so re-running the script produces byte-identical output.
 *
 * OGG encoding is unavailable in this environment (no ffmpeg), so the
 * audio manifest in js/audio.js points at the .wav files produced here.
 *
 * Usage:  node tools/make-audio.mjs          (writes to assets/audio/)
 *         node tools/make-audio.mjs --check  (validate existing files only)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'assets', 'audio');
const SR = 22050; // sample rate — ample for arcade SFX, half the download

/* ------------------------------------------------------------------ */
/* Deterministic randomness                                            */
/* ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Master seed — bump to intentionally re-roll every random detail. */
const SEED = 0x5657_4c31; // "VWL1"

/* ------------------------------------------------------------------ */
/* Buffer helpers                                                      */
/* ------------------------------------------------------------------ */

const alloc = (seconds) => new Float64Array(Math.max(1, Math.ceil(seconds * SR)));
const N = (seconds) => Math.max(1, Math.round(seconds * SR));

/** Adds `src` into `dst` starting at `atSec`, scaled by `gain`. */
function add(dst, src, atSec = 0, gain = 1) {
  const start = Math.round(atSec * SR);
  const n = Math.min(src.length, dst.length - start);
  for (let i = 0; i < n; i++) dst[start + i] += src[i] * gain;
}

/* ------------------------------------------------------------------ */
/* Envelope shapes (return 0..1 multipliers, written into `out`)       */
/* ------------------------------------------------------------------ */

/** Attack/decay exponential: fast fade-in, exponential tail. */
function envAttackDecay(len, attackSec, tauSec, skew = 0) {
  const env = new Float64Array(len);
  const aN = Math.max(1, attackSec * SR);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const attack = Math.min(1, i / aN);
    const decay = Math.exp(-t / tauSec);
    env[i] = attack * decay + skew * Math.exp(-t / (tauSec * 4)) * (1 - attack);
  }
  return env;
}

/** Skewed bell (classic whoosh amplitude: quick swell, longer release). */
function envBell(len, risePow = 2, fallPow = 3) {
  const env = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    const x = (i + 1) / len;
    env[i] = Math.pow(x, risePow) * Math.pow(1 - x, fallPow);
  }
  const peak = Math.max(...env);
  if (peak > 0) for (let i = 0; i < len; i++) env[i] /= peak;
  return env;
}

/* ------------------------------------------------------------------ */
/* Oscillators                                                         */
/* ------------------------------------------------------------------ */

/**
 * Sine with optional exponential pitch glide f0 → f1 and an attack/decay
 * envelope. `partials` adds quiet upper harmonics: [[ratio, amp, tauMul]].
 */
function tone(f0, f1, seconds, { amp = 1, attack = 0.006, tau = 0.2, partials = [], glideShape = 'exp' } = {}) {
  const len = N(seconds);
  const out = new Float64Array(len);
  const env = envAttackDecay(len, attack, tau);
  const glide = (x) => (glideShape === 'exp'
    ? f0 * Math.pow(f1 / f0, x)
    : f0 + (f1 - f0) * x);
  const renderPartial = (ratio, pAmp, tauMul) => {
    let phase = 0;
    for (let i = 0; i < len; i++) {
      const x = i / (len - 1);
      const f = glide(x) * ratio;
      phase += (2 * Math.PI * f) / SR;
      out[i] += Math.sin(phase) * pAmp * env[i] * (tauMul === 1 ? 1 : Math.exp((-i / SR) / (tau * tauMul)));
    }
  };
  renderPartial(1, 1, 1);
  for (const [ratio, pAmp, tauMul] of partials) renderPartial(ratio, pAmp, tauMul ?? 1);
  for (let i = 0; i < len; i++) out[i] *= amp;
  return out;
}

/**
 * Bell/chime: sine + slightly detuned twin + inharmonic 2.76x partial.
 * The detune gives the warm "game chime" beating without FM harshness.
 */
function bell(freq, seconds, { amp = 1, tau = 0.25, detune = 1.006 } = {}) {
  const len = N(seconds);
  const out = new Float64Array(len);
  const env = envAttackDecay(len, 0.004, tau);
  let p1 = 0;
  let p2 = 0;
  let p3 = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    p1 += (2 * Math.PI * freq) / SR;
    p2 += (2 * Math.PI * freq * detune) / SR;
    p3 += (2 * Math.PI * freq * 2.76) / SR;
    const bright = Math.exp(-t / (tau * 0.35)); // high partial dies fast
    out[i] = (Math.sin(p1) + 0.55 * Math.sin(p2) + 0.14 * bright * Math.sin(p3)) * env[i];
  }
  for (let i = 0; i < len; i++) out[i] *= amp;
  return out;
}

/** Droplet "plip": short sine chirp sweeping UP (canonical water blip). */
function droplet(f0, f1, seconds, { amp = 0.3, tau = 0.03 } = {}) {
  return tone(f0, f1, seconds, { amp, attack: 0.003, tau, glideShape: 'exp' });
}

/* ------------------------------------------------------------------ */
/* Noise + biquad filters                                              */
/* ------------------------------------------------------------------ */

function whiteNoise(len, rng) {
  const out = new Float64Array(len);
  for (let i = 0; i < len; i++) out[i] = rng() * 2 - 1;
  return out;
}

/**
 * RBJ audio-EQ-cookbook biquad (normalized). type: 'lp' | 'hp' | 'bp'.
 * Bandpass is the constant-peak (0dB) variant.
 */
function biquadCoeffs(type, f0, q) {
  const w0 = (2 * Math.PI * Math.max(20, Math.min(f0, SR / 2 - 20))) / SR;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * Math.max(0.1, q));
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let a0 = 1;
  let a1 = 0;
  let a2 = 0;
  if (type === 'lp') {
    b0 = (1 - cosW0) / 2; b1 = 1 - cosW0; b2 = b0;
    a0 = 1 + alpha; a1 = -2 * cosW0; a2 = 1 - alpha;
  } else if (type === 'hp') {
    b0 = (1 + cosW0) / 2; b1 = -(1 + cosW0); b2 = b0;
    a0 = 1 + alpha; a1 = -2 * cosW0; a2 = 1 - alpha;
  } else { // bp (constant peak)
    b0 = alpha; b1 = 0; b2 = -alpha;
    a0 = 1 + alpha; a1 = -2 * cosW0; a2 = 1 - alpha;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/**
 * Filters `input` through a biquad whose cutoff follows `f0At(x)` where x
 * is the normalized position in the buffer (0..1). Coefficients are
 * recomputed every 16 samples (cheap and artifact-free at SFX scale).
 */
function sweepFilter(input, type, f0At, q) {
  const out = new Float64Array(input.length);
  let b0 = 0; let b1 = 0; let b2 = 0; let a1 = 0; let a2 = 0;
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  const BLOCK = 16;
  for (let i = 0; i < input.length; i++) {
    if (i % BLOCK === 0) {
      const c = biquadCoeffs(type, f0At(i / (input.length - 1 || 1)), q);
      b0 = c.b0; b1 = c.b1; b2 = c.b2; a1 = c.a1; a2 = c.a2;
    }
    const x0 = input[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    out[i] = y0;
  }
  return out;
}

/**
 * Layered noise burst: white noise → time-varying bandpass sweep
 * (lo → hi → lo for whooshes; pass `sweep` as [peakX, loHz, peakHz, endHz])
 * multiplied by an envelope. Wobble modulates the cutoff for juicy texture.
 */
function noiseBurst(seconds, rng, {
  amp = 1, env = null, type = 'bp', q = 1.1,
  sweep = [0.4, 500, 2600, 900], wobbleHz = 0, wobbleDepth = 0,
} = {}) {
  const len = N(seconds);
  let noise = whiteNoise(len, rng);
  const [peakX, loHz, peakHz, endHz] = sweep;
  const cutoffAt = (x) => {
    const f = x < peakX
      ? loHz * Math.pow(peakHz / loHz, x / peakX)
      : peakHz * Math.pow(endHz / peakHz, (x - peakX) / (1 - peakX));
    if (!wobbleHz) return f;
    return f * (1 + wobbleDepth * Math.sin(2 * Math.PI * wobbleHz * x * seconds));
  };
  noise = sweepFilter(noise, type, cutoffAt, q);
  const shape = env || envBell(len, 2, 3);
  for (let i = 0; i < len; i++) noise[i] *= shape[i] * amp;
  return noise;
}

/**
 * Crackle envelope: sparse random impulses, each decaying exponentially —
 * hundreds of tiny micro-events per second. Multiplied into band-limited
 * noise this yields a FIBROUS TORN texture (rough, granular), which is what
 * separates "blade through flesh" from the smooth swell of filtered air
 * (a plain envelope on bandpass noise always reads as wind/whoosh).
 * `densityHz` thins out over time via `decayTau` so the tear starts dense
 * and peters out like real flesh giving way.
 */
function crackleEnv(len, rng, { densityHz = 420, grainTauMs = 5, decayTau = 0.045 } = {}) {
  const env = new Float64Array(len);
  const grainDecay = Math.exp(-1 / ((grainTauMs / 1000) * SR));
  let v = 0;
  let nextAt = 0;
  let peak = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    if (t >= nextAt) {
      v = Math.min(1.2, v + 0.35 + rng() * 0.65); // grains pile up slightly
      nextAt = t + (0.35 + rng() * 1.3) / densityHz;
    }
    v *= grainDecay;
    env[i] = v * Math.exp(-t / decayTau);
    if (env[i] > peak) peak = env[i];
  }
  if (peak > 0) for (let i = 0; i < len; i++) env[i] /= peak;
  return env;
}

/**
 * Tear layer: band-limited noise swept DOWN (bright → dark, the blade
 * burying into the fruit) modulated by a crackle envelope. Never sounds
 * airy because the amplitude is granular, not smoothly swelled.
 */
function tearLayer(seconds, rng, { sweep = [2800, 700], q = 0.9, amp = 1, crackle = {} } = {}) {
  const len = N(seconds);
  let noise = whiteNoise(len, rng);
  const [hiHz, loHz] = sweep;
  noise = sweepFilter(noise, 'bp', (x) => hiHz * Math.pow(loHz / hiHz, x), q);
  const grains = crackleEnv(len, rng, { densityHz: 420, grainTauMs: 5, decayTau: seconds * 0.55, ...crackle });
  for (let i = 0; i < len; i++) noise[i] *= grains[i] * amp;
  return noise;
}

/**
 * Wet splat: one short juicy micro-burst — lowpassed noise with a near-zero
 * attack, a fast exponential decay and a touch of 600–900 Hz resonance
 * ("wetness"). Layer C is built from a few of these staggered in time;
 * each is a discrete event, never a sustained pour.
 */
function splat(seconds, rng, { cutoffHz = 1100, amp = 1, q = 0.8 } = {}) {
  const len = N(seconds);
  let noise = whiteNoise(len, rng);
  // Cutoff falls as the droplet settles — reads as matter, not breath.
  noise = sweepFilter(noise, 'lp', (x) => cutoffHz * (1.5 - 0.7 * x), q);
  const body = sweepFilter(whiteNoise(N(seconds), rng), 'bp', () => 740, 2.4);
  const env = envAttackDecay(len, 0.001, seconds * 0.42);
  for (let i = 0; i < len; i++) noise[i] = (noise[i] + 0.22 * body[i]) * env[i] * amp;
  return noise;
}

/* ------------------------------------------------------------------ */
/* Reverb (Schroeder: 4 combs + 2 allpass)                             */
/* ------------------------------------------------------------------ */

function reverb(input, { wet = 0.25, decay = 0.72 } = {}) {
  const combDelaysMs = [29.7, 37.1, 41.1, 43.7];
  const allpassDelaysMs = [5.0, 1.7];
  const combFb = 0.77 + decay * 0.08;

  const runComb = (x, delaySamples, fb) => {
    const y = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const delayed = i >= delaySamples ? y[i - delaySamples] : 0;
      y[i] = x[i] + fb * delayed;
    }
    return y;
  };
  const runAllpass = (x, delaySamples, g) => {
    const y = new Float64Array(x.length);
    let dnZ1 = 0;
    for (let i = 0; i < x.length; i++) {
      const delayedX = i >= delaySamples ? x[i - delaySamples] : 0;
      const delayedY = i >= delaySamples ? y[i - delaySamples] : 0;
      y[i] = -g * x[i] + delayedX + g * delayedY;
      dnZ1 = delayedX - g * y[i]; // keep flow explicit; dnZ1 unused visually
      void dnZ1;
    }
    return y;
  };

  let acc = new Float64Array(input.length);
  for (const ms of combDelaysMs) {
    const c = runComb(input, Math.round((ms / 1000) * SR), combFb);
    for (let i = 0; i < acc.length; i++) acc[i] += c[i];
  }
  for (const ms of allpassDelaysMs) acc = runAllpass(acc, Math.round((ms / 1000) * SR), 0.7);
  for (let i = 0; i < acc.length; i++) acc[i] /= combDelaysMs.length;

  const out = new Float64Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i] + wet * acc[i];
  return out;
}

/* ------------------------------------------------------------------ */
/* Finalize + WAV writer                                               */
/* ------------------------------------------------------------------ */

/** Peak-normalize to `peak`, apply gentle tanh soft-limit and fades. */
function finalize(buf, { peak = 0.8, fadeInMs = 2, fadeOutMs = 14 } = {}) {
  let max = 0;
  for (let i = 0; i < buf.length; i++) {
    if (!Number.isFinite(buf[i])) buf[i] = 0;
    const a = Math.abs(buf[i]);
    if (a > max) max = a;
  }
  const gain = max > 1e-9 ? peak / max : 0;
  const fadeIn = Math.round((fadeInMs / 1000) * SR);
  const fadeOut = Math.round((fadeOutMs / 1000) * SR);
  for (let i = 0; i < buf.length; i++) {
    let v = buf[i] * gain;
    v = Math.tanh(v * 1.12) / Math.tanh(1.12); // soft clip safety
    if (i < fadeIn) v *= i / fadeIn;
    const fromEnd = buf.length - 1 - i;
    if (fromEnd < fadeOut) v *= fromEnd / fadeOut;
    buf[i] = v;
  }
  return buf;
}

function wavBytes(f64) {
  const numSamples = f64.length;
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);        // PCM chunk size
  buffer.writeUInt16LE(1, 20);         // PCM format
  buffer.writeUInt16LE(1, 22);         // mono
  buffer.writeUInt32LE(SR, 24);
  buffer.writeUInt32LE(SR * 2, 28);    // byte rate
  buffer.writeUInt16LE(2, 32);         // block align
  buffer.writeUInt16LE(16, 34);        // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, f64[i]));
    buffer.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buffer;
}

/* ------------------------------------------------------------------ */
/* Shared multi-tone helpers                                           */
/* ------------------------------------------------------------------ */

/** Plays bell notes in sequence: [[freqHz, atSec, amp, tauSec], ...]. */
function bellPhrase(buf, notes, { tailSec = 0.45, reverbWet = 0.22 } = {}) {
  for (const [freq, at, amp, tau] of notes) {
    const dur = Math.max(0.08, tailSec);
    add(buf, bell(freq, dur, { amp, tau }), at);
  }
  return reverbWet > 0 ? reverb(buf, { wet: reverbWet }) : buf;
}

/* ------------------------------------------------------------------ */
/* Sound definitions                                                   */
/* ------------------------------------------------------------------ */

const SOUNDS = [
  /* ---------------- slicing: blade whooshes ---------------- */
  {
    path: 'slicing/blade-whoosh-1.wav', peak: 0.72,
    render(buf, rng) {
      // Crisp short whoosh: bp noise rising 500→2600→900Hz with HF swish.
      add(buf, noiseBurst(0.17, rng, { amp: 1.0, q: 1.2, sweep: [0.35, 500, 2600, 900] }));
      add(buf, noiseBurst(0.12, rng, { amp: 0.32, type: 'hp', q: 0.8, sweep: [0.3, 3200, 5200, 3800] }), 0.015);
    },
  },
  {
    path: 'slicing/blade-whoosh-2.wav', peak: 0.74,
    render(buf, rng) {
      // Deeper, more powerful: slower swell 220→1100→380 + soft body thump.
      add(buf, noiseBurst(0.24, rng, { amp: 1.0, q: 0.9, sweep: [0.45, 220, 1100, 380], env: envBell(N(0.24), 3, 4) }));
      add(buf, tone(150, 85, 0.1, { amp: 0.22, tau: 0.05, attack: 0.01 }));
    },
  },
  {
    path: 'slicing/blade-whoosh-3.wav', peak: 0.7,
    render(buf, rng) {
      // Sharp fast ninja swipe: 900→4200→1600, near-instant attack.
      add(buf, noiseBurst(0.135, rng, { amp: 1.0, q: 1.4, sweep: [0.3, 900, 4200, 1600], env: envBell(N(0.135), 1.5, 3) }));
      add(buf, noiseBurst(0.09, rng, { amp: 0.3, type: 'hp', q: 0.9, sweep: [0.25, 4000, 7000, 5000] }));
    },
  },
  {
    path: 'slicing/blade-whoosh-4.wav', peak: 0.72,
    render(buf, rng) {
      // Long diagonal slicing motion: the blade sweeps across the whole
      // ear, so the swell develops later and lasts longer than the short
      // swipes. 260→1500→420 Hz over 0.28 s with a slight wobble (the
      // blade rotating through the diagonal) + a faint HF layer that only
      // joins mid-swing — the far edge of the blade passing last.
      add(buf, noiseBurst(0.28, rng, { amp: 1.0, q: 1.0, sweep: [0.55, 260, 1500, 420], env: envBell(N(0.28), 2.5, 4), wobbleHz: 6.5, wobbleDepth: 0.06 }));
      add(buf, noiseBurst(0.14, rng, { amp: 0.26, type: 'hp', q: 0.9, sweep: [0.4, 2800, 4600, 3200] }), 0.05);
    },
  },

  /* ---------------- slicing: juicy fruit cuts ----------------
   *
   * Three-layer design (a real cut, not a puff of air):
   *   A. instant HF transient + damped knife tick + a SHORT low-mid knock
   *      (physical body — never a 60–170 Hz glide, which reads as breath);
   *   B. fibrous tearing = band-limited noise swept DOWN and multiplied by
   *      a crackle envelope (granular micro-events, zero smooth swell);
   *   C. a few discrete wet splats + at most one subtle high plip.
   * Nothing sustains: every layer is an event with a fast decay, so the
   * whoosh that precedes it can never be mistaken for the cut itself. */
  {
    path: 'slicing/fruit-cut-1.wav', peak: 0.88,
    render(buf, rng) {
      // Crisp apple: bright two-stage snap-crack, tight fibrous tear.
      add(buf, noiseBurst(0.009, rng, { amp: 1.0, type: 'hp', q: 0.7, sweep: [0.5, 2500, 6500, 4200], env: envAttackDecay(N(0.009), 0.0003, 0.004) }));
      add(buf, tone(3300, 3300, 0.012, { amp: 0.3, tau: 0.0035, attack: 0.0004 })); // knife tick
      add(buf, tone(285, 240, 0.03, { amp: 0.28, tau: 0.011, attack: 0.0006 }));    // short body knock
      add(buf, noiseBurst(0.006, rng, { amp: 0.5, type: 'hp', q: 0.8, sweep: [0.5, 1800, 5200, 3600], env: envAttackDecay(N(0.006), 0.0003, 0.0025) }), 0.016); // the "crack"
      add(buf, tone(2200, 2200, 0.01, { amp: 0.25, tau: 0.003, attack: 0.0004 }), 0.016);
      add(buf, tearLayer(0.085, rng, { sweep: [3000, 900], q: 0.9, amp: 0.8, crackle: { densityHz: 520, grainTauMs: 4.5, decayTau: 0.045 } }));
      add(buf, tearLayer(0.05, rng, { sweep: [3800, 1600], q: 1.2, amp: 0.35, crackle: { densityHz: 300, grainTauMs: 3.5, decayTau: 0.028 } }));
      add(buf, splat(0.022, rng, { cutoffHz: 1300, amp: 0.42 }), 0.06);
      add(buf, splat(0.02, rng, { cutoffHz: 1000, amp: 0.3 }), 0.12);
      add(buf, droplet(1400, 2100, 0.04, { amp: 0.1, tau: 0.01 }), 0.165);
    },
  },
  {
    path: 'slicing/fruit-cut-2.wav', peak: 0.88,
    render(buf, rng) {
      // Wet watermelon: full snap, deeper dense tear, short juicy splash.
      add(buf, noiseBurst(0.011, rng, { amp: 0.95, type: 'hp', q: 0.7, sweep: [0.5, 2200, 5600, 3800], env: envAttackDecay(N(0.011), 0.0004, 0.005) }));
      add(buf, tone(2900, 2900, 0.014, { amp: 0.28, tau: 0.004, attack: 0.0005 }));
      add(buf, tone(250, 205, 0.035, { amp: 0.3, tau: 0.013, attack: 0.0007 }));
      add(buf, tearLayer(0.12, rng, { sweep: [2400, 650], q: 0.85, amp: 0.85, crackle: { densityHz: 380, grainTauMs: 6, decayTau: 0.062 } }));
      add(buf, tearLayer(0.045, rng, { sweep: [3400, 1500], q: 1.1, amp: 0.3, crackle: { densityHz: 280, grainTauMs: 3.5, decayTau: 0.025 } }));
      add(buf, splat(0.024, rng, { cutoffHz: 950, amp: 0.5 }), 0.055);
      add(buf, splat(0.022, rng, { cutoffHz: 1150, amp: 0.4 }), 0.105);
      add(buf, splat(0.02, rng, { cutoffHz: 850, amp: 0.32 }), 0.16);
      add(buf, splat(0.018, rng, { cutoffHz: 750, amp: 0.24 }), 0.205);
      add(buf, droplet(1250, 1900, 0.04, { amp: 0.09, tau: 0.009 }), 0.17);
    },
  },
  {
    path: 'slicing/fruit-cut-3.wav', peak: 0.88,
    render(buf, rng) {
      // Clean citrus: shortest brightest snap, finer lighter rind tear.
      add(buf, noiseBurst(0.006, rng, { amp: 1.0, type: 'hp', q: 0.7, sweep: [0.5, 3000, 6800, 5000], env: envAttackDecay(N(0.006), 0.0002, 0.003) }));
      add(buf, tone(3600, 3600, 0.01, { amp: 0.32, tau: 0.0028, attack: 0.0003 }));
      add(buf, tone(320, 270, 0.026, { amp: 0.22, tau: 0.009, attack: 0.0005 }));
      add(buf, tearLayer(0.07, rng, { sweep: [3400, 1200], q: 1.0, amp: 0.72, crackle: { densityHz: 460, grainTauMs: 4, decayTau: 0.036 } }));
      add(buf, splat(0.02, rng, { cutoffHz: 1400, amp: 0.36 }), 0.065);
      add(buf, splat(0.018, rng, { cutoffHz: 1100, amp: 0.26 }), 0.125);
      add(buf, droplet(1500, 2300, 0.035, { amp: 0.08, tau: 0.009 }), 0.15);
    },
  },

  /* ---------------- slicing: fruit throw / launch ----------------
   *
   * A quick playful "fwoop" as fruits launch from below the playfield:
   *   A. a bright millisecond flick at the very start — the "f" of the
   *      fwoop, the hand releasing the fruit (also what keeps the sound
   *      from reading as plain wind, which has no attack);
   *   B. an airy bandpass sweep that only RISES (320→2100 Hz): the blade
   *      whooshes rise AND fall because a blade passes the ear — a thrown
   *      object instead keeps accelerating away, so its air noise never
   *      comes back down. This is the main cue separating throw from
   *      whoosh;
   *   C. a soft rounded tonal glide an octave up — the playful pitch
   *      movement. Kept ~15% of the noise level so it warms the fwoop
   *      without becoming a zappy laser glide;
   *   D. a subtle soft pop near the end (short lowpassed splat + a tiny
   *      150–190 Hz thump) as the fruit leaves the frame. Never an
   *      impact: no heavy bass, no explosion-style body.
   * Total 160–220 ms — energetic anticipation, clean fade-out. */
  {
    path: 'slicing/fruit-throw-1.wav', peak: 0.64,
    render(buf, rng) {
      // Classic fwoop: airy rise 320→2100 Hz, gentle tonal lift, soft pop.
      add(buf, noiseBurst(0.02, rng, { amp: 0.34, type: 'hp', q: 0.8, sweep: [0.4, 1600, 3400, 2600], env: envAttackDecay(N(0.02), 0.0006, 0.008) }));
      add(buf, noiseBurst(0.19, rng, { amp: 1.0, q: 1.3, sweep: [0.8, 320, 1900, 2100] }));
      add(buf, tone(300, 640, 0.15, { amp: 0.17, tau: 0.06, attack: 0.02, partials: [[2, 0.22, 0.6]] }));
      add(buf, splat(0.028, rng, { cutoffHz: 900, amp: 0.3 }), 0.14);
      add(buf, tone(190, 150, 0.045, { amp: 0.15, tau: 0.018, attack: 0.002 }), 0.15);
    },
  },
  {
    path: 'slicing/fruit-throw-2.wav', peak: 0.62,
    render(buf, rng) {
      // Faster, brighter "fwip": shorter rise 420→2650 Hz, lighter pop.
      add(buf, noiseBurst(0.016, rng, { amp: 0.3, type: 'hp', q: 0.9, sweep: [0.4, 2000, 3800, 3000], env: envAttackDecay(N(0.016), 0.0005, 0.007) }));
      add(buf, noiseBurst(0.16, rng, { amp: 1.0, q: 1.45, sweep: [0.82, 420, 2400, 2650], env: envBell(N(0.16), 1.5, 2.6) }));
      add(buf, tone(360, 800, 0.12, { amp: 0.15, tau: 0.05, attack: 0.015, partials: [[2, 0.2, 0.55]] }));
      add(buf, splat(0.024, rng, { cutoffHz: 1050, amp: 0.26 }), 0.12);
      add(buf, tone(210, 165, 0.04, { amp: 0.13, tau: 0.016, attack: 0.002 }), 0.13);
    },
  },
  {
    path: 'slicing/fruit-throw-3.wav', peak: 0.64,
    render(buf, rng) {
      // Rounder, warmer toss: slower rise 260→1650 Hz with a gentle flutter.
      add(buf, noiseBurst(0.022, rng, { amp: 0.28, type: 'hp', q: 0.8, sweep: [0.4, 1300, 2800, 2200], env: envAttackDecay(N(0.022), 0.0007, 0.009) }));
      add(buf, noiseBurst(0.22, rng, { amp: 1.0, q: 1.0, sweep: [0.78, 260, 1450, 1650], wobbleHz: 14, wobbleDepth: 0.12 }));
      add(buf, tone(240, 520, 0.18, { amp: 0.19, tau: 0.07, attack: 0.025, partials: [[2, 0.25, 0.6]] }));
      add(buf, splat(0.03, rng, { cutoffHz: 800, amp: 0.32 }), 0.16);
      add(buf, tone(170, 135, 0.05, { amp: 0.16, tau: 0.02, attack: 0.002 }), 0.17);
    },
  },

  /* ---------------- feedback ---------------- */
  {
    path: 'feedback/correct.wav', peak: 0.8,
    render(buf, rng) {
      // Pleasant ascending chime E5→A5 with sparkle.
      bellPhrase(buf, [
        [659.25, 0, 0.8, 0.16],
        [880.0, 0.115, 0.95, 0.22],
      ], { tailSec: 0.32, reverbWet: 0.2 });
      add(buf, bell(2637, 0.14, { amp: 0.14, tau: 0.1 }), 0.14);
      add(buf, noiseBurst(0.1, rng, { amp: 0.08, type: 'hp', q: 0.8, sweep: [0.4, 5000, 8000, 6000], env: envBell(N(0.1), 2, 3) }), 0.12);
    },
  },
  {
    path: 'feedback/incorrect.wav', peak: 0.72,
    render(buf) {
      // Soft downward two-note tone with a muted impact — clear, not harsh.
      add(buf, tone(130, 95, 0.06, { amp: 0.35, tau: 0.028, attack: 0.002 }));
      add(buf, tone(392, 392, 0.16, { amp: 0.62, tau: 0.11, attack: 0.012, partials: [[2, 0.18, 0.5]] }), 0.02);
      add(buf, tone(311.1, 311.1, 0.2, { amp: 0.62, tau: 0.13, attack: 0.012, partials: [[2, 0.18, 0.5]] }), 0.16);
    },
  },
  {
    path: 'feedback/heart-lost.wav', peak: 0.6,
    render(buf, rng) {
      // Brief distinct low "dud" — quieter and lower priority than the slice.
      add(buf, tone(230, 95, 0.2, { amp: 0.85, tau: 0.09, attack: 0.004, partials: [[2, 0.12, 0.4]] }));
      add(buf, noiseBurst(0.04, rng, { amp: 0.16, type: 'lp', q: 0.7, sweep: [0.5, 600, 400, 300], env: envAttackDecay(N(0.04), 0.001, 0.014) }));
    },
  },
  {
    path: 'feedback/fruit-missed.wav', peak: 0.42,
    render(buf, rng) {
      // Very soft airy "whiff" — a genuinely missed correct target only.
      add(buf, noiseBurst(0.2, rng, { amp: 1.0, type: 'lp', q: 0.8, sweep: [0.25, 1300, 900, 300], env: envBell(N(0.2), 3, 4) }));
    },
  },
  {
    path: 'feedback/combo-2.wav', peak: 0.78,
    render(buf, rng) {
      // Bright rising chime C6→E6 + small sparkle.
      bellPhrase(buf, [
        [1046.5, 0, 0.75, 0.13],
        [1318.5, 0.09, 0.9, 0.2],
      ], { tailSec: 0.3, reverbWet: 0.2 });
      add(buf, noiseBurst(0.09, rng, { amp: 0.07, type: 'hp', q: 0.8, sweep: [0.4, 5000, 8000, 6200], env: envBell(N(0.09), 2, 3) }), 0.09);
    },
  },
  {
    path: 'feedback/combo-3.wav', peak: 0.8,
    render(buf, rng) {
      // Stronger ascending chime C6→E6→G6 with sparkle.
      bellPhrase(buf, [
        [1046.5, 0, 0.7, 0.12],
        [1318.5, 0.085, 0.85, 0.16],
        [1568.0, 0.17, 1.0, 0.22],
      ], { tailSec: 0.32, reverbWet: 0.24 });
      add(buf, bell(3136, 0.12, { amp: 0.12, tau: 0.09 }), 0.17);
      add(buf, noiseBurst(0.12, rng, { amp: 0.08, type: 'hp', q: 0.8, sweep: [0.3, 5500, 8500, 6500], env: envBell(N(0.12), 2, 3) }), 0.15);
    },
  },
  {
    path: 'feedback/combo-high.wav', peak: 0.82,
    render(buf, rng) {
      // Celebratory energetic run A5 C6 E6 A6 + shimmer.
      bellPhrase(buf, [
        [880.0, 0, 0.68, 0.12],
        [1046.5, 0.08, 0.8, 0.15],
        [1318.5, 0.16, 0.92, 0.18],
        [1760.0, 0.26, 1.0, 0.3],
      ], { tailSec: 0.4, reverbWet: 0.28 });
      add(buf, bell(2637, 0.14, { amp: 0.12, tau: 0.11 }), 0.26);
      add(buf, noiseBurst(0.3, rng, { amp: 0.09, type: 'hp', q: 0.9, sweep: [0.5, 4000, 9000, 7000], env: envAttackDecay(N(0.3), 0.18, 0.12) }), 0.22);
    },
  },

  /* ---------------- progression ---------------- */
  {
    path: 'progression/countdown-tick.wav', peak: 0.55,
    render(buf, rng) {
      // Subtle soft tick — must not distract from reading the question.
      add(buf, tone(1050, 980, 0.07, { amp: 0.8, tau: 0.024, attack: 0.001 }));
      add(buf, noiseBurst(0.012, rng, { amp: 0.18, type: 'hp', q: 0.8, sweep: [0.5, 2800, 4200, 3200], env: envAttackDecay(N(0.012), 0.0005, 0.004) }));
    },
  },
  {
    path: 'progression/round-intro.wav', peak: 0.66,
    render(buf, rng) {
      // Pleasant short round-introduction sound (question card appears).
      bellPhrase(buf, [
        [659.25, 0, 0.62, 0.14],
        [987.77, 0.1, 0.72, 0.2],
      ], { tailSec: 0.28, reverbWet: 0.18 });
      add(buf, noiseBurst(0.12, rng, { amp: 0.06, type: 'hp', q: 0.9, sweep: [0.4, 3500, 6500, 5000], env: envBell(N(0.12), 2, 3) }), 0.05);
    },
  },
  {
    path: 'progression/round-start.wav', peak: 0.74,
    render(buf, rng) {
      // Energetic swoosh-pop as the card lands and fruits launch.
      add(buf, noiseBurst(0.2, rng, { amp: 0.95, q: 1.1, sweep: [0.55, 400, 2400, 1400], env: envBell(N(0.2), 2, 3) }));
      add(buf, tone(340, 690, 0.16, { amp: 0.4, tau: 0.07, attack: 0.01 }));
      add(buf, tone(170, 90, 0.07, { amp: 0.3, tau: 0.03, attack: 0.002 }), 0.1);
    },
  },
  {
    path: 'progression/round-success.wav', peak: 0.8,
    render(buf, rng) {
      // Bright short victory chime G5→C6→E6 + sparkle echo.
      bellPhrase(buf, [
        [783.99, 0, 0.7, 0.14],
        [1046.5, 0.11, 0.85, 0.18],
        [1318.5, 0.22, 1.0, 0.26],
      ], { tailSec: 0.45, reverbWet: 0.26 });
      add(buf, bell(2637, 0.1, { amp: 0.11, tau: 0.1 }), 0.4);
      add(buf, noiseBurst(0.1, rng, { amp: 0.07, type: 'hp', q: 0.8, sweep: [0.4, 5200, 8200, 6400], env: envBell(N(0.1), 2, 3) }), 0.24);
    },
  },
  {
    path: 'progression/round-failed.wav', peak: 0.66,
    render(buf) {
      // Gentle, encouraging two-note descent resolving on a warm low tone.
      add(buf, tone(440, 440, 0.16, { amp: 0.55, tau: 0.11, attack: 0.012, partials: [[2, 0.15, 0.5]] }), 0.02);
      add(buf, tone(349.23, 349.23, 0.18, { amp: 0.58, tau: 0.13, attack: 0.012, partials: [[2, 0.15, 0.5]] }), 0.16);
      add(buf, tone(220, 220, 0.3, { amp: 0.42, tau: 0.2, attack: 0.015, partials: [[2, 0.1, 0.4]] }), 0.3);
    },
  },
  {
    path: 'progression/level-win.wav', peak: 0.85,
    render(buf, rng) {
      // Uplifting arcade celebration: C-major motif, held climax, sparkle finish.
      const notes = [
        [523.25, 0, 0.6, 0.13],
        [659.25, 0.14, 0.68, 0.15],
        [783.99, 0.28, 0.78, 0.18],
        [1046.5, 0.48, 1.0, 0.55],   // held high C — the payoff note
        [523.25, 0.48, 0.35, 0.3],   // low root under the climax
        [1318.5, 0.9, 0.42, 0.2],    // sparkle finish arpeggio
        [1568.0, 1.02, 0.4, 0.2],
        [2093.0, 1.14, 0.42, 0.28],
      ];
      for (const [freq, at, amp, tau] of notes) add(buf, bell(freq, 0.5, { amp, tau }), at);
      // Rising shimmer underneath the climax.
      add(buf, noiseBurst(0.6, rng, { amp: 0.1, type: 'hp', q: 0.9, sweep: [0.6, 3500, 9000, 7500], env: envAttackDecay(N(0.6), 0.35, 0.25) }), 0.5);
      return reverb(buf, { wet: 0.32 });
    },
  },
  {
    path: 'progression/level-failed.wav', peak: 0.7,
    render(buf) {
      // Short encouraging failure: warm descending phrase, no siren, no drama.
      const notes = [
        [392.0, 0, 0.55, 0.2],
        [329.63, 0.22, 0.55, 0.22],
        [261.63, 0.44, 0.62, 0.3],
        [130.81, 0.5, 0.3, 0.4],     // warm low floor under the last note
      ];
      for (const [freq, at, amp, tau] of notes) {
        add(buf, tone(freq, freq, Math.max(0.25, tau * 1.8), { amp, tau, attack: 0.02, partials: [[2, 0.2, 0.6]] }), at);
      }
      return reverb(buf, { wet: 0.18 });
    },
  },
  {
    path: 'progression/level-unlocked.wav', peak: 0.78,
    render(buf, rng) {
      // Magical ascending flourish with shimmer.
      const notes = [
        [1046.5, 0, 0.55, 0.12],
        [1174.7, 0.07, 0.62, 0.13],
        [1318.5, 0.14, 0.7, 0.14],
        [1568.0, 0.21, 0.78, 0.16],
        [1760.0, 0.28, 0.85, 0.18],
        [2093.0, 0.36, 1.0, 0.32],
      ];
      for (const [freq, at, amp, tau] of notes) add(buf, bell(freq, 0.45, { amp, tau }), at);
      add(buf, noiseBurst(0.45, rng, { amp: 0.11, type: 'hp', q: 0.9, sweep: [0.5, 3000, 9500, 8000], env: envAttackDecay(N(0.45), 0.25, 0.18) }), 0.2);
      return reverb(buf, { wet: 0.3 });
    },
  },
  {
    path: 'progression/star-earned.wav', peak: 0.72,
    render(buf, rng) {
      // Small glittering star: two high bells + sparkle sweep.
      bellPhrase(buf, [
        [2093.0, 0, 0.7, 0.12],
        [2637.0, 0.1, 0.9, 0.2],
      ], { tailSec: 0.3, reverbWet: 0.24 });
      add(buf, noiseBurst(0.14, rng, { amp: 0.09, type: 'hp', q: 0.9, sweep: [0.4, 5500, 9000, 7000], env: envBell(N(0.14), 2, 3) }), 0.06);
    },
  },
  {
    path: 'progression/three-stars.wav', peak: 0.82,
    render(buf, rng) {
      // Special three-star achievement: rich arpeggio + warm pad + shimmer.
      const notes = [
        [1046.5, 0, 0.6, 0.12],
        [1318.5, 0.1, 0.7, 0.15],
        [1568.0, 0.2, 0.8, 0.18],
        [2093.0, 0.31, 1.0, 0.36],
      ];
      for (const [freq, at, amp, tau] of notes) add(buf, bell(freq, 0.5, { amp, tau }), at);
      add(buf, tone(440, 440, 0.8, { amp: 0.14, tau: 0.4, attack: 0.1 })); // warm pad
      add(buf, tone(659.25, 659.25, 0.8, { amp: 0.12, tau: 0.4, attack: 0.12 }), 0.05);
      add(buf, noiseBurst(0.5, rng, { amp: 0.1, type: 'hp', q: 0.9, sweep: [0.5, 4000, 9500, 8000], env: envAttackDecay(N(0.5), 0.3, 0.2) }), 0.28);
      return reverb(buf, { wet: 0.34 });
    },
  },
  {
    path: 'progression/achievement.wav', peak: 0.78,
    render(buf, rng) {
      // Distinctive short fanfare G5-G5-C6 with a sparkle tail.
      const fanfare = (freq, at, amp) =>
        add(buf, tone(freq * 0.985, freq, 0.3, { amp, tau: 0.16, attack: 0.02, partials: [[2, 0.32, 0.6], [3, 0.14, 0.35]] }), at);
      fanfare(783.99, 0, 0.6);
      fanfare(783.99, 0.16, 0.6);
      fanfare(1046.5, 0.33, 0.85);
      add(buf, bell(2093, 0.16, { amp: 0.12, tau: 0.12 }), 0.36);
      add(buf, noiseBurst(0.14, rng, { amp: 0.07, type: 'hp', q: 0.8, sweep: [0.4, 5200, 8600, 6600], env: envBell(N(0.14), 2, 3) }), 0.36);
      return reverb(buf, { wet: 0.24 });
    },
  },

  /* ---------------- ui ---------------- */
  {
    path: 'ui/button-click.wav', peak: 0.62,
    render(buf, rng) {
      // Short pleasant tactile click.
      add(buf, tone(1900, 1450, 0.055, { amp: 0.8, tau: 0.013, attack: 0.0008 }));
      add(buf, noiseBurst(0.01, rng, { amp: 0.28, type: 'hp', q: 0.8, sweep: [0.5, 2400, 4200, 3000], env: envAttackDecay(N(0.01), 0.0004, 0.003) }));
    },
  },
  {
    path: 'ui/button-hover.wav', peak: 0.38,
    render(buf) {
      // Very subtle soft blip (desktop, rate-limited).
      add(buf, tone(2500, 2500, 0.05, { amp: 0.9, tau: 0.011, attack: 0.0008 }));
    },
  },
  {
    path: 'ui/menu-open.wav', peak: 0.62,
    render(buf, rng) {
      // Polished panel transition: soft rising sweep + gentle thunk.
      add(buf, noiseBurst(0.16, rng, { amp: 0.8, q: 1.0, sweep: [0.6, 600, 1900, 1200], env: envBell(N(0.16), 2, 3) }));
      add(buf, tone(185, 130, 0.08, { amp: 0.3, tau: 0.033, attack: 0.003 }), 0.11);
    },
  },
  {
    path: 'ui/pause.wav', peak: 0.6,
    render(buf) {
      // Gentle muted descending transition.
      add(buf, tone(520, 520, 0.13, { amp: 0.6, tau: 0.09, attack: 0.012, partials: [[2, 0.14, 0.5]] }), 0.01);
      add(buf, tone(390, 390, 0.17, { amp: 0.6, tau: 0.11, attack: 0.012, partials: [[2, 0.14, 0.5]] }), 0.15);
    },
  },
  {
    path: 'ui/resume.wav', peak: 0.6,
    render(buf) {
      // Light positive ascending transition.
      add(buf, tone(440, 440, 0.12, { amp: 0.6, tau: 0.08, attack: 0.01, partials: [[2, 0.14, 0.5]] }), 0.01);
      add(buf, tone(587.33, 587.33, 0.15, { amp: 0.62, tau: 0.1, attack: 0.01, partials: [[2, 0.14, 0.5]] }), 0.13);
    },
  },
];

/* ------------------------------------------------------------------ */
/* Build + verify                                                      */
/* ------------------------------------------------------------------ */

function analyze(bytes) {
  const numSamples = bytes.readUInt32LE(40) / 2;
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < numSamples; i++) {
    const s = bytes.readInt16LE(44 + i * 2) / 32768;
    const a = Math.abs(s);
    if (a > peak) peak = a;
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, numSamples));
  return { numSamples, peak, rms };
}

function buildAll() {
  console.log(`Rendering ${SOUNDS.length} sounds at ${SR} Hz mono → ${OUT_DIR}\n`);
  const rows = [];
  for (const def of SOUNDS) {
    // One independent PRNG stream per sound (stable ordering = stable output).
    const rng = mulberry32(SEED + hashPath(def.path));
    const sized = allocOf(def);
    let rendered;
    try {
      rendered = def.render(sized, rng);
    } catch (err) {
      throw new Error(`render failed for ${def.path}: ${err.message}`);
    }
    const data = rendered || sized;
    finalize(data, { peak: def.peak });
    const bytes = wavBytes(data);
    const file = join(OUT_DIR, def.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    const { numSamples, peak, rms } = analyze(bytes);
    rows.push({
      path: def.path,
      kb: (bytes.length / 1024).toFixed(1),
      ms: Math.round((numSamples / SR) * 1000),
      peak: peak.toFixed(3),
      rmsDb: (20 * Math.log10(Math.max(rms, 1e-9))).toFixed(1),
    });
  }
  printTable(rows);
}

/** Deterministic per-path seed offset. */
function hashPath(path) {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Allocates a buffer long enough for each def (max end time + tail). */
function allocOf(def) {
  const extents = DURATIONS[def.path];
  if (!extents) throw new Error(`missing duration budget for ${def.path}`);
  return alloc(extents);
}

/**
 * Explicit buffer budgets (seconds) — every layer of each sound must fit,
 * including reverb tails. Keeping this explicit avoids truncation surprises.
 */
const DURATIONS = {
  'slicing/blade-whoosh-1.wav': 0.22,
  'slicing/blade-whoosh-2.wav': 0.30,
  'slicing/blade-whoosh-3.wav': 0.18,
  'slicing/blade-whoosh-4.wav': 0.30,
  'slicing/fruit-cut-1.wav': 0.24,
  'slicing/fruit-cut-2.wav': 0.27,
  'slicing/fruit-cut-3.wav': 0.22,
  'slicing/fruit-throw-1.wav': 0.24,
  'slicing/fruit-throw-2.wav': 0.22,
  'slicing/fruit-throw-3.wav': 0.28,
  'feedback/correct.wav': 0.46,
  'feedback/incorrect.wav': 0.40,
  'feedback/heart-lost.wav': 0.28,
  'feedback/fruit-missed.wav': 0.24,
  'feedback/combo-2.wav': 0.40,
  'feedback/combo-3.wav': 0.46,
  'feedback/combo-high.wav': 0.70,
  'progression/countdown-tick.wav': 0.10,
  'progression/round-intro.wav': 0.40,
  'progression/round-start.wav': 0.28,
  'progression/round-success.wav': 0.85,
  'progression/round-failed.wav': 0.65,
  'progression/level-win.wav': 2.30,
  'progression/level-failed.wav': 1.35,
  'progression/level-unlocked.wav': 0.85,
  'progression/star-earned.wav': 0.48,
  'progression/three-stars.wav': 1.10,
  'progression/achievement.wav': 0.85,
  'ui/button-click.wav': 0.08,
  'ui/button-hover.wav': 0.07,
  'ui/menu-open.wav': 0.24,
  'ui/pause.wav': 0.36,
  'ui/resume.wav': 0.32,
};

function printTable(rows) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log([pad('file', 36), pad('KB', 6), pad('ms', 6), pad('peak', 6), 'rms dBFS'].join(''));
  let total = 0;
  for (const r of rows) {
    total += parseFloat(r.kb);
    console.log([pad(r.path, 36), pad(r.kb, 6), pad(r.ms, 6), pad(r.peak, 6), r.rmsDb].join(''));
  }
  console.log(`\n${rows.length} files, ${total.toFixed(1)} KB total`);
}

function checkAll() {
  let failures = 0;
  const rows = [];
  for (const def of SOUNDS) {
    const file = join(OUT_DIR, def.path);
    const rel = `assets/audio/${def.path}`;
    if (!existsSync(file)) {
      console.error(`MISSING ${rel}`);
      failures++;
      continue;
    }
    const bytes = readFileSync(file);
    const okHeader = bytes.length > 44
      && bytes.toString('ascii', 0, 4) === 'RIFF'
      && bytes.toString('ascii', 8, 12) === 'WAVE'
      && bytes.toString('ascii', 36, 40) === 'data'
      && bytes.readUInt16LE(20) === 1
      && bytes.readUInt16LE(22) === 1
      && bytes.readUInt32LE(24) === SR;
    const { numSamples, peak, rms } = analyze(bytes);
    const okAudio = okHeader && peak > 0.15 && rms > 0.003 && numSamples > SR * 0.03;
    if (!okHeader || !okAudio) {
      console.error(`BAD     ${rel} header=${okHeader} peak=${peak.toFixed(3)} rms=${rms.toFixed(5)}`);
      failures++;
      continue;
    }
    rows.push({ path: def.path, kb: (statSync(file).size / 1024).toFixed(1), ms: Math.round(numSamples / SR * 1000), peak: peak.toFixed(3), rmsDb: (20 * Math.log10(Math.max(rms, 1e-9))).toFixed(1) });
  }
  printTable(rows);
  if (failures) {
    console.error(`\n${failures} file(s) failed validation`);
    process.exitCode = 1;
  } else {
    console.log('\nAll files valid: RIFF/WAVE PCM mono headers, audible content present.');
  }
}

if (process.argv.includes('--check')) {
  checkAll();
} else {
  buildAll();
  console.log('\n--- validation pass ---');
  checkAll();
}
