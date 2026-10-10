import { createLogger } from '../logger.js';
import {
  type AuthFile,
  AuthJsonClient,
  applyRefreshResponse,
  type BaseAuthEntry,
  expandHome,
  type RefreshResponse,
} from './auth-json.js';

const log = createLogger('adapter:claude');

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

// Client ID extracted from pi's anthropic OAuth module.
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

interface AnthropicAuthEntry extends BaseAuthEntry {
  type: string;
}

// Retry constants: Anthropic's OAuth endpoint may return 429 rate_limit_error
// during token refresh. We retry with exponential backoff to avoid data loss.
const RATE_LIMIT_HTTP_STATUS = 429;
const MAX_REFRESH_RETRIES = 3;
const REFRESH_RETRY_BASE_DELAY_MS = 5_000;

export class ClaudeAuth extends AuthJsonClient<AnthropicAuthEntry> {
  constructor(authJsonPaths?: string[]) {
    super(authJsonPaths, [expandHome('~/.pi/agent/auth.json')]);
  }

  protected entryKey(): string {
    return 'anthropic';
  }

  protected label(): string {
    return 'Anthropic';
  }

  protected async refreshEntry(
    entry: AnthropicAuthEntry,
    auth: AuthFile,
  ): Promise<AnthropicAuthEntry> {
    const INVALID_GRANT_ERROR =
      'Anthropic refresh token is invalid or expired – re-authentication required';

    const payload = {
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: entry.refresh,
    };

    // Try up to 1 + MAX_REFRESH_RETRIES times with exponential backoff on rate limits.
    for (let attempt = 0; attempt <= MAX_REFRESH_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = REFRESH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);

        log.warn(
          { attempt, maxAttempts: MAX_REFRESH_RETRIES, delayMs: delay },
          'Anthropic token refresh rate-limited, retrying',
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const data = (await response.json()) as RefreshResponse;

        const updated = applyRefreshResponse(entry, data);

        this.store.persist(updated, auth, ['anthropic']);

        return updated;
      }

      const bodyText = await response.text();
      const isRateLimited =
        response.status === RATE_LIMIT_HTTP_STATUS || bodyText.includes('rate_limit_error');
      const isInvalidGrant = bodyText.includes('invalid_grant');

      if (isInvalidGrant) {
        throw new Error(INVALID_GRANT_ERROR);
      }

      if (!isRateLimited) {
        throw new Error(`Anthropic token refresh failed: HTTP ${response.status}`);
      }

      // Rate limited — loop will retry (or exit if max attempts reached).
    }

    throw new Error(`Anthropic token refresh rate-limited after ${MAX_REFRESH_RETRIES} retries`);
  }
}
