/**
 * Shared OAuth/auth.json plumbing for adapters that refresh tokens through
 * a provider OAuth endpoint and persist entries back to auth.json files.
 *
 * Provider-specific concerns (endpoints, client IDs, retry policy, body
 * encoding) stay in the per-provider *-auth.ts modules; this module owns the
 * mechanics they all duplicate: path expansion, freshness checks, entry
 * updates, file loading, and multi-path persistence.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { MS_PER_SECOND } from '../constants.js';
import { createLogger } from '../logger.js';
import type { Provider } from '../provider.js';

const log = createLogger('adapter:auth');

/** Minimum shape every auth.json entry shares. */
export interface BaseAuthEntry {
  access: string;
  refresh: string;
  expires: number;
}

/** OAuth refresh-token response envelope shared by all providers. */
export interface RefreshResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
  refresh_token?: string;
}

/** Generic auth.json object — callers cast their provider-specific key. */
export type AuthFile = Record<string, unknown>;

/** Minimal contract the 401-retry helper needs from an auth client. */
interface AuthProvider {
  getToken(): Promise<string>;
  clearCache(): void;
}

/**
 * Standard single-file token flow shared by the single-entry providers.
 *
 * Subclasses supply the auth.json entry key, the error label, and the
 * provider-specific refresh call. Codex does NOT use this base: its
 * multi-file fallback loop has different caching/refresh semantics.
 */
export abstract class AuthJsonClient<Entry extends BaseAuthEntry> {
  private cached: Entry | null = null;
  protected readonly store: AuthJsonStore;

  constructor(paths: string[] | undefined, defaultPaths: string[]) {
    this.store = new AuthJsonStore(paths, defaultPaths);
  }

  protected abstract entryKey(): string;

  protected abstract label(): string;

  protected abstract refreshEntry(entry: Entry, auth: AuthFile): Promise<Entry>;

  async getToken(): Promise<string> {
    if (this.cached && isFresh(this.cached)) {
      return this.cached.access;
    }

    const auth = this.store.loadFirst();
    const entry = auth?.[this.entryKey()] as Entry | undefined;

    if (!(entry && auth)) {
      throw new Error(`No ${this.label()} auth entry found in auth.json`);
    }

    this.cached = entry;

    if (!isFresh(entry)) {
      this.cached = await this.refreshEntry(entry, auth);
    }

    return this.cached.access;
  }

  clearCache(): void {
    this.cached = null;
  }
}

const FRESHNESS_BUFFER_MS = 60_000;

/** Expand a leading `~/` to `$HOME`. */
export function expandHome(path: string): string {
  if (path.startsWith('~/') && process.env.HOME) {
    return `${process.env.HOME}/${path.slice(2)}`;
  }

  return path;
}

/** True when the token is still valid with a 60s safety margin. */
export function isFresh(entry: BaseAuthEntry): boolean {
  return Date.now() + FRESHNESS_BUFFER_MS < entry.expires;
}

/** Build the refreshed entry, preserving provider-specific fields via spread. */
export function applyRefreshResponse<Entry extends BaseAuthEntry>(
  entry: Entry,
  data: RefreshResponse,
): Entry {
  return {
    ...entry,
    access: data.access_token,
    expires: Date.now() + data.expires_in * MS_PER_SECOND,
    refresh: data.refresh_token ?? entry.refresh,
  };
}

/**
 * Run a provider fetch, retrying exactly once with a force-fresh token when
 * the first attempt fails with HTTP 401 and the token came from auth.json.
 *
 * Env-var tokens cannot be refreshed, so `fromAuth` guards the retry. When
 * the retry also fails, the original 401 is rethrown.
 */
export async function retryOn401(
  token: string,
  fromAuth: boolean,
  auth: AuthProvider,
  run: (token: string) => Promise<Provider>,
): Promise<Provider> {
  try {
    return await run(token);
  } catch (err) {
    if (!(fromAuth && err instanceof Error && /^HTTP 401/.test(err.message))) {
      throw err;
    }

    auth.clearCache();

    try {
      const fresh = await auth.getToken();

      return await run(fresh);
    } catch {
      // fall through to rethrow the original 401
    }

    throw err;
  }
}

/** Load and persist auth entries across the priority-ordered auth.json paths. */
export class AuthJsonStore {
  readonly paths: string[];

  constructor(paths: string[] | undefined, defaultPaths: string[]) {
    this.paths = paths ?? defaultPaths;
  }

  /** First readable auth.json file (early return), or null when none parse. */
  loadFirst(): AuthFile | null {
    for (const path of this.paths) {
      try {
        const raw = readFileSync(path, 'utf-8');

        return JSON.parse(raw);
      } catch (err) {
        log.debug({ path, err }, 'auth.json not readable, trying next path');
      }
    }

    return null;
  }

  /** Every readable auth.json file, in path priority order. */
  loadAll(): AuthFile[] {
    const results: AuthFile[] = [];

    for (const path of this.paths) {
      try {
        const raw = readFileSync(path, 'utf-8');
        results.push(JSON.parse(raw));
      } catch (err) {
        log.debug({ path, err }, 'auth.json not readable, trying next path');
      }
    }

    return results;
  }

  /**
   * Write `entry` back under every key in `entryKeys` that exists in `source`,
   * to ALL configured paths, mode 0o600, 2-space JSON + trailing newline.
   * Warns only when every write fails.
   */
  persist(entry: BaseAuthEntry, source: AuthFile, entryKeys: readonly string[]): void {
    const written: AuthFile = { ...source };

    for (const key of entryKeys) {
      if (written[key]) {
        written[key] = entry;
      }
    }

    const writeErrors: string[] = [];

    for (const path of this.paths) {
      try {
        writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`, {
          mode: 0o600,
        });
      } catch (err) {
        writeErrors.push(`${path}: ${err}`);
      }
    }

    if (writeErrors.length === this.paths.length) {
      log.warn(
        { paths: this.paths, errors: writeErrors },
        'Token refreshed but could not persist to any auth.json',
      );
    }
  }
}
