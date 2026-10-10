import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelUsage } from '../../src/model-usage.js';
import { Provider } from '../../src/provider.js';
import { ProviderManager } from '../../src/provider-manager.js';
import { ProviderStore } from '../../src/store.js';
import type { LogEntry } from '../../src/types.js';
import { UsageWindow } from '../../src/usage-window.js';

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({ createLogger: () => logger }));

// Time constants (milliseconds) — named to satisfy noMagicNumbers.
const TICK_INTERVAL_MS = 60_000;
const SLOW_TICK_INTERVAL_MS = 600_000;
const TIME_T0 = 1_000;
const TIME_T1 = 5_000;
const USED_PERCENT = 50;

// ── Quota tracking constants ──────────────────────────────────
const QUOTA_USED_PCT = 30;
const QUOTA_REMAINING_PCT = 70;
const QUOTA_RESET_AT = '2026-07-19T00:00:00.000Z';
const QUOTA_BASE_NOW = 1_750_000_000_000;
const CLOSE_TO_DECIMALS = 5;

// ── Fakes ───────────────────────────────────────────────────

function makeAdapter(
  id: string,
  name: string,
  fetchUsage: () => Promise<Provider>,
): ProviderAdapter {
  return { id, name, fetchUsage };
}

interface MetricRecord {
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  configured: boolean;
}

interface FakeStore {
  store: ProviderStore;
  map: Map<string, Provider>;
  archiveSet: Set<string>;
  metricsMap: Map<string, MetricRecord>;
}

function makeFakeStore(): FakeStore {
  const map = new Map<string, Provider>();
  const archiveSet = new Set<string>();
  const metricsMap = new Map<string, MetricRecord>();
  const store = {
    get: (id: string): Provider | null => map.get(id) ?? null,
    set: (id: string, provider: Provider): void => {
      map.set(id, provider);
    },
    getArchiveSettings: (): Set<string> => archiveSet,
    getMetrics: (): Map<string, MetricRecord> => metricsMap,
    upsertMetric: (
      id: string,
      lastSuccessAt: number | null,
      lastAttemptAt: number | null,
      configured: boolean,
    ): void => {
      metricsMap.set(id, { lastSuccessAt, lastAttemptAt, configured });
    },
  } as unknown as ProviderStore;

  return { store, map, archiveSet, metricsMap };
}

function makeProvider(id: string, plan = 'plan', models: ModelUsage[] = []): Provider {
  return new Provider(id, id.toUpperCase(), plan, models);
}

function makeModelUsage(): ModelUsage {
  return { modelName: 'gpt', windows: [UsageWindow.fromApi('daily', USED_PERCENT, null)] };
}

// Flush pending microtasks created by async fetches under fake timers.
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

// ── Tests ───────────────────────────────────────────────────

describe('ProviderManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    logger.debug.mockReset();
    logger.info.mockReset();
    logger.warn.mockReset();
    logger.error.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── register / markSlow ──────────────────────────────────

  describe('register / markSlow', () => {
    it('register adds an adapter surfaced by getCachedProviders as Loading', () => {
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('a', 'A', () => Promise.resolve(makeProvider('a'))));

      const providers = manager.getCachedProviders();

      expect(providers).toHaveLength(1);
      expect(providers[0].id).toBe('a');
      expect(providers[0].name).toBe('A');
      expect(providers[0].plan).toBe('Loading');
      expect(providers[0].models).toEqual([]);
    });

    it('markSlow excludes an adapter from the active refresh set', async () => {
      const fetchSlow = vi.fn(() => Promise.resolve(makeProvider('slow')));
      const fetchFast = vi.fn(() => Promise.resolve(makeProvider('fast')));
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('slow', 'Slow', fetchSlow));
      manager.register(makeAdapter('fast', 'Fast', fetchFast));
      manager.markSlow('slow');

      await manager.refresh();

      expect(fetchFast).toHaveBeenCalledTimes(1);
      expect(fetchSlow).not.toHaveBeenCalled();
    });
  });

  // ── start / stop ─────────────────────────────────────────

  describe('start / stop', () => {
    it('start triggers an immediate refresh', async () => {
      const fetchA = vi.fn(() => Promise.resolve(makeProvider('a')));
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('a', 'A', fetchA));

      manager.start();
      await flush();

      expect(fetchA).toHaveBeenCalledTimes(1);
      manager.stop();
    });

    it('start is idempotent — calling twice does not double-schedule', async () => {
      const fetchA = vi.fn(() => Promise.resolve(makeProvider('a')));
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('a', 'A', fetchA));

      manager.start();
      await flush(); // initial refresh completes; timer scheduled
      expect(fetchA).toHaveBeenCalledTimes(1);

      manager.start(); // no-op: timer already set
      await flush();
      expect(fetchA).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS); // only one cycle fires
      expect(fetchA).toHaveBeenCalledTimes(2);

      manager.stop();
    });

    it('stop prevents further scheduled refreshes', async () => {
      const fetchA = vi.fn(() => Promise.resolve(makeProvider('a')));
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('a', 'A', fetchA));

      manager.start();
      await flush();
      manager.stop();

      await vi.advanceTimersByTimeAsync(SLOW_TICK_INTERVAL_MS); // well past one tick
      expect(fetchA).toHaveBeenCalledTimes(1);
    });
  });

  // ── getLastUpdated ───────────────────────────────────────

  describe('getLastUpdated', () => {
    it('returns null when no fetches have been recorded', () => {
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);

      expect(manager.getLastUpdated()).toBeNull();
    });

    it('returns the fetch timestamp after a successful refresh', async () => {
      vi.setSystemTime(TIME_T0);
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('a', 'A', () => Promise.resolve(makeProvider('a'))));

      await manager.refresh();

      expect(manager.getLastUpdated()).toBe(TIME_T0);
    });

    it('returns the minimum timestamp across fresh and stale adapters', async () => {
      vi.setSystemTime(TIME_T1);
      const stale = new Provider('a', 'A', 'plan', [makeModelUsage()], undefined, TIME_T0);
      const { store, map } = makeFakeStore();
      map.set('a', stale);
      const fresh = makeProvider('b', 'plan', [makeModelUsage()]);
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('a', 'A', () => Promise.reject(new Error('boom'))));
      manager.register(makeAdapter('b', 'B', () => Promise.resolve(fresh)));

      await manager.refresh();

      // 'b' fresh at TIME_T1, 'a' stale at TIME_T0 -> min is TIME_T0
      expect(manager.getLastUpdated()).toBe(TIME_T0);
    });
  });

  // ── getCachedProviders ───────────────────────────────────

  describe('getCachedProviders', () => {
    it('returns a Loading placeholder when nothing is cached or stored', () => {
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('a', 'A', () => Promise.resolve(makeProvider('a'))));

      const providers = manager.getCachedProviders();

      expect(providers[0].plan).toBe('Loading');
      expect(providers[0].models).toEqual([]);
    });

    it('falls back to the store on a cache miss and warms the cache', () => {
      const stored = makeProvider('a', 'plan', [makeModelUsage()]);
      const { store, map } = makeFakeStore();
      map.set('a', stored);
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('a', 'A', () => Promise.resolve(makeProvider('a'))));

      const first = manager.getCachedProviders();
      expect(first[0].plan).toBe('plan'); // served from store

      // Store emptied: the warmed cache must keep serving the value.
      map.delete('a');
      const second = manager.getCachedProviders();
      expect(second[0].plan).toBe('plan');
    });

    it('serves from cache when populated by a prior refresh', async () => {
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('a', 'A', () => Promise.resolve(makeProvider('a', 'fetched'))));

      await manager.refresh();

      const providers = manager.getCachedProviders();
      expect(providers[0].plan).toBe('fetched');
    });
  });

  // ── refresh ──────────────────────────────────────────────

  describe('refresh', () => {
    it('returns all providers when every adapter succeeds', async () => {
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('a', 'A', () => Promise.resolve(makeProvider('a'))));
      manager.register(makeAdapter('b', 'B', () => Promise.resolve(makeProvider('b'))));

      const result = await manager.refresh();

      expect(result).toHaveLength(2);
      expect(result.map((p) => p.id)).toEqual(['a', 'b']);
    });

    it('serves stale data when an adapter rejects but a stored snapshot has models', async () => {
      const stale = new Provider('a', 'A', 'plan', [makeModelUsage()], undefined, TIME_T0);
      const { store, map } = makeFakeStore();
      map.set('a', stale);
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('a', 'A', () => Promise.reject(new Error('boom'))));

      const result = await manager.refresh();

      expect(result).toHaveLength(1);
      expect(result[0].stale).toBe(true);
      expect(result[0].models).toHaveLength(1);
      expect(result[0].updatedAt).toBe(TIME_T0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'a' }),
        expect.stringContaining('Serving stale data'),
      );
    });

    it('recovers from the previous cache snapshot on a later failed refresh', async () => {
      const { store } = makeFakeStore();
      let fail = false;
      const manager = new ProviderManager(store);
      manager.register(
        makeAdapter('a', 'A', () =>
          fail
            ? Promise.reject(new Error('boom'))
            : Promise.resolve(makeProvider('a', 'plan', [makeModelUsage()])),
        ),
      );

      await manager.refresh(); // populates cache with a valid provider

      fail = true;
      const result = await manager.refresh();

      expect(result[0].stale).toBe(true);
      expect(result[0].models).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'a' }),
        expect.stringContaining('Serving stale data'),
      );
    });

    it('falls back to an error placeholder when an adapter rejects with no usable cache', async () => {
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('a', 'A', () => Promise.reject(new Error('boom'))));

      const result = await manager.refresh();

      expect(result).toHaveLength(1);
      expect(result[0].plan).toBe('unknown');
      expect(result[0].error).toBe('boom');
      expect(result[0].models).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'a' }),
        expect.stringContaining('no cached data'),
      );
    });

    it('falls back when the stored snapshot carries an error', async () => {
      const errored = new Provider('a', 'A', 'plan', [makeModelUsage()], 'old error', TIME_T0);
      const { store, map } = makeFakeStore();
      map.set('a', errored);
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('a', 'A', () => Promise.reject(new Error('boom'))));

      const result = await manager.refresh();

      expect(result[0].plan).toBe('unknown');
      expect(result[0].error).toBe('boom');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'a' }),
        expect.stringContaining('no cached data'),
      );
    });

    it('falls back when the stored snapshot has no models', async () => {
      const empty = makeProvider('a', 'plan', []);
      const { store, map } = makeFakeStore();
      map.set('a', empty);
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('a', 'A', () => Promise.reject(new Error('boom'))));

      const result = await manager.refresh();

      expect(result[0].plan).toBe('unknown');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'a' }),
        expect.stringContaining('no cached data'),
      );
    });

    it('stringifies a non-Error rejection reason in the fallback error message', async () => {
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('a', 'A', () => Promise.reject('weird failure')));

      const result = await manager.refresh();

      expect(result[0].error).toBe('weird failure');
    });

    it('uses Date.now() for the stale timestamp when the snapshot lacks updatedAt', async () => {
      vi.setSystemTime(TIME_T1);
      const stale = new Provider('a', 'A', 'plan', [makeModelUsage()]);
      const { store, map } = makeFakeStore();
      map.set('a', stale);
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('a', 'A', () => Promise.reject(new Error('boom'))));

      const result = await manager.refresh();

      expect(result[0].stale).toBe(true);
      expect(result[0].updatedAt).toBe(TIME_T1);
    });
  });

  // ── refreshSlow (slow adapters) ──────────────────────────

  describe('refreshSlow (slow adapters)', () => {
    it('start fetches slow adapters via the slow path and caches them', async () => {
      const fetchSlow = vi.fn(() =>
        Promise.resolve(makeProvider('slow', 'plan', [makeModelUsage()])),
      );
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('slow', 'Slow', fetchSlow));
      manager.markSlow('slow');

      manager.start();
      await flush();

      expect(fetchSlow).toHaveBeenCalledTimes(1);
      const providers = manager.getCachedProviders();
      expect(providers[0].id).toBe('slow');
      expect(providers[0].plan).toBe('plan');
      manager.stop();
    });

    it('surfaces a slow adapter failure and continues with the next adapter', async () => {
      const fetchBad = vi.fn(() => Promise.reject(new Error('slow fail')));
      const fetchGood = vi.fn(() => Promise.resolve(makeProvider('good')));
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('bad', 'Bad', fetchBad));
      manager.register(makeAdapter('good', 'Good', fetchGood));
      manager.markSlow('bad');
      manager.markSlow('good');

      manager.start();
      await flush();

      expect(fetchBad).toHaveBeenCalledTimes(1);
      expect(fetchGood).toHaveBeenCalledTimes(1);

      const logs = manager.getLogs();
      expect(
        logs.some(
          (entry: LogEntry) =>
            entry.providerId === 'bad' &&
            entry.level === 'error' &&
            entry.message.includes('slow fail'),
        ),
      ).toBe(true);
      manager.stop();
    });

    it('serves the last-good card marked stale when a slow adapter rejects', async () => {
      vi.setSystemTime(TIME_T0);
      const good = makeProvider('slow', 'plan', [makeModelUsage()]);
      const fetchSlow = vi
        .fn()
        .mockResolvedValueOnce(good)
        .mockRejectedValue(new Error('CDP websocket failed'));
      const { store, metricsMap } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('slow', 'Slow', fetchSlow));
      manager.markSlow('slow');

      manager.start();
      await flush();
      // One slow interval reaches the failing tick; one extra fast tick then
      // clears the in-memory cache, proving the stale card survives via the store.
      await vi.advanceTimersByTimeAsync(SLOW_TICK_INTERVAL_MS + TICK_INTERVAL_MS);

      const card = manager.getCachedProviders()[0];
      expect(card.stale).toBe(true);
      expect(card.error).toBeUndefined();
      expect(card.models).toHaveLength(1);
      // The original success timestamp is preserved, not bumped by the failure.
      expect(card.updatedAt).toBe(TIME_T0);

      // The failure still counts as an attempt; the success timestamp survives.
      expect(metricsMap.get('slow')).toEqual({
        lastSuccessAt: TIME_T0,
        lastAttemptAt: TIME_T0 + SLOW_TICK_INTERVAL_MS,
        configured: true,
      });
      manager.stop();
    });

    it('falls back to an error card when a slow adapter has no cached data', async () => {
      const fetchSlow = vi.fn(() => Promise.reject(new Error('HTTP 403')));
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('slow', 'Slow', fetchSlow));
      manager.markSlow('slow');

      manager.start();
      await flush();

      const card = manager.getCachedProviders()[0];
      expect(card.error).toBe('HTTP 403');
      expect(card.models).toEqual([]);
      manager.stop();
    });

    it('schedules another slow refresh after SLOW_TICK_INTERVAL', async () => {
      const fetchSlow = vi.fn(() => Promise.resolve(makeProvider('slow')));
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('slow', 'Slow', fetchSlow));
      manager.markSlow('slow');

      manager.start();
      await flush();
      expect(fetchSlow).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(SLOW_TICK_INTERVAL_MS);
      expect(fetchSlow).toHaveBeenCalledTimes(2);
      manager.stop();
    });
  });

  // ── fetchOne stamping ────────────────────────────────────

  describe('fetchOne stamping', () => {
    it('stamps the provider with the current time and persists to the store', async () => {
      vi.setSystemTime(TIME_T0);
      const { store, map } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(
        makeAdapter('a', 'A', () => Promise.resolve(makeProvider('a', 'plan', [makeModelUsage()]))),
      );

      const result = await manager.refresh();

      expect(result[0].updatedAt).toBe(TIME_T0);
      expect(map.get('a')?.updatedAt).toBe(TIME_T0);
    });
  });

  // ── archive + metrics + logs ─────────────────────────────

  describe('archive handling', () => {
    it('does not fetch archived adapters on refresh', async () => {
      const fetchA = vi.fn(() => Promise.resolve(makeProvider('a', 'plan', [makeModelUsage()])));
      const fetchB = vi.fn(() => Promise.resolve(makeProvider('b')));
      const { store, archiveSet } = makeFakeStore();

      archiveSet.add('a');

      const manager = new ProviderManager(store);
      manager.register(makeAdapter('a', 'A', fetchA));
      manager.register(makeAdapter('b', 'B', fetchB));

      await manager.refresh();

      expect(fetchA).not.toHaveBeenCalled();
      expect(fetchB).toHaveBeenCalledTimes(1);
    });

    it('does not fetch archived slow adapters on refreshSlow', async () => {
      const fetchSlow = vi.fn(() => Promise.resolve(makeProvider('slow')));
      const { store, archiveSet } = makeFakeStore();

      archiveSet.add('slow');

      const manager = new ProviderManager(store);
      manager.register(makeAdapter('slow', 'Slow', fetchSlow));
      manager.markSlow('slow');

      manager.start();
      await flush();

      expect(fetchSlow).not.toHaveBeenCalled();
      manager.stop();
    });
  });

  describe('metrics tracking', () => {
    it('records lastSuccessAt and lastAttemptAt on successful fetch', async () => {
      vi.setSystemTime(TIME_T0);
      const { store, metricsMap } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(
        makeAdapter('a', 'A', () => Promise.resolve(makeProvider('a', 'plan', [makeModelUsage()]))),
      );

      await manager.refresh();

      const rec = metricsMap.get('a');

      expect(rec).toBeDefined();
      expect(rec?.lastSuccessAt).toBe(TIME_T0);
      expect(rec?.lastAttemptAt).toBe(TIME_T0);
      expect(rec?.configured).toBe(true);
    });

    it('records configured=false and null lastSuccessAt for Not configured result', async () => {
      vi.setSystemTime(TIME_T0);
      const { store, metricsMap } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(
        makeAdapter('a', 'A', () => Promise.resolve(makeProvider('a', 'Not configured', []))),
      );

      await manager.refresh();

      const rec = metricsMap.get('a');

      expect(rec).toBeDefined();
      expect(rec?.configured).toBe(false);
      expect(rec?.lastAttemptAt).toBe(TIME_T0);
      expect(rec?.lastSuccessAt).toBeNull();
    });

    it('advances lastAttemptAt but preserves lastSuccessAt on rejected fetch', async () => {
      vi.setSystemTime(TIME_T0);
      const { store, metricsMap } = makeFakeStore();

      const manager = new ProviderManager(store);
      let shouldFail = false;
      manager.register(
        makeAdapter('a', 'A', () => {
          if (shouldFail) {
            return Promise.reject(new Error('boom'));
          }
          return Promise.resolve(makeProvider('a', 'plan', [makeModelUsage()]));
        }),
      );

      // First fetch succeeds — populates lastSuccessAt = TIME_T0
      await manager.refresh();

      const afterSuccess = metricsMap.get('a');

      expect(afterSuccess?.lastSuccessAt).toBe(TIME_T0);

      vi.setSystemTime(TIME_T1);
      shouldFail = true;

      // Second fetch fails — lastAttemptAt advances, lastSuccessAt preserved
      await manager.refresh();

      const rec = metricsMap.get('a');

      expect(rec).toBeDefined();
      expect(rec?.lastAttemptAt).toBe(TIME_T1);
      expect(rec?.lastSuccessAt).toBe(TIME_T0);
    });

    it('preserves null lastSuccessAt on rejected fetch when no prior success', async () => {
      vi.setSystemTime(TIME_T0);
      const { store, metricsMap } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('a', 'A', () => Promise.reject(new Error('boom'))));

      await manager.refresh();

      const rec = metricsMap.get('a');

      expect(rec).toBeDefined();
      expect(rec?.lastAttemptAt).toBe(TIME_T0);
      expect(rec?.lastSuccessAt).toBeNull();
    });

    it('getMetrics reports archived=true for archived adapter', () => {
      const { store, archiveSet } = makeFakeStore();

      archiveSet.add('a');

      const manager = new ProviderManager(store);
      manager.register(makeAdapter('a', 'A', () => Promise.resolve(makeProvider('a'))));

      const results = manager.getMetrics();

      expect(results).toHaveLength(1);
      expect(results[0].archived).toBe(true);
    });

    it('getMetrics reports archived=false for non-archived adapter', () => {
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('a', 'A', () => Promise.resolve(makeProvider('a'))));

      const results = manager.getMetrics();

      expect(results).toHaveLength(1);
      expect(results[0].archived).toBe(false);
    });

    it('getMetrics reads configured from metric map when available', async () => {
      vi.setSystemTime(TIME_T0);
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(
        makeAdapter('a', 'A', () => Promise.resolve(makeProvider('a', 'Not configured', []))),
      );

      // Populate metrics via refresh
      await manager.refresh();

      const results = manager.getMetrics();

      expect(results[0].configured).toBe(false);
    });

    it('getMetrics returns adapter name from registration', () => {
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('xyz', 'TestName', () => Promise.resolve(makeProvider('xyz'))));

      const results = manager.getMetrics();

      expect(results[0].name).toBe('TestName');
      expect(results[0].id).toBe('xyz');
    });
  });

  describe('log entries', () => {
    it('getLogs returns entries pushed by refresh, newest-first', async () => {
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(
        makeAdapter('a', 'A', () => Promise.resolve(makeProvider('a', 'plan', [makeModelUsage()]))),
      );

      await manager.refresh();

      const logs = manager.getLogs();

      expect(logs.length).toBeGreaterThanOrEqual(2);

      // Should be newest-first: Refresh complete before Refresh started
      const completeIdx = logs.findIndex((l: LogEntry) => l.message.includes('Refresh complete'));
      const startedIdx = logs.findIndex((l: LogEntry) => l.message.includes('Refresh started'));

      expect(completeIdx).toBeLessThan(startedIdx);
    });

    it('getLogs includes per-provider update entries', async () => {
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(
        makeAdapter('a', 'A', () => Promise.resolve(makeProvider('a', 'plan', [makeModelUsage()]))),
      );

      await manager.refresh();

      const logs = manager.getLogs();
      const updated = logs.filter((l: LogEntry) => l.message === 'A updated');

      expect(updated.length).toBe(1);
    });

    it('getLogs includes Not configured per-provider entry', async () => {
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(
        makeAdapter('a', 'A', () => Promise.resolve(makeProvider('a', 'Not configured', []))),
      );

      await manager.refresh();

      const logs = manager.getLogs();
      const notConf = logs.filter((l: LogEntry) => l.message === 'A not configured');

      expect(notConf.length).toBe(1);
    });

    it('recordArchive(id, true) pushes an archived info log', () => {
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('a', 'A', () => Promise.resolve(makeProvider('a'))));

      manager.recordArchive('a', true);

      const logs = manager.getLogs();

      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('info');
      expect(logs[0].message).toBe('A archived');
      expect(logs[0].providerId).toBe('a');
    });

    it('recordArchive(id, false) pushes an unarchived info log', () => {
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('a', 'A', () => Promise.resolve(makeProvider('a'))));

      manager.recordArchive('a', false);

      const logs = manager.getLogs();

      expect(logs).toHaveLength(1);
      expect(logs[0].message).toBe('A unarchived');
    });

    it('recordArchive uses providerId as fallback when adapter not registered', () => {
      const { store } = makeFakeStore();
      const manager = new ProviderManager(store);

      manager.recordArchive('unknown', true);

      const logs = manager.getLogs();

      expect(logs[0].message).toContain('unknown');
    });
  });

  // ── quota tracking ───────────────────────────────────────

  describe('quota tracking', () => {
    let store: ProviderStore;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(QUOTA_BASE_NOW);
      store = new ProviderStore();
      store.init(':memory:');
    });

    afterEach(() => {
      vi.useRealTimers();
      store.close();
    });

    it('records a quota period row for a tracked provider after refresh', async () => {
      const win = UsageWindow.fromApi('weekly', QUOTA_USED_PCT, QUOTA_RESET_AT);
      const provider = new Provider('codex', 'OpenAI Codex', 'pro', [
        { modelName: 'pro', windows: [win] },
      ]);
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('codex', 'OpenAI Codex', () => Promise.resolve(provider)));

      await manager.refresh();

      const periods = store.getQuotaPeriods();

      expect(periods).toHaveLength(1);
      expect(periods[0].providerId).toBe('codex');
      expect(periods[0].remainingPercent).toBeCloseTo(QUOTA_REMAINING_PCT, CLOSE_TO_DECIMALS);
    });

    it('produces no quota rows for a non-tracked provider after refresh', async () => {
      const win = UsageWindow.fromApi('daily', QUOTA_USED_PCT, QUOTA_RESET_AT);
      const provider = new Provider('brave', 'Brave', 'pro', [
        { modelName: 'pro', windows: [win] },
      ]);
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('brave', 'Brave', () => Promise.resolve(provider)));

      await manager.refresh();

      expect(store.getQuotaPeriods()).toHaveLength(0);
    });

    it('getQuotaHistory returns the row with providerName and completed=false for a future reset', async () => {
      const win = UsageWindow.fromApi('weekly', QUOTA_USED_PCT, QUOTA_RESET_AT);
      const provider = new Provider('codex', 'OpenAI Codex', 'pro', [
        { modelName: 'pro', windows: [win] },
      ]);
      const manager = new ProviderManager(store);
      manager.register(makeAdapter('codex', 'OpenAI Codex', () => Promise.resolve(provider)));

      await manager.refresh();

      const history = manager.getQuotaHistory();

      expect(history).toHaveLength(1);
      expect(history[0].providerName).toBe('OpenAI Codex');
      expect(history[0].completed).toBe(false);
      expect(history[0].startedAt).toBe('2025-06-09T00:00:00.000Z');
    });
  });
});
