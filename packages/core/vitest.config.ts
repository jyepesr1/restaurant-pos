import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Property tests run through thousands of random cases; with coverage on, on the CI server or
    // with every package testing at once (`pnpm check`) they exceed the default 5 s, and even 30 s.
    testTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: [
        'src/money/**',
        'src/order/**',
        'src/events/**',
        'src/access/**',
        'src/catalog/**',
        'src/canonical.ts',
        'src/config.ts',
        'src/time.ts',
        'src/reports/alerts.ts',
      ],
      exclude: ['**/*.test.ts', 'src/**/index.ts'],
      // Phase 0 plan: at least 90 % in money and in the order reducer.
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
})
