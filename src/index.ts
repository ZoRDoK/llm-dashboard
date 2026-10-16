import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { z } from 'zod';

import { registerAdapters } from './adapters/registry.js';

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
