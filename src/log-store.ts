import type { LogEntry } from './types.js';

const LOG_CAP = 500;
const DEFAULT_RECENT_LIMIT = 200;

export class LogStore {
  private entries: LogEntry[] = [];

  push(entry: LogEntry): void {
    this.entries.unshift(entry);

    if (this.entries.length > LOG_CAP) {
      this.entries.length = LOG_CAP;
    }
  }

  recent(limit = DEFAULT_RECENT_LIMIT): LogEntry[] {
    return this.entries.slice(0, limit);
  }
}
