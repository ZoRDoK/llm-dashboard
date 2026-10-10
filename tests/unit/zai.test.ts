import { describe, expect, it } from 'vitest';
import type { ZaiLimit } from '../../src/adapters/zai.js';
import { zaiUsedPercent } from '../../src/adapters/zai.js';

// Count field values used for non-null cases
const COUNT_VALUE_10 = 10;
const COUNT_VALUE_100 = 100;
const COUNT_VALUE_0 = 0;

type LimitFields = Pick<ZaiLimit, 'percentage' | 'currentValue' | 'usage' | 'total'>;

// Percentage normalization only reads these fields; `type` is required by the
// schema but does not affect the 5h rounding artifact.
const buildLimit = (fields: LimitFields): ZaiLimit => ({ type: 'TOKENS_LIMIT', ...fields });

describe('zaiUsedPercent 5h rounding artifact', () => {
  it('returns 0 for 5h with percentage 1 and count fields absent', () => {
    const limit = buildLimit({ percentage: 1, currentValue: null, usage: null, total: null });

    const result = zaiUsedPercent(limit, '5h');

    expect(result).toBe(0);
  });

  it('returns 0 for 5h with percentage 1 and count fields undefined', () => {
    const limit = buildLimit({
      percentage: 1,
      currentValue: undefined,
      usage: undefined,
      total: undefined,
    });

    const result = zaiUsedPercent(limit, '5h');

    expect(result).toBe(0);
  });

  it('returns 0 for 5h with percentage 1 and mixed null/undefined counts', () => {
    const limit = buildLimit({ percentage: 1, currentValue: null, usage: undefined, total: null });

    const result = zaiUsedPercent(limit, '5h');

    expect(result).toBe(0);
  });

  it('passes through 0 for 5h with percentage 0 and count fields absent', () => {
    const limit = buildLimit({ percentage: 0, currentValue: null, usage: null, total: null });

    const result = zaiUsedPercent(limit, '5h');

    expect(result).toBe(0);
  });

  it('returns 1 for 5h with percentage 1 and currentValue present', () => {
    const limit = buildLimit({
      percentage: 1,
      currentValue: COUNT_VALUE_10,
      usage: null,
      total: null,
    });

    const result = zaiUsedPercent(limit, '5h');

    expect(result).toBe(1);
  });

  it('returns 1 for 5h with percentage 1 and usage present', () => {
    const limit = buildLimit({
      percentage: 1,
      currentValue: null,
      usage: COUNT_VALUE_100,
      total: null,
    });

    const result = zaiUsedPercent(limit, '5h');

    expect(result).toBe(1);
  });

  it('returns 1 for 5h with percentage 1 and total present', () => {
    const limit = buildLimit({
      percentage: 1,
      currentValue: null,
      usage: null,
      total: COUNT_VALUE_100,
    });

    const result = zaiUsedPercent(limit, '5h');

    expect(result).toBe(1);
  });

  it('returns 1 for 5h with percentage 1 and currentValue 0', () => {
    const limit = buildLimit({
      percentage: 1,
      currentValue: COUNT_VALUE_0,
      usage: null,
      total: null,
    });

    const result = zaiUsedPercent(limit, '5h');

    expect(result).toBe(1);
  });

  it('returns 1 for weekly with percentage 1 and count fields absent', () => {
    const limit = buildLimit({ percentage: 1, currentValue: null, usage: null, total: null });

    const result = zaiUsedPercent(limit, 'weekly');

    expect(result).toBe(1);
  });

  it('returns 1 for tokens with percentage 1 and count fields absent', () => {
    const limit = buildLimit({ percentage: 1, currentValue: null, usage: null, total: null });

    const result = zaiUsedPercent(limit, 'tokens');

    expect(result).toBe(1);
  });

  it('returns 1 for non-5h label searches with percentage 1 and count fields absent', () => {
    const limit = buildLimit({ percentage: 1, currentValue: null, usage: null, total: null });

    const result = zaiUsedPercent(limit, 'searches');

    expect(result).toBe(1);
  });
});

describe('zaiUsedPercent', () => {
  it('returns 0 for 5h label with percentage 1 and missing currentValue/usage/total', () => {
    const limit: ZaiLimit = {
      type: 'TOKENS_LIMIT',
      unit: 3,
      number: 5,
      percentage: 1,
      currentValue: null,
      usage: null,
      total: null,
      nextResetTime: null,
    };
    const result = zaiUsedPercent(limit, '5h');

    expect(result).toBe(0);
  });

  it('returns 1 unchanged for weekly label with percentage 1 and missing counts', () => {
    const limit: ZaiLimit = {
      type: 'TOKENS_LIMIT',
      unit: 6,
      number: null,
      percentage: 1,
      currentValue: null,
      usage: null,
      total: null,
      nextResetTime: null,
    };
    const result = zaiUsedPercent(limit, 'weekly');

    expect(result).toBe(1);
  });

  it('returns null when percentage missing but valid counts are present', () => {
    const limit: ZaiLimit = {
      type: 'TOKENS_LIMIT',
      unit: 3,
      number: 5,
      percentage: null,
      currentValue: 50,
      usage: null,
      total: 200,
      nextResetTime: null,
    };
    const result = zaiUsedPercent(limit, '5h');

    expect(result).toBeNull();
  });
});
