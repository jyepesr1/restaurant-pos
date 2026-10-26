import { newId } from '@pos/core'
import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import { atender } from './api'
import { normalizarCodigo, VIGENCIA_CODIGO_MS } from './nube'
import { ADMIN, batch, crearMundo, type Mundo, NOW, SEED } from './pruebas/mundo'

// El registro de un hub con un código (ADR-016): un solo hub por código, vigencia de 24 horas,
// reintento del mismo hub, y credenciales que no sirven si son inventadas o el hub fue revocado.

let m: Mundo
beforeAll(async () => {
  m = await crearMundo()
})

async function restauranteConCodigo() {
  const restaurant = newId()
  await m.nube.crearRestaurante({ id: restaurant, name: 'R' })
  const c = await m.nube.crearCodigo(restaurant)
  if (!c) throw new Error('sin código')
  return { restaurant, code: c.code, venceEn: c.venceEn }
}

const nuevoCodigoDe = async (restaurant: string) => {
  const c = await m.nube.crearCodigo(restaurant)
  if (!c) throw new Error('sin código')
  return c.code
}

const record = (code: string, hubId = newId(), extras: Record<string, unknown> = {}) =>
  m.request('POST', '/v1/hubs/register', {
    code,
    hub_id: hubId,
    location_id: newId(),
    name: 'Caja',
    instance: 'i',
    ...extras,
  })

const hubsDe = async (restaurant: string) =>
  (await m.db.query<{ id: string }>('SELECT id FROM hubs WHERE restaurant_id = $1', [restaurant]))
    .rows

describe('código de un solo uso', () => {
  it('con registros concurrentes del mismo código, solo uno gana', async () => {
    const { restaurant, code } = await restauranteConCodigo()
    const respuestas = await Promise.all(Array.from({ length: 8 }, () => record(code)))
    const statuses = respuestas.map((r) => r.status).sort()
    expect(statuses).toEqual([201, 403, 403, 403, 403, 403, 403, 403])
    expect(await hubsDe(restaurant)).toHaveLength(1)
  })

  it('con el mismo código escrito de varias formas a la vez, solo uno gana', async () => {
    const { restaurant, code } = await restauranteConCodigo()
    const formas = [
      code,
      code.toLowerCase(),
      code.replaceAll('-', ''),
      ` ${code} `,
      code.replaceAll('-', ' '),
    ]
    const respuestas = await Promise.all(formas.map((c) => record(c)))
    expect(respuestas.filter((r) => r.status === 201)).toHaveLength(1)
    expect(await hubsDe(restaurant)).toHaveLength(1)
  })

  it('el mismo hub repitiendo el registro a la vez con el mismo código: queda una sola credencial válida', async () => {
    const { restaurant, code } = await restauranteConCodigo()
    const hubId = newId()
    const respuestas = await Promise.all(Array.from({ length: 4 }, () => record(code, hubId)))
    expect(respuestas.map((r) => r.status)).toEqual([201, 201, 201, 201])
    expect(await hubsDe(restaurant)).toHaveLength(1)
    const credenciales = await Promise.all(
      respuestas.map(async (r) => ((await r.json()) as { credential: string }).credential),
    )
    const validas = await Promise.all(credenciales.map((c) => m.nube.authenticate(c)))
    expect(validas.filter((h) => h !== null)).toHaveLength(1)
  })

  it('un código usado por otro hub no sirve para un tercero', async () => {
    const { code } = await restauranteConCodigo()
    expect((await record(code)).status).toBe(201)
    expect((await record(code)).status).toBe(403)
    expect((await record(code.toLowerCase())).status).toBe(403)
  })

  it('el mismo hub puede repetir el registro con su código (respuesta perdida): credencial nueva, la anterior deja de servir', async () => {
    const { restaurant, code } = await restauranteConCodigo()
    const hubId = newId()
    const first = (await (await record(code, hubId)).json()) as { credential: string }
    const r2 = await record(code, hubId)
    expect(r2.status).toBe(201)
    const second = (await r2.json()) as { credential: string; restaurant_id: string }
    expect(second.restaurant_id).toBe(restaurant)
    expect(second.credential).not.toBe(first.credential)
    expect(await m.nube.authenticate(first.credential)).toBeNull()
    expect((await m.nube.authenticate(second.credential))?.id).toBe(hubId)
    expect(await hubsDe(restaurant)).toHaveLength(1)
  })

  it('el reintento tras vencer el código ya no sirve', async () => {
    const { code } = await restauranteConCodigo()
    const hubId = newId()
    expect((await record(code, hubId)).status).toBe(201)
    m.clock.now = new Date(NOW.getTime() + VIGENCIA_CODIGO_MS + 1)
    try {
      expect((await record(code, hubId)).status).toBe(403)
    } finally {
      m.clock.now = NOW
    }
  })

  it('el mismo hub con otro código es 409 y el otro código queda sin usar', async () => {
    const a = await restauranteConCodigo()
    const hubId = newId()
    expect((await record(a.code, hubId)).status).toBe(201)
    const other = await nuevoCodigoDe(a.restaurant)
    expect((await record(other, hubId)).status).toBe(409)
    // El código que no se gastó sigue sirviendo para un hub distinto.
    expect((await record(other)).status).toBe(201)
  })

  it('el mismo hub con dos códigos distintos a la vez: uno gana y el otro es 409, nunca 500', async () => {
    const a = await restauranteConCodigo()
    const other = await nuevoCodigoDe(a.restaurant)
    const hubId = newId()
    const [r1, r2] = await Promise.all([record(a.code, hubId), record(other, hubId)])
    expect([r1.status, r2.status].sort()).toEqual([201, 409])
  })

  it('un hub revocado no puede volver a registrarse con su código', async () => {
    const { code } = await restauranteConCodigo()
    const hubId = newId()
    const { credential } = (await (await record(code, hubId)).json()) as { credential: string }
    expect(
      (await m.request('POST', '/v1/admin/hubs/revoke', { hub_id: hubId }, ADMIN)).status,
    ).toBe(204)
    expect((await record(code, hubId)).status).toBe(403)
    expect(await m.nube.authenticate(credential)).toBeNull()
  })

  it('el código no se guarda en claro ni la credencial: solo su huella', async () => {
    const { code } = await restauranteConCodigo()
    const { credential } = (await (await record(code)).json()) as { credential: string }
    const saved = JSON.stringify([
      (await m.db.query('SELECT * FROM registration_codes')).rows,
      (await m.db.query('SELECT * FROM hubs')).rows,
    ])
    expect(saved).not.toContain(credential)
    expect(saved).not.toContain(normalizarCodigo(code))
    expect(saved).not.toContain(code)
  })
})

describe('código mal escrito', () => {
  /** Mezcla mayúsculas, espacios y guiones sin cambiar las letras del código. */
  const escritura = fc.record({
    minusculas: fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
    separadores: fc.array(fc.constantFrom('', '', '', ' ', '-', '--', ' - ', '\t'), {
      minLength: 13,
      maxLength: 13,
    }),
  })

  it('propiedad: mayúsculas, minúsculas, espacios y guiones en cualquier sitio siguen siendo el mismo código', async () => {
    await fc.assert(
      fc.asyncProperty(escritura, async ({ minusculas, separadores }) => {
        const { restaurant, code } = await restauranteConCodigo()
        const letras = code.replaceAll('-', '')
        const escrito = [...letras]
          .map((c, i) => `${separadores[i]}${minusculas[i] ? c.toLowerCase() : c}`)
          .join('')
          .concat(separadores[12] ?? '')
        expect(escrito.length).toBeLessThanOrEqual(40)
        const r = await record(escrito)
        expect(r.status, JSON.stringify(escrito)).toBe(201)
        expect(await hubsDe(restaurant)).toHaveLength(1)
      }),
      { seed: SEED, numRuns: 30 },
    )
  })

  it('una letra cambiada, de menos, de más, o con letras confundibles: 403 y el código sigue sirviendo', async () => {
    const { restaurant, code } = await restauranteConCodigo()
    const letras = code.replaceAll('-', '')
    const another = letras[0] === 'A' ? 'B' : 'A'
    const badOnes = [
      `${another}${letras.slice(1)}`,
      letras.slice(1),
      letras.slice(0, -1),
      `${letras}A`,
      `A${letras}`,
      letras.replaceAll(/[A-Z]/g, '0'),
      letras.replaceAll(/[2-9]/g, 'O'),
      `${letras.slice(0, 6)}${letras.slice(6).toLowerCase().replace(/[a-z]/, 'l')}`,
    ].filter((c) => normalizarCodigo(c) !== letras)
    for (const badCase of badOnes) expect((await record(badCase)).status, badCase).toBe(403)
    expect(await hubsDe(restaurant)).toHaveLength(0)
    expect((await record(code)).status).toBe(201)
  })

  it('vacío, solo espacios o solo guiones: 403 (o 400 si ni llega) sin registrar nada', async () => {
    const { restaurant } = await restauranteConCodigo()
    for (const c of ['', ' ', '   ', '---', '- - -', '\t\n'])
      expect([400, 403], JSON.stringify(c)).toContain((await record(c)).status)
    expect(await hubsDe(restaurant)).toHaveLength(0)
  })

  it('un código de más de 40 caracteres es un cuerpo inválido', async () => {
    const r = await record('A'.repeat(41))
    expect(r.status).toBe(400)
    expect((await record('A'.repeat(100_000))).status).toBe(400)
  })

  it('propiedad: un texto cualquiera nunca registra un hub', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'binary', maxLength: 40 }), async (text) => {
        const before = (await m.db.query<{ n: number }>('SELECT count(*)::int AS n FROM hubs'))
          .rows[0]
        const r = await record(text)
        expect([400, 403]).toContain(r.status)
        const after = (await m.db.query<{ n: number }>('SELECT count(*)::int AS n FROM hubs'))
          .rows[0]
        expect(after?.n).toBe(before?.n)
      }),
      { seed: SEED, numRuns: 40 },
    )
  })

  it('un cuerpo que además dice un restaurante_id no sirve para escoger restaurante', async () => {
    const { code } = await restauranteConCodigo()
    const r = await record(code, newId(), { restaurant_id: newId() })
    expect(r.status).toBe(400)
  })
})

describe('vigencia del código', () => {
  it('vence exactamente a las 24 horas: un milisegundo antes sirve, justo en el instante ya no', async () => {
    const a = await restauranteConCodigo()
    const b = await restauranteConCodigo()
    expect(a.venceEn).toBe(new Date(NOW.getTime() + VIGENCIA_CODIGO_MS).toISOString())
    try {
      m.clock.now = new Date(NOW.getTime() + VIGENCIA_CODIGO_MS - 1)
      expect((await record(a.code)).status).toBe(201)
      m.clock.now = new Date(NOW.getTime() + VIGENCIA_CODIGO_MS)
      expect((await record(b.code)).status).toBe(403)
    } finally {
      m.clock.now = NOW
    }
  })

  it('un código vencido no se puede registrar aunque nadie lo haya usado, y uno nuevo sí', async () => {
    const { restaurant, code } = await restauranteConCodigo()
    try {
      m.clock.now = new Date(NOW.getTime() + 3 * VIGENCIA_CODIGO_MS)
      expect((await record(code)).status).toBe(403)
      expect((await record(await nuevoCodigoDe(restaurant))).status).toBe(201)
    } finally {
      m.clock.now = NOW
    }
  })

  it('un reloj atrasado en la nube no vence un código antes de tiempo (se compara contra el reloj de la nube)', async () => {
    const { code } = await restauranteConCodigo()
    try {
      // Reloj muy adelantado = código vencido; muy atrasado = código aún vigente.
      m.clock.now = new Date(NOW.getTime() - 5 * VIGENCIA_CODIGO_MS)
      expect((await record(code)).status).toBe(201)
    } finally {
      m.clock.now = NOW
    }
  })
})

describe('código de otro restaurante', () => {
  it('registra el hub en el restaurante del código, no en otro', async () => {
    const a = await restauranteConCodigo()
    const b = await restauranteConCodigo()
    const r = await record(b.code)
    expect(((await r.json()) as { restaurant_id: string }).restaurant_id).toBe(b.restaurant)
    expect(await hubsDe(a.restaurant)).toHaveLength(0)
    expect(await hubsDe(b.restaurant)).toHaveLength(1)
  })

  it('crear un código para un restaurante que no existe no deja rastro', async () => {
    const r = await m.request('POST', '/v1/admin/codes', { restaurant_id: newId() }, ADMIN)
    expect(r.status).toBe(404)
  })
})

describe('credenciales', () => {
  it('una credencial inventada, vacía o enorme no sube eventos ni lee la secuencia', async () => {
    const events = batch(1, 2)
    for (const token of [
      'inventada',
      'x',
      'A'.repeat(43),
      'A'.repeat(100_000),
      '0'.repeat(200),
      'Bearer',
    ]) {
      expect(
        (await m.request('POST', '/v1/events', { events }, token)).status,
        token.slice(0, 20),
      ).toBe(401)
      expect((await m.request('GET', '/v1/events/last', undefined, token)).status).toBe(401)
    }
  })

  it('encabezados de autorización raros: sin esquema Bearer, vacíos o con partes de más', async () => {
    const { credential } = await m.newHub()
    const request = (authorization: string | null) =>
      atender(
        new Request('https://cloud.faro.test/v1/events/last', {
          headers: authorization === null ? {} : { authorization: authorization },
        }),
        { sql: m.sql },
      )
    expect((await request(null)).status).toBe(401)
    expect((await request('')).status).toBe(401)
    expect((await request('Bearer')).status).toBe(401)
    expect((await request('Bearer ')).status).toBe(401)
    expect((await request(credential)).status).toBe(401)
    expect((await request(`Basic ${credential}`)).status).toBe(401)
    expect((await request(`Token ${credential}`)).status).toBe(401)
    // La credencial correcta con esquema Bearer sí entra.
    expect((await request(`Bearer ${credential}`)).status).toBe(200)
  })

  it('propiedad: cualquier credencial al azar es 401', async () => {
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[\x21-\x7e]{0,300}$/), async (token) => {
        const r = await m.request('GET', '/v1/events/last', undefined, token)
        expect(r.status).toBe(401)
      }),
      { seed: SEED, numRuns: 40 },
    )
  })

  it('un hub revocado no sube ni lee, pero los demás hubs siguen', async () => {
    const a = await m.newHub()
    const b = await m.newHub()
    expect(
      (await m.request('POST', '/v1/events', { events: batch(1, 2) }, a.credential)).status,
    ).toBe(200)
    expect(
      (await m.request('POST', '/v1/admin/hubs/revoke', { hub_id: a.hub.id }, ADMIN)).status,
    ).toBe(204)
    expect(
      (await m.request('POST', '/v1/events', { events: batch(3, 2) }, a.credential)).status,
    ).toBe(401)
    expect((await m.request('GET', '/v1/events/last', undefined, a.credential)).status).toBe(401)
    expect(
      (await m.request('POST', '/v1/events', { events: batch(1, 2) }, b.credential)).status,
    ).toBe(200)
  })

  it('revocar dos veces o un hub que no existe es 404, y no cambia la fecha de revocación', async () => {
    const a = await m.newHub()
    const token = ADMIN
    expect(
      (await m.request('POST', '/v1/admin/hubs/revoke', { hub_id: a.hub.id }, token)).status,
    ).toBe(204)
    const [before] = (
      await m.db.query<{ r: string }>('SELECT revoked_at::text AS r FROM hubs WHERE id = $1', [
        a.hub.id,
      ])
    ).rows
    m.clock.now = new Date(NOW.getTime() + 60_000)
    try {
      expect(
        (await m.request('POST', '/v1/admin/hubs/revoke', { hub_id: a.hub.id }, token)).status,
      ).toBe(404)
    } finally {
      m.clock.now = NOW
    }
    const [after] = (
      await m.db.query<{ r: string }>('SELECT revoked_at::text AS r FROM hubs WHERE id = $1', [
        a.hub.id,
      ])
    ).rows
    expect(after).toEqual(before)
    expect(
      (await m.request('POST', '/v1/admin/hubs/revoke', { hub_id: newId() }, token)).status,
    ).toBe(404)
  })

  it('la credencial de un hub revocado guarda sus eventos anteriores (nada se borra)', async () => {
    const a = await m.newHub()
    await m.request('POST', '/v1/events', { events: batch(1, 3) }, a.credential)
    await m.request('POST', '/v1/admin/hubs/revoke', { hub_id: a.hub.id }, ADMIN)
    const n = (
      await m.db.query<{ n: number }>('SELECT count(*)::int AS n FROM events WHERE hub_id = $1', [
        a.hub.id,
      ])
    ).rows[0]
    expect(n?.n).toBe(3)
  })

  it('el token de administración no sirve como credencial de hub, y la credencial de hub no sirve como administración', async () => {
    const a = await m.newHub()
    expect((await m.request('GET', '/v1/events/last', undefined, ADMIN)).status).toBe(401)
    expect(
      (await m.request('POST', '/v1/admin/codes', { restaurant_id: a.restaurantId }, a.credential))
        .status,
    ).toBe(401)
  })

  it('un token de administración enorme, vacío o casi igual es 401', async () => {
    const { restaurantId } = await m.newHub()
    const cuerpo = { restaurant_id: restaurantId }
    for (const t of [
      '',
      'x',
      'A'.repeat(100_000),
      'token-de-administracion-de-prueb',
      'Token-de-administracion-de-prueba',
    ])
      expect((await m.request('POST', '/v1/admin/codes', cuerpo, t)).status, t.slice(0, 20)).toBe(
        401,
      )
  })
})
