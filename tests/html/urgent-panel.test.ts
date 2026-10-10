import { describe, expect, it } from 'vitest';
import { renderUrgentPanel } from '../../src/html/urgent-panel.js';
import { Provider } from '../../src/provider.js';
import { UsageWindow } from '../../src/usage-window.js';

// ── Percent constants ───────────────────────────────────────
const PCT_HALF = 50;
const PCT_EIGHTY = 80;
const PCT_SPENT = 96;

// ── Reset offsets in milliseconds ───────────────────────────
const THREE_HOURS_MS = 10_800_000;
const TEN_HOURS_MS = 36_000_000;
const FIFTY_HOURS_MS = 180_000_000;
const HUNDRED_HOURS_MS = 360_000_000;

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
