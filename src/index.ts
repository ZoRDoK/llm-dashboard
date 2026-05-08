import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { z } from 'zod';
import { Codex } from './adapters/codex';
import { Context7 } from './adapters/context7';
import { MiniMax } from './adapters/minimax';
import { OllamaCloud } from './adapters/ollama-cloud';
import { OpenCodeGo } from './adapters/opencode-go';
import { Tavily } from './adapters/tavily';
import { config } from './config';
import { renderDashboard } from './html';
import { ProviderManager } from './provider-manager';
import { ProviderStore } from './store';

const BILLING_BODY_SCHEMA = z.object({
  billingOverrides: z.record(z.string(), z.string().nullable()),
});

const STATUS_500 = 500;
const STATUS_404 = 404;

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

const app = new Hono();

app.onError((err, c) => {
  console.error('Request error:', err);

  return c.json({ error: 'Internal server error' }, STATUS_500);
});

app.notFound((c) => {
  return c.json({ error: 'Not found' }, STATUS_404);
});

const store = new ProviderStore();

store.init();

const manager = new ProviderManager(store);

manager.register(new MiniMax());
manager.register(new OpenCodeGo());
manager.register(new OllamaCloud());
manager.register(new Codex());
manager.register(new Tavily());
manager.markSlow('tavily');
manager.register(new Context7());

manager.start();

function shutdown(): void {
  console.info('Shutting down...');

  manager.stop();
  store.close();

  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.get('/', (c) => {
  const providers = manager.getCachedProviders();
  const billingSettings = store.getBillingSettings();
  const lastUpdated = manager.getLastUpdated();

  return c.html(renderDashboard(providers, lastUpdated, billingSettings));
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

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.info(`Server listening on http://localhost:${info.port}`);
});
