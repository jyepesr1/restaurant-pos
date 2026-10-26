import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { event, itemCopy } from '../../../packages/core/src/testing/factory'
import { atender, MAX_BYTES_CUERPO } from './api'
import { MIGRACIONES_NUBE, migrar } from './migraciones'
import { MAX_EVENTOS_POR_LOTE, newCode, normalizarCodigo } from './nube'
import { baseDePrueba } from './pruebas/pglite'

// La API de la nube (tarea 1.10) contra un Postgres embebido: crear el restaurante, registrar el
// hub con un código de un solo uso y subir eventos sin duplicar.

const ADMIN = 'token-de-administracion-de-prueba'
const NOW = new Date('2026-10-26T15:00:00.000Z')

async function world() {
  const { sql, db } = await baseDePrueba()
  const clock = { now: NOW }
  const request = (httpMethod: string, route: string, body?: unknown, token?: string) =>
    atender(
      new Request(`https://cloud.faro.test${route}`, {
        method: httpMethod,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body:
          body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      }),
      { sql, tokenAdmin: ADMIN, clock: () => clock.now },
    )
  const restaurant = newId()
  const location = newId()
  /** Crea el restaurante, un código y registra un hub; devuelve su credencial. */
  const hubRegistrado = async (rest = restaurant, hubId = newId()) => {
    await request('POST', '/v1/admin/restaurants', { id: rest, name: 'La Spritzzería' }, ADMIN)
    const { code } = await (
      await request('POST', '/v1/admin/codes', { restaurant_id: rest }, ADMIN)
    ).json()
    const r = await request('POST', '/v1/hubs/register', {
      code,
      hub_id: hubId,
      location_id: location,
      name: 'Caja principal',
      instance: 'instancia-1',
    })
    expect(r.status).toBe(201)
    const { credential } = await r.json()
    return { credential: credential as string, hubId }
  }
  return { sql, db, clock, request, restaurant, location, hubRegistrado }
}

/** Un pedido con dos eventos, como los guarda el hub (con secuencia, día y hora del hub). */
function eventosDePedido(sequence = 1) {
  const order = newId()
  return [
    event(order, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 }, {
      sequence,
      business_day: '2026-10-26',
    } as never),
    event(order, 'ItemAdded', itemCopy(), {
      sequence: sequence + 1,
      business_day: '2026-10-26',
    } as never),
  ]
}

describe('migraciones de la nube', () => {
  it('aplican una vez; repetirlas no hace nada; editar una ya aplicada falla', async () => {
    const { sql } = await baseDePrueba()
    expect(await migrar(sql)).toEqual([])
    const edited = MIGRACIONES_NUBE.map((m) => ({ ...m, sql: `${m.sql}\n-- cambio` }))
    await expect(migrar(sql, edited)).rejects.toThrow(/cambió después de aplicarse/)
  })

  it('los eventos no se cambian ni se borran', async () => {
    const { request, hubRegistrado, db } = await world()
    const { credential } = await hubRegistrado()
    await request('POST', '/v1/events', { events: eventosDePedido() }, credential)
    await expect(db.query("UPDATE events SET type = 'x'")).rejects.toThrow(/solo se agregan/)
    await expect(db.query('DELETE FROM events')).rejects.toThrow(/solo se agregan/)
  })
})

describe('administración y registro del hub', () => {
  it('sin el token de administración no se crea nada', async () => {
    const { request, restaurant } = await world()
    const without = await request('POST', '/v1/admin/restaurants', { id: restaurant, name: 'X' })
    expect(without.status).toBe(401)
    const other = await request(
      'POST',
      '/v1/admin/restaurants',
      { id: restaurant, name: 'X' },
      'other',
    )
    expect(other.status).toBe(401)
  })

  it('sin token de administración configurado, las rutas de administración no sirven', async () => {
    const { sql } = await baseDePrueba()
    const r = await atender(
      new Request('https://cloud.faro.test/v1/admin/restaurants', {
        method: 'POST',
        headers: { authorization: 'Bearer cualquiera' },
        body: JSON.stringify({ id: newId(), name: 'X' }),
      }),
      { sql },
    )
    expect(r.status).toBe(401)
  })

  it('crear el restaurante dos veces no lo duplica; un código para uno que no existe da 404', async () => {
    const { request, restaurant } = await world()
    const data = { id: restaurant, name: 'La Spritzzería' }
    expect((await request('POST', '/v1/admin/restaurants', data, ADMIN)).status).toBe(201)
    expect((await request('POST', '/v1/admin/restaurants', data, ADMIN)).status).toBe(200)
    const r = await request('POST', '/v1/admin/codes', { restaurant_id: newId() }, ADMIN)
    expect(r.status).toBe(404)
  })

  it('el código sirve una vez, sin importar mayúsculas ni guiones, y vence a las 24 horas', async () => {
    const { request, restaurant, location, clock } = await world()
    await request('POST', '/v1/admin/restaurants', { id: restaurant, name: 'R' }, ADMIN)
    const fresh = async () =>
      (
        await (
          await request('POST', '/v1/admin/codes', { restaurant_id: restaurant }, ADMIN)
        ).json()
      ).code as string
    const record = (code: string, hub_id = newId()) =>
      request('POST', '/v1/hubs/register', {
        code,
        hub_id,
        location_id: location,
        name: 'Caja',
        instance: 'i',
      })

    const code = await fresh()
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect((await record(` ${code.toLowerCase().replaceAll('-', ' ')} `)).status).toBe(201)
    expect((await record(code)).status).toBe(403)

    const other = await fresh()
    clock.now = new Date(NOW.getTime() + 24 * 60 * 60 * 1000 + 1)
    expect((await record(other)).status).toBe(403)
  })

  it('un hub ya registrado no se registra de nuevo con otro código', async () => {
    const { request, hubRegistrado, restaurant, location } = await world()
    const { hubId } = await hubRegistrado()
    const { code } = await (
      await request('POST', '/v1/admin/codes', { restaurant_id: restaurant }, ADMIN)
    ).json()
    const r = await request('POST', '/v1/hubs/register', {
      code,
      hub_id: hubId,
      location_id: location,
      name: 'Caja',
      instance: 'i',
    })
    expect(r.status).toBe(409)
  })

  it('los códigos no se repiten y solo usan letras y números fáciles de dictar', () => {
    const codigos = new Set(Array.from({ length: 2000 }, newCode))
    expect(codigos.size).toBe(2000)
    for (const c of codigos) expect(normalizarCodigo(c)).not.toMatch(/[01OIL]/)
  })
})

describe('subir eventos', () => {
  it('guarda un lote, y reenviarlo no lo duplica', async () => {
    const { request, hubRegistrado, db } = await world()
    const { credential } = await hubRegistrado()
    const events = eventosDePedido()
    const r = await request('POST', '/v1/events', { events }, credential)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      results: events.map((e) => ({ id: e.id, status: 'saved' })),
      last_sequence: 2,
    })
    const another = await (await request('POST', '/v1/events', { events }, credential)).json()
    expect(another.results.map((x: { status: string }) => x.status)).toEqual([
      'already_stored',
      'already_stored',
    ])
    expect((await db.query('SELECT count(*)::int AS n FROM events')).rows).toEqual([{ n: 2 }])
  })

  it('el mismo id con otro contenido no pisa el guardado: queda para revisión', async () => {
    const { request, hubRegistrado, db } = await world()
    const { credential } = await hubRegistrado()
    const [opened] = eventosDePedido()
    if (!opened) throw new Error('sin evento')
    await request('POST', '/v1/events', { events: [opened] }, credential)
    const changed = { ...opened, data: { ...opened.data, guests: 9 } }
    const r = await (await request('POST', '/v1/events', { events: [changed] }, credential)).json()
    expect(r.results).toEqual([{ id: opened.id, status: 'divergent' }])
    const [saved] = (
      await db.query<{ c: number }>("SELECT (content->'data'->>'guests')::int AS c FROM events")
    ).rows
    expect(saved?.c).toBe(2)
    expect((await db.query('SELECT count(*)::int AS n FROM divergent_events')).rows).toEqual([
      { n: 1 },
    ])
  })

  it('un evento mal formado no tumba el lote: los demás se guardan', async () => {
    const { request, hubRegistrado } = await world()
    const { credential } = await hubRegistrado()
    const [a, b] = eventosDePedido()
    const r = await (
      await request('POST', '/v1/events', { events: [a, { id: 'x', type: 'Nada' }, b] }, credential)
    ).json()
    expect(r.results.map((x: { status: string }) => x.status)).toEqual([
      'saved',
      'invalid',
      'saved',
    ])
  })

  it('sin credencial, con una inventada o con un hub revocado no se sube nada', async () => {
    const { request, hubRegistrado } = await world()
    const { credential, hubId } = await hubRegistrado()
    const events = eventosDePedido()
    expect((await request('POST', '/v1/events', { events })).status).toBe(401)
    expect((await request('POST', '/v1/events', { events }, 'inventada')).status).toBe(401)
    expect((await request('POST', '/v1/admin/hubs/revoke', { hub_id: hubId }, ADMIN)).status).toBe(
      204,
    )
    expect((await request('POST', '/v1/events', { events }, credential)).status).toBe(401)
  })

  it('cada restaurante ve solo lo suyo, aunque los ids de los eventos coincidan', async () => {
    const { request, hubRegistrado, db } = await world()
    const a = await hubRegistrado(newId())
    const b = await hubRegistrado(newId())
    const events = eventosDePedido()
    await request('POST', '/v1/events', { events }, a.credential)
    // El mismo evento en otro restaurante no es «ya estaba»: es suyo.
    const r = await (await request('POST', '/v1/events', { events }, b.credential)).json()
    expect(r.results.map((x: { status: string }) => x.status)).toEqual(['saved', 'saved'])
    expect((await db.query('SELECT count(*)::int AS n FROM events')).rows).toEqual([{ n: 4 }])
    const last = await (await request('GET', '/v1/events/last', undefined, b.credential)).json()
    expect(last).toEqual({ last_sequence: 2 })
  })

  it('límites: lote vacío, más de 500 eventos, cuerpo que no es JSON o demasiado grande', async () => {
    const { request, hubRegistrado } = await world()
    const { credential } = await hubRegistrado()
    expect((await request('POST', '/v1/events', { events: [] }, credential)).status).toBe(400)
    const muchos = Array.from({ length: MAX_EVENTOS_POR_LOTE + 1 }, () => ({}))
    expect((await request('POST', '/v1/events', { events: muchos }, credential)).status).toBe(400)
    expect((await request('POST', '/v1/events', '{no es json', credential)).status).toBe(400)
    const huge = JSON.stringify({ events: ['x'.repeat(MAX_BYTES_CUERPO)] })
    const r = await request('POST', '/v1/events', huge, credential)
    expect(r.status).toBe(413)
    expect((await r.json()).error).toBe('batch_too_large')
  })

  it('un evento de más de 64 KB es inválido, el resto del lote se guarda', async () => {
    const { request, hubRegistrado } = await world()
    const { credential } = await hubRegistrado()
    const [a, b] = eventosDePedido()
    if (!a || !b) throw new Error('sin eventos')
    const large = { ...b, data: { ...b.data, notes: 'x'.repeat(70_000) } }
    const r = await (await request('POST', '/v1/events', { events: [a, large] }, credential)).json()
    expect(r.results).toEqual([
      { id: a.id, status: 'saved' },
      { id: b.id, status: 'invalid', reason: 'too_large' },
    ])
  })

  it('las rutas que no existen dan 404 y la salud responde', async () => {
    const { request } = await world()
    expect((await request('GET', '/v1/health')).status).toBe(200)
    expect((await request('GET', '/v1/nothing')).status).toBe(404)
  })
})

describe('seguridad por fila en la base', () => {
  it('dentro de un restaurante solo se ven sus eventos, y no se puede escribir en otro', async () => {
    const { request, hubRegistrado, sql } = await world()
    const restA = newId()
    const restB = newId()
    const a = await hubRegistrado(restA)
    const b = await hubRegistrado(restB)
    await request('POST', '/v1/events', { events: eventosDePedido() }, a.credential)
    await request('POST', '/v1/events', { events: eventosDePedido() }, b.credential)
    const enRestaurante = <T>(rest: string, job: (tx: typeof sql) => Promise<T>) =>
      sql.transaction(async (tx) => {
        await tx.query("SELECT set_config('faro.restaurant_id', $1, true)", [rest])
        await tx.query('SET LOCAL ROLE faro_data')
        return job(tx)
      })
    // Una consulta sin filtro igual ve solo lo de su restaurante.
    const seenSet = await enRestaurante(restA, (tx) =>
      tx.query<{ r: string }>('SELECT DISTINCT restaurant_id AS r FROM events'),
    )
    expect(seenSet).toEqual([{ r: restA }])
    // Sin decir el restaurante no se ve nada.
    const nothing = await sql.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE faro_data')
      return tx.query('SELECT 1 FROM events')
    })
    expect(nothing).toEqual([])
    // Escribir un evento de B desde una transacción de A falla.
    await expect(
      enRestaurante(restA, (tx) =>
        tx.query(
          `INSERT INTO events (restaurant_id, id, hub_id, type, aggregate_type, aggregate_id,
             hub_sequence, business_day, received_at, content, fingerprint)
           VALUES ($1, $2, $3, 't', 'order', $2, 1, '2026-10-26', now(), '{}', 'h')`,
          [restB, newId(), b.hubId],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    // El rol de la API tampoco puede borrar ni cambiar el registro de hubs más allá de lo suyo.
    await expect(enRestaurante(restA, (tx) => tx.query('DELETE FROM hubs'))).rejects.toThrow(
      /permission denied/,
    )
  })
})

describe('revisión de código (1.10)', () => {
  it('un texto con carácter nulo o medio sustituto es inválido y no tumba el lote', async () => {
    const { request, hubRegistrado } = await world()
    const { credential } = await hubRegistrado()
    const [a, b] = eventosDePedido()
    if (!a || !b) throw new Error('sin eventos')
    const nulo = { ...b, data: { ...b.data, notes: `con ${String.fromCharCode(0)} nulo` } }
    const r = await (await request('POST', '/v1/events', { events: [a, nulo] }, credential)).json()
    expect(r.results).toEqual([
      { id: a.id, status: 'saved' },
      { id: b.id, status: 'invalid', reason: 'invalid_character' },
    ])
    const [c] = eventosDePedido(10)
    if (!c) throw new Error('sin evento')
    const lone = { ...c, data: { ...c.data, [`clave\uD800`]: 1 } }
    const r2 = await (await request('POST', '/v1/events', { events: [lone] }, credential)).json()
    expect(r2.results[0]).toMatchObject({ status: 'invalid', reason: 'invalid_character' })
  })

  it('ultima_secuencia es la última sin huecos desde 1, no la mayor', async () => {
    const { request, hubRegistrado } = await world()
    const { credential } = await hubRegistrado()
    const [s1, s2] = eventosDePedido(1)
    const [s3, s4] = eventosDePedido(3)
    const upload = async (events: unknown[]) =>
      (await (await request('POST', '/v1/events', { events }, credential)).json()).last_sequence
    // Llega primero lo de después (3 y 4): falta el 1 y el 2.
    expect(await upload([s3, s4])).toBe(0)
    expect(await upload([s1])).toBe(1)
    expect(await upload([s2])).toBe(4)
  })

  it('el registro se puede repetir con el mismo código y el mismo hub: la credencial anterior se anula', async () => {
    const { request, restaurant, location } = await world()
    await request('POST', '/v1/admin/restaurants', { id: restaurant, name: 'R' }, ADMIN)
    const { code } = await (
      await request('POST', '/v1/admin/codes', { restaurant_id: restaurant }, ADMIN)
    ).json()
    const hub_id = newId()
    const record = (id = hub_id) =>
      request('POST', '/v1/hubs/register', {
        code,
        hub_id: id,
        location_id: location,
        name: 'C',
        instance: 'i',
      })
    const first = (await (await record()).json()).credential
    const second = await record()
    expect(second.status).toBe(201)
    const newOne = (await second.json()).credential
    expect(newOne).not.toBe(first)
    expect((await request('GET', '/v1/events/last', undefined, first)).status).toBe(401)
    expect((await request('GET', '/v1/events/last', undefined, newOne)).status).toBe(200)
    // Otro hub con ese código usado, no.
    expect((await record(newId())).status).toBe(403)
  })

  it('un error interno responde 500 sin detalles', async () => {
    const faulty = {
      query: async () => {
        throw Object.assign(new Error('relation "secreta" does not exist'), { code: '42P01' })
      },
      execute: async () => {},
      transaction: async () => {
        throw new Error('x')
      },
    }
    const r = await atender(
      new Request('https://cloud.faro.test/v1/events/last', {
        headers: { authorization: 'Bearer algo' },
      }),
      { sql: faulty },
    )
    expect(r.status).toBe(500)
    expect(await r.text()).not.toMatch(/secreta|relation/)
  })
})

describe('lote con un dato que Postgres rechaza', () => {
  it('se guarda el resto y el malo queda inválido, sin 500 ni lote bloqueado', async () => {
    const { request, hubRegistrado } = await world()
    const { credential } = await hubRegistrado()
    const [a, b] = eventosDePedido()
    if (!a || !b) throw new Error('sin eventos')
    // Un 30 de febrero pasa por el sobre pero Postgres no lo acepta como fecha.
    const badCase = { ...b, business_day: '2026-02-30' }
    const r = await request('POST', '/v1/events', { events: [a, badCase] }, credential)
    expect(r.status).toBe(200)
    const { results } = await r.json()
    expect(results[0]).toEqual({ id: a.id, status: 'saved' })
    expect(results[1]).toMatchObject({ id: b.id, status: 'invalid' })
    // Reenviar el lote da lo mismo: no se queda trabado.
    const another = await (
      await request('POST', '/v1/events', { events: [a, badCase] }, credential)
    ).json()
    expect(another.results.map((x: { status: string }) => x.status)).toEqual([
      'already_stored',
      'invalid',
    ])
  })
})
