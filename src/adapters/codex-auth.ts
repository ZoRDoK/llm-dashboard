import { readFileSync, writeFileSync } from 'node:fs';

const AUTH0_TOKEN_URL = 'https://auth0.openai.com/oauth/token';

interface OpenCodeAuthEntry {
  type: string;
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

interface OpenCodeAuth {
  openai?: OpenCodeAuthEntry;
  'openai-codex'?: OpenCodeAuthEntry;
  [key: string]: unknown;
}

interface RefreshResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  refresh_token?: string;
}

const FRESHNESS_BUFFER_MS = 60_000;
const MS_PER_SECOND = 1_000;

function decodeClientId(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

  return payload.client_id;
}

function expandHome(path: string): string {
  if (path.startsWith('~/') && process.env.HOME) {
    return `${process.env.HOME}/${path.slice(2)}`;
  }

  return path;
}

export class CodexAuth {
  private cached: OpenCodeAuthEntry | null = null;
  private paths: string[];

  /**
   * @param authJsonPaths — Priority-ordered list of auth.json file paths to search.
   *                        Defaults to OpenCode and Pi standard paths.
   */
  constructor(authJsonPaths?: string[]) {
    this.paths = authJsonPaths ?? [
      expandHome('~/.local/share/opencode/auth.json'),
      expandHome('~/.pi/agent/auth.json'),
    ];
  }

  /**
   * Get a valid access token.
   *
   * Returns the in-memory cached token if it's still fresh.
   * Otherwise loads from auth.json files and refreshes if expired.
   */
  async getToken(): Promise<string> {
    if (this.cached && this.isFresh(this.cached)) {
      return this.cached.access;
    }

    const auth = this.loadAuth();
    const entry = auth?.openai ?? auth?.['openai-codex'];

    if (!entry) {
      throw new Error('No OpenAI auth entry found in auth.json');
    }

    this.cached = entry;

    if (!this.isFresh(entry) && auth) {
      this.cached = await this.refresh(entry, auth);
    }

    return this.cached.access;
  }

  /** Check whether the access token is still valid (expires in 60+ seconds). */
  private isFresh(entry: OpenCodeAuthEntry): boolean {
    return Date.now() + FRESHNESS_BUFFER_MS < entry.expires;
  }

  /** Clear the in-memory cache so the next getToken() re-loads from file. */
  clearCache(): void {
    this.cached = null;
  }

  /** Try each auth.json path and return the first valid one. */
  private loadAuth(): OpenCodeAuth | null {
    for (const path of this.paths) {
      try {
        const raw = readFileSync(path, 'utf-8');

        return JSON.parse(raw);
      } catch {
        // try next path
      }
    }

    return null;
  }

  /** Refresh the access token via Auth0 and persist back to auth.json. */
  private async refresh(entry: OpenCodeAuthEntry, auth: OpenCodeAuth): Promise<OpenCodeAuthEntry> {
    const clientId = decodeClientId(entry.access);

    const payload = {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: entry.refresh,
    };

    const response = await fetch(AUTH0_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Token refresh failed: HTTP ${response.status}`);
    }

    const data = (await response.json()) as RefreshResponse;

    const updated: OpenCodeAuthEntry = {
      ...entry,
      access: data.access_token,
      expires: Date.now() + data.expires_in * MS_PER_SECOND,
      refresh: data.refresh_token ?? entry.refresh,
    };

    this.persist(updated, auth);

    return updated;
  }

  /** Persist updated token back to every auth.json file we successfully read. */
  private persist(updated: OpenCodeAuthEntry, auth: OpenCodeAuth): void {
    const written: OpenCodeAuth = { ...auth };

    for (const key of ['openai', 'openai-codex'] as const) {
      if (written[key]) {
        written[key] = updated;
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
      console.warn(
        'Token refreshed but could not persist to any auth.json:',
        writeErrors.join('; '),
      );
    }
  }
}
