import { z } from 'zod';
import { config } from '../config.js';
import { ModelUsage } from '../model-usage.js';
import { Provider } from '../provider.js';
import { msToIso } from '../time-utils.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';

const FETCH_TIMEOUT_MS = 5_000;
const ENDPOINT = 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains';

const RemainSchema = z.object({
  model_name: z.string(),
  current_interval_total_count: z.number(),
  current_interval_usage_count: z.number(),
  end_time: z.number(),
  current_weekly_total_count: z.number(),
  current_weekly_usage_count: z.number(),
  weekly_end_time: z.number(),
});

const ResponseSchema = z.object({
  model_remains: z.array(RemainSchema),
  base_resp: z
    .object({
      status_code: z.number(),
      status_msg: z.string().optional(),
    })
    .optional(),
});

type MiniMaxResponse = z.infer<typeof ResponseSchema>;

export class MiniMax implements ProviderAdapter {
  id = 'minimax';
  name = 'MiniMax Token Plan';

  async fetchUsage(): Promise<Provider> {
    const apiKey = config.minimaxApiKey;

    if (!apiKey) {
      return new Provider(this.id, this.name, 'Not configured', []);
    }

    const data = await this.fetchData(apiKey);

    if (data.base_resp?.status_code !== 0) {
      throw new Error(data.base_resp?.status_msg ?? 'API error');
    }

    if (!data.model_remains?.length) {
      throw new Error('No model remains data in API response');
    }

    return new Provider(this.id, this.name, 'Token Plan', ModelsAgg.from(data.model_remains));
  }

  private async fetchData(apiKey: string): Promise<MiniMaxResponse> {
    const payload = {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    };

    const response = await fetch(ENDPOINT, payload);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const raw = (await response.json()) as unknown;

    return ResponseSchema.parse(raw);
  }
}

class ModelsAgg {
  private constructor() {}

  static from(raw: ModelRemain[]): ModelUsage[] {
    return raw
      .sort((a, b) => a.model_name.localeCompare(b.model_name))
      .map(ModelsAgg.toModel)
      .filter((m): m is ModelUsage => m !== null);
  }

  private static toModel(raw: ModelRemain): ModelUsage | null {
    if (raw.current_interval_total_count <= 0) {
      return null;
    }

    if (raw.current_interval_usage_count < 0) {
      throw new Error(`Invalid interval usage count for ${raw.model_name}`);
    }

    const windows: UsageWindow[] = [];

    const intervalUsed = ModelsAgg.usedCount(
      raw.current_interval_total_count,
      raw.current_interval_usage_count,
    );
    windows.push(
      UsageWindow.fromCounts(
        '5h',
        intervalUsed,
        raw.current_interval_total_count,
        msToIso(raw.end_time),
      ),
    );

    if (raw.current_weekly_total_count > 0) {
      const weeklyUsed = ModelsAgg.usedCount(
        raw.current_weekly_total_count,
        raw.current_weekly_usage_count,
      );
      windows.push(
        UsageWindow.fromCounts(
          'weekly',
          weeklyUsed,
          raw.current_weekly_total_count,
          msToIso(raw.weekly_end_time),
        ),
      );
    }

    return ModelUsage.from(raw.model_name, windows);
  }

  private static usedCount(total: number, remaining: number): number {
    const clamped = Math.min(Math.max(remaining, 0), total);
    return total - clamped;
  }
}

interface ModelRemain {
  model_name: string;
  current_interval_total_count: number;
  current_interval_usage_count: number;
  end_time: number;
  current_weekly_total_count: number;
  current_weekly_usage_count: number;
  weekly_end_time: number;
}
