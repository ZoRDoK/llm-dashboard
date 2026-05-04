import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { MiniMaxAdapter } from './adapters/minimax';
import { OpenCodeGoAdapter } from './adapters/opencode-go';
import { ProviderService } from './service';
import { renderDashboard } from './html';

const app = new Hono();

const service = new ProviderService(60_000);
service.register(new MiniMaxAdapter());
service.register(new OpenCodeGoAdapter());

app.get('/', async (c) => {
  const cached = !service.isExpired();
  const providers = await service.getAllProviders();
  return c.html(renderDashboard(providers, cached));
});

app.get('/api/providers', async (c) => {
  const providers = await service.getAllProviders();
  return c.json({ providers });
});

app.post('/api/refresh', async (c) => {
  const providers = await service.refresh();
  return c.json({ providers });
});

const port = Number(process.env.PORT) || 3001;

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server on http://localhost:${info.port}`);
});
