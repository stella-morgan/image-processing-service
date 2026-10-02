import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 85 },
    },
  },
});
