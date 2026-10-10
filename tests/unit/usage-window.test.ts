import { describe, expect, it } from 'vitest';
import { UsageWindow } from '../../src/usage-window.js';

// ── Test constants ──────────────────────────────────────────
const LABEL = 'daily';
const USED_PERCENT_50 = 50;
const REMAINING_50 = 50;
const USED_PERCENT_0 = 0;
const REMAINING_100 = 100;
const RESET_AT = '2025-01-01T00:00:00.000Z';
const USED_COUNT_30 = 30;
const TOTAL_COUNT_100 = 100;
const EXPECTED_PERCENT_30 = 30;
const EXPECTED_REMAINING_70 = 70;
const SPEND_10 = 10;

// Validation test constants
const PERCENT_OVER_100 = 150;
const PERCENT_OVER_100_API = 101;
const TOTAL_ZERO = 0;
const USED_NEGATIVE = -1;
const USED_OVER_TOTAL = 200;
const TOTAL_FOR_USED_OVER = 100;

// ── Validation ──────────────────────────────────────────────

describe('UsageWindow validation', () => {
  it('rejects negative percent in fromSection', () => {
    expect(() => UsageWindow.fromSection(LABEL, USED_NEGATIVE, null)).toThrow('must be 0..100');
  });

  it('rejects percent > 100 in fromSection', () => {
    expect(() => UsageWindow.fromSection(LABEL, PERCENT_OVER_100, null)).toThrow('must be 0..100');
  });

  it('rejects non-finite percent in fromSection', () => {
    expect(() => UsageWindow.fromSection(LABEL, Number.NaN, null)).toThrow('not finite');
  });

  it('rejects negative percent in fromApi', () => {
    expect(() => UsageWindow.fromApi(LABEL, USED_NEGATIVE, RESET_AT)).toThrow('must be 0..100');
  });

  it('rejects percent > 100 in fromApi', () => {
    expect(() => UsageWindow.fromApi(LABEL, PERCENT_OVER_100_API, RESET_AT)).toThrow(
      'must be 0..100',
    );
  });

  it('allows null percent in fromApi', () => {
    const window = UsageWindow.fromApi(LABEL, null, RESET_AT);

    expect(window.usedPercent).toBeNull();
    expect(window.remainingPercent).toBeNull();
  });

  it('rejects negative used count in fromCounts', () => {
    expect(() => UsageWindow.fromCounts(LABEL, USED_NEGATIVE, TOTAL_COUNT_100, RESET_AT)).toThrow(
      'must be >= 0',
    );
  });

  it('rejects non-positive total count in fromCounts', () => {
    expect(() => UsageWindow.fromCounts(LABEL, 0, TOTAL_ZERO, RESET_AT)).toThrow('must be > 0');
  });

  it('rejects used > total in fromCounts', () => {
    expect(() =>
      UsageWindow.fromCounts(LABEL, USED_OVER_TOTAL, TOTAL_FOR_USED_OVER, RESET_AT),
    ).toThrow('exceeds total');
  });

  it('rejects non-finite counts in fromCounts', () => {
    expect(() => UsageWindow.fromCounts(LABEL, Number.NaN, TOTAL_COUNT_100, RESET_AT)).toThrow(
      'must be finite',
    );
  });
});

describe('UsageWindow.fromSection', () => {
  it('sets remaining to 100 - usedPercent when resetText is null', () => {
    const window = UsageWindow.fromSection(LABEL, USED_PERCENT_50, null);

    expect(window.label).toBe(LABEL);
    expect(window.usedPercent).toBe(USED_PERCENT_50);
    expect(window.remainingPercent).toBe(REMAINING_50);
    expect(window.used).toBeNull();
    expect(window.total).toBeNull();
    expect(window.spend).toBeNull();
    expect(window.resetAt).toBeNull();
  });

  it('sets remaining to 100 when usedPercent is 0', () => {
    const window = UsageWindow.fromSection(LABEL, USED_PERCENT_0, '5h');

    expect(window.remainingPercent).toBe(REMAINING_100);
    expect(window.resetAt).not.toBeNull();
  });
});

// ── fromApi ─────────────────────────────────────────────────

describe('UsageWindow.fromApi', () => {
  it('populates all fields from API data', () => {
    const window = UsageWindow.fromApi(LABEL, USED_PERCENT_50, RESET_AT, SPEND_10, 'USD');

    expect(window.label).toBe(LABEL);
    expect(window.usedPercent).toBe(USED_PERCENT_50);
    expect(window.remainingPercent).toBe(REMAINING_50);
    expect(window.used).toBeNull();
    expect(window.total).toBeNull();
    expect(window.spend).toBe(SPEND_10);
    expect(window.resetAt).toBe(RESET_AT);
    expect(window.valueLabel).toBe('USD');
  });

  it('sets remaining to null when usedPercent is null', () => {
    const window = UsageWindow.fromApi(LABEL, null, RESET_AT);

    expect(window.usedPercent).toBeNull();
    expect(window.remainingPercent).toBeNull();
  });
});

// ── fromCounts ──────────────────────────────────────────────

describe('UsageWindow.fromCounts', () => {
  it('calculates percent and remaining from used and total', () => {
    const window = UsageWindow.fromCounts(LABEL, USED_COUNT_30, TOTAL_COUNT_100, RESET_AT);

    expect(window.label).toBe(LABEL);
    expect(window.usedPercent).toBe(EXPECTED_PERCENT_30);
    expect(window.remainingPercent).toBe(EXPECTED_REMAINING_70);
    expect(window.used).toBe(USED_COUNT_30);
    expect(window.total).toBe(TOTAL_COUNT_100);
    expect(window.spend).toBeNull();
    expect(window.resetAt).toBe(RESET_AT);
  });
});
