import { describe, expect, it } from 'vitest';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND } from '../../src/constants.js';
import {
  errorCard,
  escapeHtml,
  formatNumber,
  formatTimeUntil,
  groupMiniMaxModels,
  modelCard,
  toDateInputValue,
} from '../../src/html/usage-renderers.js';
import { Provider } from '../../src/provider.js';
import { UsageWindow } from '../../src/usage-window.js';

// ── Percent / count / spend constants ───────────────────────
// Bare literals in const initializers are exempt from noMagicNumbers.
const PCT_HALF = 50;
const PCT_LOW = 30;
const PCT_MID = 60;
const PCT_HIGH = 90;
const PCT_NEAR_VISIBLE = 2;
const COUNT_USED = 30;
const COUNT_TOTAL = 100;
const SPEND_AMOUNT = 12.5;
const LARGE_NUMBER = 1_234_567;
const PCT_FULL = 100;

// ── Reset-ring offsets (5h cycle) ───────────────────────────
const NEAR_RESET_OFFSET_MS = 1_800_000; // ~10% of cycle → progress 0.9 (near)
const MID_RESET_OFFSET_MS = 3_600_000; // 20% of cycle → progress 0.8 (mid)
const FAR_RESET_OFFSET_MS = 14_400_000; // 80% of cycle → progress 0.2 (far)

function isoFromNow(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

// ── formatNumber ────────────────────────────────────────────

describe('formatNumber', () => {
  it('возвращает пустую строку для null', () => {
    expect(formatNumber(null)).toBe('');
  });

  it('форматирует большое число с разделителями разрядов', () => {
    expect(formatNumber(LARGE_NUMBER)).toBe('1,234,567');
  });
});

// ── formatTimeUntil ─────────────────────────────────────────

describe('formatTimeUntil', () => {
  it('возвращает пустую строку для неположительного и не-finite значения', () => {
    expect(formatTimeUntil(0)).toBe('');
    expect(formatTimeUntil(-MS_PER_MINUTE)).toBe('');
    expect(formatTimeUntil(Number.POSITIVE_INFINITY)).toBe('');
  });

  it('возвращает "<1m" для значения меньше минуты', () => {
    expect(formatTimeUntil(MS_PER_SECOND)).toBe('<1m');
  });

  it('возвращает минуты для значения меньше часа', () => {
    expect(formatTimeUntil(MS_PER_MINUTE)).toBe('1m');
  });

  it('возвращает часы для значения меньше дня', () => {
    expect(formatTimeUntil(MS_PER_HOUR)).toBe('1h');
  });

  it('возвращает дни для значения больше дня', () => {
    expect(formatTimeUntil(MS_PER_DAY)).toBe('1d');
  });
});

// ── escapeHtml ──────────────────────────────────────────────

describe('escapeHtml', () => {
  it('возвращает пустую строку для null/undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('экранирует спецсимволы HTML', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});

// ── toDateInputValue ────────────────────────────────────────

describe('toDateInputValue', () => {
  it('возвращает пустую строку для undefined', () => {
    expect(toDateInputValue(undefined)).toBe('');
  });

  it('возвращает пустую строку для некорректной даты', () => {
    expect(toDateInputValue('not-a-date')).toBe('');
  });

  it('возвращает YYYY-MM-DD для корректной ISO-даты', () => {
    expect(toDateInputValue('2026-03-15T10:00:00.000Z')).toBe('2026-03-15');
  });
});

// ── groupMiniMaxModels ──────────────────────────────────────

describe('groupMiniMaxModels', () => {
  it('отфильтровывает модели с префиксом coding-plan', () => {
    const coding = {
      modelName: 'coding-plan-x',
      windows: [UsageWindow.fromSection('monthly', PCT_HALF, '5h')],
    };
    const chat = { modelName: 'chat', windows: [UsageWindow.fromSection('daily', PCT_HALF, '5h')] };

    const { main } = groupMiniMaxModels([coding, chat]);

    expect(main).toHaveLength(1);
    expect(main[0].modelName).toBe('chat');
  });

  it('возвращает пустой extra для совместимости', () => {
    const chat = { modelName: 'chat', windows: [UsageWindow.fromSection('daily', PCT_HALF, '5h')] };

    const { extra } = groupMiniMaxModels([chat]);

    expect(extra).toHaveLength(0);
  });
});

// ── errorCard ───────────────────────────────────────────────

describe('errorCard', () => {
  it('показывает метку обновления, когда updatedAt задан', () => {
    const now = Date.now();
    const provider = new Provider('test', 'Test', 'pro', [], 'boom', now);

    expect(errorCard(provider)).toContain(`data-provider-updated="${now}"`);
  });

  it('не показывает метку обновления без updatedAt', () => {
    const provider = new Provider('test', 'Test', 'pro', [], 'boom');

    expect(errorCard(provider)).not.toMatch(/data-provider-updated="\d+"/);
  });

  it('рендерит сообщение об ошибке', () => {
    const provider = new Provider('test', 'Test', 'pro', [], 'boom');

    expect(errorCard(provider)).toContain('border-theme-danger');
    expect(errorCard(provider)).toContain('boom');
  });
});

// ── modelCard: internal helpers via windows ─────────────────

describe('modelCard', () => {
  it('возвращает пустую строку для модели без окон', () => {
    expect(modelCard({ modelName: 'chat', windows: [] })).toBe('');
  });

  it('красит полосу использования по порогам (зелёный/жёлтый/красный)', () => {
    const low = modelCard({
      modelName: 'm',
      windows: [UsageWindow.fromApi('daily', PCT_LOW, null)],
    });
    const mid = modelCard({
      modelName: 'm',
      windows: [UsageWindow.fromApi('daily', PCT_MID, null)],
    });
    const high = modelCard({
      modelName: 'm',
      windows: [UsageWindow.fromApi('daily', PCT_HIGH, null)],
    });

    expect(low).toContain('bg-green-500');
    expect(mid).toContain('bg-yellow-500');
    expect(high).toContain('bg-red-500');
  });

  it('рисует полосу нулевой ширины для 0%', () => {
    const html = modelCard({ modelName: 'm', windows: [UsageWindow.fromApi('daily', 0, null)] });

    expect(html).toContain('text-theme-text mb-0.5');
    expect(html).toContain('width:0%');
  });

  it('добавляет min-w-1 для видимости полос 1–2%', () => {
    const html = modelCard({
      modelName: 'm',
      windows: [UsageWindow.fromApi('daily', PCT_NEAR_VISIBLE, null)],
    });

    expect(html).toContain('min-w-1');
  });

  it('показывает проценты, остаток и счётчики в buildUsageParts', () => {
    const html = modelCard({
      modelName: 'm',
      windows: [UsageWindow.fromCounts('daily', COUNT_USED, COUNT_TOTAL, null)],
    });

    expect(html).toContain(`${PCT_LOW.toFixed(1)}% used`);
    expect(html).toContain(`${(PCT_FULL - PCT_LOW).toFixed(1)}% left`);
    expect(html).toContain(`${COUNT_USED}/${COUNT_TOTAL}`);
  });

  it('подставляет valueLabel вместо счётчиков когда задан', () => {
    const html = modelCard({
      modelName: 'm',
      windows: [
        UsageWindow.fromCounts('daily', COUNT_USED, COUNT_TOTAL, null, 'thirty of hundred'),
      ],
    });

    expect(html).toContain('thirty of hundred');
  });

  it('показывает трату (spend > 0) когда нет usedPercent', () => {
    const html = modelCard({
      modelName: 'm',
      windows: [UsageWindow.fromApi('daily', null, null, SPEND_AMOUNT)],
    });

    expect(html).toContain('text-theme-spend font-bold');
    expect(html).toContain(`$${SPEND_AMOUNT.toFixed(2)}`);
  });

  it('показывает трату тусклым цветом для spend === 0', () => {
    const html = modelCard({
      modelName: 'm',
      windows: [UsageWindow.fromApi('daily', null, null, 0)],
    });

    expect(html).toContain('text-theme-text-tertiary');
    expect(html).toContain('$0.00');
  });

  it('показывает valueLabel когда нет usedPercent и spend', () => {
    const html = modelCard({
      modelName: 'm',
      windows: [UsageWindow.fromApi('daily', null, null, null, 'custom label')],
    });

    expect(html).toContain('custom label');
    expect(html).toContain('truncate flex-1');
  });

  it('рендерит пустой middle-спан когда нет данных', () => {
    const html = modelCard({ modelName: 'm', windows: [UsageWindow.fromApi('daily', null, null)] });

    expect(html).toContain('<span class="flex-1"></span>');
  });
});

// ── renderResetRing / cycleMs via modelCard ─────────────────

describe('renderResetRing (через modelCard)', () => {
  it('не рендерит кольцо без resetAt', () => {
    const html = modelCard({
      modelName: 'm',
      windows: [UsageWindow.fromApi('5h', PCT_HALF, null)],
    });

    expect(html).not.toContain('min-w-[4rem]');
  });

  it('не рендерит кольцо для неизвестного label (cycleMs === null)', () => {
    const html = modelCard({
      modelName: 'm',
      windows: [UsageWindow.fromApi('lifetime', PCT_HALF, isoFromNow(MID_RESET_OFFSET_MS))],
    });

    expect(html).not.toContain('min-w-[4rem]');
  });

  it('не рендерит кольцо для просроченного resetAt', () => {
    const pastIso = new Date(Date.now() - MID_RESET_OFFSET_MS).toISOString();
    const html = modelCard({
      modelName: 'm',
      windows: [UsageWindow.fromApi('5h', PCT_HALF, pastIso)],
    });

    expect(html).not.toContain('min-w-[4rem]');
  });

  it('красит кольцо зелёным у сброса (progress >= 0.85)', () => {
    const html = modelCard({
      modelName: 'm',
      windows: [UsageWindow.fromApi('5h', PCT_HALF, isoFromNow(NEAR_RESET_OFFSET_MS))],
    });

    expect(html).toContain('min-w-[4rem]');
    expect(html).toContain('text-green-500');
  });

  it('красит кольцо жёлтым в середине цикла (progress >= 0.625)', () => {
    const html = modelCard({
      modelName: 'm',
      windows: [UsageWindow.fromApi('5h', PCT_HALF, isoFromNow(MID_RESET_OFFSET_MS))],
    });

    expect(html).toContain('min-w-[4rem]');
    expect(html).toContain('text-yellow-500');
  });

  it('красит кольцо красным в начале цикла (progress < 0.625)', () => {
    const html = modelCard({
      modelName: 'm',
      windows: [UsageWindow.fromApi('5h', PCT_HALF, isoFromNow(FAR_RESET_OFFSET_MS))],
    });

    expect(html).toContain('min-w-[4rem]');
    expect(html).toContain('text-red-500/60');
  });

  it('распознаёт все валидные циклы (включая алиасы)', () => {
    const labels = ['today', 'daily', 'week', 'weekly', 'month', 'monthly'];

    for (const label of labels) {
      const html = modelCard({
        modelName: 'm',
        windows: [UsageWindow.fromApi(label, PCT_HALF, isoFromNow(NEAR_RESET_OFFSET_MS))],
      });

      // Любой валидный цикл рендерит кольцо (зелёное при близком сбросе).
      expect(html).toContain('text-green-500');
    }
  });

  it('не рендерит кольцо для некорректной даты resetAt', () => {
    const html = modelCard({
      modelName: 'm',
      windows: [UsageWindow.fromApi('5h', PCT_HALF, 'not-a-date')],
    });

    expect(html).not.toContain('min-w-[4rem]');
  });
});
