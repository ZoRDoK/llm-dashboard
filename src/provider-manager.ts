import { LogStore } from './log-store.js';
import { createLogger } from './logger.js';
import { Provider } from './provider.js';
import { periodStartIso, QuotaTracker } from './quota-tracker.js';
import type { ProviderStore } from './store.js';
import type { LogEntry, ProviderAdapter, ProviderMetrics, QuotaPeriod } from './types.js';

const log = createLogger('manager');

const TICK_INTERVAL_MS = 60_000;
const SLOW_TICK_INTERVAL_MS = 600_000; // 10 minutes for rate-limited providers
const LOG_RECENT_LIMIT = 200;

export class ProviderManager {
  private adapters: ProviderAdapter[] = [];
  private store: ProviderStore;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private slowTimer: ReturnType<typeof setTimeout> | null = null;
  private cache: Map<string, Provider> = new Map();
  private lastFetch: Map<string, number> = new Map();
  private slowAdapters: Set<string> = new Set();
  private readonly logStore = new LogStore();
  private readonly quotaTracker: QuotaTracker;
  private metricMap: Map<
    string,
    { lastSuccessAt: number | null; lastAttemptAt: number | null; configured: boolean }
  > = new Map();

  constructor(store: ProviderStore) {
    this.store = store;
    this.quotaTracker = new QuotaTracker(store);
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

    this.loadMetrics();
    this.scheduleRefresh();
    this.scheduleSlowRefresh();
  }

  private scheduleRefresh(): void {
    this.refresh()
      .catch((err: unknown) => {
        log.error({ err }, 'Background refresh failed');
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

  private loadMetrics(): void {
    this.metricMap = this.store.getMetrics();
  }

  /** Return the most recent log entries (newest first). */
  getLogs(): LogEntry[] {
    return this.logStore.recent(LOG_RECENT_LIMIT);
  }

  /** Build metrics records for all registered adapters. */
  getMetrics(): ProviderMetrics[] {
    const archiveSet = this.store.getArchiveSettings();
    const results: ProviderMetrics[] = [];

    for (const adapter of this.adapters) {
      const rec = this.metricMap.get(adapter.id);

      results.push({
        id: adapter.id,
        name: adapter.name,
        archived: archiveSet.has(adapter.id),
        configured: rec?.configured ?? true,
        lastSuccessAt: rec?.lastSuccessAt ?? null,
        lastAttemptAt: rec?.lastAttemptAt ?? null,
      });
    }

    return results;
  }

  /** Build the quota-burn history records for all tracked providers. */
  getQuotaHistory(): QuotaPeriod[] {
    const rows = this.quotaTracker.periods();
    const now = Date.now();
    const nameMap = new Map(this.adapters.map((a) => [a.id, a.name]));

    const periods: QuotaPeriod[] = rows.map((r) => ({
      providerId: r.providerId,
      providerName: nameMap.get(r.providerId) ?? r.providerId,
      periodKey: r.periodKey,
      resetAt: r.resetAt,
      startedAt: periodStartIso(r.providerId, r.periodKey, r.resetAt),
      usedPercent: r.usedPercent,
      remainingPercent: r.remainingPercent,
      firstSampledAt: r.firstSampledAt,
      lastSampledAt: r.lastSampledAt,
      sampleCount: r.sampleCount,
      completed: r.resetAt != null && Date.parse(r.resetAt) < now,
    }));

    periods.sort((a, b) => {
      const byName = a.providerName.localeCompare(b.providerName);

      if (byName !== 0) {
        return byName;
      }

      return (b.resetAt ?? '').localeCompare(a.resetAt ?? '');
    });

    return periods;
  }

  /** Record an archive/unarchive action in the log. */
  recordArchive(providerId: string, archived: boolean): void {
    const adapter = this.adapters.find((a) => a.id === providerId);
    const name = adapter?.name ?? providerId;
    const message = archived ? `${name} archived` : `${name} unarchived`;

    this.logStore.push({
      ts: Date.now(),
      level: 'info',
      message,
      providerId,
    });

    log.info({ providerId, archived }, message);
  }

  getLastUpdated(): number | null {
    const timestamps = [...this.lastFetch.values()];

    return timestamps.length === 0 ? null : Math.min(...timestamps);
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
    const archiveSet = this.store.getArchiveSettings();

    // Every tick, intentionally: idempotent — clearTimeout on a null timer is a no-op.
    this.stopArchivedKeepalives(archiveSet);

    const oldCache = new Map(this.cache);
    const oldFetch = new Map(this.lastFetch);

    this.lastFetch.clear();
    this.cache.clear();

    this.logStore.push({
      ts: Date.now(),
      level: 'info',
      message: 'Refresh started',
    });

    log.info('Refresh started');

    const activeAdapters = this.adapters.filter(
      (a) => !(this.slowAdapters.has(a.id) || archiveSet.has(a.id)),
    );
    const results = await Promise.allSettled(activeAdapters.map((a) => this.fetchOne(a)));

    const providers: Provider[] = [];
    const activeSet = new Set(activeAdapters);
    let okCount = 0;
    let failCount = 0;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const adapter = activeAdapters[i];

      if (result.status === 'fulfilled') {
        providers.push(result.value);
        okCount++;
      } else {
        failCount++;

        const recovered = this.recoverFailedFetch(adapter, result.reason, oldCache, oldFetch);

        if (recovered) {
          providers.push(recovered);
        }
      }
    }

    this.logStore.push({
      ts: Date.now(),
      level: 'info',
      message: `Refresh complete (${okCount} ok, ${failCount} failed)`,
    });

    log.info({ ok: okCount, failed: failCount }, 'Refresh complete');

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
    reason: unknown,
    oldCache: Map<string, Provider>,
    oldFetch: Map<string, number>,
  ): Provider | null {
    const prev = oldCache.get(adapter.id);
    const cached = prev?.error ? null : prev;
    const stored = cached ?? this.store.get(adapter.id);

    const error = reason instanceof Error ? reason : new Error(String(reason));
    const err = error.message;
    const metricPrev = this.metricMap.get(adapter.id);
    const metricAttemptAt = Date.now();

    this.metricMap.set(adapter.id, {
      lastSuccessAt: metricPrev?.lastSuccessAt ?? null,
      lastAttemptAt: metricAttemptAt,
      configured: metricPrev?.configured ?? true,
    });
    this.store.upsertMetric(
      adapter.id,
      metricPrev?.lastSuccessAt ?? null,
      metricAttemptAt,
      metricPrev?.configured ?? true,
    );
    this.logStore.push({
      ts: metricAttemptAt,
      level: 'error',
      message: `${adapter.name} update failed: ${err}`,
      providerId: adapter.id,
    });

    log.error({ providerId: adapter.id, err: error }, 'Provider update failed');

    // Serve stale data only when it has actual content (models present).
    // This excludes "Not configured" and other empty entries that look valid
    // but carry no useful information.
    if (stored && !stored.error && stored.models.length > 0) {
      // Preserve the original stale timestamp rather than pretending it was refreshed.
      const staleTs = stored.updatedAt ?? oldFetch.get(adapter.id) ?? Date.now();

      log.warn({ providerId: adapter.id, err: error }, 'Serving stale data');

      // Mark the cached copy as stale so the dashboard can surface the failure
      // without hiding the last-known usage behind an error card.
      const stale = new Provider(
        stored.id,
        stored.name,
        stored.plan,
        stored.models,
        stored.error,
        staleTs,
        true,
      );

      // Persist the stale-marked copy, not just the in-memory cache: the next
      // fast tick clears the cache, and a restart would otherwise load the
      // last-good card with no stale flag — hiding an ongoing outage.
      this.lastFetch.set(adapter.id, staleTs);
      this.cache.set(adapter.id, stale);
      this.store.set(adapter.id, stale);

      return stale;
    }

    log.warn({ providerId: adapter.id, err: error }, 'Refresh failed, no cached data');

    const now = Date.now();
    const fallback = new Provider(adapter.id, adapter.name, 'unknown', [], err, now);

    this.lastFetch.set(adapter.id, now);
    this.cache.set(adapter.id, fallback);
    this.store.set(adapter.id, fallback);

    return fallback;
  }

  private scheduleSlowRefresh(): void {
    this.refreshSlow()
      .catch((err: unknown) => {
        log.error({ err }, 'Slow refresh failed');
      })
      .finally(() => {
        this.slowTimer = setTimeout(() => this.scheduleSlowRefresh(), SLOW_TICK_INTERVAL_MS);
      });
  }

  /**
   * Refresh slow (rate-limited) adapters sequentially, one per tick slot.
   *
   * A failure goes through the same recovery as a fast-tick failure — log-store
   * error entry, lastAttemptAt metric, stale-marked card — so a persistently
   * failing slow provider stays visible to the dashboard and the watchdog.
   * Without this, a slow adapter that kept rejecting served its last-good card
   * with no error for hours (the watchdog reported "stale, last error: none").
   */
  private async refreshSlow(): Promise<void> {
    const archiveSet = this.store.getArchiveSettings();

    this.stopArchivedKeepalives(archiveSet);

    for (const adapter of this.adapters) {
      if (!this.slowAdapters.has(adapter.id)) {
        continue;
      }

      if (archiveSet.has(adapter.id)) {
        continue;
      }

      try {
        await this.fetchOne(adapter);
      } catch (err) {
        this.recoverFailedFetch(adapter, err, this.cache, this.lastFetch);
      }
    }
  }

  /** Archived providers must not keep background session timers running. */
  private stopArchivedKeepalives(archiveSet: ReadonlySet<string>): void {
    for (const adapter of this.adapters) {
      if (archiveSet.has(adapter.id)) {
        adapter.stopKeepalive?.();
      }
    }
  }

  private async fetchOne(adapter: ProviderAdapter): Promise<Provider> {
    const result = await adapter.fetchUsage();

    const now = Date.now();
    const isNotConfigured = result.plan === 'Not configured';
    const configured = !isNotConfigured;
    const isRealSuccess = !(isNotConfigured || result.error) && result.models.length > 0;
    const prev = this.metricMap.get(adapter.id);
    const lastSuccessAt = isRealSuccess ? now : (prev?.lastSuccessAt ?? null);
    const lastAttemptAt = now;

    this.metricMap.set(adapter.id, { lastSuccessAt, lastAttemptAt, configured });
    this.store.upsertMetric(adapter.id, lastSuccessAt, lastAttemptAt, configured);

    if (isRealSuccess) {
      this.logStore.push({
        ts: now,
        level: 'info',
        message: `${result.name} updated`,
        providerId: adapter.id,
      });

      log.info({ providerId: adapter.id }, 'Provider updated');
    } else if (isNotConfigured) {
      this.logStore.push({
        ts: now,
        level: 'info',
        message: `${result.name} not configured`,
        providerId: adapter.id,
      });

      log.info({ providerId: adapter.id }, 'Provider not configured');
    } else {
      this.logStore.push({
        ts: now,
        level: 'warn',
        message: `${result.name} update failed: ${result.error ?? ''}`,
        providerId: adapter.id,
      });

      log.warn({ providerId: adapter.id, reason: result.error }, 'Provider update failed');
    }

    const stamped = new Provider(
      result.id,
      result.name,
      result.plan,
      result.models,
      result.error,
      now,
    );

    this.lastFetch.set(adapter.id, now);
    this.cache.set(adapter.id, stamped);
    this.store.set(adapter.id, stamped);

    if (isRealSuccess) {
      this.quotaTracker.record(stamped);
    }

    return stamped;
  }
}
