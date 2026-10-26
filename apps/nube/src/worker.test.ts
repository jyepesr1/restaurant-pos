import type { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ADMIN, batch, crearMundo, type Mundo } from './pruebas/mundo'

// El Worker de Cloudflare con un `pg.Client` de mentira que habla con PGlite: conecta solo si la
// ruta usa la base, cierra la conexión al terminar y no filtra nada si la conexión falla.

const status = vi.hoisted(() => ({
  db: null as unknown,
  creados: [] as { connectionString: string }[],
  conectados: 0,
  terminados: 0,
  oyentes: [] as string[],
  failing: null as Error | null,
  fallaAlTerminar: false,
  fallaConsulta: false,
}))

vi.mock('pg', () => ({
  Client: class {
    constructor(options: { connectionString: string }) {
      status.creados.push(options)
    }
    on(event: string) {
      status.oyentes.push(event)
    }
    async connect() {
      if (status.failing) throw status.failing
      status.conectados++
    }
    async query(text: string, parametros?: unknown[]) {
      if (status.fallaConsulta) throw new Error('connection terminated')
      const db = status.db as PGlite
      if (parametros === undefined) {
        const r = await db.exec(text)
        return { rows: r.at(-1)?.rows ?? [] }
      }
      return db.query(text, parametros)
    }
    async end() {
      status.terminados++
      if (status.fallaAlTerminar) throw new Error('ya estaba cerrada')
    }
  },
}))

import worker from './worker'

const CADENA = 'postgres://faro_api:clave-de-la-base@host.neon.tech/faro'

let m: Mundo
let credential: string
beforeEach(async () => {
  m = await crearMundo()
  status.db = m.db
  status.creados.length = 0
  status.conectados = 0
  status.terminados = 0
  status.oyentes.length = 0
  status.failing = null
  status.fallaAlTerminar = false
  status.fallaConsulta = false
  credential = (await m.nuevoHub()).credential
})

function llamar(ruta: string, options: RequestInit = {}) {
  const pendingList: Promise<unknown>[] = []
  const respuesta = worker.fetch(
    new Request(`https://cloud.faro.test${ruta}`, options),
    { HYPERDRIVE: { connectionString: CADENA }, TOKEN_ADMIN: ADMIN },
    { waitUntil: (p) => void pendingList.push(p) },
  )
  return { respuesta, pendingList }
}

describe('Worker', () => {
  it('la salud y las rutas que no existen no abren conexión con la base', async () => {
    for (const ruta of ['/v1/health', '/v1/nothing']) {
      const { respuesta, pendingList } = llamar(ruta)
      await respuesta
      await Promise.all(pendingList)
    }
    expect(status.creados).toEqual([])
    expect(status.conectados).toBe(0)
    expect(status.terminados).toBe(0)
  })

  it('una ruta que usa la base conecta una vez, con la cadena de Hyperdrive, y cierra al terminar', async () => {
    const { respuesta, pendingList } = llamar('/v1/events', {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}` },
      body: JSON.stringify({ events: batch(1, 3) }),
    })
    const r = await respuesta
    expect(r.status).toBe(200)
    await Promise.all(pendingList)
    expect(status.creados).toEqual([{ connectionString: CADENA }])
    expect(status.conectados).toBe(1)
    expect(status.terminados).toBe(1)
  })

  it('cada petición usa su propia conexión', async () => {
    for (let i = 0; i < 3; i++) {
      const { respuesta, pendingList } = llamar('/v1/events/last', {
        headers: { authorization: `Bearer ${credential}` },
      })
      expect((await respuesta).status).toBe(200)
      await Promise.all(pendingList)
    }
    expect(status.conectados).toBe(3)
    expect(status.terminados).toBe(3)
  })

  it('una caída de la conexión a mitad de camino queda atendida (hay oyente de error)', async () => {
    const { respuesta, pendingList } = llamar('/v1/events/last', {
      headers: { authorization: `Bearer ${credential}` },
    })
    await respuesta
    await Promise.all(pendingList)
    expect(status.oyentes).toContain('error')
  })

  it('si no se puede conectar: 500 genérico, sin la cadena de conexión ni el motivo', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    status.failing = new Error(`connect ECONNREFUSED ${CADENA}`)
    const { respuesta, pendingList } = llamar('/v1/events/last', {
      headers: { authorization: `Bearer ${credential}` },
    })
    const r = await respuesta
    await Promise.all(pendingList)
    const text = await r.text()
    expect(r.status).toBeGreaterThanOrEqual(500)
    expect(text).not.toContain('clave-de-la-base')
    expect(text).not.toContain('ECONNREFUSED')
    expect(text).not.toContain('neon.tech')
    expect(r.headers.get('content-type')).toContain('application/json')
  })

  it('si cerrar la conexión falla, la petición igual responde y no queda una promesa sin manejar', async () => {
    status.fallaAlTerminar = true
    const { respuesta, pendingList } = llamar('/v1/events/last', {
      headers: { authorization: `Bearer ${credential}` },
    })
    expect((await respuesta).status).toBe(200)
    await expect(Promise.all(pendingList)).resolves.toBeDefined()
  })

  it('un error interno de la API (la consulta falla) responde 500 y cierra igual la conexión', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    status.fallaConsulta = true
    const { respuesta, pendingList } = llamar('/v1/events/last', {
      headers: { authorization: `Bearer ${credential}` },
    })
    const r = await respuesta
    await Promise.all(pendingList)
    expect(r.status).toBe(500)
    expect(status.conectados).toBe(1)
    expect(status.terminados).toBe(1)
  })

  it('la zona de administración funciona con el token del entorno y no sin él', async () => {
    const without = llamar('/v1/admin/restaurants', { method: 'POST', body: '{}' })
    expect((await without.respuesta).status).toBe(401)
    await Promise.all(without.pendingList)
    const withIt = llamar('/v1/admin/restaurants', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}` },
      body: JSON.stringify({ id: '0'.repeat(26), name: 'R' }),
    })
    expect((await withIt.respuesta).status).toBe(201)
    await Promise.all(withIt.pendingList)
  })

  it('sin TOKEN_ADMIN en el entorno no hay administración (aunque se mande un token)', async () => {
    const pendingList: Promise<unknown>[] = []
    const r = await worker.fetch(
      new Request('https://cloud.faro.test/v1/admin/restaurants', {
        method: 'POST',
        headers: { authorization: 'Bearer cualquiera' },
        body: '{}',
      }),
      { HYPERDRIVE: { connectionString: CADENA } },
      { waitUntil: (p) => void pendingList.push(p) },
    )
    expect(r.status).toBe(401)
  })
})
