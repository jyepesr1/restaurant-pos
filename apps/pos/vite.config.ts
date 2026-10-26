/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // In development, the hub serves the API.
    proxy: {
      '/api': { target: 'http://localhost:4000', ws: true },
      '/photos': 'http://localhost:4000',
    },
  },
  test: {
    // `pnpm check` runs all packages at once and the hub tests (real processes, scrypt)
    // keep the CPU busy: the random property tests can exceed the default 5 s.
    testTimeout: 20_000,
  },
})
