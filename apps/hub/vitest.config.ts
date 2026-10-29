import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Many tests start the hub or the seed as real processes and check passwords with scrypt:
    // with `pnpm check` running all packages at once they exceed the default 5 s.
    testTimeout: 30_000,
    // The same for the hooks that build a hub and a cloud on PGlite once per file.
    hookTimeout: 30_000,
  },
})
