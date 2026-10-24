import { describe, expect, it } from 'vitest';
import { renderLoginPage } from '../../src/html/login-page.js';

const COMMAND =
  'google-chrome --user-data-dir=/tmp/profile --remote-debugging-port=9341 https://opencode.ai/console';

describe('renderLoginPage', () => {
  it('shows the sign-in instruction, live status polling and the collapsed fallback', () => {
    const html = renderLoginPage({
      providerId: 'opencode-go',
      providerName: 'OpenCode Go',
      ok: true,
      error: null,
      command: COMMAND,
    });

    expect(html).toContain('Chrome window opened — sign in with Google');
    expect(html).toContain('OpenCode Go');
    expect(html).toContain('id="session-status"');
    expect(html).toContain('/api/providers');
    expect(html).toContain('href="/"');
    expect(html).toContain('<details>');
    expect(html).toContain('google-chrome --user-data-dir=/tmp/profile');
    expect(html).not.toContain('Could not open the window');
  });

  it('polls the status for the requested provider id only', () => {
    const html = renderLoginPage({
      providerId: 'opencode-go-2',
      providerName: 'OpenCode Go 2',
      ok: true,
      error: null,
      command: COMMAND,
    });

    expect(html).toContain('const providerId = "opencode-go-2";');
  });

  it('reports a launch failure honestly and keeps the fallback command', () => {
    const html = renderLoginPage({
      providerId: 'opencode-go',
      providerName: 'OpenCode Go',
      ok: false,
      error: 'No graphical session available to the service (DISPLAY/WAYLAND_DISPLAY missing).',
      command: COMMAND,
    });

    expect(html).toContain('Could not open the window');
    expect(html).toContain('No graphical session available');
    expect(html).toContain('google-chrome --user-data-dir=/tmp/profile');
    expect(html).not.toContain('id="session-status"');
  });

  it('escapes an error message instead of injecting markup', () => {
    const html = renderLoginPage({
      providerId: 'opencode-go',
      providerName: 'OpenCode Go',
      ok: false,
      error: '<script>alert(1)</script>',
      command: COMMAND,
    });

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
