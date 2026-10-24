import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Starts an account's dedicated Chrome profile when the service has to show a
 * sign-in window. The unit carries the GUI session variables (Wayland/DISPLAY,
 * XDG_RUNTIME_DIR, DBUS address), so a Chrome spawned from the service becomes
 * a normal visible window of the operator's session.
 */

const CDP_START_TIMEOUT_MS = 10_000;
const CDP_POLL_INTERVAL_MS = 250;
const CDP_PROBE_TIMEOUT_MS = 1_000;

const CHROME_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome',
];

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function findChromeBinary(): string | null {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function isCdpAlive(cdpUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${cdpUrl}/json/version`, {
      signal: AbortSignal.timeout(CDP_PROBE_TIMEOUT_MS),
    });

    return response.ok;
  } catch {
    return false;
  }
}

interface ChromeLaunch {
  ok: boolean;
  error?: string;
}

/**
 * Make sure the account's Chrome profile is running and reachable over CDP.
 *
 * An already running profile is reused (Chrome refuses a second process on the
 * same user data dir). A missing one is spawned detached; if it never answers
 * on its debugging port, the caller gets the real reason instead of a silent
 * success.
 */
export async function ensureProfileChrome(
  cdpUrl: string,
  userDataDir: string,
  startUrl: string,
): Promise<ChromeLaunch> {
  if (await isCdpAlive(cdpUrl)) {
    return { ok: true };
  }

  if (!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
    return {
      ok: false,
      error: 'No graphical session available to the service (DISPLAY/WAYLAND_DISPLAY missing).',
    };
  }

  const binary = findChromeBinary();

  if (!binary) {
    return { ok: false, error: 'Chrome binary not found on this host.' };
  }

  const port = new URL(cdpUrl).port;
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    startUrl,
  ];

  const child = spawn(binary, args, { detached: true, stdio: 'ignore' });
  // An async spawn failure (EACCES, binary removed after the check) must not
  // escape as an uncaught 'error' event and take the whole service down.
  let spawnError: string | null = null;

  child.on('error', (err) => {
    spawnError = err.message;
  });
  child.unref();

  const deadline = Date.now() + CDP_START_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (spawnError) {
      return { ok: false, error: `Chrome spawn failed: ${spawnError}` };
    }

    if (await isCdpAlive(cdpUrl)) {
      return { ok: true };
    }

    await sleep(CDP_POLL_INTERVAL_MS);
  }

  return {
    ok: false,
    error: `Chrome started but its debugging port ${port} did not answer within ${CDP_START_TIMEOUT_MS / 1000}s.`,
  };
}
