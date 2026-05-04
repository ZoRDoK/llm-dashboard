import type { Provider, ProviderAdapter } from './adapters/types';

interface CacheEntry {
  data: Provider[];
  timestamp: number;
}

export class ProviderService {
  private adapters: ProviderAdapter[] = [];
  private cache: CacheEntry | null = null;
  private ttl: number;

  constructor(ttlMs = 60_000) {
    this.ttl = ttlMs;
  }

  register(adapter: ProviderAdapter): void {
    this.adapters.push(adapter);
  }

  isExpired(): boolean {
    return !this.cache || (Date.now() - this.cache.timestamp) > this.ttl;
  }

  async getAllProviders(): Promise<Provider[]> {
    if (this.cache && !this.isExpired()) {
      return this.cache.data;
    }

    const results = await Promise.allSettled(
      this.adapters.map((a) => a.fetchUsage())
    );

    const providers: Provider[] = results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      return {
        id: this.adapters[i].id,
        name: this.adapters[i].name,
        plan: 'unknown',
        models: [],
        error: r.status === 'rejected' ? String(r.reason) : undefined,
      };
    });

    this.cache = { data: providers, timestamp: Date.now() };
    return providers;
  }

  async refresh(): Promise<Provider[]> {
    this.cache = null;
    return this.getAllProviders();
  }
}
