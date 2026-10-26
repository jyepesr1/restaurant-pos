import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import { MAX_BYTES_EVENTO } from './nube'
import {
  contar,
  crearMundo,
  eventoPlano,
  eventosGuardados,
  type Mundo,
  SEMILLA,
  statuses,
} from './pruebas/mundo'

// Los bordes de un evento y de la secuencia de subida: formato, tamaño, caracteres que Postgres
// no acepta, y «hasta dónde está todo» (last_sequence contigua desde 1).

let m: Mundo
beforeAll(async () => {
  m = await crearMundo()
})

const mayorContigua = (secuencias: number[]) => {
  const conjunto = new Set(secuencias)
  let k = 0
  while (conjunto.has(k + 1)) k++
  return k
}

describe('ultima_secuencia: contigua desde 1', () => {
  it('sin eventos es 0, y con huecos se queda antes del hueco', async () => {
    const { hub } = await m.nuevoHub()
    expect(await m.nube.lastSequence(hub)).toBe(0)
    await m.nube.recibirEventos(hub, [
      eventoPlano(1),
      eventoPlano(2),
      eventoPlano(4),
      eventoPlano(5),
    ])
    expect(await m.nube.lastSequence(hub)).toBe(2)
    await m.nube.recibirEventos(hub, [eventoPlano(3)])
    expect(await m.nube.lastSequence(hub)).toBe(5)
  })

  it('si falta la secuencia 1, es 0 aunque haya eventos guardados', async () => {
    const { hub } = await m.nuevoHub()
    await m.nube.recibirEventos(hub, [eventoPlano(2), eventoPlano(3)])
    expect(await m.nube.lastSequence(hub)).toBe(0)
  })

  it('propiedad: sin importar el orden, el reparto en lotes ni los reenvíos, es la mayor k con 1..k completo', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 25 }), { minLength: 1, maxLength: 40 }),
        fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 8 }),
        async (secuencias, sizes) => {
          const { hub } = await m.nuevoHub()
          let previous = 0
          let from = 0
          let i = 0
          const llegados: number[] = []
          while (from < secuencias.length) {
            const tam = sizes[i++ % sizes.length] ?? 1
            const trozo = secuencias.slice(from, from + tam)
            await m.nube.recibirEventos(
              hub,
              trozo.map((s) => eventoPlano(s)),
            )
            llegados.push(...trozo)
            from += tam
            const ahora = await m.nube.lastSequence(hub)
            expect(ahora).toBe(mayorContigua(llegados))
            // Nunca retrocede.
            expect(ahora).toBeGreaterThanOrEqual(previous)
            previous = ahora
          }
        },
      ),
      { seed: SEMILLA, numRuns: 25 },
    )
  })

  it('dos eventos con la misma secuencia del hub (ids distintos) no la cuentan dos veces', async () => {
    const { hub } = await m.nuevoHub()
    await m.nube.recibirEventos(hub, [
      eventoPlano(1),
      eventoPlano(2, { sequence: 1 }),
      eventoPlano(3, { sequence: 2 }),
    ])
    expect(await m.nube.lastSequence(hub)).toBe(2)
  })

  it('un evento inválido no cuenta: el hub debe reenviarlo', async () => {
    const { hub } = await m.nuevoHub()
    await m.nube.recibirEventos(hub, [
      eventoPlano(1),
      { ...eventoPlano(2), data: 'x' },
      eventoPlano(3),
    ])
    expect(await m.nube.lastSequence(hub)).toBe(1)
  })

  it('una variante distinta de un evento guardado no mueve la secuencia', async () => {
    const { hub } = await m.nuevoHub()
    await m.nube.recibirEventos(hub, [eventoPlano(1)])
    await m.nube.recibirEventos(hub, [
      eventoPlano(2),
      eventoPlano(1, { sequence: 3, data: { v: 1 } }),
    ])
    expect(await m.nube.lastSequence(hub)).toBe(2)
  })

  it('dos hubs del mismo restaurante llevan cada uno su cuenta', async () => {
    const a = await m.nuevoHub()
    await m.nube.recibirEventos(a.hub, [eventoPlano(1), eventoPlano(2)])
    const b = await m.nuevoHub()
    await m.nube.recibirEventos(b.hub, [eventoPlano(101, { sequence: 1 })])
    expect(await m.nube.lastSequence(a.hub)).toBe(2)
    expect(await m.nube.lastSequence(b.hub)).toBe(1)
  })

  it('muchos eventos a la vez: 500 en un lote y la secuencia llega a 500', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const r = await m.nube.recibirEventos(
      hub,
      Array.from({ length: 500 }, (_, i) => eventoPlano(i + 1)),
    )
    expect(statuses(r).every((e) => e === 'saved')).toBe(true)
    expect(await m.nube.lastSequence(hub)).toBe(500)
    expect(await contar(m.db, 'events', restauranteId)).toBe(500)
  })

  it('una secuencia muy grande (límite de enteros seguros) se guarda sin perder precisión', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const [r] = await m.nube.recibirEventos(hub, [
      eventoPlano(1, { sequence: Number.MAX_SAFE_INTEGER }),
    ])
    expect(r?.status).toBe('saved')
    const [fila] = await eventosGuardados(m.db, restauranteId)
    expect(fila?.hub_sequence).toBe(String(Number.MAX_SAFE_INTEGER))
    expect(await m.nube.lastSequence(hub)).toBe(0)
  })
})

describe('formato de un evento', () => {
  const invalidCases: [string, Record<string, unknown>][] = [
    ['sin id', { id: undefined }],
    ['id que no es ULID', { id: 'abc' }],
    ['id con letras que no existen (I, L, O, U)', { id: 'I'.repeat(26) }],
    ['id en minúsculas', { id: '0e'.padEnd(26, 'a') }],
    ['id numérico', { id: 12345 }],
    ['tipo vacío', { type: '' }],
    ['tipo de más de 60 caracteres', { type: 'x'.repeat(61) }],
    ['aggregate_type vacío', { aggregate_type: '' }],
    ['aggregate_type largo', { aggregate_type: 'x'.repeat(31) }],
    ['aggregate_id corto', { aggregate_id: 'ABC' }],
    ['secuencia 0', { sequence: 0 }],
    ['secuencia negativa', { sequence: -1 }],
    ['secuencia decimal', { sequence: 1.5 }],
    ['secuencia como texto', { sequence: '1' }],
    ['secuencia mayor que un entero seguro', { sequence: 2 ** 60 }],
    ['secuencia nula', { sequence: null }],
    ['received_at sin zona horaria', { received_at: '2026-10-26T15:00:00' }],
    ['received_at que no es fecha', { received_at: 'yesterday' }],
    ['business_day con otro formato', { business_day: '26/10/2026' }],
    ['business_day imposible', { business_day: '2026-02-30' }],
    ['business_day mes 13', { business_day: '2026-13-01' }],
    ['datos nulos', { data: null }],
    ['datos como lista', { data: [] }],
    ['datos como texto', { data: 'x' }],
    ['sin datos', { data: undefined }],
  ]

  it.each(invalidCases)('%s: es inválido y no tumba al resto del lote', async (_nombre, change) => {
    const { hub, restauranteId } = await m.nuevoHub()
    const badCase = { ...eventoPlano(2), ...change }
    const r = await m.nube.recibirEventos(hub, [eventoPlano(1), badCase, eventoPlano(3)])
    expect(r[1]?.status).toBe('invalid')
    expect([r[0]?.status, r[2]?.status]).toEqual(['saved', 'saved'])
    expect(await contar(m.db, 'events', restauranteId)).toBe(2)
  })

  it('lo que no es objeto (null, números, texto, listas) es inválido y no devuelve un id', async () => {
    const { hub } = await m.nuevoHub()
    const r = await m.nube.recibirEventos(hub, [null, 1, 'x', [], true, undefined, {}])
    expect(r).toEqual(Array(7).fill({ id: null, status: 'invalid', reason: 'format' }))
  })

  it('un id inválido que es un texto largo no se devuelve al hub (no se repite cualquier cosa)', async () => {
    const { hub } = await m.nuevoHub()
    const [r] = await m.nube.recibirEventos(hub, [{ ...eventoPlano(1), id: 'x'.repeat(5000) }])
    expect(r).toEqual({ id: null, status: 'invalid', reason: 'format' })
  })

  it('campos de más se conservan (la nube no rechaza lo que el hub aceptó)', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const e = eventoPlano(1, {
      schema_version: 3,
      related: [],
      campo_futuro: { a: [1, 2, { b: null }] },
    })
    const [r] = await m.nube.recibirEventos(hub, [e])
    expect(r?.status).toBe('saved')
    const [fila] = await eventosGuardados(m.db, restauranteId)
    expect(fila?.content).toEqual(e)
  })

  it('la misma estructura inválida dos veces en el lote se responde dos veces', async () => {
    const { hub } = await m.nuevoHub()
    const badCase = { ...eventoPlano(1), sequence: 0 }
    const r = await m.nube.recibirEventos(hub, [badCase, badCase])
    expect(statuses(r)).toEqual(['invalid', 'invalid'])
  })

  it('un lote entero de inválidos no toca la base', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const r = await m.nube.recibirEventos(hub, [{}, { id: 'x' }])
    expect(statuses(r)).toEqual(['invalid', 'invalid'])
    expect(await contar(m.db, 'events', restauranteId)).toBe(0)
  })

  it('propiedad: con datos arbitrarios nunca falla el lote entero; cada evento es guardado o inválido', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.jsonValue(), { minLength: 1, maxLength: 6 }),
        async (cualquiera) => {
          const { hub } = await m.nuevoHub()
          const events = cualquiera.map((v, i) => eventoPlano(i + 1, { data: { v } }))
          const r = await m.nube.recibirEventos(hub, [...events, ...cualquiera])
          expect(r).toHaveLength(events.length + cualquiera.length)
          for (const x of r.slice(0, events.length))
            expect(['saved', 'invalid']).toContain(x.status)
          for (const x of r.slice(events.length)) expect(x.status).toBe('invalid')
        },
      ),
      { seed: SEMILLA, numRuns: 25 },
    )
  })
})

describe('tamaño', () => {
  /** Un evento cuyo JSON mide exactamente `bytes` bytes. */
  function conTamano(n: number, bytes: number) {
    const base = eventoPlano(n, { data: { notes: '' } })
    const empty = new TextEncoder().encode(JSON.stringify(base)).length
    return { ...base, data: { notes: 'x'.repeat(bytes - empty) } }
  }

  it('el límite es exacto: 64 KB entra, un byte más no', async () => {
    const { hub } = await m.nuevoHub()
    const justo = conTamano(1, MAX_BYTES_EVENTO)
    const demas = conTamano(2, MAX_BYTES_EVENTO + 1)
    expect(new TextEncoder().encode(JSON.stringify(justo)).length).toBe(MAX_BYTES_EVENTO)
    const r = await m.nube.recibirEventos(hub, [justo, demas])
    expect(r).toEqual([
      { id: justo.id, status: 'saved' },
      { id: demas.id, status: 'invalid', reason: 'too_large' },
    ])
  })

  it('el límite se mide en bytes, no en caracteres (tildes y emojis pesan más)', async () => {
    const { hub } = await m.nuevoHub()
    const e = eventoPlano(1, { data: { notes: 'ñ'.repeat(MAX_BYTES_EVENTO / 2) } })
    const [r] = await m.nube.recibirEventos(hub, [e])
    expect(r?.status).toBe('invalid')
    const emojis = eventoPlano(2, { data: { notes: '🍺'.repeat(MAX_BYTES_EVENTO / 4) } })
    const [r2] = await m.nube.recibirEventos(hub, [emojis])
    expect(r2?.status).toBe('invalid')
  })

  it('un evento enorme que se repite en el lote no se cuenta como guardado', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const large = conTamano(1, MAX_BYTES_EVENTO + 10)
    const r = await m.nube.recibirEventos(hub, [large, large])
    expect(statuses(r)).toEqual(['invalid', 'invalid'])
    expect(await contar(m.db, 'events', restauranteId)).toBe(0)
  })
})

describe('texto que Postgres no acepta', () => {
  const casos: [string, (text: string) => Record<string, unknown>][] = [
    ['\\u0000 en un dato', (t) => ({ data: { note: t } })],
    ['\\u0000 en el nombre de un dato', (t) => ({ data: { [t]: 1 } })],
    ['\\u0000 en una lista anidada', (t) => ({ data: { a: [{ b: [t] }] } })],
    ['\\u0000 en el tipo', (t) => ({ type: t })],
    ['\\u0000 en un campo extra', (t) => ({ extra: t })],
    ['\\u0000 en el nombre de un campo extra', (t) => ({ [t]: 1 })],
  ]
  const malos = ['a\u0000b', '\ud800', 'x\udfff', '\u0000']
  for (const [name, hacer] of casos)
    it(`${name} o un sustituto suelto: ese evento es inválido y el lote sigue`, async () => {
      const { hub, restauranteId } = await m.nuevoHub()
      for (const [i, t] of malos.entries()) {
        const r = await m.nube.recibirEventos(hub, [
          eventoPlano(10 * i + 1),
          eventoPlano(10 * i + 2, hacer(t)),
          eventoPlano(10 * i + 3),
        ])
        expect(r[1], JSON.stringify(t)).toMatchObject({
          status: 'invalid',
          reason: 'invalid_character',
        })
        expect([r[0]?.status, r[2]?.status]).toEqual(['saved', 'saved'])
      }
      expect(await contar(m.db, 'events', restauranteId)).toBe(malos.length * 2)
    })

  it('texto válido raro (emojis, tildes, ñ, controles comunes, par sustituto completo) sí se guarda', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const notes = 'Té con ñandú 🍹 \t\n\r   \u{1F600} \u0001'
    const [r] = await m.nube.recibirEventos(hub, [eventoPlano(1, { data: { notes } })])
    expect(r?.status).toBe('saved')
    const [fila] = await eventosGuardados(m.db, restauranteId)
    expect(fila?.content).toMatchObject({ data: { notes } })
  })

  it('propiedad: cualquier texto Unicode arbitrario nunca produce un error en el lote', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'binary', maxLength: 40 }), async (text) => {
        const { hub } = await m.nuevoHub()
        const [r, s] = await m.nube.recibirEventos(hub, [
          eventoPlano(1, { data: { text } }),
          eventoPlano(2),
        ])
        expect(['saved', 'invalid']).toContain(r?.status)
        expect(s?.status).toBe('saved')
      }),
      { seed: SEMILLA, numRuns: 40 },
    )
  })
})

describe('fechas en el borde de lo que acepta Postgres', () => {
  const fechas: Record<string, unknown>[] = [
    { received_at: '0000-01-01T00:00:00Z' },
    { received_at: '9999-12-31T23:59:59.999Z' },
    { received_at: '2026-10-26T15:00:00+23:59' },
    { received_at: '2026-10-26T15:00:00.123456789Z' },
    { business_day: '0000-01-01' },
    { business_day: '9999-12-31' },
    { business_day: '2024-02-29' },
    { business_day: '2026-02-29' },
  ]
  it.each(fechas)('%j: se guarda o se rechaza ese evento, sin romper el lote', async (f) => {
    const { hub } = await m.nuevoHub()
    const r = await m.nube.recibirEventos(hub, [eventoPlano(1), eventoPlano(2, f), eventoPlano(3)])
    expect([r[0]?.status, r[2]?.status]).toEqual(['saved', 'saved'])
    expect(['saved', 'invalid']).toContain(r[1]?.status)
  })

  it('un reloj del dispositivo desfasado (fecha en el futuro o en el pasado) no cambia lo guardado', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const e = eventoPlano(1, { received_at: '2031-01-01T00:00:00Z', business_day: '2019-05-05' })
    const [r] = await m.nube.recibirEventos(hub, [e])
    expect(r?.status).toBe('saved')
    const [fila] = await eventosGuardados(m.db, restauranteId)
    expect(fila?.content).toEqual(e)
    const [two] = await m.nube.recibirEventos(hub, [e])
    expect(two?.status).toBe('already_stored')
  })

  it('la fecha de guardado la pone la nube, no el evento', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    await m.nube.recibirEventos(hub, [eventoPlano(1, { received_at: '2000-01-01T00:00:00Z' })])
    const [fila] = (
      await m.db.query<{ vieja: boolean }>(
        "SELECT saved_at > '2020-01-01' AS vieja FROM events WHERE restaurant_id = $1",
        [restauranteId],
      )
    ).rows
    expect(fila?.vieja).toBe(true)
  })
})

describe('anidamiento extremo', () => {
  it('un dato anidado a miles de niveles no tumba el lote', async () => {
    const { hub } = await m.nuevoHub()
    let hondo: unknown = 'fin'
    for (let i = 0; i < 5000; i++) hondo = { a: hondo }
    const [a, b, c] = await m.nube.recibirEventos(hub, [
      eventoPlano(1),
      eventoPlano(2, { data: { hondo } }),
      eventoPlano(3),
    ])
    expect([a?.status, c?.status]).toEqual(['saved', 'saved'])
    expect(['saved', 'invalid']).toContain(b?.status)
  })
})
