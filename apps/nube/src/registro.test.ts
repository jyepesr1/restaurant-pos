import { nuevoId } from '@pos/core'
import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import { atender } from './api'
import { normalizarCodigo, VIGENCIA_CODIGO_MS } from './nube'
import { ADMIN, AHORA, crearMundo, lote, type Mundo, SEMILLA } from './pruebas/mundo'

// El registro de un hub con un código (ADR-016): un solo hub por código, vigencia de 24 horas,
// reintento del mismo hub, y credenciales que no sirven si son inventadas o el hub fue revocado.

let m: Mundo
beforeAll(async () => {
  m = await crearMundo()
})

async function restauranteConCodigo() {
  const restaurante = nuevoId()
  await m.nube.crearRestaurante({ id: restaurante, nombre: 'R' })
  const c = await m.nube.crearCodigo(restaurante)
  if (!c) throw new Error('sin código')
  return { restaurante, codigo: c.codigo, venceEn: c.venceEn }
}

const nuevoCodigoDe = async (restaurante: string) => {
  const c = await m.nube.crearCodigo(restaurante)
  if (!c) throw new Error('sin código')
  return c.codigo
}

const registrar = (codigo: string, hubId = nuevoId(), extras: Record<string, unknown> = {}) =>
  m.pedir('POST', '/v1/hubs/registro', {
    codigo,
    hub_id: hubId,
    sede_id: nuevoId(),
    nombre: 'Caja',
    instancia: 'i',
    ...extras,
  })

const hubsDe = async (restaurante: string) =>
  (await m.db.query<{ id: string }>('SELECT id FROM hub WHERE restaurante_id = $1', [restaurante]))
    .rows

describe('código de un solo uso', () => {
  it('con registros concurrentes del mismo código, solo uno gana', async () => {
    const { restaurante, codigo } = await restauranteConCodigo()
    const respuestas = await Promise.all(Array.from({ length: 8 }, () => registrar(codigo)))
    const estados = respuestas.map((r) => r.status).sort()
    expect(estados).toEqual([201, 403, 403, 403, 403, 403, 403, 403])
    expect(await hubsDe(restaurante)).toHaveLength(1)
  })

  it('con el mismo código escrito de varias formas a la vez, solo uno gana', async () => {
    const { restaurante, codigo } = await restauranteConCodigo()
    const formas = [
      codigo,
      codigo.toLowerCase(),
      codigo.replaceAll('-', ''),
      ` ${codigo} `,
      codigo.replaceAll('-', ' '),
    ]
    const respuestas = await Promise.all(formas.map((c) => registrar(c)))
    expect(respuestas.filter((r) => r.status === 201)).toHaveLength(1)
    expect(await hubsDe(restaurante)).toHaveLength(1)
  })

  it('el mismo hub repitiendo el registro a la vez con el mismo código: queda una sola credencial válida', async () => {
    const { restaurante, codigo } = await restauranteConCodigo()
    const hubId = nuevoId()
    const respuestas = await Promise.all(Array.from({ length: 4 }, () => registrar(codigo, hubId)))
    expect(respuestas.map((r) => r.status)).toEqual([201, 201, 201, 201])
    expect(await hubsDe(restaurante)).toHaveLength(1)
    const credenciales = await Promise.all(
      respuestas.map(async (r) => ((await r.json()) as { credencial: string }).credencial),
    )
    const validas = await Promise.all(credenciales.map((c) => m.nube.autenticar(c)))
    expect(validas.filter((h) => h !== null)).toHaveLength(1)
  })

  it('un código usado por otro hub no sirve para un tercero', async () => {
    const { codigo } = await restauranteConCodigo()
    expect((await registrar(codigo)).status).toBe(201)
    expect((await registrar(codigo)).status).toBe(403)
    expect((await registrar(codigo.toLowerCase())).status).toBe(403)
  })

  it('el mismo hub puede repetir el registro con su código (respuesta perdida): credencial nueva, la anterior deja de servir', async () => {
    const { restaurante, codigo } = await restauranteConCodigo()
    const hubId = nuevoId()
    const primera = (await (await registrar(codigo, hubId)).json()) as { credencial: string }
    const r2 = await registrar(codigo, hubId)
    expect(r2.status).toBe(201)
    const segunda = (await r2.json()) as { credencial: string; restaurante_id: string }
    expect(segunda.restaurante_id).toBe(restaurante)
    expect(segunda.credencial).not.toBe(primera.credencial)
    expect(await m.nube.autenticar(primera.credencial)).toBeNull()
    expect((await m.nube.autenticar(segunda.credencial))?.id).toBe(hubId)
    expect(await hubsDe(restaurante)).toHaveLength(1)
  })

  it('el reintento tras vencer el código ya no sirve', async () => {
    const { codigo } = await restauranteConCodigo()
    const hubId = nuevoId()
    expect((await registrar(codigo, hubId)).status).toBe(201)
    m.reloj.ahora = new Date(AHORA.getTime() + VIGENCIA_CODIGO_MS + 1)
    try {
      expect((await registrar(codigo, hubId)).status).toBe(403)
    } finally {
      m.reloj.ahora = AHORA
    }
  })

  it('el mismo hub con otro código es 409 y el otro código queda sin usar', async () => {
    const a = await restauranteConCodigo()
    const hubId = nuevoId()
    expect((await registrar(a.codigo, hubId)).status).toBe(201)
    const otro = await nuevoCodigoDe(a.restaurante)
    expect((await registrar(otro, hubId)).status).toBe(409)
    // El código que no se gastó sigue sirviendo para un hub distinto.
    expect((await registrar(otro)).status).toBe(201)
  })

  it('el mismo hub con dos códigos distintos a la vez: uno gana y el otro es 409, nunca 500', async () => {
    const a = await restauranteConCodigo()
    const otro = await nuevoCodigoDe(a.restaurante)
    const hubId = nuevoId()
    const [r1, r2] = await Promise.all([registrar(a.codigo, hubId), registrar(otro, hubId)])
    expect([r1.status, r2.status].sort()).toEqual([201, 409])
  })

  it('un hub revocado no puede volver a registrarse con su código', async () => {
    const { codigo } = await restauranteConCodigo()
    const hubId = nuevoId()
    const { credencial } = (await (await registrar(codigo, hubId)).json()) as { credencial: string }
    expect((await m.pedir('POST', '/v1/admin/hubs/revocar', { hub_id: hubId }, ADMIN)).status).toBe(
      204,
    )
    expect((await registrar(codigo, hubId)).status).toBe(403)
    expect(await m.nube.autenticar(credencial)).toBeNull()
  })

  it('el código no se guarda en claro ni la credencial: solo su huella', async () => {
    const { codigo } = await restauranteConCodigo()
    const { credencial } = (await (await registrar(codigo)).json()) as { credencial: string }
    const guardado = JSON.stringify([
      (await m.db.query('SELECT * FROM codigo_registro')).rows,
      (await m.db.query('SELECT * FROM hub')).rows,
    ])
    expect(guardado).not.toContain(credencial)
    expect(guardado).not.toContain(normalizarCodigo(codigo))
    expect(guardado).not.toContain(codigo)
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
        const { restaurante, codigo } = await restauranteConCodigo()
        const letras = codigo.replaceAll('-', '')
        const escrito = [...letras]
          .map((c, i) => `${separadores[i]}${minusculas[i] ? c.toLowerCase() : c}`)
          .join('')
          .concat(separadores[12] ?? '')
        expect(escrito.length).toBeLessThanOrEqual(40)
        const r = await registrar(escrito)
        expect(r.status, JSON.stringify(escrito)).toBe(201)
        expect(await hubsDe(restaurante)).toHaveLength(1)
      }),
      { seed: SEMILLA, numRuns: 30 },
    )
  })

  it('una letra cambiada, de menos, de más, o con letras confundibles: 403 y el código sigue sirviendo', async () => {
    const { restaurante, codigo } = await restauranteConCodigo()
    const letras = codigo.replaceAll('-', '')
    const otra = letras[0] === 'A' ? 'B' : 'A'
    const malos = [
      `${otra}${letras.slice(1)}`,
      letras.slice(1),
      letras.slice(0, -1),
      `${letras}A`,
      `A${letras}`,
      letras.replaceAll(/[A-Z]/g, '0'),
      letras.replaceAll(/[2-9]/g, 'O'),
      `${letras.slice(0, 6)}${letras.slice(6).toLowerCase().replace(/[a-z]/, 'l')}`,
    ].filter((c) => normalizarCodigo(c) !== letras)
    for (const malo of malos) expect((await registrar(malo)).status, malo).toBe(403)
    expect(await hubsDe(restaurante)).toHaveLength(0)
    expect((await registrar(codigo)).status).toBe(201)
  })

  it('vacío, solo espacios o solo guiones: 403 (o 400 si ni llega) sin registrar nada', async () => {
    const { restaurante } = await restauranteConCodigo()
    for (const c of ['', ' ', '   ', '---', '- - -', '\t\n'])
      expect([400, 403], JSON.stringify(c)).toContain((await registrar(c)).status)
    expect(await hubsDe(restaurante)).toHaveLength(0)
  })

  it('un código de más de 40 caracteres es un cuerpo inválido', async () => {
    const r = await registrar('A'.repeat(41))
    expect(r.status).toBe(400)
    expect((await registrar('A'.repeat(100_000))).status).toBe(400)
  })

  it('propiedad: un texto cualquiera nunca registra un hub', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'binary', maxLength: 40 }), async (texto) => {
        const antes = (await m.db.query<{ n: number }>('SELECT count(*)::int AS n FROM hub'))
          .rows[0]
        const r = await registrar(texto)
        expect([400, 403]).toContain(r.status)
        const despues = (await m.db.query<{ n: number }>('SELECT count(*)::int AS n FROM hub'))
          .rows[0]
        expect(despues?.n).toBe(antes?.n)
      }),
      { seed: SEMILLA, numRuns: 40 },
    )
  })

  it('un cuerpo que además dice un restaurante_id no sirve para escoger restaurante', async () => {
    const { codigo } = await restauranteConCodigo()
    const r = await registrar(codigo, nuevoId(), { restaurante_id: nuevoId() })
    expect(r.status).toBe(400)
  })
})

describe('vigencia del código', () => {
  it('vence exactamente a las 24 horas: un milisegundo antes sirve, justo en el instante ya no', async () => {
    const a = await restauranteConCodigo()
    const b = await restauranteConCodigo()
    expect(a.venceEn).toBe(new Date(AHORA.getTime() + VIGENCIA_CODIGO_MS).toISOString())
    try {
      m.reloj.ahora = new Date(AHORA.getTime() + VIGENCIA_CODIGO_MS - 1)
      expect((await registrar(a.codigo)).status).toBe(201)
      m.reloj.ahora = new Date(AHORA.getTime() + VIGENCIA_CODIGO_MS)
      expect((await registrar(b.codigo)).status).toBe(403)
    } finally {
      m.reloj.ahora = AHORA
    }
  })

  it('un código vencido no se puede registrar aunque nadie lo haya usado, y uno nuevo sí', async () => {
    const { restaurante, codigo } = await restauranteConCodigo()
    try {
      m.reloj.ahora = new Date(AHORA.getTime() + 3 * VIGENCIA_CODIGO_MS)
      expect((await registrar(codigo)).status).toBe(403)
      expect((await registrar(await nuevoCodigoDe(restaurante))).status).toBe(201)
    } finally {
      m.reloj.ahora = AHORA
    }
  })

  it('un reloj atrasado en la nube no vence un código antes de tiempo (se compara contra el reloj de la nube)', async () => {
    const { codigo } = await restauranteConCodigo()
    try {
      // Reloj muy adelantado = código vencido; muy atrasado = código aún vigente.
      m.reloj.ahora = new Date(AHORA.getTime() - 5 * VIGENCIA_CODIGO_MS)
      expect((await registrar(codigo)).status).toBe(201)
    } finally {
      m.reloj.ahora = AHORA
    }
  })
})

describe('código de otro restaurante', () => {
  it('registra el hub en el restaurante del código, no en otro', async () => {
    const a = await restauranteConCodigo()
    const b = await restauranteConCodigo()
    const r = await registrar(b.codigo)
    expect(((await r.json()) as { restaurante_id: string }).restaurante_id).toBe(b.restaurante)
    expect(await hubsDe(a.restaurante)).toHaveLength(0)
    expect(await hubsDe(b.restaurante)).toHaveLength(1)
  })

  it('crear un código para un restaurante que no existe no deja rastro', async () => {
    const r = await m.pedir('POST', '/v1/admin/codigos', { restaurante_id: nuevoId() }, ADMIN)
    expect(r.status).toBe(404)
  })
})

describe('credenciales', () => {
  it('una credencial inventada, vacía o enorme no sube eventos ni lee la secuencia', async () => {
    const eventos = lote(1, 2)
    for (const token of [
      'inventada',
      'x',
      'A'.repeat(43),
      'A'.repeat(100_000),
      '0'.repeat(200),
      'Bearer',
    ]) {
      expect(
        (await m.pedir('POST', '/v1/eventos', { eventos }, token)).status,
        token.slice(0, 20),
      ).toBe(401)
      expect((await m.pedir('GET', '/v1/eventos/ultima', undefined, token)).status).toBe(401)
    }
  })

  it('encabezados de autorización raros: sin esquema Bearer, vacíos o con partes de más', async () => {
    const { credencial } = await m.nuevoHub()
    const pedir = (autorizacion: string | null) =>
      atender(
        new Request('https://nube.faro.test/v1/eventos/ultima', {
          headers: autorizacion === null ? {} : { authorization: autorizacion },
        }),
        { sql: m.sql },
      )
    expect((await pedir(null)).status).toBe(401)
    expect((await pedir('')).status).toBe(401)
    expect((await pedir('Bearer')).status).toBe(401)
    expect((await pedir('Bearer ')).status).toBe(401)
    expect((await pedir(credencial)).status).toBe(401)
    expect((await pedir(`Basic ${credencial}`)).status).toBe(401)
    expect((await pedir(`Token ${credencial}`)).status).toBe(401)
    // La credencial correcta con esquema Bearer sí entra.
    expect((await pedir(`Bearer ${credencial}`)).status).toBe(200)
  })

  it('propiedad: cualquier credencial al azar es 401', async () => {
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[\x21-\x7e]{0,300}$/), async (token) => {
        const r = await m.pedir('GET', '/v1/eventos/ultima', undefined, token)
        expect(r.status).toBe(401)
      }),
      { seed: SEMILLA, numRuns: 40 },
    )
  })

  it('un hub revocado no sube ni lee, pero los demás hubs siguen', async () => {
    const a = await m.nuevoHub()
    const b = await m.nuevoHub()
    expect(
      (await m.pedir('POST', '/v1/eventos', { eventos: lote(1, 2) }, a.credencial)).status,
    ).toBe(200)
    expect(
      (await m.pedir('POST', '/v1/admin/hubs/revocar', { hub_id: a.hub.id }, ADMIN)).status,
    ).toBe(204)
    expect(
      (await m.pedir('POST', '/v1/eventos', { eventos: lote(3, 2) }, a.credencial)).status,
    ).toBe(401)
    expect((await m.pedir('GET', '/v1/eventos/ultima', undefined, a.credencial)).status).toBe(401)
    expect(
      (await m.pedir('POST', '/v1/eventos', { eventos: lote(1, 2) }, b.credencial)).status,
    ).toBe(200)
  })

  it('revocar dos veces o un hub que no existe es 404, y no cambia la fecha de revocación', async () => {
    const a = await m.nuevoHub()
    const token = ADMIN
    expect(
      (await m.pedir('POST', '/v1/admin/hubs/revocar', { hub_id: a.hub.id }, token)).status,
    ).toBe(204)
    const [antes] = (
      await m.db.query<{ r: string }>('SELECT revocado_en::text AS r FROM hub WHERE id = $1', [
        a.hub.id,
      ])
    ).rows
    m.reloj.ahora = new Date(AHORA.getTime() + 60_000)
    try {
      expect(
        (await m.pedir('POST', '/v1/admin/hubs/revocar', { hub_id: a.hub.id }, token)).status,
      ).toBe(404)
    } finally {
      m.reloj.ahora = AHORA
    }
    const [despues] = (
      await m.db.query<{ r: string }>('SELECT revocado_en::text AS r FROM hub WHERE id = $1', [
        a.hub.id,
      ])
    ).rows
    expect(despues).toEqual(antes)
    expect(
      (await m.pedir('POST', '/v1/admin/hubs/revocar', { hub_id: nuevoId() }, token)).status,
    ).toBe(404)
  })

  it('la credencial de un hub revocado guarda sus eventos anteriores (nada se borra)', async () => {
    const a = await m.nuevoHub()
    await m.pedir('POST', '/v1/eventos', { eventos: lote(1, 3) }, a.credencial)
    await m.pedir('POST', '/v1/admin/hubs/revocar', { hub_id: a.hub.id }, ADMIN)
    const n = (
      await m.db.query<{ n: number }>('SELECT count(*)::int AS n FROM evento WHERE hub_id = $1', [
        a.hub.id,
      ])
    ).rows[0]
    expect(n?.n).toBe(3)
  })

  it('el token de administración no sirve como credencial de hub, y la credencial de hub no sirve como administración', async () => {
    const a = await m.nuevoHub()
    expect((await m.pedir('GET', '/v1/eventos/ultima', undefined, ADMIN)).status).toBe(401)
    expect(
      (
        await m.pedir(
          'POST',
          '/v1/admin/codigos',
          { restaurante_id: a.restauranteId },
          a.credencial,
        )
      ).status,
    ).toBe(401)
  })

  it('un token de administración enorme, vacío o casi igual es 401', async () => {
    const { restauranteId } = await m.nuevoHub()
    const cuerpo = { restaurante_id: restauranteId }
    for (const t of [
      '',
      'x',
      'A'.repeat(100_000),
      'token-de-administracion-de-prueb',
      'Token-de-administracion-de-prueba',
    ])
      expect((await m.pedir('POST', '/v1/admin/codigos', cuerpo, t)).status, t.slice(0, 20)).toBe(
        401,
      )
  })
})
