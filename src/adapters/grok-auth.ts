import {
  type AuthFile,
  AuthJsonClient,
  applyRefreshResponse,
  type BaseAuthEntry,
  expandHome,
  type RefreshResponse,
} from './auth-json.js';

const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

interface XaiAuthEntry extends BaseAuthEntry {
  type: string;
  tokenEndpoint: string;
  tokenType: string;
}

export class GrokAuth extends AuthJsonClient<XaiAuthEntry> {
  constructor(authJsonPaths?: string[]) {
    super(authJsonPaths, [expandHome('~/.pi/agent/auth.json')]);
  }

  protected entryKey(): string {
    return 'xai-auth';
  }

  protected label(): string {
    return 'xAI';
  }

  protected async refreshEntry(entry: XaiAuthEntry, auth: AuthFile): Promise<XaiAuthEntry> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: entry.refresh,
    });

    const response = await fetch(entry.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(`xAI token refresh failed: HTTP ${response.status}`);
    }

    const data = (await response.json()) as RefreshResponse;

    const updated = applyRefreshResponse(entry, data);

    this.store.persist(updated, auth, ['xai-auth']);

    return updated;
  }
}
