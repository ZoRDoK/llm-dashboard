/**
 * Server-rendered P Charts page: token usage aggregated from pi session logs.
 * Tokens only — no dollar amounts anywhere (subscriptions make costs meaningless).
 * All charts are plain server-rendered SVG/div bars; no JS chart libraries.
 */
import type {
  PiDayBucket,
  PiModelRow,
  PiProjectRow,
  PiProviderRow,
  PiUsageStats,
} from '../pi-usage.js';
import { PI_PROJECT_HOME_PREFIX } from '../pi-usage.js';
import { THEME_NAMES, tailwindCSS, themeCSS } from './themes.js';
import { emptyState, escapeHtml, formatNumber } from './usage-renderers.js';

// ── Types ───────────────────────────────────────────────────

export type PChartsRange = '7' | '30' | '90' | 'all';

// ── Constants ───────────────────────────────────────────────

const RANGE_OPTIONS: { key: PChartsRange; label: string }[] = [
  { key: '7', label: '7d' },
  { key: '30', label: '30d' },
  { key: '90', label: '90d' },
  { key: 'all', label: 'All' },
];

const TOKEN_UNIT_K = 1_000;
const TOKEN_UNIT_M = 1_000_000;
const TOKEN_UNIT_B = 1_000_000_000;

const DAY_LABEL_FROM = 5;
const X_LABEL_Y_OFFSET = 8;
const PERCENT_SCALE = 100;
const MIN_BAR_PCT = 1;

// Stacked-bar component colors: theme CSS vars with sensible fallbacks.
const BAR_COLOR_CACHE_READ = 'var(--theme-accent, #6366f1)';
const BAR_COLOR_CACHE_WRITE = 'var(--theme-success, #22c55e)';
const BAR_COLOR_INPUT = 'var(--theme-warning, #eab308)';
const BAR_COLOR_OUTPUT = 'var(--theme-spend, #ef4444)';

const CHART_WIDTH = 1000;
const CHART_HEIGHT = 260;
const CHART_PAD_LEFT = 56;
const CHART_PAD_RIGHT = 12;
const CHART_PAD_TOP = 10;
const CHART_PAD_BOTTOM = 26;
const GRID_LINE_COUNT = 4;
const MAX_X_LABELS = 10;
const MIN_BAR_HEIGHT = 0.5;
const AXIS_LABEL_FONT = 10;
const Y_LABEL_OFFSET = 6;
const X_LABEL_BASELINE_OFFSET = 3;
const BAR_WIDTH_FRACTION = 0.7;
const MIN_BAR_WIDTH = 1;

// ── Formatting helpers ──────────────────────────────────────

function formatTokens(value: number): string {
  if (value >= TOKEN_UNIT_B) {
    return `${(value / TOKEN_UNIT_B).toFixed(2)}B`;
  }

  if (value >= TOKEN_UNIT_M) {
    return `${(value / TOKEN_UNIT_M).toFixed(1)}M`;
  }

  if (value >= TOKEN_UNIT_K) {
    return `${(value / TOKEN_UNIT_K).toFixed(1)}K`;
  }

  return String(value);
}

/** Prettier project name: strip the home/dev/projects slug prefix, keep the rest. */
function projectDisplayName(project: string): string {
  return project.startsWith(PI_PROJECT_HOME_PREFIX)
    ? project.slice(PI_PROJECT_HOME_PREFIX.length)
    : project;
}

// ── Page head (mirrors html.ts documentHead, minimal subset) ──

function pageHead(title: string): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="ocean-depths">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%20width%3D%2232%22%20height%3D%2232%22%3E%3Ccircle%20cx%3D%2216%22%20cy%3D%2216%22%20r%3D%2215%22%20fill%3D%22%23000000%22%2F%3E%3Ctext%20x%3D%2216%22%20y%3D%2222%22%20text-anchor%3D%22middle%22%20font-family%3D%22monospace%2C%20Courier%20New%22%20font-weight%3D%22700%22%20font-size%3D%2219%22%20fill%3D%22%23ffffff%22%3EAI%3C%2Ftext%3E%3Ctext%20x%3D%2231%22%20y%3D%2232%22%20text-anchor%3D%22end%22%20font-family%3D%22monospace%2C%20Courier%20New%22%20font-weight%3D%22700%22%20font-size%3D%2216%22%20fill%3D%22%2322c55e%22%3E%24%3C%2Ftext%3E%3C%2Fsvg%3E">
  <style>
    /* ── Locally built Tailwind utilities (design/tailwind.css, no CDN) ── */
    ${tailwindCSS}
  </style>
  <style>
${themeCSS}
  </style>
</head>`;
}

/** Minimal theme manager: restore from localStorage + Ctrl+T rotation. */
function themeScript(): string {
  return `    const ThemeManager = {
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
      },
      rotate() {
        this.setTheme(this.current + 1);
      }
    };
    document.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 't') {
        e.preventDefault();
        ThemeManager.rotate();
      }
    });
    ThemeManager.init();`;
}

// ── Header / status ─────────────────────────────────────────

function rangeLinks(active: PChartsRange): string {
  const links = RANGE_OPTIONS.map((option) => {
    const activeClass =
      option.key === active
        ? 'bg-theme-accent text-theme-accent-text'
        : 'text-theme-text-secondary hover:bg-theme-bg-secondary/50 hover:text-theme-text';

    return `<a href="/p-charts?range=${option.key}" class="px-3 py-1.5 text-sm rounded-theme-sm transition-theme duration-theme ${activeClass}">${option.label}</a>`;
  });

  return links.join('');
}

function headerRow(range: PChartsRange): string {
  return `    <div class="flex flex-wrap items-center justify-between gap-3 mb-6">
      <div class="flex items-center gap-4">
        <a href="/" class="text-sm text-theme-text-secondary hover:text-theme-text transition-theme duration-theme" title="Back to the dashboard">&larr; Dashboard</a>
        <h1 class="text-2xl font-bold text-theme-text">P Charts</h1>
      </div>
      <div class="flex items-center gap-3">
        <div class="inline-flex rounded-theme-sm bg-theme-bg-tertiary border border-theme-border p-1">
          ${rangeLinks(range)}
        </div>
        <button onclick="ThemeManager.rotate()"
          class="p-1.5 rounded-theme-sm bg-theme-bg-tertiary hover:bg-theme-bg-secondary transition-theme duration-theme"
          title="Switch theme (Ctrl+T)">
          <svg class="w-4 h-4 text-theme-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4.098 19.902a3.75 3.75 0 005.304 0l6.401-6.402M6.75 21A3.75 3.75 0 013 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 003.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.879 2.88M6.75 17.25h.008v.008H6.75v-.008z" />
          </svg>
        </button>
      </div>
    </div>`;
}

function statusLine(stats: PiUsageStats, range: PChartsRange): string {
  const status = stats.status;
  const refreshHref = `/p-charts?range=${range}`;
  const errorHtml = status.error
    ? `<span class="text-red-500"> · ${escapeHtml(status.error)}</span>`
    : '';

  const stateHtml = status.running
    ? `Indexing ${formatNumber(status.scanned)}/${formatNumber(status.total)} files&hellip;`
    : `Up to date · ${formatNumber(stats.allTimeTotals.sessions)} sessions · ${formatNumber(stats.allTimeTotals.models)} models`;

  return `    <div class="flex items-center gap-3 mb-4 text-sm text-theme-text-secondary">
      <span>${stateHtml}${errorHtml}</span>
      <a href="${refreshHref}" class="text-xs text-theme-text-tertiary hover:text-theme-text underline transition-theme duration-theme">Refresh</a>
    </div>`;
}

// ── KPI cards ───────────────────────────────────────────────

function kpiCard(label: string, value: string, sub: string): string {
  const subHtml =
    sub === '' ? '' : `<div class="text-xs text-theme-text-tertiary mt-1">${sub}</div>`;

  return `<div class="bg-theme-bg-secondary rounded-theme-md p-4 border border-theme-border shadow-theme-sm">
      <div class="text-xs text-theme-text-secondary uppercase tracking-wide">${label}</div>
      <div class="text-2xl font-bold text-theme-text font-mono mt-1">${value}</div>
      ${subHtml}
    </div>`;
}

function kpiCards(stats: PiUsageStats): string {
  const { totals, allTimeTotals } = stats;
  const cards = [
    kpiCard(
      'Total tokens',
      formatTokens(totals.total),
      `All time: ${formatTokens(allTimeTotals.total)} tokens`,
    ),
    kpiCard('Input', formatTokens(totals.input), ''),
    kpiCard('Output', formatTokens(totals.output), ''),
    kpiCard('Cache read', formatTokens(totals.cacheRead), ''),
    kpiCard('Assistant calls', formatNumber(totals.calls), ''),
  ];

  return `<div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">${cards.join('')}</div>`;
}

// ── Daily stacked bar chart (SVG) ───────────────────────────

function chartLegend(): string {
  const items = [
    { color: BAR_COLOR_CACHE_READ, label: 'cache read' },
    { color: BAR_COLOR_CACHE_WRITE, label: 'cache write' },
    { color: BAR_COLOR_INPUT, label: 'input' },
    { color: BAR_COLOR_OUTPUT, label: 'output' },
  ];

  const dots = items.map(
    (item) =>
      `<span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-sm inline-block" style="background:${item.color}"></span>${item.label}</span>`,
  );

  return `<div class="flex flex-wrap items-center gap-4 text-xs text-theme-text-secondary mb-2">${dots.join('')}</div>`;
}

/** One stacked day bar (cacheRead + cacheWrite + input + output) with a hover title. */
function dayBar(
  bucket: PiDayBucket,
  x: number,
  barWidth: number,
  baseY: number,
  plotHeight: number,
  maxTotal: number,
): string {
  const segments = [
    { value: bucket.cacheRead, color: BAR_COLOR_CACHE_READ, label: 'cache read' },
    { value: bucket.cacheWrite, color: BAR_COLOR_CACHE_WRITE, label: 'cache write' },
    { value: bucket.input, color: BAR_COLOR_INPUT, label: 'input' },
    { value: bucket.output, color: BAR_COLOR_OUTPUT, label: 'output' },
  ];

  const rects: string[] = [];
  let cursor = baseY;

  for (const segment of segments) {
    if (segment.value <= 0) {
      continue;
    }

    const height = Math.max((segment.value / maxTotal) * plotHeight, MIN_BAR_HEIGHT);

    cursor -= height;

    rects.push(
      `<rect x="${x.toFixed(1)}" y="${cursor.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${height.toFixed(1)}" fill="${segment.color}" rx="1"/>`,
    );
  }

  const title = `${bucket.day} — total ${formatTokens(bucket.total)} (in ${formatTokens(bucket.input)} · out ${formatTokens(bucket.output)} · cache read ${formatTokens(bucket.cacheRead)} · cache write ${formatTokens(bucket.cacheWrite)})`;

  return `<g><title>${escapeHtml(title)}</title>${rects.join('')}</g>`;
}

function dailyChartSvg(buckets: PiDayBucket[]): string {
  const plotWidth = CHART_WIDTH - CHART_PAD_LEFT - CHART_PAD_RIGHT;
  const plotHeight = CHART_HEIGHT - CHART_PAD_TOP - CHART_PAD_BOTTOM;
  const baseY = CHART_PAD_TOP + plotHeight;
  const maxTotal = Math.max(...buckets.map((bucket) => bucket.total), 1);

  const parts: string[] = [];

  for (let i = 1; i <= GRID_LINE_COUNT; i++) {
    const value = (maxTotal * i) / GRID_LINE_COUNT;
    const y = baseY - (plotHeight * i) / GRID_LINE_COUNT;

    parts.push(
      `<line x1="${CHART_PAD_LEFT}" y1="${y.toFixed(1)}" x2="${CHART_WIDTH - CHART_PAD_RIGHT}" y2="${y.toFixed(1)}" stroke="var(--theme-border-light, #333)" stroke-width="1"/>`,
    );
    parts.push(
      `<text x="${CHART_PAD_LEFT - Y_LABEL_OFFSET}" y="${(y + X_LABEL_BASELINE_OFFSET).toFixed(1)}" text-anchor="end" font-size="${AXIS_LABEL_FONT}" fill="var(--theme-text-tertiary, #888)">${formatTokens(value)}</text>`,
    );
  }

  const slot = plotWidth / buckets.length;
  const barWidth = Math.max(slot * BAR_WIDTH_FRACTION, MIN_BAR_WIDTH);
  const labelStep = Math.ceil(buckets.length / MAX_X_LABELS);

  for (const [index, bucket] of buckets.entries()) {
    const x = CHART_PAD_LEFT + index * slot + (slot - barWidth) / 2;

    parts.push(dayBar(bucket, x, barWidth, baseY, plotHeight, maxTotal));

    if (index % labelStep === 0) {
      const centerX = x + barWidth / 2;

      parts.push(
        `<text x="${centerX.toFixed(1)}" y="${CHART_HEIGHT - X_LABEL_Y_OFFSET}" text-anchor="middle" font-size="${AXIS_LABEL_FONT}" fill="var(--theme-text-tertiary, #888)">${escapeHtml(bucket.day.slice(DAY_LABEL_FROM))}</text>`,
      );
    }
  }

  return `<svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" class="w-full" role="img" aria-label="Daily token usage">${parts.join('')}</svg>`;
}

function chartCard(buckets: PiDayBucket[]): string {
  return `<div class="bg-theme-bg-secondary rounded-theme-md p-4 border border-theme-border shadow-theme-md mb-4">
      <h2 class="text-lg font-bold text-theme-text mb-3">Daily tokens</h2>
      ${chartLegend()}
      ${dailyChartSvg(buckets)}
    </div>`;
}

// ── Horizontal stacked bars ─────────────────────────────────

interface SegmentSource {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function stackedTrack(row: SegmentSource): string {
  const total = row.input + row.output + row.cacheRead + row.cacheWrite;

  if (total <= 0) {
    return '<div class="h-2.5 rounded-full bg-theme-bg-tertiary"></div>';
  }

  const segments = [
    { value: row.cacheRead, color: BAR_COLOR_CACHE_READ, label: 'cache read' },
    { value: row.cacheWrite, color: BAR_COLOR_CACHE_WRITE, label: 'cache write' },
    { value: row.input, color: BAR_COLOR_INPUT, label: 'input' },
    { value: row.output, color: BAR_COLOR_OUTPUT, label: 'output' },
  ];

  const spans = segments
    .filter((segment) => segment.value > 0)
    .map(
      (segment) =>
        `<span class="inline-block h-full" style="width:${((segment.value / total) * PERCENT_SCALE).toFixed(2)}%;background:${segment.color}" title="${segment.label} ${formatTokens(segment.value)}"></span>`,
    );

  return `<div class="h-2.5 rounded-full overflow-hidden bg-theme-bg-tertiary flex">${spans.join('')}</div>`;
}

function modelRowHtml(row: PiModelRow): string {
  const sharePct = (row.share * PERCENT_SCALE).toFixed(1);

  return `<div class="mb-3">
      <div class="flex justify-between items-baseline gap-2 mb-1">
        <span class="text-sm text-theme-text truncate" title="${escapeHtml(row.model)}">${escapeHtml(row.model)}</span>
        <span class="text-xs text-theme-text-secondary font-mono whitespace-nowrap">${formatTokens(row.total)} · ${sharePct}% · ${formatNumber(row.calls)} calls</span>
      </div>
      ${stackedTrack(row)}
    </div>`;
}

function providerRowHtml(row: PiProviderRow): string {
  return `<div class="mb-3">
      <div class="flex justify-between items-baseline gap-2 mb-1">
        <span class="text-sm text-theme-text truncate" title="${escapeHtml(row.provider)}">${escapeHtml(row.provider)}</span>
        <span class="text-xs text-theme-text-secondary font-mono whitespace-nowrap">${formatTokens(row.total)} · ${formatNumber(row.calls)} calls</span>
      </div>
      ${stackedTrack(row)}
    </div>`;
}

function projectRowHtml(row: PiProjectRow, maxTotal: number): string {
  const name = projectDisplayName(row.project);
  const width = maxTotal > 0 ? Math.max((row.total / maxTotal) * PERCENT_SCALE, MIN_BAR_PCT) : 0;

  return `<div class="mb-3">
      <div class="flex justify-between items-baseline gap-2 mb-1">
        <span class="text-sm text-theme-text truncate" title="${escapeHtml(row.project)}">${escapeHtml(name)}</span>
        <span class="text-xs text-theme-text-secondary font-mono whitespace-nowrap">${formatTokens(row.total)} · ${formatNumber(row.sessions)} sessions</span>
      </div>
      <div class="h-2.5 rounded-full bg-theme-bg-tertiary">
        <div class="h-2.5 rounded-full" style="width:${width.toFixed(1)}%;background:${BAR_COLOR_CACHE_READ}"></div>
      </div>
    </div>`;
}

function card(title: string, body: string): string {
  return `<div class="bg-theme-bg-secondary rounded-theme-md p-4 border border-theme-border shadow-theme-md">
      <h2 class="text-base font-bold text-theme-text mb-3">${title}</h2>
      ${body}
    </div>`;
}

function breakdownGrid(stats: PiUsageStats): string {
  const maxProjectTotal = Math.max(...stats.byProject.map((row) => row.total), 0);

  const modelBody =
    stats.byModel.length > 0
      ? stats.byModel.map(modelRowHtml).join('')
      : emptyState('No model usage in range');
  const providerBody =
    stats.byProvider.length > 0
      ? stats.byProvider.map(providerRowHtml).join('')
      : emptyState('No provider usage in range');
  const projectBody =
    stats.byProject.length > 0
      ? stats.byProject.map((row) => projectRowHtml(row, maxProjectTotal)).join('')
      : emptyState('No project usage in range');

  return `<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      ${card('By model', modelBody)}
      ${card('By provider', providerBody)}
      ${card('By project', projectBody)}
    </div>`;
}

// ── Main render ─────────────────────────────────────────────

export function renderPChartsPage(stats: PiUsageStats, range: PChartsRange): string {
  const hasData = stats.totals.calls > 0 || stats.totals.total > 0;
  const main = hasData
    ? `${kpiCards(stats)}
${chartCard(stats.byDay)}
${breakdownGrid(stats)}`
    : `<div class="bg-theme-bg-secondary rounded-theme-md p-6 border border-theme-border mb-4">${emptyState('No pi usage indexed yet')}</div>`;

  return `${pageHead('P Charts')}
<body class="bg-theme-bg text-theme-text min-h-screen theme-transition">
  <div class="max-w-5xl mx-auto px-4 py-8">
${headerRow(range)}
${statusLine(stats, range)}
${main}
    <p class="mt-6 text-xs text-theme-text-tertiary text-center">Tokens as reported by pi session logs. Cache reads are cached prompt tokens.</p>
    <div id="status" class="mt-4 text-sm text-theme-text-tertiary text-center"></div>
  </div>
  <script>
${themeScript()}
  </script>
</body>
</html>`;
}
