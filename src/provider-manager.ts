import { Provider } from './provider.js';
import type { ProviderStore } from './store.js';
import type { ProviderAdapter } from './types.js';

const TICK_INTERVAL_MS = 60_000;
const SLOW_TICK_INTERVAL_MS = 600_000; // 10 minutes for rate-limited providers

export class ProviderManager {
  private adapters: ProviderAdapter[] = [];
  private store: ProviderStore;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private slowTimer: ReturnType<typeof setTimeout> | null = null;
  private cache: Map<string, Provider> = new Map();
  private lastFetch: Map<string, number> = new Map();
  private slowAdapters: Set<string> = new Set();

  constructor(store: ProviderStore) {
    this.store = store;
  }

  register(adapter: ProviderAdapter): void {
    this.adapters.push(adapter);
  }

  /** Mark a provider as rate-limited — fetched on SLOW_TICK_INTERVAL instead of TICK_INTERVAL. */
  markSlow(id: string): void {
    this.slowAdapters.add(id);
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.scheduleRefresh();
    this.scheduleSlowRefresh();
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

    if (this.slowTimer) {
      clearTimeout(this.slowTimer);
      this.slowTimer = null;
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
    const oldCache = new Map(this.cache);
    const oldFetch = new Map(this.lastFetch);

    this.lastFetch.clear();
    this.cache.clear();

    const activeAdapters = this.adapters.filter((a) => !this.slowAdapters.has(a.id));
    const results = await Promise.allSettled(activeAdapters.map((a) => this.fetchOne(a)));

    const providers: Provider[] = [];
    const activeSet = new Set(activeAdapters);

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const adapter = activeAdapters[i];

      if (result.status === 'fulfilled') {
        providers.push(result.value);
      } else {
        const recovered = this.recoverFailedFetch(adapter, result, oldCache, oldFetch);

        if (recovered) {
          providers.push(recovered);
        }
      }
    }

    // Add cached values for slow adapters so they still appear on the dashboard
    for (const adapter of this.adapters) {
      if (activeSet.has(adapter)) {
        continue;
      }

      const cached = this.cache.get(adapter.id);

      if (cached) {
        providers.push(cached);
      }
    }

    return providers;
  }

  /**
   * On fetch failure, try to serve stale data from cache or store.
   * Falls back to an error placeholder when nothing is available.
   */
  private recoverFailedFetch(
    adapter: ProviderAdapter,
    result: PromiseSettledResult<Provider>,
    oldCache: Map<string, Provider>,
    oldFetch: Map<string, number>,
  ): Provider | null {
    if (result.status === 'fulfilled') {
      return result.value;
    }

    const prev = oldCache.get(adapter.id);
    const cached = prev?.error ? null : prev;
    const stored = cached ?? this.store.get(adapter.id);

    if (stored && !stored.error) {
      // Serve stale data instead of showing an error
      this.lastFetch.set(adapter.id, oldFetch.get(adapter.id) ?? Date.now());
      this.cache.set(adapter.id, stored);

      return stored;
    }

    const err = result.reason instanceof Error ? result.reason.message : String(result.reason);
    const fallback = new Provider(adapter.id, adapter.name, 'unknown', [], err);

    this.lastFetch.set(adapter.id, Date.now());
    this.cache.set(adapter.id, fallback);

    return fallback;
  }

  private scheduleSlowRefresh(): void {
    this.refreshSlow()
      .catch((err) => {
        console.error('Slow refresh failed:', err);
      })
      .finally(() => {
        this.slowTimer = setTimeout(() => this.scheduleSlowRefresh(), SLOW_TICK_INTERVAL_MS);
      });
  }

  private async refreshSlow(): Promise<void> {
    for (const adapter of this.adapters) {
      if (!this.slowAdapters.has(adapter.id)) {
        continue;
      }

      try {
        await this.fetchOne(adapter);
      } catch (err) {
        console.error(`Slow refresh failed for ${adapter.id}:`, err);
      }
    }
  }

  private async fetchOne(adapter: ProviderAdapter): Promise<Provider> {
    const result = await adapter.fetchUsage();

    this.lastFetch.set(adapter.id, Date.now());
    this.cache.set(adapter.id, result);
    this.store.set(adapter.id, result);

    return result;
  }
}
