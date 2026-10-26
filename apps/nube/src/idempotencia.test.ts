import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  batch,
  contar,
  crearMundo,
  eventoPlano,
  eventosGuardados,
  type Mundo,
  SEMILLA,
  statuses,
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
          const events = batch(1, n)
          const firstOne = await m.nube.recibirEventos(hub, events)
          expect(statuses(firstOne).every((e) => e === 'saved')).toBe(true)
          const before = await eventosGuardados(m.db, restauranteId)
          for (let i = 1; i < veces; i++) {
            const another = await m.nube.recibirEventos(hub, events)
            expect(another.map((r) => r.id)).toEqual(events.map((e) => e.id))
            expect(statuses(another).every((e) => e === 'already_stored')).toBe(true)
          }
          expect(await eventosGuardados(m.db, restauranteId)).toEqual(before)
          expect(await contar(m.db, 'divergent_events', restauranteId)).toBe(0)
          expect(await m.nube.lastSequence(hub)).toBe(n)
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
          const events = numeros.map((n) => eventoPlano(n))
          const inOrder = [...events].sort((a, b) => a.sequence - b.sequence)
          const r1 = await m.nube.recibirEventos(revuelto.hub, events)
          const r2 = await m.nube.recibirEventos(ordenado.hub, inOrder)
          // El resultado de cada evento sigue la posición en que llegó.
          expect(r1.map((r) => r.id)).toEqual(events.map((e) => e.id))
          expect(statuses(r1)).toEqual(events.map(() => 'saved'))
          expect(statuses(r2)).toEqual(inOrder.map(() => 'saved'))
          const quitarHub = (rows: Awaited<ReturnType<typeof eventosGuardados>>) =>
            rows.map(({ hub_id: _h, ...rest }) => rest)
          expect(quitarHub(await eventosGuardados(m.db, revuelto.restauranteId))).toEqual(
            quitarHub(await eventosGuardados(m.db, ordenado.restauranteId)),
          )
          expect(await m.nube.lastSequence(revuelto.hub)).toBe(
            await m.nube.lastSequence(ordenado.hub),
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
        async (numeros, sizes, solape) => {
          const entero = await m.nuevoHub()
          const partido = await m.nuevoHub()
          const events = numeros.map((n) => eventoPlano(n))
          await m.nube.recibirEventos(entero.hub, events)
          let from = 0
          let i = 0
          const guardadosEnTotal = new Map<string, number>()
          while (from < events.length) {
            const tam = sizes[i++ % sizes.length] ?? 1
            const trozo = events.slice(from, from + tam)
            // Con solape, el lote repite los dos últimos eventos del anterior (un reintento a medias).
            const sent = solape ? [...events.slice(Math.max(0, from - 2), from), ...trozo] : trozo
            const r = await m.nube.recibirEventos(partido.hub, sent)
            for (const x of r)
              if (x.status === 'saved' && x.id)
                guardadosEnTotal.set(x.id, (guardadosEnTotal.get(x.id) ?? 0) + 1)
            from += tam
          }
          // Cada evento se guardó exactamente una vez en todo el recorrido.
          expect([...guardadosEnTotal.values()].every((v) => v === 1)).toBe(true)
          expect(guardadosEnTotal.size).toBe(events.length)
          const quitarHub = (rows: Awaited<ReturnType<typeof eventosGuardados>>) =>
            rows.map(({ hub_id: _h, ...rest }) => rest)
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
    const events = batch(1, 6)
    await m.nube.recibirEventos(hub, [events[1], events[4]] as never)
    const r = await m.nube.recibirEventos(hub, events)
    expect(r.map((x) => [x.id, x.status])).toEqual(
      events.map((e, i) => [e.id, i === 1 || i === 4 ? 'already_stored' : 'saved']),
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
          const events = numeros.map((n) => eventoPlano(n))
          const r = await m.nube.recibirEventos(hub, events)
          const seen = new Set<number>()
          const expected = numeros.map((n) => {
            const firstOne = !seen.has(n)
            seen.add(n)
            return firstOne ? 'saved' : 'already_stored'
          })
          expect(statuses(r)).toEqual(expected)
          expect(await contar(m.db, 'events', restauranteId)).toBe(new Set(numeros).size)
          expect(await contar(m.db, 'divergent_events', restauranteId)).toBe(0)
        },
      ),
      CORRIDAS,
    )
  })

  it('con otro contenido: el primero se guarda y el segundo es distinto, sin pisar al primero', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const a = eventoPlano(1, { data: { quantity: 1 } })
    const b = eventoPlano(1, { data: { quantity: 99 } })
    const r = await m.nube.recibirEventos(hub, [a, b])
    expect(r.map((x) => x.status)).toEqual(['saved', 'divergent'])
    const [saved] = await eventosGuardados(m.db, restauranteId)
    expect(saved?.content).toMatchObject({ data: { quantity: 1 } })
  })

  it('con otro contenido: lo distinto queda registrado para revisión (no se descarta, ADR-007)', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const a = eventoPlano(1, { data: { quantity: 1 } })
    const b = eventoPlano(1, { data: { quantity: 99 } })
    await m.nube.recibirEventos(hub, [a, b])
    // La respuesta dijo «distinto» (queda para revisión): tiene que estar en divergent_events.
    expect(await contar(m.db, 'divergent_events', restauranteId)).toBe(1)
  })

  it('el orden decide cuál se guarda: el primero que llega', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const a = eventoPlano(1, { data: { quantity: 1 } })
    const b = eventoPlano(1, { data: { quantity: 99 } })
    await m.nube.recibirEventos(hub, [b, a])
    const [saved] = await eventosGuardados(m.db, restauranteId)
    expect(saved?.content).toMatchObject({ data: { quantity: 99 } })
  })
})

describe('lotes concurrentes con los mismos eventos', () => {
  it('el mismo lote enviado a la vez varias veces: cada evento se guarda una sola vez', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const events = batch(1, 30)
    const respuestas = await Promise.all(
      Array.from({ length: 6 }, () => m.nube.recibirEventos(hub, events)),
    )
    for (const e of events) {
      const veredictos = respuestas.map((r) => r.find((x) => x.id === e.id)?.status)
      expect(veredictos.filter((v) => v === 'saved')).toHaveLength(1)
      expect(veredictos.filter((v) => v === 'already_stored')).toHaveLength(5)
    }
    expect(await contar(m.db, 'events', restauranteId)).toBe(30)
    expect(await contar(m.db, 'divergent_events', restauranteId)).toBe(0)
  })

  it('lotes que se solapan, a la vez y en distinto orden: la unión exacta, sin duplicados', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const all = batch(1, 40)
    const lotes = [all.slice(0, 20), all.slice(10, 30).reverse(), all.slice(25), [...all].reverse()]
    const respuestas = await Promise.all(lotes.map((l) => m.nube.recibirEventos(hub, l)))
    const guardados = respuestas.flat().filter((r) => r.status === 'saved')
    expect(new Set(guardados.map((g) => g.id)).size).toBe(40)
    expect(guardados).toHaveLength(40)
    expect(await contar(m.db, 'events', restauranteId)).toBe(40)
    expect(await m.nube.lastSequence(hub)).toBe(40)
  })

  it('una variante con otro contenido enviada a la vez que el original: el guardado es uno de los dos y nada se pierde', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const a = eventoPlano(1, { data: { quantity: 1 } })
    const b = eventoPlano(1, { data: { quantity: 99 } })
    const [ra, rb] = await Promise.all([
      m.nube.recibirEventos(hub, [a]),
      m.nube.recibirEventos(hub, [b]),
    ])
    expect([ra[0]?.status, rb[0]?.status].sort()).toEqual(['divergent', 'saved'])
    expect(await contar(m.db, 'events', restauranteId)).toBe(1)
    expect(await contar(m.db, 'divergent_events', restauranteId)).toBe(1)
  })

  it('el mismo lote subido a la vez por dos restaurantes: cada uno guarda el suyo', async () => {
    const a = await m.nuevoHub()
    const b = await m.nuevoHub()
    const events = batch(1, 10)
    const [ra, rb] = await Promise.all([
      m.nube.recibirEventos(a.hub, events),
      m.nube.recibirEventos(b.hub, events),
    ])
    expect(statuses(ra).every((e) => e === 'saved')).toBe(true)
    expect(statuses(rb).every((e) => e === 'saved')).toBe(true)
  })
})

describe('evento_distinto', () => {
  it('lo ya guardado no cambia nunca, y el mismo contenido distinto repetido no se duplica', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 2, max: 5 }),
        async (n, variants, veces) => {
          const { hub, restauranteId } = await m.nuevoHub()
          const originales = batch(1, n)
          await m.nube.recibirEventos(hub, originales)
          const before = await eventosGuardados(m.db, restauranteId)
          // `variantes` contenidos distintos por cada evento; cada uno se envía `veces` veces.
          const distintos = originales.flatMap((e) =>
            Array.from({ length: variants }, (_, v) => ({
              ...e,
              data: { ...e.data, variant: v + 1 },
            })),
          )
          for (let i = 0; i < veces; i++) {
            const r = await m.nube.recibirEventos(
              hub,
              i % 2 === 0 ? distintos : [...distintos].reverse().map((x) => x),
            )
            // Los ids repetidos dentro del lote (varias variantes del mismo evento) se
            // responden todos «distinto»; ninguno es «guardado».
            expect(statuses(r).every((e) => e === 'divergent')).toBe(true)
          }
          expect(await eventosGuardados(m.db, restauranteId)).toEqual(before)
        },
      ),
      CORRIDAS,
    )
  })

  it('cada contenido distinto queda una sola vez, aunque llegue en lotes y veces distintas', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const original = eventoPlano(1)
    await m.nube.recibirEventos(hub, [original])
    const v1 = { ...original, data: { quantity: 77 } }
    const v2 = { ...original, data: { quantity: 78 } }
    for (const envio of [[v1], [v1], [v2], [v1], [v2], [original]]) {
      const [r] = await m.nube.recibirEventos(hub, envio)
      expect(r?.status).toBe(envio[0] === original ? 'already_stored' : 'divergent')
    }
    expect(await contar(m.db, 'divergent_events', restauranteId)).toBe(2)
    const [saved] = await eventosGuardados(m.db, restauranteId)
    expect(saved?.content).toEqual(original)
  })

  it('el mismo contenido distinto, enviado a la vez varias veces, queda una sola vez', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const original = eventoPlano(1)
    await m.nube.recibirEventos(hub, [original])
    const variant = { ...original, data: { quantity: 42 } }
    const r = await Promise.all(
      Array.from({ length: 5 }, () => m.nube.recibirEventos(hub, [variant])),
    )
    expect(r.every((x) => x[0]?.status === 'divergent')).toBe(true)
    expect(await contar(m.db, 'divergent_events', restauranteId)).toBe(1)
  })

  it('guarda quién lo mandó y el contenido recibido', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const original = eventoPlano(1)
    await m.nube.recibirEventos(hub, [original])
    const variant = { ...original, data: { quantity: 42 } }
    await m.nube.recibirEventos(hub, [variant])
    const rows = (
      await m.db.query<{ event_id: string; hub_id: string; content: unknown }>(
        'SELECT event_id, hub_id, content FROM divergent_events WHERE restaurant_id = $1',
        [restauranteId],
      )
    ).rows
    expect(rows).toEqual([{ event_id: original.id, hub_id: hub.id, content: variant }])
  })

  it('lo que no es parte de lo que pasó (secuencia_base, firma, orden de las claves) no cuenta como distinto', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const original = eventoPlano(1, { base_sequence: 5, signature: 'a'.repeat(64) })
    await m.nube.recibirEventos(hub, [original])
    const reordenado = Object.fromEntries(
      Object.entries({ ...original, base_sequence: 0, signature: 'b'.repeat(64) }).reverse(),
    )
    const [r] = await m.nube.recibirEventos(hub, [reordenado])
    expect(r?.status).toBe('already_stored')
    expect(await contar(m.db, 'divergent_events', restauranteId)).toBe(0)
  })

  it('cambiar cualquier campo con sentido sí lo hace distinto', async () => {
    const { hub, restauranteId } = await m.nuevoHub()
    const base = eventoPlano(1)
    await m.nube.recibirEventos(hub, [base])
    const changes: Record<string, unknown>[] = [
      { type: 'ItemVoided' },
      { sequence: 2 },
      { received_at: '2026-10-26T15:00:00.001Z' },
      { business_day: '2026-10-27' },
      { aggregate_id: eventoPlano(99).aggregate_id },
      { campo_nuevo: 1 },
      { data: {} },
    ]
    for (const change of changes) {
      const [r] = await m.nube.recibirEventos(hub, [{ ...base, ...change }])
      expect(r?.status, JSON.stringify(change)).toBe('divergent')
    }
    expect(await contar(m.db, 'divergent_events', restauranteId)).toBe(changes.length)
  })

  it('un hub de la misma sede que manda otro contenido para un id existente también queda para revisión', async () => {
    const a = await m.nuevoHub()
    const secondOne = await m.nube.crearCodigo(a.restauranteId)
    if (!secondOne) throw new Error('sin código')
    const reg = await m.nube.registrarHub({
      code: secondOne.code,
      hub_id: eventoPlano(500).id,
      location_id: a.hub.sedeId,
      name: 'Caja 2',
      instancia: 'i2',
    })
    if (!reg.ok) throw new Error(reg.reason)
    const hub2 = await m.nube.authenticate(reg.credential)
    if (!hub2) throw new Error('sin hub 2')
    const original = eventoPlano(1)
    await m.nube.recibirEventos(a.hub, [original])
    const [r] = await m.nube.recibirEventos(hub2, [{ ...original, data: { x: 1 } }])
    expect(r?.status).toBe('divergent')
    const [same] = await m.nube.recibirEventos(hub2, [original])
    expect(same?.status).toBe('already_stored')
    // Cada hub ve su propia última secuencia: el segundo no subió nada.
    expect(await m.nube.lastSequence(hub2)).toBe(0)
    expect(await m.nube.lastSequence(a.hub)).toBe(1)
  })
})
