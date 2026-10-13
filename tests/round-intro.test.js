/**
 * Focused tests for the automatic round-introduction scheduler:
 * automatic launch behavior and interruption safety.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoundIntroScheduler,
  INTRO_STATES,
  INTRO_HOLD_MS,
  INTRO_FLIGHT_MS,
} from '../js/round-intro.js';

test('INTRO: hold counts down only while active', () => {
  const intro = new RoundIntroScheduler();
  intro.begin();
  assert.equal(intro.state, INTRO_STATES.HOLD);
  assert.equal(intro.remainingSeconds, 4);

  // Inactive time (paused / hidden tab / overlay) must not be consumed.
  intro.step(2000, false);
  intro.step(2000, false);
  assert.equal(intro.remainingSeconds, 4);

  intro.step(1000, true); // clamped to maxStepMs
  assert.equal(intro.remainingSeconds, 4); // 3.95s left still rounds up
  for (let i = 0; i < 19; i++) intro.step(50, true); // 950ms more → 3.0s left
  assert.equal(intro.remainingSeconds, 3);
});

test('INTRO: oversized frame deltas are clamped (watchdog stall guard)', () => {
  const intro = new RoundIntroScheduler({ maxStepMs: 50 });
  intro.begin();
  // A stalled watchdog tick reporting 5s must not skip the countdown.
  intro.step(5000, true);
  assert.equal(intro.remainingSeconds, 4);
  assert.equal(intro.state, INTRO_STATES.HOLD);
});

test('INTRO: countdown finishing emits fly exactly once, then settles and launches once', () => {
  const intro = new RoundIntroScheduler();
  intro.begin();
  const actions = [];
  for (let i = 0; i < 400 && intro.state === INTRO_STATES.HOLD; i++) {
    actions.push(intro.step(16, true));
  }
  assert.equal(actions.at(-1), 'fly');
  assert.equal(intro.state, INTRO_STATES.FLIGHT);

  // Step-driven flight completion.
  let settled = null;
  for (let i = 0; i < 200 && intro.state === INTRO_STATES.FLIGHT; i++) {
    settled = intro.step(16, true);
  }
  assert.equal(settled, 'settled');
  assert.equal(intro.tryLaunch(true), 'launch');
  assert.equal(intro.state, INTRO_STATES.IDLE);
});

test('INTRO: flight freezes while inactive and still launches exactly once', () => {
  const intro = new RoundIntroScheduler();
  intro.begin();
  while (intro.state === INTRO_STATES.HOLD) intro.step(50, true);
  // Paused mid-flight: time passes but the flight does not advance.
  for (let i = 0; i < 50; i++) intro.step(100, false);
  assert.equal(intro.state, INTRO_STATES.FLIGHT);
  // Resume: flight completes.
  while (intro.state === INTRO_STATES.FLIGHT) intro.step(16, true);
  assert.equal(intro.tryLaunch(true), 'launch');
  // No double launch, however often the DOM fires completion again.
  assert.equal(intro.tryLaunch(true), null);
  assert.equal(intro.settle(), null);
  assert.equal(intro.step(100, true), null);
});

test('INTRO: settle() while paused defers the launch until allowed', () => {
  const intro = new RoundIntroScheduler();
  intro.begin();
  while (intro.state === INTRO_STATES.HOLD) intro.step(50, true);
  // transitionend arrives while the game is paused (canLaunch false).
  assert.equal(intro.settle(), 'settled');
  assert.equal(intro.tryLaunch(false), null);
  assert.equal(intro.state, INTRO_STATES.AWAIT_LAUNCH);
  // Resume path: the launch fires exactly once.
  assert.equal(intro.tryLaunch(true), 'launch');
  assert.equal(intro.tryLaunch(true), null);
});

test('INTRO: cancel silences a running introduction permanently', () => {
  const intro = new RoundIntroScheduler();
  intro.begin();
  while (intro.state === INTRO_STATES.HOLD) intro.step(50, true);
  intro.cancel();
  assert.equal(intro.state, INTRO_STATES.IDLE);
  // Stale callbacks after a restart/level change must not launch anything.
  assert.equal(intro.settle(), null);
  assert.equal(intro.tryLaunch(true), null);
  assert.equal(intro.step(1000, true), null);
});

test('INTRO: begin() resets state so the next round starts clean', () => {
  const intro = new RoundIntroScheduler();
  intro.begin();
  while (intro.state !== INTRO_STATES.AWAIT_LAUNCH) intro.step(50, true);
  assert.equal(intro.tryLaunch(true), 'launch');
  // Next round: full countdown again, launch available again.
  intro.begin();
  assert.equal(intro.state, INTRO_STATES.HOLD);
  assert.equal(intro.remainingSeconds, 4);
  assert.equal(intro.progress, 0);
  while (intro.state === INTRO_STATES.HOLD) intro.step(16, true);
  assert.equal(intro.settle(), 'settled');
  assert.equal(intro.tryLaunch(true), 'launch');
});

test('INTRO: hold progress drives the countdown bar', () => {
  const intro = new RoundIntroScheduler();
  intro.begin();
  assert.equal(intro.progress, 0);
  while (intro.state === INTRO_STATES.HOLD) intro.step(16, true);
  assert.equal(intro.progress, 1);
});

test('INTRO: reduced-motion configuration skips the flight delay', () => {
  const intro = new RoundIntroScheduler({ flightMs: 0 });
  intro.begin();
  while (intro.state === INTRO_STATES.HOLD) intro.step(50, true);
  assert.equal(intro.step(0, true), 'settled');
  assert.equal(intro.tryLaunch(true), 'launch');
});

test('INTRO: defaults match the specified presentation timings', () => {
  assert.equal(INTRO_HOLD_MS, 4000);
  assert.equal(INTRO_FLIGHT_MS, 520);
  const intro = new RoundIntroScheduler();
  assert.equal(intro.holdMs, INTRO_HOLD_MS);
  assert.equal(intro.flightMs, INTRO_FLIGHT_MS);
});
