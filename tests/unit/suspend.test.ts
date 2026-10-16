import { describe, expect, it } from 'vitest';
import { SuspendTracker } from '../../src/suspend.js';

const WALL_START = 1_750_000_000_000;
const MONO_START = 500;
const MINUTE_MS = 60_000;
// 20h — the shape of an overnight lid-close suspend.
const SUSPEND_MS = 72_000_000;
const DRIFT_NOISE_MS = 5_000;
const ACTIVE_MINUTES = 10;

interface Clocks {
  wall: () => number;
  mono: () => number;
  advance: (wallMs: number, monoMs: number) => void;
}

/** Mutable clock cursors: advance() moves wall and mono independently. */
function makeClocks(): Clocks {
  let wall = WALL_START;
  let mono = MONO_START;

  return {
    wall: () => wall,
    mono: () => mono,
    advance: (wallMs, monoMs) => {
      wall += wallMs;
      mono += monoMs;
    },
  };
}

describe('SuspendTracker', () => {
  it('reports zero when wall and monotonic clocks advance together', () => {
    const clocks = makeClocks();
    const tracker = new SuspendTracker(clocks.wall, clocks.mono);

    tracker.sample();
    clocks.advance(ACTIVE_MINUTES * MINUTE_MS, ACTIVE_MINUTES * MINUTE_MS);
    tracker.sample();

    expect(tracker.suspendedSince(WALL_START)).toBe(0);
  });

  it('counts a wall-vs-mono gap beyond the slack as suspend time', () => {
    const clocks = makeClocks();
    const tracker = new SuspendTracker(clocks.wall, clocks.mono);

    tracker.sample();
    // The wall clock runs 20h while the monotonic clock moves one minute —
    // the shape of a lid-close suspend.
    clocks.advance(SUSPEND_MS + MINUTE_MS, MINUTE_MS);
    tracker.sample();

    expect(tracker.suspendedSince(WALL_START)).toBe(SUSPEND_MS);
  });

  it('ignores small drift below the slack threshold', () => {
    const clocks = makeClocks();
    const tracker = new SuspendTracker(clocks.wall, clocks.mono);

    tracker.sample();
    clocks.advance(MINUTE_MS + DRIFT_NOISE_MS, MINUTE_MS);
    tracker.sample();

    expect(tracker.suspendedSince(WALL_START)).toBe(0);
  });

  it('excludes suspends that completed before the queried stamp', () => {
    const clocks = makeClocks();
    const tracker = new SuspendTracker(clocks.wall, clocks.mono);

    tracker.sample();
    clocks.advance(SUSPEND_MS + MINUTE_MS, MINUTE_MS);
    tracker.sample();

    const afterFirstSuspend = clocks.wall();

    clocks.advance(SUSPEND_MS + MINUTE_MS, MINUTE_MS);
    tracker.sample();

    expect(tracker.suspendedSince(afterFirstSuspend)).toBe(SUSPEND_MS);
  });

  it('accumulates suspend time across multiple gaps', () => {
    const clocks = makeClocks();
    const tracker = new SuspendTracker(clocks.wall, clocks.mono);

    tracker.sample();
    clocks.advance(SUSPEND_MS + MINUTE_MS, MINUTE_MS);
    tracker.sample();
    clocks.advance(SUSPEND_MS + MINUTE_MS, MINUTE_MS);
    tracker.sample();

    const TWO_SUSPENDS_MS = 144_000_000;

    expect(tracker.suspendedSince(WALL_START)).toBe(TWO_SUSPENDS_MS);
  });

  it('samples the real clocks when constructed without injected ones', () => {
    // Regression for the default-parameter bug: a bare performance.now
    // default threw ERR_INVALID_THIS on the first sample().
    const tracker = new SuspendTracker();

    expect(() => {
      tracker.sample();
      tracker.sample();
    }).not.toThrow();

    expect(tracker.suspendedSince(Date.now())).toBe(0);
  });

  it('reports zero before any sample was taken', () => {
    const clocks = makeClocks();
    const tracker = new SuspendTracker(clocks.wall, clocks.mono);

    expect(tracker.suspendedSince(WALL_START)).toBe(0);
  });
});
