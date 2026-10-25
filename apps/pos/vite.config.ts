/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // En desarrollo, la API la atiende el hub.
    proxy: {
      '/api': { target: 'http://localhost:4000', ws: true },
      '/fotos': 'http://localhost:4000',
    },
  },
  test: {
    // `pnpm check` corre todos los paquetes a la vez y las pruebas del hub (procesos reales,
    // scrypt) ocupan la CPU: las de propiedades al azar pueden pasar de los 5 s por defecto.
    testTimeout: 20_000,
  },
})
