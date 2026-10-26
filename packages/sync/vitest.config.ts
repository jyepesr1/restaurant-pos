import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Property-based convergence and `pull` with thousands of events: on the CI server they exceed
    // the default 5 s.
    testTimeout: 30_000,
  },
})
