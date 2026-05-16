import { config } from '../config.js';
import { Provider } from '../provider.js';
import type { ProviderAdapter } from '../types.js';
import { WindowsAgg } from '../windows-agg.js';

const FETCH_TIMEOUT_MS = 5_000;
const GO_USAGE_URL = 'https://opencode.ai/workspace';
const GO_PLAN_NAME = 'Go Plan';
const SESSION_REDIRECT_MARKER = 'window.location="/auth/authorize"';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

export class OpenCodeGo implements ProviderAdapter {
  id = 'opencode-go';
  name = 'OpenCode Go';

  async fetchUsage(): Promise<Provider> {
    const sessionCookie = config.openCodeGoSessionCookie;
    const workspaceId = config.openCodeGoWorkspaceId;

    if (!(sessionCookie && workspaceId)) {
      return new Provider(this.id, this.name, 'Not configured', []);
    }

    const html = await this.fetchHtml(sessionCookie, workspaceId);

    if (html.includes(SESSION_REDIRECT_MARKER)) {
      throw new Error('Session expired, re-authenticate required');
    }

    return Provider.fromAdapter(this.id, this.name, GO_PLAN_NAME, WindowsAgg.from(html));
  }

  private async fetchHtml(cookie: string, wsId: string): Promise<string> {
    const payload = {
      headers: {
        cookie: `auth=${cookie}`,
        'user-agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    };

    const response = await fetch(`${GO_USAGE_URL}/${wsId}/go`, payload);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.text();
  }
}
