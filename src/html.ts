import type { Provider, ModelUsage } from './adapters/types';

function usageColor(percent: number | null): string {
  if (percent == null) return 'bg-gray-400';
  if (percent < 50) return 'bg-green-500';
  if (percent < 80) return 'bg-yellow-500';
  return 'bg-red-500';
}

function barWidth(percent: number | null): string {
  if (percent == null) return '0%';
  return `${Math.min(percent, 100)}%`;
}

function timeUntil(reset: string | null): string {
  if (!reset) return '—';
  const ms = new Date(reset).getTime() - Date.now();
  if (ms <= 0) return 'сейчас';
  const mins = Math.floor(ms / 60_000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  if (days > 0) return `${days}д ${hrs % 24}ч`;
  if (hrs > 0) return `${hrs}ч ${mins % 60}м`;
  return `${mins}м`;
}

function modelRow(m: ModelUsage): string {
  const fh = m.fiveHourUsage;
  const wk = m.weeklyUsage;

  return `
    <div class="border border-gray-700 rounded-lg p-4 bg-gray-900">
      <div class="flex items-center justify-between mb-3">
        <span class="text-sm font-mono text-gray-300">${m.modelName}</span>
      </div>
      <div class="grid grid-cols-2 gap-4">
        <div>
          <div class="flex justify-between text-xs text-gray-400 mb-1">
            <span>5hr</span>
            <span>${fh != null ? fh.toFixed(1) + '%' : '—'} · ${timeUntil(m.fiveHourReset)}</span>
          </div>
          <div class="w-full bg-gray-800 rounded h-2">
            <div class="h-2 rounded ${usageColor(fh)}" style="width:${barWidth(fh)}"></div>
          </div>
        </div>
        <div>
          <div class="flex justify-between text-xs text-gray-400 mb-1">
            <span>Weekly</span>
            <span>${wk != null ? wk.toFixed(1) + '%' : '—'} · ${timeUntil(m.weeklyReset)}</span>
          </div>
          <div class="w-full bg-gray-800 rounded h-2">
            <div class="h-2 rounded ${usageColor(wk)}" style="width:${barWidth(wk)}"></div>
          </div>
        </div>
      </div>
    </div>`;
}

function errorCard(provider: Provider): string {
  return `
    <div class="border border-red-700 rounded-lg p-4 bg-red-900/30">
      <div class="text-red-400 text-sm">Ошибка: ${provider.error}</div>
    </div>`;
}

export function renderDashboard(providers: Provider[], cached: boolean): string {
  const rows = providers.map((p) => {
    if (p.error) return errorCard(p);
    return p.models.map(modelRow).join('');
  }).join('');

  const cacheLabel = cached
    ? '<span class="text-yellow-400 text-xs">(кэш)</span>'
    : '<span class="text-green-400 text-xs">(свежее)</span>';

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Creds — Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-950 text-white min-h-screen">
  <div class="max-w-2xl mx-auto px-4 py-8">
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold">AI Creds</h1>
      <div class="flex items-center gap-3">
        ${cacheLabel}
        <button id="refresh-btn" onclick="refresh()"
          class="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm transition">
          Refresh
        </button>
      </div>
    </div>
    <div class="space-y-3" id="dashboard">
      ${rows}
    </div>
    <div id="status" class="mt-4 text-sm text-gray-500 text-center"></div>
  </div>
  <script>
    async function load() {
      const status = document.getElementById('status');
      status.textContent = 'загрузка...';
      try {
        const r = await fetch('/api/providers');
        const data = await r.json();
        window.location.reload();
      } catch (e) {
        status.textContent = 'ошибка загрузки';
      }
    }
    async function refresh() {
      const status = document.getElementById('status');
      const btn = document.getElementById('refresh-btn');
      status.textContent = 'обновление...';
      btn.disabled = true;
      try {
        const r = await fetch('/api/refresh', { method: 'POST' });
        if (r.ok) window.location.reload();
        else status.textContent = 'ошибка обновления';
      } catch (e) {
        status.textContent = 'ошибка обновления';
      } finally {
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>`;
}
