import {
  DAYS_PER_MONTH,
  DAYS_PER_WEEK,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
} from './constants.js';
import type { ModelUsage } from './model-usage.js';
import type { Provider } from './provider.js';
import type { ProviderStore, QuotaPeriodRow } from './store.js';
import { weekEndIso, weekStartKey } from './time-utils.js';
import type { UsageWindow } from './usage-window.js';

// 1 day: absorbs ±~1h jitter from "Resets in Xd Yh" parsing, but never bridges
// weekly (7d) or monthly (30d) periods.
const PERIOD_MATCH_TOLERANCE_MS = MS_PER_DAY;
// Default cadence: at most one sample per hour per period. Near reset the
// cadence tightens — see minSampleIntervalMs for why.
const SAMPLE_MIN_INTERVAL_MS = MS_PER_HOUR;
// Length of the final stretch before reset that gets dense sampling.
const NEAR_RESET_WINDOW_MS = 6 * MS_PER_HOUR;
// Sampling interval inside the near-reset window.
const NEAR_RESET_INTERVAL_MS = 5 * MS_PER_MINUTE;
// Percent ceiling — 100% remaining means the quota is fully unused.
const PERCENT_MAX = 100;

const WEEKLY_WINDOW_MS = DAYS_PER_WEEK * MS_PER_DAY;
const MONTHLY_WINDOW_MS = DAYS_PER_MONTH * MS_PER_DAY;

interface TrackedQuota {
  label: string;
  windowMs: number;
  kind: 'reset' | 'iso-week';
}

/** Tracked provider ids mapped to their quota window configuration. */
export const TRACKED_QUOTA: Record<string, TrackedQuota> = {
  // Monthly reset windows (billing-period anchored).
  'opencode-go': { label: 'monthly', windowMs: MONTHLY_WINDOW_MS, kind: 'reset' },
  'opencode-go-2': { label: 'monthly', windowMs: MONTHLY_WINDOW_MS, kind: 'reset' },
  commandcode: { label: 'monthly', windowMs: MONTHLY_WINDOW_MS, kind: 'reset' },
  // Weekly windows.
  'ollama-cloud': { label: 'weekly', windowMs: WEEKLY_WINDOW_MS, kind: 'reset' },
  codex: { label: 'weekly', windowMs: WEEKLY_WINDOW_MS, kind: 'iso-week' },
  zai: { label: 'weekly', windowMs: WEEKLY_WINDOW_MS, kind: 'reset' },
  'alibaba-qwen': { label: 'weekly', windowMs: WEEKLY_WINDOW_MS, kind: 'reset' },
};

interface QuotaSample {
  providerId: string;
  resetAt: string;
  usedPercent: number | null;
  remainingPercent: number | null;
}

/** Extract the tracked period-limit window for a provider, or null. */
export function extractQuotaSample(provider: Provider): QuotaSample | null {
  const label = TRACKED_QUOTA[provider.id]?.label;

  if (!label) {
    return null;
  }

  for (const model of provider.models) {
    const sample = sampleFromModel(provider.id, label, model);

    if (sample) {
      return sample;
    }
  }

  return null;
}

/** Find the matching tracked window within a single model. */
function sampleFromModel(providerId: string, label: string, model: ModelUsage): QuotaSample | null {
  for (const window of model.windows) {
    if (window.label !== label) {
      continue;
    }

    if (!window.resetAt) {
      return null;
    }

    const remaining = computeRemaining(window);

    if (remaining == null) {
      return null;
    }

    return {
      providerId,
      resetAt: window.resetAt,
      usedPercent: window.usedPercent,
      remainingPercent: remaining,
    };
  }

  return null;
}

/** Derive remaining percent, falling back to (100 - used) when not provided. */
function computeRemaining(window: UsageWindow): number | null {
  if (window.remainingPercent != null) {
    return window.remainingPercent;
  }

  if (window.usedPercent != null) {
    return PERCENT_MAX - window.usedPercent;
  }

  return null;
}

/** Stable UTC date key (YYYY-MM-DD) for a reset timestamp. */
export function periodKeyFromResetAt(resetAt: string): string {
  return new Date(resetAt).toISOString().slice(0, 10);
}

/**
 * Compute the ISO start timestamp for a stored period. For iso-week providers
 * the start is the Monday at 00:00 UTC (encoded in periodKey). For reset
 * providers the start is resetAt minus the window duration. Unknown providers
 * fall back to resetAt minus one week.
 */
export function periodStartIso(providerId: string, periodKey: string, resetAt: string): string {
  const config = TRACKED_QUOTA[providerId];

  if (config?.kind === 'iso-week') {
    return `${periodKey}T00:00:00.000Z`;
  }

  const windowMs = config?.windowMs ?? WEEKLY_WINDOW_MS;

  return new Date(Date.parse(resetAt) - windowMs).toISOString();
}

function withinTolerance(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);

  if (Number.isFinite(ta) && Number.isFinite(tb)) {
    return Math.abs(ta - tb) <= PERIOD_MATCH_TOLERANCE_MS;
  }

  return false;
}

/**
 * Adaptive sampling throttle. Percent-used grows monotonically within a
 * period, so a flat hourly cap can skip the final burn-down before reset and
 * the stored history then overstates what remained. Sampling densely inside
 * the last NEAR_RESET_WINDOW_MS bounds that error to ~NEAR_RESET_INTERVAL_MS.
 */
export function minSampleIntervalMs(resetAt: string, now: number): number {
  const msToReset = Date.parse(resetAt) - now;
  const isNearReset =
    Number.isFinite(msToReset) && msToReset >= 0 && msToReset <= NEAR_RESET_WINDOW_MS;

  return isNearReset ? NEAR_RESET_INTERVAL_MS : SAMPLE_MIN_INTERVAL_MS;
}

export class QuotaTracker {
  constructor(private readonly store: ProviderStore) {}

  /** Record a fresh provider snapshot into the current period row (throttled, dense near reset). */
  record(provider: Provider): void {
    const sample = extractQuotaSample(provider);

    if (!sample) {
      return;
    }

    const config = TRACKED_QUOTA[sample.providerId];

    if (!config) {
      return;
    }

    const now = Date.now();

    if (config.kind === 'iso-week') {
      this.recordIsoWeek(sample, now);
      return;
    }

    this.recordReset(sample, now);
  }

  /** Reset-anchored path: stable reset timestamps keyed by reset date (±1d tolerance). */
  private recordReset(sample: QuotaSample, now: number): void {
    const latest = this.store.getLatestQuotaPeriod(sample.providerId);
    const isSamePeriod = latest != null && withinTolerance(latest.resetAt, sample.resetAt);

    // Throttle existing periods using the stored reset; new periods always get a first sample.
    if (isSamePeriod && now - latest.lastSampledAt < minSampleIntervalMs(latest.resetAt, now)) {
      return;
    }

    const periodKey = isSamePeriod ? latest.periodKey : periodKeyFromResetAt(sample.resetAt);

    this.store.upsertQuotaSample(
      sample.providerId,
      periodKey,
      sample.resetAt,
      sample.usedPercent,
      sample.remainingPercent,
      now,
    );
  }

  /**
   * ISO-week path for rolling-window providers (codex). The API returns
   * reset_at = now + reset_after_seconds, which drifts on every fetch. Keying
   * by the drifting reset date (even with ±1d tolerance) creates spurious period
   * rows. Instead, bucket by calendar ISO week: the period key is the Monday
   * that starts the current week, and the reset timestamp is the next Monday
   * 00:00 UTC — both derived from the current wall-clock time, ignoring the
   * sample's own drifting resetAt.
   */
  private recordIsoWeek(sample: QuotaSample, now: number): void {
    const current = new Date(now);
    const periodKey = weekStartKey(current);
    const resetAt = weekEndIso(current);
    const latest = this.store.getLatestQuotaPeriod(sample.providerId);

    // Throttle existing weeks; new weeks always get a first sample.
    if (
      latest?.periodKey === periodKey &&
      now - latest.lastSampledAt < minSampleIntervalMs(resetAt, now)
    ) {
      return;
    }

    this.store.upsertQuotaSample(
      sample.providerId,
      periodKey,
      resetAt,
      sample.usedPercent,
      sample.remainingPercent,
      now,
    );
  }

  /** All stored period rows (raw, unordered). */
  periods(): QuotaPeriodRow[] {
    return this.store.getQuotaPeriods();
  }
}
