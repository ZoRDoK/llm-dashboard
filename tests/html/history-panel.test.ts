import { describe, expect, it, vi } from 'vitest';
import { renderHistoryPanel } from '../../src/html/history-panel.js';
import type { QuotaPeriod } from '../../src/types.js';

// ── Constants ─────────────────────────────────────────────────

const REMAINING_HIGH = 70;
const REMAINING_LOW = 15;
const FUTURE_RESET_AT = '2026-07-19T00:00:00.000Z';
const PAST_RESET_AT = '2026-06-19T00:00:00.000Z';
const STARTED_AT = '2026-07-12T00:00:00.000Z';
const BASE_NOW = 1_750_000_000_000;
const SAMPLE_COUNT = 5;
const ONE_HOUR_MS = 3_600_000;
const ONE_MINUTE_MS = 60_000;
const FIRST_SAMPLED = BASE_NOW - ONE_HOUR_MS;
const LAST_SAMPLED = BASE_NOW - ONE_MINUTE_MS;
const USED_PCT = 30;

// ── Helpers ─────────────────────────────────────────────────

function makePeriod(overrides: Partial<QuotaPeriod> = {}): QuotaPeriod {
  return {
    providerId: 'codex',
    providerName: 'OpenAI Codex',
    periodKey: '2026-07-19',
    resetAt: FUTURE_RESET_AT,
    startedAt: STARTED_AT,
    usedPercent: USED_PCT,
    remainingPercent: REMAINING_HIGH,
    firstSampledAt: FIRST_SAMPLED,
    lastSampledAt: LAST_SAMPLED,
    sampleCount: SAMPLE_COUNT,
    completed: false,
    ...overrides,
  };
}

describe('renderHistoryPanel', () => {
  it('renders the empty message when no periods exist', () => {
    const html = renderHistoryPanel([]);

    expect(html).toContain('No quota history yet');
  });

  it('renders provider name and cadence label', () => {
    const html = renderHistoryPanel([makePeriod()]);

    expect(html).toContain('OpenAI Codex');
    expect(html).toContain('weekly');
  });

  it('renders the calendar Mon–Mon UTC subtitle for iso-week providers', () => {
    const html = renderHistoryPanel([makePeriod()]);

    expect(html).toContain('calendar Mon–Mon UTC');
  });

  it('shows the current badge for a non-completed period', () => {
    const html = renderHistoryPanel([makePeriod({ completed: false })]);

    expect(html).toContain('current');
    expect(html).not.toContain('burned');
  });

  it('shows the burned badge for a completed period', () => {
    const html = renderHistoryPanel([makePeriod({ completed: true, resetAt: PAST_RESET_AT })]);

    expect(html).toContain('burned');
  });

  it('renders the date range with a → arrow between start and end', () => {
    const html = renderHistoryPanel([makePeriod()]);

    expect(html).toContain('→');
  });

  it('renders the exact UTC reset time on each history row', () => {
    const html = renderHistoryPanel([makePeriod({ resetAt: '2026-07-19T09:30:00.000Z' })]);

    expect(html).toContain('reset Jul 19, 09:30 UTC');
  });

  it('renders midnight UTC resets as 00:00 without hour rollover', () => {
    const html = renderHistoryPanel([makePeriod({ resetAt: '2026-07-19T00:00:00.000Z' })]);

    expect(html).toContain('reset Jul 19, 00:00 UTC');
    expect(html).not.toContain('24:00');
  });

  it('renders the reset time for a future weekly Alibaba Qwen period', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:00:00.000Z'));

    try {
      const html = renderHistoryPanel([
        makePeriod({
          providerId: 'alibaba-qwen',
          providerName: 'Alibaba Qwen',
          periodKey: '2026-07-21',
          resetAt: '2026-07-21T16:45:00.000Z',
          startedAt: '2026-07-14T16:45:00.000Z',
        }),
      ]);

      expect(html).toContain('Alibaba Qwen');
      expect(html).toContain('reset Jul 21, 16:45 UTC');
      expect(html).toContain('in 7d');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the reset time on completed rows too', () => {
    const html = renderHistoryPanel([
      makePeriod({ completed: true, resetAt: '2026-06-19T08:00:00.000Z' }),
    ]);

    expect(html).toContain('reset Jun 19, 08:00 UTC');
  });

  it('renders the used and left percentage labels', () => {
    const html = renderHistoryPanel([makePeriod({ usedPercent: USED_PCT })]);

    expect(html).toContain('used');
    expect(html).toContain('left');
    expect(html).toContain(`${USED_PCT.toFixed(1)}%`);
    expect(html).toContain(`${REMAINING_HIGH.toFixed(1)}%`);
  });

  it('formats the remaining percentage to one decimal with a percent sign', () => {
    const html = renderHistoryPanel([makePeriod({ remainingPercent: REMAINING_HIGH })]);

    expect(html).toContain(`${REMAINING_HIGH.toFixed(1)}%`);
  });

  it('derives used from 100 minus remaining when usedPercent is null', () => {
    const html = renderHistoryPanel([
      makePeriod({ usedPercent: null, remainingPercent: REMAINING_HIGH }),
    ]);

    // 100 - 70 = 30
    expect(html).toContain(`${USED_PCT.toFixed(1)}% used`);
  });

  it('renders an em dash for a null remaining percentage', () => {
    const html = renderHistoryPanel([makePeriod({ remainingPercent: null, usedPercent: null })]);

    expect(html).toContain('—');
  });

  it('renders multiple periods grouped by provider', () => {
    const periods: QuotaPeriod[] = [
      makePeriod({ providerId: 'codex', providerName: 'OpenAI Codex' }),
      makePeriod({
        providerId: 'ollama-cloud',
        providerName: 'Ollama Cloud',
        completed: true,
        resetAt: PAST_RESET_AT,
        startedAt: '2026-06-12T00:00:00.000Z',
        remainingPercent: REMAINING_LOW,
      }),
    ];

    const html = renderHistoryPanel(periods);

    expect(html).toContain('OpenAI Codex');
    expect(html).toContain('Ollama Cloud');
    expect(html).toContain(`${REMAINING_LOW.toFixed(1)}%`);
  });
});
