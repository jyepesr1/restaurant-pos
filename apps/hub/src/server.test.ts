import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppServer } from './server'

describe('hub server', () => {
  let app: ReturnType<typeof createAppServer> | undefined

  afterEach(async () => {
    await app?.close()
  })

  it('answers the health check', async () => {
    app = createAppServer()
    const res = await app.inject({ method: 'GET', url: '/api/health' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok', service: 'hub' })
  })

  it('reports the database version in the health check', async () => {
    app = createAppServer({ dbVersion: 1 })
    const res = await app.inject({ method: 'GET', url: '/api/health' })

    expect(res.json()).toMatchObject({ db_version: 1 })
  })

  it('serves the app and returns index.html on app routes', async () => {
    const dirApp = mkdtempSync(join(tmpdir(), 'pos-app-'))
    writeFileSync(join(dirApp, 'index.html'), '<title>POS</title>')
    app = createAppServer({ dirApp })

    const root = await app.inject({ method: 'GET', url: '/' })
    const appRoute = await app.inject({ method: 'GET', url: '/tables/5' })

    expect(root.body).toContain('<title>POS</title>')
    expect(appRoute.statusCode).toBe(200)
    expect(appRoute.body).toContain('<title>POS</title>')
  })

  it('answers 404 on API routes that do not exist', async () => {
    const dirApp = mkdtempSync(join(tmpdir(), 'pos-app-'))
    writeFileSync(join(dirApp, 'index.html'), '<title>POS</title>')
    app = createAppServer({ dirApp })

    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' })

    expect(res.statusCode).toBe(404)
  })

  describe('static app files', () => {
    /** Test folder: `<root>/app` is the app and `<root>/secreto.txt` sits outside it. */
    function createDirs() {
      const root = mkdtempSync(join(tmpdir(), 'pos-estaticos-'))
      const dirApp = join(root, 'app')
      mkdirSync(join(dirApp, 'assets'), { recursive: true })
      writeFileSync(join(dirApp, 'index.html'), '<title>POS</title>')
      writeFileSync(join(dirApp, 'assets', 'index-abc.js'), 'console.log("pos")')
      writeFileSync(join(dirApp, 'assets', 'index-abc.css'), 'body{margin:0}')
      writeFileSync(join(root, 'secreto.txt'), 'CONTENIDO-SECRETO')
      return dirApp
    }

    /** A real HTTP request with the path as is, without the client normalizing it. */
    async function requestRaw(server: ReturnType<typeof createAppServer>, route: string) {
      await server.listen({ host: '127.0.0.1', port: 0 })
      const { port } = server.server.address() as AddressInfo
      return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: route, method: 'GET' }, (res) => {
          let body = ''
          res.on('data', (chunk) => {
            body += chunk
          })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        })
        req.on('error', reject)
        req.end()
      })
    }

    it('serves JS and CSS assets with their content type', async () => {
      app = createAppServer({ dirApp: createDirs() })

      const js = await app.inject({ method: 'GET', url: '/assets/index-abc.js' })
      const css = await app.inject({ method: 'GET', url: '/assets/index-abc.css' })

      expect(js.statusCode).toBe(200)
      expect(js.headers['content-type']).toMatch(/javascript/)
      expect(js.body).toBe('console.log("pos")')
      expect(css.statusCode).toBe(200)
      expect(css.headers['content-type']).toMatch(/text\/css/)
    })

    it('serves index.html as HTML', async () => {
      app = createAppServer({ dirApp: createDirs() })

      const res = await app.inject({ method: 'GET', url: '/' })

      expect(res.headers['content-type']).toMatch(/text\/html/)
    })

    it.each(['/assets/does-not-exist.js', '/favicon.ico'])(
      'a file that does not exist answers 404 and not HTML: %s',
      async (url) => {
        app = createAppServer({ dirApp: createDirs() })

        const res = await app.inject({ method: 'GET', url })

        // Keeps a phone with an old version from receiving HTML instead of its JS.
        expect(res.statusCode).toBe(404)
        expect(res.body).not.toContain('<title>POS</title>')
      },
    )

    it.each(['/api', '/api?x=1'])('%s answers 404 JSON and not the app', async (url) => {
      app = createAppServer({ dirApp: createDirs() })

      const res = await app.inject({ method: 'GET', url })

      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'No encontrado' })
    })

    it('HEAD on an app route answers 200', async () => {
      app = createAppServer({ dirApp: createDirs() })

      const res = await app.inject({ method: 'HEAD', url: '/tables/5' })

      expect(res.statusCode).toBe(200)
    })

    it('answers 404 to non-GET methods outside the API', async () => {
      app = createAppServer({ dirApp: createDirs() })

      const res = await app.inject({ method: 'POST', url: '/tables/5' })

      expect(res.statusCode).toBe(404)
    })

    it.each([
      '/../secreto.txt',
      '/%2e%2e/secreto.txt',
      '/%2e%2e%2fsecreto.txt',
      '/assets/../../secreto.txt',
      '/assets/..%2f..%2fsecreto.txt',
      '/..%5csecreto.txt',
      '/%252e%252e/secreto.txt',
    ])('does not expose files outside the app folder: %s', async (route) => {
      app = createAppServer({ dirApp: createDirs() })

      const res = await requestRaw(app, route)

      expect(res.body).not.toContain('CONTENIDO-SECRETO')
    })
  })
})
