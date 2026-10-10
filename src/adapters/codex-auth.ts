import { createLogger } from '../logger.js';
import {
  type AuthFile,
  AuthJsonStore,
  applyRefreshResponse,
  type BaseAuthEntry,
  expandHome,
  isFresh,
  type RefreshResponse,
} from './auth-json.js';

const log = createLogger('adapter:codex');

const AUTH0_TOKEN_URL = 'https://auth0.openai.com/oauth/token';

interface OpenCodeAuthEntry extends BaseAuthEntry {
  type: string;
  accountId?: string;
}

/** auth.json keys that may hold the OpenAI/Codex OAuth entry, in priority order. */
const ENTRY_KEYS = ['openai-codex', 'openai'] as const;

function decodeClientId(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

  return payload.client_id;
}

export class CodexAuth {
  private cached: OpenCodeAuthEntry | null = null;
  private readonly store: AuthJsonStore;

  /**
   * @param authJsonPaths — Priority-ordered list of auth.json file paths to search.
   *                        Defaults to OpenCode and Pi standard paths.
   */
  constructor(authJsonPaths?: string[]) {
    this.store = new AuthJsonStore(authJsonPaths, [
      expandHome('~/.pi/agent/auth.json'),
      expandHome('~/.local/share/opencode/auth.json'),
    ]);
  }

  /**
   * Get a valid access token.
   *
   * Returns the in-memory cached token if it's still fresh.
   * Otherwise loads from auth.json files and refreshes if expired.
   */
  async getToken(): Promise<string> {
    if (this.cached && isFresh(this.cached)) {
      return this.cached.access;
    }

    for (const auth of this.store.loadAll()) {
      const entry = readEntry(auth);

      if (!entry) {
        continue;
      }

      this.cached = entry;

      if (!isFresh(entry)) {
        try {
          this.cached = await this.refresh(entry, auth);
        } catch (err) {
          log.debug({ err }, 'Codex token refresh failed, trying next auth entry');

          continue;
        }
      }

      return this.cached.access;
    }

    throw new Error('No OpenAI auth entry found in auth.json');
  }

  /** Clear the in-memory cache so the next getToken() re-loads from file. */
  clearCache(): void {
    this.cached = null;
  }

  /** Refresh the access token via Auth0 and persist back to auth.json. */
  private async refresh(entry: OpenCodeAuthEntry, auth: AuthFile): Promise<OpenCodeAuthEntry> {
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

    const updated = applyRefreshResponse(entry, data);

    this.store.persist(updated, auth, ENTRY_KEYS);

    return updated;
  }
}

/** Read the first present OpenAI/Codex entry from an auth.json object. */
function readEntry(auth: AuthFile): OpenCodeAuthEntry | null {
  for (const key of ENTRY_KEYS) {
    const entry = auth[key] as OpenCodeAuthEntry | undefined;

    if (entry) {
      return entry;
    }
  }

  return null;
}
