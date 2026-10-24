import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { crearServidor } from './servidor'

describe('servidor del hub', () => {
  let app: ReturnType<typeof crearServidor> | undefined

  afterEach(async () => {
    await app?.close()
  })

  it('responde el chequeo de salud', async () => {
    app = crearServidor()
    const res = await app.inject({ method: 'GET', url: '/api/salud' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ estado: 'ok', servicio: 'hub' })
  })

  it('informa la versión de la base en el chequeo de salud', async () => {
    app = crearServidor({ versionBase: 1 })
    const res = await app.inject({ method: 'GET', url: '/api/salud' })

    expect(res.json()).toMatchObject({ version_base: 1 })
  })

  it('sirve la app y devuelve index.html en rutas de la app', async () => {
    const dirApp = mkdtempSync(join(tmpdir(), 'pos-app-'))
    writeFileSync(join(dirApp, 'index.html'), '<title>POS</title>')
    app = crearServidor({ dirApp })

    const raiz = await app.inject({ method: 'GET', url: '/' })
    const rutaApp = await app.inject({ method: 'GET', url: '/mesas/5' })

    expect(raiz.body).toContain('<title>POS</title>')
    expect(rutaApp.statusCode).toBe(200)
    expect(rutaApp.body).toContain('<title>POS</title>')
  })

  it('responde 404 en rutas de la API que no existen', async () => {
    const dirApp = mkdtempSync(join(tmpdir(), 'pos-app-'))
    writeFileSync(join(dirApp, 'index.html'), '<title>POS</title>')
    app = crearServidor({ dirApp })

    const res = await app.inject({ method: 'GET', url: '/api/no-existe' })

    expect(res.statusCode).toBe(404)
  })

  describe('archivos estáticos de la app', () => {
    /** Carpeta de pruebas: `<raiz>/app` es la app y `<raiz>/secreto.txt` queda fuera de ella. */
    function crearCarpetas() {
      const raiz = mkdtempSync(join(tmpdir(), 'pos-estaticos-'))
      const dirApp = join(raiz, 'app')
      mkdirSync(join(dirApp, 'assets'), { recursive: true })
      writeFileSync(join(dirApp, 'index.html'), '<title>POS</title>')
      writeFileSync(join(dirApp, 'assets', 'index-abc.js'), 'console.log("pos")')
      writeFileSync(join(dirApp, 'assets', 'index-abc.css'), 'body{margin:0}')
      writeFileSync(join(raiz, 'secreto.txt'), 'CONTENIDO-SECRETO')
      return dirApp
    }

    /** Petición HTTP real con la ruta tal cual, sin que el cliente la normalice. */
    async function pedirCrudo(servidor: ReturnType<typeof crearServidor>, ruta: string) {
      await servidor.listen({ host: '127.0.0.1', port: 0 })
      const { port } = servidor.server.address() as AddressInfo
      return new Promise<{ status: number; cuerpo: string }>((resolver, rechazar) => {
        const req = request({ host: '127.0.0.1', port, path: ruta, method: 'GET' }, (res) => {
          let cuerpo = ''
          res.on('data', (trozo) => {
            cuerpo += trozo
          })
          res.on('end', () => resolver({ status: res.statusCode ?? 0, cuerpo }))
        })
        req.on('error', rechazar)
        req.end()
      })
    }

    it('sirve los assets JS y CSS con su tipo de contenido', async () => {
      app = crearServidor({ dirApp: crearCarpetas() })

      const js = await app.inject({ method: 'GET', url: '/assets/index-abc.js' })
      const css = await app.inject({ method: 'GET', url: '/assets/index-abc.css' })

      expect(js.statusCode).toBe(200)
      expect(js.headers['content-type']).toMatch(/javascript/)
      expect(js.body).toBe('console.log("pos")')
      expect(css.statusCode).toBe(200)
      expect(css.headers['content-type']).toMatch(/text\/css/)
    })

    it('sirve index.html como HTML', async () => {
      app = crearServidor({ dirApp: crearCarpetas() })

      const res = await app.inject({ method: 'GET', url: '/' })

      expect(res.headers['content-type']).toMatch(/text\/html/)
    })

    it.each(['/assets/no-existe.js', '/favicon.ico'])(
      'un archivo que no existe responde 404 y no HTML: %s',
      async (url) => {
        app = crearServidor({ dirApp: crearCarpetas() })

        const res = await app.inject({ method: 'GET', url })

        // Evita que un celular con una versión vieja reciba HTML en lugar de su JS.
        expect(res.statusCode).toBe(404)
        expect(res.body).not.toContain('<title>POS</title>')
      },
    )

    it.each(['/api', '/api?x=1'])('%s responde 404 JSON y no la app', async (url) => {
      app = crearServidor({ dirApp: crearCarpetas() })

      const res = await app.inject({ method: 'GET', url })

      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'No encontrado' })
    })

    it('HEAD a una ruta de la app responde 200', async () => {
      app = crearServidor({ dirApp: crearCarpetas() })

      const res = await app.inject({ method: 'HEAD', url: '/mesas/5' })

      expect(res.statusCode).toBe(200)
    })

    it('responde 404 a métodos que no son GET fuera de la API', async () => {
      app = crearServidor({ dirApp: crearCarpetas() })

      const res = await app.inject({ method: 'POST', url: '/mesas/5' })

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
    ])('no expone archivos fuera de la carpeta de la app: %s', async (ruta) => {
      app = crearServidor({ dirApp: crearCarpetas() })

      const res = await pedirCrudo(app, ruta)

      expect(res.cuerpo).not.toContain('CONTENIDO-SECRETO')
    })
  })
})
