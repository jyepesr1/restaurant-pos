import { newId, type OrderEvent } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { AlmacenDispositivoMemoria } from './dispositivo/almacen'
import { ClienteSync } from './dispositivo/cliente'
import { AlmacenMemoria } from './hub/almacen'
import { AlmacenSqlite } from './hub/almacen-sqlite'
import { type CambioPedido, type Conexion, HubSync } from './hub/hub'
import { SalaSync } from './hub/sala'
import type { EstadoImpresora, MensajeHub } from './protocolo'
import { accesoLibre } from './pruebas/acceso'
import { baseSqlite, item } from './pruebas/montaje'

// Tarea 1.4 (ADR-015) en la sincronización: el número de cada comanda lo da el hub, por día
// operativo; `onSave` corre con el evento ya guardado y sin poder frenarlo; y el estado de las
// impresoras viaja a los equipos por el WebSocket.

const BOGOTA = (time: string) => new Date(`${time}-05:00`).getTime()
const WAITER: Conexion = { dispositivoId: newId(), type: 'waiter', revocadoEn: null }
const OTRO: Conexion = { dispositivoId: newId(), type: 'waiter', revocadoEn: null }
const USUARIO = newId()

type Almacen = 'memory' | 'sqlite'

function montar(almacen: Almacen, config: Partial<ConstructorParameters<typeof HubSync>[1]> = {}) {
  const { db, restauranteId } = baseSqlite()
  const saved = almacen === 'sqlite' ? new AlmacenSqlite(db, restauranteId) : new AlmacenMemoria()
  let ms = BOGOTA('2026-10-24T15:00:00')
  const hub = new HubSync(saved, {
    restauranteId,
    timeZone: 'America/Bogota',
    inicioDiaOperativo: '06:00',
    instancia: 'hub-1',
    clock: () => new Date(ms).toISOString(),
    access: accesoLibre,
    ...config,
  })
  /** Un evento en bruto como lo manda un dispositivo (hora estimada = la que se indique). */
  const crudo = (
    connection: Conexion,
    order: string,
    type: string,
    data: unknown,
    horaEstimada = new Date(ms).toISOString(),
  ) => ({
    id: newId(),
    type,
    schema_version: 1,
    aggregate_type: 'order',
    aggregate_id: order,
    related: [],
    data,
    session_id: null,
    user_id: USUARIO,
    device_id: connection.dispositivoId,
    authorization_id: null,
    reason: null,
    device_time: horaEstimada,
    hub_estimated_time: horaEstimada,
    base_sequence: saved.maxSecuencia(),
  })
  const send = (
    connection: Conexion,
    order: string,
    type: string,
    data: unknown,
    horaEstimada?: string,
  ) => {
    const r = hub.recibirLote(connection, [crudo(connection, order, type, data, horaEstimada)])
    return { result: r.resultados[0], accepted: r.aceptados[0] }
  }
  return {
    db,
    restauranteId,
    saved,
    hub,
    crudo,
    send,
    ahora: () => ms,
    fijar: (time: string) => {
      ms = BOGOTA(time)
    },
    advance: (n: number) => {
      ms += n
    },
  }
}
type Montaje = ReturnType<typeof montar>

/** Abre un pedido con `n` platos y los deja listos para enviar. */
function conPlatos(m: Montaje, n: number, connection = WAITER, time?: string) {
  const order = newId()
  expect(
    m.send(
      connection,
      order,
      'OrderOpened',
      { channel: 'dine_in', table_id: null, guests: 2 },
      time,
    ).result?.status,
  ).toBe('confirmed')
  const dishes = Array.from({ length: n }, () => item())
  for (const p of dishes)
    expect(m.send(connection, order, 'ItemAdded', p, time).result?.status).toBe('confirmed')
  return { order, ids: dishes.map((p) => p.item_id) }
}

const ticket = (itemIds: string[], station = newId()) => ({
  ticket_id: newId(),
  station_id: station,
  item_ids: itemIds,
})

const numeros = (e: OrderEvent | undefined) =>
  (e?.assignments as { ticket_numbers?: Record<string, number> } | undefined)?.ticket_numbers

describe.each(['memory', 'sqlite'] as const)('número de comanda (%s)', (almacen) => {
  it('cada comanda de un envío recibe un número seguido, una por estación', () => {
    const m = montar(almacen)
    const { order, ids } = conPlatos(m, 3)
    const [a, b, c] = [
      ticket([ids[0] as string]),
      ticket([ids[1] as string]),
      ticket([ids[2] as string]),
    ]
    const r = m.send(WAITER, order, 'ItemsSent', { tickets: [a, b, c] })
    expect(numeros(r.accepted)).toEqual({ [a.ticket_id]: 1, [b.ticket_id]: 2, [c.ticket_id]: 3 })
    expect(r.result?.status === 'confirmed' && r.result.aceptacion.assignments).toEqual({
      ticket_numbers: numeros(r.accepted),
    })
  })

  it('el siguiente envío, aunque sea de otro pedido u otro equipo, sigue la cuenta del día', () => {
    const m = montar(almacen)
    const one = conPlatos(m, 2)
    const two = conPlatos(m, 1, OTRO)
    const e1 = m.send(WAITER, one.order, 'ItemsSent', {
      tickets: [ticket([one.ids[0] as string]), ticket([one.ids[1] as string])],
    })
    const c2 = ticket([two.ids[0] as string])
    const e2 = m.send(OTRO, two.order, 'ItemsSent', { tickets: [c2] })
    expect(Object.values(numeros(e1.accepted) ?? {})).toEqual([1, 2])
    expect(numeros(e2.accepted)).toEqual({ [c2.ticket_id]: 3 })
  })

  it('solo ItemsEnviados trae números de comanda; PedidoAbierto sigue trayendo el número de pedido', () => {
    const m = montar(almacen)
    const order = newId()
    const opened = m.send(WAITER, order, 'OrderOpened', {
      channel: 'dine_in',
      table_id: null,
      guests: 1,
    })
    expect(opened.accepted?.assignments).toEqual({ day_number: 1 })
    const dish = item()
    const aggregate = m.send(WAITER, order, 'ItemAdded', dish)
    expect(aggregate.accepted?.assignments).toEqual({})
    const sent = m.send(WAITER, order, 'ItemsSent', {
      tickets: [ticket([dish.item_id])],
    })
    expect(Object.keys(sent.accepted?.assignments ?? {})).toEqual(['ticket_numbers'])
    // Un evento que no crea comanda no gasta números.
    const ready = m.send(WAITER, order, 'ItemReady', { item_ids: [dish.item_id] })
    expect(ready.accepted?.assignments).toEqual({})
  })

  it('un envío rechazado no gasta números', () => {
    const m = montar(almacen)
    const { order, ids } = conPlatos(m, 2)
    const badCase = m.send(WAITER, order, 'ItemsSent', { tickets: [ticket([newId()])] })
    expect(badCase.result?.status).toBe('rejected')
    const c = ticket([ids[0] as string])
    const good = m.send(WAITER, order, 'ItemsSent', { tickets: [c] })
    expect(numeros(good.accepted)).toEqual({ [c.ticket_id]: 1 })
  })

  it('el mismo envío reenviado (misma id) devuelve el mismo número y no gasta otro', () => {
    const m = montar(almacen)
    const { order, ids } = conPlatos(m, 1)
    const c = ticket([ids[0] as string])
    const event = m.crudo(WAITER, order, 'ItemsSent', { tickets: [c] })
    const firstOne = m.hub.recibirLote(WAITER, [event])
    const repetido = m.hub.recibirLote(WAITER, [event])
    expect(repetido.aceptados).toHaveLength(0)
    expect(repetido.resultados[0]).toEqual(firstOne.resultados[0])
    const other = conPlatos(m, 1)
    const c2 = ticket([other.ids[0] as string])
    expect(numeros(m.send(WAITER, other.order, 'ItemsSent', { tickets: [c2] }).accepted)).toEqual({
      [c2.ticket_id]: 2,
    })
  })

  describe('día operativo', () => {
    const enviarUno = (m: Montaje, time: string) => {
      m.fijar(time)
      const { order, ids } = conPlatos(m, 1)
      const c = ticket([ids[0] as string])
      const r = m.send(WAITER, order, 'ItemsSent', { tickets: [c] })
      return { number: numeros(r.accepted)?.[c.ticket_id], day: r.accepted?.business_day }
    }

    it('a las 6:00 a. m. empieza un día nuevo y la numeración vuelve a 1', () => {
      const m = montar(almacen)
      expect(enviarUno(m, '2026-10-24T20:00:00')).toEqual({ number: 1, day: '2026-10-24' })
      expect(enviarUno(m, '2026-10-24T21:00:00')).toEqual({ number: 2, day: '2026-10-24' })
      expect(enviarUno(m, '2026-10-25T05:59:00')).toEqual({ number: 3, day: '2026-10-24' })
      expect(enviarUno(m, '2026-10-25T06:00:00')).toEqual({ number: 1, day: '2026-10-25' })
      expect(enviarUno(m, '2026-10-25T06:01:00')).toEqual({ number: 2, day: '2026-10-25' })
    })

    it('la madrugada (después de medianoche) sigue siendo del día anterior', () => {
      const m = montar(almacen)
      enviarUno(m, '2026-10-24T22:00:00')
      expect(enviarUno(m, '2026-10-25T01:30:00')).toEqual({ number: 2, day: '2026-10-24' })
    })

    it('un envío con la hora del dispositivo de ayer que llega hoy cuenta en el día de ayer', () => {
      const m = montar(almacen)
      enviarUno(m, '2026-10-24T22:00:00')
      enviarUno(m, '2026-10-25T07:00:00')
      // Sin conexión desde las 11 p. m.; el hub lo recibe a las 7:10 a. m., dentro de la ventana de 12 h.
      m.fijar('2026-10-25T07:10:00')
      const { order, ids } = conPlatos(
        m,
        1,
        OTRO,
        new Date(BOGOTA('2026-10-24T23:00:00')).toISOString(),
      )
      const c = ticket([ids[0] as string])
      const r = m.send(
        OTRO,
        order,
        'ItemsSent',
        { tickets: [c] },
        new Date(BOGOTA('2026-10-24T23:05:00')).toISOString(),
      )
      expect(r.accepted?.business_day).toBe('2026-10-24')
      expect(numeros(r.accepted)).toEqual({ [c.ticket_id]: 2 })
      // El día de hoy no se mueve.
      expect(enviarUno(m, '2026-10-25T07:20:00')).toEqual({ number: 2, day: '2026-10-25' })
    })

    it('un dispositivo con el reloj muy atrasado no mete su comanda en un día viejo: vale la hora del hub', () => {
      const m = montar(almacen)
      enviarUno(m, '2026-10-24T20:00:00')
      m.fijar('2026-10-25T10:00:00')
      const { order, ids } = conPlatos(m, 1)
      const c = ticket([ids[0] as string])
      // El equipo dice que son las 2 p. m. del 20 de octubre (más de 12 h de diferencia).
      const r = m.send(
        WAITER,
        order,
        'ItemsSent',
        { tickets: [c] },
        new Date(BOGOTA('2026-10-20T14:00:00')).toISOString(),
      )
      expect(r.accepted?.business_day).toBe('2026-10-25')
      expect(numeros(r.accepted)).toEqual({ [c.ticket_id]: 1 })
    })

    it('un reloj adelantado más de un minuto tampoco adelanta el día', () => {
      const m = montar(almacen)
      m.fijar('2026-10-24T23:00:00')
      const { order, ids } = conPlatos(m, 1)
      const c = ticket([ids[0] as string])
      const r = m.send(
        WAITER,
        order,
        'ItemsSent',
        { tickets: [c] },
        new Date(BOGOTA('2026-10-25T09:00:00')).toISOString(),
      )
      expect(r.accepted?.business_day).toBe('2026-10-24')
    })

    it('el inicio del día es configurable (4:00 a. m.)', () => {
      const m = montar(almacen, { inicioDiaOperativo: '04:00' })
      expect(enviarUno(m, '2026-10-25T03:59:00').day).toBe('2026-10-24')
      expect(enviarUno(m, '2026-10-25T04:00:00')).toEqual({ number: 1, day: '2026-10-25' })
    })
  })

  it('el hub reiniciado sigue la cuenta donde iba (la numeración vive en los eventos guardados)', () => {
    const m = montar(almacen)
    const { order, ids } = conPlatos(m, 2)
    m.send(WAITER, order, 'ItemsSent', { tickets: [ticket([ids[0] as string])] })
    const reiniciado = new HubSync(m.saved, {
      restauranteId: m.restauranteId,
      timeZone: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      instancia: 'hub-2',
      clock: () => new Date(m.ahora()).toISOString(),
      access: accesoLibre,
    })
    const c = ticket([ids[1] as string])
    const r = reiniciado.recibirLote(WAITER, [
      m.crudo(WAITER, order, 'ItemsSent', { tickets: [c] }),
    ])
    expect(numeros(r.aceptados[0])).toEqual({ [c.ticket_id]: 2 })
  })

  it('un envío con 40 comandas numera de 1 a 40 en el orden recibido, sin repetir', () => {
    const m = montar(almacen)
    const { order, ids } = conPlatos(m, 40)
    const tickets = ids.map((id) => ticket([id]))
    const r = m.send(WAITER, order, 'ItemsSent', { tickets })
    expect(r.result?.status).toBe('confirmed')
    const given = numeros(r.accepted) ?? {}
    expect(tickets.map((c) => given[c.ticket_id])).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1),
    )
  })
})

describe('número de comanda: varios restaurantes en la misma base', () => {
  it('cada restaurante lleva su propia cuenta del día', () => {
    const { db, restauranteId } = baseSqlite()
    const other = newId()
    db.prepare(
      `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
       VALUES (?, ?, '2026-10-24T15:00:00.000Z', '2026-10-24T15:00:00.000Z', 1, 'Otro', '{}')`,
    ).run(other, other)
    const ms = BOGOTA('2026-10-24T15:00:00')
    const hubDe = (id: string) =>
      new HubSync(new AlmacenSqlite(db, id), {
        restauranteId: id,
        timeZone: 'America/Bogota',
        inicioDiaOperativo: '06:00',
        instancia: `hub-${id}`,
        clock: () => new Date(ms).toISOString(),
        access: accesoLibre,
      })
    const [a, b] = [hubDe(restauranteId), hubDe(other)]
    let sequence = 0
    const event = (connection: Conexion, order: string, type: string, data: unknown) => ({
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: order,
      related: [],
      data,
      session_id: null,
      user_id: USUARIO,
      device_id: connection.dispositivoId,
      authorization_id: null,
      reason: null,
      device_time: new Date(ms).toISOString(),
      hub_estimated_time: new Date(ms).toISOString(),
      base_sequence: sequence,
    })
    const enviarEn = (hub: HubSync, base: number, tickets: number) => {
      const order = newId()
      const dishes = Array.from({ length: tickets }, () => item())
      sequence = base
      const batch = [
        event(WAITER, order, 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 1 }),
        ...dishes.map((p) => event(WAITER, order, 'ItemAdded', p)),
        event(WAITER, order, 'ItemsSent', {
          tickets: dishes.map((p) => ticket([p.item_id])),
        }),
      ]
      const r = hub.recibirLote(WAITER, batch)
      expect(r.resultados.every((x) => x.status === 'confirmed')).toBe(true)
      return Object.values(numeros(r.aceptados.at(-1)) ?? {})
    }
    // Las secuencias son globales de la base: el segundo restaurante arranca en la suya.
    const maxDe = (id: string) =>
      Number(
        db
          .prepare('SELECT coalesce(max(sequence), 0) AS s FROM events WHERE restaurant_id = ?')
          .get(id)?.s,
      )
    expect(enviarEn(a, maxDe(restauranteId), 2)).toEqual([1, 2])
    expect(enviarEn(b, maxDe(other), 3)).toEqual([1, 2, 3])
    expect(enviarEn(a, maxDe(restauranteId), 1)).toEqual([3])
    expect(enviarEn(b, maxDe(other), 1)).toEqual([4])
  })
})

describe('comandasDelDia (almacenes)', () => {
  it.each(['memory', 'sqlite'] as const)(
    '%s: suma las comandas de los envíos del día y de ningún otro evento',
    (almacen) => {
      const m = montar(almacen)
      expect(m.saved.comandasDelDia('2026-10-24')).toBe(0)
      const { order, ids } = conPlatos(m, 3)
      m.send(WAITER, order, 'ItemsSent', {
        tickets: [ticket([ids[0] as string]), ticket([ids[1] as string])],
      })
      m.send(WAITER, order, 'ItemsSent', { tickets: [ticket([ids[2] as string])] })
      expect(m.saved.comandasDelDia('2026-10-24')).toBe(3)
      expect(m.saved.comandasDelDia('2026-10-23')).toBe(0)
      expect(m.saved.comandasDelDia('2026-10-25')).toBe(0)
    },
  )
})

describe.each(['memory', 'sqlite'] as const)('alGuardar (%s)', (almacen) => {
  type Llamada = { event: OrderEvent; changes: CambioPedido[] }
  const conGancho = () => {
    const llamadas: Llamada[] = []
    const fallos: { error: unknown; id: string }[] = []
    const m = montar(almacen, {
      onSave: (event, changes) => {
        llamadas.push({ event, changes })
      },
      onSaveFailure: (error, id) => fallos.push({ error, id }),
    })
    return { m, llamadas, fallos }
  }

  it('recibe el evento ya numerado y el pedido antes y después de aplicarlo', () => {
    const { m, llamadas } = conGancho()
    const { order, ids } = conPlatos(m, 1)
    llamadas.length = 0
    const c = ticket([ids[0] as string])
    const r = m.send(WAITER, order, 'ItemsSent', { tickets: [c] })
    expect(llamadas).toHaveLength(1)
    const { event, changes } = llamadas[0] as Llamada
    expect(event.id).toBe(r.accepted?.id)
    expect(event.sequence).toBe(r.accepted?.sequence)
    expect(numeros(event)).toEqual({ [c.ticket_id]: 1 })
    expect(changes).toHaveLength(1)
    expect(changes[0]?.before?.items[ids[0] as string]?.status).toBe('pending')
    expect(changes[0]?.after?.items[ids[0] as string]?.status).toBe('sent')
    // La proyección del hub ya quedó al día después.
    expect(m.hub.order(order)?.items[ids[0] as string]?.status).toBe('sent')
  })

  it('al abrir un pedido, antes es null; el evento de un producto no trae pedidos', () => {
    const { m, llamadas } = conGancho()
    const order = newId()
    m.send(WAITER, order, 'OrderOpened', { channel: 'bar', table_id: null, guests: 1 })
    expect(llamadas[0]?.changes).toEqual([
      { before: null, after: expect.objectContaining({ id: order, status: 'open' }) },
    ])
    llamadas.length = 0
    const product = {
      id: newId(),
      type: 'ProductSoldOut',
      schema_version: 1,
      aggregate_type: 'product',
      aggregate_id: newId(),
      related: [],
      data: { product_id: newId(), variant_id: null },
      session_id: null,
      user_id: USUARIO,
      device_id: WAITER.dispositivoId,
      authorization_id: null,
      reason: null,
      device_time: new Date(m.ahora()).toISOString(),
      hub_estimated_time: new Date(m.ahora()).toISOString(),
      base_sequence: m.saved.maxSecuencia(),
    }
    const r = m.hub.recibirLote(WAITER, [product])
    if (r.aceptados.length > 0) {
      expect(llamadas).toHaveLength(1)
      expect(llamadas[0]?.changes).toEqual([])
    }
  })

  it('el pedido «antes» no se modifica al aplicar el evento (es una foto)', () => {
    const { m, llamadas } = conGancho()
    const { order, ids } = conPlatos(m, 2)
    llamadas.length = 0
    m.send(WAITER, order, 'ItemsSent', { tickets: [ticket([ids[0] as string])] })
    m.send(WAITER, order, 'ItemReady', { item_ids: [ids[0] as string] })
    const [sent, ready] = llamadas as [Llamada, Llamada]
    expect(sent.changes[0]?.before?.items[ids[0] as string]?.status).toBe('pending')
    expect(sent.changes[0]?.after?.items[ids[0] as string]?.status).toBe('sent')
    expect(ready.changes[0]?.before?.items[ids[0] as string]?.status).toBe('sent')
    expect(ready.changes[0]?.after?.items[ids[0] as string]?.status).toBe('ready')
  })

  it('no corre con un evento rechazado ni con uno reenviado', () => {
    const { m, llamadas } = conGancho()
    const { order, ids } = conPlatos(m, 1)
    const total = llamadas.length
    const badCase = m.send(WAITER, order, 'ItemsSent', { tickets: [ticket([newId()])] })
    expect(badCase.result?.status).toBe('rejected')
    const event = m.crudo(WAITER, order, 'ItemsSent', {
      tickets: [ticket([ids[0] as string])],
    })
    m.hub.recibirLote(WAITER, [event])
    m.hub.recibirLote(WAITER, [event])
    expect(llamadas.length).toBe(total + 1)
  })

  it('si el gancho lanza, el evento igual se acepta, se confirma y se avisa el fallo', () => {
    const fallos: { error: unknown; id: string }[] = []
    const m = montar(almacen, {
      onSave: () => {
        throw new Error('la impresora explotó')
      },
      onSaveFailure: (error, id) => fallos.push({ error, id }),
    })
    const { order, ids } = conPlatos(m, 1)
    const c = ticket([ids[0] as string])
    const r = m.send(WAITER, order, 'ItemsSent', { tickets: [c] })
    expect(r.result?.status).toBe('confirmed')
    expect(r.accepted).toBeDefined()
    expect(numeros(r.accepted)).toEqual({ [c.ticket_id]: 1 })
    expect(m.saved.porId(r.accepted?.id as string)).toBeDefined()
    expect(m.hub.order(order)?.items[ids[0] as string]?.status).toBe('sent')
    expect(fallos.length).toBeGreaterThan(0)
    expect(fallos.at(-1)?.id).toBe(r.accepted?.id)
    expect(String((fallos.at(-1)?.error as Error | undefined)?.message)).toBe(
      'la impresora explotó',
    )
    // Y el hub sigue funcionando.
    expect(
      m.send(WAITER, order, 'ItemReady', { item_ids: [ids[0] as string] }).result?.status,
    ).toBe('confirmed')
  })

  it('si el gancho lanza y no hay quién escuche el fallo, tampoco frena el evento', () => {
    const m = montar(almacen, {
      onSave: () => {
        throw new Error('x')
      },
    })
    const { order } = conPlatos(m, 0)
    expect(order).toBeTruthy()
    expect(m.saved.maxSecuencia()).toBe(1)
  })

  it('un fallo del gancho en un evento no afecta a los demás del mismo lote', () => {
    let n = 0
    const m = montar(almacen, {
      onSave: () => {
        n += 1
        if (n === 2) throw new Error('solo el segundo')
      },
    })
    const order = newId()
    const dishes = [item(), item()]
    const batch = [
      m.crudo(WAITER, order, 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 1 }),
      ...dishes.map((p) => m.crudo(WAITER, order, 'ItemAdded', p)),
    ]
    const r = m.hub.recibirLote(WAITER, batch)
    expect(r.resultados.map((x) => x.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
    expect(r.aceptados).toHaveLength(3)
  })
})

describe('alGuardar: misma transacción que el evento (SQLite)', () => {
  class CaeAlFinal extends AlmacenSqlite {
    cae = false
    override transaccion<T>(trabajo: () => T): T {
      return super.transaccion(() => {
        const r = trabajo()
        if (this.cae) throw new Error('se fue la luz before del COMMIT')
        return r
      })
    }
  }

  function montarConSonda() {
    const { db, restauranteId } = baseSqlite()
    db.exec('CREATE TABLE sonda (event_id TEXT, existia_el_evento INTEGER)')
    const almacen = new CaeAlFinal(db, restauranteId)
    const hub = new HubSync(almacen, {
      restauranteId,
      timeZone: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      instancia: 'hub-1',
      clock: () => '2026-10-24T20:00:00.000Z',
      access: accesoLibre,
      onSave: (event) => {
        // El evento ya está guardado cuando corre el gancho.
        const row = db
          .prepare('SELECT count(*) AS n FROM events WHERE restaurant_id = ? AND id = ?')
          .get(restauranteId, event.id)
        db.prepare('INSERT INTO sonda VALUES (?, ?)').run(event.id, Number(row?.n))
      },
    })
    const crudo = (order: string) => ({
      id: newId(),
      type: 'OrderOpened',
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: order,
      related: [],
      data: { channel: 'dine_in', table_id: null, guests: 1 },
      session_id: null,
      user_id: USUARIO,
      device_id: WAITER.dispositivoId,
      authorization_id: null,
      reason: null,
      device_time: '2026-10-24T20:00:00.000Z',
      hub_estimated_time: '2026-10-24T20:00:00.000Z',
      base_sequence: 0,
    })
    return { db, almacen, hub, crudo }
  }

  it('lo que escribe el gancho se guarda junto con el evento y ve el evento ya guardado', () => {
    const { db, hub, crudo } = montarConSonda()
    const e = crudo(newId())
    hub.recibirLote(WAITER, [e])
    expect(db.prepare('SELECT * FROM sonda').all()).toEqual([
      { event_id: e.id, existia_el_evento: 1 },
    ])
  })

  it('si el hub se cae antes de confirmar, no queda ni el evento ni lo que escribió el gancho', () => {
    const { db, almacen, hub, crudo } = montarConSonda()
    almacen.cae = true
    const e = crudo(newId())
    // Tampoco se puede guardar el rechazo: el almacén está caído y el hub debe reiniciarse.
    expect(() => hub.recibirLote(WAITER, [e])).toThrow(/luz/)
    expect(db.prepare('SELECT count(*) AS n FROM sonda').get()).toEqual({ n: 0 })
    expect(Number(db.prepare('SELECT count(*) AS n FROM events WHERE id = ?').get(e.id)?.n)).toBe(0)
  })
})

// ── Mensaje `impresoras` ────────────────────────────────────────────────

const ESTADOS: EstadoImpresora[] = [
  { id: newId(), name: 'Cocina', status: 'ready', error: null, pendingList: 0 },
  {
    id: newId(),
    name: 'Barra',
    status: 'failed',
    error: 'La impresora no responde',
    pendingList: 3,
  },
]

function montarSala() {
  const m = montar('memory')
  const tokens = new Map<string, Conexion>([
    ['t-ana', { dispositivoId: newId(), type: 'waiter', revocadoEn: null }],
    ['t-caja', { dispositivoId: newId(), type: 'register', revocadoEn: null }],
    ['t-rev', { dispositivoId: newId(), type: 'waiter', revocadoEn: '2026-10-24T10:00:00.000Z' }],
  ])
  const sala = new SalaSync(m.hub, (t) => tokens.get(t) ?? null)
  const connect = (token?: string) => {
    const recibidos: MensajeHub[] = []
    const enlace = sala.connect((msg) => recibidos.push(JSON.parse(JSON.stringify(msg))))
    if (token)
      enlace.recibir({ type: 'hello', token, hub_instancia: null, until: 0, version_app: 'x' })
    return { recibidos, enlace }
  }
  const printers = (r: MensajeHub[]) => r.filter((x) => x.type === 'printers')
  return { sala, connect, printers, tokens }
}

describe('mensaje impresoras', () => {
  it('lo reciben los equipos conectados cada vez que cambia el estado', () => {
    const { sala, connect, printers } = montarSala()
    const ana = connect('t-ana')
    const register = connect('t-caja')
    sala.avisarImpresoras(ESTADOS)
    expect(printers(ana.recibidos)).toEqual([{ type: 'printers', printers: ESTADOS }])
    expect(printers(register.recibidos)).toEqual([{ type: 'printers', printers: ESTADOS }])
    const sana = ESTADOS.map((e) => ({
      ...e,
      status: 'ready' as const,
      error: null,
      pendingList: 0,
    }))
    sala.avisarImpresoras(sana)
    expect(printers(ana.recibidos).at(-1)).toEqual({ type: 'printers', printers: sana })
    expect(printers(ana.recibidos)).toHaveLength(2)
  })

  it('un equipo que se conecta después recibe el último estado justo tras la bienvenida', () => {
    const { sala, connect } = montarSala()
    sala.avisarImpresoras(ESTADOS)
    const tarde = connect('t-ana')
    expect(tarde.recibidos.map((r) => r.type)).toEqual(['welcome', 'printers'])
    expect(tarde.recibidos[1]).toEqual({ type: 'printers', printers: ESTADOS })
  })

  it('al conectar recibe el estado más reciente, no uno viejo', () => {
    const { sala, connect } = montarSala()
    sala.avisarImpresoras(ESTADOS)
    sala.avisarImpresoras([ESTADOS[0] as EstadoImpresora])
    const tarde = connect('t-caja')
    expect(tarde.recibidos[1]).toEqual({ type: 'printers', printers: [ESTADOS[0]] })
  })

  it('si aún no se sabe nada de las impresoras, al conectar solo llega la bienvenida', () => {
    const { connect } = montarSala()
    expect(connect('t-ana').recibidos.map((r) => r.type)).toEqual(['welcome'])
  })

  it('una lista vacía se avisa a los conectados, pero un equipo nuevo no recibe nada de más', () => {
    const { sala, connect, printers } = montarSala()
    const ana = connect('t-ana')
    sala.avisarImpresoras(ESTADOS)
    sala.avisarImpresoras([])
    expect(printers(ana.recibidos).at(-1)).toEqual({ type: 'printers', printers: [] })
    expect(connect('t-caja').recibidos.map((r) => r.type)).toEqual(['welcome'])
  })

  it('no se le manda a quien no se presentó, ni a quien tiene un token inválido', () => {
    const { sala, connect, printers } = montarSala()
    const anonimo = connect()
    const falso = connect('inventado')
    sala.avisarImpresoras(ESTADOS)
    expect(printers(anonimo.recibidos)).toHaveLength(0)
    expect(printers(falso.recibidos)).toHaveLength(0)
    expect(falso.recibidos[0]).toMatchObject({ type: 'error', code: 'invalid_token' })
  })

  it('un equipo retirado no recibe el estado, ni al avisar ni al conectarse', () => {
    const { sala, connect, printers } = montarSala()
    const rev = connect('t-rev')
    sala.avisarImpresoras(ESTADOS)
    expect(printers(rev.recibidos)).toHaveLength(0)
    expect(printers(connect('t-rev').recibidos)).toHaveLength(0)
  })

  it('un equipo que se revoca después deja de recibirlo', () => {
    const { sala, connect, printers, tokens } = montarSala()
    const ana = connect('t-ana')
    sala.avisarImpresoras(ESTADOS)
    sala.revoke((tokens.get('t-ana') as Conexion).dispositivoId, '2026-10-24T21:00:00.000Z')
    sala.avisarImpresoras([])
    expect(printers(ana.recibidos)).toHaveLength(1)
  })

  it('una conexión rota no impide que las demás reciban el aviso, y se descarta', () => {
    const m = montar('memory')
    const connection: Conexion = { dispositivoId: newId(), type: 'waiter', revocadoEn: null }
    const sala = new SalaSync(m.hub, () => connection)
    let broken = false
    const recibidos: MensajeHub[] = []
    const mala = sala.connect(() => {
      if (broken) throw new Error('socket cerrado')
    })
    const buena = sala.connect((msg) => recibidos.push(msg))
    for (const e of [mala, buena])
      e.recibir({ type: 'hello', token: 't', hub_instancia: null, until: 0, version_app: 'x' })
    broken = true
    expect(() => sala.avisarImpresoras(ESTADOS)).not.toThrow()
    expect(recibidos.filter((r) => r.type === 'printers')).toHaveLength(1)
    // Ya está descartada: un segundo aviso no vuelve a tocarla.
    let toques = 0
    broken = false
    const contada = sala.connect(() => {
      toques += 1
    })
    contada.recibir({ type: 'hello', token: 't', hub_instancia: null, until: 0, version_app: 'x' })
    toques = 0
    sala.avisarImpresoras(ESTADOS)
    expect(toques).toBe(1)
  })

  it('el aviso no altera el estado guardado por el hub: la lista se copia por la red', () => {
    const { sala, connect } = montarSala()
    sala.avisarImpresoras(ESTADOS)
    const a = connect('t-ana')
    const b = connect('t-caja')
    expect(a.recibidos[1]).toEqual(b.recibidos[1])
  })

  it('un mensaje de dispositivo mal formado sigue recibiendo error, no impresoras', () => {
    const { sala, connect } = montarSala()
    sala.avisarImpresoras(ESTADOS)
    const c = connect('t-ana')
    c.enlace.recibir({ type: 'printers', printers: [] })
    expect(c.recibidos.at(-1)).toMatchObject({ type: 'error', code: 'invalid_message' })
  })
})

describe('el dispositivo y el mensaje impresoras', () => {
  async function connected() {
    const enviados: unknown[] = []
    let changes = 0
    const fallos: unknown[] = []
    const almacen = new AlmacenDispositivoMemoria()
    const cliente = new ClienteSync({
      almacen,
      token: 't',
      versionApp: 'x',
      send: (m) => enviados.push(m),
      onChange: () => {
        changes += 1
      },
      onFailure: (e) => fallos.push(e),
    })
    await cliente.alConectar()
    await cliente.ready()
    return { cliente, almacen, enviados, fallos, changes: () => changes }
  }

  it('no cambia nada guardado, no hace releer la pantalla y no pide nada al hub', async () => {
    const c = await connected()
    const before = { enviados: c.enviados.length, changes: c.changes() }
    await c.cliente.recibir({ type: 'printers', printers: ESTADOS })
    await c.cliente.ready()
    expect(c.enviados).toHaveLength(before.enviados)
    expect(c.changes()).toBe(before.changes)
    expect(c.fallos).toEqual([])
    expect(await c.almacen.cursor()).toMatchObject({ until: 0 })
    expect(await c.cliente.locales()).toEqual([])
  })

  it('varios avisos seguidos (incluso vacíos o repetidos) no rompen la cola de mensajes', async () => {
    const c = await connected()
    for (const list of [ESTADOS, ESTADOS, [], ESTADOS.slice(0, 1)])
      await c.cliente.recibir({ type: 'printers', printers: list })
    // Un evento nuevo del hub después sigue procesándose con normalidad.
    const m = montar('memory')
    const { order } = conPlatos(m, 0)
    const e = m.hub.pull(0, 'waiter').events[0]
    await c.cliente.recibir({
      type: 'new',
      event: e as OrderEvent,
      hasta_anterior: 0,
      until: 1,
    })
    await c.cliente.ready()
    expect((await c.cliente.locales()).map((l) => l.event.aggregate_id)).toEqual([order])
    expect(c.fallos).toEqual([])
  })
})
