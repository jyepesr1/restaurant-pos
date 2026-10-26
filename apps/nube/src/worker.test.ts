import type { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ADMIN, crearMundo, lote, type Mundo } from './pruebas/mundo'

// El Worker de Cloudflare con un `pg.Client` de mentira que habla con PGlite: conecta solo si la
// ruta usa la base, cierra la conexión al terminar y no filtra nada si la conexión falla.

const estado = vi.hoisted(() => ({
  db: null as unknown,
  creados: [] as { connectionString: string }[],
  conectados: 0,
  terminados: 0,
  oyentes: [] as string[],
  falla: null as Error | null,
  fallaAlTerminar: false,
  fallaConsulta: false,
}))

vi.mock('pg', () => ({
  Client: class {
    constructor(opciones: { connectionString: string }) {
      estado.creados.push(opciones)
    }
    on(evento: string) {
      estado.oyentes.push(evento)
    }
    async connect() {
      if (estado.falla) throw estado.falla
      estado.conectados++
    }
    async query(texto: string, parametros?: unknown[]) {
      if (estado.fallaConsulta) throw new Error('connection terminated')
      const db = estado.db as PGlite
      if (parametros === undefined) {
        const r = await db.exec(texto)
        return { rows: r.at(-1)?.rows ?? [] }
      }
      return db.query(texto, parametros)
    }
    async end() {
      estado.terminados++
      if (estado.fallaAlTerminar) throw new Error('ya estaba cerrada')
    }
  },
}))

import worker from './worker'

const CADENA = 'postgres://faro_api:clave-de-la-base@host.neon.tech/faro'

let m: Mundo
let credencial: string
beforeEach(async () => {
  m = await crearMundo()
  estado.db = m.db
  estado.creados.length = 0
  estado.conectados = 0
  estado.terminados = 0
  estado.oyentes.length = 0
  estado.falla = null
  estado.fallaAlTerminar = false
  estado.fallaConsulta = false
  credencial = (await m.nuevoHub()).credencial
})

function llamar(ruta: string, opciones: RequestInit = {}) {
  const pendientes: Promise<unknown>[] = []
  const respuesta = worker.fetch(
    new Request(`https://nube.faro.test${ruta}`, opciones),
    { HYPERDRIVE: { connectionString: CADENA }, TOKEN_ADMIN: ADMIN },
    { waitUntil: (p) => void pendientes.push(p) },
  )
  return { respuesta, pendientes }
}

describe('Worker', () => {
  it('la salud y las rutas que no existen no abren conexión con la base', async () => {
    for (const ruta of ['/v1/salud', '/v1/nada']) {
      const { respuesta, pendientes } = llamar(ruta)
      await respuesta
      await Promise.all(pendientes)
    }
    expect(estado.creados).toEqual([])
    expect(estado.conectados).toBe(0)
    expect(estado.terminados).toBe(0)
  })

  it('una ruta que usa la base conecta una vez, con la cadena de Hyperdrive, y cierra al terminar', async () => {
    const { respuesta, pendientes } = llamar('/v1/eventos', {
      method: 'POST',
      headers: { authorization: `Bearer ${credencial}` },
      body: JSON.stringify({ eventos: lote(1, 3) }),
    })
    const r = await respuesta
    expect(r.status).toBe(200)
    await Promise.all(pendientes)
    expect(estado.creados).toEqual([{ connectionString: CADENA }])
    expect(estado.conectados).toBe(1)
    expect(estado.terminados).toBe(1)
  })

  it('cada petición usa su propia conexión', async () => {
    for (let i = 0; i < 3; i++) {
      const { respuesta, pendientes } = llamar('/v1/eventos/ultima', {
        headers: { authorization: `Bearer ${credencial}` },
      })
      expect((await respuesta).status).toBe(200)
      await Promise.all(pendientes)
    }
    expect(estado.conectados).toBe(3)
    expect(estado.terminados).toBe(3)
  })

  it('una caída de la conexión a mitad de camino queda atendida (hay oyente de error)', async () => {
    const { respuesta, pendientes } = llamar('/v1/eventos/ultima', {
      headers: { authorization: `Bearer ${credencial}` },
    })
    await respuesta
    await Promise.all(pendientes)
    expect(estado.oyentes).toContain('error')
  })

  it('si no se puede conectar: 500 genérico, sin la cadena de conexión ni el motivo', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    estado.falla = new Error(`connect ECONNREFUSED ${CADENA}`)
    const { respuesta, pendientes } = llamar('/v1/eventos/ultima', {
      headers: { authorization: `Bearer ${credencial}` },
    })
    const r = await respuesta
    await Promise.all(pendientes)
    const texto = await r.text()
    expect(r.status).toBeGreaterThanOrEqual(500)
    expect(texto).not.toContain('clave-de-la-base')
    expect(texto).not.toContain('ECONNREFUSED')
    expect(texto).not.toContain('neon.tech')
    expect(r.headers.get('content-type')).toContain('application/json')
  })

  it('si cerrar la conexión falla, la petición igual responde y no queda una promesa sin manejar', async () => {
    estado.fallaAlTerminar = true
    const { respuesta, pendientes } = llamar('/v1/eventos/ultima', {
      headers: { authorization: `Bearer ${credencial}` },
    })
    expect((await respuesta).status).toBe(200)
    await expect(Promise.all(pendientes)).resolves.toBeDefined()
  })

  it('un error interno de la API (la consulta falla) responde 500 y cierra igual la conexión', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    estado.fallaConsulta = true
    const { respuesta, pendientes } = llamar('/v1/eventos/ultima', {
      headers: { authorization: `Bearer ${credencial}` },
    })
    const r = await respuesta
    await Promise.all(pendientes)
    expect(r.status).toBe(500)
    expect(estado.conectados).toBe(1)
    expect(estado.terminados).toBe(1)
  })

  it('la zona de administración funciona con el token del entorno y no sin él', async () => {
    const sin = llamar('/v1/admin/restaurantes', { method: 'POST', body: '{}' })
    expect((await sin.respuesta).status).toBe(401)
    await Promise.all(sin.pendientes)
    const con = llamar('/v1/admin/restaurantes', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}` },
      body: JSON.stringify({ id: '0'.repeat(26), nombre: 'R' }),
    })
    expect((await con.respuesta).status).toBe(201)
    await Promise.all(con.pendientes)
  })

  it('sin TOKEN_ADMIN en el entorno no hay administración (aunque se mande un token)', async () => {
    const pendientes: Promise<unknown>[] = []
    const r = await worker.fetch(
      new Request('https://nube.faro.test/v1/admin/restaurantes', {
        method: 'POST',
        headers: { authorization: 'Bearer cualquiera' },
        body: '{}',
      }),
      { HYPERDRIVE: { connectionString: CADENA } },
      { waitUntil: (p) => void pendientes.push(p) },
    )
    expect(r.status).toBe(401)
  })
})
