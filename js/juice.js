/**
 * Word Slice — juice splash & droplet effects (canvas layer).
 *
 * Presentation-only particle system for sliced fruits. One JuiceFx instance
 * owns every live burst: game.js spawns on the engine's confirmed slice
 * events, steps it from the single rAF loop (so pausing the engine freezes
 * the juice with everything else) and paints into the dedicated #fx canvas
 * that sits above the separating fruit halves and below the blade trail.
 *
 * The splash is an irregular union of uneven lobes (plus satellite beads
 * and a gloss highlight) that expands fast along the swipe axis and fades
 * inside ~350 ms; droplets are gravity-driven shrinking circles with white
 * glints that expire inside ~650 ms. Everything is plain canvas fills —
 * no DOM nodes, no blur filters, no timers — with hard ceilings on live
 * bursts and droplets, and a smaller mobile budget.
 *
 * The module is DOM-free apart from the 2D context handed to draw(), so it
 * unit-tests in Node with a mock context and an injectable rng.
 */

export const JUICE_TUNING = Object.freeze({
  // Simultaneous splash groups (oldest dropped when exceeded).
  MAX_BURSTS: 14,
  MAX_BURSTS_MOBILE: 10,
  // Main splash visible duration (ms): expand fast, never linger.
  SPLASH_MS_MIN: 190,
  SPLASH_MS_MAX: 340,
  // Droplets per slice.
  DROPS_MIN: 12,
  DROPS_MAX: 16,
  DROPS_MIN_MOBILE: 8,
  DROPS_MAX_MOBILE: 10,
  // Droplet lifetimes (ms).
  DROP_LIFE_MS_MIN: 300,
  DROP_LIFE_MS_MAX: 650,
  // Droplet launch speeds (px/s before swipe bias and speed scaling).
  DROP_SPEED_MIN: 150,
  DROP_SPEED_MAX: 340,
  // Fraction of the launch speed added along the swipe direction.
  DROP_SWIPE_BIAS: 0.45,
  // Swipe speed (px/ms) → effect scale, clamped: faster slashes burst
  // harder, but the effect stays bounded.
  SPEED_SCALE_MIN: 0.85,
  SPEED_SCALE_MAX: 1.25,
  SPEED_PER_PXMS: 0.12,
});

const TAU = Math.PI * 2;

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function smoothstep(a, b, t) {
  const x = clamp((t - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
}

const rgbCache = new Map();

/**
 * Parses '#rrggbb' into [r, g, b] (cached; bad input falls back to a
 * generic red so a typo never blanks the juice).
 * @returns {[number, number, number]}
 */
export function hexToRgb(hex) {
  const key = String(hex);
  let out = rgbCache.get(key);
  if (out) return out;
  const m = /^#([0-9a-f]{6})$/i.exec(key.trim());
  out = m
    ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)]
    : [226, 62, 62];
  rgbCache.set(key, out);
  return out;
}

export class JuiceFx {
  /**
   * @param {{rng?: () => number, mobile?: boolean}} [options]
   */
  constructor(options = {}) {
    this._rand = typeof options.rng === 'function' ? options.rng : Math.random;
    this._bursts = [];
    this._maxBursts = options.mobile ? JUICE_TUNING.MAX_BURSTS_MOBILE : JUICE_TUNING.MAX_BURSTS;
    this._dropMin = options.mobile ? JUICE_TUNING.DROPS_MIN_MOBILE : JUICE_TUNING.DROPS_MIN;
    this._dropMax = options.mobile ? JUICE_TUNING.DROPS_MAX_MOBILE : JUICE_TUNING.DROPS_MAX;
  }

  /** Live splash groups. */
  get count() {
    return this._bursts.length;
  }

  /** Total live droplets across all bursts. */
  get dropletCount() {
    let n = 0;
    for (const b of this._bursts) n += b.drops.length;
    return n;
  }

  /** Drops every burst (restart, level change, leaving the game screen). */
  clear() {
    this._bursts.length = 0;
  }

  /**
   * One sliced fruit → one burst = main splash + satellites + droplets.
   *
   * @param {number} x cut point (playfield CSS px)
   * @param {number} y
   * @param {{size?: number, juice?: string, dirX?: number, dirY?: number, speedPxMs?: number, gravity?: number}} [opts]
   *   size — whole-fruit sprite box width, sets the splash scale;
   *   juice — fruit juice color ('#rrggbb', centralized in FRUIT_ASSETS);
   *   dirX/dirY — swipe unit vector; speedPxMs — recent swipe speed.
   * @returns {object|null} the created burst (null never happens; kept for tests)
   */
  spawn(x, y, opts = {}) {
    const t = JUICE_TUNING;
    const rand = this._rand;
    const scale = clamp(
      t.SPEED_SCALE_MIN + (Number(opts.speedPxMs) || 0) * t.SPEED_PER_PXMS,
      t.SPEED_SCALE_MIN,
      t.SPEED_SCALE_MAX,
    );
    let dirX = Number(opts.dirX) || 0;
    let dirY = Number(opts.dirY) || 0;
    const dirLen = Math.hypot(dirX, dirY);
    if (dirLen < 0.001) {
      dirX = 1;
      dirY = 0;
    } else {
      dirX /= dirLen;
      dirY /= dirLen;
    }

    const base = Math.max(24, (Number(opts.size) || 90) * 0.5) * scale;

    // Organic silhouette: 7–9 uneven lobes. Each lobe is a circle whose
    // center drifts outward and whose radius grows on its own (staggered)
    // schedule — the filled union reads as splashing liquid, not a disc.
    const lobeCount = 7 + Math.floor(rand() * 3);
    const lobes = [];
    for (let i = 0; i < lobeCount; i++) {
      lobes.push({
        ang: (i / lobeCount) * TAU + (rand() - 0.5) * (TAU / lobeCount) * 0.7,
        dist: (0.18 + rand() * 0.52) * base,
        rad: (0.34 + rand() * 0.6) * base,
        delay: rand() * 0.22,
      });
    }
    // 2–3 smaller satellite beads flung a bit further out.
    const satCount = 2 + Math.floor(rand() * 2);
    const sats = [];
    for (let i = 0; i < satCount; i++) {
      sats.push({
        ang: rand() * TAU,
        dist: (0.9 + rand() * 0.4) * base,
        rad: (0.1 + rand() * 0.13) * base,
        delay: 0.1 + rand() * 0.2,
      });
    }

    // Droplets: varied sizes/speeds, natural outward directions, biased
    // along the swipe, gravity-fed, short bounded lives.
    const dropCount = this._dropMin + Math.floor(rand() * (this._dropMax - this._dropMin + 1));
    const maxRad = Math.max(4, base * 0.09);
    const drops = [];
    for (let i = 0; i < dropCount; i++) {
      const ang = rand() * TAU;
      const spd = (t.DROP_SPEED_MIN + rand() * (t.DROP_SPEED_MAX - t.DROP_SPEED_MIN)) * scale;
      drops.push({
        x: x + Math.cos(ang) * base * 0.22 * rand(),
        y: y + Math.sin(ang) * base * 0.22 * rand(),
        vx: Math.cos(ang) * spd + dirX * spd * t.DROP_SWIPE_BIAS,
        vy: Math.sin(ang) * spd * 0.8 + dirY * spd * t.DROP_SWIPE_BIAS - 30,
        rad: 2 + rand() * maxRad,
        age: 0,
        life: (t.DROP_LIFE_MS_MIN + rand() * (t.DROP_LIFE_MS_MAX - t.DROP_LIFE_MS_MIN)) / 1000,
      });
    }

    const burst = {
      x,
      y,
      rgb: hexToRgb(opts.juice),
      base,
      dirX,
      dirY,
      splashMs: t.SPLASH_MS_MIN + rand() * (t.SPLASH_MS_MAX - t.SPLASH_MS_MIN),
      age: 0,
      gravity: Number.isFinite(opts.gravity) && opts.gravity > 0 ? opts.gravity : 900,
      lobes,
      sats,
      drops,
    };
    while (this._bursts.length >= this._maxBursts) this._bursts.shift();
    this._bursts.push(burst);
    return burst;
  }

  /**
   * Advances every live burst by `dtSeconds` (clamped: a stalled or
   * watchdog-driven frame must not teleport droplets). A burst survives
   * until its splash finished AND its last droplet expired — expired
   * effects are dropped immediately.
   */
  step(dtSeconds) {
    let dt = Number(dtSeconds);
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    if (dt > 0.06) dt = 0.06;
    const alive = [];
    for (const b of this._bursts) {
      b.age += dt;
      for (const d of b.drops) {
        d.age += dt;
        d.vy += b.gravity * dt;
        d.x += d.vx * dt;
        d.y += d.vy * dt;
      }
      const splashDone = b.age * 1000 >= b.splashMs;
      let dropsDone = true;
      for (const d of b.drops) {
        if (d.age < d.life) {
          dropsDone = false;
          break;
        }
      }
      if (!splashDone || !dropsDone) alive.push(b);
    }
    this._bursts = alive;
  }

  /** Paints every live burst (CSS-pixel coordinates, dpr handled outside). */
  draw(ctx) {
    for (const b of this._bursts) this._drawSplash(ctx, b);
    this._drawDrops(ctx);
    ctx.globalAlpha = 1;
  }

  /** Main splash: dark wet rim → body → lighter juicy core → beads → gloss. */
  _drawSplash(ctx, b) {
    const p = (b.age * 1000) / b.splashMs;
    if (p >= 1) return;
    const grow = easeOutCubic(clamp(p / 0.6, 0, 1));
    const fade = 1 - smoothstep(0.45, 1, p);
    if (fade <= 0) return;
    const [r, g, bl] = b.rgb;
    const dark = `rgb(${(r * 0.66) | 0},${(g * 0.66) | 0},${(bl * 0.66) | 0})`;
    const main = `rgb(${r},${g},${bl})`;
    const lite = `rgb(${(r + (255 - r) * 0.55) | 0},${(g + (255 - g) * 0.55) | 0},${(bl + (255 - bl) * 0.55) | 0})`;

    ctx.save();
    ctx.translate(b.x, b.y);
    // Elongated along the swipe: the liquid spreads with the blade.
    ctx.rotate(Math.atan2(b.dirY, b.dirX));
    ctx.scale(1.18, 0.82);

    const paintLobes = (color, radScale, distScale, alpha) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const l of b.lobes) {
        const lp = easeOutCubic(clamp((p - l.delay) / (1 - l.delay), 0, 1));
        if (lp <= 0) continue;
        const cx = Math.cos(l.ang) * l.dist * distScale * grow;
        const cy = Math.sin(l.ang) * l.dist * distScale * grow;
        const rr = l.rad * radScale * (0.55 + 0.45 * lp);
        if (rr <= 0.1) continue;
        ctx.moveTo(cx + rr, cy);
        ctx.arc(cx, cy, rr, 0, TAU);
      }
      ctx.fill();
    };
    paintLobes(dark, 1.08, 1.0, 0.55 * fade);
    paintLobes(main, 0.92, 0.96, 0.88 * fade);
    paintLobes(lite, 0.55, 0.55, 0.5 * fade);

    // Satellite beads — small secondary splashes outside the main blob.
    ctx.globalAlpha = 0.8 * fade;
    ctx.fillStyle = main;
    ctx.beginPath();
    for (const s of b.sats) {
      const sp = easeOutCubic(clamp((p - s.delay) / (1 - s.delay), 0, 1));
      if (sp <= 0) continue;
      const cx = Math.cos(s.ang) * s.dist * grow;
      const cy = Math.sin(s.ang) * s.dist * grow;
      const rr = s.rad * (0.5 + 0.5 * sp);
      ctx.moveTo(cx + rr, cy);
      ctx.arc(cx, cy, rr, 0, TAU);
    }
    ctx.fill();

    // Subtle liquid shine.
    ctx.globalAlpha = 0.34 * fade;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(
      -b.base * 0.3 * grow,
      -b.base * 0.34 * grow,
      Math.max(1, b.base * 0.26 * grow),
      Math.max(1, b.base * 0.15 * grow),
      -0.5,
      0,
      TAU,
    );
    ctx.fill();
    ctx.restore();
  }

  /**
   * Droplets, batched into one fill per burst: they shrink smoothly over
   * the last ~65% of their life (reads as a liquid fading out), and the
   * bigger ones carry a small white glint.
   */
  _drawDrops(ctx) {
    for (const b of this._bursts) {
      if (b.drops.length === 0) continue;
      ctx.fillStyle = `rgb(${b.rgb[0]},${b.rgb[1]},${b.rgb[2]})`;
      ctx.globalAlpha = 0.92;
      ctx.beginPath();
      let any = false;
      for (const d of b.drops) {
        const fade = 1 - smoothstep(0.35, 1, d.age / d.life);
        if (fade <= 0.02) continue;
        const rr = d.rad * (0.35 + 0.65 * fade);
        if (rr <= 0.2) continue;
        ctx.moveTo(d.x + rr, d.y);
        ctx.arc(d.x, d.y, rr, 0, TAU);
        any = true;
      }
      if (any) ctx.fill();

      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      let anyGlint = false;
      for (const d of b.drops) {
        if (d.rad < 3.2) continue;
        const fade = 1 - smoothstep(0.35, 1, d.age / d.life);
        if (fade <= 0.02) continue;
        const rr = d.rad * 0.32 * (0.35 + 0.65 * fade);
        ctx.moveTo(d.x - d.rad * 0.32 + rr, d.y - d.rad * 0.36);
        ctx.arc(d.x - d.rad * 0.32, d.y - d.rad * 0.36, rr, 0, TAU);
        anyGlint = true;
      }
      if (anyGlint) ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
