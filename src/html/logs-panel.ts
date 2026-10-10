import { formatElapsed } from '../time-utils.js';
import type { LogEntry } from '../types.js';
import { emptyState, escapeHtml } from './usage-renderers.js';

// ── Constants ───────────────────────────────────────────────

const LEVEL_CLASSES: Record<string, string> = {
  info: 'text-theme-text-tertiary',
  warn: 'text-theme-warning',
  error: 'text-theme-danger',
};

// ── Helpers ─────────────────────────────────────────────────

function levelClass(level: string): string {
  return LEVEL_CLASSES[level] ?? 'text-theme-text-tertiary';
}

// ── Renderer ────────────────────────────────────────────────

export function renderLogsPanel(logs: LogEntry[]): string {
  if (logs.length === 0) {
    return emptyState('No logs yet');
  }

  const rows = logs
    .map((log) => {
      const timeStr = new Date(log.ts).toLocaleTimeString('en');
      const elapsed = formatElapsed(log.ts);
      const lc = levelClass(log.level);
      const providerPart = log.providerId ? ` · ${escapeHtml(log.providerId)}` : '';

      return `<div class="flex items-start gap-2 py-1 border-b border-theme-border/30 text-xs">
      <span class="font-mono text-theme-text-secondary whitespace-nowrap">${timeStr} (${elapsed})</span>
      <span class="font-semibold uppercase ${lc}">${log.level}</span>
      <span class="text-theme-text">${escapeHtml(log.message)}${providerPart}</span>
    </div>`;
    })
    .join('');

  return `<div>${rows}</div>`;
}
