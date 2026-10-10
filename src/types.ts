import type { Provider } from './provider.js';

export interface ProviderAdapter {
  id: string;
  name: string;
  fetchUsage(): Promise<Provider>;

  /** Adapters with background session timers pause them when archived. */
  stopKeepalive?(): void;
}

export interface ProviderMetrics {
  id: string;
  name: string;
  archived: boolean;
  configured: boolean;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
}

export interface LogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  providerId?: string;
}

export interface QuotaPeriod {
  providerId: string;
  providerName: string;
  periodKey: string;
  resetAt: string;
  startedAt: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  firstSampledAt: number;
  lastSampledAt: number;
  sampleCount: number;
  completed: boolean;
}
