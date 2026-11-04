import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // The Durable Object imports the Workers runtime module, which only exists in workerd.
    alias: {
      'cloudflare:workers': fileURLToPath(
        new URL('./src/testing/cloudflare-workers.ts', import.meta.url),
      ),
    },
  },
  test: {
    // Several tests start a new embedded Postgres (PGlite), which takes a few seconds: with
    // `pnpm check` running all packages at once they exceed the default 5 s, and at times even 30 s.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
