import { describe, expect, it } from 'vitest';
import { formatElapsed, renderDashboard } from '../src/html.js';
import { ModelUsage } from '../src/model-usage.js';
import { Provider } from '../src/provider.js';
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
  const model = ModelUsage.from(name, [usageWindow]);

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
