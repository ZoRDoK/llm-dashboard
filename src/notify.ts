/**
 * Best-effort desktop notifications via notify-send.
 *
 * Watchdog login-required alerts used to live only in the dashboard, so a dead
 * console session went unnoticed for days; this is the out-of-band signal.
 * The systemd user unit runs on a desktop session, where notify-send works.
 * Every failure is swallowed with at most one warn log — a missing or
 * broken notifier must never break the caller's flow.
 */
import { spawn } from 'node:child_process';

import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('notify');

const NOTIFY_SEND = 'notify-send';
// -t 0: never auto-expire — login alerts must wait for the user.
const NEVER_EXPIRE_MS = '0';

/** Fire-and-forget desktop notification; never throws. */
export const desktopNotify = (title: string, body: string): void => {
  if (!config.DESKTOP_NOTIFY) {
    return;
  }

  try {
    const child = spawn(NOTIFY_SEND, ['-t', NEVER_EXPIRE_MS, title, body], { stdio: 'ignore' });

    // Missing binary reports ENOENT asynchronously — it must not crash.
    child.on('error', (err) => {
      log.warn({ err }, 'notify-send failed');
    });
    child.unref();
  } catch (err) {
    log.warn({ err: err instanceof Error ? err : new Error(String(err)) }, 'notify-send failed');
  }
};
