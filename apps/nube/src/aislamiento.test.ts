import { nuevoId } from '@pos/core'
import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  contar,
  crearMundo,
  eventoPlano,
  eventosGuardados,
  lote,
  type Mundo,
  SEMILLA,
  ulid,
} from './pruebas/mundo'

// Varios restaurantes en la misma base (ADR-016): nada de uno aparece en el otro, ni por la API
// ni dentro de la base con el rol de la API (seguridad por fila).

let m: Mundo
beforeAll(async () => {
  m = await crearMundo()
})

/** Corre el trabajo como lo hace la API: en una transacción de un restaurante, con el rol limitado. */
const comoApi = <T>(restauranteId: string | null, trabajo: (tx: Mundo['sql']) => Promise<T>) =>
  m.sql.transaccion(async (tx) => {
    if (restauranteId !== null)
      await tx.query("SELECT set_config('faro.restaurante_id', $1, true)", [restauranteId])
    await tx.query('SET LOCAL ROLE faro_datos')
    return trabajo(tx)
  })

const insertarEvento =
  (restauranteId: string, hubId: string, id = nuevoId()) =>
  (tx: Mundo['sql']) =>
    tx.query(
      `INSERT INTO evento (restaurante_id, id, hub_id, tipo, agregado_tipo, agregado_id,
       secuencia_hub, dia_operativo, recibido_en, contenido, huella)
     VALUES ($1, $2, $3, 't', 'pedido', $2, 1, '2026-10-26', now(), '{}', 'h')`,
      [restauranteId, id, hubId],
    )

describe('por la API', () => {
  it('con dos restaurantes que suben el mismo id de evento, cada uno guarda y ve el suyo', async () => {
    const a = await m.nuevoHub()
    const b = await m.nuevoHub()
    // Mismos ids, pero un contenido distinto en cada restaurante.
    const deA = lote(1, 5).map((e) => ({ ...e, datos: { dueno: 'A' } }))
    const deB = lote(1, 5).map((e) => ({ ...e, datos: { dueno: 'B' } }))
    const ra = await m.nube.recibirEventos(a.hub, deA)
    const rb = await m.nube.recibirEventos(b.hub, deB)
    // Para B no es «ya estaba» ni «distinto»: en su restaurante el id no existía.
    expect(ra.map((r) => r.estado)).toEqual(Array(5).fill('guardado'))
    expect(rb.map((r) => r.estado)).toEqual(Array(5).fill('guardado'))
    expect(await contar(m.db, 'evento_distinto', a.restauranteId)).toBe(0)
    expect(await contar(m.db, 'evento_distinto', b.restauranteId)).toBe(0)
    for (const [h, dueno] of [
      [a, 'A'],
      [b, 'B'],
    ] as const) {
      const filas = await eventosGuardados(m.db, h.restauranteId)
      expect(filas).toHaveLength(5)
      expect(
        filas.every((f) => (f.contenido as { datos: { dueno: string } }).datos.dueno === dueno),
      ).toBe(true)
      expect(filas.every((f) => f.hub_id === h.hub.id)).toBe(true)
    }
  })

  it('ultima_secuencia de uno no se mueve por lo que sube el otro', async () => {
    const a = await m.nuevoHub()
    const b = await m.nuevoHub()
    await m.nube.recibirEventos(a.hub, lote(1, 20))
    expect(await m.nube.ultimaSecuencia(a.hub)).toBe(20)
    expect(await m.nube.ultimaSecuencia(b.hub)).toBe(0)
    await m.nube.recibirEventos(b.hub, lote(1, 3))
    expect(await m.nube.ultimaSecuencia(a.hub)).toBe(20)
    expect(await m.nube.ultimaSecuencia(b.hub)).toBe(3)
  })

  it('por HTTP: la credencial de uno no sube ni lee nada del otro', async () => {
    const a = await m.nuevoHub()
    const b = await m.nuevoHub()
    const r = await m.pedir('POST', '/v1/eventos', { eventos: lote(1, 4) }, a.credencial)
    expect(r.status).toBe(200)
    const deB = await (await m.pedir('GET', '/v1/eventos/ultima', undefined, b.credencial)).json()
    expect(deB).toEqual({ ultima_secuencia: 0 })
    expect(await contar(m.db, 'evento', b.restauranteId)).toBe(0)
  })

  it('un evento que declara otro restaurante u otro hub en su cuerpo se guarda en el del hub que lo sube', async () => {
    const a = await m.nuevoHub()
    const b = await m.nuevoHub()
    const falso = eventoPlano(1, {
      restaurante_id: b.restauranteId,
      hub_id: b.hub.id,
      datos: { restaurante_id: b.restauranteId },
    })
    const [r] = await m.nube.recibirEventos(a.hub, [falso])
    expect(r?.estado).toBe('guardado')
    expect(await contar(m.db, 'evento', b.restauranteId)).toBe(0)
    const [fila] = await eventosGuardados(m.db, a.restauranteId)
    expect(fila?.hub_id).toBe(a.hub.id)
  })

  it('propiedad: con k restaurantes y lotes al azar, cada uno termina con exactamente lo suyo', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uniqueArray(fc.integer({ min: 1, max: 30 }), { maxLength: 15 }), {
          minLength: 2,
          maxLength: 4,
        }),
        async (porRestaurante) => {
          const hubs = await Promise.all(porRestaurante.map(() => m.nuevoHub()))
          await Promise.all(
            hubs.map((h, i) =>
              m.nube.recibirEventos(
                h.hub,
                (porRestaurante[i] ?? []).map((n) =>
                  eventoPlano(n, { datos: { de: h.restauranteId } }),
                ),
              ),
            ),
          )
          for (const [i, h] of hubs.entries()) {
            const filas = await eventosGuardados(m.db, h.restauranteId)
            expect(filas.map((f) => f.id).sort()).toEqual(
              (porRestaurante[i] ?? []).map((n) => ulid(n, 'E')).sort(),
            )
            expect(
              filas.every(
                (f) => (f.contenido as { datos: { de: string } }).datos.de === h.restauranteId,
              ),
            ).toBe(true)
          }
        },
      ),
      { seed: SEMILLA, numRuns: 15 },
    )
  })

  it('el registro de otro restaurante no se mezcla: el código fija el restaurante', async () => {
    const a = await m.nuevoHub()
    const rb = nuevoId()
    await m.nube.crearRestaurante({ id: rb, nombre: 'B' })
    const cb = await m.nube.crearCodigo(rb)
    if (!cb) throw new Error('sin código')
    const r = await m.nube.registrarHub({
      codigo: cb.codigo,
      hub_id: nuevoId(),
      sede_id: a.hub.sedeId,
      nombre: 'Caja B',
      instancia: 'i',
    })
    if (!r.ok) throw new Error(r.motivo)
    expect(r.restauranteId).toBe(rb)
    const hub = await m.nube.autenticar(r.credencial)
    expect(hub?.restauranteId).toBe(rb)
  })
})

describe('dentro de la base, con el rol de la API', () => {
  it('sin decir el restaurante no se ve ni se escribe nada; con una cadena vacía o inventada, tampoco', async () => {
    const a = await m.nuevoHub()
    await m.nube.recibirEventos(a.hub, lote(1, 3))
    for (const rest of [null, '', 'inventado', nuevoId()]) {
      expect(await comoApi(rest, (tx) => tx.query('SELECT 1 FROM evento')), String(rest)).toEqual(
        [],
      )
      expect(
        await comoApi(rest, (tx) => tx.query('SELECT 1 FROM evento_distinto')),
        String(rest),
      ).toEqual([])
      await expect(comoApi(rest, insertarEvento(a.restauranteId, a.hub.id))).rejects.toThrow(
        /row-level security/,
      )
    }
  })

  it('leer: una consulta sin filtro, o que pide a propósito otro restaurante, no ve nada ajeno', async () => {
    const a = await m.nuevoHub()
    const b = await m.nuevoHub()
    await m.nube.recibirEventos(a.hub, lote(1, 3))
    await m.nube.recibirEventos(b.hub, lote(1, 4))
    const vistosPorA = await comoApi(a.restauranteId, (tx) =>
      tx.query<{ r: string }>('SELECT DISTINCT restaurante_id AS r FROM evento'),
    )
    expect(vistosPorA).toEqual([{ r: a.restauranteId }])
    const ajenos = await comoApi(a.restauranteId, (tx) =>
      tx.query('SELECT * FROM evento WHERE restaurante_id = $1', [b.restauranteId]),
    )
    expect(ajenos).toEqual([])
    const porHub = await comoApi(a.restauranteId, (tx) =>
      tx.query('SELECT * FROM evento WHERE hub_id = $1', [b.hub.id]),
    )
    expect(porHub).toEqual([])
    const [cuenta] = await comoApi(b.restauranteId, (tx) =>
      tx.query<{ n: number }>('SELECT count(*)::int AS n FROM evento'),
    )
    expect(cuenta?.n).toBe(4)
  })

  it('escribir: un evento o un conflicto de otro restaurante lo rechaza la política', async () => {
    const a = await m.nuevoHub()
    const b = await m.nuevoHub()
    await expect(
      comoApi(a.restauranteId, insertarEvento(b.restauranteId, b.hub.id)),
    ).rejects.toThrow(/row-level security/)
    await expect(
      comoApi(a.restauranteId, (tx) =>
        tx.query(
          `INSERT INTO evento_distinto (restaurante_id, evento_id, hub_id, contenido, huella)
           VALUES ($1, $2, $3, '{}', 'h')`,
          [b.restauranteId, ulid(1, 'E'), b.hub.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    expect(await contar(m.db, 'evento', b.restauranteId)).toBe(0)
    expect(await contar(m.db, 'evento_distinto', b.restauranteId)).toBe(0)
  })

  it('escribir con el restaurante propio sí funciona (la política no bloquea de más)', async () => {
    const a = await m.nuevoHub()
    await comoApi(a.restauranteId, insertarEvento(a.restauranteId, a.hub.id))
    expect(await contar(m.db, 'evento', a.restauranteId)).toBe(1)
  })

  it('el rol no puede cambiar ni borrar eventos, ni borrar hubs, ni tocar conflictos', async () => {
    const a = await m.nuevoHub()
    await m.nube.recibirEventos(a.hub, lote(1, 2))
    await m.nube.recibirEventos(a.hub, [eventoPlano(1, { datos: { otro: 1 } })])
    const sentencias = [
      "UPDATE evento SET tipo = 'x'",
      'DELETE FROM evento',
      "UPDATE evento_distinto SET huella = 'x'",
      'DELETE FROM evento_distinto',
      'DELETE FROM hub',
      'DELETE FROM restaurante',
      "UPDATE restaurante SET nombre = 'x'",
      'DELETE FROM codigo_registro',
      `UPDATE hub SET restaurante_id = '${ulid(1, 'R')}'`,
      "UPDATE hub SET nombre = 'x'",
      'TRUNCATE evento',
      'INSERT INTO migracion (version, nombre, huella) VALUES (99, $$x$$, $$x$$)',
      'CREATE TABLE intruso (a int)',
      'ALTER TABLE evento DISABLE ROW LEVEL SECURITY',
      'DROP POLICY evento_del_restaurante ON evento',
    ]
    for (const s of sentencias)
      await expect(
        comoApi(a.restauranteId, (tx) => tx.query(s)),
        s,
      ).rejects.toThrow(/permission denied|must be owner|row-level security/)
    expect(await contar(m.db, 'evento', a.restauranteId)).toBe(2)
    expect(await contar(m.db, 'hub')).toBeGreaterThan(0)
  })

  it('aunque el rol intente ver otro restaurante cambiando de rol o de ajuste, sale del rol limitado solo si es el dueño', async () => {
    // El rol de la API no puede volver a ser superusuario con RESET ROLE dentro de la transacción
    // de la API (en producción su rol de inicio es faro_api, que solo tiene faro_datos). Aquí lo
    // que se garantiza es que el rol de las políticas no se salta la seguridad por fila.
    const [r] = (
      await m.db.query<{ rolbypassrls: boolean; rolsuper: boolean; rolcanlogin: boolean }>(
        "SELECT rolbypassrls, rolsuper, rolcanlogin FROM pg_roles WHERE rolname = 'faro_datos'",
      )
    ).rows
    expect(r).toEqual({ rolbypassrls: false, rolsuper: false, rolcanlogin: false })
    const tablas = (
      await m.db.query<{ relname: string; relrowsecurity: boolean }>(
        "SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('evento', 'evento_distinto')",
      )
    ).rows
    expect(tablas.map((t) => t.relrowsecurity)).toEqual([true, true])
  })

  it('ultima_secuencia y los registros de hubs no dependen del restaurante activo', async () => {
    const a = await m.nuevoHub()
    const b = await m.nuevoHub()
    await m.nube.recibirEventos(a.hub, lote(1, 3))
    // Solo se lee la fila del hub de cada uno.
    expect(await m.nube.ultimaSecuencia(a.hub)).toBe(3)
    expect(await m.nube.ultimaSecuencia(b.hub)).toBe(0)
  })
})
