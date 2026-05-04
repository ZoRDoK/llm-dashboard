import type { Provider } from './provider';

export interface ProviderAdapter {
  id: string;
  name: string;
  fetchUsage(): Promise<Provider>;
}
