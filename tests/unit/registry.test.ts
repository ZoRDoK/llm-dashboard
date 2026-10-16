import { describe, expect, it } from 'vitest';
import { registerAdapters } from '../../src/adapters/registry.js';
import { Provider } from '../../src/provider.js';
import { ProviderManager } from '../../src/provider-manager.js';
import type { ProviderStore } from '../../src/store.js';

// Minimal fake store: only what registration reads (get/set/archive set).
function makeStore(): { store: ProviderStore; map: Map<string, Provider> } {
  const map = new Map<string, Provider>();
  const store = {
    get: (id: string): Provider | null => map.get(id) ?? null,
    set: (id: string, provider: Provider): void => {
      map.set(id, provider);
    },
    getArchiveSettings: (): Set<string> => new Set(),
  } as unknown as ProviderStore;

  return { store, map };
}

describe('provider registry', () => {
  it('registers the active provider set without the removed R4', () => {
    const { store } = makeStore();
    const manager = new ProviderManager(store);

    registerAdapters(manager);

    const ids = manager.getMetrics().map((m) => m.id);

    expect(ids).not.toContain('r4');
    // The rest of the registration survives the removal.
    for (const id of [
      'brave',
      'codex',
      'commandcode',
      'openrouter',
      'tavily',
      'tavily-2',
      'tavily-3',
      'alibaba-qwen',
      'context7',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('does not resurrect R4 from a historical cache row', () => {
    // A row left in the SQLite cache by the removed adapter must not put the
    // provider back on the dashboard: cached values are served per registered
    // adapter only.
    const { store, map } = makeStore();
    map.set('r4', new Provider('r4', 'R4 Coder', 'Code Lite', []));
    const manager = new ProviderManager(store);

    registerAdapters(manager);

    const served = manager.getCachedProviders().map((p) => p.id);

    expect(served).not.toContain('r4');
  });
});
