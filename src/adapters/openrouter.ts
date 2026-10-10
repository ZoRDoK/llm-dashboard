import { z } from 'zod';
import { config } from '../config.js';
import { fetchAndParse } from '../fetch-utils.js';
import { Provider } from '../provider.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/credits';

const ResponseSchema = z.object({
  data: z.object({
    total_credits: z.number(),
    total_usage: z.number(),
  }),
});

export class OpenRouter implements ProviderAdapter {
  readonly id = 'openrouter';
  readonly name = 'OpenRouter';

  async fetchUsage(): Promise<Provider> {
    const apiKey = config.OPENROUTER_API_KEY;

    if (!apiKey) {
      return Provider.notConfigured(this.id, this.name);
    }

    const data = await fetchAndParse(ENDPOINT, apiKey, ResponseSchema);
    const windows = buildOpenRouterWindows(data.data.total_credits, data.data.total_usage);

    return Provider.fromAdapter(this.id, this.name, 'Credits', windows);
  }
}

/**
 * Build the OpenRouter credits window from total credits and usage.
 *
 * `total_usage` is clamped to `total_credits` so `used <= total` (the
 * `UsageWindow.fromCounts` precondition). The display label reports the
 * remaining balance: `$<remaining> of $<total_credits>`.
 */
export function buildOpenRouterWindows(totalCredits: number, totalUsage: number): UsageWindow[] {
  const used = Math.min(totalUsage, totalCredits);
  const remaining = totalCredits - totalUsage;
  const valueLabel = `$${remaining.toFixed(2)} of $${totalCredits.toFixed(2)}`;

  return [UsageWindow.fromCounts('credits', used, totalCredits, null, valueLabel)];
}
