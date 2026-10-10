import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '../constants.js';
import type { ModelUsage } from '../model-usage.js';
import type { Provider } from '../provider.js';
import { formatElapsed } from '../time-utils.js';
import type { UsageWindow } from '../usage-window.js';

// ── Constants ───────────────────────────────────────────────

const PERCENT_MAX = 100;
const LOW_USAGE_THRESHOLD = 50;
const MEDIUM_USAGE_THRESHOLD = 80;
const MIN_VISIBLE_PERCENT = 3;
const ZERO_PERCENT = 0;

const FIVE_HOURS = 5;
const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 30;

const SEGMENT_COUNT = 8;
const RESET_NEAR_THRESHOLD = 0.85;
const RESET_MID_THRESHOLD = 0.625;

// ── Formatting helpers ──────────────────────────────────────

function usageColor(percent: number | null): string {
  if (percent == null) {
    return 'bg-theme-bg-tertiary';
  }

  if (percent < LOW_USAGE_THRESHOLD) {
    return 'bg-green-500';
  }

  if (percent < MEDIUM_USAGE_THRESHOLD) {
    return 'bg-yellow-500';
  }

  return 'bg-red-500';
}

function barWidth(percent: number | null): string {
  if (percent == null || percent <= ZERO_PERCENT) {
    return '0%';
  }

  return `${Math.min(percent, PERCENT_MAX)}%`;
}

function formatSpend(amount: number | null): string {
  if (amount == null) {
    return '';
  }

  return `$${amount.toFixed(2)}`;
}

export function formatNumber(n: number | null): string {
  if (n == null) {
    return '';
  }

  return n.toLocaleString('en');
}

/** Format milliseconds remaining until a future timestamp. */
export function formatTimeUntil(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '';
  }

  if (ms >= MS_PER_DAY) {
    return `${Math.ceil(ms / MS_PER_DAY)}d`;
  }

  if (ms >= MS_PER_HOUR) {
    return `${Math.ceil(ms / MS_PER_HOUR)}h`;
  }

  if (ms >= MS_PER_MINUTE) {
    return `${Math.ceil(ms / MS_PER_MINUTE)}m`;
  }

  return '<1m';
}

export function toDateInputValue(iso: string | undefined): string {
  if (!iso) {
    return '';
  }

  const date = new Date(iso);

  if (!Number.isFinite(date.getTime())) {
    return '';
  }

  return date.toISOString().slice(0, 10);
}

export function escapeHtml(text: string | null | undefined): string {
  if (text == null) {
    return '';
  }

  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Shared panel primitives ─────────────────────────────────

/** Find the first window in a provider that satisfies the predicate. */
export function findWindow(
  provider: Provider,
  pred: (w: UsageWindow) => boolean,
): UsageWindow | null {
  for (const model of provider.models) {
    for (const w of model.windows) {
      if (pred(w)) {
        return w;
      }
    }
  }

  return null;
}

/** The "Updated <elapsed>" pill attached to every refreshed card variant. */
export function updatedLabelSpan(updatedAt: number, className: string, extra = ''): string {
  return `<span class="provider-updated ${className}" data-provider-updated="${updatedAt}">Updated ${formatElapsed(updatedAt)}${extra}</span>`;
}

/** Placeholder shown by panels when there is nothing to render yet. */
export function emptyState(message: string): string {
  return `<div class="text-theme-text-tertiary text-sm">${message}</div>`;
}

// ── Reset countdown ring ────────────────────────────────────

/** Map window label to approximate cycle duration in ms. */
function cycleMs(label: string): number | null {
  switch (label) {
    case '5h':
      return FIVE_HOURS * MS_PER_HOUR;
    case 'today':
    case 'daily':
      return HOURS_PER_DAY * MS_PER_HOUR;
    case 'week':
    case 'weekly':
      return DAYS_PER_WEEK * HOURS_PER_DAY * MS_PER_HOUR;
    case 'month':
    case 'monthly':
      return DAYS_PER_MONTH * HOURS_PER_DAY * MS_PER_HOUR;
    default:
      return null;
  }
}

/**
 * Render one of 8 quarter-block characters based on elapsed time.
 * ▖=12% ▗=25% ▘=37% ▙=50% ▚=62% ▛=75% ▜=87% █=100%
 */
function renderResetRing(label: string, resetAt: string | null): string {
  if (!resetAt) {
    return '';
  }

  const cycle = cycleMs(label);

  if (!cycle) {
    return '';
  }

  const remaining = new Date(resetAt).getTime() - Date.now();

  if (!Number.isFinite(remaining) || remaining <= 0) {
    return '';
  }

  // progress = 0 when just reset, = 1 when about to reset
  const progress = Math.min(1, Math.max(0, 1 - remaining / cycle));
  const idx = Math.min(SEGMENT_COUNT - 1, Math.floor(progress * SEGMENT_COUNT));

  // Quarter-block characters: increasing fill left-to-right
  const blocks = ['▖', '▗', '▘', '▙', '▚', '▛', '▜', '█'];
  const block = blocks[idx];

  // Color: green when close to reset (good), yellow mid, red when far (bad)
  let colorClass: string;

  if (progress >= RESET_NEAR_THRESHOLD) {
    colorClass = 'text-green-500';
  } else if (progress >= RESET_MID_THRESHOLD) {
    colorClass = 'text-yellow-500';
  } else {
    colorClass = 'text-red-500/60';
  }

  return `<span class="font-mono text-xs ${colorClass}">${block}</span>`;
}

// ── Usage window renderers ──────────────────────────────────

function buildUsageParts(window: UsageWindow): string {
  if (window.usedPercent == null) {
    return '';
  }

  const parts: string[] = [`${window.usedPercent.toFixed(1)}% used`];

  if (window.remainingPercent != null) {
    parts.push(`${window.remainingPercent.toFixed(1)}% left`);
  }

  if (window.used != null && window.total != null) {
    const countText =
      window.valueLabel ?? `${formatNumber(window.used)}/${formatNumber(window.total)}`;
    parts.push(countText);
  }

  return parts.join(' · ');
}

function renderUsageMiddle(window: UsageWindow): string {
  if (window.usedPercent == null) {
    return '';
  }

  const usageClass =
    window.usedPercent === ZERO_PERCENT ? 'text-theme-text' : 'text-theme-text-secondary';

  const needsMinWidth =
    window.usedPercent > ZERO_PERCENT && window.usedPercent < MIN_VISIBLE_PERCENT;

  const minWidthClass = needsMinWidth ? ' min-w-1' : '';

  return `
      <div class="flex-1 min-w-0">
        <div class="flex justify-between text-xs ${usageClass} mb-0.5">
          <span>${buildUsageParts(window)}</span>
          <span></span>
        </div>
        <div class="w-full bg-theme-bg-tertiary rounded h-1.5">
          <div class="h-1.5 rounded ${usageColor(window.usedPercent)}${minWidthClass}" style="width:${barWidth(window.usedPercent)}"></div>
        </div>
      </div>`;
}

function renderWindowMiddle(window: UsageWindow): string {
  const usageMiddle = renderUsageMiddle(window);

  if (usageMiddle) {
    return usageMiddle;
  }

  if (window.spend != null) {
    const spendClass =
      window.spend > ZERO_PERCENT ? 'text-theme-spend font-bold' : 'text-theme-text-tertiary';

    return `<span class="text-xs font-mono flex-1 ${spendClass}">${formatSpend(window.spend)}</span>`;
  }

  if (window.valueLabel) {
    return `<span class="text-xs text-theme-text-secondary truncate flex-1">${escapeHtml(window.valueLabel)}</span>`;
  }

  return '<span class="flex-1"></span>';
}

function renderWindowMeta(window: UsageWindow): string {
  const resetRing = renderResetRing(window.label, window.resetAt);

  if (!resetRing) {
    return '<span></span>';
  }

  const remaining = window.resetAt ? new Date(window.resetAt).getTime() - Date.now() : null;

  const timeText = remaining == null ? '' : formatTimeUntil(remaining);

  return `<span class="inline-flex items-center gap-1.5 min-w-[4rem]">${resetRing}${timeText}</span>`;
}

function windowRow(window: UsageWindow): string {
  const label = `<span class="text-xs font-semibold text-theme-text-secondary uppercase tracking-wider">${escapeHtml(window.label)}</span>`;

  const middle = renderWindowMiddle(window);

  const meta = renderWindowMeta(window);

  return `
    <div class="grid grid-cols-[4.5rem_1fr_auto] gap-1.5 items-start py-1 px-1.5 bg-theme-bg-tertiary rounded">
      ${label}
      ${middle}
      ${meta}
    </div>`;
}

// ── Model grouping for MiniMax ──────────────────────────────

interface ModelGroup {
  main: ModelUsage[];
  extra: ModelUsage[];
}

export function groupMiniMaxModels(models: ModelUsage[]): ModelGroup {
  const main: ModelUsage[] = [];

  for (const m of models) {
    if (m.modelName.startsWith('coding-plan')) {
      continue;
    }

    main.push(m);
  }

  return { main, extra: [] };
}

// ── Card renderers ──────────────────────────────────────────

export function modelCard(m: ModelUsage): string {
  if (m.windows.length === 0) {
    return '';
  }

  return `
    <div class="mb-1">
      <div class="space-y-1">${m.windows.map(windowRow).join('')}</div>
    </div>`;
}

export function errorCard(provider: Provider): string {
  const updatedHtml =
    provider.updatedAt == null
      ? ''
      : updatedLabelSpan(provider.updatedAt, 'text-xs text-theme-text-tertiary ml-2');

  return `
    <div class="bg-theme-bg-secondary rounded-theme-md p-4 border border-theme-danger mb-4 shadow-theme-sm hover:shadow-theme-md transition-all duration-theme focus-within:border-theme-accent/50">
      <h2 class="text-lg font-bold text-theme-text mb-3">${escapeHtml(provider.name)}${updatedHtml}</h2>
      <div class="bg-[var(--theme-danger)]/10 rounded-theme-md p-3">
        <div class="text-theme-danger text-sm">${escapeHtml(provider.error ?? '')}</div>
      </div>
    </div>`;
}
