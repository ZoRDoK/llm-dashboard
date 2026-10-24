import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MS_PER_HOUR } from '../../src/constants.js';
import { renderUrgentPanel } from '../../src/html/urgent-panel.js';
import { Provider } from '../../src/provider.js';
import { UsageWindow } from '../../src/usage-window.js';

// ── Percent constants ───────────────────────────────────────
const PCT_HALF = 50;
const PCT_EIGHTY = 80;
const PCT_SPENT = 96;
const PCT_THRESHOLD = 95;
const PCT_ALMOST_SPENT = 94.999;
const PCT_THREE_QUARTERS = 75;

// ── Reset offsets in milliseconds ───────────────────────────
const THREE_HOURS_MS = 10_800_000;
const TEN_HOURS_MS = 36_000_000;
const FIFTY_HOURS_MS = 180_000_000;
const HUNDRED_HOURS_MS = 360_000_000;
const THRESHOLD_MS = 172_800_000;
const INVALID_RESETS = [null, 'invalid reset', '2026-01-01T00:00:00Z', '2025-12-31T23:59:59Z'];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function isoFromNow(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

// ── Empty cases ─────────────────────────────────────────────

describe('renderUrgentPanel — пустые случаи', () => {
  it('возвращает пустую строку без провайдеров', () => {
    expect(renderUrgentPanel([])).toBe('');
  });

  it('возвращает пустую строку для провайдера без config', () => {
    const provider = new Provider('random', 'Random', 'pro', [
      {
        modelName: 'm',
        windows: [UsageWindow.fromApi('weekly', PCT_HALF, isoFromNow(THREE_HOURS_MS))],
      },
    ]);

    expect(renderUrgentPanel([provider])).toBe('');
  });

  it('возвращает пустую строку при несовпадении имени модели', () => {
    const codex = new Provider('codex', 'CodeX', 'plus', [
      {
        modelName: 'wrong',
        windows: [UsageWindow.fromApi('weekly', PCT_HALF, isoFromNow(THREE_HOURS_MS))],
      },
    ]);

    expect(renderUrgentPanel([codex])).toBe('');
  });

  it('возвращает пустую строку при несовпадении окна', () => {
    const codex = new Provider('codex', 'CodeX', 'plus', [
      {
        modelName: 'plus',
        windows: [UsageWindow.fromApi('monthly', PCT_HALF, isoFromNow(THREE_HOURS_MS))],
      },
    ]);

    expect(renderUrgentPanel([codex])).toBe('');
  });

  it('возвращает пустую строку без resetAt', () => {
    const codex = new Provider('codex', 'CodeX', 'plus', [
      { modelName: 'plus', windows: [UsageWindow.fromApi('weekly', PCT_HALF, null)] },
    ]);

    expect(renderUrgentPanel([codex])).toBe('');
  });

  it('возвращает пустую строку для просроченного resetAt', () => {
    const pastIso = new Date(Date.now() - THREE_HOURS_MS).toISOString();
    const codex = new Provider('codex', 'CodeX', 'plus', [
      { modelName: 'plus', windows: [UsageWindow.fromApi('weekly', PCT_HALF, pastIso)] },
    ]);

    expect(renderUrgentPanel([codex])).toBe('');
  });

  it('отфильтровывает полностью потраченные окна (usedPercent >= 95)', () => {
    const codex = new Provider('codex', 'CodeX', 'plus', [
      {
        modelName: 'plus',
        windows: [UsageWindow.fromApi('weekly', PCT_SPENT, isoFromNow(THREE_HOURS_MS))],
      },
    ]);

    expect(renderUrgentPanel([codex])).toBe('');
  });
});

// ── Urgent mode ─────────────────────────────────────────────

describe('renderUrgentPanel — срочный режим', () => {
  it('показывает "Spend urgently" для окна близкого к сбросу', () => {
    const codex = new Provider('codex', 'CodeX', 'plus', [
      {
        modelName: 'plus',
        windows: [UsageWindow.fromApi('weekly', PCT_HALF, isoFromNow(THREE_HOURS_MS))],
      },
    ]);

    const html = renderUrgentPanel([codex]);

    expect(html).toContain('Spend urgently');
    expect(html).toContain('CodeX');
  });

  it('учитывает окно с неизвестным usedPercent (null)', () => {
    const codex = new Provider('codex', 'CodeX', 'plus', [
      {
        modelName: 'plus',
        windows: [UsageWindow.fromApi('weekly', null, isoFromNow(THREE_HOURS_MS))],
      },
    ]);

    expect(renderUrgentPanel([codex])).toContain('Spend urgently');
  });

  it('сортирует несколько срочных провайдеров по urgency', () => {
    const codex = new Provider('codex', 'CodeX', 'plus', [
      {
        modelName: 'plus',
        windows: [UsageWindow.fromApi('weekly', PCT_HALF, isoFromNow(THREE_HOURS_MS))],
      },
    ]);
    const zai = new Provider('zai', 'Zai', 'pro', [
      {
        modelName: 'Quota',
        windows: [UsageWindow.fromApi('weekly', PCT_EIGHTY, isoFromNow(TEN_HOURS_MS))],
      },
    ]);

    const html = renderUrgentPanel([codex, zai]);

    expect(html).toContain('Spend urgently');
    expect(html).toContain('CodeX');
    expect(html).toContain('Zai');
  });
});

// ── Desirable mode ──────────────────────────────────────────

describe('renderUrgentPanel — желательный режим', () => {
  it('показывает "Consider spending" для далёкого, но пригодного провайдера', () => {
    // codex — жизнеспособен (viable), но не срочный (100h > 48h порога).
    const codex = new Provider('codex', 'CodeX', 'plus', [
      {
        modelName: 'plus',
        windows: [UsageWindow.fromApi('weekly', PCT_HALF, isoFromNow(HUNDRED_HOURS_MS))],
      },
    ]);
    // claude — не кандидат (окно monthly не равно weekly), но даёт desirable-кандидат.
    const claude = new Provider('claude', 'Claude', 'pro', [
      {
        modelName: 'Claude',
        windows: [UsageWindow.fromApi('monthly', PCT_HALF, isoFromNow(FIFTY_HOURS_MS))],
      },
    ]);

    const html = renderUrgentPanel([codex, claude]);

    expect(html).toContain('Consider spending');
    expect(html).toContain('Claude');
  });

  it('пропускает desirable-окна с usedPercent >= 95 и возвращает пустую строку', () => {
    // codex — жизнеспособен, но не срочный.
    const codex = new Provider('codex', 'CodeX', 'plus', [
      {
        modelName: 'plus',
        windows: [UsageWindow.fromApi('weekly', PCT_HALF, isoFromNow(HUNDRED_HOURS_MS))],
      },
    ]);
    // kimi — не кандидат (окно monthly), desirable-окно полностью потрачено.
    const kimi = new Provider('kimi', 'Kimi', 'pro', [
      {
        modelName: 'Coding',
        windows: [UsageWindow.fromApi('monthly', PCT_SPENT, isoFromNow(FIFTY_HOURS_MS))],
      },
    ]);

    expect(renderUrgentPanel([codex, kimi])).toBe('');
  });
});

function rowNames(html: string): string[] {
  return Array.from(html.matchAll(/<span>(.*?)<\/span>/g), (match) => match[1]);
}

describe('renderUrgentPanel selection contract', () => {
  it.each(INVALID_RESETS)('skips reset %s before selecting a later preferred window', (resetAt) => {
    const invalid = UsageWindow.fromApi('weekly', PCT_HALF, resetAt);
    const codex = Provider.fromAdapter('codex', 'CodeX', 'plus', [invalid]);

    expect(renderUrgentPanel([codex])).toBe('');

    codex.models[0].windows.push(
      UsageWindow.fromApi('weekly', PCT_HALF, isoFromNow(THREE_HOURS_MS)),
    );

    expect(renderUrgentPanel([codex])).toContain('weekly 3h');
  });

  it.each([
    null,
    PCT_ALMOST_SPENT,
    PCT_THRESHOLD,
    PCT_SPENT,
  ])('selects the first future preferred window before filtering usage %s', (usedPercent) => {
    const codex = new Provider('codex', 'CodeX', 'plus', [
      {
        modelName: 'wrong',
        windows: [UsageWindow.fromApi('weekly', PCT_HALF, isoFromNow(MS_PER_HOUR))],
      },
      {
        modelName: 'plus',
        windows: [
          UsageWindow.fromApi('monthly', PCT_HALF, isoFromNow(MS_PER_HOUR)),
          UsageWindow.fromApi('weekly', usedPercent, isoFromNow(TEN_HOURS_MS)),
          UsageWindow.fromApi('weekly', PCT_HALF, isoFromNow(MS_PER_HOUR)),
        ],
      },
      {
        modelName: 'plus',
        windows: [UsageWindow.fromApi('weekly', PCT_HALF, isoFromNow(THREE_HOURS_MS))],
      },
    ]);
    const fallback = Provider.fromAdapter('claude', 'Fallback', 'Claude', [
      UsageWindow.fromApi('monthly', PCT_HALF, isoFromNow(THREE_HOURS_MS)),
    ]);
    const html = renderUrgentPanel([codex, fallback]);

    if (usedPercent !== null && usedPercent >= PCT_THRESHOLD) {
      expect(html).toBe('');
      return;
    }

    expect(html).toContain('Spend urgently');
    expect(html).toContain('weekly 10h');
    expect(rowNames(html)).toEqual(['CodeX']);
  });

  it.each([
    [THRESHOLD_MS - 1, 'Spend urgently'],
    [THRESHOLD_MS, 'Consider spending'],
  ])('uses a strict urgent threshold at %s ms', (offset, title) => {
    const codex = Provider.fromAdapter('codex', 'CodeX', 'plus', [
      UsageWindow.fromApi('weekly', PCT_HALF, isoFromNow(offset)),
    ]);
    const claude = Provider.fromAdapter('claude', 'Claude', 'Claude', [
      UsageWindow.fromApi('monthly', PCT_HALF, isoFromNow(THREE_HOURS_MS)),
    ]);

    expect(renderUrgentPanel([codex, claude])).toContain(title);
  });

  it.each([
    [null, null, ['Target', 'Reference']],
    [PCT_EIGHTY, null, ['Reference', 'Target']],
    [PCT_EIGHTY, PCT_EIGHTY, ['Target', 'Reference']],
    [null, 0, ['Reference', 'Target']],
  ])('ranks usage %s and remaining %s without mutating callers', (used, remaining, names) => {
    const target = Provider.fromAdapter('codex', 'Target', 'plus', [
      {
        ...UsageWindow.fromApi('weekly', used, isoFromNow(THREE_HOURS_MS)),
        remainingPercent: remaining,
      },
    ]);
    const reference = Provider.fromAdapter('codex', 'Reference', 'plus', [
      UsageWindow.fromApi('weekly', PCT_HALF, isoFromNow(THREE_HOURS_MS)),
    ]);
    const providers = [target, reference];
    const before = JSON.stringify(providers);

    expect(rowNames(renderUrgentPanel(providers))).toEqual(names);
    expect(JSON.stringify(providers)).toBe(before);
  });

  it('sorts by computed urgency with stable ties and retains duplicate names', () => {
    const kimi = Provider.fromAdapter('kimi', 'Lower', 'Coding', [
      UsageWindow.fromApi('weekly', PCT_THREE_QUARTERS, isoFromNow(MS_PER_HOUR)),
    ]);
    const zai = Provider.fromAdapter('zai', 'First tie', 'Quota', [
      UsageWindow.fromApi('weekly', PCT_HALF, isoFromNow(2 * MS_PER_HOUR)),
    ]);
    const codex = Provider.fromAdapter('codex', 'Duplicate', 'plus', [
      UsageWindow.fromApi('weekly', PCT_EIGHTY, isoFromNow(MS_PER_HOUR)),
    ]);

    expect(rowNames(renderUrgentPanel([kimi, zai, codex, codex]))).toEqual([
      'First tie',
      'Duplicate',
      'Duplicate',
      'Lower',
    ]);
  });

  it('preserves panel markup and provider-name escaping', () => {
    const codex = Provider.fromAdapter('codex', '<CodeX> & "A" \'B\'', 'plus', [
      UsageWindow.fromApi('weekly', null, isoFromNow(THREE_HOURS_MS)),
    ]);

    expect(renderUrgentPanel([codex])).toBe(`
<div class="urgent-panel bg-theme-bg-secondary border border-theme-border rounded-theme-md p-3 shadow-theme-md max-w-xs">
  <div class="flex items-center gap-2 mb-2">
    <span class="inline-block w-2 h-2 rounded-full bg-orange-500"></span>
    <span class="text-sm font-semibold text-theme-text">Spend urgently</span>
  </div>
  <div class="space-y-1">
    <div class="flex justify-between text-xs font-mono">
        <span>&lt;CodeX&gt; &amp; &quot;A&quot; &#39;B&#39;</span>
        <span class="text-theme-text-secondary">weekly 3h</span>
      </div>
  </div>
</div>`);
  });
});

describe('renderUrgentPanel desirable selection contract', () => {
  let gate: Provider;

  beforeEach(() => {
    gate = Provider.fromAdapter('codex', 'Gate', 'plus', [
      UsageWindow.fromApi('weekly', PCT_HALF, isoFromNow(HUNDRED_HOURS_MS)),
    ]);
  });

  it('requires a viable preferred candidate and excludes every viable name, not id', () => {
    const otherGate = Provider.fromAdapter('zai', 'Other gate', 'Quota', [
      UsageWindow.fromApi('weekly', PCT_HALF, isoFromNow(HUNDRED_HOURS_MS)),
    ]);
    const sameName = Provider.fromAdapter('claude', gate.name, 'Claude', [
      UsageWindow.fromApi('monthly', PCT_HALF, isoFromNow(MS_PER_HOUR)),
    ]);
    const otherName = Provider.fromAdapter('kimi', otherGate.name, 'Coding', [
      UsageWindow.fromApi('monthly', PCT_HALF, isoFromNow(MS_PER_HOUR)),
    ]);
    const sameId = Provider.fromAdapter('codex', 'Same id', 'plus', [
      UsageWindow.fromApi('monthly', PCT_HALF, isoFromNow(THREE_HOURS_MS)),
    ]);

    expect(renderUrgentPanel([sameName, otherName, sameId])).toBe('');
    expect(rowNames(renderUrgentPanel([gate, otherGate, sameName, otherName, sameId]))).toEqual([
      'Same id',
    ]);
  });

  it.each([
    [TEN_HOURS_MS, TEN_HOURS_MS, 'monthly'],
    [THREE_HOURS_MS, THREE_HOURS_MS, 'daily'],
    [TEN_HOURS_MS, THREE_HOURS_MS, 'hourly'],
  ])('keeps the first nearest window with offsets %s and %s', (dailyMs, hourlyMs, label) => {
    const claude = new Provider('claude', 'Claude', 'pro', [
      {
        modelName: 'wrong',
        windows: [UsageWindow.fromApi('monthly', PCT_HALF, isoFromNow(MS_PER_HOUR))],
      },
      {
        modelName: 'Claude',
        windows: [
          ...INVALID_RESETS.map((reset) => UsageWindow.fromApi('invalid', PCT_HALF, reset)),
          UsageWindow.fromApi('spent', PCT_THRESHOLD, isoFromNow(MS_PER_HOUR)),
          UsageWindow.fromApi('monthly', null, isoFromNow(TEN_HOURS_MS)),
          UsageWindow.fromApi('daily', PCT_HALF, isoFromNow(dailyMs)),
        ],
      },
      {
        modelName: 'Claude',
        windows: [UsageWindow.fromApi('hourly', PCT_HALF, isoFromNow(hourlyMs))],
      },
    ]);
    const html = renderUrgentPanel([gate, claude]);
    const hours = Math.min(TEN_HOURS_MS, dailyMs, hourlyMs) / MS_PER_HOUR;

    expect(html).toContain('Consider spending');
    expect(html).toContain(`${label} ${hours}h`);
    expect(rowNames(html)).toEqual(['Claude']);
  });

  it('keeps provider order for equal reset hours and limits desirable rows to two', () => {
    const providers = [
      gate,
      Provider.fromAdapter('zai', 'Zai', 'Quota', [
        UsageWindow.fromApi('monthly', PCT_HALF, isoFromNow(THREE_HOURS_MS)),
      ]),
      Provider.fromAdapter('kimi', 'Kimi', 'Coding', [
        UsageWindow.fromApi('monthly', PCT_HALF, isoFromNow(THREE_HOURS_MS)),
      ]),
      Provider.fromAdapter('claude', 'Claude', 'Claude', [
        UsageWindow.fromApi('monthly', PCT_HALF, isoFromNow(THREE_HOURS_MS)),
      ]),
    ];
    const before = JSON.stringify(providers);

    expect(rowNames(renderUrgentPanel(providers))).toEqual(['Zai', 'Kimi']);
    expect(JSON.stringify(providers)).toBe(before);
  });

  it('samples the clock per checked reset and stops urgent traversal at its first match', () => {
    const now = Date.now();
    const expiredMs = 5;
    const nearestMs = 7;
    const laterMs = 9;
    const expectedSamples = 8;
    const codex = Provider.fromAdapter('codex', 'CodeX', 'plus', [
      UsageWindow.fromApi('monthly', PCT_HALF, isoFromNow(MS_PER_HOUR)),
      UsageWindow.fromApi('weekly', PCT_HALF, null),
      UsageWindow.fromApi('weekly', PCT_HALF, 'invalid reset'),
      UsageWindow.fromApi('weekly', PCT_HALF, isoFromNow(1)),
      UsageWindow.fromApi('weekly', PCT_HALF, isoFromNow(HUNDRED_HOURS_MS)),
      UsageWindow.fromApi('weekly', PCT_HALF, isoFromNow(THREE_HOURS_MS)),
    ]);
    const claude = Provider.fromAdapter('claude', 'Claude', 'Claude', [
      UsageWindow.fromApi('monthly', PCT_HALF, null),
      UsageWindow.fromApi('monthly', PCT_HALF, 'invalid reset'),
      UsageWindow.fromApi('spent', PCT_THRESHOLD, isoFromNow(HUNDRED_HOURS_MS)),
      UsageWindow.fromApi('monthly', PCT_HALF, isoFromNow(expiredMs)),
      UsageWindow.fromApi('daily', PCT_HALF, isoFromNow(nearestMs)),
      UsageWindow.fromApi('hourly', PCT_HALF, isoFromNow(laterMs)),
    ]);
    let sample = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now + sample++);
    const html = renderUrgentPanel([codex, claude]);

    expect(html).toContain('Consider spending');
    expect(html).toContain('daily <1m');
    expect(clock).toHaveBeenCalledTimes(expectedSamples);
  });
});
