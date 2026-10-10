import { z } from 'zod';
import { config } from '../config.js';
import { fetchAndParse } from '../fetch-utils.js';
import { Provider } from '../provider.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';

const ENDPOINT = 'https://api.deepseek.com/user/balance';

const BalanceInfoSchema = z.object({
  currency: z.string(),
  total_balance: z.string(),
  granted_balance: z.string(),
  topped_up_balance: z.string(),
});

const ResponseSchema = z.object({
  is_available: z.boolean(),
  balance_infos: z.array(BalanceInfoSchema),
});

export class DeepSeek implements ProviderAdapter {
  id = 'deepseek';
  name = 'DeepSeek';

  async fetchUsage(): Promise<Provider> {
    const apiKey = config.DEEPSEEK_API_KEY;

    if (!apiKey) {
      return Provider.notConfigured(this.id, this.name);
    }

    const data = await fetchAndParse(ENDPOINT, apiKey, ResponseSchema);

    const windows: UsageWindow[] = [];

    for (const info of data.balance_infos) {
      const balance = Number.parseFloat(info.total_balance);

      windows.push(
        UsageWindow.fromApi(
          info.currency,
          null,
          null,
          balance,
          `${info.total_balance} ${info.currency}`,
        ),
      );
    }

    const plan = data.is_available && windows.length > 0 ? 'API' : 'Insufficient funds';

    return new Provider(this.id, this.name, plan, [{ modelName: 'API Usage', windows }]);
  }
}
