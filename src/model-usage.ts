import type { UsageWindow } from './usage-window.js';

export interface ModelUsage {
  readonly modelName: string;
  readonly windows: UsageWindow[];
}
