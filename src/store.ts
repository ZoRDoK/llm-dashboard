/**
 * SQLite-backed persistence layer for provider cache data and billing settings.
 *
 * Uses node:sqlite (synchronous by design) — acceptable for this use case
 * because operations are small, infrequent, and run in a single-process server.
 */
import { DatabaseSync } from 'node:sqlite';
import type { Provider } from './provider.js';

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
  }

  private ensureDb(): DatabaseSync {
    if (!this.db) {
      throw new Error('Store not initialized. Call init() first.');
    }

    return this.db;
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
      .prepare('SELECT data FROM provider_cache WHERE provider_id = ?')
      .all(providerId) as { data: string }[];

    if (rows.length === 0) {
      return null;
    }

    return JSON.parse(rows[0].data);
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
    if (billingEndAt == null) {
      return;
    }

    const db = this.ensureDb();

    db.prepare(
      'INSERT OR REPLACE INTO billing_settings (provider_id, billing_end_at, updated_at) VALUES (?, ?, ?)',
    ).run(providerId, billingEndAt, Date.now());
  }
}
