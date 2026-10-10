import { MS_PER_DAY, MS_PER_HOUR } from '../constants.js';
import { TRACKED_QUOTA } from '../quota-tracker.js';
import { formatElapsed } from '../time-utils.js';
import type { QuotaPeriod } from '../types.js';
import { emptyState, escapeHtml } from './usage-renderers.js';

// ── Thresholds ───────────────────────────────────────────────

// Remaining-percent coloring: a high unused value means the quota was wasted.
const HIGH_UNUSED = 50;
const LOW_UNUSED = 20;
const PERCENT_MAX = 100;

// ── Helpers ─────────────────────────────────────────────────

function unusedColorClass(remaining: number | null): string {
  if (remaining == null) {
    return 'text-theme-text-tertiary';
  }

  if (remaining >= HIGH_UNUSED) {
    return 'text-theme-danger';
  }

  if (remaining >= LOW_UNUSED) {
    return 'text-theme-warning';
  }

  return 'text-theme-success';
}

function formatPercent(value: number | null): string {
  if (value == null) {
    return '—';
  }

  return `${value.toFixed(1)}%`;
}

/** Derive used percent from used, falling back to (100 − remaining) when absent. */
function deriveUsedPercent(period: QuotaPeriod): number | null {
  if (period.usedPercent != null) {
    return period.usedPercent;
  }

  if (period.remainingPercent != null) {
    return PERCENT_MAX - period.remainingPercent;
  }

  return null;
}

/** Format a date as "Jul 22", including the year only when it differs from now. */
function formatDay(iso: string): string {
  const date = new Date(iso);
  const currentYear = new Date().getUTCFullYear();
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };

  if (date.getUTCFullYear() !== currentYear) {
    opts.year = 'numeric';
  }

  return date.toLocaleDateString('en', opts);
}

/** Format a reset timestamp as "Jul 22, 14:30 UTC" — pinned to UTC, never local time. */
function formatResetUtc(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const opts: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  };

  return `${date.toLocaleString('en', opts)} UTC`;
}

/** Short "in Nd"/"in Nh" countdown to a future reset, or '' when not applicable. */
function countdownTo(resetAt: string): string {
  const remaining = Date.parse(resetAt) - Date.now();

  if (!Number.isFinite(remaining) || remaining <= 0) {
    return '';
  }

  if (remaining >= MS_PER_DAY) {
    return `in ${Math.ceil(remaining / MS_PER_DAY)}d`;
  }

  if (remaining >= MS_PER_HOUR) {
    return `in ${Math.ceil(remaining / MS_PER_HOUR)}h`;
  }

  return '';
}

function renderBadge(completed: boolean): string {
  if (completed) {
    return '<span class="text-xs text-theme-text-tertiary border border-theme-border rounded-full px-1.5 py-0.5">burned</span>';
  }

  return '<span class="text-xs text-theme-accent border border-theme-accent/40 rounded-full px-1.5 py-0.5">current</span>';
}

function formatUpdatedLabel(ts: number): string {
  const elapsed = formatElapsed(ts);

  if (!elapsed) {
    return '';
  }

  return elapsed === 'now' ? 'just now' : `${elapsed} ago`;
}

function renderRow(period: QuotaPeriod): string {
  const rangeText = `${formatDay(period.startedAt)} → ${formatDay(period.resetAt)}`;
  const resetText = formatResetUtc(period.resetAt);
  const countdown = period.completed ? '' : countdownTo(period.resetAt);
  const countdownHtml = countdown
    ? ` <span class="text-xs text-theme-text-tertiary">${escapeHtml(countdown)}</span>`
    : '';
  const resetHtml = resetText
    ? ` <span class="text-xs text-theme-text-tertiary">reset ${escapeHtml(resetText)}</span>`
    : '';
  const badge = renderBadge(period.completed);
  const colorClass = unusedColorClass(period.remainingPercent);
  const usedText = formatPercent(deriveUsedPercent(period));
  const leftText = formatPercent(period.remainingPercent);
  const sampleLabel = `${period.sampleCount} sample${period.sampleCount === 1 ? '' : 's'}`;

  return `<div class="flex items-center justify-between gap-2 py-1.5 border-b border-theme-border/30 last:border-0">
      <div class="flex items-center gap-2 min-w-0">
        <span class="text-sm text-theme-text">${escapeHtml(rangeText)}</span>${countdownHtml}${resetHtml}
        ${badge}
      </div>
      <div class="flex items-center gap-2">
        <span class="text-sm text-theme-text">${escapeHtml(usedText)} used</span>
        <span class="text-sm font-bold ${colorClass}">${escapeHtml(leftText)} left</span>
        <span class="hidden sm:inline text-xs text-theme-text-tertiary">${sampleLabel} · ${escapeHtml(formatUpdatedLabel(period.lastSampledAt))}</span>
      </div>
    </div>`;
}

function renderCard(periods: QuotaPeriod[]): string {
  const first = periods[0];
  const config = TRACKED_QUOTA[first.providerId];
  const cadence = config?.label ?? '';

  // For iso-week providers, surface the calendar Mon–Mon UTC boundary so users
  // understand codex week boundaries differ from rolling-window reset dates.
  const cadenceText = config?.kind === 'iso-week' ? `${cadence} · calendar Mon–Mon UTC` : cadence;

  const cadenceHtml = cadenceText
    ? ` <span class="text-xs text-theme-text-tertiary font-normal">${escapeHtml(cadenceText)}</span>`
    : '';

  const rows = periods.map(renderRow).join('');

  return `<div class="bg-theme-bg-secondary rounded-theme-md p-4 border border-theme-border shadow-theme-sm">
      <h3 class="text-sm font-bold text-theme-text mb-2">${escapeHtml(first.providerName)}${cadenceHtml}</h3>
      ${rows}
    </div>`;
}

// ── Renderer ────────────────────────────────────────────────

export function renderHistoryPanel(periods: QuotaPeriod[]): string {
  if (periods.length === 0) {
    return emptyState('No quota history yet');
  }

  // Group by providerId preserving first-seen order.
  const groups = new Map<string, QuotaPeriod[]>();

  for (const period of periods) {
    const list = groups.get(period.providerId);

    if (list) {
      list.push(period);
    } else {
      groups.set(period.providerId, [period]);
    }
  }

  const cards: string[] = [];

  for (const group of groups.values()) {
    cards.push(renderCard(group));
  }

  return `<div class="grid grid-cols-1 md:grid-cols-2 gap-4">${cards.join('')}</div>`;
}
