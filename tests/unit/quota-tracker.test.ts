import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MS_PER_MINUTE } from '../../src/constants.js';
import { Provider } from '../../src/provider.js';
import {
  extractQuotaSample,
  minSampleIntervalMs,
  periodKeyFromResetAt,
  periodStartIso,
  QuotaTracker,
  TRACKED_QUOTA,
} from '../../src/quota-tracker.js';
import { ProviderStore } from '../../src/store.js';
import { UsageWindow } from '../../src/usage-window.js';

// ── Constants ─────────────────────────────────────────────────

const USED_PCT = 30;
const UPDATED_USED_PCT = 40;
const REMAINING_PCT = 70;
const UPDATED_REMAINING_PCT = 60;
const RESET_AT = '2026-07-19T00:00:00.000Z';
const PERIOD_KEY = '2026-07-19';

const RESET_AT_NEXT = '2026-07-26T00:00:00.000Z';

const BASE_NOW = 1_750_000_000_000;
const ONE_HOUR_MS = 3_600_000;
const JUST_UNDER_ONE_HOUR_MS = ONE_HOUR_MS - 1;
const OVER_ONE_HOUR_MS = ONE_HOUR_MS + 1;

// ── Near-reset dense sampling constants ────────────────────

const RESET_AT_TS = Date.parse(RESET_AT);
const THREE_HOURS_MS = 3 * ONE_HOUR_MS;
const SIX_HOURS_MS = 6 * ONE_HOUR_MS;
const SEVEN_HOURS_MS = 7 * ONE_HOUR_MS;
const EIGHT_HOURS_MS = 8 * ONE_HOUR_MS;
// Dense-cadence interval from src/quota-tracker.ts (5 minutes).
const NEAR_RESET_INTERVAL_MS = 5 * MS_PER_MINUTE;
// Well under the old hourly throttle, above the near-reset interval.
const DENSE_SAMPLE_GAP_MS = 10 * MS_PER_MINUTE;

// ── ISO-week constants (codex) ──────────────────────────────

// Monday 2026-07-20T12:00:00Z — a known Monday inside an ISO week.
const ISO_WEEK_NOW = 1_784_548_800_000;
const WEEK_START_KEY = '2026-07-20';
const WEEK_END_ISO = '2026-07-27T00:00:00.000Z';
// A drifting resetAt (Wednesday noon) — the tracker must ignore it for keying.
const DRIFTING_RESET_AT = '2026-07-22T06:00:00.000Z';
const WEEK_END_TS = 1_785_110_400_000;

// ── Helpers ─────────────────────────────────────────────────

function makeTrackedProvider(
  id: string,
  name: string,
  label: string,
  usedPercent: number,
  resetAt: string | null,
): Provider {
  const window = UsageWindow.fromApi(label, usedPercent, resetAt);
  const model = { modelName: 'pro', windows: [window] };

  return new Provider(id, name, 'pro', [model]);
}

describe('quota-tracker', () => {
  describe('extractQuotaSample', () => {
    it('returns the monthly window for an opencode-go provider', () => {
      const provider = makeTrackedProvider(
        'opencode-go',
        'OpenCode Go',
        'monthly',
        USED_PCT,
        RESET_AT,
      );

      const sample = extractQuotaSample(provider);

      expect(sample).not.toBeNull();
      expect(sample?.providerId).toBe('opencode-go');
      expect(sample?.resetAt).toBe(RESET_AT);
      expect(sample?.remainingPercent).toBe(REMAINING_PCT);
    });

    it('returns the weekly window for codex, ollama-cloud, and zai', () => {
      const codex = makeTrackedProvider('codex', 'OpenAI Codex', 'weekly', USED_PCT, RESET_AT);
      const ollama = makeTrackedProvider(
        'ollama-cloud',
        'Ollama Cloud',
        'weekly',
        USED_PCT,
        RESET_AT,
      );
      const zai = makeTrackedProvider('zai', 'Zai', 'weekly', USED_PCT, RESET_AT);

      expect(extractQuotaSample(codex)?.resetAt).toBe(RESET_AT);
      expect(extractQuotaSample(ollama)?.resetAt).toBe(RESET_AT);
      expect(extractQuotaSample(zai)?.resetAt).toBe(RESET_AT);
    });

    it('returns the monthly window for opencode-go-2 and commandcode', () => {
      const go2 = makeTrackedProvider(
        'opencode-go-2',
        'OpenCode Go 2',
        'monthly',
        USED_PCT,
        RESET_AT,
      );
      const commandcode = makeTrackedProvider(
        'commandcode',
        'Command Code',
        'monthly',
        USED_PCT,
        RESET_AT,
      );

      expect(extractQuotaSample(go2)?.providerId).toBe('opencode-go-2');
      expect(extractQuotaSample(go2)?.resetAt).toBe(RESET_AT);
      expect(extractQuotaSample(go2)?.remainingPercent).toBe(REMAINING_PCT);
      expect(extractQuotaSample(commandcode)?.providerId).toBe('commandcode');
      expect(extractQuotaSample(commandcode)?.resetAt).toBe(RESET_AT);
      expect(extractQuotaSample(commandcode)?.remainingPercent).toBe(REMAINING_PCT);
    });

    it('returns the weekly window for alibaba-qwen', () => {
      const qwen = makeTrackedProvider(
        'alibaba-qwen',
        'Alibaba Qwen',
        'weekly',
        USED_PCT,
        RESET_AT,
      );

      expect(extractQuotaSample(qwen)?.providerId).toBe('alibaba-qwen');
      expect(extractQuotaSample(qwen)?.resetAt).toBe(RESET_AT);
      expect(extractQuotaSample(qwen)?.remainingPercent).toBe(REMAINING_PCT);
    });

    it('returns null for a non-tracked provider id', () => {
      const provider = makeTrackedProvider('brave', 'Brave', 'daily', USED_PCT, RESET_AT);

      expect(extractQuotaSample(provider)).toBeNull();
    });

    it('returns null when the tracked window has no resetAt', () => {
      const provider = makeTrackedProvider('codex', 'OpenAI Codex', 'weekly', USED_PCT, null);

      expect(extractQuotaSample(provider)).toBeNull();
    });

    it('carries the remainingPercent derived from usedPercent via fromApi', () => {
      // fromApi computes remaining as (100 - used) automatically, so the sample
      // carries the derived remaining percent (30 used → 70 remaining).
      const provider = makeTrackedProvider('codex', 'OpenAI Codex', 'weekly', USED_PCT, RESET_AT);

      const sample = extractQuotaSample(provider);

      expect(sample?.remainingPercent).toBe(REMAINING_PCT);
    });

    it('TRACKED_QUOTA maps the seven live providers to their cadence labels and kinds', () => {
      // Monthly reset windows (billing-period anchored).
      expect(TRACKED_QUOTA['opencode-go']?.label).toBe('monthly');
      expect(TRACKED_QUOTA['opencode-go']?.kind).toBe('reset');
      expect(TRACKED_QUOTA['opencode-go-2']?.label).toBe('monthly');
      expect(TRACKED_QUOTA['opencode-go-2']?.kind).toBe('reset');
      expect(TRACKED_QUOTA.commandcode?.label).toBe('monthly');
      expect(TRACKED_QUOTA.commandcode?.kind).toBe('reset');
      // Weekly windows.
      expect(TRACKED_QUOTA['ollama-cloud']?.label).toBe('weekly');
      expect(TRACKED_QUOTA['ollama-cloud']?.kind).toBe('reset');
      expect(TRACKED_QUOTA.codex?.label).toBe('weekly');
      expect(TRACKED_QUOTA.codex?.kind).toBe('iso-week');
      expect(TRACKED_QUOTA.zai?.label).toBe('weekly');
      expect(TRACKED_QUOTA.zai?.kind).toBe('reset');
      expect(TRACKED_QUOTA['alibaba-qwen']?.label).toBe('weekly');
      expect(TRACKED_QUOTA['alibaba-qwen']?.kind).toBe('reset');
    });
  });

  describe('periodKeyFromResetAt', () => {
    it('returns the UTC date key (YYYY-MM-DD)', () => {
      expect(periodKeyFromResetAt('2026-07-19T00:30:00.000Z')).toBe('2026-07-19');
    });
  });

  describe('periodStartIso', () => {
    it('returns the periodKey as a midnight ISO timestamp for iso-week providers', () => {
      expect(periodStartIso('codex', WEEK_START_KEY, WEEK_END_ISO)).toBe(
        '2026-07-20T00:00:00.000Z',
      );
    });

    it('returns resetAt minus the weekly window for zai (reset kind)', () => {
      expect(periodStartIso('zai', PERIOD_KEY, RESET_AT_NEXT)).toBe('2026-07-19T00:00:00.000Z');
    });

    it('returns resetAt minus the monthly window for opencode-go', () => {
      expect(periodStartIso('opencode-go', '2026-07-19', '2026-08-18T00:00:00.000Z')).toBe(
        '2026-07-19T00:00:00.000Z',
      );
    });

    it('returns resetAt minus the monthly window for opencode-go-2', () => {
      expect(periodStartIso('opencode-go-2', '2026-07-19', '2026-08-18T00:00:00.000Z')).toBe(
        '2026-07-19T00:00:00.000Z',
      );
    });

    it('returns resetAt minus the monthly window for commandcode', () => {
      expect(periodStartIso('commandcode', '2026-07-19', '2026-08-18T00:00:00.000Z')).toBe(
        '2026-07-19T00:00:00.000Z',
      );
    });

    it('returns resetAt minus the weekly window for alibaba-qwen (reset kind)', () => {
      expect(periodStartIso('alibaba-qwen', PERIOD_KEY, RESET_AT_NEXT)).toBe(
        '2026-07-19T00:00:00.000Z',
      );
    });

    it('falls back to resetAt minus 7 days for an unknown provider', () => {
      expect(periodStartIso('unknown', PERIOD_KEY, RESET_AT_NEXT)).toBe('2026-07-19T00:00:00.000Z');
    });
  });

  describe('minSampleIntervalMs', () => {
    it('returns the dense interval inside the final 6h before reset', () => {
      const nearResetNow = RESET_AT_TS - THREE_HOURS_MS;

      expect(minSampleIntervalMs(RESET_AT, nearResetNow)).toBe(NEAR_RESET_INTERVAL_MS);
    });

    it('treats the exact 6h mark as near reset (inclusive boundary)', () => {
      const windowEdgeNow = RESET_AT_TS - SIX_HOURS_MS;

      expect(minSampleIntervalMs(RESET_AT, windowEdgeNow)).toBe(NEAR_RESET_INTERVAL_MS);
    });

    it('returns the hourly interval more than 6h before reset', () => {
      const farFromResetNow = RESET_AT_TS - SEVEN_HOURS_MS;

      expect(minSampleIntervalMs(RESET_AT, farFromResetNow)).toBe(ONE_HOUR_MS);
    });

    it('falls back to the hourly interval after reset (negative msToReset)', () => {
      const afterResetNow = RESET_AT_TS + ONE_HOUR_MS;

      expect(minSampleIntervalMs(RESET_AT, afterResetNow)).toBe(ONE_HOUR_MS);
    });
  });

  // ── Reset-anchored record (zai) ───────────────────────────

  describe('QuotaTracker.record — reset (zai)', () => {
    let store: ProviderStore;

    beforeEach(() => {
      store = new ProviderStore();
      store.init(':memory:');
      vi.useFakeTimers();
      vi.setSystemTime(BASE_NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
      store.close();
    });

    it('inserts a new period row on first sample', () => {
      const provider = makeTrackedProvider('zai', 'Zai', 'weekly', USED_PCT, RESET_AT);
      const tracker = new QuotaTracker(store);

      tracker.record(provider);

      const periods = store.getQuotaPeriods();

      expect(periods).toHaveLength(1);
      expect(periods[0].providerId).toBe('zai');
      expect(periods[0].remainingPercent).toBe(REMAINING_PCT);
      expect(periods[0].periodKey).toBe(PERIOD_KEY);
      expect(periods[0].sampleCount).toBe(1);
    });

    it('throttles a second sample within the same period and under one hour', () => {
      const provider = makeTrackedProvider('zai', 'Zai', 'weekly', USED_PCT, RESET_AT);
      const tracker = new QuotaTracker(store);

      tracker.record(provider);
      vi.setSystemTime(BASE_NOW + JUST_UNDER_ONE_HOUR_MS);
      tracker.record(provider);

      const latest = store.getLatestQuotaPeriod('zai');

      expect(latest?.sampleCount).toBe(1);
    });

    it('records a second sample minutes later inside the final 6h before reset', () => {
      const provider = makeTrackedProvider('zai', 'Zai', 'weekly', USED_PCT, RESET_AT);
      const tracker = new QuotaTracker(store);

      // 3h before reset — inside the dense near-reset window.
      vi.setSystemTime(RESET_AT_TS - THREE_HOURS_MS);
      tracker.record(provider);

      // Minutes later: far under the old hourly throttle, above the dense one.
      vi.setSystemTime(RESET_AT_TS - THREE_HOURS_MS + DENSE_SAMPLE_GAP_MS);
      const updated = makeTrackedProvider('zai', 'Zai', 'weekly', UPDATED_USED_PCT, RESET_AT);
      tracker.record(updated);

      const latest = store.getLatestQuotaPeriod('zai');

      expect(latest?.sampleCount).toBe(2);
      expect(latest?.remainingPercent).toBe(UPDATED_REMAINING_PCT);
    });

    it('still throttles a sub-hour second sample when more than 6h remain before reset', () => {
      const provider = makeTrackedProvider('zai', 'Zai', 'weekly', USED_PCT, RESET_AT);
      const tracker = new QuotaTracker(store);

      // 8h before reset; even after the sub-hour advance we stay outside the
      // 6h dense window, so the hourly throttle still applies.
      vi.setSystemTime(RESET_AT_TS - EIGHT_HOURS_MS);
      tracker.record(provider);

      vi.setSystemTime(RESET_AT_TS - EIGHT_HOURS_MS + JUST_UNDER_ONE_HOUR_MS);
      tracker.record(provider);

      const latest = store.getLatestQuotaPeriod('zai');

      expect(latest?.sampleCount).toBe(1);
    });

    it('updates the row when a second sample arrives over one hour later in the same period', () => {
      const provider = makeTrackedProvider('zai', 'Zai', 'weekly', USED_PCT, RESET_AT);
      const tracker = new QuotaTracker(store);

      tracker.record(provider);
      const first = store.getLatestQuotaPeriod('zai');
      const firstResetAt = first?.resetAt;
      const firstSampledAt = first?.firstSampledAt;

      vi.setSystemTime(BASE_NOW + OVER_ONE_HOUR_MS);
      const updated = makeTrackedProvider('zai', 'Zai', 'weekly', UPDATED_USED_PCT, RESET_AT);
      tracker.record(updated);

      const latest = store.getLatestQuotaPeriod('zai');

      expect(latest?.sampleCount).toBe(2);
      expect(latest?.remainingPercent).toBe(UPDATED_REMAINING_PCT);
      // reset_at and first_sampled_at preserved.
      expect(latest?.resetAt).toBe(firstResetAt);
      expect(latest?.firstSampledAt).toBe(firstSampledAt);
    });

    it.each([
      '2026-07-18T00:00:00.000Z',
      '2026-07-18T23:30:00.000Z',
      '2026-07-20T00:00:00.000Z',
    ])('keeps the stored period key when reset drifts within one day to %s', (resetAt) => {
      const provider = makeTrackedProvider('zai', 'Zai', 'weekly', USED_PCT, RESET_AT);
      const tracker = new QuotaTracker(store);

      tracker.record(provider);
      vi.setSystemTime(BASE_NOW + OVER_ONE_HOUR_MS);
      const updated = makeTrackedProvider('zai', 'Zai', 'weekly', UPDATED_USED_PCT, resetAt);
      tracker.record(updated);

      expect(store.getQuotaPeriods()).toEqual([
        {
          providerId: 'zai',
          periodKey: PERIOD_KEY,
          resetAt: RESET_AT,
          usedPercent: UPDATED_USED_PCT,
          remainingPercent: UPDATED_REMAINING_PCT,
          firstSampledAt: BASE_NOW,
          lastSampledAt: BASE_NOW + OVER_ONE_HOUR_MS,
          sampleCount: 2,
        },
      ]);
    });

    it.each([
      {
        cadence: 'hourly',
        firstSampleAt: RESET_AT_TS - SEVEN_HOURS_MS,
        driftedReset: '2026-07-18T23:00:00.000Z',
        sampleCount: 1,
      },
      {
        cadence: 'near-reset',
        firstSampleAt: RESET_AT_TS - THREE_HOURS_MS,
        driftedReset: '2026-07-19T07:00:00.000Z',
        sampleCount: 2,
      },
    ])('uses the stored reset time for $cadence sampling despite reset drift', ({
      firstSampleAt,
      driftedReset,
      sampleCount,
    }) => {
      const provider = makeTrackedProvider('zai', 'Zai', 'weekly', USED_PCT, RESET_AT);
      const tracker = new QuotaTracker(store);

      vi.setSystemTime(firstSampleAt);
      tracker.record(provider);
      vi.setSystemTime(firstSampleAt + DENSE_SAMPLE_GAP_MS);
      const updated = makeTrackedProvider('zai', 'Zai', 'weekly', UPDATED_USED_PCT, driftedReset);
      tracker.record(updated);

      expect(store.getLatestQuotaPeriod('zai')).toMatchObject({
        periodKey: PERIOD_KEY,
        resetAt: RESET_AT,
        sampleCount,
      });
    });

    it('creates a new period row when reset_at is more than a day from the latest', () => {
      const first = makeTrackedProvider('zai', 'Zai', 'weekly', USED_PCT, RESET_AT);
      const tracker = new QuotaTracker(store);

      tracker.record(first);

      const next = makeTrackedProvider('zai', 'Zai', 'weekly', USED_PCT, RESET_AT_NEXT);

      tracker.record(next);

      const periods = store.getQuotaPeriods();

      expect(periods).toHaveLength(2);
    });

    it('is a no-op for a non-tracked provider', () => {
      const provider = makeTrackedProvider('brave', 'Brave', 'daily', USED_PCT, RESET_AT);
      const tracker = new QuotaTracker(store);

      tracker.record(provider);

      expect(store.getQuotaPeriods()).toHaveLength(0);
    });

    it('is a no-op for a provider with empty models', () => {
      const provider = new Provider('zai', 'Zai', 'pro', []);
      const tracker = new QuotaTracker(store);

      tracker.record(provider);

      expect(store.getQuotaPeriods()).toHaveLength(0);
    });
  });

  // ── ISO-week record (codex) ───────────────────────────────

  describe('QuotaTracker.record — iso-week (codex)', () => {
    let store: ProviderStore;

    beforeEach(() => {
      store = new ProviderStore();
      store.init(':memory:');
      vi.useFakeTimers();
      vi.setSystemTime(ISO_WEEK_NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
      store.close();
    });

    it('creates a row keyed by the Monday of the current ISO week with computed week-end resetAt', () => {
      // The sample's drifting resetAt must be ignored — the period key is the
      // Monday and the resetAt is the next Monday 00:00 UTC.
      const provider = makeTrackedProvider(
        'codex',
        'OpenAI Codex',
        'weekly',
        USED_PCT,
        DRIFTING_RESET_AT,
      );
      const tracker = new QuotaTracker(store);

      tracker.record(provider);

      const periods = store.getQuotaPeriods();

      expect(periods).toHaveLength(1);
      expect(periods[0].periodKey).toBe(WEEK_START_KEY);
      expect(periods[0].resetAt).toBe(WEEK_END_ISO);
      expect(periods[0].sampleCount).toBe(1);
    });

    it('throttles a second sample within the same week and under one hour', () => {
      const provider = makeTrackedProvider(
        'codex',
        'OpenAI Codex',
        'weekly',
        USED_PCT,
        DRIFTING_RESET_AT,
      );
      const tracker = new QuotaTracker(store);

      tracker.record(provider);
      vi.setSystemTime(ISO_WEEK_NOW + JUST_UNDER_ONE_HOUR_MS);
      tracker.record(provider);

      const latest = store.getLatestQuotaPeriod('codex');

      expect(latest?.sampleCount).toBe(1);
    });

    it('records a second sample minutes later inside the final 6h of the week', () => {
      const provider = makeTrackedProvider(
        'codex',
        'OpenAI Codex',
        'weekly',
        USED_PCT,
        DRIFTING_RESET_AT,
      );
      const tracker = new QuotaTracker(store);

      // Sunday evening — 3h before the computed week end (next Monday 00:00 UTC).
      vi.setSystemTime(WEEK_END_TS - THREE_HOURS_MS);
      tracker.record(provider);

      vi.setSystemTime(WEEK_END_TS - THREE_HOURS_MS + DENSE_SAMPLE_GAP_MS);
      const updated = makeTrackedProvider(
        'codex',
        'OpenAI Codex',
        'weekly',
        UPDATED_USED_PCT,
        DRIFTING_RESET_AT,
      );
      tracker.record(updated);

      const latest = store.getLatestQuotaPeriod('codex');

      expect(latest?.sampleCount).toBe(2);
      expect(latest?.remainingPercent).toBe(UPDATED_REMAINING_PCT);
    });

    it('increments sampleCount when a second sample arrives over one hour later in the same week', () => {
      const provider = makeTrackedProvider(
        'codex',
        'OpenAI Codex',
        'weekly',
        USED_PCT,
        DRIFTING_RESET_AT,
      );
      const tracker = new QuotaTracker(store);

      tracker.record(provider);
      const first = store.getLatestQuotaPeriod('codex');
      const firstResetAt = first?.resetAt;
      const firstSampledAt = first?.firstSampledAt;

      vi.setSystemTime(ISO_WEEK_NOW + OVER_ONE_HOUR_MS);
      const updated = makeTrackedProvider(
        'codex',
        'OpenAI Codex',
        'weekly',
        UPDATED_USED_PCT,
        DRIFTING_RESET_AT,
      );
      tracker.record(updated);

      const latest = store.getLatestQuotaPeriod('codex');

      expect(latest?.sampleCount).toBe(2);
      expect(latest?.remainingPercent).toBe(UPDATED_REMAINING_PCT);
      // The week-end resetAt is preserved (same week), not the drifting sample resetAt.
      expect(latest?.resetAt).toBe(firstResetAt);
      expect(latest?.firstSampledAt).toBe(firstSampledAt);
    });

    it('creates a new row at the week boundary even inside the sampling interval', () => {
      const provider = makeTrackedProvider(
        'codex',
        'OpenAI Codex',
        'weekly',
        USED_PCT,
        DRIFTING_RESET_AT,
      );
      const tracker = new QuotaTracker(store);

      vi.setSystemTime(WEEK_END_TS - MS_PER_MINUTE);
      tracker.record(provider);

      // Only one minute later: a new week must bypass the five-minute throttle.
      vi.setSystemTime(WEEK_END_TS);
      tracker.record(provider);

      const periods = store.getQuotaPeriods();

      expect(periods).toHaveLength(2);
      // The second row is keyed by the new Monday.
      const latest = store.getLatestQuotaPeriod('codex');
      expect(latest?.periodKey).toBe('2026-07-27');
      expect(latest?.firstSampledAt).toBe(WEEK_END_TS);
      expect(latest?.sampleCount).toBe(1);
    });
  });
});
