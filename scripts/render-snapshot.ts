/**
 * Render a deterministic dashboard snapshot for byte-level diffing.
 * Freezes Date.now so elapsed labels are stable between runs.
 */
import { writeFileSync } from 'node:fs';

const FIXED = 1_730_000_000_000;
const RealDate = globalThis.Date;

class FrozenDate extends RealDate {
  static now() {
    return FIXED;
  }

  constructor(...args) {
    super(args.length > 0 ? args[0] : FIXED);
  }
}

globalThis.Date = FrozenDate;

const { renderDashboard } = await import('../src/html.js');
const { Provider } = await import('../src/provider.js');
const { UsageWindow } = await import('../src/usage-window.js');

const now = FIXED;
const hourFromNow = new Date(FIXED + 3_600_000).toISOString();
const dayFromNow = new Date(FIXED + 86_400_000).toISOString();
const weekFromNow = new Date(FIXED + 604_800_000).toISOString();

const providers = [
  new Provider(
    'opencode-go',
    'OpenCode Go',
    'Go Plan',
    [
      { modelName: 'Go Plan', windows: [
        UsageWindow.fromSection('5h', 42, '5 hours'),
        UsageWindow.fromSection('weekly', 73, '2 days'),
        UsageWindow.fromSection('monthly', 10, '20 days'),
      ] },
    ],
    undefined,
    now - 120_000,
  ),
  new Provider(
    'minimax',
    'MiniMax Token Plan',
    'Token Plan',
    [
      { modelName: 'coding-plan-pro', windows: [UsageWindow.fromApi('5h', 5, hourFromNow)] },
      { modelName: 'MiniMax-Text', windows: [UsageWindow.fromApi('weekly', 55, weekFromNow)] },
    ],
    undefined,
    now - 300_000,
  ),
  new Provider('codex', 'OpenAI Codex', 'plus', [
    { modelName: 'plus', windows: [
      UsageWindow.fromApi('weekly', 60, weekFromNow),
      UsageWindow.fromApi('credits', null, null, 12.5, '$12.50 remaining'),
    ] },
  ]),
  new Provider(
    'kimi',
    'Kimi',
    'Plus',
    [{ modelName: 'Coding', windows: [UsageWindow.fromCounts('weekly', 800, 1000, weekFromNow)] }],
    undefined,
    now - 720_000,
    true,
  ),
  new Provider('deepseek', 'DeepSeek', 'API', [
    { modelName: 'API Usage', windows: [UsageWindow.fromApi('USD', null, null, null, '9.24 USD')] },
  ]),
  new Provider('evolink', 'Evolink AI', 'API', [
    { modelName: 'Credits', windows: [UsageWindow.fromApi('User', null, null, null, '585 credits')] },
  ]),
  new Provider('tavily', 'Tavily', 'Research', [
    { modelName: 'Tavily', windows: [
      UsageWindow.fromCounts('plan', 35, 1000, null),
      UsageWindow.fromCounts('key', 3, 100, null),
    ] },
  ]),
  new Provider('brave', 'Brave', 'Search API', [
    { modelName: 'Tokens', windows: [
      UsageWindow.fromApi('monthly', 25, null, undefined, '12345 tokens'),
    ] },
  ]),
  new Provider('firecrawl', 'Firecrawl', 'Credits', [
    { modelName: 'Credits', windows: [
      UsageWindow.fromApi('credits', 40, dayFromNow, undefined, '400 / 1000 used'),
    ] },
  ]),
  new Provider('openrouter', 'OpenRouter', 'Credits', [
    { modelName: 'credits', windows: [
      UsageWindow.fromCounts('credits', 3, 10, null, '$7.00 of $10.00'),
    ] },
  ]),
  new Provider('opencode', 'OpenCode Zen', 'Zen', [
    { modelName: 'Zen', windows: [UsageWindow.fromApi('balance', null, null, null, '$6.71')] },
  ]),
  new Provider('grok', 'Grok', 'SuperGrok', [
    { modelName: 'SuperGrok', windows: [UsageWindow.fromApi('monthly', 33.3, dayFromNow)] },
  ]),
  new Provider('context7', 'Context7', 'Free', [
    { modelName: 'Context7', windows: [
      UsageWindow.fromCounts('monthly', 42, 100, null, null),
    ] },
  ]),
  new Provider('broken', 'Broken', 'unknown', [], 'HTTP 500', now - 60_000),
  new Provider(
    'archived-one',
    'Archived One',
    'Pro',
    [{ modelName: 'Pro', windows: [UsageWindow.fromApi('5h', 12, hourFromNow)] }],
    undefined,
    now - 60_000,
  ),
];

const metrics = providers.slice(0, 6).map((p, i) => ({
  id: p.id,
  name: p.name,
  archived: i === 5,
  configured: i !== 4,
  lastSuccessAt: i === 0 ? now - 60_000 : i === 1 ? null : now - 7_200_000,
  lastAttemptAt: now - 60_000,
}));

const logs = [
  { ts: now, level: 'info', message: 'Refresh complete (5 ok, 1 failed)' },
  { ts: now - 1000, level: 'warn', message: 'Kimi update failed: HTTP 429', providerId: 'kimi' },
  { ts: now - 2000, level: 'error', message: 'Broken update failed: HTTP 500', providerId: 'broken' },
];

const history = [
  {
    providerId: 'codex',
    providerName: 'OpenAI Codex',
    periodKey: '2025-10-27',
    resetAt: '2025-11-03T00:00:00.000Z',
    startedAt: '2025-10-27T00:00:00.000Z',
    usedPercent: 55.5,
    remainingPercent: 44.5,
    firstSampledAt: now - 500_000,
    lastSampledAt: now - 1000,
    sampleCount: 7,
    completed: false,
  },
  {
    providerId: 'codex',
    providerName: 'OpenAI Codex',
    periodKey: '2025-10-20',
    resetAt: '2025-10-27T00:00:00.000Z',
    startedAt: '2025-10-20T00:00:00.000Z',
    usedPercent: 80.2,
    remainingPercent: 19.8,
    firstSampledAt: now - 900_000,
    lastSampledAt: now - 600_000,
    sampleCount: 42,
    completed: true,
  },
];

const html = renderDashboard(
  providers,
  now,
  { 'opencode-go': '2025-11-20T00:00:00.000Z', codex: '2026-01-01T00:00:00.000Z' },
  new Set(['archived-one']),
  metrics,
  logs,
  history,
);

writeFileSync(process.argv[2] ?? '/tmp/dashboard-snapshot.html', html);
console.info('snapshot written:', process.argv[2], html.length, 'bytes');
