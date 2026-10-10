import { z } from 'zod';
import { config } from '../config.js';
import { fetchJsonWith } from '../fetch-utils.js';
import { Provider } from '../provider.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';

const DEFAULT_BASE_URL = 'https://platform.xiaomimimo.com';

const UsageItemSchema = z.object({
  name: z.string(),
  used: z.number(),
  limit: z.number(),
  percent: z.number(),
});

const UsageGroupSchema = z.object({
  percent: z.number(),
  items: z.array(UsageItemSchema),
});

const TokenPlanSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z
    .object({
      monthUsage: UsageGroupSchema.optional().nullable(),
      usage: UsageGroupSchema.optional().nullable(),
    })
    .optional()
    .nullable(),
});

type TokenPlanResponse = z.infer<typeof TokenPlanSchema>;
type UsageItem = z.infer<typeof UsageItemSchema>;

const MILLION = 1_000_000;

export class Mimo implements ProviderAdapter {
  id = 'mimo';
  name = 'MiMo';

  async fetchUsage(): Promise<Provider> {
    const cookie = config.MIMO_COOKIE;

    if (!cookie) {
      return Provider.notConfigured(this.id, this.name);
    }

    const data = await this.fetchUsageData(cookie);
    const windows = this.buildWindows(data);

    if (windows.length === 0) {
      return new Provider(this.id, this.name, 'Error', [], 'Usage data not found');
    }

    return new Provider(this.id, this.name, 'API', [{ modelName: 'Token Plan', windows }]);
  }

  private buildWindows(data: TokenPlanResponse): UsageWindow[] {
    const windows: UsageWindow[] = [];

    for (const item of data.data?.usage?.items ?? []) {
      if (item.limit > 0) {
        windows.push(this.itemWindow(labelFromName(item.name), item));
      }
    }

    for (const item of data.data?.monthUsage?.items ?? []) {
      if (item.limit > 0) {
        windows.push(this.itemWindow('monthly', item));
      }
    }

    return windows;
  }

  private itemWindow(label: string, item: UsageItem): UsageWindow {
    const usedM = Math.floor(item.used / MILLION);
    const limitM = Math.floor(item.limit / MILLION);

    return UsageWindow.fromCounts(label, item.used, item.limit, null, `${usedM}/${limitM} M`);
  }

  private async fetchUsageData(cookie: string): Promise<TokenPlanResponse> {
    const baseUrl = config.MIMO_API_URL ?? DEFAULT_BASE_URL;
    const url = `${baseUrl}/api/v1/tokenPlan/usage`;

    const raw = await fetchJsonWith(url, { Cookie: cookie });

    return TokenPlanSchema.parse(raw);
  }
}

function labelFromName(name: string): string {
  switch (name) {
    case 'plan_total_token':
      return 'plan';
    case 'compensation_total_token':
      return 'compensation';
    default:
      return name;
  }
}
