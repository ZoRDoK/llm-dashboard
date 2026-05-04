import { config } from '../config';
import { Provider } from '../provider';
import type { ProviderAdapter } from '../types';
import { UsageWindow } from '../usage-window';

const SETTINGS_URL = 'https://ollama.com/settings';
const FETCH_TIMEOUT_MS = 5_000;
const SECTION_RANGE = 1500;

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

export class OllamaCloud implements ProviderAdapter {
  id = 'ollama-cloud';
  name = 'Ollama Cloud';

  async fetchUsage(): Promise<Provider> {
    const sessionCookie = config.ollamaCloudSessionCookie;

    if (!sessionCookie) {
      return new Provider(this.id, this.name, 'Not configured', []);
    }

    const html = await this.fetchHtml(sessionCookie);
    const windows = this.parseUsageWindows(html);

    return Provider.fromAdapter(this.id, this.name, 'Cloud', windows, 'Cloud Usage');
  }

  private async fetchHtml(cookie: string): Promise<string> {
    const payload = {
      headers: {
        cookie: `__Secure-session=${cookie}`,
        'user-agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    };

    const response = await fetch(SETTINGS_URL, payload);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.text();
  }

  private parseUsageWindows(html: string): UsageWindow[] {
    const sessionData = this.parseSection(html, 'Session usage');
    const weeklyData = this.parseSection(html, 'Weekly usage');

    return [
      UsageWindow.fromSection('5h', sessionData.percent, sessionData.resetText),
      UsageWindow.fromSection('weekly', weeklyData.percent, weeklyData.resetText),
    ];
  }

  private parseSection(
    html: string,
    label: string,
  ): {
    percent: number;
    resetText: string | null;
  } {
    const idx = html.indexOf(label);

    if (idx === -1) {
      throw new Error(`Section not found: ${label}`);
    }

    const section = html.slice(idx, idx + SECTION_RANGE);
    const widthMatch = section.match(/width:\s*([\d.]+)%/);

    if (!widthMatch) {
      throw new Error(`Usage percent not found in section: ${label}`);
    }

    const resetMatch = section.match(/Resets in\s+([^<]+)/i);

    return {
      percent: Number.parseFloat(widthMatch[1]),
      resetText: resetMatch ? resetMatch[1].trim() : null,
    };
  }
}
