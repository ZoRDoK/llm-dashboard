import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { z } from 'zod';

import { AlibabaQwen } from './adapters/alibaba-qwen.js';
import { Brave } from './adapters/brave.js';
import { Claude } from './adapters/claude.js';
import { Codex } from './adapters/codex.js';
import { CommandCode } from './adapters/commandcode.js';
import { Context7 } from './adapters/context7.js';
import { DeepSeek } from './adapters/deepseek.js';
import { Evolink } from './adapters/evolink.js';
import { Firecrawl } from './adapters/firecrawl.js';
import { Grok } from './adapters/grok.js';
import { Kimi } from './adapters/kimi.js';
import { Mimo } from './adapters/mimo.js';
import { MiniMax } from './adapters/minimax.js';
import { OllamaCloud } from './adapters/ollama-cloud.js';
import { OpenCodeGo } from './adapters/opencode-go.js';
import { OpenCodeZen } from './adapters/opencode-zen.js';
import { OpenRouter } from './adapters/openrouter.js';
import { R4 } from './adapters/r4.js';
import { Synthetic } from './adapters/synthetic.js';
import { Tavily } from './adapters/tavily.js';
import { Zai } from './adapters/zai.js';

import { config } from './config.js';
import { renderHistoryPanel } from './html/history-panel.js';
import { renderLogsPanel } from './html/logs-panel.js';
import { renderMetricsPanel } from './html/metrics-panel.js';
import { type PChartsRange, renderPChartsPage } from './html/p-charts.js';
import { renderWatchdogPanel } from './html/watchdog-panel.js';
import { renderDashboard } from './html.js';
import { createLogger } from './logger.js';
import { PiUsageIndex } from './pi-usage.js';
import { ProviderManager } from './provider-manager.js';
import { ProviderStore } from './store.js';
import type { ProviderAdapter } from './types.js';
import { Watchdog } from './watchdog.js';

const log = createLogger('api');

const BILLING_BODY_SCHEMA = z.object({
  billingOverrides: z.record(z.string(), z.string().nullable()),
});

const PCHARTS_RANGE_SCHEMA = z.enum(['7', '30', '90', 'all']);

process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  // Rejection reasons are unknown values; normalize so the err serializer
  // always emits a message and stack.
  const err = reason instanceof Error ? reason : new Error(String(reason));

  log.error({ err }, 'Unhandled rejection');
  process.exit(1);
});

const app = new Hono();

app.onError((err, c) => {
  log.error({ err, method: c.req.method, path: c.req.path }, 'Request error');

  // biome-ignore lint/style/noMagicNumbers: standard HTTP status code
  return c.json({ error: 'Internal server error' }, 500);
});

app.notFound((c) => {
  // biome-ignore lint/style/noMagicNumbers: standard HTTP status code
  return c.json({ error: 'Not found' }, 404);
});

function registerAdapters(manager: ProviderManager): void {
  const adapters: ProviderAdapter[] = [
    new Brave(),
    new Mimo(),
    new MiniMax(),
    new OpenCodeGo(),
    new OpenCodeGo({
      id: 'opencode-go-2',
      name: 'OpenCode Go 2',
      sessionCookie: config.OPENCODE_GO_2_SESSION_COOKIE,
      workspaceId: config.OPENCODE_GO_2_WORKSPACE_ID,
    }),
    new OpenCodeZen(),
    new OllamaCloud(),
    new Claude(),
    new Codex(),
    new CommandCode(),
    new R4(),
    new DeepSeek(),
    new Evolink(),
    new Firecrawl(),
    new OpenRouter(),
    new Grok(),
    new Kimi(),
    new Zai(),
    new Synthetic(),
    new AlibabaQwen(),
    new Tavily(),
    new Tavily({
      id: 'tavily-2',
      name: 'Tavily 2',
      apiKey: config.TAVILY_API_KEY_2,
    }),
    new Tavily({
      id: 'tavily-3',
      name: 'Tavily 3',
      apiKey: config.TAVILY_API_KEY_3,
    }),
    new Context7(),
  ];

  for (const adapter of adapters) {
    manager.register(adapter);
  }

  // Rate-limited providers — fetched on the slow refresh schedule.
  for (const id of ['commandcode', 'r4', 'tavily', 'tavily-2', 'tavily-3']) {
    manager.markSlow(id);
  }
}

const store = new ProviderStore();

store.init();

const manager = new ProviderManager(store);

registerAdapters(manager);

manager.start();

// Constructed even when disabled so the dashboard panel keeps working;
// only the periodic ticking is gated by the config flag.
const watchdog = new Watchdog({ store, manager });

if (config.WATCHDOG_ENABLED) {
  watchdog.start();
}

// Indexes pi session logs for the /p-charts token usage page.
const piUsage = new PiUsageIndex();

piUsage.start();

function shutdown(): void {
  log.info('Shutting down');

  watchdog.stop();
  manager.stop();
  piUsage.stop();
  store.close();

  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.get('/', (c) => {
  const providers = manager.getCachedProviders();
  const billingSettings = store.getBillingSettings();
  const lastUpdated = manager.getLastUpdated();
  const archiveSet = store.getArchiveSettings();
  const metrics = manager.getMetrics();
  const logs = manager.getLogs();
  const history = manager.getQuotaHistory();
  const watchdogPanel = renderWatchdogPanel(watchdog.getPanelData());

  return c.html(
    renderDashboard(
      providers,
      lastUpdated,
      billingSettings,
      archiveSet,
      metrics,
      logs,
      history,
      watchdogPanel,
    ),
  );
});

app.get('/api/providers', (c) => {
  const providers = manager.getCachedProviders();

  return c.json({ providers });
});

app.post('/api/refresh', async (c) => {
  const providers = await manager.refresh();

  return c.json({ providers });
});

app.get('/api/settings/billing', (c) => {
  return c.json({ billingOverrides: store.getBillingSettings() });
});

app.post('/api/settings/billing', async (c) => {
  const { billingOverrides } = BILLING_BODY_SCHEMA.parse(await c.req.json());

  for (const [providerId, value] of Object.entries(billingOverrides)) {
    const trimmed = value?.trim() ?? null;
    store.setBillingSetting(providerId, trimmed === '' ? null : trimmed);
  }

  return c.json({ ok: true, billingOverrides: store.getBillingSettings() });
});

const ARCHIVE_BODY_SCHEMA = z.object({
  providerId: z.string(),
  archived: z.boolean(),
});

app.get('/api/settings/archive', (c) => {
  const archiveSet = store.getArchiveSettings();

  return c.json({ archive: [...archiveSet] });
});

app.post('/api/settings/archive', async (c) => {
  const { providerId, archived } = ARCHIVE_BODY_SCHEMA.parse(await c.req.json());

  store.setArchiveSetting(providerId, archived);
  manager.recordArchive(providerId, archived);

  const archiveSet = store.getArchiveSettings();

  return c.json({ ok: true, archive: [...archiveSet] });
});

app.get('/api/metrics', (c) => {
  return c.html(renderMetricsPanel(manager.getMetrics()));
});

app.get('/api/history', (c) => {
  return c.html(renderHistoryPanel(manager.getQuotaHistory()));
});

app.get('/api/logs', (c) => {
  return c.html(renderLogsPanel(manager.getLogs()));
});

app.get('/api/watchdog', (c) => {
  return c.html(renderWatchdogPanel(watchdog.getPanelData()));
});

function pchartsRange(raw: string | undefined): { range: PChartsRange; rangeDays: number | 'all' } {
  const parsed = PCHARTS_RANGE_SCHEMA.safeParse(raw);
  const range = parsed.success ? parsed.data : '30';
  const rangeDays = range === 'all' ? 'all' : Number(range);

  return { range, rangeDays };
}

app.get('/p-charts', (c) => {
  const { range, rangeDays } = pchartsRange(c.req.query('range'));

  // Fire-and-forget: the scan loop yields between files, so requests stay responsive.
  piUsage.rescanIfStale();

  return c.html(renderPChartsPage(piUsage.getStats(rangeDays), range));
});

app.get('/api/pcharts', (c) => {
  const { rangeDays } = pchartsRange(c.req.query('range'));

  return c.json(piUsage.getStats(rangeDays));
});

const server = serve({ fetch: app.fetch, port: config.PORT, hostname: '127.0.0.1' }, (info) => {
  log.info({ port: info.port }, 'Server listening');
});

// Without a handler a failed bind (e.g. EADDRINUSE) would surface as an
// uncaught exception; log it as a server error and exit so the unit restarts
// instead of lingering without a listener.
server.on('error', (err) => {
  log.error({ err }, 'Server error');
  process.exit(1);
});
