import { z } from 'zod';
import { config } from '../config.js';
import { fetchAndParse } from '../fetch-utils.js';
import { Provider } from '../provider.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';

const ENDPOINT = 'https://api.firecrawl.dev/v2/team/credit-usage';

const CreditUsageSchema = z.object({
  success: z.boolean(),
  data: z.object({
    remainingCredits: z.number(),
    planCredits: z.number(),
    billingPeriodStart: z.string(),
    billingPeriodEnd: z.string(),
  }),
});

const PERCENT_MAX = 100;

export class Firecrawl implements ProviderAdapter {
  id = 'firecrawl';
  name = 'Firecrawl';

  async fetchUsage(): Promise<Provider> {
    const apiKey = config.FIRECRAWL_API_KEY;

    if (!apiKey) {
      return Provider.notConfigured(this.id, this.name);
    }

    const data = await fetchAndParse(ENDPOINT, apiKey, CreditUsageSchema);

    const { remainingCredits, planCredits, billingPeriodEnd } = data.data;

    const spent = Math.max(0, planCredits - remainingCredits);

    const usedPercent =
      planCredits > 0
        ? Math.min(PERCENT_MAX, Math.round((spent / planCredits) * PERCENT_MAX))
        : null;

    const valueLabel = `${spent} / ${planCredits} used`;

    const window = UsageWindow.fromApi(
      'credits',
      usedPercent,
      billingPeriodEnd,
      undefined,
      valueLabel,
    );

    return new Provider(this.id, this.name, 'Credits', [
      { modelName: 'Credits', windows: [window] },
    ]);
  }
}
