import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Muchas pruebas levantan el hub o el seed como procesos reales y comprueban contraseñas con
    // scrypt: con `pnpm check` corriendo todos los paquetes a la vez pasan de los 5 s por defecto.
    testTimeout: 30_000,
  },
})
