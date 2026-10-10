import type { WatchdogPanelData, WatchdogProblem } from '../watchdog.js';
import { formatLag } from '../watchdog.js';
import { emptyState, escapeHtml } from './usage-renderers.js';

// ── Constants ───────────────────────────────────────────────

const ERROR_TRUNCATE = 90;
const RUNS_SHOWN = 3;

// ── Helpers ─────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }

  return `${text.slice(0, max)}…`;
}

function renderProblemLine(p: WatchdogProblem): string {
  // 🔑 marks human-auth problems (never auto-repaired); ⚠️ marks fixable ones.
  const icon = p.needsHuman ? '🔑' : '⚠️';
  const error = p.error ? ` — ${escapeHtml(truncate(p.error, ERROR_TRUNCATE))}` : '';
  const colorClass = p.needsHuman ? 'text-theme-warning' : 'text-theme-danger';

  return `<div class="text-xs ${colorClass} truncate py-0.5">${icon} ${escapeHtml(p.name)} · ${escapeHtml(
    formatLag(p.lagMs),
  )}${error}</div>`;
}

function renderRunLine(run: WatchdogPanelData['runs'][number]): string {
  const timeStr = new Date(run.startedAt).toLocaleTimeString('en');
  const ids = run.providers.join(', ');

  return `<div class="text-xs text-theme-text-secondary truncate py-0.5 font-mono">${timeStr} · ${escapeHtml(
    ids,
  )} · ${escapeHtml(run.status)}</div>`;
}

function renderExhaustedLine(data: WatchdogPanelData): string {
  const alert = data.alerts.find((a) => a.kind === 'repair-failed');

  if (!alert) {
    return '';
  }

  // The ids come from live problems; the alert itself stays as a persistent flag.
  const fixableIds = data.problems.filter((p) => !p.needsHuman).map((p) => p.providerId);

  if (fixableIds.length === 0) {
    return `<div class="text-xs text-theme-danger border border-red-500/40 bg-red-500/10 rounded-theme-sm px-2 py-1 mb-2">${escapeHtml(
      alert.message,
    )}</div>`;
  }

  return `<div class="text-xs text-theme-danger border border-red-500/40 bg-red-500/10 rounded-theme-sm px-2 py-1 mb-2">Auto-repair exhausted today (${data.today.runs}/${data.today.max}) — still failing: ${escapeHtml(
    fixableIds.join(', '),
  )}</div>`;
}

// ── Renderer ────────────────────────────────────────────────

export function renderWatchdogPanel(data: WatchdogPanelData): string {
  const badge = `<span class="text-xs text-theme-text-secondary border border-theme-border rounded-full px-1.5 py-0.5 whitespace-nowrap">${data.today.runs}/${data.today.max} runs today</span>`;

  const problemsHtml =
    data.problems.length > 0
      ? data.problems.map((p) => renderProblemLine(p)).join('')
      : emptyState('All providers fresh');

  const runsHtml =
    data.runs.length > 0
      ? data.runs
          .slice(0, RUNS_SHOWN)
          .map((r) => renderRunLine(r))
          .join('')
      : emptyState('No runs yet');

  return `<div class="bg-theme-bg-secondary rounded-theme-md p-4 border border-theme-border shadow-theme-sm">
      <div class="flex items-center justify-between gap-2 mb-3">
        <h3 class="text-sm font-semibold text-theme-text">Watchdog</h3>
        ${badge}
      </div>
      ${renderExhaustedLine(data)}
      <h4 class="text-[0.65rem] font-semibold uppercase tracking-wide text-theme-text-tertiary mb-1">Problems</h4>
      ${problemsHtml}
      <h4 class="text-[0.65rem] font-semibold uppercase tracking-wide text-theme-text-tertiary mt-3 mb-1">Auto-repair runs</h4>
      ${runsHtml}
    </div>`;
}
