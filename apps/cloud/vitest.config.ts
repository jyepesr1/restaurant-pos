import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Several tests start a new embedded Postgres (PGlite), which takes a few seconds: with
    // `pnpm check` running all packages at once they exceed the default 5 s.
    testTimeout: 30_000,
  },
})
