import { MS_PER_DAY } from './constants.js';
import { clientScript } from './html/client-script.js';
import { isCompactProvider, renderCompactPanel } from './html/compact-panel.js';
import { renderHistoryPanel } from './html/history-panel.js';
import { renderLogsPanel } from './html/logs-panel.js';
import { renderMetricsPanel } from './html/metrics-panel.js';
import { THEME_NAMES, tailwindCSS, themeCSS } from './html/themes.js';
import { renderUrgentPanel } from './html/urgent-panel.js';
import {
  errorCard,
  escapeHtml,
  modelCard,
  toDateInputValue,
  updatedLabelSpan,
} from './html/usage-renderers.js';
import type { Provider } from './provider.js';
import { formatElapsed } from './time-utils.js';
import type { LogEntry, ProviderMetrics, QuotaPeriod } from './types.js';

// ── SVG refresh circle constants ────────────────────────────

const REFRESH_RADIUS = 14;
const REFRESH_CIRCUMFERENCE = 2 * Math.PI * REFRESH_RADIUS;

// ── Billing constants ───────────────────────────────────────

const BILLING_URGENT_DAYS = 5;

// ── Sub-renderers ───────────────────────────────────────────

function computeMaxUsage(providers: Provider[]): number {
  let maxUsage = 0;

  for (const p of providers) {
    for (const m of p.models) {
      for (const w of m.windows) {
        if (w.usedPercent != null && w.usedPercent > maxUsage) {
          maxUsage = w.usedPercent;
        }
      }
    }
  }

  return maxUsage;
}

function renderBillingTag(billingEnd: string | undefined): string {
  if (!billingEnd) {
    return '';
  }

  const msLeft = new Date(billingEnd).getTime() - Date.now();
  const daysLeft = msLeft / MS_PER_DAY;
  const urgent = daysLeft <= BILLING_URGENT_DAYS;
  const colorClass = urgent
    ? 'text-red-500 border-red-500/30'
    : 'text-theme-text-tertiary border-theme-border-light';
  const dateText = new Date(billingEnd).toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
  });

  return `<span class="text-xs font-normal border rounded-full px-1.5 py-0.5 ml-2 ${colorClass}">Billing: ${dateText}</span>`;
}

function renderUpdatedLabel(p: Provider): string {
  if (p.updatedAt == null) {
    return '';
  }

  const stalePill = p.stale
    ? `<span class="text-[0.65rem] font-normal border rounded-full px-1.5 py-0.5 text-theme-warning border-theme-warning/40 not-italic">stale</span>`
    : '';

  return updatedLabelSpan(
    p.updatedAt,
    'absolute top-2 right-2 inline-flex items-center gap-1 text-[0.65rem] text-theme-text-tertiary/40 italic',
    stalePill,
  );
}

function renderProviderCard(p: Provider, billingEnd: string | undefined): string {
  if (p.error) {
    return errorCard(p);
  }

  const visibleModels =
    p.id === 'minimax' ? p.models.filter((m) => !m.modelName.startsWith('coding-plan')) : p.models;
  const modelsHtml = visibleModels.map(modelCard).join('');

  const billingTag = renderBillingTag(billingEnd);

  const updatedLabel = renderUpdatedLabel(p);

  return `
      <div class="relative bg-theme-bg-secondary rounded-theme-md p-4 border border-theme-border break-inside-avoid mb-4 shadow-theme-md transition-theme duration-theme">
        ${updatedLabel}
        <h2 class="text-lg font-bold text-theme-text mb-3">
          ${escapeHtml(p.name)}
          ${billingTag}
        </h2>
        <div>
          ${modelsHtml}
        </div>
      </div>`;
}

function renderSettingsRow(p: Provider, inputValue: string): string {
  return `
      <div class="grid grid-cols-1 md:grid-cols-[200px_1fr_auto] gap-2 items-center p-3 rounded-theme-sm bg-theme-bg-tertiary border border-theme-border" data-provider-id="${escapeHtml(p.id)}">
        <div class="text-sm text-theme-text">${escapeHtml(p.name)}</div>
        <input
          type="date"
          class="billing-date-input px-2 py-1.5 rounded-theme-sm bg-theme-bg text-theme-text border border-theme-border focus:outline-none focus:ring-2 focus:ring-theme-accent"
          value="${inputValue}"
          onchange="markBillingDirty('${escapeHtml(p.id)}')"
          autocomplete="off"
        />
        <button
          type="button"
          class="px-2 py-1.5 text-xs rounded-theme-sm bg-theme-bg-secondary text-theme-text-secondary border border-theme-border hover:bg-theme-bg"
          onclick="clearBillingDate('${escapeHtml(p.id)}')"
        >
          Clear
        </button>
      </div>`;
}

function renderArchiveToggle(p: Provider, archived: boolean): string {
  return `<div class="flex items-center justify-between p-3 rounded-theme-sm bg-theme-bg-tertiary border border-theme-border">
          <span class="text-sm text-theme-text">${escapeHtml(p.name)}</span>
          <label class="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" class="archive-toggle sr-only peer" data-provider-id="${escapeHtml(p.id)}" ${archived ? 'checked' : ''} onchange="toggleArchive('${escapeHtml(p.id)}')">
            <span class="text-xs text-theme-text-secondary mr-2">Archive</span>
            <div class="relative w-9 h-5 bg-theme-bg rounded-full peer peer-checked:bg-theme-accent peer-focus:ring-2 peer-focus:ring-theme-accent/30 after:content-[''] after:absolute after:top-0.5 after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
          </label>
        </div>`;
}

// ── Page sections ───────────────────────────────────────────

function documentHead(): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="ocean-depths">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Creds</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%20width%3D%2232%22%20height%3D%2232%22%3E%3Ccircle%20cx%3D%2216%22%20cy%3D%2216%22%20r%3D%2215%22%20fill%3D%22%23000000%22%2F%3E%3Ctext%20x%3D%2216%22%20y%3D%2222%22%20text-anchor%3D%22middle%22%20font-family%3D%22monospace%2C%20Courier%20New%22%20font-weight%3D%22700%22%20font-size%3D%2219%22%20fill%3D%22%23ffffff%22%3EAI%3C%2Ftext%3E%3Ctext%20x%3D%2231%22%20y%3D%2232%22%20text-anchor%3D%22end%22%20font-family%3D%22monospace%2C%20Courier%20New%22%20font-weight%3D%22700%22%20font-size%3D%2216%22%20fill%3D%22%2322c55e%22%3E%24%3C%2Ftext%3E%3C%2Fsvg%3E">
  <style>
    /* ── Locally built Tailwind utilities (design/tailwind.css, no CDN) ── */
    ${tailwindCSS}
  </style>
  <style>
    /* ── Inlined theme definitions ── */
    ${themeCSS}

    /* ── Refresh progress circle ── */
    .refresh-circle {
      width: 26px;
      height: 26px;
      flex-shrink: 0;
    }
    .refresh-circle .track {
      stroke: var(--theme-bg-tertiary);
    }
    .refresh-circle .progress {
      transition: stroke-dashoffset 0.8s ease-out, stroke 1.5s ease-out;
    }
    .refresh-circle.fresh .progress {
      stroke: var(--theme-success);
    }
    .refresh-circle.stale .progress {
      stroke: var(--theme-warning);
    }
    .refresh-circle.normal .progress {
      stroke: var(--theme-accent);
    }

  </style>
</head>`;
}

function dashboardHeader(lastUpdated: number | null, maxUsage: number): string {
  return `    <!-- Header: title, tabs, and controls on one row -->
    <div class="flex items-center justify-between gap-4 mb-6">
      <div class="flex items-center gap-4">
        <h1 class="text-2xl font-bold text-theme-text">AI Creds</h1>
        <div class="inline-flex rounded-theme-sm bg-theme-bg-tertiary border border-theme-border p-1 w-fit">
          <button id="tab-dashboard-btn" onclick="showTab('dashboard')" class="tab-btn px-3 py-1.5 text-sm rounded-theme-sm bg-theme-accent text-theme-accent-text transition-theme duration-theme">Dashboard</button>
          <button id="tab-settings-btn" onclick="showTab('settings')" class="tab-btn px-3 py-1.5 text-sm rounded-theme-sm text-theme-text-secondary hover:bg-theme-bg-secondary/50 hover:text-theme-text transition-theme duration-theme">Settings</button>
          <button id="tab-history-btn" onclick="showTab('history')" class="tab-btn px-3 py-1.5 text-sm rounded-theme-sm text-theme-text-secondary hover:bg-theme-bg-secondary/50 hover:text-theme-text transition-theme duration-theme">History</button>
          <button id="tab-metrics-btn" onclick="showTab('metrics')" class="tab-btn px-3 py-1.5 text-sm rounded-theme-sm text-theme-text-secondary hover:bg-theme-bg-secondary/50 hover:text-theme-text transition-theme duration-theme">Metrics</button>
          <a href="/p-charts" title="Pi token usage charts" class="px-3 py-1.5 text-sm rounded-theme-sm text-theme-text-secondary hover:bg-theme-bg-secondary/50 hover:text-theme-text transition-theme duration-theme">P Charts</a>
        </div>
      </div>
      <div id="dashboard-controls" class="flex items-center gap-3 h-8">
        <svg id="refresh-circle" class="refresh-circle normal"
             width="26" height="26" viewBox="0 0 36 36"
             data-updated="${lastUpdated ?? ''}"
             data-max-usage="${maxUsage}">
          <circle class="track" cx="18" cy="18" r="14" fill="none" stroke-width="3"/>
          <circle class="progress" cx="18" cy="18" r="14" fill="none" stroke-width="3"
                  stroke-linecap="round"
                  stroke-dasharray="${REFRESH_CIRCUMFERENCE} ${REFRESH_CIRCUMFERENCE}"
                  stroke-dashoffset="${REFRESH_CIRCUMFERENCE}"
                  transform="rotate(-90 18 18)"/>
        </svg>
        <span id="last-updated-time" class="text-xs text-theme-text-secondary font-mono tabular-nums w-16 text-right" data-updated="${lastUpdated ?? ''}">${formatElapsed(lastUpdated)}</span>
        <button onclick="ThemeManager.rotate()"
          class="p-1.5 rounded-theme-sm bg-theme-bg-tertiary hover:bg-theme-bg-secondary transition-theme duration-theme"
          title="Switch theme (Ctrl+T)">
          <svg class="w-4 h-4 text-theme-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4.098 19.902a3.75 3.75 0 005.304 0l6.401-6.402M6.75 21A3.75 3.75 0 013 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 003.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.879 2.88M6.75 17.25h.008v.008H6.75v-.008z" />
          </svg>
        </button>
        <button id="refresh-btn" onclick="refresh()"
          class="px-4 py-1.5 bg-theme-accent hover:bg-theme-accent-hover text-theme-accent-text rounded-theme-sm text-sm transition-theme duration-theme flex items-center gap-2 focus:ring-2 focus:ring-theme-accent focus:outline-none">
          <span id="refresh-spinner" class="hidden">⟳</span>
          <span>Refresh</span>
        </button>
      </div>
    </div>`;
}

function responsivePanels(urgentPanel: string, compactPanel: string): string {
  const stacked =
    urgentPanel || compactPanel
      ? `<div class="xl:hidden flex flex-col sm:flex-row gap-4 mb-4">
      <div class="flex-1 min-w-0">${urgentPanel}</div>
      <div class="flex-1 min-w-0">${compactPanel}</div>
    </div>`
      : '';

  const urgentAside = urgentPanel
    ? `<aside class="hidden xl:block fixed left-4 top-28 w-56 pointer-events-auto">${urgentPanel}</aside>`
    : '';
  const compactAside = compactPanel
    ? `<aside class="hidden xl:block fixed right-4 top-28 w-56 pointer-events-auto">${compactPanel}</aside>`
    : '';

  return `    <!-- Mobile/tablet panels: stacked above dashboard on small screens -->
    ${stacked}

    <!-- Floating panels on wide screens; they do not consume dashboard columns -->
    ${urgentAside}
    ${compactAside}`;
}

function dashboardTab(rows: string, archivedCount: number, archivedRows: string): string {
  const archiveDetails =
    archivedCount > 0
      ? `<details class="mt-6 bg-theme-bg-secondary rounded-theme-md border border-theme-border shadow-theme-sm">
      <summary class="px-4 py-3 cursor-pointer text-sm font-semibold text-theme-text-secondary hover:text-theme-text transition-theme duration-theme select-none">Archive (${archivedCount})</summary>
      <div class="px-4 pb-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          ${archivedRows}
        </div>
      </div>
    </details>`
      : '';

  return `    <div id="tab-dashboard" class="tab-panel">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4" id="dashboard">
        ${rows}
      </div>
      ${archiveDetails}
    </div>`;
}

function settingsTab(settingsRows: string, archiveToggles: string): string {
  return `    <div id="tab-settings" class="tab-panel hidden">
      <div class="bg-theme-bg-secondary rounded-theme-md p-4 border border-theme-border shadow-theme-md">
        <h2 class="text-lg font-bold text-theme-text mb-1">Billing dates</h2>
        <p class="text-sm text-theme-text-secondary mb-3">Set manual billing end dates for providers.</p>
        <div class="space-y-2">${settingsRows}</div>
        <div class="mt-3 flex items-center gap-2">
          <button id="save-settings-btn" onclick="saveBillingSettings()" class="px-3 py-1.5 bg-theme-accent hover:bg-theme-accent-hover text-theme-accent-text rounded-theme-sm text-sm transition-theme duration-theme">Save</button>
          <span id="settings-status" class="text-xs text-theme-text-tertiary"></span>
        </div>
      </div>
      <div class="bg-theme-bg-secondary rounded-theme-md p-4 border border-theme-border shadow-theme-md mt-4">
        <h2 class="text-lg font-bold text-theme-text mb-1">Archive</h2>
        <p class="text-sm text-theme-text-secondary mb-3">Hide providers from the main dashboard.</p>
        <div class="space-y-2">
          ${archiveToggles}
        </div>
      </div>
    </div>`;
}

function dataTabs(
  historyPanel: string,
  metricsPanel: string,
  logsPanel: string,
  watchdogPanel = '',
): string {
  return `    <div id="tab-history" class="tab-panel hidden">
      <h2 class="text-lg font-bold text-theme-text mb-3">Quota history</h2>
      <div id="history-panel">${historyPanel}</div>
    </div>

    <div id="tab-metrics" class="tab-panel hidden">
      <h2 class="text-lg font-bold text-theme-text mb-3">Metrics</h2>
      <div id="metrics-panel">${metricsPanel}</div>
      <h2 class="text-lg font-bold text-theme-text mb-3 mt-6">Logs</h2>
      <div id="logs-panel">${logsPanel}</div>
      <h2 class="text-lg font-bold text-theme-text mb-3 mt-6">Watchdog</h2>
      <div id="watchdog-panel">${watchdogPanel}</div>
    </div>`;
}

// ── Main render ─────────────────────────────────────────────

export function renderDashboard(
  providers: Provider[],
  lastUpdated: number | null,
  billingOverrides: Record<string, string>,
  archiveSet: Set<string> = new Set(),
  metrics: ProviderMetrics[] = [],
  logs: LogEntry[] = [],
  history: QuotaPeriod[] = [],
  watchdogPanel = '',
): string {
  const maxUsage = computeMaxUsage(providers);

  const activeProviders = providers.filter((p) => !archiveSet.has(p.id));
  const archivedProviders = providers.filter((p) => archiveSet.has(p.id));

  const mainProviders = activeProviders.filter((p) => !isCompactProvider(p));
  const rows = mainProviders.map((p) => renderProviderCard(p, billingOverrides[p.id])).join('');

  const settingsRows = mainProviders
    .map((p) => renderSettingsRow(p, toDateInputValue(billingOverrides[p.id])))
    .join('');

  const archivedRows = archivedProviders
    .map((p) => renderProviderCard(p, billingOverrides[p.id]))
    .join('');

  const archiveToggles = providers
    .map((p) => renderArchiveToggle(p, archiveSet.has(p.id)))
    .join('');

  const urgentPanel = renderUrgentPanel(mainProviders);
  const compactPanel = renderCompactPanel(activeProviders);

  return `${documentHead()}
<body class="bg-theme-bg text-theme-text min-h-screen theme-transition">
  <div class="max-w-5xl mx-auto px-4 py-8">
${dashboardHeader(lastUpdated, maxUsage)}

${responsivePanels(urgentPanel, compactPanel)}

${dashboardTab(rows, archivedProviders.length, archivedRows)}

${settingsTab(settingsRows, archiveToggles)}

${dataTabs(
  renderHistoryPanel(history),
  renderMetricsPanel(metrics),
  renderLogsPanel(logs),
  watchdogPanel,
)}

    <div id="status" class="mt-4 text-sm text-theme-text-tertiary text-center"></div>
  </div>
  <script>
${clientScript({ themeNames: THEME_NAMES, refreshCircumference: REFRESH_CIRCUMFERENCE })}
  </script>
</body>
</html>`;
}
