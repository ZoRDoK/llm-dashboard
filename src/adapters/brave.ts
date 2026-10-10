import { config } from '../config.js';
import { CHROME_USER_AGENT } from '../constants.js';
import { fetchText } from '../fetch-utils.js';
import { Provider } from '../provider.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';

const ENDPOINT = 'https://api-dashboard.search.brave.com/app/dashboard/__data.json';
const MIN_PERCENT = 0;
const MAX_PERCENT = 100;

/** Detects the login-redirect chunk the dashboard serves when the cookie expired. */
function isLoginRedirect(chunk: unknown): boolean {
  if (chunk === null || typeof chunk !== 'object' || Array.isArray(chunk)) {
    return false;
  }

  const { type, location } = chunk as Record<string, unknown>;

  return type === 'redirect' && typeof location === 'string' && location.includes('/login');
}

export class Brave implements ProviderAdapter {
  id = 'brave';
  name = 'Brave';

  async fetchUsage(): Promise<Provider> {
    const cookie = config.BRAVE_COOKIE;

    if (!cookie) {
      return Provider.notConfigured(this.id, this.name);
    }

    const text = await this.fetchDashboard(cookie);
    const data = this.parseChunks(text);
    const usage = this.resolveUsage(data);

    const spentTokens = usage.tokensIn + usage.tokensOut;
    const clamp = (n: number): number => {
      if (n < MIN_PERCENT) {
        return MIN_PERCENT;
      }
      if (n > MAX_PERCENT) {
        return MAX_PERCENT;
      }
      return n;
    };
    const usedPercent = clamp(Math.round(usage.quotaUsedPrc));

    const windows: UsageWindow[] = [
      UsageWindow.fromApi('monthly', usedPercent, null, undefined, `${spentTokens} tokens`),
    ];

    return new Provider(this.id, this.name, 'Search API', [{ modelName: 'Tokens', windows }]);
  }

  private async fetchDashboard(cookie: string): Promise<string> {
    const headers = {
      cookie: cookie,
      'user-agent': CHROME_USER_AGENT,
      accept: 'application/json',
    };

    return await fetchText(ENDPOINT, headers);
  }

  private parseChunks(text: string): unknown[] {
    const lines = text.split('\n');
    const chunks: unknown[] = [];

    for (const line of lines) {
      if (line.trim() === '') {
        continue;
      }

      chunks.push(JSON.parse(line));
    }

    for (const chunk of chunks) {
      if (isLoginRedirect(chunk)) {
        throw new Error('Brave session expired — update BRAVE_COOKIE');
      }

      if (
        chunk !== null &&
        typeof chunk === 'object' &&
        !Array.isArray(chunk) &&
        Object.hasOwn(chunk, 'type') &&
        Object.hasOwn(chunk, 'data') &&
        (chunk as Record<string, unknown>).type === 'chunk' &&
        Array.isArray((chunk as Record<string, unknown>).data) &&
        ((chunk as Record<string, unknown>).data as unknown[]).some(
          (v) =>
            v !== null &&
            typeof v === 'object' &&
            !Array.isArray(v) &&
            Object.hasOwn(v, 'currentMonthUsage'),
        )
      ) {
        return (chunk as Record<string, unknown>).data as unknown[];
      }
    }

    throw new Error('Brave usage data not found in dashboard response');
  }

  private resolveUsage(data: unknown[]): {
    tokensIn: number;
    tokensOut: number;
    quotaUsedPrc: number;
    monthlyLimit: number;
  } {
    const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

    const resolve = (idx: number, seen: Set<number>): unknown => {
      const node = data[idx];

      if (node === null || typeof node !== 'object') {
        return node;
      }

      if (seen.has(idx)) {
        return undefined;
      }

      const nextSeen = new Set(seen);
      nextSeen.add(idx);

      if (Array.isArray(node)) {
        return node.map((value) => (typeof value === 'number' ? resolve(value, nextSeen) : value));
      }

      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        out[key] = typeof value === 'number' ? resolve(value, nextSeen) : value;
      }

      return out;
    };

    for (let index = 0; index < data.length; index++) {
      const node = data[index];

      if (
        node !== null &&
        typeof node === 'object' &&
        !Array.isArray(node) &&
        Object.hasOwn(node, 'currentMonthUsage')
      ) {
        const sub = resolve(index, new Set()) as Record<string, unknown>;
        const usage = sub.currentMonthUsage as Record<string, unknown>;

        return {
          tokensIn: toNum(usage.tokensIn),
          tokensOut: toNum(usage.tokensOut),
          quotaUsedPrc: toNum(usage.quotaUsedPrc),
          monthlyLimit: toNum(sub.monthlyLimit),
        };
      }
    }

    throw new Error('Brave subscription usage not found');
  }
}
