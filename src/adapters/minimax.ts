import type { ProviderAdapter, Provider, ModelUsage } from './types';

interface ModelRemainRaw {
  model_name?: string;
  current_interval_total_count?: number;
  current_interval_usage_count?: number;
  end_time?: number;
  current_weekly_total_count?: number;
  current_weekly_usage_count?: number;
  weekly_end_time?: number;
}

interface MiniMaxResponse {
  model_remains?: ModelRemainRaw[];
  base_resp?: { status_code?: number; status_msg?: string };
}

const ENDPOINTS = [
  'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
  'https://www.minimax.io/v1/api/openplatform/coding_plan/remains',
];

function calcPercent(total: number, remaining: number): number {
  const clamped = Math.min(Math.max(remaining, 0), total);
  const used = total - clamped;
  return (used / total) * 100;
}

function epochToISO(ms: number | null | undefined): string | null {
  if (!ms) return null;
  return new Date(ms).toISOString();
}

function mapModel(raw: ModelRemainRaw): ModelUsage {
  const intervalTotal = raw.current_interval_total_count;
  const intervalRemain = raw.current_interval_usage_count;
  const weeklyTotal = raw.current_weekly_total_count;
  const weeklyRemain = raw.current_weekly_usage_count;

  return {
    modelName: raw.model_name ?? 'unknown',
    fiveHourUsage: intervalTotal != null && intervalRemain != null && intervalTotal > 0
      ? Math.round(calcPercent(intervalTotal, intervalRemain) * 10) / 10
      : null,
    fiveHourReset: epochToISO(raw.end_time),
    weeklyUsage: weeklyTotal != null && weeklyRemain != null && weeklyTotal > 0
      ? Math.round(calcPercent(weeklyTotal, weeklyRemain) * 10) / 10
      : null,
    weeklyReset: epochToISO(raw.weekly_end_time),
  };
}

export class MiniMaxAdapter implements ProviderAdapter {
  id = 'minimax';
  name = 'MiniMax Token Plan';

  async fetchUsage(): Promise<Provider> {
    const apiKey = process.env.MINIMAX_API_KEY;
    if (!apiKey) throw new Error('MINIMAX_API_KEY not set');

    let lastError: unknown;

    for (const endpoint of ENDPOINTS) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);

        const response = await fetch(endpoint, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = (await response.json()) as MiniMaxResponse;

        if (data.base_resp?.status_code !== 0) {
          throw new Error(data.base_resp?.status_msg ?? 'API error');
        }

        const models = (data.model_remains ?? [])
          .filter((r) => r.current_interval_total_count && r.current_interval_total_count > 0
            || r.current_weekly_total_count && r.current_weekly_total_count > 0)
          .sort((a, b) => (a.model_name ?? '').localeCompare(b.model_name ?? ''))
          .map(mapModel);

        return {
          id: this.id,
          name: this.name,
          plan: models[0]?.modelName ?? 'unknown',
          models,
        };
      } catch (err) {
        lastError = err;
        continue;
      }
    }

    throw lastError ?? new Error('All MiniMax endpoints failed');
  }
}
