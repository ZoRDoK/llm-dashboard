/**
 * Ollama Cloud adapter.
 *
 * Reads usage from the JSON API instead of scraping ollama.com/settings:
 * the site migrated website sign-in to WorkOS (signin.ollama.com) on
 * 2026-09-06, which invalidated the old session-cookie scraping.
 */
import { z } from 'zod';
import { config } from '../config.js';
import { fetchAndParse } from '../fetch-utils.js';
import { createLogger } from '../logger.js';
import { Provider } from '../provider.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';

const log = createLogger('adapter:ollama-cloud');

const USAGE_ENDPOINT = 'https://ollama.com/api/usage';
const PERCENT_MAX = 100;

// Unknown fields (activity, per-model lists, ...) are stripped. `usage` is a
// 0..1 ratio of the window limit, not a percent.
export const UsageSchema = z.object({
  limits: z.object({
    session: z.object({ usage: z.number().min(0) }),
    weekly: z.object({ usage: z.number().min(0) }),
  }),
});

type Usage = z.infer<typeof UsageSchema>;

export class OllamaCloud implements ProviderAdapter {
  id = 'ollama-cloud';
  name = 'Ollama Cloud';

  async fetchUsage(): Promise<Provider> {
    const apiKey = config.OLLAMA_CLOUD_API_KEY;

    if (!apiKey) {
      log.warn('Ollama Cloud: no API key configured');

      return Provider.notConfigured(this.id, this.name);
    }

    const usage = await fetchAndParse(USAGE_ENDPOINT, apiKey, UsageSchema);
    const windows = this.parseWindows(usage);

    return Provider.fromAdapter(this.id, this.name, 'Cloud', windows, 'Cloud Usage');
  }

  /**
   * Map API limit ratios to dashboard windows ('5h' = session, 'weekly').
   *
   * resetAt is null: the usage API exposes no reset timestamps.
   */
  parseWindows(usage: Usage): UsageWindow[] {
    const session = UsageWindow.fromApi('5h', ratioToPercent(usage.limits.session.usage), null);
    const weekly = UsageWindow.fromApi('weekly', ratioToPercent(usage.limits.weekly.usage), null);

    return [session, weekly];
  }
}

/** Convert a 0..1 usage ratio to a percent rounded to one decimal (0.008 → 0.8). */
function ratioToPercent(ratio: number): number {
  return Math.round(ratio * PERCENT_MAX * 10) / 10;
}
