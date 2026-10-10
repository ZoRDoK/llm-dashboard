import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider } from '../../src/provider.js';
import { ProviderStore } from '../../src/store.js';

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({ createLogger: () => logger }));

// ── Constants ───────────────────────────────────────────────

const PROVIDER_A = 'adapt-a';
const PROVIDER_B = 'adapt-b';
const PROVIDER_C = 'adapt-c';

const SUCCESS_TS = 1_700_000_000_000;
const ATTEMPT_TS = 1_700_000_100_000;
const UPDATED_SUCCESS_TS = 1_700_000_200_000;

const BILLING_DATE = '2026-03-15T00:00:00.000Z';
const THREE_PROVIDERS = 3;

const STORE_PATH = ':memory:';

// ── Quota history constants ──────────────────────────────────

const RESET_AT_EARLY = '2026-07-12T00:00:00.000Z';
const RESET_AT_LATE = '2026-07-19T00:00:00.000Z';
const PERIOD_KEY_EARLY = '2026-07-12';
const PERIOD_KEY_LATE = '2026-07-19';
const FIRST_SAMPLED_TS = 1_000;
const SECOND_SAMPLED_TS = 5_000;
const USED_PCT = 30;
const REMAINING_PCT = 70;
const UPDATED_REMAINING_PCT = 60;
const UPDATED_USED_PCT = 40;

// ── Migration constants ─────────────────────────────────────

const CODEX_PERIOD_KEY = '2026-07-26';
const CODEX_RESET_AT = '2026-07-26T00:00:00.000Z';
const CODEX_NEW_PERIOD_KEY = '2026-07-20';
const CODEX_NEW_RESET_AT = '2026-07-27T00:00:00.000Z';

// ── Watchdog constants ─────────────────────────────────────

const DAY_TODAY = '2026-07-15';
const DAY_OTHER = '2026-07-16';
const RUN_STARTED_AT = 1_784_000_000_000;
const ONE_MINUTE_MS = 60_000;
const RUN_FINISHED_AT = RUN_STARTED_AT + ONE_MINUTE_MS;
const SPAWN_PID = 12_345;
const RECENT_LIMIT_ONE = 1;
const RECENT_LIMIT_TWO = 2;
const LOGIN_ALERT_MSG = 'Brave: login required';
const FAILED_ALERT_MSG = 'Auto-repair ran 2 times today, still failing: kimi';

// ── Helpers ─────────────────────────────────────────────────

/** Seed a pre-migration DB: quota_history rows without a meta/migration key. */
function seedPreMigrationDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS quota_history (
      provider_id TEXT NOT NULL,
      period_key TEXT NOT NULL,
      reset_at TEXT NOT NULL,
      used_percent REAL,
      remaining_percent REAL,
      first_sampled_at INTEGER NOT NULL,
      last_sampled_at INTEGER NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (provider_id, period_key)
    )
  `);

  db.prepare(
    'INSERT INTO quota_history (provider_id, period_key, reset_at, used_percent, remaining_percent, first_sampled_at, last_sampled_at, sample_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    'codex',
    CODEX_PERIOD_KEY,
    CODEX_RESET_AT,
    USED_PCT,
    REMAINING_PCT,
    FIRST_SAMPLED_TS,
    FIRST_SAMPLED_TS,
    1,
  );
  db.prepare(
    'INSERT INTO quota_history (provider_id, period_key, reset_at, used_percent, remaining_percent, first_sampled_at, last_sampled_at, sample_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    'zai',
    PERIOD_KEY_LATE,
    RESET_AT_LATE,
    USED_PCT,
    REMAINING_PCT,
    FIRST_SAMPLED_TS,
    FIRST_SAMPLED_TS,
    1,
  );

  db.close();
}

// ── Tests ───────────────────────────────────────────────────

describe('ProviderStore', () => {
  let store: ProviderStore;

  beforeEach(() => {
    store = new ProviderStore();
    store.init(STORE_PATH);
  });

  afterEach(() => {
    store.close();
  });

  // ── get / set ────────────────────────────────────────────

  describe('get / set', () => {
    it('returns null for unknown provider id', () => {
      expect(store.get('nonexistent')).toBeNull();
    });

    it('round-trips a provider through set and get', () => {
      const provider = new Provider(PROVIDER_A, 'A', 'pro', []);

      store.set(PROVIDER_A, provider);

      const retrieved = store.get(PROVIDER_A);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(PROVIDER_A);
      expect(retrieved?.name).toBe('A');
      expect(retrieved?.plan).toBe('pro');
    });

    it('overwrites an existing provider on second set', () => {
      const first = new Provider(PROVIDER_A, 'A', 'pro', []);
      const second = new Provider(PROVIDER_A, 'A', 'updated-plan', []);

      store.set(PROVIDER_A, first);
      store.set(PROVIDER_A, second);

      const retrieved = store.get(PROVIDER_A);

      expect(retrieved?.plan).toBe('updated-plan');
    });

    it('returns null and logs an error for a corrupt cache row', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'store-corrupt-'));
      const dbPath = join(tmpDir, 'test.sqlite');
      const seeded = new ProviderStore();

      seeded.init(dbPath);
      seeded.close();

      const raw = new DatabaseSync(dbPath);

      raw
        .prepare(
          'INSERT OR REPLACE INTO provider_cache (provider_id, data, updated_at) VALUES (?, ?, ?)',
        )
        .run(PROVIDER_A, '{ not json', SUCCESS_TS);
      raw.close();

      logger.error.mockReset();

      const corrupt = new ProviderStore();

      corrupt.init(dbPath);
      expect(corrupt.get(PROVIDER_A)).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        { providerId: PROVIDER_A, err: expect.any(Error) },
        expect.stringContaining('Corrupt cache row'),
      );

      corrupt.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  // ── getBillingSettings / setBillingSetting ───────────────

  describe('billing settings', () => {
    it('returns empty record when no settings exist', () => {
      const settings = store.getBillingSettings();

      expect(settings).toEqual({});
    });

    it('round-trips a billing date', () => {
      store.setBillingSetting(PROVIDER_A, BILLING_DATE);

      const settings = store.getBillingSettings();

      expect(settings).toEqual({ [PROVIDER_A]: BILLING_DATE });
    });

    it('deletes billing setting when value is null', () => {
      store.setBillingSetting(PROVIDER_A, BILLING_DATE);
      store.setBillingSetting(PROVIDER_A, null);

      const settings = store.getBillingSettings();

      expect(settings).toEqual({});
    });

    it('stores settings for multiple providers independently', () => {
      store.setBillingSetting(PROVIDER_A, BILLING_DATE);
      store.setBillingSetting(PROVIDER_B, '2026-06-01T00:00:00.000Z');

      const settings = store.getBillingSettings();

      expect(settings[PROVIDER_A]).toBe(BILLING_DATE);
      expect(settings[PROVIDER_B]).toBe('2026-06-01T00:00:00.000Z');
    });
  });

  // ── archive settings ──────────────────────────────────────

  describe('archive settings', () => {
    it('returns empty set by default', () => {
      const archiveSet = store.getArchiveSettings();

      expect(archiveSet.size).toBe(0);
    });

    it('contains a provider id after archiving it', () => {
      store.setArchiveSetting(PROVIDER_A, true);

      const archiveSet = store.getArchiveSettings();

      expect(archiveSet.has(PROVIDER_A)).toBe(true);
      expect(archiveSet.size).toBe(1);
    });

    it('removes a provider id after unarchiving it', () => {
      store.setArchiveSetting(PROVIDER_A, true);
      store.setArchiveSetting(PROVIDER_A, false);

      const archiveSet = store.getArchiveSettings();

      expect(archiveSet.has(PROVIDER_A)).toBe(false);
      expect(archiveSet.size).toBe(0);
    });

    it('tracks multiple archived providers independently', () => {
      store.setArchiveSetting(PROVIDER_A, true);
      store.setArchiveSetting(PROVIDER_B, true);
      store.setArchiveSetting(PROVIDER_C, true);

      const archiveSet = store.getArchiveSettings();

      expect(archiveSet.size).toBe(THREE_PROVIDERS);
      expect(archiveSet.has(PROVIDER_A)).toBe(true);
      expect(archiveSet.has(PROVIDER_B)).toBe(true);
      expect(archiveSet.has(PROVIDER_C)).toBe(true);

      store.setArchiveSetting(PROVIDER_B, false);

      const updated = store.getArchiveSettings();

      expect(updated.size).toBe(2);
      expect(updated.has(PROVIDER_B)).toBe(false);
    });
  });

  // ── metrics ──────────────────────────────────────────────

  describe('metrics', () => {
    it('returns empty map when no metrics exist', () => {
      const metrics = store.getMetrics();

      expect(metrics.size).toBe(0);
    });

    it('upsertMetric inserts a new record and getMetrics returns it', () => {
      store.upsertMetric(PROVIDER_A, SUCCESS_TS, ATTEMPT_TS, true);

      const metrics = store.getMetrics();
      const rec = metrics.get(PROVIDER_A);

      expect(rec).toBeDefined();
      expect(rec?.lastSuccessAt).toBe(SUCCESS_TS);
      expect(rec?.lastAttemptAt).toBe(ATTEMPT_TS);
      expect(rec?.configured).toBe(true);
    });

    it('upsertMetric updates an existing record', () => {
      store.upsertMetric(PROVIDER_A, SUCCESS_TS, ATTEMPT_TS, true);
      store.upsertMetric(PROVIDER_A, UPDATED_SUCCESS_TS, ATTEMPT_TS, true);

      const metrics = store.getMetrics();
      const rec = metrics.get(PROVIDER_A);

      expect(rec?.lastSuccessAt).toBe(UPDATED_SUCCESS_TS);
    });

    it('upsertMetric stores null lastSuccessAt when provided', () => {
      store.upsertMetric(PROVIDER_A, null, ATTEMPT_TS, false);

      const metrics = store.getMetrics();
      const rec = metrics.get(PROVIDER_A);

      expect(rec?.lastSuccessAt).toBeNull();
      expect(rec?.configured).toBe(false);
    });

    it('stores metrics for multiple providers independently', () => {
      store.upsertMetric(PROVIDER_A, SUCCESS_TS, ATTEMPT_TS, true);
      store.upsertMetric(PROVIDER_B, null, ATTEMPT_TS, false);

      const metrics = store.getMetrics();

      expect(metrics.size).toBe(2);
      expect(metrics.get(PROVIDER_A)?.configured).toBe(true);
      expect(metrics.get(PROVIDER_B)?.configured).toBe(false);
    });
  });

  // ── quota history ────────────────────────────────────────

  describe('quota history', () => {
    it('getQuotaPeriods returns empty array initially', () => {
      expect(store.getQuotaPeriods()).toEqual([]);
    });

    it('upsertQuotaSample inserts a new period row returned by getLatestQuotaPeriod', () => {
      store.upsertQuotaSample(
        PROVIDER_A,
        PERIOD_KEY_LATE,
        RESET_AT_LATE,
        USED_PCT,
        REMAINING_PCT,
        FIRST_SAMPLED_TS,
      );

      const latest = store.getLatestQuotaPeriod(PROVIDER_A);

      expect(latest).not.toBeNull();
      expect(latest?.providerId).toBe(PROVIDER_A);
      expect(latest?.periodKey).toBe(PERIOD_KEY_LATE);
      expect(latest?.resetAt).toBe(RESET_AT_LATE);
      expect(latest?.usedPercent).toBe(USED_PCT);
      expect(latest?.remainingPercent).toBe(REMAINING_PCT);
      expect(latest?.sampleCount).toBe(1);

      const periods = store.getQuotaPeriods();

      expect(periods).toHaveLength(1);
      expect(periods[0].periodKey).toBe(PERIOD_KEY_LATE);
    });

    it('upserting the same provider and period increments sample_count and preserves reset_at and first_sampled_at', () => {
      store.upsertQuotaSample(
        PROVIDER_A,
        PERIOD_KEY_LATE,
        RESET_AT_LATE,
        USED_PCT,
        REMAINING_PCT,
        FIRST_SAMPLED_TS,
      );

      // Second call passes a DIFFERENT resetAt — the stored reset_at must stay the first one.
      store.upsertQuotaSample(
        PROVIDER_A,
        PERIOD_KEY_LATE,
        RESET_AT_EARLY,
        UPDATED_USED_PCT,
        UPDATED_REMAINING_PCT,
        SECOND_SAMPLED_TS,
      );

      const latest = store.getLatestQuotaPeriod(PROVIDER_A);

      expect(latest?.sampleCount).toBe(2);
      expect(latest?.lastSampledAt).toBe(SECOND_SAMPLED_TS);
      expect(latest?.usedPercent).toBe(UPDATED_USED_PCT);
      expect(latest?.remainingPercent).toBe(UPDATED_REMAINING_PCT);
      // reset_at and first_sampled_at are preserved from the first insert.
      expect(latest?.resetAt).toBe(RESET_AT_LATE);
      expect(latest?.firstSampledAt).toBe(FIRST_SAMPLED_TS);
    });

    it('getLatestQuotaPeriod returns the row with the greatest reset_at', () => {
      store.upsertQuotaSample(
        PROVIDER_A,
        PERIOD_KEY_EARLY,
        RESET_AT_EARLY,
        USED_PCT,
        REMAINING_PCT,
        FIRST_SAMPLED_TS,
      );
      store.upsertQuotaSample(
        PROVIDER_A,
        PERIOD_KEY_LATE,
        RESET_AT_LATE,
        USED_PCT,
        REMAINING_PCT,
        SECOND_SAMPLED_TS,
      );

      const latest = store.getLatestQuotaPeriod(PROVIDER_A);

      expect(latest?.resetAt).toBe(RESET_AT_LATE);
      expect(latest?.periodKey).toBe(PERIOD_KEY_LATE);
    });

    it('stores periods for multiple providers independently', () => {
      store.upsertQuotaSample(
        PROVIDER_A,
        PERIOD_KEY_LATE,
        RESET_AT_LATE,
        USED_PCT,
        REMAINING_PCT,
        FIRST_SAMPLED_TS,
      );
      store.upsertQuotaSample(
        PROVIDER_B,
        PERIOD_KEY_EARLY,
        RESET_AT_EARLY,
        USED_PCT,
        REMAINING_PCT,
        SECOND_SAMPLED_TS,
      );

      const periods = store.getQuotaPeriods();

      expect(periods).toHaveLength(2);

      const latestA = store.getLatestQuotaPeriod(PROVIDER_A);
      const latestB = store.getLatestQuotaPeriod(PROVIDER_B);

      expect(latestA?.providerId).toBe(PROVIDER_A);
      expect(latestB?.providerId).toBe(PROVIDER_B);
    });

    it('upsertQuotaSample stores null used and remaining percentages', () => {
      store.upsertQuotaSample(
        PROVIDER_A,
        PERIOD_KEY_LATE,
        RESET_AT_LATE,
        null,
        null,
        FIRST_SAMPLED_TS,
      );

      const latest = store.getLatestQuotaPeriod(PROVIDER_A);

      expect(latest?.usedPercent).toBeNull();
      expect(latest?.remainingPercent).toBeNull();
    });

    it('getLatestQuotaPeriod returns null for an unknown provider', () => {
      expect(store.getLatestQuotaPeriod(PROVIDER_C)).toBeNull();
    });
  });
});

// ── quota_v2_codex_iso_week migration ───────────────────────

describe('quota_v2_codex_iso_week migration', () => {
  let store: ProviderStore;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'store-test-'));
    dbPath = join(tmpDir, 'test.sqlite');
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deletes codex rows and preserves other-provider rows when the migration key is absent', () => {
    seedPreMigrationDb(dbPath);

    store = new ProviderStore();
    store.init(dbPath);

    const periods = store.getQuotaPeriods();
    const codexRows = periods.filter((p) => p.providerId === 'codex');
    const zaiRows = periods.filter((p) => p.providerId === 'zai');

    expect(codexRows).toHaveLength(0);
    expect(zaiRows).toHaveLength(1);
  });

  it('is idempotent — does not re-delete codex rows inserted after migration', () => {
    // First init: migration runs and sets the marker key (no codex rows yet).
    store = new ProviderStore();
    store.init(dbPath);

    // Insert codex + zai rows after the migration has completed.
    store.upsertQuotaSample(
      'codex',
      CODEX_NEW_PERIOD_KEY,
      CODEX_NEW_RESET_AT,
      USED_PCT,
      REMAINING_PCT,
      FIRST_SAMPLED_TS,
    );
    store.upsertQuotaSample(
      'zai',
      PERIOD_KEY_LATE,
      RESET_AT_LATE,
      USED_PCT,
      REMAINING_PCT,
      FIRST_SAMPLED_TS,
    );

    store.close();

    // Second init: marker key already present, codex rows must survive.
    store = new ProviderStore();
    store.init(dbPath);

    const periods = store.getQuotaPeriods();

    expect(periods).toHaveLength(2);
    expect(periods.filter((p) => p.providerId === 'codex')).toHaveLength(1);
  });
});

// ── Watchdog tables ─────────────────────────────────────────

describe('ProviderStore watchdog persistence', () => {
  let store: ProviderStore;

  beforeEach(() => {
    store = new ProviderStore();
    store.init(STORE_PATH);
  });

  afterEach(() => {
    store.close();
  });

  describe('watchdog runs', () => {
    it('inserts a running run, returns its id, and round-trips providers JSON', () => {
      const id = store.addWatchdogRun(DAY_TODAY, RUN_STARTED_AT, [PROVIDER_A, PROVIDER_B], null);

      const runs = store.getRunningWatchdogRuns();

      expect(id).toBe(1);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.providers).toEqual([PROVIDER_A, PROVIDER_B]);
      expect(runs[0]?.status).toBe('running');
      expect(runs[0]?.pid).toBeNull();
      expect(runs[0]?.finishedAt).toBeNull();
    });

    it('records the pid separately after the spawn', () => {
      const id = store.addWatchdogRun(DAY_TODAY, RUN_STARTED_AT, [PROVIDER_A], null);

      store.setWatchdogRunPid(id, SPAWN_PID);

      expect(store.getRunningWatchdogRuns()[0]?.pid).toBe(SPAWN_PID);
    });

    it('finishes a run and drops it from the running set', () => {
      const id = store.addWatchdogRun(DAY_TODAY, RUN_STARTED_AT, [PROVIDER_A], SPAWN_PID);

      store.finishWatchdogRun(id, 'finished', RUN_FINISHED_AT);

      expect(store.getRunningWatchdogRuns()).toHaveLength(0);

      const [run] = store.getRecentWatchdogRuns(RECENT_LIMIT_ONE);

      expect(run?.status).toBe('finished');
      expect(run?.finishedAt).toBe(RUN_FINISHED_AT);
    });

    it('filters runs by local day and counts them', () => {
      store.addWatchdogRun(DAY_TODAY, RUN_STARTED_AT, [PROVIDER_A], null);
      store.addWatchdogRun(DAY_TODAY, RUN_STARTED_AT + 1, [PROVIDER_B], null);
      store.addWatchdogRun(DAY_OTHER, RUN_STARTED_AT + 2, [PROVIDER_C], null);

      expect(store.countWatchdogRunsForDay(DAY_TODAY)).toBe(2);
      expect(store.countWatchdogRunsForDay(DAY_OTHER)).toBe(1);
      expect(store.countWatchdogRunsForDay('2000-01-01')).toBe(0);
    });

    it('returns recent runs newest-first with a limit', () => {
      store.addWatchdogRun(DAY_TODAY, RUN_STARTED_AT, [PROVIDER_A], null);
      store.addWatchdogRun(DAY_TODAY, RUN_STARTED_AT + 1, [PROVIDER_B], null);
      store.addWatchdogRun(DAY_TODAY, RUN_STARTED_AT + 2, [PROVIDER_C], null);

      const recent = store.getRecentWatchdogRuns(RECENT_LIMIT_TWO);

      expect(recent.map((r) => r.providers[0])).toEqual([PROVIDER_C, PROVIDER_B]);
    });
  });

  describe('watchdog alerts', () => {
    it('opens and lists alerts, treating unresolved as open', () => {
      store.openWatchdogAlert('login-required', PROVIDER_A, LOGIN_ALERT_MSG, RUN_STARTED_AT);

      const open = store.getOpenWatchdogAlerts();

      expect(open).toHaveLength(1);
      expect(open[0]?.kind).toBe('login-required');
      expect(open[0]?.providerId).toBe(PROVIDER_A);
      expect(open[0]?.message).toBe(LOGIN_ALERT_MSG);
      expect(open[0]?.createdAt).toBe(RUN_STARTED_AT);
      expect(open[0]?.resolvedAt).toBeNull();
    });

    it('resolves only the alerts matching kind and provider scope', () => {
      store.openWatchdogAlert('login-required', PROVIDER_A, LOGIN_ALERT_MSG, RUN_STARTED_AT);
      store.openWatchdogAlert('login-required', PROVIDER_B, LOGIN_ALERT_MSG, RUN_STARTED_AT);
      store.openWatchdogAlert('repair-failed', null, FAILED_ALERT_MSG, RUN_STARTED_AT);

      store.resolveWatchdogAlert('login-required', PROVIDER_A);

      const open = store.getOpenWatchdogAlerts();

      expect(open.map((a) => `${a.kind}:${a.providerId}`)).toEqual([
        `login-required:${PROVIDER_B}`,
        'repair-failed:null',
      ]);
    });

    it('resolves global alerts without touching provider-scoped ones', () => {
      store.openWatchdogAlert('repair-failed', null, FAILED_ALERT_MSG, RUN_STARTED_AT);
      store.openWatchdogAlert('login-required', PROVIDER_A, LOGIN_ALERT_MSG, RUN_STARTED_AT);

      store.resolveWatchdogAlert('repair-failed', null);

      expect(store.getOpenWatchdogAlerts().map((a) => a.kind)).toEqual(['login-required']);
    });

    it('resolves all open alerts at once', () => {
      store.openWatchdogAlert('login-required', PROVIDER_A, LOGIN_ALERT_MSG, RUN_STARTED_AT);
      store.openWatchdogAlert('repair-failed', null, FAILED_ALERT_MSG, RUN_STARTED_AT);

      store.resolveAllOpenWatchdogAlerts();

      expect(store.getOpenWatchdogAlerts()).toHaveLength(0);
    });
  });
});
