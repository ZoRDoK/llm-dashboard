import { z } from 'zod';
import { config } from '../config.js';
import { fetchAndParse } from '../fetch-utils.js';
import type { ModelUsage } from '../model-usage.js';
import { Provider } from '../provider.js';
import { msToIso } from '../time-utils.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';

const ENDPOINT = 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const PERCENT_MAX = 100;
const STATUS_INACTIVE = 3;

const RemainSchema = z.object({
  model_name: z.string(),
  start_time: z.number(),
  end_time: z.number(),
  remains_time: z.number(),
  current_interval_total_count: z.number(),
  current_interval_usage_count: z.number(),
  current_interval_status: z.number(),
  current_interval_remaining_percent: z.number(),
  weekly_start_time: z.number(),
  weekly_end_time: z.number(),
  weekly_remains_time: z.number(),
  current_weekly_total_count: z.number(),
  current_weekly_usage_count: z.number(),
  current_weekly_status: z.number(),
  current_weekly_remaining_percent: z.number(),
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

type ModelRemain = z.infer<typeof RemainSchema>;

export class MiniMax implements ProviderAdapter {
  id = 'minimax';
  name = 'MiniMax Token Plan';

  async fetchUsage(): Promise<Provider> {
    const apiKey = config.MINIMAX_API_KEY;

    if (!apiKey) {
      return Provider.notConfigured(this.id, this.name);
    }

    const data = await fetchAndParse(ENDPOINT, apiKey, ResponseSchema);

    if (data.base_resp?.status_code !== 0) {
      throw new Error(data.base_resp?.status_msg ?? 'API error');
    }

    if (!data.model_remains?.length) {
      throw new Error('No model remains data in API response');
    }

    return new Provider(this.id, this.name, 'Token Plan', modelsFrom(data.model_remains));
  }
}

/** Format milliseconds into a human-readable remaining time label. */
function formatRemainingTime(ms: number): string | null {
  if (ms <= 0) {
    return null;
  }

  const hours = Math.floor(ms / MS_PER_HOUR);
  const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE);

  if (hours > 0) {
    return `${hours}h ${minutes}m left`;
  }

  return `${minutes}m left`;
}

function modelsFrom(raw: ModelRemain[]): ModelUsage[] {
  return raw
    .sort((a, b) => a.model_name.localeCompare(b.model_name))
    .map(toModel)
    .filter((m): m is ModelUsage => m !== null);
}

function toModel(raw: ModelRemain): ModelUsage | null {
  // Skip inactive models (not configured / no quota)
  if (raw.current_interval_status === STATUS_INACTIVE) {
    return null;
  }

  const windows: UsageWindow[] = [];

  const intervalUsed = PERCENT_MAX - raw.current_interval_remaining_percent;

  windows.push(
    UsageWindow.fromApi(
      '5h',
      intervalUsed,
      msToIso(raw.end_time),
      null,
      formatRemainingTime(raw.remains_time),
    ),
  );

  if (raw.current_weekly_status !== STATUS_INACTIVE) {
    const weeklyUsed = PERCENT_MAX - raw.current_weekly_remaining_percent;

    windows.push(
      UsageWindow.fromApi(
        'weekly',
        weeklyUsed,
        msToIso(raw.weekly_end_time),
        null,
        formatRemainingTime(raw.weekly_remains_time),
      ),
    );
  }

  return { modelName: raw.model_name, windows };
}
