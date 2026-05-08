import { z } from 'zod';
import { config } from '../config';
import { ModelUsage } from '../model-usage';
import { Provider } from '../provider';
import type { ProviderAdapter } from '../types';
import { UsageWindow } from '../usage-window';

const FETCH_TIMEOUT_MS = 5_000;
const METRICS_ENDPOINT = 'https://context7.com/api/v2/libs/metrics';

const DailyMetricsSchema = z.object({
  total: z.object({
    page: z.number(),
    txt: z.number(),
    mcp: z.number(),
    cli: z.number(),
  }),
});

type DailyMetrics = z.infer<typeof DailyMetricsSchema>;

export class Context7 implements ProviderAdapter {
  id = 'context7';
  name = 'Context7';

  async fetchUsage(): Promise<Provider> {
    const apiKey = config.context7ApiKey;
    const libraryIds = config.context7LibraryIds;

    if (!apiKey) {
      return new Provider(this.id, this.name, 'Not configured', []);
    }

    if (!libraryIds.length) {
      return new Provider(this.id, this.name, 'Plan', [ModelUsage.from('Context7', [])]);
    }

    const models: ModelUsage[] = [];

    for (const libId of libraryIds) {
      const data = await this.fetchLibraryMetrics(apiKey, libId);

      const total = data.total;
      const totalRequests = total.page + total.txt + total.mcp + total.cli;

      const windows: UsageWindow[] = [
        // Show cumulative request counts per surface as usage/limit
        // (no hard limit, just informational counters)
        UsageWindow.fromCounts('total', totalRequests, totalRequests, null),
        UsageWindow.fromCounts('web', total.page, total.page, null),
        UsageWindow.fromCounts('mcp', total.mcp, total.mcp, null),
        UsageWindow.fromCounts('cli', total.cli, total.cli, null),
      ];

      models.push(ModelUsage.from(libId, windows));
    }

    return new Provider(this.id, this.name, 'Plan', models);
  }

  private async fetchLibraryMetrics(apiKey: string, libraryId: string): Promise<DailyMetrics> {
    const url = `${METRICS_ENDPOINT}?libraryId=${encodeURIComponent(libraryId)}`;

    const payload = {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    };

    const response = await fetch(url, payload);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for library ${libraryId}`);
    }

    const raw = (await response.json()) as unknown;

    return DailyMetricsSchema.parse(raw);
  }
}
