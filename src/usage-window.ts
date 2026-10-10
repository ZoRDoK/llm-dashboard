import { parseResetIn } from './time-utils.js';

const PERCENT_MAX = 100;

function validatePercent(value: number, context: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`UsageWindow: invalid percentile ${context} — not finite: ${value}`);
  }

  if (value < 0 || value > PERCENT_MAX) {
    throw new Error(
      `UsageWindow: invalid percent for ${context} — must be 0..${PERCENT_MAX}, got: ${value}`,
    );
  }
}

function validateCounts(used: number, total: number): void {
  if (!(Number.isFinite(used) && Number.isFinite(total))) {
    throw new Error(
      `UsageWindow: invalid counts — must be finite, got used=${used} total=${total}`,
    );
  }

  if (used < 0) {
    throw new Error(`UsageWindow: invalid used count — must be >= 0, got: ${used}`);
  }

  if (total <= 0) {
    throw new Error(`UsageWindow: invalid total count — must be > 0, got: ${total}`);
  }

  if (used > total) {
    throw new Error(`UsageWindow: used (${used}) exceeds total (${total})`);
  }
}

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
    validatePercent(usedPercent, `${label} fromSection`);

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
    if (usedPercent != null) {
      validatePercent(usedPercent, `${label} fromApi`);
    }

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
    valueLabel?: string | null,
  ): UsageWindow {
    validateCounts(used, total);

    const usedPct = Math.round((used / total) * PERCENT_MAX * 10) / 10;
    const remainingPct = Math.round((PERCENT_MAX - usedPct) * 10) / 10;

    return new UsageWindow(
      label,
      usedPct,
      remainingPct,
      used,
      total,
      null,
      resetAt,
      valueLabel ?? null,
    );
  }
}
