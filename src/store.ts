/**
 * SQLite-backed persistence layer for provider cache data and billing settings.
 *
 * Uses node:sqlite (synchronous by design) — acceptable for this use case
 * because operations are small, infrequent, and run in a single-process server.
 */
import { DatabaseSync } from 'node:sqlite';
import { createLogger } from './logger.js';
import type { Provider } from './provider.js';

const log = createLogger('store');

export interface QuotaPeriodRow {
  providerId: string;
  periodKey: string;
  resetAt: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  firstSampledAt: number;
  lastSampledAt: number;
  sampleCount: number;
}

export type WatchdogRunStatus = 'running' | 'finished' | 'timeout';

type WatchdogAlertKind = 'repair-failed' | 'login-required';

/** One watchdog auto-repair run (a spawned headless agent session). */
export interface WatchdogRunRow {
  id: number;
  day: string;
  startedAt: number;
  finishedAt: number | null;
  status: WatchdogRunStatus;
  providers: string[];
  pid: number | null;
}

// Raw watchdog_runs row: aliased columns come back camelCase, but providers is
// still the JSON array encoded as TEXT.
type StoredWatchdogRun = Omit<WatchdogRunRow, 'providers'> & { providers: string };

/** A persistent watchdog alert that stays open until the cause disappears. */
export interface WatchdogAlertRow {
  id: number;
  providerId: string | null;
  kind: WatchdogAlertKind;
  message: string;
  createdAt: number;
  resolvedAt: number | null;
}

// One-time migration marker: when absent, bogus drift-fragmented codex rows
// are wiped so the new ISO-week keying starts from a clean slate.
const CODEX_ISO_WEEK_MIGRATION_KEY = 'quota_v2_codex_iso_week'; // gitleaks:allow — SQLite preference key, not a credential
const CODEX_ISO_WEEK_MIGRATION_VALUE = '1';

export class ProviderStore {
  private db: DatabaseSync | null = null;

  /** Initialize the database and create tables if they don't exist. */
  init(dbPath = 'data/cache.sqlite'): void {
    this.db = new DatabaseSync(dbPath);

    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA cache_size = -64000');
    this.db.exec('PRAGMA mmap_size = 268435456');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_cache (
        provider_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS billing_settings (
        provider_id TEXT PRIMARY KEY,
        billing_end_at TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_archive (
        provider_id TEXT PRIMARY KEY,
        archived INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_metrics (
        provider_id TEXT PRIMARY KEY,
        last_success_at INTEGER,
        last_attempt_at INTEGER,
        configured INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
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

    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_quota_history_reset ON quota_history (provider_id, reset_at)',
    );

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS watchdog_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        providers TEXT NOT NULL,
        pid INTEGER
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS watchdog_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      )
    `);

    this.migrate();

    log.info({ path: dbPath }, 'Provider store initialized');
  }

  private ensureDb(): DatabaseSync {
    if (!this.db) {
      throw new Error('Store not initialized. Call init() first.');
    }

    return this.db;
  }

  /**
   * One-time migration: wipe drift-fragmented codex quota_history rows so the
   * new ISO-week keying starts from a clean slate. Runs atomically and is
   * idempotent — the marker key prevents re-wiping on subsequent startups.
   */
  private migrate(): void {
    const db = this.ensureDb();

    const rows = db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .all(CODEX_ISO_WEEK_MIGRATION_KEY) as { value: string }[];

    if (rows.length > 0) {
      return;
    }

    db.exec('BEGIN');
    db.prepare('DELETE FROM quota_history WHERE provider_id = ?').run('codex');
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      CODEX_ISO_WEEK_MIGRATION_KEY,
      CODEX_ISO_WEEK_MIGRATION_VALUE,
    );
    db.exec('COMMIT');
  }

  /** Close the database connection gracefully. */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /** Retrieve a cached provider by ID. Returns null if not found. */
  get(providerId: string): Provider | null {
    const db = this.ensureDb();

    const rows = db
      .prepare('SELECT data, updated_at FROM provider_cache WHERE provider_id = ?')
      .all(providerId) as { data: string; updated_at: number }[];

    if (rows.length === 0) {
      return null;
    }

    const row = rows[0];
    let raw: Record<string, unknown>;

    try {
      raw = JSON.parse(row.data) as Record<string, unknown>;
    } catch (err) {
      // A corrupt row must not fail the whole refresh: log it and let the
      // caller treat the provider as uncached so the next fetch rewrites it.
      log.error({ providerId, err }, 'Corrupt cache row ignored');

      return null;
    }

    // Hydrate with stored updated_at timestamp so restarts show correct freshness
    raw.updatedAt = raw.updatedAt ?? row.updated_at;

    return raw as unknown as Provider;
  }

  /** Store or update a cached provider snapshot. */
  set(providerId: string, data: Provider): void {
    const db = this.ensureDb();

    db.prepare(
      'INSERT OR REPLACE INTO provider_cache (provider_id, data, updated_at) VALUES (?, ?, ?)',
    ).run(providerId, JSON.stringify(data), Date.now());
  }

  /** Retrieve all billing override dates. */
  getBillingSettings(): Record<string, string> {
    const db = this.ensureDb();

    const rows = db.prepare('SELECT provider_id, billing_end_at FROM billing_settings').all() as {
      provider_id: string;
      billing_end_at: string;
    }[];

    const result: Record<string, string> = {};

    for (const row of rows) {
      result[row.provider_id] = row.billing_end_at;
    }

    return result;
  }

  /**
   * Set a billing override date for a provider.
   * Passing null deletes the override (falls back to default billing logic).
   */
  setBillingSetting(providerId: string, billingEndAt: string | null): void {
    const db = this.ensureDb();

    if (billingEndAt === null) {
      db.prepare('DELETE FROM billing_settings WHERE provider_id = ?').run(providerId);
      return;
    }

    db.prepare(
      'INSERT OR REPLACE INTO billing_settings (provider_id, billing_end_at, updated_at) VALUES (?, ?, ?)',
    ).run(providerId, billingEndAt, Date.now());
  }

  /** Return the set of provider IDs that are archived. */
  getArchiveSettings(): Set<string> {
    const db = this.ensureDb();

    const rows = db
      .prepare('SELECT provider_id FROM provider_archive WHERE archived = 1')
      .all() as { provider_id: string }[];

    const result = new Set<string>();

    for (const row of rows) {
      result.add(row.provider_id);
    }

    return result;
  }

  /**
   * Set or clear the archive flag for a provider.
   * INSERTs a row when archived=true; DELETEs the row when archived=false.
   */
  setArchiveSetting(providerId: string, archived: boolean): void {
    const db = this.ensureDb();

    if (archived) {
      db.prepare(
        'INSERT OR REPLACE INTO provider_archive (provider_id, archived, updated_at) VALUES (?, 1, ?)',
      ).run(providerId, Date.now());
      return;
    }

    db.prepare('DELETE FROM provider_archive WHERE provider_id = ?').run(providerId);
  }

  /** Retrieve all provider metrics from the database. */
  getMetrics(): Map<
    string,
    { lastSuccessAt: number | null; lastAttemptAt: number | null; configured: boolean }
  > {
    const db = this.ensureDb();

    const rows = db.prepare('SELECT * FROM provider_metrics').all() as {
      provider_id: string;
      last_success_at: number | null;
      last_attempt_at: number | null;
      configured: number;
    }[];

    const result = new Map<
      string,
      { lastSuccessAt: number | null; lastAttemptAt: number | null; configured: boolean }
    >();

    for (const row of rows) {
      result.set(row.provider_id, {
        lastSuccessAt: row.last_success_at ?? null,
        lastAttemptAt: row.last_attempt_at ?? null,
        configured: row.configured !== 0,
      });
    }

    return result;
  }

  /** Insert or update a single provider's metrics row. */
  upsertMetric(
    providerId: string,
    lastSuccessAt: number | null,
    lastAttemptAt: number | null,
    configured: boolean,
  ): void {
    const db = this.ensureDb();

    db.prepare(
      `INSERT OR REPLACE INTO provider_metrics
       (provider_id, last_success_at, last_attempt_at, configured, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(providerId, lastSuccessAt, lastAttemptAt, configured ? 1 : 0, Date.now());
  }

  /** Return the latest quota period row for a provider (greatest reset_at), or null. */
  getLatestQuotaPeriod(providerId: string): QuotaPeriodRow | null {
    const db = this.ensureDb();

    const rows = db
      .prepare(
        `SELECT provider_id AS providerId, period_key AS periodKey, reset_at AS resetAt,
                used_percent AS usedPercent, remaining_percent AS remainingPercent,
                first_sampled_at AS firstSampledAt, last_sampled_at AS lastSampledAt,
                sample_count AS sampleCount
         FROM quota_history
         WHERE provider_id = ?
         ORDER BY reset_at DESC
         LIMIT 1`,
      )
      .all(providerId) as unknown as QuotaPeriodRow[];

    if (rows.length === 0) {
      return null;
    }

    return rows[0];
  }

  /**
   * Upsert a quota sample. On conflict (provider_id, period_key), only volatile
   * fields are updated and sample_count is incremented; reset_at and
   * first_sampled_at are preserved.
   */
  upsertQuotaSample(
    providerId: string,
    periodKey: string,
    resetAt: string,
    usedPercent: number | null,
    remainingPercent: number | null,
    sampledAt: number,
  ): void {
    const db = this.ensureDb();

    db.prepare(
      `INSERT INTO quota_history
        (provider_id, period_key, reset_at, used_percent, remaining_percent,
         first_sampled_at, last_sampled_at, sample_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(provider_id, period_key) DO UPDATE SET
         used_percent = excluded.used_percent,
         remaining_percent = excluded.remaining_percent,
         last_sampled_at = excluded.last_sampled_at,
         sample_count = quota_history.sample_count + 1`,
    ).run(providerId, periodKey, resetAt, usedPercent, remainingPercent, sampledAt, sampledAt);
  }

  /** Return all quota period rows ordered by provider_id then reset_at desc. */
  getQuotaPeriods(): QuotaPeriodRow[] {
    const db = this.ensureDb();

    const rows = db
      .prepare(
        `SELECT provider_id AS providerId, period_key AS periodKey, reset_at AS resetAt,
                used_percent AS usedPercent, remaining_percent AS remainingPercent,
                first_sampled_at AS firstSampledAt, last_sampled_at AS lastSampledAt,
                sample_count AS sampleCount
         FROM quota_history
         ORDER BY provider_id, reset_at DESC`,
      )
      .all() as unknown as QuotaPeriodRow[];

    return rows;
  }

  /** Insert a running watchdog run; providers are stored as a JSON array. */
  addWatchdogRun(day: string, startedAt: number, providers: string[], pid: number | null): number {
    const db = this.ensureDb();

    const result = db
      .prepare(
        `INSERT INTO watchdog_runs (day, started_at, providers, pid)
         VALUES (?, ?, ?, ?)`,
      )
      .run(day, startedAt, JSON.stringify(providers), pid);

    return Number(result.lastInsertRowid);
  }

  /** Record the pid of a spawned agent once the process exists. */
  setWatchdogRunPid(id: number, pid: number): void {
    const db = this.ensureDb();

    db.prepare('UPDATE watchdog_runs SET pid = ? WHERE id = ?').run(pid, id);
  }

  /** Close a run out with its final status. */
  finishWatchdogRun(id: number, status: WatchdogRunStatus, finishedAt: number): void {
    const db = this.ensureDb();

    db.prepare('UPDATE watchdog_runs SET status = ?, finished_at = ? WHERE id = ?').run(
      status,
      finishedAt,
      id,
    );
  }

  /** Return watchdog runs still marked as running. */
  getRunningWatchdogRuns(): WatchdogRunRow[] {
    const db = this.ensureDb();

    const rows = db
      .prepare(
        `SELECT id, day, started_at AS startedAt, finished_at AS finishedAt, status, providers, pid
         FROM watchdog_runs
         WHERE status = 'running'
         ORDER BY id`,
      )
      .all() as unknown as StoredWatchdogRun[];

    return rows.map((row) => ({ ...row, providers: JSON.parse(row.providers) as string[] }));
  }

  /** Return the most recent watchdog runs, newest first. */
  getRecentWatchdogRuns(limit: number): WatchdogRunRow[] {
    const db = this.ensureDb();

    const rows = db
      .prepare(
        `SELECT id, day, started_at AS startedAt, finished_at AS finishedAt, status, providers, pid
         FROM watchdog_runs
         ORDER BY started_at DESC, id DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as StoredWatchdogRun[];

    return rows.map((row) => ({ ...row, providers: JSON.parse(row.providers) as string[] }));
  }

  /** Count watchdog runs started on the given local day (any status). */
  countWatchdogRunsForDay(day: string): number {
    const db = this.ensureDb();

    const rows = db
      .prepare('SELECT COUNT(*) AS count FROM watchdog_runs WHERE day = ?')
      .all(day) as { count: number }[];

    return rows[0]?.count ?? 0;
  }

  /** Open a new alert. Callers dedupe by checking getOpenWatchdogAlerts() first. */
  openWatchdogAlert(
    kind: WatchdogAlertKind,
    providerId: string | null,
    message: string,
    createdAt: number,
  ): void {
    const db = this.ensureDb();

    db.prepare(
      'INSERT INTO watchdog_alerts (provider_id, kind, message, created_at) VALUES (?, ?, ?, ?)',
    ).run(providerId, kind, message, createdAt);
  }

  /** Return alerts that have not been resolved yet. */
  getOpenWatchdogAlerts(): WatchdogAlertRow[] {
    const db = this.ensureDb();

    const rows = db
      .prepare(
        `SELECT id, provider_id AS providerId, kind, message, created_at AS createdAt,
                resolved_at AS resolvedAt
         FROM watchdog_alerts
         WHERE resolved_at IS NULL
         ORDER BY id`,
      )
      .all() as unknown as WatchdogAlertRow[];

    return rows;
  }

  /** Resolve open alerts matching the kind and provider scope. */
  resolveWatchdogAlert(kind: WatchdogAlertKind, providerId: string | null): void {
    const db = this.ensureDb();

    db.prepare(
      'UPDATE watchdog_alerts SET resolved_at = ? WHERE kind = ? AND provider_id IS ? AND resolved_at IS NULL',
    ).run(Date.now(), kind, providerId);
  }

  /** Resolve every open alert (used when all providers are fresh again). */
  resolveAllOpenWatchdogAlerts(): void {
    const db = this.ensureDb();

    db.prepare('UPDATE watchdog_alerts SET resolved_at = ? WHERE resolved_at IS NULL').run(
      Date.now(),
    );
  }
}
