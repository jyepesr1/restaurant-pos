import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import { MAX_BYTES_EVENTO } from './nube'
import {
  contar,
  crearMundo,
  estados,
  eventoPlano,
  eventosGuardados,
  type Mundo,
  SEMILLA,
} from './pruebas/mundo'

// Los bordes de un evento y de la secuencia de subida: formato, tamaño, caracteres que Postgres
// no acepta, y «hasta dónde está todo» (ultima_secuencia contigua desde 1).

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
    expect(await m.nube.ultimaSecuencia(hub)).toBe(0)
    await m.nube.recibirEventos(hub, [
      eventoPlano(1),
      eventoPlano(2),
      eventoPlano(4),
      eventoPlano(5),
    ])
    expect(await m.nube.ultimaSecuencia(hub)).toBe(2)
    await m.nube.recibirEventos(hub, [eventoPlano(3)])
    expect(await m.nube.ultimaSecuencia(hub)).toBe(5)
  })

  it('si falta la secuencia 1, es 0 aunque haya eventos guardados', async () => {
    const { hub } = await m.nuevoHub()
    await m.nube.recibirEventos(hub, [eventoPlano(2), eventoPlano(3)])
    expect(await m.nube.ultimaSecuencia(hub)).toBe(0)
  })

  it('propiedad: sin importar el orden, el reparto en lotes ni los reenvíos, es la mayor k con 1..k completo', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 25 }), { minLength: 1, maxLength: 40 }),
        fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 8 }),
        async (secuencias, tamanos) => {
          const { hub } = await m.nuevoHub()
          let anterior = 0
          let desde = 0
          let i = 0
          const llegados: number[] = []
          while (desde < secuencias.length) {
            const tam = tamanos[i++ % tamanos.length] ?? 1
            const trozo = secuencias.slice(desde, desde + tam)
            await m.nube.recibirEventos(
              hub,
              trozo.map((s) => eventoPlano(s)),
            )
            llegados.push(...trozo)
            desde += tam
            const ahora = await m.nube.ultimaSecuencia(hub)
            expect(ahora).toBe(mayorContigua(llegados))
            // Nunca retrocede.
            expect(ahora).toBeGreaterThanOrEqual(anterior)
            anterior = ahora
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
      eventoPlano(2, { secuencia: 1 }),
      eventoPlano(3, { secuencia: 2 }),
    ])
    expect(await m.nube.ultimaSecuencia(hub)).toBe(2)
  })

  it('un evento inválido no cuenta: el hub debe reenviarlo', async () => {
    const { hub } = await m.nuevoHub()
    await m.nube.recibirEventos(hub, [
      eventoPlano(1),
      { ...eventoPlano(2), datos: 'x' },
      eventoPlano(3),
    ])
    expect(await m.nube.ultimaSecuencia(hub)).toBe(1)
  })

  it('una variante distinta de un evento guardado no mueve la secuencia', async () => {
    const { hub } = await m.nuevoHub()
    await m.nube.recibirEventos(hub, [eventoPlano(1)])
    await m.nube.recibirEventos(hub, [
      eventoPlano(2),
      eventoPlano(1, { secuencia: 3, datos: { v: 1 } }),
    ])
    expect(await m.nube.ultimaSecuencia(hub)).toBe(2)
  })

  it('dos hubs del mismo restaurante llevan cada uno su cuenta', async () => {
    const a = await m.nuevoHub()
    await m.nube.recibirEventos(a.hub, [eventoPlano(1), eventoPlano(2)])
    const b = await m.nuevoHub()
    await m.nube.recibirEventos(b.hub, [eventoPlano(101, { secuencia: 1 })])
    expect(await m.nube.ultimaSecuencia(a.hub)).toBe(2)
    expect(await m.nube.ultimaSecuencia(b.hub)).toBe(1)
  })

  it('muchos eventos a la vez: 500 en un lote y la secuencia llega a 500', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const r = await m.nube.recibirEventos(
      hub,
      Array.from({ length: 500 }, (_, i) => eventoPlano(i + 1)),
    )
    expect(estados(r).every((e) => e === 'guardado')).toBe(true)
    expect(await m.nube.ultimaSecuencia(hub)).toBe(500)
    expect(await contar(m.db, 'evento', restauranteId)).toBe(500)
  })

  it('una secuencia muy grande (límite de enteros seguros) se guarda sin perder precisión', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const [r] = await m.nube.recibirEventos(hub, [
      eventoPlano(1, { secuencia: Number.MAX_SAFE_INTEGER }),
    ])
    expect(r?.estado).toBe('guardado')
    const [fila] = await eventosGuardados(m.db, restauranteId)
    expect(fila?.secuencia_hub).toBe(String(Number.MAX_SAFE_INTEGER))
    expect(await m.nube.ultimaSecuencia(hub)).toBe(0)
  })
})

describe('formato de un evento', () => {
  const invalidos: [string, Record<string, unknown>][] = [
    ['sin id', { id: undefined }],
    ['id que no es ULID', { id: 'abc' }],
    ['id con letras que no existen (I, L, O, U)', { id: 'I'.repeat(26) }],
    ['id en minúsculas', { id: '0e'.padEnd(26, 'a') }],
    ['id numérico', { id: 12345 }],
    ['tipo vacío', { tipo: '' }],
    ['tipo de más de 60 caracteres', { tipo: 'x'.repeat(61) }],
    ['agregado_tipo vacío', { agregado_tipo: '' }],
    ['agregado_tipo largo', { agregado_tipo: 'x'.repeat(31) }],
    ['agregado_id corto', { agregado_id: 'ABC' }],
    ['secuencia 0', { secuencia: 0 }],
    ['secuencia negativa', { secuencia: -1 }],
    ['secuencia decimal', { secuencia: 1.5 }],
    ['secuencia como texto', { secuencia: '1' }],
    ['secuencia mayor que un entero seguro', { secuencia: 2 ** 60 }],
    ['secuencia nula', { secuencia: null }],
    ['recibido_en sin zona horaria', { recibido_en: '2026-10-26T15:00:00' }],
    ['recibido_en que no es fecha', { recibido_en: 'ayer' }],
    ['dia_operativo con otro formato', { dia_operativo: '26/10/2026' }],
    ['dia_operativo imposible', { dia_operativo: '2026-02-30' }],
    ['dia_operativo mes 13', { dia_operativo: '2026-13-01' }],
    ['datos nulos', { datos: null }],
    ['datos como lista', { datos: [] }],
    ['datos como texto', { datos: 'x' }],
    ['sin datos', { datos: undefined }],
  ]

  it.each(invalidos)('%s: es inválido y no tumba al resto del lote', async (_nombre, cambio) => {
    const { hub, restauranteId } = await m.nuevoHub()
    const malo = { ...eventoPlano(2), ...cambio }
    const r = await m.nube.recibirEventos(hub, [eventoPlano(1), malo, eventoPlano(3)])
    expect(r[1]?.estado).toBe('invalido')
    expect([r[0]?.estado, r[2]?.estado]).toEqual(['guardado', 'guardado'])
    expect(await contar(m.db, 'evento', restauranteId)).toBe(2)
  })

  it('lo que no es objeto (null, números, texto, listas) es inválido y no devuelve un id', async () => {
    const { hub } = await m.nuevoHub()
    const r = await m.nube.recibirEventos(hub, [null, 1, 'x', [], true, undefined, {}])
    expect(r).toEqual(Array(7).fill({ id: null, estado: 'invalido', motivo: 'formato' }))
  })

  it('un id inválido que es un texto largo no se devuelve al hub (no se repite cualquier cosa)', async () => {
    const { hub } = await m.nuevoHub()
    const [r] = await m.nube.recibirEventos(hub, [{ ...eventoPlano(1), id: 'x'.repeat(5000) }])
    expect(r).toEqual({ id: null, estado: 'invalido', motivo: 'formato' })
  })

  it('campos de más se conservan (la nube no rechaza lo que el hub aceptó)', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const e = eventoPlano(1, {
      version_esquema: 3,
      relacionados: [],
      campo_futuro: { a: [1, 2, { b: null }] },
    })
    const [r] = await m.nube.recibirEventos(hub, [e])
    expect(r?.estado).toBe('guardado')
    const [fila] = await eventosGuardados(m.db, restauranteId)
    expect(fila?.contenido).toEqual(e)
  })

  it('la misma estructura inválida dos veces en el lote se responde dos veces', async () => {
    const { hub } = await m.nuevoHub()
    const malo = { ...eventoPlano(1), secuencia: 0 }
    const r = await m.nube.recibirEventos(hub, [malo, malo])
    expect(estados(r)).toEqual(['invalido', 'invalido'])
  })

  it('un lote entero de inválidos no toca la base', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const r = await m.nube.recibirEventos(hub, [{}, { id: 'x' }])
    expect(estados(r)).toEqual(['invalido', 'invalido'])
    expect(await contar(m.db, 'evento', restauranteId)).toBe(0)
  })

  it('propiedad: con datos arbitrarios nunca falla el lote entero; cada evento es guardado o inválido', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.jsonValue(), { minLength: 1, maxLength: 6 }),
        async (cualquiera) => {
          const { hub } = await m.nuevoHub()
          const eventos = cualquiera.map((v, i) => eventoPlano(i + 1, { datos: { v } }))
          const r = await m.nube.recibirEventos(hub, [...eventos, ...cualquiera])
          expect(r).toHaveLength(eventos.length + cualquiera.length)
          for (const x of r.slice(0, eventos.length))
            expect(['guardado', 'invalido']).toContain(x.estado)
          for (const x of r.slice(eventos.length)) expect(x.estado).toBe('invalido')
        },
      ),
      { seed: SEMILLA, numRuns: 25 },
    )
  })
})

describe('tamaño', () => {
  /** Un evento cuyo JSON mide exactamente `bytes` bytes. */
  function conTamano(n: number, bytes: number) {
    const base = eventoPlano(n, { datos: { notas: '' } })
    const vacio = new TextEncoder().encode(JSON.stringify(base)).length
    return { ...base, datos: { notas: 'x'.repeat(bytes - vacio) } }
  }

  it('el límite es exacto: 64 KB entra, un byte más no', async () => {
    const { hub } = await m.nuevoHub()
    const justo = conTamano(1, MAX_BYTES_EVENTO)
    const demas = conTamano(2, MAX_BYTES_EVENTO + 1)
    expect(new TextEncoder().encode(JSON.stringify(justo)).length).toBe(MAX_BYTES_EVENTO)
    const r = await m.nube.recibirEventos(hub, [justo, demas])
    expect(r).toEqual([
      { id: justo.id, estado: 'guardado' },
      { id: demas.id, estado: 'invalido', motivo: 'demasiado_grande' },
    ])
  })

  it('el límite se mide en bytes, no en caracteres (tildes y emojis pesan más)', async () => {
    const { hub } = await m.nuevoHub()
    const e = eventoPlano(1, { datos: { notas: 'ñ'.repeat(MAX_BYTES_EVENTO / 2) } })
    const [r] = await m.nube.recibirEventos(hub, [e])
    expect(r?.estado).toBe('invalido')
    const emojis = eventoPlano(2, { datos: { notas: '🍺'.repeat(MAX_BYTES_EVENTO / 4) } })
    const [r2] = await m.nube.recibirEventos(hub, [emojis])
    expect(r2?.estado).toBe('invalido')
  })

  it('un evento enorme que se repite en el lote no se cuenta como guardado', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const grande = conTamano(1, MAX_BYTES_EVENTO + 10)
    const r = await m.nube.recibirEventos(hub, [grande, grande])
    expect(estados(r)).toEqual(['invalido', 'invalido'])
    expect(await contar(m.db, 'evento', restauranteId)).toBe(0)
  })
})

describe('texto que Postgres no acepta', () => {
  const casos: [string, (texto: string) => Record<string, unknown>][] = [
    ['\\u0000 en un dato', (t) => ({ datos: { nota: t } })],
    ['\\u0000 en el nombre de un dato', (t) => ({ datos: { [t]: 1 } })],
    ['\\u0000 en una lista anidada', (t) => ({ datos: { a: [{ b: [t] }] } })],
    ['\\u0000 en el tipo', (t) => ({ tipo: t })],
    ['\\u0000 en un campo extra', (t) => ({ extra: t })],
    ['\\u0000 en el nombre de un campo extra', (t) => ({ [t]: 1 })],
  ]
  const malos = ['a\u0000b', '\ud800', 'x\udfff', '\u0000']
  for (const [nombre, hacer] of casos)
    it(`${nombre} o un sustituto suelto: ese evento es inválido y el lote sigue`, async () => {
      const { hub, restauranteId } = await m.nuevoHub()
      for (const [i, t] of malos.entries()) {
        const r = await m.nube.recibirEventos(hub, [
          eventoPlano(10 * i + 1),
          eventoPlano(10 * i + 2, hacer(t)),
          eventoPlano(10 * i + 3),
        ])
        expect(r[1], JSON.stringify(t)).toMatchObject({
          estado: 'invalido',
          motivo: 'caracter_no_valido',
        })
        expect([r[0]?.estado, r[2]?.estado]).toEqual(['guardado', 'guardado'])
      }
      expect(await contar(m.db, 'evento', restauranteId)).toBe(malos.length * 2)
    })

  it('texto válido raro (emojis, tildes, ñ, controles comunes, par sustituto completo) sí se guarda', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const notas = 'Té con ñandú 🍹 \t\n\r   \u{1F600} \u0001'
    const [r] = await m.nube.recibirEventos(hub, [eventoPlano(1, { datos: { notas } })])
    expect(r?.estado).toBe('guardado')
    const [fila] = await eventosGuardados(m.db, restauranteId)
    expect(fila?.contenido).toMatchObject({ datos: { notas } })
  })

  it('propiedad: cualquier texto Unicode arbitrario nunca produce un error en el lote', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'binary', maxLength: 40 }), async (texto) => {
        const { hub } = await m.nuevoHub()
        const [r, s] = await m.nube.recibirEventos(hub, [
          eventoPlano(1, { datos: { texto } }),
          eventoPlano(2),
        ])
        expect(['guardado', 'invalido']).toContain(r?.estado)
        expect(s?.estado).toBe('guardado')
      }),
      { seed: SEMILLA, numRuns: 40 },
    )
  })
})

describe('fechas en el borde de lo que acepta Postgres', () => {
  const fechas: Record<string, unknown>[] = [
    { recibido_en: '0000-01-01T00:00:00Z' },
    { recibido_en: '9999-12-31T23:59:59.999Z' },
    { recibido_en: '2026-10-26T15:00:00+23:59' },
    { recibido_en: '2026-10-26T15:00:00.123456789Z' },
    { dia_operativo: '0000-01-01' },
    { dia_operativo: '9999-12-31' },
    { dia_operativo: '2024-02-29' },
    { dia_operativo: '2026-02-29' },
  ]
  it.each(fechas)('%j: se guarda o se rechaza ese evento, sin romper el lote', async (f) => {
    const { hub } = await m.nuevoHub()
    const r = await m.nube.recibirEventos(hub, [eventoPlano(1), eventoPlano(2, f), eventoPlano(3)])
    expect([r[0]?.estado, r[2]?.estado]).toEqual(['guardado', 'guardado'])
    expect(['guardado', 'invalido']).toContain(r[1]?.estado)
  })

  it('un reloj del dispositivo desfasado (fecha en el futuro o en el pasado) no cambia lo guardado', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const e = eventoPlano(1, { recibido_en: '2031-01-01T00:00:00Z', dia_operativo: '2019-05-05' })
    const [r] = await m.nube.recibirEventos(hub, [e])
    expect(r?.estado).toBe('guardado')
    const [fila] = await eventosGuardados(m.db, restauranteId)
    expect(fila?.contenido).toEqual(e)
    const [dos] = await m.nube.recibirEventos(hub, [e])
    expect(dos?.estado).toBe('ya_estaba')
  })

  it('la fecha de guardado la pone la nube, no el evento', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    await m.nube.recibirEventos(hub, [eventoPlano(1, { recibido_en: '2000-01-01T00:00:00Z' })])
    const [fila] = (
      await m.db.query<{ vieja: boolean }>(
        "SELECT guardado_en > '2020-01-01' AS vieja FROM evento WHERE restaurante_id = $1",
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
      eventoPlano(2, { datos: { hondo } }),
      eventoPlano(3),
    ])
    expect([a?.estado, c?.estado]).toEqual(['guardado', 'guardado'])
    expect(['guardado', 'invalido']).toContain(b?.estado)
  })
})
