import type { ProviderAdapter, Provider, ModelUsage } from './types';

interface RollingUsage {
  usagePercent: number;
  resetsInSec: number;
}

interface OpenCodeGoResponse {
  rolling: RollingUsage;
  weekly: RollingUsage;
  monthly: RollingUsage;
}

const API_ENDPOINT = 'https://opencode.ai/zen/go/v1/usage';

function secondsToIso(resetsInSec: number | null | undefined): string | null {
  if (resetsInSec == null || resetsInSec < 0) return null;
  return new Date(Date.now() + resetsInSec * 1000).toISOString();
}

function mapUsage(data: OpenCodeGoResponse): ModelUsage {
  return {
    modelName: 'aggregate',
    fiveHourUsage: data.rolling.usagePercent,
    fiveHourReset: secondsToIso(data.rolling.resetsInSec),
    weeklyUsage: data.weekly.usagePercent,
    weeklyReset: secondsToIso(data.weekly.resetsInSec),
  };
}

export class OpenCodeGoAdapter implements ProviderAdapter {
  id = 'opencode-go';
  name = 'OpenCode Go';

  async fetchUsage(): Promise<Provider> {
    const apiKey = process.env.OPENCODE_GO_API_KEY;
    if (!apiKey) {
      throw new Error('OPENCODE_GO_API_KEY not set');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(API_ENDPOINT, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`OpenCode Go API responded with HTTP ${response.status}`);
      }

      const data = (await response.json()) as OpenCodeGoResponse;

      if (
        !data.rolling || typeof data.rolling.usagePercent !== 'number'
        || !data.weekly || typeof data.weekly.usagePercent !== 'number'
      ) {
        throw new Error('Invalid response shape from OpenCode Go API');
      }

      const model = mapUsage(data);

      return {
        id: this.id,
        name: this.name,
        plan: 'token-plan',
        models: [model],
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('OpenCode Go API request timed out');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
