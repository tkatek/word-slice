/**
 * Word Slice — round introduction scheduler (pure, DOM-free).
 *
 * Times the per-round question introduction: a centered question card
 * holds for a countdown, then flies to its top slot, then the round may
 * launch. The browser layer (game.js) drives step() from the single rAF
 * loop and decides what "active" means (engine ROUND_READY, tab visible,
 * no overlay open), so the countdown only ever consumes active, visible
 * time — pausing or hiding the tab freezes it.
 *
 * Guarantees relied upon by tests:
 * - begin() resets everything, so a new round can never inherit state.
 * - 'launch' is returned at most once per begin(), no matter how often
 *   settle()/tryLaunch()/step() are called.
 * - cancel() permanently silences a running introduction.
 * - Oversized frame deltas are clamped so a stalled watchdog tick cannot
 *   skip the countdown.
 */
export const INTRO_STATES = Object.freeze({
  IDLE: 'idle',
  HOLD: 'hold',
  FLIGHT: 'flight',
  AWAIT_LAUNCH: 'awaitLaunch',
});

export const INTRO_HOLD_MS = 4000;
export const INTRO_FLIGHT_MS = 520;
/** Max countdown time consumed by a single step (watchdog stall guard). */
export const INTRO_MAX_STEP_MS = 50;

export class RoundIntroScheduler {
  /**
   * @param {{holdMs?: number, flightMs?: number, maxStepMs?: number}} [options]
   */
  constructor(options = {}) {
    this.holdMs = Math.max(0, options.holdMs ?? INTRO_HOLD_MS);
    this.flightMs = Math.max(0, options.flightMs ?? INTRO_FLIGHT_MS);
    this.maxStepMs = Math.max(1, options.maxStepMs ?? INTRO_MAX_STEP_MS);
    this._state = INTRO_STATES.IDLE;
    this._remainingMs = 0;
    this._flightElapsedMs = 0;
    this._launched = false;
  }

  get state() {
    return this._state;
  }

  /** Whole seconds left in the hold ("Starting in 3s"). */
  get remainingSeconds() {
    return Math.max(0, Math.ceil(this._remainingMs / 1000));
  }

  /** Hold progress 0..1 (drives the countdown bar). */
  get progress() {
    return this.holdMs > 0 ? Math.min(1, Math.max(0, 1 - this._remainingMs / this.holdMs)) : 1;
  }

  /** Starts (or restarts) an introduction. */
  begin() {
    this._state = this.holdMs > 0 ? INTRO_STATES.HOLD : INTRO_STATES.FLIGHT;
    this._remainingMs = this.holdMs;
    this._flightElapsedMs = 0;
    this._launched = false;
    return this._state;
  }

  /** Cancels an introduction; later callbacks can never launch from it. */
  cancel() {
    this._state = INTRO_STATES.IDLE;
    this._remainingMs = 0;
    this._flightElapsedMs = 0;
    this._launched = false;
  }

  /**
   * Advances by dtMs of frame time. Progress happens only while `active`
   * is true (visible, unpaused, no overlay); inactive steps are absorbed
   * without consuming the countdown.
   *
   * @returns {'tick'|'fly'|'settled'|null} action for this step.
   */
  step(dtMs, active) {
    if (this._state === INTRO_STATES.HOLD) {
      if (active) this._remainingMs -= Math.min(Math.max(dtMs, 0), this.maxStepMs);
      if (this._remainingMs <= 0) {
        this._remainingMs = 0;
        this._state = INTRO_STATES.FLIGHT;
        this._flightElapsedMs = 0;
        return 'fly';
      }
      return 'tick';
    }
    if (this._state === INTRO_STATES.FLIGHT) {
      if (active) this._flightElapsedMs += Math.min(Math.max(dtMs, 0), this.maxStepMs);
      if (this._flightElapsedMs >= this.flightMs) {
        this._state = INTRO_STATES.AWAIT_LAUNCH;
        return 'settled';
      }
      return null;
    }
    return null;
  }

  /** Flight animation finished (transitionend). Safe to call anytime. */
  settle() {
    if (this._state !== INTRO_STATES.FLIGHT) return null;
    this._state = INTRO_STATES.AWAIT_LAUNCH;
    return 'settled';
  }

  /**
   * Attempts to fire the round launch. Returns 'launch' exactly once per
   * begin(), and only while `canLaunch` is true (e.g. paused mid-flight
   * defers the launch until the game resumes).
   */
  tryLaunch(canLaunch) {
    if (this._state !== INTRO_STATES.AWAIT_LAUNCH || this._launched || !canLaunch) return null;
    this._launched = true;
    this._state = INTRO_STATES.IDLE;
    return 'launch';
  }
}
