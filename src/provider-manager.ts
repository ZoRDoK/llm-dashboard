import { Provider } from './provider';
import type { ProviderStore } from './store';
import type { ProviderAdapter } from './types';

const TICK_INTERVAL_MS = 60_000;

export class ProviderManager {
  private adapters: ProviderAdapter[] = [];
  private store: ProviderStore;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cache: Map<string, Provider> = new Map();
  private lastFetch: Map<string, number> = new Map();

  constructor(store: ProviderStore) {
    this.store = store;
  }

  register(adapter: ProviderAdapter): void {
    this.adapters.push(adapter);
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    this.refresh()
      .catch((err) => {
        console.error('Background refresh failed:', err);
      })
      .finally(() => {
        this.timer = setTimeout(() => this.scheduleRefresh(), TICK_INTERVAL_MS);
      });
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getLastUpdated(): number | null {
    let min: number | null = null;

    for (const ts of this.lastFetch.values()) {
      if (min === null || ts < min) {
        min = ts;
      }
    }

    return min;
  }

  getCachedProviders(): Provider[] {
    const providers: Provider[] = [];

    for (const adapter of this.adapters) {
      const cached = this.cache.get(adapter.id);

      if (cached) {
        providers.push(cached);
        continue;
      }

      const stored = this.store.get(adapter.id);

      if (stored) {
        this.cache.set(adapter.id, stored);
        providers.push(stored);
        continue;
      }

      providers.push(new Provider(adapter.id, adapter.name, 'Loading', []));
    }

    return providers;
  }

  async refresh(): Promise<Provider[]> {
    this.lastFetch.clear();
    this.cache.clear();

    const results = await Promise.allSettled(this.adapters.map((a) => this.fetchOne(a)));

    const providers: Provider[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const adapter = this.adapters[i];

      if (result.status === 'fulfilled') {
        providers.push(result.value);
      } else {
        // Adapter fetch failed — create a fallback Provider so the dashboard
        // displays the error message instead of showing a blank/missing card.
        const err = result.reason instanceof Error ? result.reason.message : String(result.reason);
        const fallback = new Provider(adapter.id, adapter.name, 'unknown', [], err);

        this.lastFetch.set(adapter.id, Date.now());
        this.cache.set(adapter.id, fallback);
        providers.push(fallback);
      }
    }

    return providers;
  }

  private async fetchOne(adapter: ProviderAdapter): Promise<Provider> {
    const result = await adapter.fetchUsage();

    this.lastFetch.set(adapter.id, Date.now());
    this.cache.set(adapter.id, result);
    this.store.set(adapter.id, result);

    return result;
  }
}
