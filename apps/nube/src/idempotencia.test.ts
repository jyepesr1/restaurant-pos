import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  contar,
  crearMundo,
  estados,
  eventoPlano,
  eventosGuardados,
  lote,
  type Mundo,
  SEMILLA,
} from './pruebas/mundo'

// Idempotencia de la subida de eventos (ADR-007, ADR-016): sin importar cuántas veces, en qué
// orden o partido en cuántos lotes llegue lo mismo, la nube termina con exactamente los mismos
// eventos. Una sola base para todo el archivo; cada corrida usa un restaurante nuevo, así que no
// se estorban.

const CORRIDAS = { seed: SEMILLA, numRuns: 25 }

let m: Mundo
beforeAll(async () => {
  m = await crearMundo()
})

describe('reenviar un lote', () => {
  it('N veces deja exactamente los mismos eventos, y el resto responde ya_estaba', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 2, max: 5 }),
        async (n, veces) => {
          const { hub, restauranteId } = await m.nuevoHub()
          const eventos = lote(1, n)
          const primero = await m.nube.recibirEventos(hub, eventos)
          expect(estados(primero).every((e) => e === 'guardado')).toBe(true)
          const antes = await eventosGuardados(m.db, restauranteId)
          for (let i = 1; i < veces; i++) {
            const otra = await m.nube.recibirEventos(hub, eventos)
            expect(otra.map((r) => r.id)).toEqual(eventos.map((e) => e.id))
            expect(estados(otra).every((e) => e === 'ya_estaba')).toBe(true)
          }
          expect(await eventosGuardados(m.db, restauranteId)).toEqual(antes)
          expect(await contar(m.db, 'evento_distinto', restauranteId)).toBe(0)
          expect(await m.nube.ultimaSecuencia(hub)).toBe(n)
        },
      ),
      CORRIDAS,
    )
  })

  it('en cualquier orden deja lo mismo que en orden', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 1, max: 300 }), { minLength: 1, maxLength: 40 }),
        async (numeros) => {
          const revuelto = await m.nuevoHub()
          const ordenado = await m.nuevoHub()
          const eventos = numeros.map((n) => eventoPlano(n))
          const enOrden = [...eventos].sort((a, b) => a.secuencia - b.secuencia)
          const r1 = await m.nube.recibirEventos(revuelto.hub, eventos)
          const r2 = await m.nube.recibirEventos(ordenado.hub, enOrden)
          // El resultado de cada evento sigue la posición en que llegó.
          expect(r1.map((r) => r.id)).toEqual(eventos.map((e) => e.id))
          expect(estados(r1)).toEqual(eventos.map(() => 'guardado'))
          expect(estados(r2)).toEqual(enOrden.map(() => 'guardado'))
          const quitarHub = (filas: Awaited<ReturnType<typeof eventosGuardados>>) =>
            filas.map(({ hub_id: _h, ...resto }) => resto)
          expect(quitarHub(await eventosGuardados(m.db, revuelto.restauranteId))).toEqual(
            quitarHub(await eventosGuardados(m.db, ordenado.restauranteId)),
          )
          expect(await m.nube.ultimaSecuencia(revuelto.hub)).toBe(
            await m.nube.ultimaSecuencia(ordenado.hub),
          )
        },
      ),
      CORRIDAS,
    )
  })

  it('partido en lotes de cualquier tamaño (con o sin solape) deja lo mismo que de una vez', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 1, max: 300 }), { minLength: 1, maxLength: 40 }),
        fc.array(fc.integer({ min: 1, max: 8 }), { minLength: 1, maxLength: 10 }),
        fc.boolean(),
        async (numeros, tamanos, solape) => {
          const entero = await m.nuevoHub()
          const partido = await m.nuevoHub()
          const eventos = numeros.map((n) => eventoPlano(n))
          await m.nube.recibirEventos(entero.hub, eventos)
          let desde = 0
          let i = 0
          const guardadosEnTotal = new Map<string, number>()
          while (desde < eventos.length) {
            const tam = tamanos[i++ % tamanos.length] ?? 1
            const trozo = eventos.slice(desde, desde + tam)
            // Con solape, el lote repite los dos últimos eventos del anterior (un reintento a medias).
            const enviado = solape
              ? [...eventos.slice(Math.max(0, desde - 2), desde), ...trozo]
              : trozo
            const r = await m.nube.recibirEventos(partido.hub, enviado)
            for (const x of r)
              if (x.estado === 'guardado' && x.id)
                guardadosEnTotal.set(x.id, (guardadosEnTotal.get(x.id) ?? 0) + 1)
            desde += tam
          }
          // Cada evento se guardó exactamente una vez en todo el recorrido.
          expect([...guardadosEnTotal.values()].every((v) => v === 1)).toBe(true)
          expect(guardadosEnTotal.size).toBe(eventos.length)
          const quitarHub = (filas: Awaited<ReturnType<typeof eventosGuardados>>) =>
            filas.map(({ hub_id: _h, ...resto }) => resto)
          expect(quitarHub(await eventosGuardados(m.db, partido.restauranteId))).toEqual(
            quitarHub(await eventosGuardados(m.db, entero.restauranteId)),
          )
        },
      ),
      CORRIDAS,
    )
  })

  it('un lote con una parte ya guardada responde cada evento en su posición', async () => {
    const { hub } = await m.nuevoHub()
    const eventos = lote(1, 6)
    await m.nube.recibirEventos(hub, [eventos[1], eventos[4]] as never)
    const r = await m.nube.recibirEventos(hub, eventos)
    expect(r.map((x) => [x.id, x.estado])).toEqual(
      eventos.map((e, i) => [e.id, i === 1 || i === 4 ? 'ya_estaba' : 'guardado']),
    )
  })
})

describe('el mismo id dentro del mismo lote', () => {
  it('con el mismo contenido: se guarda una vez y los demás son ya_estaba', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 15 }), { minLength: 1, maxLength: 40 }),
        async (numeros) => {
          const { hub, restauranteId } = await m.nuevoHub()
          const eventos = numeros.map((n) => eventoPlano(n))
          const r = await m.nube.recibirEventos(hub, eventos)
          const visto = new Set<number>()
          const esperado = numeros.map((n) => {
            const primero = !visto.has(n)
            visto.add(n)
            return primero ? 'guardado' : 'ya_estaba'
          })
          expect(estados(r)).toEqual(esperado)
          expect(await contar(m.db, 'evento', restauranteId)).toBe(new Set(numeros).size)
          expect(await contar(m.db, 'evento_distinto', restauranteId)).toBe(0)
        },
      ),
      CORRIDAS,
    )
  })

  it('con otro contenido: el primero se guarda y el segundo es distinto, sin pisar al primero', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const a = eventoPlano(1, { datos: { cantidad: 1 } })
    const b = eventoPlano(1, { datos: { cantidad: 99 } })
    const r = await m.nube.recibirEventos(hub, [a, b])
    expect(r.map((x) => x.estado)).toEqual(['guardado', 'distinto'])
    const [guardado] = await eventosGuardados(m.db, restauranteId)
    expect(guardado?.contenido).toMatchObject({ datos: { cantidad: 1 } })
  })

  it('con otro contenido: lo distinto queda registrado para revisión (no se descarta, ADR-007)', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const a = eventoPlano(1, { datos: { cantidad: 1 } })
    const b = eventoPlano(1, { datos: { cantidad: 99 } })
    await m.nube.recibirEventos(hub, [a, b])
    // La respuesta dijo «distinto» (queda para revisión): tiene que estar en evento_distinto.
    expect(await contar(m.db, 'evento_distinto', restauranteId)).toBe(1)
  })

  it('el orden decide cuál se guarda: el primero que llega', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const a = eventoPlano(1, { datos: { cantidad: 1 } })
    const b = eventoPlano(1, { datos: { cantidad: 99 } })
    await m.nube.recibirEventos(hub, [b, a])
    const [guardado] = await eventosGuardados(m.db, restauranteId)
    expect(guardado?.contenido).toMatchObject({ datos: { cantidad: 99 } })
  })
})

describe('lotes concurrentes con los mismos eventos', () => {
  it('el mismo lote enviado a la vez varias veces: cada evento se guarda una sola vez', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const eventos = lote(1, 30)
    const respuestas = await Promise.all(
      Array.from({ length: 6 }, () => m.nube.recibirEventos(hub, eventos)),
    )
    for (const e of eventos) {
      const veredictos = respuestas.map((r) => r.find((x) => x.id === e.id)?.estado)
      expect(veredictos.filter((v) => v === 'guardado')).toHaveLength(1)
      expect(veredictos.filter((v) => v === 'ya_estaba')).toHaveLength(5)
    }
    expect(await contar(m.db, 'evento', restauranteId)).toBe(30)
    expect(await contar(m.db, 'evento_distinto', restauranteId)).toBe(0)
  })

  it('lotes que se solapan, a la vez y en distinto orden: la unión exacta, sin duplicados', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const todos = lote(1, 40)
    const lotes = [
      todos.slice(0, 20),
      todos.slice(10, 30).reverse(),
      todos.slice(25),
      [...todos].reverse(),
    ]
    const respuestas = await Promise.all(lotes.map((l) => m.nube.recibirEventos(hub, l)))
    const guardados = respuestas.flat().filter((r) => r.estado === 'guardado')
    expect(new Set(guardados.map((g) => g.id)).size).toBe(40)
    expect(guardados).toHaveLength(40)
    expect(await contar(m.db, 'evento', restauranteId)).toBe(40)
    expect(await m.nube.ultimaSecuencia(hub)).toBe(40)
  })

  it('una variante con otro contenido enviada a la vez que el original: el guardado es uno de los dos y nada se pierde', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const a = eventoPlano(1, { datos: { cantidad: 1 } })
    const b = eventoPlano(1, { datos: { cantidad: 99 } })
    const [ra, rb] = await Promise.all([
      m.nube.recibirEventos(hub, [a]),
      m.nube.recibirEventos(hub, [b]),
    ])
    expect([ra[0]?.estado, rb[0]?.estado].sort()).toEqual(['distinto', 'guardado'])
    expect(await contar(m.db, 'evento', restauranteId)).toBe(1)
    expect(await contar(m.db, 'evento_distinto', restauranteId)).toBe(1)
  })

  it('el mismo lote subido a la vez por dos restaurantes: cada uno guarda el suyo', async () => {
    const a = await m.nuevoHub()
    const b = await m.nuevoHub()
    const eventos = lote(1, 10)
    const [ra, rb] = await Promise.all([
      m.nube.recibirEventos(a.hub, eventos),
      m.nube.recibirEventos(b.hub, eventos),
    ])
    expect(estados(ra).every((e) => e === 'guardado')).toBe(true)
    expect(estados(rb).every((e) => e === 'guardado')).toBe(true)
  })
})

describe('evento_distinto', () => {
  it('lo ya guardado no cambia nunca, y el mismo contenido distinto repetido no se duplica', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 2, max: 5 }),
        async (n, variantes, veces) => {
          const { hub, restauranteId } = await m.nuevoHub()
          const originales = lote(1, n)
          await m.nube.recibirEventos(hub, originales)
          const antes = await eventosGuardados(m.db, restauranteId)
          // `variantes` contenidos distintos por cada evento; cada uno se envía `veces` veces.
          const distintos = originales.flatMap((e) =>
            Array.from({ length: variantes }, (_, v) => ({
              ...e,
              datos: { ...e.datos, variante: v + 1 },
            })),
          )
          for (let i = 0; i < veces; i++) {
            const r = await m.nube.recibirEventos(
              hub,
              i % 2 === 0 ? distintos : [...distintos].reverse().map((x) => x),
            )
            // Los ids repetidos dentro del lote (varias variantes del mismo evento) se
            // responden todos «distinto»; ninguno es «guardado».
            expect(estados(r).every((e) => e === 'distinto')).toBe(true)
          }
          expect(await eventosGuardados(m.db, restauranteId)).toEqual(antes)
        },
      ),
      CORRIDAS,
    )
  })

  it('cada contenido distinto queda una sola vez, aunque llegue en lotes y veces distintas', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const original = eventoPlano(1)
    await m.nube.recibirEventos(hub, [original])
    const v1 = { ...original, datos: { cantidad: 77 } }
    const v2 = { ...original, datos: { cantidad: 78 } }
    for (const envio of [[v1], [v1], [v2], [v1], [v2], [original]]) {
      const [r] = await m.nube.recibirEventos(hub, envio)
      expect(r?.estado).toBe(envio[0] === original ? 'ya_estaba' : 'distinto')
    }
    expect(await contar(m.db, 'evento_distinto', restauranteId)).toBe(2)
    const [guardado] = await eventosGuardados(m.db, restauranteId)
    expect(guardado?.contenido).toEqual(original)
  })

  it('el mismo contenido distinto, enviado a la vez varias veces, queda una sola vez', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const original = eventoPlano(1)
    await m.nube.recibirEventos(hub, [original])
    const variante = { ...original, datos: { cantidad: 42 } }
    const r = await Promise.all(
      Array.from({ length: 5 }, () => m.nube.recibirEventos(hub, [variante])),
    )
    expect(r.every((x) => x[0]?.estado === 'distinto')).toBe(true)
    expect(await contar(m.db, 'evento_distinto', restauranteId)).toBe(1)
  })

  it('guarda quién lo mandó y el contenido recibido', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const original = eventoPlano(1)
    await m.nube.recibirEventos(hub, [original])
    const variante = { ...original, datos: { cantidad: 42 } }
    await m.nube.recibirEventos(hub, [variante])
    const filas = (
      await m.db.query<{ evento_id: string; hub_id: string; contenido: unknown }>(
        'SELECT evento_id, hub_id, contenido FROM evento_distinto WHERE restaurante_id = $1',
        [restauranteId],
      )
    ).rows
    expect(filas).toEqual([{ evento_id: original.id, hub_id: hub.id, contenido: variante }])
  })

  it('lo que no es parte de lo que pasó (secuencia_base, firma, orden de las claves) no cuenta como distinto', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const original = eventoPlano(1, { secuencia_base: 5, firma: 'a'.repeat(64) })
    await m.nube.recibirEventos(hub, [original])
    const reordenado = Object.fromEntries(
      Object.entries({ ...original, secuencia_base: 0, firma: 'b'.repeat(64) }).reverse(),
    )
    const [r] = await m.nube.recibirEventos(hub, [reordenado])
    expect(r?.estado).toBe('ya_estaba')
    expect(await contar(m.db, 'evento_distinto', restauranteId)).toBe(0)
  })

  it('cambiar cualquier campo con sentido sí lo hace distinto', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const base = eventoPlano(1)
    await m.nube.recibirEventos(hub, [base])
    const cambios: Record<string, unknown>[] = [
      { tipo: 'ItemAnulado' },
      { secuencia: 2 },
      { recibido_en: '2026-10-26T15:00:00.001Z' },
      { dia_operativo: '2026-10-27' },
      { agregado_id: eventoPlano(99).agregado_id },
      { campo_nuevo: 1 },
      { datos: {} },
    ]
    for (const cambio of cambios) {
      const [r] = await m.nube.recibirEventos(hub, [{ ...base, ...cambio }])
      expect(r?.estado, JSON.stringify(cambio)).toBe('distinto')
    }
    expect(await contar(m.db, 'evento_distinto', restauranteId)).toBe(cambios.length)
  })

  it('un hub de la misma sede que manda otro contenido para un id existente también queda para revisión', async () => {
    const a = await m.nuevoHub()
    const segundo = await m.nube.crearCodigo(a.restauranteId)
    if (!segundo) throw new Error('sin código')
    const reg = await m.nube.registrarHub({
      codigo: segundo.codigo,
      hub_id: eventoPlano(500).id,
      sede_id: a.hub.sedeId,
      nombre: 'Caja 2',
      instancia: 'i2',
    })
    if (!reg.ok) throw new Error(reg.motivo)
    const hub2 = await m.nube.autenticar(reg.credencial)
    if (!hub2) throw new Error('sin hub 2')
    const original = eventoPlano(1)
    await m.nube.recibirEventos(a.hub, [original])
    const [r] = await m.nube.recibirEventos(hub2, [{ ...original, datos: { x: 1 } }])
    expect(r?.estado).toBe('distinto')
    const [mismo] = await m.nube.recibirEventos(hub2, [original])
    expect(mismo?.estado).toBe('ya_estaba')
    // Cada hub ve su propia última secuencia: el segundo no subió nada.
    expect(await m.nube.ultimaSecuencia(hub2)).toBe(0)
    expect(await m.nube.ultimaSecuencia(a.hub)).toBe(1)
  })
})
