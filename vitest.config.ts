import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      'tests/**/*.e2e.test.ts',
      '**/node_modules/**',
      '**/dist/**',
      '**/data/**',
      '**/reports/**',
    ],
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/store.ts',
        'src/browser-cookies.ts',
        'src/config.ts',
        'src/html/themes.ts',
        'src/types.ts',
        'src/adapters/**/*.ts',
      ],
      reporter: ['text', 'html', 'text-summary'],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
