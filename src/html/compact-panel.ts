import type { Provider } from '../provider.js';
import {
  escapeHtml,
  findWindow,
  formatNumber,
  formatTimeUntil,
  updatedLabelSpan,
} from './usage-renderers.js';

// ── Per-provider compact lines ───────────────────────────────

/** Line renderer: extracts a concise display string from a provider card. */
type CompactLine = (provider: Provider) => string | null;

/** First window with the given label that also carries a valueLabel. */
const valueLabelLine =
  (label: string): CompactLine =>
  (provider) => {
    const win = findWindow(provider, (w) => w.label === label && !!w.valueLabel);

    return win?.valueLabel ? escapeHtml(win.valueLabel) : null;
  };

/** First window carrying any valueLabel at all. */
function anyValueLabelLine(provider: Provider): string | null {
  const win = findWindow(provider, (w) => !!w.valueLabel);

  return win?.valueLabel ? escapeHtml(win.valueLabel) : null;
}

function formatResetTime(resetAt: string | null): string {
  if (!resetAt) {
    return '';
  }

  return formatTimeUntil(new Date(resetAt).getTime() - Date.now());
}

/** Find the `monthly` window with a known used-percent; shared by percent-based lines. */
function monthlyPercent(provider: Provider): {
  usedPercent: number;
  used: number | null;
  total: number | null;
  resetAt: string | null;
} | null {
  const win = findWindow(provider, (w) => w.label === 'monthly' && w.usedPercent != null);

  if (!win || win.usedPercent == null) {
    return null;
  }

  return {
    usedPercent: win.usedPercent,
    used: win.used,
    total: win.total,
    resetAt: win.resetAt,
  };
}

function grokLine(provider: Provider): string | null {
  const found = monthlyPercent(provider);

  if (!found) {
    return null;
  }

  const timeText = formatResetTime(found.resetAt);

  return `${found.usedPercent.toFixed(1)}%${timeText ? ` · ${timeText}` : ''}`;
}

function context7Line(provider: Provider): string | null {
  const found = monthlyPercent(provider);

  if (!found) {
    return null;
  }

  const parts = [`${found.usedPercent.toFixed(0)}% used`];

  if (found.used != null && found.total != null) {
    parts.push(`${formatNumber(found.used)} / ${formatNumber(found.total)}`);
  }

  return parts.join(' · ');
}

/** All count-based windows as `label: used / total` lines. */
function tavilyLines(provider: Provider): string | null {
  const lines: string[] = [];

  for (const model of provider.models) {
    for (const win of model.windows) {
      if (win.used != null && win.total != null) {
        lines.push(
          `${escapeHtml(win.label)}: ${formatNumber(win.used)} / ${formatNumber(win.total)}`,
        );
      }
    }
  }

  return lines.length === 0 ? null : lines.join('<br>');
}

const COMPACT_LINES: Record<string, CompactLine> = {
  brave: valueLabelLine('monthly'),
  context7: context7Line,
  deepseek: anyValueLabelLine,
  evolink: valueLabelLine('User'),
  firecrawl: valueLabelLine('credits'),
  grok: grokLine,
  opencode: valueLabelLine('balance'),
  openrouter: valueLabelLine('credits'),
  tavily: tavilyLines,
  'tavily-2': tavilyLines,
  'tavily-3': tavilyLines,
};

const COMPACT_PROVIDER_IDS = new Set(Object.keys(COMPACT_LINES));

// ── Renderer ────────────────────────────────────────────────

export function isCompactProvider(provider: Provider): boolean {
  return COMPACT_PROVIDER_IDS.has(provider.id);
}

/** Extract a concise display line for a compact card, or null if not applicable. */
function extractItem(provider: Provider): string | null {
  if (provider.error) {
    return null;
  }

  const line = COMPACT_LINES[provider.id];

  return line ? line(provider) : null;
}

function renderCompactTimeLabel(provider: Provider): string {
  if (provider.updatedAt == null) {
    return '';
  }

  return updatedLabelSpan(
    provider.updatedAt,
    'absolute top-2 right-2 text-[0.65rem] text-theme-text-tertiary/40 italic',
  );
}

export function renderCompactPanel(providers: Provider[]): string {
  const compactProviders = providers.filter(isCompactProvider);

  if (compactProviders.length === 0) {
    return '';
  }

  const cards = compactProviders
    .map((p) => {
      const item = extractItem(p);

      if (!item) {
        return '';
      }

      const timeLabel = renderCompactTimeLabel(p);

      return `
    <div class="relative bg-theme-bg-secondary border border-theme-border rounded-theme-md p-3 shadow-theme-sm">
      ${timeLabel}
      <div class="flex items-center justify-between mb-1">
        <div class="text-xs font-semibold text-theme-text-secondary uppercase tracking-wider">${escapeHtml(p.name)}</div>
      </div>
      <div class="text-sm font-mono text-theme-text">${item}</div>
    </div>`;
    })
    .filter(Boolean)
    .join('');

  if (!cards) {
    return '';
  }

  return `
<div class="space-y-2">
  ${cards}
</div>`;
}
