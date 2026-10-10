import { z } from 'zod';
import { config } from '../config.js';
import { fetchAndParse } from '../fetch-utils.js';
import { Provider } from '../provider.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';

const ENDPOINT = 'https://api.evolink.ai/v1/credits';

const TokenInfoSchema = z.object({
  remaining_credits: z.number(),
  unlimited_credits: z.boolean(),
  used_credits: z.number(),
});

const UserInfoSchema = z.object({
  remaining_credits: z.number(),
  used_credits: z.number(),
});

const DataSchema = z.object({
  token: TokenInfoSchema,
  user: UserInfoSchema,
});

const ResponseSchema = z.object({
  data: DataSchema,
  success: z.boolean(),
});

type EvolinkResponse = z.infer<typeof ResponseSchema>;

export class Evolink implements ProviderAdapter {
  readonly id = 'evolink';
  readonly name = 'Evolink AI';

  async fetchUsage(): Promise<Provider> {
    const apiKey = config.EVOLINK_API_KEY;

    if (!apiKey) {
      return Provider.notConfigured(this.id, this.name);
    }

    const data = await fetchAndParse(ENDPOINT, apiKey, ResponseSchema);
    const windows = buildWindows(data);

    const plan = data.success ? 'API' : 'Error';

    return Provider.fromAdapter(this.id, this.name, plan, windows, 'Credits');
  }
}

function buildWindows(data: EvolinkResponse): UsageWindow[] {
  const tokenLabel = data.data.token.unlimited_credits
    ? 'Unlimited'
    : `${data.data.token.remaining_credits.toFixed(0)} credits`;

  const windows = [UsageWindow.fromApi('Token', null, null, null, tokenLabel)];

  windows.push(
    UsageWindow.fromApi(
      'User',
      null,
      null,
      null,
      `${data.data.user.remaining_credits.toFixed(0)} credits`,
    ),
  );

  return windows;
}
