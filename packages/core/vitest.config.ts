import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Las pruebas de propiedades recorren miles de casos al azar; con la cobertura activa y en el
    // servidor de CI pasan de los 5 s por defecto.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: [
        'src/dinero/**',
        'src/pedido/**',
        'src/eventos/**',
        'src/acceso/**',
        'src/canonico.ts',
        'src/tiempo.ts',
      ],
      exclude: ['**/*.test.ts', 'src/**/index.ts'],
      // Plan de la Fase 0: al menos 90 % en dinero y en el reductor del pedido.
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
})
