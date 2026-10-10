/**
 * Token-usage indexer for the pi coding agent.
 *
 * Walks the pi sessions directory (config.PI_SESSIONS_DIR), parses assistant
 * `usage` records out of the JSONL session logs, and caches per-file
 * day × model aggregates in SQLite (data/cache.sqlite, shared with
 * ProviderStore — WAL mode allows concurrent connections).
 *
 * Scanning is incremental: a file is re-parsed only when its (mtime, size)
 * no longer matches the cached row. `subagent-artifacts/*_transcript.jsonl`
 * duplicates are skipped to avoid double counting.
 */
import type { Dirent, Stats } from 'node:fs';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { config } from './config.js';
import { MS_PER_DAY, MS_PER_MINUTE } from './constants.js';
import { createLogger } from './logger.js';

const log = createLogger('pi-usage');

// ── Constants ───────────────────────────────────────────────

const DEFAULT_DB_PATH = 'data/cache.sqlite';
const RESCAN_INTERVAL_MINUTES = 10;
const RESCAN_STALE_MINUTES = 5;
const RESCAN_INTERVAL_MS = RESCAN_INTERVAL_MINUTES * MS_PER_MINUTE;
const RESCAN_STALE_MS = RESCAN_STALE_MINUTES * MS_PER_MINUTE;
const FILES_PER_TICK = 4;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UNKNOWN_MODEL = 'unknown/unknown';
const UNKNOWN_PROVIDER = 'unknown';
const SKIP_DIR_NAME = 'subagent-artifacts';
const SESSION_FILE_SUFFIX = '.jsonl';
const KEY_SEPARATOR = '\u0000';
const TOP_MODELS = 15;
const TOP_PROJECTS = 10;
const MAX_DAY_BUCKETS = 120;
const DAYS_PER_WEEK = 7;
const DAYS_FROM_MONDAY = 6;
/** Slug prefix of sessions run under ~/home/<user>/dev/projects — stripped for display names. */
export const PI_PROJECT_HOME_PREFIX = 'home-slava-dev-projects-';

// ── Types ───────────────────────────────────────────────────

/** Token buckets summed over assistant API calls. */
interface PiTokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  calls: number;
  sessions: number;
  models: number;
}

export interface PiDayBucket {
  day: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface PiModelRow {
  model: string;
  provider: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  calls: number;
  share: number;
}

export interface PiProviderRow {
  provider: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  calls: number;
}

export interface PiProjectRow {
  project: string;
  total: number;
  sessions: number;
}

interface PiUsageStatus {
  running: boolean;
  /** Files visited so far in the current (or last) scan. */
  scanned: number;
  /** Files discovered by the current (or last) walk. */
  total: number;
  /** Files actually re-parsed in the current (or last) scan. */
  parsed: number;
  lastScanAt: number | null;
  error: string | null;
}

export interface PiUsageStats {
  totals: PiTokenTotals;
  allTimeTotals: PiTokenTotals;
  byDay: PiDayBucket[];
  byModel: PiModelRow[];
  byProvider: PiProviderRow[];
  byProject: PiProjectRow[];
  status: PiUsageStatus;
}

type PiUsageRange = number | 'all';

interface PiUsageIndexOptions {
  dbPath?: string;
  sessionsDir?: string;
}

// Internal parsing shapes.

interface PiMessageRecord {
  type?: string;
  timestamp?: unknown;
  message?: {
    role?: string;
    provider?: string;
    model?: string;
    usage?: unknown;
  };
}

interface DayModelCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  calls: number;
}

interface ParsedFile {
  startedAt: number;
  counts: Map<string, DayModelCounts>;
}

// Raw snake_case row shapes returned by the pi_* tables.
interface PiFileDbRow {
  path: string;
  mtime: number;
  size: number;
}

interface PiSumDbRow {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  calls: number | null;
}

interface PiCountDbRow {
  n: number | null;
}

interface PiDayDbRow {
  day: string;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
}

interface PiModelDbRow {
  model: string;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  calls: number | null;
}

interface PiProjectDbRow {
  project: string;
  sessions: number | null;
  total: number | null;
}

// ── Small helpers ───────────────────────────────────────────

/** Expand a leading `~` to the user's home directory. */
const expandHome = (dir: string): string => {
  return dir.startsWith('~') ? join(homedir(), dir.slice(1)) : dir;
};

/** Yield to the event loop between file batches so scans never block requests. */
const yieldToLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** List directory entries; null when the directory is unreadable. */
function listDir(dir: string): Dirent[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch {
    return null;
  }
}

interface WalkState {
  files: string[];
  pending: string[];
}

/** Queue subdirectories (except artifacts) and record session files. */
function handleEntry(entry: Dirent, dir: string, root: string, state: WalkState): void {
  const entryPath = join(dir, entry.name);

  if (entry.isDirectory()) {
    if (entry.name !== SKIP_DIR_NAME) {
      state.pending.push(entryPath);
    }

    return;
  }

  const isSession = entry.isFile() && entry.name.endsWith(SESSION_FILE_SUFFIX);

  if (isSession) {
    state.files.push(relative(root, entryPath));
  }
}

/** Recursively collect `*.jsonl` session files, skipping `subagent-artifacts` subtrees. */
function collectSessionFiles(root: string): string[] {
  const state: WalkState = { files: [], pending: [root] };

  while (state.pending.length > 0) {
    const current = state.pending.pop();

    if (current === undefined) {
      break;
    }

    const entries = listDir(current);

    if (entries === null) {
      continue;
    }

    for (const entry of entries) {
      handleEntry(entry, current, root, state);
    }
  }

  return state.files;
}

/** Top-level directory of the session path with the `--` wrapping stripped. */
function projectLabel(relPath: string): string {
  const raw = relPath.split(sep)[0] ?? '';

  return raw.replace(/^-+/, '').replace(/-+$/, '');
}

/** Extract one assistant usage record; null when the line is not a counted message. */
function parseUsageRecord(
  line: string,
): { day: string; model: string; usage: Record<string, unknown> } | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    log.debug('pi-usage: skipping malformed JSONL line');

    return null;
  }

  const record = parsed as PiMessageRecord;
  const message = record.message;

  if (record.type !== 'message' || message?.role !== 'assistant') {
    return null;
  }

  if (typeof message.usage !== 'object' || message.usage === null) {
    return null;
  }

  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : '';

  if (!DAY_PATTERN.test(timestamp.slice(0, 10))) {
    return null;
  }

  const provider =
    message.provider == null || message.provider === '' ? UNKNOWN_PROVIDER : message.provider;
  const model = message.model == null || message.model === '' ? UNKNOWN_MODEL : message.model;

  return {
    day: timestamp.slice(0, 10),
    model: `${provider}/${model}`,
    usage: message.usage as Record<string, unknown>,
  };
}

const usageNumber = (usage: Record<string, unknown>, key: string): number => {
  const value = usage[key];

  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

/** Session start timestamp from the first (`session`) line, falling back to file mtime. */
function sessionStartedAt(raw: string, fallbackMs: number): number {
  const newlineAt = raw.indexOf('\n');
  const firstLine = newlineAt === -1 ? raw : raw.slice(0, newlineAt);

  try {
    const head = JSON.parse(firstLine) as { type?: string; timestamp?: string };

    if (head.type === 'session' && typeof head.timestamp === 'string') {
      const parsed = Date.parse(head.timestamp);

      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  } catch {
    // Malformed header — mtime fallback below is good enough.
    log.debug('pi-usage: unparseable session header, using file mtime');
  }

  return fallbackMs;
}

/** Parse one session file into per-(day, model) token counts. */
function parseSessionFile(absPath: string, fallbackMs: number): ParsedFile {
  const raw = readFileSync(absPath, 'utf-8');
  const counts = new Map<string, DayModelCounts>();
  const startedAt = sessionStartedAt(raw, fallbackMs);

  for (const line of raw.split('\n')) {
    // Cheap pre-filter: counted records always embed a "usage" object.
    if (!line.includes('"usage"')) {
      continue;
    }

    const record = parseUsageRecord(line);

    if (record === null) {
      continue;
    }

    const key = `${record.day}${KEY_SEPARATOR}${record.model}`;
    const acc = counts.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };

    acc.input += usageNumber(record.usage, 'input');
    acc.output += usageNumber(record.usage, 'output');
    acc.cacheRead += usageNumber(record.usage, 'cacheRead');
    acc.cacheWrite += usageNumber(record.usage, 'cacheWrite');
    acc.calls += 1;

    counts.set(key, acc);
  }

  return { startedAt, counts };
}

/** ISO Monday of the week containing `day` — label for weekly-aggregated buckets. */
function mondayOf(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  const daysSinceMonday = (date.getUTCDay() + DAYS_FROM_MONDAY) % DAYS_PER_WEEK;

  date.setUTCDate(date.getUTCDate() - daysSinceMonday);

  return date.toISOString().slice(0, 10);
}

/** Collapse daily buckets into ISO-week buckets (label = Monday date). */
function weeklyBuckets(buckets: PiDayBucket[]): PiDayBucket[] {
  const weeks = new Map<string, PiDayBucket>();

  for (const bucket of buckets) {
    const week = mondayOf(bucket.day);
    const acc = weeks.get(week) ?? {
      day: week,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    };

    acc.input += bucket.input;
    acc.output += bucket.output;
    acc.cacheRead += bucket.cacheRead;
    acc.cacheWrite += bucket.cacheWrite;
    acc.total += bucket.total;

    weeks.set(week, acc);
  }

  return [...weeks.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Cutoff ISO day (inclusive) for a numeric range; null means "all time". */
function rangeCutoffDay(rangeDays: PiUsageRange): string | null {
  if (rangeDays === 'all') {
    return null;
  }

  const cutoffMs = Date.now() - rangeDays * MS_PER_DAY;

  return new Date(cutoffMs).toISOString().slice(0, 10);
}

const totalOf = (row: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}): number => {
  return row.input + row.output + row.cacheRead + row.cacheWrite;
};

/** Keep the top N model rows and fold the rest into a single `other` row. */
function topModelRows(rows: PiModelRow[]): PiModelRow[] {
  if (rows.length <= TOP_MODELS) {
    return rows;
  }

  const head = rows.slice(0, TOP_MODELS);
  const tail = rows.slice(TOP_MODELS);
  const other: PiModelRow = {
    model: 'other',
    provider: 'other',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    calls: 0,
    share: 0,
  };

  for (const row of tail) {
    other.input += row.input;
    other.output += row.output;
    other.cacheRead += row.cacheRead;
    other.cacheWrite += row.cacheWrite;
    other.total += row.total;
    other.calls += row.calls;
    other.share += row.share;
  }

  return [...head, other];
}

/** Roll full model rows up to provider (part before `/`) rows, sorted by total desc. */
function rollupProviders(rows: PiModelRow[]): PiProviderRow[] {
  const providers = new Map<string, PiProviderRow>();

  for (const row of rows) {
    const acc = providers.get(row.provider) ?? {
      provider: row.provider,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      calls: 0,
    };

    acc.input += row.input;
    acc.output += row.output;
    acc.cacheRead += row.cacheRead;
    acc.cacheWrite += row.cacheWrite;
    acc.total += row.total;
    acc.calls += row.calls;

    providers.set(row.provider, acc);
  }

  return [...providers.values()].sort((a, b) => b.total - a.total);
}

// ── Index ───────────────────────────────────────────────────

export class PiUsageIndex {
  private db: DatabaseSync | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private readonly dbPath: string;
  private readonly sessionsDir: string;
  private running = false;
  private scanned = 0;
  private total = 0;
  private parsed = 0;
  private lastScanAt: number | null = null;
  private lastError: string | null = null;

  constructor(opts: PiUsageIndexOptions = {}) {
    this.dbPath = opts.dbPath ?? DEFAULT_DB_PATH;
    this.sessionsDir = expandHome(opts.sessionsDir ?? config.PI_SESSIONS_DIR);
  }

  /** Open the cache DB and create tables if needed. Idempotent. */
  init(): void {
    if (this.db !== null) {
      return;
    }

    const parentDir = dirname(this.dbPath);

    if (parentDir !== '.' && parentDir !== '') {
      mkdirSync(parentDir, { recursive: true });
    }

    this.db = new DatabaseSync(this.dbPath);

    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pi_files (
        path TEXT PRIMARY KEY,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        project TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        parsed_at INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pi_daily (
        path TEXT NOT NULL,
        day TEXT NOT NULL,
        model TEXT NOT NULL,
        input INTEGER NOT NULL,
        output INTEGER NOT NULL,
        cache_read INTEGER NOT NULL,
        cache_write INTEGER NOT NULL,
        calls INTEGER NOT NULL,
        PRIMARY KEY (path, day, model)
      )
    `);
  }

  /** Initial scan, then a rescan every RESCAN_INTERVAL_MS. */
  start(): void {
    this.init();

    void this.scan();

    this.rescanTimer = setInterval(() => {
      void this.scan();
    }, RESCAN_INTERVAL_MS);

    this.rescanTimer.unref();
  }

  /** Stop the rescan timer and close the DB. */
  stop(): void {
    if (this.rescanTimer !== null) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = null;
    }

    if (this.db !== null) {
      this.db.close();
      this.db = null;
    }
  }

  /** Fire-and-forget rescan used by route handlers once the last scan is stale. */
  rescanIfStale(): void {
    if (this.running) {
      return;
    }

    const isStale = this.lastScanAt === null || Date.now() - this.lastScanAt > RESCAN_STALE_MS;

    if (isStale) {
      void this.scan();
    }
  }

  /** Walk the sessions dir and update the cache; concurrent invocations are ignored. */
  async scan(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.lastError = null;
    this.parsed = 0;

    try {
      await this.walkAndIndex();
      this.lastScanAt = Date.now();

      log.info(
        { scanned: this.scanned, total: this.total, parsed: this.parsed },
        'pi-usage: scan complete',
      );
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      log.warn({ err }, 'pi-usage: scan failed');
    } finally {
      this.running = false;
    }
  }

  getStatus(): PiUsageStatus {
    return {
      running: this.running,
      scanned: this.scanned,
      total: this.total,
      parsed: this.parsed,
      lastScanAt: this.lastScanAt,
      error: this.lastError,
    };
  }

  /** Aggregate token stats for the requested range (days) or 'all'. */
  getStats(rangeDays: PiUsageRange): PiUsageStats {
    this.init();

    const cutoffDay = rangeCutoffDay(rangeDays);
    const modelRows = this.modelRows(cutoffDay);

    return {
      totals: this.totalsFor(cutoffDay),
      allTimeTotals: this.totalsFor(null),
      byDay: this.dayBuckets(cutoffDay),
      byModel: topModelRows(modelRows),
      byProvider: rollupProviders(modelRows),
      byProject: this.projectRows(cutoffDay),
      status: this.getStatus(),
    };
  }

  // ── Internals ─────────────────────────────────────────────

  private ensureDb(): DatabaseSync {
    this.init();

    if (this.db === null) {
      throw new Error('pi-usage store not initialized');
    }

    return this.db;
  }

  private async walkAndIndex(): Promise<void> {
    try {
      statSync(this.sessionsDir);
    } catch {
      this.lastError = `sessions dir not readable: ${this.sessionsDir}`;

      log.warn({ dir: this.sessionsDir }, 'pi-usage: sessions dir not readable');

      return;
    }

    const db = this.ensureDb();
    const files = collectSessionFiles(this.sessionsDir);

    this.scanned = 0;
    this.total = files.length;

    const rows = db
      .prepare('SELECT path, mtime, size FROM pi_files')
      .all() as unknown as PiFileDbRow[];
    const cached = new Map(rows.map((row) => [row.path, row]));

    let batch = 0;

    for (const relPath of files) {
      const absPath = join(this.sessionsDir, relPath);

      let stat: Stats;

      try {
        stat = statSync(absPath);
      } catch (err) {
        log.debug({ path: relPath, err }, 'pi-usage: stat failed');

        continue;
      }

      const row = cached.get(relPath);
      const isUnchanged = row !== undefined && row.mtime === stat.mtimeMs && row.size === stat.size;

      if (!isUnchanged && this.refreshFile(relPath, absPath, stat)) {
        this.parsed += 1;
      }

      this.scanned += 1;
      batch += 1;

      if (batch >= FILES_PER_TICK) {
        batch = 0;

        await yieldToLoop();
      }
    }

    this.pruneDeleted(files);
  }

  /** Parse and persist one file; returns false when indexing failed (logged). */
  private refreshFile(relPath: string, absPath: string, stat: Stats): boolean {
    try {
      const parsed = parseSessionFile(absPath, stat.mtimeMs);

      this.persistFile(relPath, stat.mtimeMs, stat.size, parsed);

      return true;
    } catch (err) {
      log.warn({ path: relPath, err }, 'pi-usage: failed to index session file');

      return false;
    }
  }

  private persistFile(relPath: string, mtimeMs: number, size: number, parsed: ParsedFile): void {
    const db = this.ensureDb();

    db.exec('BEGIN');

    try {
      db.prepare('DELETE FROM pi_daily WHERE path = ?').run(relPath);
      db.prepare(
        'INSERT OR REPLACE INTO pi_files (path, mtime, size, project, started_at, parsed_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(relPath, mtimeMs, size, projectLabel(relPath), parsed.startedAt, Date.now());

      const insert = db.prepare(
        'INSERT INTO pi_daily (path, day, model, input, output, cache_read, cache_write, calls) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );

      for (const [key, counts] of parsed.counts) {
        const separatorAt = key.indexOf(KEY_SEPARATOR);
        const day = key.slice(0, separatorAt);
        const model = key.slice(separatorAt + KEY_SEPARATOR.length);

        insert.run(
          relPath,
          day,
          model,
          counts.input,
          counts.output,
          counts.cacheRead,
          counts.cacheWrite,
          counts.calls,
        );
      }

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');

      throw err;
    }
  }

  /** Drop cache rows for session files that no longer exist. */
  private pruneDeleted(keepPaths: string[]): void {
    const db = this.ensureDb();
    const keep = new Set(keepPaths);
    const rows = db.prepare('SELECT path FROM pi_files').all() as unknown as PiFileDbRow[];

    for (const row of rows) {
      if (!keep.has(row.path)) {
        db.prepare('DELETE FROM pi_files WHERE path = ?').run(row.path);
        db.prepare('DELETE FROM pi_daily WHERE path = ?').run(row.path);
      }
    }
  }

  private totalsFor(cutoffDay: string | null): PiTokenTotals {
    const db = this.ensureDb();
    const dayFilter = cutoffDay === null ? '' : ' WHERE day >= ?';
    const dayParams = cutoffDay === null ? [] : [cutoffDay];

    const sums = db
      .prepare(
        `SELECT COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output,
         COALESCE(SUM(cache_read), 0) AS cache_read, COALESCE(SUM(cache_write), 0) AS cache_write,
         COALESCE(SUM(calls), 0) AS calls FROM pi_daily${dayFilter}`,
      )
      .get(...dayParams) as unknown as PiSumDbRow;

    const modelCount = db
      .prepare(`SELECT COUNT(DISTINCT model) AS n FROM pi_daily${dayFilter}`)
      .get(...dayParams) as unknown as PiCountDbRow;

    const sessionFilter = cutoffDay === null ? '' : ' WHERE started_at >= ?';
    const sessionParams = cutoffDay === null ? [] : [Date.parse(`${cutoffDay}T00:00:00.000Z`)];

    const sessionCount = db
      .prepare(`SELECT COUNT(*) AS n FROM pi_files${sessionFilter}`)
      .get(...sessionParams) as unknown as PiCountDbRow;

    const input = sums.input ?? 0;
    const output = sums.output ?? 0;
    const cacheRead = sums.cache_read ?? 0;
    const cacheWrite = sums.cache_write ?? 0;

    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      total: input + output + cacheRead + cacheWrite,
      calls: sums.calls ?? 0,
      sessions: sessionCount.n ?? 0,
      models: modelCount.n ?? 0,
    };
  }

  private dayBuckets(cutoffDay: string | null): PiDayBucket[] {
    const db = this.ensureDb();
    const dayFilter = cutoffDay === null ? '' : ' WHERE day >= ?';
    const dayParams = cutoffDay === null ? [] : [cutoffDay];

    const rows = db
      .prepare(
        `SELECT day, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read,
         SUM(cache_write) AS cache_write FROM pi_daily${dayFilter} GROUP BY day ORDER BY day`,
      )
      .all(...dayParams) as unknown as PiDayDbRow[];

    const buckets = rows.map((row) => {
      const bucket: PiDayBucket = {
        day: row.day,
        input: row.input ?? 0,
        output: row.output ?? 0,
        cacheRead: row.cache_read ?? 0,
        cacheWrite: row.cache_write ?? 0,
        total: 0,
      };

      bucket.total = totalOf(bucket);

      return bucket;
    });

    // Very long ranges collapse to ISO weeks so charts stay readable.
    if (buckets.length > MAX_DAY_BUCKETS) {
      return weeklyBuckets(buckets);
    }

    return buckets;
  }

  private modelRows(cutoffDay: string | null): PiModelRow[] {
    const db = this.ensureDb();
    const dayFilter = cutoffDay === null ? '' : ' WHERE day >= ?';
    const dayParams = cutoffDay === null ? [] : [cutoffDay];

    const rows = db
      .prepare(
        `SELECT model, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read,
         SUM(cache_write) AS cache_write, SUM(calls) AS calls FROM pi_daily${dayFilter}
         GROUP BY model ORDER BY (input + output + cache_read + cache_write) DESC`,
      )
      .all(...dayParams) as unknown as PiModelDbRow[];

    const mapped = rows.map((row) => {
      const base = {
        input: row.input ?? 0,
        output: row.output ?? 0,
        cacheRead: row.cache_read ?? 0,
        cacheWrite: row.cache_write ?? 0,
      };

      return {
        model: row.model,
        provider: row.model.split('/')[0] ?? UNKNOWN_PROVIDER,
        input: base.input,
        output: base.output,
        cacheRead: base.cacheRead,
        cacheWrite: base.cacheWrite,
        total: totalOf(base),
        calls: row.calls ?? 0,
        share: 0,
      };
    });

    const grandTotal = mapped.reduce((sum, row) => sum + row.total, 0);

    for (const row of mapped) {
      row.share = grandTotal > 0 ? row.total / grandTotal : 0;
    }

    return mapped;
  }

  private projectRows(cutoffDay: string | null): PiProjectRow[] {
    const db = this.ensureDb();
    const dayFilter = cutoffDay === null ? '' : ' WHERE d.day >= ?';
    const dayParams = cutoffDay === null ? [] : [cutoffDay];

    const rows = db
      .prepare(
        `SELECT f.project AS project, COUNT(DISTINCT f.path) AS sessions,
         SUM(d.input + d.output + d.cache_read + d.cache_write) AS total
         FROM pi_files f JOIN pi_daily d ON d.path = f.path${dayFilter}
         GROUP BY f.project ORDER BY total DESC LIMIT ${TOP_PROJECTS}`,
      )
      .all(...dayParams) as unknown as PiProjectDbRow[];

    return rows.map((row) => ({
      project: row.project,
      total: row.total ?? 0,
      sessions: row.sessions ?? 0,
    }));
  }
}
