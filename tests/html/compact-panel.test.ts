import { describe, expect, it } from 'vitest';
import { isCompactProvider, renderCompactPanel } from '../../src/html/compact-panel.js';
import { Provider } from '../../src/provider.js';
import { UsageWindow } from '../../src/usage-window.js';

// ── Percent / count constants ───────────────────────────────
const PCT_HALF = 50;
const COUNT_USED = 1_200_000;
const COUNT_TOTAL = 5_000_000;
const FORTY_EIGHT_HOURS_MS = 172_800_000;

// ── isCompactProvider ───────────────────────────────────────

describe('isCompactProvider', () => {
  it('распознаёт известные compact-провайдеры', () => {
    const compact = new Provider('deepseek', 'DeepSeek', 'pro', []);

    expect(isCompactProvider(compact)).toBe(true);
  });

  it('не считает обычного провайдера compact', () => {
    const normal = new Provider('codex', 'CodeX', 'plus', []);

    expect(isCompactProvider(normal)).toBe(false);
  });

  it('распознаёт openrouter и opencode zen как compact', () => {
    expect(isCompactProvider(new Provider('openrouter', 'OpenRouter', 'Credits', []))).toBe(true);
    expect(isCompactProvider(new Provider('opencode', 'OpenCode Zen', 'Zen', []))).toBe(true);
  });
});

// ── renderCompactPanel ──────────────────────────────────────

describe('renderCompactPanel', () => {
  it('возвращает пустую строку без compact-провайдеров', () => {
    expect(renderCompactPanel([])).toBe('');
    expect(renderCompactPanel([new Provider('codex', 'CodeX', 'plus', [])])).toBe('');
  });

  it('показывает метку обновления с provider-updated для compact-карточки', () => {
    const now = Date.now();
    const provider = new Provider(
      'deepseek',
      'DeepSeek',
      'pro',
      [
        {
          modelName: 'Chat',
          windows: [UsageWindow.fromApi('daily', null, null, null, '1.2M tokens')],
        },
      ],
      undefined,
      now,
    );

    const html = renderCompactPanel([provider]);

    expect(html).toContain('provider-updated');
    expect(html).toContain(`data-provider-updated="${now}"`);
  });

  it('не показывает метку обновления без updatedAt', () => {
    const provider = new Provider('deepseek', 'DeepSeek', 'pro', [
      {
        modelName: 'Chat',
        windows: [UsageWindow.fromApi('daily', null, null, null, '1.2M tokens')],
      },
    ]);

    expect(renderCompactPanel([provider])).not.toMatch(/data-provider-updated="\d+"/);
  });

  it('пропускает compact-провайдера с ошибкой', () => {
    const provider = new Provider('deepseek', 'DeepSeek', 'pro', [], 'boom');

    expect(renderCompactPanel([provider])).toBe('');
  });

  it('извлекает значение для deepseek (valueLabel)', () => {
    const provider = new Provider('deepseek', 'DeepSeek', 'pro', [
      {
        modelName: 'Chat',
        windows: [UsageWindow.fromApi('daily', null, null, null, '1.2M tokens')],
      },
    ]);

    expect(renderCompactPanel([provider])).toContain('1.2M tokens');
  });

  it('извлекает значение для evolink (окно User)', () => {
    const provider = new Provider('evolink', 'Evolink', 'pro', [
      { modelName: 'm', windows: [UsageWindow.fromApi('User', null, null, null, '42 users')] },
    ]);

    expect(renderCompactPanel([provider])).toContain('42 users');
  });

  it('извлекает строки для tavily (used/total)', () => {
    const provider = new Provider('tavily', 'Tavily', 'pro', [
      { modelName: 'm', windows: [UsageWindow.fromCounts('api', COUNT_USED, COUNT_TOTAL, null)] },
    ]);

    const html = renderCompactPanel([provider]);

    expect(html).toContain(`${COUNT_USED.toLocaleString('en')}`);
    expect(html).toContain('Tavily');
  });

  it('извлекает строки для tavily-3 (used/total)', () => {
    const provider = new Provider('tavily-3', 'Tavily 3', 'pro', [
      { modelName: 'm', windows: [UsageWindow.fromCounts('api', COUNT_USED, COUNT_TOTAL, null)] },
    ]);

    const html = renderCompactPanel([provider]);

    expect(html).toContain(`${COUNT_USED.toLocaleString('en')}`);
    expect(html).toContain('Tavily 3');
  });

  it('извлекает процент и время до сброса для grok (monthly)', () => {
    const provider = new Provider('grok', 'Grok', 'pro', [
      { modelName: 'm', windows: [UsageWindow.fromApi('monthly', PCT_HALF, null)] },
    ]);

    expect(renderCompactPanel([provider])).toContain(`${PCT_HALF.toFixed(1)}%`);
  });

  it('добавляет время до сброса для grok при наличии resetAt', () => {
    const futureIso = new Date(Date.now() + FORTY_EIGHT_HOURS_MS).toISOString();
    const provider = new Provider('grok', 'Grok', 'pro', [
      { modelName: 'm', windows: [UsageWindow.fromApi('monthly', PCT_HALF, futureIso)] },
    ]);

    const html = renderCompactPanel([provider]);

    expect(html).toContain(`${PCT_HALF.toFixed(1)}%`);
    expect(html).toContain(' · ');
  });

  it('извлекает значение для context7 (monthly: процент и used/total)', () => {
    const provider = new Provider('context7', 'Context7', 'pro', [
      {
        modelName: 'm',
        windows: [UsageWindow.fromCounts('monthly', COUNT_USED, COUNT_TOTAL, null)],
      },
    ]);

    const html = renderCompactPanel([provider]);

    // usedPercent = COUNT_USED / COUNT_TOTAL * 100 = 24%
    expect(html).toContain('24% used');
    expect(html).toContain(COUNT_USED.toLocaleString('en'));
    expect(html).toContain(COUNT_TOTAL.toLocaleString('en'));
  });

  it('извлекает значение для brave (monthly + valueLabel)', () => {
    const provider = new Provider('brave', 'Brave', 'pro', [
      {
        modelName: 'm',
        windows: [UsageWindow.fromApi('monthly', null, null, null, 'brave-key ok')],
      },
    ]);

    expect(renderCompactPanel([provider])).toContain('brave-key ok');
  });

  it('извлекает значение для firecrawl (credits + valueLabel)', () => {
    const provider = new Provider('firecrawl', 'Firecrawl', 'pro', [
      {
        modelName: 'm',
        windows: [UsageWindow.fromApi('credits', null, null, null, '500 credits')],
      },
    ]);

    expect(renderCompactPanel([provider])).toContain('500 credits');
  });

  it('извлекает значение для openrouter (credits + valueLabel)', () => {
    const provider = new Provider('openrouter', 'OpenRouter', 'Credits', [
      {
        modelName: 'm',
        windows: [UsageWindow.fromApi('credits', null, null, null, '$5.56 of $23.00')],
      },
    ]);

    expect(renderCompactPanel([provider])).toContain('$5.56 of $23.00');
  });

  it('извлекает значение для opencode zen (balance + valueLabel)', () => {
    const provider = new Provider('opencode', 'OpenCode Zen', 'Zen', [
      { modelName: 'm', windows: [UsageWindow.fromApi('balance', null, null, null, '$6.71')] },
    ]);

    expect(renderCompactPanel([provider])).toContain('$6.71');
  });

  it('рендерит несколько compact-карточек одновременно', () => {
    const deepseek = new Provider('deepseek', 'DeepSeek', 'pro', [
      { modelName: 'Chat', windows: [UsageWindow.fromApi('daily', null, null, null, 'a')] },
    ]);
    const brave = new Provider('brave', 'Brave', 'pro', [
      { modelName: 'm', windows: [UsageWindow.fromApi('monthly', null, null, null, 'b')] },
    ]);

    const html = renderCompactPanel([deepseek, brave]);

    expect(html).toContain('DeepSeek');
    expect(html).toContain('Brave');
  });
});
