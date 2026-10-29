import { readFileSync } from 'node:fs'
import { cp, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// The owner's panel (task 1.11c-1, docs/PANEL.md): a second entry of the app, `panel.html`, built
// to `dist-panel` for Workers Static Assets. The Worker serves `index.html` for any address that
// is not `/v1/*` (`not_found_handling: "single-page-application"`), so the page is renamed.
// `public/` (the brand logos) is shared with the register; `public-panel/` holds what only the panel
// serves: `_headers` (CSP and cache of the static files, which the Worker code does not answer)
// and `boot.js` (brand and dark mode before painting, outside the HTML so the CSP allows no inline
// script).

const OUT_DIR = 'dist-panel'
const OWN = resolve(import.meta.dirname, 'public-panel')

/** In development, every page address (`/`, `/reports`, `/r/<slug>`) answers with panel.html. */
const panelPage = (): Plugin => ({
  name: 'faro-panel-page',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const path = req.url?.split('?')[0] ?? '/'
      const isPage =
        req.method === 'GET' &&
        !path.startsWith('/v1/') &&
        !path.startsWith('/@') &&
        !path.includes('.') &&
        (req.headers.accept ?? '').includes('text/html')
      if (isPage) req.url = '/panel.html'
      if (path === '/boot.js') {
        res.setHeader('content-type', 'text/javascript')
        res.end(readFileSync(resolve(OWN, 'boot.js')))
        return
      }
      next()
    })
  },
})

/** In the build: panel.html → index.html, and the panel's own files at the root. */
const finish = (): Plugin => ({
  name: 'faro-panel-finish',
  apply: 'build',
  async closeBundle() {
    const out = resolve(import.meta.dirname, OUT_DIR)
    await rename(resolve(out, 'panel.html'), resolve(out, 'index.html'))
    await cp(OWN, out, { recursive: true })
  },
})

export default defineConfig({
  plugins: [react(), tailwindcss(), panelPage(), finish()],
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, 'panel.html') },
  },
  server: {
    port: 5174,
    // In development, the cloud runs with `wrangler dev` (apps/cloud); FARO_CLOUD_URL points
    // elsewhere (the deployed Worker, a fake one for trying the screens).
    proxy: { '/v1': process.env.FARO_CLOUD_URL ?? 'http://localhost:8787' },
  },
})
