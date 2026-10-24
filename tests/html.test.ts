import { describe, expect, it } from 'vitest';
import { renderLogsPanel } from '../src/html/logs-panel.js';
import { renderMetricsPanel } from '../src/html/metrics-panel.js';
import { renderDashboard } from '../src/html.js';
import { Provider } from '../src/provider.js';
import { formatElapsed } from '../src/time-utils.js';
import type { LogEntry, ProviderMetrics } from '../src/types.js';
import { UsageWindow } from '../src/usage-window.js';

// Time constants in milliseconds — spelled out to pass noMagicNumbers.
const FIVE_SECONDS = 5_000;
const FIFTY_NINE_SECONDS = 59_000;
const ONE_MINUTE = 60_000;
const FIFTY_NINE_MINUTES = 3_540_000;
const ONE_HOUR = 3_600_000;
const TWENTY_THREE_HOURS = 82_800_000;
const ONE_DAY = 86_400_000;
const THREE_POINT_SEVEN_DAYS = 3.7;

// Percent constants for dashboard coverage.
const PCT_HALF = 50;
const PCT_THIRTY = 30;
const PCT_SEVENTY = 70;

// Billing-offset constants in milliseconds.
const THREE_DAYS_MS = 259_200_000;
const TEN_DAYS_MS = 864_000_000;

// Metrics / logs timestamp constants.
const NOW = 1_700_000_000_000;
const ONE_HOUR_MS = 3_600_000;
const ONE_HOUR_AGO = NOW - ONE_HOUR_MS;
const RECENT = NOW - ONE_MINUTE;

// ── formatElapsed ───────────────────────────────────────────

describe('formatElapsed', () => {
  it('возвращает пустую строку для null', () => {
    expect(formatElapsed(null)).toBe('');
  });

  it('возвращает "now" при < 1 минуты', () => {
    expect(formatElapsed(Date.now() - FIVE_SECONDS)).toBe('now');
    expect(formatElapsed(Date.now() - FIFTY_NINE_SECONDS)).toBe('now');
  });

  it('возвращает "now" для 0 и отрицательной разницы', () => {
    // biome-ignore lint/style/noMagicNumbers: test offset value
    expect(formatElapsed(Date.now() + 1_000)).toBe('now');
    expect(formatElapsed(Date.now())).toBe('now');
  });

  it('возвращает "1m" ровно на границе 1 минуты', () => {
    expect(formatElapsed(Date.now() - ONE_MINUTE)).toBe('1m');
  });

  it('возвращает "59m" за минуту до часа', () => {
    expect(formatElapsed(Date.now() - FIFTY_NINE_MINUTES)).toBe('59m');
  });

  it('возвращает "1h" ровно на границе 1 часа', () => {
    expect(formatElapsed(Date.now() - ONE_HOUR)).toBe('1h');
  });

  it('возвращает "23h" за час до дня', () => {
    expect(formatElapsed(Date.now() - TWENTY_THREE_HOURS)).toBe('23h');
  });

  it('возвращает "1d" ровно на границе 1 дня', () => {
    expect(formatElapsed(Date.now() - ONE_DAY)).toBe('1d');
  });

  it('возвращает целое число дней, отсекая дробную часть', () => {
    const ts = Date.now() - Math.floor(ONE_DAY * THREE_POINT_SEVEN_DAYS);

    expect(formatElapsed(ts)).toBe('3d');
  });
});

// ── renderDashboard: время в HTML ───────────────────────────

function timeSpanContent(html: string): string | null {
  const match = /<span id="last-updated-time"[^>]*>([^<]*)<\/span>/.exec(html);

  return match ? match[1] : null;
}

function makeMockProvider(name: string): Provider {
  const usageWindow = UsageWindow.fromSection('daily', 0, '5h');
  const model = { modelName: name, windows: [usageWindow] };

  return new Provider(name.toLowerCase(), name, 'pro', [model]);
}

const mockProviders = [makeMockProvider('OpenAI'), makeMockProvider('MiniMax')];

describe('renderDashboard — время в спане', () => {
  it('рендерит спан last-updated-time', () => {
    const html = renderDashboard([], Date.now(), {});

    expect(timeSpanContent(html)).not.toBeNull();
  });

  it('пишет "now" при свежем lastUpdated', () => {
    const html = renderDashboard(mockProviders, Date.now(), {});

    expect(timeSpanContent(html)).toBe('now');
  });

  it('пишет "5m" при lastUpdated 5 минут назад', () => {
    // biome-ignore lint/style/noMagicNumbers: 5 minutes is the test scenario
    const fiveMinAgo = Date.now() - 5 * ONE_MINUTE;
    const html = renderDashboard(mockProviders, fiveMinAgo, {});

    expect(timeSpanContent(html)).toBe('5m');
  });

  it('пишет "2h" при lastUpdated 2 часа назад', () => {
    const twoHoursAgo = Date.now() - 2 * ONE_HOUR;
    const html = renderDashboard(mockProviders, twoHoursAgo, {});

    expect(timeSpanContent(html)).toBe('2h');
  });

  it('пишет "3d" при lastUpdated 3 дня назад', () => {
    // biome-ignore lint/style/noMagicNumbers: 3 days is the test scenario
    const threeDaysAgo = Date.now() - 3 * ONE_DAY;
    const html = renderDashboard(mockProviders, threeDaysAgo, {});

    expect(timeSpanContent(html)).toBe('3d');
  });

  it('оставляет спан пустым при lastUpdated = null', () => {
    const html = renderDashboard(mockProviders, null, {});

    expect(timeSpanContent(html)).toBe('');
  });

  it('ставит data-updated="" при lastUpdated = null', () => {
    const html = renderDashboard(mockProviders, null, {});

    expect(html).toContain('data-updated=""');
  });

  it('ставит data-updated с числом при наличии lastUpdated', () => {
    const dummyTs = 1234567890;
    const html = renderDashboard(mockProviders, dummyTs, {});

    expect(html).toContain('data-updated="1234567890"');
  });

  it('спан находится справа от refresh-circle и слева от кнопки темы', () => {
    const html = renderDashboard(mockProviders, Date.now(), {});
    const svgIdx = html.indexOf('id="refresh-circle"');
    const spanIdx = html.indexOf('id="last-updated-time"');
    const themeBtnIdx = html.indexOf('ThemeManager.rotate()');

    expect(spanIdx).toBeGreaterThan(svgIdx);
    expect(themeBtnIdx).toBeGreaterThan(spanIdx);
  });
});

// ── Per-provider update timestamp ──────────────────────────

describe('renderDashboard — per-provider updatedAt', () => {
  it('renders provider-updated span when provider has updatedAt', () => {
    const now = Date.now();
    const provider = new Provider('test', 'Test', 'pro', [], undefined, now);
    const html = renderDashboard([provider], now, {});

    expect(html).toContain('data-provider-updated');
    expect(html).toContain(`data-provider-updated="${now}"`);
  });

  it('omits provider-updated span when provider lacks updatedAt', () => {
    const now = Date.now();
    const provider = new Provider('test', 'Test', 'pro', []);
    const html = renderDashboard([provider], now, {});

    // Check absence of rendered data-provider-updated attribute (the substring
    // also appears in client-side JS selectors, so match the attribute pattern).
    expect(html).not.toMatch(/data-provider-updated="\d+"/);
  });

  it('renders provider-updated in error cards when available', () => {
    const now = Date.now();
    const provider = new Provider('test', 'Test', 'unknown', [], 'error message', now);
    const html = renderDashboard([provider], now, {});

    expect(html).toContain('data-provider-updated');
    expect(html).toContain(`data-provider-updated="${now}"`);
  });

  it('renders "Updated now" for fresh provider', () => {
    const now = Date.now();
    const provider = new Provider('test', 'Test', 'pro', [], undefined, now);
    const html = renderDashboard([provider], now, {});

    expect(html).toContain('Updated now');
  });

  it('renders "Updated 5m" for provider updated 5 minutes ago', () => {
    // biome-ignore lint/style/noMagicNumbers: 5 minutes is the test scenario
    const fiveMinAgo = Date.now() - 5 * ONE_MINUTE;
    const provider = new Provider('test', 'Test', 'pro', [], undefined, fiveMinAgo);
    const html = renderDashboard([provider], fiveMinAgo, {});

    expect(html).toContain('Updated 5m');
  });
});

// ── Client-side provider-updated JS ─────────────────────────

describe('renderDashboard — provider-updated client JS', () => {
  it('contains updateProviderUpdatedLabels function definition', () => {
    const html = renderDashboard([], Date.now(), {});

    expect(html).toContain('function updateProviderUpdatedLabels()');
  });

  it('contains setInterval call for provider labels', () => {
    const html = renderDashboard([], Date.now(), {});

    expect(html).toContain('setInterval(updateProviderUpdatedLabels, 10_000)');
  });

  it('contains initial call to updateProviderUpdatedLabels', () => {
    const html = renderDashboard([], Date.now(), {});

    expect(html).toContain('updateProviderUpdatedLabels();');
  });

  it('reuses MS_MINUTE, MS_HOUR, MS_DAY constants', () => {
    const html = renderDashboard([], Date.now(), {});

    expect(html).toContain('MS_MINUTE');
    expect(html).toContain('MS_HOUR');
    expect(html).toContain('MS_DAY');
  });

  it('preserves "Updated " prefix in textContent assignment', () => {
    const html = renderDashboard([], Date.now(), {});

    expect(html).toContain("el.textContent = 'Updated ' + text;");
  });

  it('uses data-provider-updated attribute selector', () => {
    const html = renderDashboard([], Date.now(), {});

    expect(html).toContain('.provider-updated[data-provider-updated]');
  });
});

// ── Layout: floating panels instead of xl grid ─────────────

describe('renderDashboard — floating panel layout', () => {
  it('does not contain the old xl grid classes', () => {
    const html = renderDashboard([], Date.now(), {});

    expect(html).not.toContain('xl:grid-cols-[');
    expect(html).not.toContain('12rem_1fr_12rem');
  });

  it('renders fixed left panel when urgent panel has content', () => {
    // biome-ignore lint/style/noMagicNumbers: 3h offset is the test scenario
    const futureReset = new Date(Date.now() + 3 * ONE_HOUR).toISOString();
    // biome-ignore lint/style/noMagicNumbers: 30% usage is the test scenario
    const window_ = UsageWindow.fromApi('weekly', 30, futureReset);
    const model = { modelName: 'plus', windows: [window_] };
    const codex = new Provider('codex', 'CodeX', 'plus', [model]);
    const html = renderDashboard([codex], Date.now(), {});

    expect(html).toContain('fixed left-4 top-28 w-56');
  });

  it('renders fixed right panel when compact panel has content', () => {
    // biome-ignore lint/style/noMagicNumbers: 50% usage is the test scenario
    const window_ = UsageWindow.fromApi('daily', 50, null, null, '1.2M tokens');
    const model = { modelName: 'Chat', windows: [window_] };
    const deepseek = new Provider('deepseek', 'DeepSeek', 'pro', [model]);
    const html = renderDashboard([deepseek], Date.now(), {});

    expect(html).toContain('fixed right-4 top-28 w-56');
  });

  it('renders both panels simultaneously', () => {
    // biome-ignore lint/style/noMagicNumbers: 3h offset is the test scenario
    const futureReset = new Date(Date.now() + 3 * ONE_HOUR).toISOString();
    // biome-ignore lint/style/noMagicNumbers: 30% usage is the test scenario
    const codexWindow = UsageWindow.fromApi('weekly', 30, futureReset);
    const codexModel = { modelName: 'plus', windows: [codexWindow] };
    const codex = new Provider('codex', 'CodeX', 'plus', [codexModel]);

    // biome-ignore lint/style/noMagicNumbers: 50% usage is the test scenario
    const deepseekWindow = UsageWindow.fromApi('daily', 50, null, null, '1.2M tokens');
    const deepseekModel = { modelName: 'Chat', windows: [deepseekWindow] };
    const deepseek = new Provider('deepseek', 'DeepSeek', 'pro', [deepseekModel]);

    const html = renderDashboard([codex, deepseek], Date.now(), {});

    expect(html).toContain('fixed left-4 top-28 w-56');
    expect(html).toContain('fixed right-4 top-28 w-56');
  });

  it('omits left panel when urgent panel is empty', () => {
    const html = renderDashboard([], Date.now(), {});

    expect(html).not.toContain('fixed left-4 top-28 w-56');
  });

  it('omits right panel when compact panel is empty', () => {
    const html = renderDashboard([], Date.now(), {});

    expect(html).not.toContain('fixed right-4 top-28 w-56');
  });

  it('includes pointer-events-auto on panels', () => {
    // biome-ignore lint/style/noMagicNumbers: 3h offset is the test scenario
    const futureReset = new Date(Date.now() + 3 * ONE_HOUR).toISOString();
    // biome-ignore lint/style/noMagicNumbers: 30% usage is the test scenario
    const window_ = UsageWindow.fromApi('weekly', 30, futureReset);
    const model = { modelName: 'plus', windows: [window_] };
    const codex = new Provider('codex', 'CodeX', 'plus', [model]);
    const html = renderDashboard([codex], Date.now(), {});

    expect(html).toContain('pointer-events-auto');
  });
});

// ── Billing tag (renderBillingTag) ──────────────────────────

describe('renderDashboard — billing tag', () => {
  it('опускает тег биллинга без переопределения', () => {
    const provider = new Provider('test', 'Test', 'pro', []);
    const html = renderDashboard([provider], Date.now(), {});

    expect(html).not.toContain('Billing: ');
  });

  it('показывает несрочный тег биллинга (> 5 дней)', () => {
    const farIso = new Date(Date.now() + TEN_DAYS_MS).toISOString();
    const provider = new Provider('test', 'Test', 'pro', []);
    const html = renderDashboard([provider], Date.now(), { test: farIso });

    expect(html).toContain('Billing: ');
    expect(html).toContain('border-theme-border-light');
  });

  it('показывает срочный тег биллинга (<= 5 дней)', () => {
    const nearIso = new Date(Date.now() + THREE_DAYS_MS).toISOString();
    const provider = new Provider('test', 'Test', 'pro', []);
    const html = renderDashboard([provider], Date.now(), { test: nearIso });

    expect(html).toContain('Billing: ');
    expect(html).toContain('text-red-500');
  });
});

// ── Updated label (renderUpdatedLabel) ──────────────────────

describe('renderDashboard — updated label', () => {
  it('опускает метку обновления без updatedAt', () => {
    const provider = new Provider('test', 'Test', 'pro', []);
    const html = renderDashboard([provider], Date.now(), {});

    expect(html).not.toMatch(/data-provider-updated="\d+"/);
  });

  it('рендерит provider-updated класс и атрибут для обычной карточки', () => {
    const now = Date.now();
    const provider = new Provider('test', 'Test', 'pro', [], undefined, now);
    const html = renderDashboard([provider], now, {});

    expect(html).toContain('provider-updated');
    expect(html).toContain(`data-provider-updated="${now}"`);
    expect(html).not.toContain('border-theme-warning');
  });

  it('показывает stale-пилюлю для устаревшего провайдера', () => {
    const now = Date.now();
    const provider = new Provider('test', 'Test', 'pro', [], undefined, now, true);
    const html = renderDashboard([provider], now, {});

    expect(html).toContain('border-theme-warning');
    expect(html).toContain(`data-provider-updated="${now}"`);
  });
});

// ── Settings row (renderSettingsRow) ────────────────────────

describe('renderDashboard — settings row', () => {
  it('рендерит поле даты со значением и data-provider-id', () => {
    const provider = new Provider('test', 'Test', 'pro', []);
    const html = renderDashboard([provider], Date.now(), { test: '2026-03-15T00:00:00.000Z' });

    expect(html).toContain('data-provider-id="test"');
    expect(html).toContain('value="2026-03-15"');
    expect(html).toContain('billing-date-input');
  });
});

// ── Max usage (computeMaxUsage) ─────────────────────────────

describe('renderDashboard — computeMaxUsage', () => {
  it('отражает максимальный usedPercent в data-max-usage', () => {
    const p1 = new Provider('a', 'A', 'pro', [
      { modelName: 'm', windows: [UsageWindow.fromApi('daily', PCT_THIRTY, null)] },
    ]);
    const p2 = new Provider('b', 'B', 'pro', [
      { modelName: 'm', windows: [UsageWindow.fromApi('daily', PCT_SEVENTY, null)] },
    ]);
    const html = renderDashboard([p1, p2], Date.now(), {});

    expect(html).toContain('data-max-usage="70"');
  });

  it('равен 0 при отсутствии usedPercent', () => {
    const provider = new Provider('a', 'A', 'pro', [
      { modelName: 'm', windows: [UsageWindow.fromApi('daily', null, null)] },
    ]);
    const html = renderDashboard([provider], Date.now(), {});

    expect(html).toContain('data-max-usage="0"');
  });
});

// ── Provider card branches (renderProviderCard) ─────────────

describe('renderDashboard — provider card branches', () => {
  it('renders MiniMax errors without model windows or billing tags', () => {
    const minimax = new Provider(
      'minimax',
      'MiniMax',
      'pro',
      [{ modelName: 'chat', windows: [UsageWindow.fromApi('error-model-window', PCT_HALF, null)] }],
      '<request failed>',
      NOW,
    );
    const html = renderDashboard([minimax], NOW, { minimax: '2026-03-15T00:00:00.000Z' });

    expect(html).toContain('border-theme-danger');
    expect(html).toContain('&lt;request failed&gt;');
    expect(html).toContain(`data-provider-updated="${NOW}"`);
    expect(html).not.toContain('error-model-window');
    expect(html).not.toContain('Billing: ');
  });

  it('MiniMax-карточка не содержит удалённый блок "Show all models"', () => {
    const minimax = new Provider('minimax', 'MiniMax', 'pro', [
      { modelName: 'chat', windows: [UsageWindow.fromSection('daily', PCT_HALF, '5h')] },
    ]);
    const html = renderDashboard([minimax], Date.now(), {});

    expect(html).not.toContain('Show all models');
    expect(html).toContain('MiniMax');
  });

  it.each([
    { id: 'minimax', isArchived: false, expected: ['chat-window', 'case-window', 'suffix-window'] },
    { id: 'minimax', isArchived: true, expected: ['chat-window', 'case-window', 'suffix-window'] },
    {
      id: 'test',
      isArchived: false,
      expected: ['chat-window', 'hidden-exact', 'case-window', 'hidden-prefix', 'suffix-window'],
    },
    {
      id: 'MiniMax',
      isArchived: false,
      expected: ['chat-window', 'hidden-exact', 'case-window', 'hidden-prefix', 'suffix-window'],
    },
  ])('filters only MiniMax coding-plan prefixes in order ($id, archived: $isArchived)', ({
    id,
    isArchived,
    expected,
  }) => {
    const models = [
      ['chat', 'chat-window'],
      ['coding-plan', 'hidden-exact'],
      ['Coding-plan-x', 'case-window'],
      ['coding-plan-x', 'hidden-prefix'],
      ['legacy-coding-plan', 'suffix-window'],
    ].map(([modelName, label]) => ({
      modelName,
      windows: [UsageWindow.fromApi(label, PCT_HALF, null)],
    }));
    const originalModels = [...models];
    const provider = new Provider(id, 'MiniMax', 'pro', models);
    const archiveSet = new Set(isArchived ? [id] : []);
    const html = renderDashboard([provider], NOW, {}, archiveSet);
    const labels = Array.from(
      html.matchAll(/uppercase tracking-wider">([^<]*)<\/span>/g),
      (match) => match[1],
    );

    expect(labels).toEqual(expected);
    expect(provider.models).toEqual(originalModels);
    expect(html.includes('Archive (1)')).toBe(isArchived);
  });

  it.each([
    { scenario: 'empty', names: [] },
    { scenario: 'all-filtered', names: ['coding-plan', 'coding-plan-x'] },
  ])('renders an empty MiniMax card for $scenario models', ({ names }) => {
    const models = names.map((modelName) => ({
      modelName,
      windows: [UsageWindow.fromApi('hidden-window', PCT_HALF, null)],
    }));
    const minimax = new Provider('minimax', 'MiniMax', 'pro', models);
    const html = renderDashboard([minimax], NOW, {});

    expect(html).toMatch(/<h2[^>]*>\s*MiniMax\s*<\/h2>\s*<div>\s*<\/div>/);
    expect(html).not.toContain('hidden-window');
  });
});

// ── Archive section ────────────────────────────────────────

describe('renderDashboard — archive section', () => {
  it('renders Archive section when archiveSet contains a provider id', () => {
    const provider = new Provider('test', 'Test', 'pro', []);
    const archiveSet = new Set(['test']);
    const html = renderDashboard([provider], NOW, {}, archiveSet);

    expect(html).toContain('Archive (1)');
    expect(html).toContain('<details');
  });

  it('renders archived provider inside details, not in main grid', () => {
    const provider = new Provider('arch-me', 'ArchMe', 'pro', []);
    const archiveSet = new Set(['arch-me']);
    const html = renderDashboard([provider], NOW, {}, archiveSet);

    // The main grid should NOT contain the archived provider card
    const mainGridStart = html.indexOf('id="dashboard"');

    // Archive section appears after the main grid
    expect(html.indexOf('Archive (1)')).toBeGreaterThan(mainGridStart);

    // Archive details contains the provider name
    const detailsSection = html.substring(html.indexOf('<details'));

    expect(detailsSection).toContain('ArchMe');
  });

  it('does not render Archive section when archiveSet is empty', () => {
    const provider = new Provider('test', 'Test', 'pro', []);
    const archiveSet = new Set<string>();
    const html = renderDashboard([provider], NOW, {}, archiveSet);

    expect(html).not.toContain('Archive (');
  });

  it('does not render Archive section when no providers are archived', () => {
    const provider = new Provider('test', 'Test', 'pro', []);
    const html = renderDashboard([provider], NOW, {});

    expect(html).not.toContain('Archive (');
  });
});

// ── Metrics tab ────────────────────────────────────────────

describe('renderDashboard — metrics tab', () => {
  it('contains Metrics tab button', () => {
    const html = renderDashboard([], NOW, {});

    expect(html).toContain('id="tab-metrics-btn"');
  });

  it('contains Metrics tab panel', () => {
    const html = renderDashboard([], NOW, {});

    expect(html).toContain('id="tab-metrics"');
  });

  it('contains metrics panel div with id', () => {
    const html = renderDashboard([], NOW, {});

    expect(html).toContain('id="metrics-panel"');
  });

  it('contains logs panel div with id', () => {
    const html = renderDashboard([], NOW, {});

    expect(html).toContain('id="logs-panel"');
  });
});

// ── Metrics panel (renderMetricsPanel) ─────────────────────

describe('renderMetricsPanel', () => {
  it('renders green card for recent success and configured', () => {
    const fakeNow = Date.now();
    const recent = fakeNow - ONE_MINUTE;
    const metrics: ProviderMetrics[] = [
      {
        id: 'a',
        name: 'A',
        archived: false,
        configured: true,
        lastSuccessAt: recent,
        lastAttemptAt: recent,
      },
    ];
    const html = renderMetricsPanel(metrics);

    expect(html).toContain('border-green-500');
    expect(html).toContain('A');
  });

  it('renders red card when lastSuccessAt is old', () => {
    const metrics: ProviderMetrics[] = [
      {
        id: 'a',
        name: 'A',
        archived: false,
        configured: true,
        lastSuccessAt: ONE_HOUR_AGO,
        lastAttemptAt: ONE_HOUR_AGO,
      },
    ];
    const html = renderMetricsPanel(metrics);

    expect(html).toContain('border-red-500');
  });

  it('renders red No data when lastSuccessAt is null and configured', () => {
    const metrics: ProviderMetrics[] = [
      {
        id: 'a',
        name: 'A',
        archived: false,
        configured: true,
        lastSuccessAt: null,
        lastAttemptAt: NOW,
      },
    ];
    const html = renderMetricsPanel(metrics);

    expect(html).toContain('border-red-500');
    expect(html).toContain('No data');
  });

  it('renders neutral Archived label when archived', () => {
    const metrics: ProviderMetrics[] = [
      {
        id: 'a',
        name: 'A',
        archived: true,
        configured: true,
        lastSuccessAt: RECENT,
        lastAttemptAt: RECENT,
      },
    ];
    const html = renderMetricsPanel(metrics);

    expect(html).toContain('border-theme-border');
    expect(html).toContain('Archived');
  });

  it('renders neutral Not configured label', () => {
    const metrics: ProviderMetrics[] = [
      {
        id: 'a',
        name: 'A',
        archived: false,
        configured: false,
        lastSuccessAt: null,
        lastAttemptAt: null,
      },
    ];
    const html = renderMetricsPanel(metrics);

    expect(html).toContain('border-theme-border');
    expect(html).toContain('Not configured');
  });

  it('shows No providers when metrics array is empty', () => {
    const html = renderMetricsPanel([]);

    expect(html).toContain('No providers');
  });

  it('renders last success and last attempt timestamps', () => {
    const metrics: ProviderMetrics[] = [
      {
        id: 'a',
        name: 'A',
        archived: false,
        configured: true,
        lastSuccessAt: RECENT,
        lastAttemptAt: ONE_HOUR_AGO,
      },
    ];
    const html = renderMetricsPanel(metrics);

    expect(html).toContain('Last success:');
    expect(html).toContain('Last attempt:');
  });
});

// ── Logs panel (renderLogsPanel) ───────────────────────────

describe('renderLogsPanel', () => {
  it('renders No logs yet when logs array is empty', () => {
    const html = renderLogsPanel([]);

    expect(html).toContain('No logs yet');
  });

  it('renders log entry message', () => {
    const logs: LogEntry[] = [{ ts: NOW, level: 'info', message: 'Refresh started' }];
    const html = renderLogsPanel(logs);

    expect(html).toContain('Refresh started');
  });

  it('renders level badge with uppercase CSS class', () => {
    const logs: LogEntry[] = [{ ts: NOW, level: 'warn', message: 'Warning message' }];
    const html = renderLogsPanel(logs);

    // The level text is lowercase in source but rendered uppercase via CSS class
    expect(html).toContain('uppercase');
    expect(html).toContain('>warn<');
  });

  it('renders providerId when present', () => {
    const logs: LogEntry[] = [
      { ts: NOW, level: 'info', message: 'A updated', providerId: 'adapt-a' },
    ];
    const html = renderLogsPanel(logs);

    expect(html).toContain('adapt-a');
  });

  it('renders multiple entries', () => {
    const logs: LogEntry[] = [
      { ts: NOW, level: 'info', message: 'third' },
      { ts: NOW - 1, level: 'info', message: 'second' },
      { ts: NOW - 2, level: 'info', message: 'first' },
    ];
    const html = renderLogsPanel(logs);

    expect(html).toContain('third');
    expect(html).toContain('second');
    expect(html).toContain('first');
  });

  it('renders elapsed time format', () => {
    const logs: LogEntry[] = [{ ts: RECENT, level: 'info', message: 'test' }];
    const html = renderLogsPanel(logs);

    // Should contain formatted time (e.g. "now" for recent)
    expect(html).toContain('now');
  });
});

// ── Settings tab — archive toggle ──────────────────────────

describe('renderDashboard — settings archive toggle', () => {
  it('renders archive toggle input for a provider', () => {
    const provider = new Provider('test', 'Test', 'pro', []);
    const html = renderDashboard([provider], NOW, {});

    expect(html).toContain('archive-toggle');
    expect(html).toContain('data-provider-id="test"');
  });

  it('renders toggle as checked when provider is archived', () => {
    const provider = new Provider('test', 'Test', 'pro', []);
    const archiveSet = new Set(['test']);
    const html = renderDashboard([provider], NOW, {}, archiveSet);

    expect(html).toContain('checked');
  });

  it('renders toggle as unchecked when provider is not archived', () => {
    const provider = new Provider('test', 'Test', 'pro', []);
    const archiveSet = new Set<string>();
    const html = renderDashboard([provider], NOW, {}, archiveSet);

    // Extract the input element for this specific provider
    // When not archived, the input should not have a "checked" attribute
    const inputMatch = /<input[^>]*archive-toggle[^>]*data-provider-id="test"([^>]*)>/s.exec(html);

    expect(inputMatch).not.toBeNull();

    const inputAttrs = inputMatch?.[1] ?? '';

    expect(inputAttrs).not.toContain('checked');
  });

  it('renders toggleArchive function call in onchange', () => {
    const provider = new Provider('test', 'Test', 'pro', []);
    const html = renderDashboard([provider], NOW, {});

    expect(html).toContain('toggleArchive');
  });

  it('renders Archive label in settings section', () => {
    const provider = new Provider('test', 'Test', 'pro', []);
    const html = renderDashboard([provider], NOW, {});

    // The settings section has an "Archive" heading
    expect(html).toContain('Archive');
  });
});
