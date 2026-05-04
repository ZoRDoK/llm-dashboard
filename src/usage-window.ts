import { parseResetIn } from './time-utils';

const PERCENT_MAX = 100;

export class UsageWindow {
  private constructor(
    readonly label: string,
    readonly usedPercent: number | null,
    readonly remainingPercent: number | null,
    readonly used: number | null,
    readonly total: number | null,
    readonly spend: number | null,
    readonly resetAt: string | null,
    readonly valueLabel: string | null,
  ) {}

  /** Create from scraped section data (HTML parsing). */
  static fromSection(label: string, usedPercent: number, resetText: string | null): UsageWindow {
    const remaining = Math.round((PERCENT_MAX - usedPercent) * 10) / 10;

    return new UsageWindow(
      label,
      usedPercent,
      remaining,
      null,
      null,
      null,
      parseResetIn(resetText),
      null,
    );
  }

  /** Create from API response (codex). */
  static fromApi(
    label: string,
    usedPercent: number | null,
    resetAt: string | null,
    spend?: number | null,
    valueLabel?: string | null,
  ): UsageWindow {
    const remaining =
      usedPercent == null ? null : Math.round((PERCENT_MAX - usedPercent) * 10) / 10;

    return new UsageWindow(
      label,
      usedPercent,
      remaining,
      null,
      null,
      spend ?? null,
      resetAt,
      valueLabel ?? null,
    );
  }

  /** Create from raw used/total counts (minimax). */
  static fromCounts(
    label: string,
    used: number,
    total: number,
    resetAt: string | null,
  ): UsageWindow {
    const usedPct = Math.round((used / total) * PERCENT_MAX * 10) / 10;
    const remainingPct = Math.round((PERCENT_MAX - usedPct) * 10) / 10;

    return new UsageWindow(label, usedPct, remainingPct, used, total, null, resetAt, null);
  }
}
