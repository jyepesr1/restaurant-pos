import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Convergencia por propiedades y `traer` con miles de eventos: en el servidor de CI pasan de
    // los 5 s por defecto.
    testTimeout: 30_000,
  },
})
