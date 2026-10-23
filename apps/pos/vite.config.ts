import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // En desarrollo, la API la atiende el hub.
    proxy: { '/api': { target: 'http://localhost:4000', ws: true } },
  },
})
