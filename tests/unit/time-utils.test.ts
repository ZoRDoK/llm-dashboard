import { describe, expect, it } from 'vitest';
import {
  epochToIso,
  msToIso,
  parseResetIn,
  weekEndIso,
  weekStartKey,
} from '../../src/time-utils.js';

// ── Time constants (milliseconds) ───────────────────────────
// biome-ignore lint/style/noMagicNumbers: time offset constants composed from unit factors
const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1_000;
// biome-ignore lint/style/noMagicNumbers: time offset constants composed from unit factors
const THREE_HOURS_MS = 3 * 60 * 60 * 1_000;
// biome-ignore lint/style/noMagicNumbers: time offset constants composed from unit factors
const TEN_MINUTES_MS = 10 * 60 * 1_000;
// biome-ignore lint/style/noMagicNumbers: time offset constants composed from unit factors
const ONE_DAY_TWO_HOURS_MS = 1 * 24 * 60 * 60 * 1_000 + 2 * 60 * 60 * 1_000;
const TOLERANCE_MS = 10_000;
const UNIX_EPOCH_SECONDS = 0;
const YEAR_2021_EPOCH_SECONDS = 1_609_459_200;
const MS_PER_SECOND = 1_000;

// ── Helpers ─────────────────────────────────────────────────

function getApproxDiff(iso: string | null, msOffset: number): number {
  if (iso === null) {
    throw new Error('Expected ISO string but got null');
  }

  const parsed = new Date(iso).getTime();
  const expected = Date.now() + msOffset;

  return Math.abs(parsed - expected);
}

// ── parseResetIn ────────────────────────────────────────────

describe('parseResetIn', () => {
  it('returns null for null input', () => {
    expect(parseResetIn(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseResetIn('')).toBeNull();
  });

  it('returns an ISO timestamp roughly 5 days from now', () => {
    expect(getApproxDiff(parseResetIn('5 days'), FIVE_DAYS_MS)).toBeLessThan(TOLERANCE_MS);
  });

  it('returns an ISO timestamp roughly 3 hours from now', () => {
    expect(getApproxDiff(parseResetIn('3 hours'), THREE_HOURS_MS)).toBeLessThan(TOLERANCE_MS);
  });

  it('returns an ISO timestamp roughly 10 minutes from now', () => {
    expect(getApproxDiff(parseResetIn('10 minutes'), TEN_MINUTES_MS)).toBeLessThan(TOLERANCE_MS);
  });

  it('returns an ISO timestamp roughly 1 day 2 hours from now', () => {
    expect(getApproxDiff(parseResetIn('1 day 2 hours'), ONE_DAY_TWO_HOURS_MS)).toBeLessThan(
      TOLERANCE_MS,
    );
  });

  it('strips the "~" prefix and parses normally', () => {
    expect(getApproxDiff(parseResetIn('~5 days'), FIVE_DAYS_MS)).toBeLessThan(TOLERANCE_MS);
  });

  it('throws for unrecognized text', () => {
    expect(() => parseResetIn('abc')).toThrow();
  });
});

// ── epochToIso ──────────────────────────────────────────────

describe('epochToIso', () => {
  it('converts 0 to the Unix epoch ISO string', () => {
    expect(epochToIso(UNIX_EPOCH_SECONDS)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('converts a known epoch to the expected ISO string', () => {
    expect(epochToIso(YEAR_2021_EPOCH_SECONDS)).toBe('2021-01-01T00:00:00.000Z');
  });
});

// ── msToIso ─────────────────────────────────────────────────

describe('msToIso', () => {
  it('converts 0 ms to the Unix epoch ISO string', () => {
    expect(msToIso(UNIX_EPOCH_SECONDS)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('returns a valid ISO string for a non-zero millisecond value', () => {
    const year2021Ms = YEAR_2021_EPOCH_SECONDS * MS_PER_SECOND;
    const result = msToIso(year2021Ms);
    const parsed = new Date(result);

    // biome-ignore lint/style/noMagicNumbers: 2021 is the literal expected year
    expect(parsed.getUTCFullYear()).toBe(2021);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

// ── weekStartKey / weekEndIso ────────────────────────────────

describe('weekStartKey', () => {
  it('returns the Monday of the current ISO week for a Monday timestamp', () => {
    // 2026-07-20 is a Monday — the week starts on that date.
    const monday = new Date('2026-07-20T12:00:00.000Z');

    expect(weekStartKey(monday)).toBe('2026-07-20');
  });

  it('rolls back to the previous Monday for a Sunday timestamp', () => {
    // 2026-07-19 is a Sunday — belongs to the week starting 2026-07-13.
    const sunday = new Date('2026-07-19T12:00:00.000Z');

    expect(weekStartKey(sunday)).toBe('2026-07-13');
  });

  it('rolls back to Monday for a Saturday-night timestamp', () => {
    // 2026-07-25 is a Saturday night — belongs to the week starting 2026-07-20.
    const saturday = new Date('2026-07-25T23:30:00.000Z');

    expect(weekStartKey(saturday)).toBe('2026-07-20');
  });
});

describe('weekEndIso', () => {
  it('returns the next Monday 00:00 UTC for a Monday timestamp', () => {
    const monday = new Date('2026-07-20T12:00:00.000Z');

    expect(weekEndIso(monday)).toBe('2026-07-27T00:00:00.000Z');
  });

  it('returns the next Monday for a Sunday timestamp in the previous week', () => {
    const sunday = new Date('2026-07-19T12:00:00.000Z');

    expect(weekEndIso(sunday)).toBe('2026-07-20T00:00:00.000Z');
  });

  it('returns the next Monday for a Saturday-night timestamp', () => {
    const saturday = new Date('2026-07-25T23:30:00.000Z');

    expect(weekEndIso(saturday)).toBe('2026-07-27T00:00:00.000Z');
  });
});
