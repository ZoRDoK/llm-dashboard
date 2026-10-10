/**
 * Small persistence helpers for session tokens/cookies kept under `data/`.
 *
 * Files are written best-effort: a failed write logs and does not interrupt
 * the fetch flow — the value is still used in memory for this run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { createLogger } from './logger.js';

const log = createLogger('data');

/**
 * Read a persisted value, or fall back to the env-provided one.
 * The fallback applies only when the file is missing — an existing but empty
 * file intentionally returns null (the caller then re-bootstraps via CDP).
 */
export function readDataFile(path: string, fallback?: string): string | null {
  if (existsSync(path)) {
    return readFileSync(path, 'utf-8').trim() || null;
  }

  return fallback ?? null;
}

/** Persist a value, creating the parent directory. Logs on failure. */
export function writeDataFile(path: string, value: string, label: string): void {
  try {
    const dir = path.slice(0, path.lastIndexOf('/'));

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(path, value, 'utf-8');
  } catch (err) {
    log.error({ path, label, err }, 'Failed to persist data file');
  }
}
