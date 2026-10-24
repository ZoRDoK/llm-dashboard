/** Small result page for the manual OpenCode Go sign-in flow. */

import { escapeHtml } from './usage-renderers.js';

interface LoginPageInput {
  providerId: string;
  providerName: string;
  ok: boolean;
  error: string | null;
  /** Manual fallback command, shown collapsed. */
  command: string;
}

const REFRESH_INTERVAL_MS = 5_000;
const FRESH_WINDOW_MS = 3 * 60_000;

/**
 * The page keeps polling /api/providers so the operator sees the card turn
 * fresh right after the Google sign-in completes in the Chrome window.
 */
function statusScript(providerId: string): string {
  return `<script>
  const providerId = ${JSON.stringify(providerId)};
  const freshWindowMs = ${FRESH_WINDOW_MS};

  async function checkStatus() {
    try {
      const response = await fetch("/api/providers", { cache: "no-store" });
      const data = await response.json();
      const provider = (data.providers || []).find((item) => item.id === providerId);
      const status = document.getElementById("session-status");

      if (!provider || !status) {
        return;
      }

      const age = provider.updatedAt ? Date.now() - provider.updatedAt : Infinity;
      const isFresh = age < freshWindowMs && !provider.error && !provider.stale;

      status.textContent = isFresh
        ? "Session active — the dashboard card is updating."
        : "Waiting for the Google sign-in to finish…";
      status.className = isFresh ? "status ok" : "status waiting";
    } catch {
      // keep the last shown status on transient failures
    }
  }

  checkStatus();
  setInterval(checkStatus, ${REFRESH_INTERVAL_MS});
</script>`;
}

export function renderLoginPage(input: LoginPageInput): string {
  const title = input.ok ? 'Chrome window opened' : 'Could not open the Chrome window';
  const heading = input.ok
    ? 'Chrome window opened — sign in with Google'
    : 'Could not open the window';
  const body = input.ok
    ? `<p>Sign in to <strong>${escapeHtml(input.providerName)}</strong> in the opened Chrome
        window via Google. The session is picked up automatically — no refresh needed.</p>
        <p id="session-status" class="status waiting">Waiting for sign-in…</p>`
    : `<p class="error">${escapeHtml(input.error ?? 'Unknown error')}</p>
        <p>Check that a graphical session is available to the service, then retry.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    :root { color-scheme: dark; }
    body { font-family: system-ui, sans-serif; background: #10131a; color: #e6e9ef; margin: 0; padding: 48px 16px; }
    main { max-width: 560px; margin: 0 auto; background: #171b24; border: 1px solid #2a3040; border-radius: 12px; padding: 24px; }
    h1 { font-size: 1.25rem; margin: 0 0 12px; }
    p { line-height: 1.5; color: #b9c0cc; }
    .error { color: #ff8b8b; }
    .status { font-weight: 600; }
    .status.waiting { color: #e6c07a; }
    .status.ok { color: #7ee2a8; }
    a.btn { display: inline-block; margin-top: 12px; color: #9ecbff; }
    details { margin-top: 20px; font-size: 0.85rem; color: #8892a4; }
    code { display: block; margin-top: 8px; padding: 8px; background: #0c0f15; border-radius: 6px; word-break: break-all; }
  </style>
</head>
<body>
  <main>
    <h1>${heading}</h1>
    ${body}
    <a class="btn" href="/">← Back to the dashboard</a>
    <details>
      <summary>Manual launch (emergency fallback)</summary>
      <code>${escapeHtml(input.command)}</code>
    </details>
  </main>
  ${input.ok ? statusScript(input.providerId) : ''}
</body>
</html>`;
}
