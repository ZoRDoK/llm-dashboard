import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ModelUsage } from './model-usage';
import type { Provider } from './provider';
import type { UsageWindow } from './usage-window';

// ── Load all theme CSS files once at module init ────────────
const __dirname = import.meta.dirname;
const THEMES_DIR = resolve(__dirname, '..', 'design', 'themes');
const THEME_NAMES = [
  'ocean-depths',
  'sunset-boulevard',
  'forest-canopy',
  'neon-nights',
  'paper-ink',
  'arctic-frost',
  'desert-dunes',
  'cyberpunk',
  'zen-garden',
  'retro-wave',
];

let themeCSS = '';
for (const [idx, name] of THEME_NAMES.entries()) {
  const padded = String(idx + 1).padStart(2, '0');
  const path = resolve(THEMES_DIR, `theme-${padded}-${name}.css`);
  try {
    themeCSS += readFileSync(path, 'utf-8');
  } catch {
    console.warn(`Theme file not found: ${path}`);
  }
}

// ── Helpers ─────────────────────────────────────────────────

const PERCENT_MAX = 100;
const LOW_USAGE_THRESHOLD = 50;
const MEDIUM_USAGE_THRESHOLD = 80;
const MIN_VISIBLE_PERCENT = 3;
const FIVE_HOURS = 5;
const ZERO_PERCENT = 0;

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

function formatNumber(n: number | null): string {
  if (n == null) {
    return '';
  }
  return n.toLocaleString('en');
}

function toDateInputValue(iso: string | undefined): string {
  if (!iso) {
    return '';
  }
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) {
    return '';
  }
  return date.toISOString().slice(0, 10);
}

function escapeHtml(text: string | null | undefined): string {
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

// ── Reset countdown ring ────────────────────────────────────

const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 30;
const MS_PER_HOUR = 3_600_000;

const RING_RADIUS = 7;
const RING_C = 2 * Math.PI * RING_RADIUS;
const REFRESH_RADIUS = 14;
const REFRESH_CIRCUMFERENCE = 2 * Math.PI * REFRESH_RADIUS;

const RESET_NEAR_THRESHOLD = 0.85;
const RESET_FAR_THRESHOLD = 0.3;
const BILLING_URGENT_DAYS = 5;
const MS_PER_DAY = 86_400_000;

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
 * Render a small SVG ring showing progress toward the next reset.
 * Empty = just reset, full = about to reset.
 * Color: positive when close to reset, negative when far away.
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
    return ''; // already past reset time or invalid date
  }
  const progress = 1 - remaining / cycle; // 0 just after reset, 1 at reset
  const clamped = Math.max(0, Math.min(1, progress));
  const offset = RING_C * (1 - clamped);

  // Color: close to reset → positive, far → neutral/negative
  let mood: string;
  if (clamped >= RESET_NEAR_THRESHOLD) {
    mood = 'positive'; // reset imminent — relief
  } else if (clamped < RESET_FAR_THRESHOLD) {
    mood = 'neutral'; // just reset — calm
  } else {
    mood = 'negative'; // far from reset — waiting
  }

  return `
    <svg class="reset-ring ${mood}" width="20" height="20" viewBox="0 0 20 20">
      <circle class="track" cx="10" cy="10" r="7" fill="none" stroke-width="2.5"/>
      <circle class="fill" cx="10" cy="10" r="7" fill="none" stroke-width="2.5"
              stroke-linecap="round"
              stroke-dasharray="${RING_C} ${RING_C}"
              stroke-dashoffset="${offset}"
              transform="rotate(-90 10 10)"/>
    </svg>`;
}

function buildUsageParts(window: UsageWindow): string {
  if (window.usedPercent == null) {
    return '';
  }

  const parts: string[] = [`${window.usedPercent.toFixed(1)}% used`];

  if (window.remainingPercent != null) {
    parts.push(`${window.remainingPercent.toFixed(1)}% left`);
  }

  if (window.used != null && window.total != null) {
    parts.push(`${formatNumber(window.used)}/${formatNumber(window.total)}`);
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

  return `<span class="inline-flex items-center gap-1.5 min-w-[4rem]">${resetRing}</span>`;
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

function groupMiniMaxModels(models: ModelUsage[]): ModelGroup {
  const main: ModelUsage[] = [];
  const extra: ModelUsage[] = [];

  for (const m of models) {
    const name = m.modelName;

    if (name.startsWith('coding-plan')) {
      continue;
    }

    if (name.startsWith('MiniMax-M') || name === 'image-01') {
      main.push(m);
      continue;
    }

    extra.push(m);
  }

  return { main, extra };
}

function modelCard(m: ModelUsage): string {
  if (m.windows.length === 0) {
    return '';
  }

  return `
    <div class="bg-theme-bg-secondary rounded-theme-md p-3 border border-theme-border mb-3 hover:shadow-theme-md hover:border-theme-accent/30 transition-all duration-theme">
      <div class="flex items-center justify-between mb-2">
        <span class="text-sm font-mono font-medium text-theme-text">${escapeHtml(m.modelName)}</span>
      </div>
      <div class="space-y-1">${m.windows.map(windowRow).join('')}</div>
    </div>`;
}

function errorCard(provider: Provider): string {
  return `
    <div class="bg-theme-bg-secondary rounded-theme-md p-4 border border-theme-danger mb-4 shadow-theme-sm hover:shadow-theme-md transition-all duration-theme focus-within:border-theme-accent/50">
      <h2 class="text-lg font-bold text-theme-text mb-3">${escapeHtml(provider.name)}</h2>
      <div class="bg-[var(--theme-danger)]/10 rounded-theme-md p-3">
        <div class="text-theme-danger text-sm">${escapeHtml(provider.error)}</div>
      </div>
    </div>`;
}

// ── Main render ─────────────────────────────────────────────

export function renderDashboard(
  providers: Provider[],
  lastUpdated: number | null,
  billingOverrides: Record<string, string>,
): string {
  // Max usage percent across all providers for color logic
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

  const rows = providers
    .map((p) => {
      if (p.error) {
        return errorCard(p);
      }

      const isMiniMax = p.id === 'minimax';

      let modelsHtml: string;

      if (isMiniMax) {
        const { main, extra } = groupMiniMaxModels(p.models);

        const mainHtml = main.map((m) => modelCard(m)).join('');

        let extraHtml = '';
        if (extra.length > 0) {
          const extraCards = extra.map((m) => modelCard(m)).join('');
          extraHtml = `
          <details class="mt-2 group">
            <summary class="text-xs text-theme-accent cursor-pointer hover:underline transition-theme duration-theme list-none marker:hidden">
              Show all models
            </summary>
            ${extraCards}
          </details>`;
        }

        modelsHtml = mainHtml + extraHtml;
      } else {
        modelsHtml = p.models.map((m) => modelCard(m)).join('');
      }

      const billingEnd = billingOverrides[p.id];
      let billingTag = '';

      if (billingEnd) {
        const msLeft = new Date(billingEnd).getTime() - Date.now();
        const daysLeft = msLeft / MS_PER_DAY;
        const urgent = daysLeft <= BILLING_URGENT_DAYS;

        billingTag = `<span class="text-xs font-normal border rounded-full px-1.5 py-0.5 ml-2 ${urgent ? 'text-red-500 border-red-500/30' : 'text-theme-text-tertiary border-theme-border-light'}">Billing: ${new Date(billingEnd).toLocaleDateString('en', { month: 'short', day: 'numeric' })}</span>`;
      }

      return `
      <div class="bg-theme-bg-secondary rounded-theme-md p-4 border border-theme-border break-inside-avoid mb-4 shadow-theme-md transition-theme duration-theme">
        <h2 class="text-lg font-bold text-theme-text mb-3">
          ${escapeHtml(p.name)}
          <span class="text-xs font-normal text-theme-text px-1.5 py-0.5 rounded-full bg-theme-bg-tertiary border border-theme-border ml-2">${escapeHtml(p.plan)}</span>
          ${billingTag}
        </h2>
        <div>
          ${modelsHtml}
        </div>
      </div>`;
    })
    .join('');

  const settingsRows = providers
    .map((p) => {
      const inputValue = toDateInputValue(billingOverrides[p.id]);
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
          onclick="clearBillingDate('${p.id}')"
        >
          Clear
        </button>
      </div>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en" data-theme="ocean-depths">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Creds</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            theme: {
              bg: 'var(--theme-bg)',
              'bg-secondary': 'var(--theme-bg-secondary)',
              'bg-tertiary': 'var(--theme-bg-tertiary)',
              text: 'var(--theme-text)',
              'text-secondary': 'var(--theme-text-secondary)',
              'text-tertiary': 'var(--theme-text-tertiary)',
              accent: 'var(--theme-accent)',
              'accent-hover': 'var(--theme-accent-hover)',
              'accent-text': 'var(--theme-accent-text)',
              border: 'var(--theme-border)',
              'border-light': 'var(--theme-border-light)',
              success: 'var(--theme-success)',
              warning: 'var(--theme-warning)',
              danger: 'var(--theme-danger)',
              spend: 'var(--theme-spend)',
            }
          },
          borderRadius: {
            'theme-sm': 'var(--theme-radius-sm)',
            'theme-md': 'var(--theme-radius-md)',
            'theme-lg': 'var(--theme-radius-lg)',
          },
          boxShadow: {
            'theme-sm': 'var(--theme-shadow-sm)',
            'theme-md': 'var(--theme-shadow-md)',
            'theme-lg': 'var(--theme-shadow-lg)',
            'theme-glow': 'var(--theme-shadow-glow)',
          },
          transitionDuration: {
            'theme': 'var(--theme-transition-speed)',
          },
          transitionTimingFunction: {
            'theme': 'var(--theme-transition-easing)',
          },
        }
      }
    }
  </script>
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

    /* ── Reset countdown ring ── */
    .reset-ring {
      flex-shrink: 0;
    }
    .reset-ring .track {
      stroke: var(--theme-border);
    }
    .reset-ring .fill {
      transition: stroke-dashoffset 1s ease-out, stroke 1.5s ease-out;
    }
    .reset-ring.positive .fill { stroke: var(--theme-success); }
    .reset-ring.neutral .fill { stroke: var(--theme-accent); }
    .reset-ring.negative .fill { stroke: var(--theme-warning); }
  </style>
</head>
<body class="bg-theme-bg text-theme-text min-h-screen theme-transition">
  <div class="max-w-5xl mx-auto px-4 py-8">
    <div class="flex flex-col gap-3 mb-6">
      <div class="flex items-center justify-between">
        <h1 class="text-2xl font-bold text-theme-text">AI Creds</h1>
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
      </div>

      <div class="inline-flex rounded-theme-sm bg-theme-bg-tertiary border border-theme-border p-1 w-fit">
        <button id="tab-dashboard-btn" onclick="showTab('dashboard')" class="tab-btn px-3 py-1.5 text-sm rounded-theme-sm bg-theme-accent text-theme-accent-text">Dashboard</button>
        <button id="tab-settings-btn" onclick="showTab('settings')" class="tab-btn px-3 py-1.5 text-sm rounded-theme-sm text-theme-text-secondary hover:bg-theme-bg-secondary/50 hover:text-theme-text transition-theme duration-theme">Settings</button>
      </div>
    </div>

    <div id="tab-dashboard" class="tab-panel">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4" id="dashboard">
        ${rows}
      </div>
    </div>

    <div id="tab-settings" class="tab-panel hidden">
      <div class="bg-theme-bg-secondary rounded-theme-md p-4 border border-theme-border shadow-theme-md">
        <h2 class="text-lg font-bold text-theme-text mb-1">Billing dates</h2>
        <p class="text-sm text-theme-text-secondary mb-3">Set manual billing end dates for providers.</p>
        <div class="space-y-2">${settingsRows}</div>
        <div class="mt-3 flex items-center gap-2">
          <button id="save-settings-btn" onclick="saveBillingSettings()" class="px-3 py-1.5 bg-theme-accent hover:bg-theme-accent-hover text-theme-accent-text rounded-theme-sm text-sm transition-theme duration-theme">Save</button>
          <span id="settings-status" class="text-xs text-theme-text-tertiary"></span>
        </div>
      </div>
    </div>

    <div id="status" class="mt-4 text-sm text-theme-text-tertiary text-center"></div>
  </div>
  <script>
    // ── Theme Manager ────────────────────────────────────────
    const ThemeManager = {
      themes: ${JSON.stringify(THEME_NAMES)},
      current: 0,

      init() {
        const saved = localStorage.getItem('ai-creds-theme');
        const idx = saved ? this.themes.indexOf(saved) : 0;
        this.setTheme(idx >= 0 ? idx : 0);
      },

      setTheme(index) {
        this.current = ((index % this.themes.length) + this.themes.length) % this.themes.length;
        const name = this.themes[this.current];
        document.documentElement.setAttribute('data-theme', name);
        localStorage.setItem('ai-creds-theme', name);
        this.updateStatus();
      },

      rotate() {
        this.setTheme(this.current + 1);
      },

      updateStatus() {
        const el = document.getElementById('status');
        if (el) {
          el.textContent = 'Theme: ' + this.themes[this.current].replace(/-/g, ' ');
          el.classList.add('opacity-100');
          setTimeout(() => el.classList.remove('opacity-100'), 1500);
        }
      }
    };

    // Hotkey: Ctrl+T / Cmd+T
    document.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 't') {
        e.preventDefault();
        ThemeManager.rotate();
      }
    });

    ThemeManager.init();

    // ── Tabs ───────────────────────────────────────────────
    function showTab(tabName) {
      const dashboardTab = document.getElementById('tab-dashboard');
      const settingsTab = document.getElementById('tab-settings');
      const dashboardBtn = document.getElementById('tab-dashboard-btn');
      const settingsBtn = document.getElementById('tab-settings-btn');

      if (!dashboardTab || !settingsTab || !dashboardBtn || !settingsBtn) return;

      const isDashboard = tabName === 'dashboard';
      dashboardTab.classList.toggle('hidden', !isDashboard);
      settingsTab.classList.toggle('hidden', isDashboard);

      dashboardBtn.classList.toggle('bg-theme-accent', isDashboard);
      dashboardBtn.classList.toggle('text-theme-accent-text', isDashboard);
      dashboardBtn.classList.toggle('text-theme-text-secondary', !isDashboard);

      settingsBtn.classList.toggle('bg-theme-accent', !isDashboard);
      settingsBtn.classList.toggle('text-theme-accent-text', !isDashboard);
      settingsBtn.classList.toggle('text-theme-text-secondary', isDashboard);
    }

    function markBillingDirty(providerId) {
      const row = document.querySelector('[data-provider-id="' + providerId + '"]');
      if (row) row.dataset.dirty = 'true';
    }

    function clearBillingDate(providerId) {
      const row = document.querySelector('[data-provider-id="' + providerId + '"]');
      if (!row) return;
      const input = row.querySelector('.billing-date-input');
      if (input) {
        input.value = '';
        row.dataset.dirty = 'true';
      }
    }

    async function saveBillingSettings() {
      const status = document.getElementById('settings-status');
      const saveBtn = document.getElementById('save-settings-btn');
      const rows = document.querySelectorAll('[data-provider-id]');

      const billingOverrides = {};
      for (const row of rows) {
        const providerId = row.getAttribute('data-provider-id');
        const input = row.querySelector('.billing-date-input');
        if (!providerId || !input) continue;

        // Only include providers the user actually modified
        if (row.dataset.dirty !== 'true') continue;

        const raw = String(input.value || '').trim();
        if (!raw) {
          continue;
        }

        // Accept both YYYY-MM-DD and YYYY-MM-DDTHH:mm:ss.sssZ
        const match = /^(\\d{4}-\\d{2}-\\d{2})/.exec(raw);
        if (!match) {
          if (status) status.textContent = 'Invalid date format. Got: ' + raw;
          return;
        }

        billingOverrides[providerId] = match[1] + 'T00:00:00.000Z';
      }

      if (status) status.textContent = 'saving...';
      if (saveBtn) saveBtn.disabled = true;

      try {
        const response = await fetch('/api/settings/billing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ billingOverrides }),
        });

        if (!response.ok) {
          if (status) status.textContent = 'save error';
          return;
        }

        if (status) status.textContent = 'saved';
        window.location.reload();
      } catch {
        if (status) status.textContent = 'save error';
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    }

    showTab('dashboard');

    // ── Refresh progress circle ─────────────────────────────
    const REFRESH_INTERVAL_MS = 30_000;
    const CIRCUMFERENCE = ${REFRESH_CIRCUMFERENCE};

    const progressCircle = document.getElementById('refresh-circle');
    const progressEl = progressCircle?.querySelector('.progress');

    function updateRefreshCircle() {
      if (!progressCircle || !progressEl) return;

      const ts = parseInt(progressCircle.dataset.updated, 10);
      if (!ts) {
        progressEl.style.strokeDashoffset = CIRCUMFERENCE;
        progressCircle.className = 'refresh-circle normal';
        return;
      }

      const elapsed = Date.now() - ts;
      const fraction = Math.min(1, elapsed / REFRESH_INTERVAL_MS);
      const offset = CIRCUMFERENCE * (1 - fraction);
      progressEl.style.strokeDashoffset = offset;

      // Color logic:
      // - fresh (< 30% of interval): positive (success color)
      // - mid (30-70%): neutral (accent color)
      // - stale (> 70%): depends on max usage
      //   - high usage (> 50%): negative (warning color)
      //   - low usage: neutral (accent color)
      const maxUsage = parseFloat(progressCircle.dataset.maxUsage) || 0;

      let colorClass;
      if (fraction < 0.3) {
        colorClass = 'fresh';
      } else if (fraction < 0.7) {
        colorClass = 'normal';
      } else {
        colorClass = maxUsage > 50 ? 'stale' : 'normal';
      }

      progressCircle.className = 'refresh-circle ' + colorClass;
    }

    setInterval(updateRefreshCircle, 1000);
    updateRefreshCircle();


    // ── Refresh ──────────────────────────────────────────────
    async function refresh() {
      const status = document.getElementById('status');
      const btn = document.getElementById('refresh-btn');
      const spinner = document.getElementById('refresh-spinner');
      status.textContent = 'updating...';
      btn.disabled = true;
      if (spinner) spinner.classList.remove('hidden');
      try {
        const r = await fetch('/api/refresh', { method: 'POST' });
        if (r.ok) window.location.reload();
        else status.textContent = 'update error';
      } catch (e) {
        status.textContent = 'update error';
      } finally {
        btn.disabled = false;
        if (spinner) spinner.classList.add('hidden');
      }
    }
  </script>
</body>
</html>`;
}
