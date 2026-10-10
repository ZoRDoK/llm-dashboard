import { MS_PER_HOUR } from '../constants.js';
import type { Provider } from '../provider.js';
import type { UsageWindow } from '../usage-window.js';
import { escapeHtml, formatTimeUntil } from './usage-renderers.js';

// ── Types ───────────────────────────────────────────────────

interface UrgentConfig {
  model: string;
  window: string;
  thresholdHours: number;
  priority: number;
}

interface QualifiedItem {
  providerName: string;
  hoursUntilReset: number;
  urgency: number;
  usedPercent: number | null;
  thresholdHours: number;
  windowLabel: string;
}

// ── Constants ───────────────────────────────────────────────

const URGENCY_OFFSET = 0.5;

const PERCENT_MAX = 100;

const SPENT_THRESHOLD = 95;
const DESIRABLE_COUNT = 2;

const URGENT_PROVIDERS: Record<string, UrgentConfig> = {
  'opencode-go': { model: 'Go Plan', window: 'weekly', thresholdHours: 48, priority: 1.3 },
  'ollama-cloud': { model: 'Cloud Usage', window: 'weekly', thresholdHours: 48, priority: 1.3 },
  codex: { model: 'plus', window: 'weekly', thresholdHours: 48, priority: 1.5 },
  'routing-sh': { model: 'Requests', window: '5h', thresholdHours: 5, priority: 0.8 },
  kimi: { model: 'Coding', window: 'weekly', thresholdHours: 48, priority: 1.0 },
  zai: { model: 'Quota', window: 'weekly', thresholdHours: 48, priority: 1.0 },
  claude: { model: 'Claude', window: 'weekly', thresholdHours: 48, priority: 1.2 },
  mimo: { model: 'Token Plan', window: 'monthly', thresholdHours: 96, priority: 1.0 },
};

// ── Checkers ────────────────────────────────────────────────

function checkUrgentWindow(
  providerName: string,
  config: UrgentConfig,
  windows: UsageWindow[],
): QualifiedItem | null {
  for (const window_ of windows) {
    if (window_.label !== config.window || !window_.resetAt) {
      continue;
    }

    const resetMs = new Date(window_.resetAt).getTime();
    const now = Date.now();
    const hoursUntilReset = (resetMs - now) / MS_PER_HOUR;

    if (!Number.isFinite(hoursUntilReset) || hoursUntilReset <= 0) {
      continue;
    }

    const usedPercent = window_.usedPercent ?? null;

    const remainingPercent =
      window_.remainingPercent ?? (usedPercent == null ? PERCENT_MAX : PERCENT_MAX - usedPercent);

    const urgency = (remainingPercent * config.priority) / (hoursUntilReset + URGENCY_OFFSET);

    return {
      providerName,
      hoursUntilReset,
      urgency,
      usedPercent,
      thresholdHours: config.thresholdHours,
      windowLabel: window_.label,
    };
  }

  return null;
}

function checkUrgentProvider(provider: Provider, config: UrgentConfig): QualifiedItem | null {
  for (const model of provider.models) {
    if (model.modelName !== config.model) {
      continue;
    }

    const item = checkUrgentWindow(provider.name, config, model.windows);

    if (item) {
      return item;
    }
  }

  return null;
}

// ── Renderer ────────────────────────────────────────────────

const buildRows = (items: QualifiedItem[]): string => {
  return items
    .map((item) => {
      const timeText = formatTimeUntil(item.hoursUntilReset * MS_PER_HOUR);

      return `<div class="flex justify-between text-xs font-mono">
        <span>${escapeHtml(item.providerName)}</span>
        <span class="text-theme-text-secondary">${item.windowLabel} ${timeText}</span>
      </div>`;
    })
    .join('');
};

const renderModePanel = (items: QualifiedItem[], dotClass: string, title: string): string => {
  const rows = buildRows(items);

  return `
<div class="urgent-panel bg-theme-bg-secondary border border-theme-border rounded-theme-md p-3 shadow-theme-md max-w-xs">
  <div class="flex items-center gap-2 mb-2">
    <span class="inline-block w-2 h-2 rounded-full ${dotClass}"></span>
    <span class="text-sm font-semibold text-theme-text">${title}</span>
  </div>
  <div class="space-y-1">
    ${rows}
  </div>
</div>`;
};

function findNearestWindow(provider: Provider, config: UrgentConfig): QualifiedItem | null {
  let nearest: QualifiedItem | null = null;

  for (const model of provider.models) {
    if (model.modelName !== config.model) {
      continue;
    }

    const candidate = nearestInWindows(provider.name, config, model.windows);

    if (candidate && (!nearest || candidate.hoursUntilReset < nearest.hoursUntilReset)) {
      nearest = candidate;
    }
  }

  return nearest;
}

function nearestInWindows(
  providerName: string,
  config: UrgentConfig,
  windows: UsageWindow[],
): QualifiedItem | null {
  let nearest: QualifiedItem | null = null;

  for (const window_ of windows) {
    const candidate = tryDesirableWindow(providerName, config, window_);

    if (candidate && (!nearest || candidate.hoursUntilReset < nearest.hoursUntilReset)) {
      nearest = candidate;
    }
  }

  return nearest;
}

function tryDesirableWindow(
  providerName: string,
  config: UrgentConfig,
  window_: UsageWindow,
): QualifiedItem | null {
  if (!window_.resetAt) {
    return null;
  }

  const hoursUntilReset = (new Date(window_.resetAt).getTime() - Date.now()) / MS_PER_HOUR;

  if (!Number.isFinite(hoursUntilReset) || hoursUntilReset <= 0) {
    return null;
  }

  const usedPercent = window_.usedPercent ?? null;

  if (usedPercent !== null && usedPercent >= SPENT_THRESHOLD) {
    return null;
  }

  const remainingPercent =
    window_.remainingPercent ?? (usedPercent == null ? PERCENT_MAX : PERCENT_MAX - usedPercent);

  return {
    providerName,
    hoursUntilReset,
    urgency: (remainingPercent * config.priority) / (hoursUntilReset + URGENCY_OFFSET),
    usedPercent,
    thresholdHours: config.thresholdHours,
    windowLabel: window_.label,
  };
}

function collectDesirableCandidates(
  providers: Provider[],
  excludedIds: QualifiedItem[],
): QualifiedItem[] {
  const excluded = new Set(excludedIds.map((item) => item.providerName));
  const results: QualifiedItem[] = [];

  for (const provider of providers) {
    const config = URGENT_PROVIDERS[provider.id];

    if (!config || excluded.has(provider.name)) {
      continue;
    }

    const nearest = findNearestWindow(provider, config);

    if (nearest) {
      results.push(nearest);
    }
  }

  results.sort((a, b) => a.hoursUntilReset - b.hoursUntilReset);

  return results;
}

export function renderUrgentPanel(providers: Provider[]): string {
  const candidates: QualifiedItem[] = [];

  for (const provider of providers) {
    const config = URGENT_PROVIDERS[provider.id];

    if (!config) {
      continue;
    }

    const item = checkUrgentProvider(provider, config);

    if (item) {
      candidates.push(item);
    }
  }

  const viable = candidates.filter(
    (item) => item.usedPercent === null || item.usedPercent < SPENT_THRESHOLD,
  );

  if (viable.length === 0) {
    return '';
  }

  const urgent = viable.filter((item) => item.hoursUntilReset < item.thresholdHours);

  if (urgent.length > 0) {
    urgent.sort((a, b) => b.urgency - a.urgency);

    return renderModePanel(urgent, 'bg-orange-500', 'Spend urgently');
  }

  // Desirable mode: find nearest-reset window across ALL windows for each provider
  const desirable = collectDesirableCandidates(providers, viable);

  if (desirable.length > 0) {
    return renderModePanel(desirable.slice(0, DESIRABLE_COUNT), 'bg-blue-400', 'Consider spending');
  }

  return '';
}
