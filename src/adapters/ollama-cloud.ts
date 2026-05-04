import type { ProviderAdapter, Provider, ModelUsage } from './types';

interface OllamaSubscriptionPeriod {
  Time: string;
  Valid: boolean;
}

interface OllamaUserResponse {
  ID: string;
  Email: string;
  Name: string;
  Plan: string;
  SubscriptionPeriodStart?: OllamaSubscriptionPeriod;
  SubscriptionPeriodEnd?: OllamaSubscriptionPeriod;
  CustomerID?: { String: string; Valid: boolean };
  SubscriptionID?: { String: string; Valid: boolean };
  NotifyUsageLimits?: boolean;
}

const ENDPOINTS = ['https://ollama.com/api/me'];

function subscriptionEnd(user: OllamaUserResponse): string | null {
  if (user.SubscriptionPeriodEnd?.Valid) {
    return user.SubscriptionPeriodEnd.Time;
  }

  return null;
}

function buildModels(user: OllamaUserResponse): ModelUsage[] {
  const resetAt = subscriptionEnd(user);

  const planModel: ModelUsage = {
    modelName: `Plan: ${user.Plan}`,
    fiveHourUsage: null,
    fiveHourReset: resetAt,
    weeklyUsage: null,
    weeklyReset: resetAt,
  };

  const models: ModelUsage[] = [planModel];

  return models;
}

export class OllamaCloudAdapter implements ProviderAdapter {
  id = 'ollama-cloud';
  name = 'Ollama Cloud';

  async fetchUsage(): Promise<Provider> {
    const apiKey = process.env.OLLAMA_CLOUD_API_KEY;
    if (!apiKey) {
      throw new Error('OLLAMA_CLOUD_API_KEY not set');
    }

    let lastError: unknown;

    for (const endpoint of ENDPOINTS) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = (await response.json()) as OllamaUserResponse;

        if (!data.Plan) {
          throw new Error('Invalid account response: missing plan');
        }

        const models = buildModels(data);

        return {
          id: this.id,
          name: this.name,
          plan: data.Plan,
          models,
        };
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError ?? new Error('All Ollama Cloud endpoints failed');
  }
}
