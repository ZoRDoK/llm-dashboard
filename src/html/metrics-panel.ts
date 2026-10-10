import { MS_PER_HOUR } from '../constants.js';
import { formatElapsed } from '../time-utils.js';
import type { ProviderMetrics } from '../types.js';
import { emptyState, escapeHtml } from './usage-renderers.js';

// ── Helpers ─────────────────────────────────────────────────

function getMetricsBorderClass(m: ProviderMetrics): string {
  if (m.archived) {
    return 'border-theme-border';
  }

  if (!m.configured) {
    return 'border-theme-border';
  }

  if (m.lastSuccessAt == null) {
    return 'border-red-500';
  }

  if (Date.now() - m.lastSuccessAt >= MS_PER_HOUR) {
    return 'border-red-500';
  }

  return 'border-green-500';
}

function getMetricsLabel(m: ProviderMetrics): string {
  if (m.archived) {
    return 'Archived';
  }

  if (!m.configured) {
    return 'Not configured';
  }

  if (m.lastSuccessAt == null) {
    return 'No data';
  }

  return '';
}

function formatLast(value: number | null): string {
  if (value == null) {
    return 'never';
  }

  return formatElapsed(value);
}

// ── Renderer ────────────────────────────────────────────────

export function renderMetricsPanel(metrics: ProviderMetrics[]): string {
  if (metrics.length === 0) {
    return emptyState('No providers');
  }

  const cards = metrics
    .map((m) => {
      const borderClass = getMetricsBorderClass(m);
      const label = getMetricsLabel(m);
      const lastSuccessText = formatLast(m.lastSuccessAt);
      const lastAttemptText = formatLast(m.lastAttemptAt);

      const labelHtml = label
        ? ` <span class="text-xs text-theme-text-tertiary">(${label})</span>`
        : '';

      return `<div class="bg-theme-bg-secondary rounded-theme-md p-4 border ${borderClass} shadow-theme-sm">
      <h3 class="text-sm font-semibold text-theme-text mb-2">${escapeHtml(m.name)}${labelHtml}</h3>
      <div class="text-xs text-theme-text-secondary space-y-1">
        <div>Last success: ${lastSuccessText}</div>
        <div>Last attempt: ${lastAttemptText}</div>
      </div>
    </div>`;
    })
    .join('');

  return `<div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">${cards}</div>`;
}
