import { describe, expect, it } from 'vitest';
import { goWindowsFromStatus } from '../../src/adapters/opencode-go.js';

// Live `/go/status` sample (2026-09-22): meters hold string microcents,
// `month` has no reset timestamps.
const STATUS_SAMPLE = {
  subscriberUserId: 'acc_1',
  renewalCurrency: 'usd',
  useBalance: false,
  cancelAtPeriodEnd: false,
  access: {
    startsAt: '2026-09-02T08:33:23.000Z',
    endsAt: '2026-10-02T08:33:23.000Z',
    cancelAtPeriodEnd: false,
    meters: {
      fiveHour: {
        startsAt: '2026-09-21T17:50:04.826Z',
        resetsAt: '2026-09-21T22:50:04.826Z',
        limitMicroCents: '1200000000',
        usedMicroCents: '27605866',
      },
      week: {
        startsAt: '2026-09-21T00:00:00.000Z',
        resetsAt: '2026-09-28T00:00:00.000Z',
        limitMicroCents: '3000000000',
        usedMicroCents: '70116641',
      },
      month: {
        limitMicroCents: '6000000000',
        usedMicroCents: '3698381418',
      },
    },
  },
};

const WINDOW_COUNT = 3;
const FIVE_HOUR_PERCENT = 2.3;
const WEEK_PERCENT = 2.3;
const MONTH_PERCENT = 61.6;

describe('goWindowsFromStatus', () => {
  it('builds the three meter windows with their labels and percents', () => {
    const windows = goWindowsFromStatus(STATUS_SAMPLE);

    expect(windows).toHaveLength(WINDOW_COUNT);
    expect(windows.map((window) => window.label)).toEqual(['5h', 'weekly', 'monthly']);
    expect(windows.map((window) => window.usedPercent)).toEqual([
      FIVE_HOUR_PERCENT,
      WEEK_PERCENT,
      MONTH_PERCENT,
    ]);
  });

  it('passes the meter resetAt through and leaves the month reset null', () => {
    const windows = goWindowsFromStatus(STATUS_SAMPLE);

    expect(windows.map((window) => window.resetAt)).toEqual([
      '2026-09-21T22:50:04.826Z',
      '2026-09-28T00:00:00.000Z',
      null,
    ]);
  });

  it('formats the value label as dollars used of the dollar limit', () => {
    const windows = goWindowsFromStatus(STATUS_SAMPLE);

    expect(windows.map((window) => window.valueLabel)).toEqual([
      '$0.28 of $12.00',
      '$0.70 of $30.00',
      '$36.98 of $60.00',
    ]);
  });

  it('throws on a payload without meters', () => {
    expect(() => goWindowsFromStatus({ access: {} })).toThrow();
  });

  it('throws when a microcent field is missing', () => {
    const broken = {
      access: {
        meters: {
          fiveHour: { limitMicroCents: '1', usedMicroCents: '1' },
          week: { limitMicroCents: '1', usedMicroCents: '1' },
          month: { usedMicroCents: '1' },
        },
      },
    };

    expect(() => goWindowsFromStatus(broken)).toThrow();
  });
});
