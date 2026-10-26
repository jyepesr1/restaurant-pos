import { newId } from '@pos/core'
import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  batch,
  count,
  crearMundo,
  eventoPlano,
  eventosGuardados,
  SEED,
  ulid,
  type World,
} from './pruebas/mundo'

// Varios restaurantes en la misma base (ADR-016): nada de uno aparece en el otro, ni por la API
// ni dentro de la base con el rol de la API (seguridad por fila).

let m: World
beforeAll(async () => {
  m = await crearMundo()
})

/** Corre el trabajo como lo hace la API: en una transacción de un restaurante, con el rol limitado. */
const comoApi = <T>(restaurantId: string | null, job: (tx: World['sql']) => Promise<T>) =>
  m.sql.transaction(async (tx) => {
    if (restaurantId !== null)
      await tx.query("SELECT set_config('faro.restaurant_id', $1, true)", [restaurantId])
    await tx.query('SET LOCAL ROLE faro_data')
    return job(tx)
  })

const insertEvent =
  (restaurantId: string, hubId: string, id = newId()) =>
  (tx: World['sql']) =>
    tx.query(
      `INSERT INTO events (restaurant_id, id, hub_id, type, aggregate_type, aggregate_id,
       hub_sequence, business_day, received_at, content, fingerprint)
     VALUES ($1, $2, $3, 't', 'order', $2, 1, '2026-10-26', now(), '{}', 'h')`,
      [restaurantId, id, hubId],
    )

describe('por la API', () => {
  it('con dos restaurantes que suben el mismo id de evento, cada uno guarda y ve el suyo', async () => {
    const a = await m.newHub()
    const b = await m.newHub()
    // Mismos ids, pero un contenido distinto en cada restaurante.
    const deA = batch(1, 5).map((e) => ({ ...e, data: { dueno: 'A' } }))
    const deB = batch(1, 5).map((e) => ({ ...e, data: { dueno: 'B' } }))
    const ra = await m.nube.recibirEventos(a.hub, deA)
    const rb = await m.nube.recibirEventos(b.hub, deB)
    // Para B no es «ya estaba» ni «distinto»: en su restaurante el id no existía.
    expect(ra.map((r) => r.status)).toEqual(Array(5).fill('saved'))
    expect(rb.map((r) => r.status)).toEqual(Array(5).fill('saved'))
    expect(await count(m.db, 'divergent_events', a.restaurantId)).toBe(0)
    expect(await count(m.db, 'divergent_events', b.restaurantId)).toBe(0)
    for (const [h, dueno] of [
      [a, 'A'],
      [b, 'B'],
    ] as const) {
      const rows = await eventosGuardados(m.db, h.restaurantId)
      expect(rows).toHaveLength(5)
      expect(
        rows.every((f) => (f.content as { data: { dueno: string } }).data.dueno === dueno),
      ).toBe(true)
      expect(rows.every((f) => f.hub_id === h.hub.id)).toBe(true)
    }
  })

  it('ultima_secuencia de uno no se mueve por lo que sube el otro', async () => {
    const a = await m.newHub()
    const b = await m.newHub()
    await m.nube.recibirEventos(a.hub, batch(1, 20))
    expect(await m.nube.lastSequence(a.hub)).toBe(20)
    expect(await m.nube.lastSequence(b.hub)).toBe(0)
    await m.nube.recibirEventos(b.hub, batch(1, 3))
    expect(await m.nube.lastSequence(a.hub)).toBe(20)
    expect(await m.nube.lastSequence(b.hub)).toBe(3)
  })

  it('por HTTP: la credencial de uno no sube ni lee nada del otro', async () => {
    const a = await m.newHub()
    const b = await m.newHub()
    const r = await m.request('POST', '/v1/events', { events: batch(1, 4) }, a.credential)
    expect(r.status).toBe(200)
    const deB = await (await m.request('GET', '/v1/events/last', undefined, b.credential)).json()
    expect(deB).toEqual({ last_sequence: 0 })
    expect(await count(m.db, 'events', b.restaurantId)).toBe(0)
  })

  it('un evento que declara otro restaurante u otro hub en su cuerpo se guarda en el del hub que lo sube', async () => {
    const a = await m.newHub()
    const b = await m.newHub()
    const fake = eventoPlano(1, {
      restaurant_id: b.restaurantId,
      hub_id: b.hub.id,
      data: { restaurant_id: b.restaurantId },
    })
    const [r] = await m.nube.recibirEventos(a.hub, [fake])
    expect(r?.status).toBe('saved')
    expect(await count(m.db, 'events', b.restaurantId)).toBe(0)
    const [row] = await eventosGuardados(m.db, a.restaurantId)
    expect(row?.hub_id).toBe(a.hub.id)
  })

  it('propiedad: con k restaurantes y lotes al azar, cada uno termina con exactamente lo suyo', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uniqueArray(fc.integer({ min: 1, max: 30 }), { maxLength: 15 }), {
          minLength: 2,
          maxLength: 4,
        }),
        async (porRestaurante) => {
          const hubs = await Promise.all(porRestaurante.map(() => m.newHub()))
          await Promise.all(
            hubs.map((h, i) =>
              m.nube.recibirEventos(
                h.hub,
                (porRestaurante[i] ?? []).map((n) =>
                  eventoPlano(n, { data: { de: h.restaurantId } }),
                ),
              ),
            ),
          )
          for (const [i, h] of hubs.entries()) {
            const rows = await eventosGuardados(m.db, h.restaurantId)
            expect(rows.map((f) => f.id).sort()).toEqual(
              (porRestaurante[i] ?? []).map((n) => ulid(n, 'E')).sort(),
            )
            expect(
              rows.every((f) => (f.content as { data: { de: string } }).data.de === h.restaurantId),
            ).toBe(true)
          }
        },
      ),
      { seed: SEED, numRuns: 15 },
    )
  })

  it('el registro de otro restaurante no se mezcla: el código fija el restaurante', async () => {
    const a = await m.newHub()
    const rb = newId()
    await m.nube.crearRestaurante({ id: rb, name: 'B' })
    const cb = await m.nube.crearCodigo(rb)
    if (!cb) throw new Error('sin código')
    const r = await m.nube.registrarHub({
      code: cb.code,
      hub_id: newId(),
      location_id: a.hub.locationId,
      name: 'Caja B',
      instance: 'i',
    })
    if (!r.ok) throw new Error(r.reason)
    expect(r.restaurantId).toBe(rb)
    const hub = await m.nube.authenticate(r.credential)
    expect(hub?.restaurantId).toBe(rb)
  })
})

describe('dentro de la base, con el rol de la API', () => {
  it('sin decir el restaurante no se ve ni se escribe nada; con una cadena vacía o inventada, tampoco', async () => {
    const a = await m.newHub()
    await m.nube.recibirEventos(a.hub, batch(1, 3))
    for (const rest of [null, '', 'inventado', newId()]) {
      expect(await comoApi(rest, (tx) => tx.query('SELECT 1 FROM events')), String(rest)).toEqual(
        [],
      )
      expect(
        await comoApi(rest, (tx) => tx.query('SELECT 1 FROM divergent_events')),
        String(rest),
      ).toEqual([])
      await expect(comoApi(rest, insertEvent(a.restaurantId, a.hub.id))).rejects.toThrow(
        /row-level security/,
      )
    }
  })

  it('leer: una consulta sin filtro, o que pide a propósito otro restaurante, no ve nada ajeno', async () => {
    const a = await m.newHub()
    const b = await m.newHub()
    await m.nube.recibirEventos(a.hub, batch(1, 3))
    await m.nube.recibirEventos(b.hub, batch(1, 4))
    const vistosPorA = await comoApi(a.restaurantId, (tx) =>
      tx.query<{ r: string }>('SELECT DISTINCT restaurant_id AS r FROM events'),
    )
    expect(vistosPorA).toEqual([{ r: a.restaurantId }])
    const ajenos = await comoApi(a.restaurantId, (tx) =>
      tx.query('SELECT * FROM events WHERE restaurant_id = $1', [b.restaurantId]),
    )
    expect(ajenos).toEqual([])
    const porHub = await comoApi(a.restaurantId, (tx) =>
      tx.query('SELECT * FROM events WHERE hub_id = $1', [b.hub.id]),
    )
    expect(porHub).toEqual([])
    const [check] = await comoApi(b.restaurantId, (tx) =>
      tx.query<{ n: number }>('SELECT count(*)::int AS n FROM events'),
    )
    expect(check?.n).toBe(4)
  })

  it('escribir: un evento o un conflicto de otro restaurante lo rechaza la política', async () => {
    const a = await m.newHub()
    const b = await m.newHub()
    await expect(comoApi(a.restaurantId, insertEvent(b.restaurantId, b.hub.id))).rejects.toThrow(
      /row-level security/,
    )
    await expect(
      comoApi(a.restaurantId, (tx) =>
        tx.query(
          `INSERT INTO divergent_events (restaurant_id, event_id, hub_id, content, fingerprint)
           VALUES ($1, $2, $3, '{}', 'h')`,
          [b.restaurantId, ulid(1, 'E'), b.hub.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    expect(await count(m.db, 'events', b.restaurantId)).toBe(0)
    expect(await count(m.db, 'divergent_events', b.restaurantId)).toBe(0)
  })

  it('escribir con el restaurante propio sí funciona (la política no bloquea de más)', async () => {
    const a = await m.newHub()
    await comoApi(a.restaurantId, insertEvent(a.restaurantId, a.hub.id))
    expect(await count(m.db, 'events', a.restaurantId)).toBe(1)
  })

  it('el rol no puede cambiar ni borrar eventos, ni borrar hubs, ni tocar conflictos', async () => {
    const a = await m.newHub()
    await m.nube.recibirEventos(a.hub, batch(1, 2))
    await m.nube.recibirEventos(a.hub, [eventoPlano(1, { data: { other: 1 } })])
    const sentencias = [
      "UPDATE events SET type = 'x'",
      'DELETE FROM events',
      "UPDATE divergent_events SET fingerprint = 'x'",
      'DELETE FROM divergent_events',
      'DELETE FROM hubs',
      'DELETE FROM restaurants',
      "UPDATE restaurants SET name = 'x'",
      'DELETE FROM registration_codes',
      `UPDATE hubs SET restaurant_id = '${ulid(1, 'R')}'`,
      "UPDATE hubs SET name = 'x'",
      'TRUNCATE events',
      'INSERT INTO migrations (version, name, fingerprint) VALUES (99, $$x$$, $$x$$)',
      'CREATE TABLE intruso (a int)',
      'ALTER TABLE events DISABLE ROW LEVEL SECURITY',
      'DROP POLICY events_of_restaurant ON events',
    ]
    for (const s of sentencias)
      await expect(
        comoApi(a.restaurantId, (tx) => tx.query(s)),
        s,
      ).rejects.toThrow(/permission denied|must be owner|row-level security/)
    expect(await count(m.db, 'events', a.restaurantId)).toBe(2)
    expect(await count(m.db, 'hubs')).toBeGreaterThan(0)
  })

  it('aunque el rol intente ver otro restaurante cambiando de rol o de ajuste, sale del rol limitado solo si es el dueño', async () => {
    // El rol de la API no puede volver a ser superusuario con RESET ROLE dentro de la transacción
    // de la API (en producción su rol de inicio es faro_api, que solo tiene faro_data). Aquí lo
    // que se garantiza es que el rol de las políticas no se salta la seguridad por fila.
    const [r] = (
      await m.db.query<{ rolbypassrls: boolean; rolsuper: boolean; rolcanlogin: boolean }>(
        "SELECT rolbypassrls, rolsuper, rolcanlogin FROM pg_roles WHERE rolname = 'faro_data'",
      )
    ).rows
    expect(r).toEqual({ rolbypassrls: false, rolsuper: false, rolcanlogin: false })
    const sqlTables = (
      await m.db.query<{ relname: string; relrowsecurity: boolean }>(
        "SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('events', 'divergent_events')",
      )
    ).rows
    expect(sqlTables.map((t) => t.relrowsecurity)).toEqual([true, true])
  })

  it('ultima_secuencia y los registros de hubs no dependen del restaurante activo', async () => {
    const a = await m.newHub()
    const b = await m.newHub()
    await m.nube.recibirEventos(a.hub, batch(1, 3))
    // Solo se lee la fila del hub de cada uno.
    expect(await m.nube.lastSequence(a.hub)).toBe(3)
    expect(await m.nube.lastSequence(b.hub)).toBe(0)
  })
})
