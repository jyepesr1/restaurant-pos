import { type NewEvent, newId, type OrderEvent } from '@pos/core'
import { aplicarMigraciones } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import { describe, expect, it } from 'vitest'
import { AlmacenDispositivoMemoria } from './dispositivo/almacen'
import { AlmacenMemoria } from './hub/almacen'
import { AlmacenSqlite } from './hub/almacen-sqlite'
import { HubSync } from './hub/hub'
import { SalaSync } from './hub/sala'
import { accesoLibre } from './pruebas/acceso'
import { type Nodo, RedSimulada } from './pruebas/red'

// Escenarios de aceptación de la tarea 0.6 (docs/SYNC.md#pruebas-de-aceptación-tarea-06).

const AHORA = '2026-10-24T15:00:00.000Z'

function baseSqlite() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db)
  const restauranteId = newId()
  db.prepare(
    `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
     VALUES (?, ?, ?, ?, 1, 'La Spritzzería', '{}')`,
  ).run(restauranteId, restauranteId, AHORA, AHORA)
  return { db, restauranteId }
}

/**
 * Hub + red simulada. Con `caer`, el almacén lanza al guardar el evento número `caer` y, como un
 * proceso apagado, no guarda nada más hasta que el hub se levanta.
 */
function montar(options: { almacen?: 'sqlite' | 'memory'; caer?: number } = {}) {
  const { db, restauranteId } = baseSqlite()
  let guardados = 0
  let caido = false
  class AlmacenQueSeCae extends AlmacenSqlite {
    override transaccion<T>(trabajo: () => T): T {
      if (caido) throw new Error('el hub está apagado')
      return super.transaccion(trabajo)
    }
    override saveEvent(...args: Parameters<AlmacenSqlite['saveEvent']>) {
      guardados += 1
      if (guardados === options.caer) {
        caido = true
        throw new Error('el hub se apagó')
      }
      super.saveEvent(...args)
    }
  }
  const almacen =
    options.almacen === 'memory' ? new AlmacenMemoria() : new AlmacenQueSeCae(db, restauranteId)
  const status: { hub: HubSync | null; instancia: string } = { hub: null, instancia: 'hub-1' }
  const network: RedSimulada = new RedSimulada(null as unknown as SalaSync)
  const crearSala = (almacenHub = almacen) => {
    status.hub = new HubSync(almacenHub, {
      restauranteId,
      timeZone: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      access: accesoLibre,
      instancia: status.instancia,
      clock: network.horaIso,
    })
    return new SalaSync(status.hub, network.authenticate)
  }
  network.sala = crearSala()
  network.alCaerHub = () => {
    caido = false
    return crearSala()
  }
  return { network, db, almacen, hub: () => status.hub as HubSync, crearSala, status }
}

const abrirPedido = (node: Nodo, order = newId(), table: string | null = newId()) =>
  node
    .crear(order, 'OrderOpened', { channel: 'dine_in', table_id: table, guests: 2 })
    .then(() => order)

const item = (price = 40_900, fields = {}) => ({
  item_id: newId(),
  product_id: newId(),
  variant_id: null,
  name: 'Garden Margarita',
  unit_price: price,
  tax_type: 'inc' as const,
  rate: 800,
  quantity: 1,
  guest: null,
  course: null,
  modifiers: [],
  notes: null,
  catalog_version: 1,
  price_channel_id: null,
  ...fields,
})

/** "Ven lo mismo": el hub tiene los eventos 1..N sin huecos y cada dispositivo, iguales proyecciones. */
async function venLoMismo(hub: HubSync, eventosHub: OrderEvent[], nodos: Nodo[], orders: string[]) {
  expect(eventosHub.map((e) => e.sequence)).toEqual(eventosHub.map((_, i) => i + 1))
  expect(new Set(eventosHub.map((e) => e.id)).size).toBe(eventosHub.length)
  for (const node of nodos) {
    expect(await node.cliente.pendingList()).toBe(0)
    const confirmados = (await node.cliente.locales())
      .filter((l) => l.status === 'confirmed')
      .map((l) => l.event.id)
    expect(new Set(confirmados)).toEqual(new Set(eventosHub.map((e) => e.id)))
    for (const order of orders) expect(await node.cliente.order(order)).toEqual(hub.order(order))
  }
}

const eventosDe = (m: ReturnType<typeof montar>) => m.almacen.eventosDesde(0, 100_000)

describe('escenarios de sincronización', () => {
  it('1. dos dispositivos sin hub crean pedidos en mesas distintas y al reconectar ven lo mismo, sin duplicados', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')

    const p1 = await abrirPedido(ana)
    await ana.crear(p1, 'ItemAdded', item())
    const p2 = await abrirPedido(luis)
    await luis.crear(p2, 'ItemAdded', item(12_900))
    expect(await ana.cliente.pendingList()).toBe(2)

    await m.network.conectarTodos()
    // Reconectar otra vez no duplica nada.
    ana.disconnect()
    luis.disconnect()
    await m.network.conectarTodos()

    expect(eventosDe(m)).toHaveLength(4)
    await venLoMismo(m.hub(), eventosDe(m), [ana, luis], [p1, p2])
    expect(m.hub().order(p1)?.dayNumber).toBe(1)
    expect(m.hub().order(p2)?.dayNumber).toBe(2)
  })

  it('2. los dos agregan ítems al mismo pedido sin conexión: se conservan todos', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await m.network.conectarTodos()
    const order = await abrirPedido(ana)
    await m.network.settle()

    ana.disconnect()
    luis.disconnect()
    await ana.crear(order, 'ItemAdded', item())
    await luis.crear(order, 'ItemAdded', item(12_900))
    await luis.crear(order, 'ItemAdded', item(8900))
    await m.network.conectarTodos()

    expect(Object.keys(m.hub().order(order)?.items ?? {})).toHaveLength(3)
    await venLoMismo(m.hub(), eventosDe(m), [ana, luis], [order])
  })

  it('3. los dos abren la misma mesa sin conexión: dos pedidos y exactamente un conflicto, también al reenviar', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    const table = newId()
    const p1 = await abrirPedido(ana, newId(), table)
    const p2 = await abrirPedido(luis, newId(), table)

    luis.rule('to_hub', 'push', 'duplicate')
    await m.network.conectarTodos()

    expect(m.hub().order(p1)?.status).toBe('open')
    expect(m.hub().order(p2)?.status).toBe('open')
    expect(
      m
        .hub()
        .conflictos()
        .map((c) => c.type),
    ).toEqual(['duplicate_table'])
    const conflictivo = (await luis.cliente.locales()).find((l) => l.event.aggregate_id === p2)
    expect(conflictivo?.conflict).toBe('duplicate_table')
    await venLoMismo(m.hub(), eventosDe(m), [ana, luis], [p1, p2])
  })

  it('3b. con la información al día, abrir una mesa ocupada se rechaza', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await m.network.conectarTodos()
    const table = newId()
    await abrirPedido(ana, newId(), table)
    await m.network.settle()

    const p2 = await abrirPedido(luis, newId(), table)
    await m.network.settle()

    expect((await luis.cliente.locales()).find((l) => l.event.aggregate_id === p2)).toMatchObject({
      status: 'rejected',
      reason: 'table_occupied',
    })
    expect(m.hub().order(p2)).toBeNull()
  })

  it('4. se pierde la respuesta y el mismo lote llega dos veces: sin duplicados', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await m.network.conectarTodos()

    ana.rule('to_device', 'result', 'drop')
    ana.rule('to_device', 'new', 'drop', 2)
    const order = await abrirPedido(ana)
    await ana.crear(order, 'ItemAdded', item())
    await m.network.settle()
    expect(await ana.cliente.pendingList()).toBe(2)

    // La conexión se reabre (por ejemplo, al volver a la pantalla) y el lote se reenvía.
    ana.disconnect()
    await m.network.conectarTodos()

    expect(eventosDe(m)).toHaveLength(2)
    await venLoMismo(m.hub(), eventosDe(m), [ana, luis], [order])
  })

  it('5a. el hub se cae a mitad de un lote: al volver, nada perdido ni duplicado', async () => {
    const m = montar({ caer: 3 })
    const ana = m.network.device('ana')
    const order = await abrirPedido(ana)
    for (const price of [10_000, 20_000, 30_000]) await ana.crear(order, 'ItemAdded', item(price))

    await m.network.conectarTodos()
    expect(ana.enLinea).toBe(false)
    expect(eventosDe(m)).toHaveLength(2)

    await m.network.conectarTodos()
    expect(eventosDe(m)).toHaveLength(4)
    await venLoMismo(m.hub(), eventosDe(m), [ana], [order])
  })

  it('5b. el hub guarda y se cae antes de responder: el reenvío no duplica', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    await m.network.conectarTodos()
    ana.rule('to_device', 'result', 'drop')
    ana.rule('to_device', 'new', 'drop', 5)
    const order = await abrirPedido(ana)
    await ana.crear(order, 'ItemAdded', item())
    await m.network.settle()

    m.network.crashHub()
    await m.network.conectarTodos()

    expect(eventosDe(m)).toHaveLength(2)
    await venLoMismo(m.hub(), eventosDe(m), [ana], [order])
  })

  it('6. un dispositivo con el reloj desfasado horas: el orden sale de la secuencia', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    luis.desfaseMs = -5 * 60 * 60 * 1000
    await m.network.conectarTodos()
    const order = await abrirPedido(ana)
    await m.network.settle()

    const firstOne = item(10_000)
    const secondOne = item(20_000)
    await ana.crear(order, 'ItemAdded', firstOne)
    await m.network.settle()
    await luis.crear(order, 'ItemAdded', secondOne)
    await m.network.settle()

    const status = m.hub().order(order)
    expect(status?.items[firstOne.item_id]?.position).toBe(1)
    expect(status?.items[secondOne.item_id]?.position).toBe(2)
    // La hora del dispositivo de Luis es 5 horas "anterior", pero no cambia el orden.
    const [, e1, e2] = eventosDe(m)
    expect((e2?.device_time ?? '') < (e1?.device_time ?? '')).toBe(true)
    expect(e2?.sequence).toBeGreaterThan(e1?.sequence ?? 0)
    await venLoMismo(m.hub(), eventosDe(m), [ana, luis], [order])
  })

  it('7. un rechazo arrastra a sus dependientes del mismo pedido y el dispositivo deshace su efecto', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await m.network.conectarTodos()
    const order = await abrirPedido(ana)
    await m.network.settle()
    const other = await abrirPedido(luis)
    await m.network.settle()

    ana.disconnect()
    // 999 unidades de $100.000.000 pasan del tope del pedido: se rechaza, y lo siguiente del pedido también.
    const expensive = item(100_000_000, { quantity: 999 })
    await ana.crear(order, 'ItemAdded', expensive)
    const after = item()
    await ana.crear(order, 'ItemAdded', after)
    await ana.crear(other, 'ItemAdded', item(5000))
    // En el propio celular el ítem que pasa del tope ya no se aplica; el siguiente sí, por ahora.
    expect(Object.keys((await ana.cliente.order(order))?.items ?? {})).toHaveLength(1)

    await m.network.conectarTodos()

    const locales = await ana.cliente.locales()
    expect(
      locales.find(
        (l) => l.event.id && (l.event as NewEvent<'ItemAdded'>).data.item_id === expensive.item_id,
      )?.reason,
    ).toBe('total_exceeds')
    expect(
      locales.find((l) => (l.event as NewEvent<'ItemAdded'>).data.item_id === after.item_id)
        ?.reason,
    ).toBe('depends_on_rejected')
    expect(Object.keys((await ana.cliente.order(order))?.items ?? {})).toHaveLength(0)
    // El evento de otro pedido no dependía y se aceptó.
    expect(Object.keys(m.hub().order(other)?.items ?? {})).toHaveLength(1)
    await venLoMismo(m.hub(), eventosDe(m), [luis], [order, other])
  })

  it('8. llega un evento con un hueco: el dispositivo trae lo que falta antes de avanzar', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const register = m.network.device('register')
    await m.network.conectarTodos()

    register.rule('to_device', 'new', 'drop')
    const order = await abrirPedido(ana)
    await ana.crear(order, 'ItemAdded', item())
    await ana.crear(order, 'ItemAdded', item(12_900))
    await m.network.settle()

    expect((await register.almacen.cursor()).until).toBe(3)
    await venLoMismo(m.hub(), eventosDe(m), [ana, register], [order])
  })

  it('9. el hub se restaura de un respaldo viejo: los dispositivos reenvían y todos quedan iguales', async () => {
    const m = montar({ almacen: 'memory' })
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await m.network.conectarTodos()
    const order = await abrirPedido(ana)
    await ana.crear(order, 'ItemAdded', item())
    await m.network.settle()
    const respaldo = structuredClone((m.almacen as AlmacenMemoria).events)

    await luis.crear(order, 'ItemAdded', item(12_900))
    await ana.crear(order, 'ItemAdded', item(8900))
    await m.network.settle()
    expect(eventosDe(m)).toHaveLength(4)

    // Se restaura el respaldo (2 eventos) en un hub reinstalado.
    for (const node of m.network.nodos) node.disconnect()
    const restaurado = new AlmacenMemoria()
    restaurado.events = respaldo
    m.status.instancia = 'hub-2'
    m.network.sala = m.crearSala(restaurado)
    await m.network.conectarTodos()

    const events = restaurado.eventosDesde(0, 1000)
    expect(events).toHaveLength(4)
    await venLoMismo(m.hub(), events, [ana, luis], [order])
  })

  it('10. se borran los datos de un dispositivo: al reconectar queda igual a los demás', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    await m.network.conectarTodos()
    const order = await abrirPedido(ana)
    await ana.crear(order, 'ItemAdded', item())
    await m.network.settle()

    // Mismo equipo (mismo token), almacenamiento borrado por el navegador.
    ana.disconnect()
    m.network.nodos.splice(m.network.nodos.indexOf(ana), 1)
    const anaDeNuevo = m.network.device('ana', new AlmacenDispositivoMemoria())
    await m.network.conectarTodos()

    await venLoMismo(m.hub(), eventosDe(m), [anaDeNuevo], [order])
  })

  it('11. más de 100 eventos pendientes se envían completos, en orden', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const order = await abrirPedido(ana)
    const items = Array.from({ length: 150 }, (_, i) => item(1000 + i))
    for (const i of items) await ana.crear(order, 'ItemAdded', i)

    await m.network.conectarTodos()

    const events = eventosDe(m)
    expect(events).toHaveLength(151)
    const position = events.slice(1).map((e) => (e.data as { item_id: string }).item_id)
    expect(position).toEqual(items.map((i) => i.item_id))
    await venLoMismo(m.hub(), events, [ana], [order])
  })

  it('12. un dispositivo revocado con eventos de antes de la revocación: quedan en cuarentena', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const order = await abrirPedido(ana)
    m.network.avanzar(60_000)
    const connection = m.network.tokens.get('token-ana')
    if (connection) connection.revocadoEn = m.network.horaIso()
    m.network.avanzar(60_000)
    await ana.crear(order, 'ItemAdded', item())

    await m.network.conectarTodos()

    const locales = await ana.cliente.locales()
    expect(locales.map((l) => l.status)).toEqual(['quarantine', 'rejected'])
    expect(m.db.prepare('SELECT count(*) AS n FROM quarantined_events').get()?.n).toBe(1)
    expect(eventosDe(m)).toHaveLength(0)
  })
})

describe('hub: validaciones', () => {
  const crudo = (node: Nodo, extras: Record<string, unknown> = {}) => ({
    id: newId(),
    type: 'OrderOpened',
    schema_version: 1,
    aggregate_type: 'order',
    aggregate_id: newId(),
    related: [],
    data: { channel: 'bar', table_id: null, guests: 1 },
    session_id: null,
    user_id: node.userId,
    device_id: node.dispositivoId,
    authorization_id: null,
    reason: null,
    device_time: AHORA,
    hub_estimated_time: AHORA,
    base_sequence: 0,
    ...extras,
  })
  const conexionDe = (m: ReturnType<typeof montar>, node: Nodo) => {
    const connection = m.network.tokens.get(`token-${node.name}`)
    if (!connection) throw new Error(`Sin token para ${node.name}`)
    return connection
  }

  it('el mismo id con otro contenido se rechaza; con el mismo contenido, misma respuesta', () => {
    const m = montar()
    const ana = m.network.device('ana')
    const event = crudo(ana)
    const firstOne = m.hub().recibirLote(conexionDe(m, ana), [event])
    const repetido = m.hub().recibirLote(conexionDe(m, ana), [event])
    const different = m
      .hub()
      .recibirLote(conexionDe(m, ana), [{ ...event, data: { ...event.data, guests: 5 } }])

    expect(repetido.resultados).toEqual(firstOne.resultados)
    expect(repetido.aceptados).toEqual([])
    expect(different.resultados[0]).toMatchObject({ status: 'rejected', reason: 'duplicate_id' })
  })

  it('rechaza formato inválido, otro dispositivo y una secuencia base del futuro', () => {
    const m = montar()
    const ana = m.network.device('ana')
    const r = m
      .hub()
      .recibirLote(conexionDe(m, ana), [
        { ...crudo(ana), data: { channel: 'dine_in' } },
        crudo(ana, { device_id: newId() }),
        crudo(ana, { base_sequence: 99 }),
        null,
      ])
    expect(
      r.resultados.map((x) => (x.status === 'rejected' ? x.reason.split(':')[0] : x.status)),
    ).toEqual(['esquema', 'device_mismatch', 'invalid_base_sequence', 'esquema'])
  })

  it('el día operativo sale de la hora estimada si es razonable; si no, de la del hub', () => {
    const m = montar()
    const ana = m.network.device('ana')
    // Hub: 15:00 UTC del 24 (10 a. m. en Bogotá).
    m.network.avanzar(Date.parse(AHORA) - m.network.ahora())
    const r = m.hub().recibirLote(conexionDe(m, ana), [
      crudo(ana, { hub_estimated_time: '2026-10-24T09:00:00.000Z' }), // 4 a. m.: día anterior
      crudo(ana, { hub_estimated_time: '2026-10-20T09:00:00.000Z' }), // días atrás: se ignora
    ])
    expect(r.aceptados.map((e) => e.business_day)).toEqual(['2026-10-23', '2026-10-24'])
  })

  it('un evento sobre un pedido cerrado: conflicto si no estaba al día, rechazo si lo estaba', () => {
    const m = montar()
    const ana = m.network.device('ana')
    const register = m.network.device('register')
    const connection = conexionDe(m, ana)
    const order = newId()
    // La caja abre su turno: sin él no se cobra (tarea 1.6).
    const shift = newId()
    m.hub().recibirLote(conexionDe(m, register), [
      crudo(register, {
        type: 'ShiftOpened',
        aggregate_type: 'register_shift',
        aggregate_id: shift,
        data: { register_id: register.dispositivoId, base: 0 },
      }),
    ])
    const payment = {
      payment_id: newId(),
      check_id: null,
      register_shift_id: shift,
      method: 'card',
      amount: 10_000,
      tip: 0,
      tendered: null,
      change: null,
      rounding_adjustment: 0,
      rounding: null,
      cardTerminal: {
        card_terminal_id: newId(),
        franchise: null,
        last4: null,
        approval_code: '1',
        receipt: null,
      },
      charge_reference: null,
    }
    const base = { aggregate_id: order }
    m.hub().recibirLote(connection, [
      crudo(ana, { ...base, data: { channel: 'dine_in', table_id: null, guests: 1 } }),
      crudo(ana, { ...base, type: 'ItemAdded', data: item(10_000), base_sequence: 2 }),
    ])
    // La caja cobra y cierra: ana solo sabe de eso si su `base_sequence` llega a 5.
    m.hub().recibirLote(conexionDe(m, register), [
      crudo(register, { ...base, type: 'PaymentRecorded', data: payment, base_sequence: 3 }),
      crudo(register, { ...base, type: 'OrderClosed', data: {}, base_sequence: 4 }),
    ])

    const atrasado = m.hub().recibirLote(connection, [
      crudo(ana, {
        ...base,
        type: 'GuestsChanged',
        data: { guests: 4 },
        base_sequence: 3,
      }),
    ])
    const alDia = m.hub().recibirLote(connection, [
      crudo(ana, {
        ...base,
        type: 'GuestsChanged',
        data: { guests: 4 },
        base_sequence: 6,
      }),
    ])

    expect(atrasado.resultados[0]).toMatchObject({
      status: 'confirmed',
      conflict: 'order_closed',
    })
    expect(alDia.resultados[0]).toMatchObject({ status: 'rejected', reason: 'order_closed' })
    expect(m.hub().order(order)?.guests).toBe(1)
  })

  it('el hub reconstruye sus proyecciones desde la base al arrancar', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    await m.network.conectarTodos()
    const order = await abrirPedido(ana)
    await ana.crear(order, 'ItemAdded', item())
    await m.network.settle()
    const before = m.hub().order(order)

    const fresh = new HubSync(m.almacen, {
      restauranteId: '',
      timeZone: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      access: accesoLibre,
      instancia: 'hub-1',
      clock: m.network.horaIso,
    })
    expect(fresh.order(order)).toEqual(before)
  })

  it('la sala rechaza mensajes con formato inválido y tokens desconocidos', () => {
    const m = montar()
    const recibidos: unknown[] = []
    const enlace = m.network.sala.connect((msg) => recibidos.push(msg))
    enlace.recibir({ type: 'push' })
    enlace.recibir({
      type: 'hello',
      token: 'unknown',
      hub_instancia: null,
      until: 0,
      version_app: 'x',
    })
    enlace.recibir({ type: 'pull', from: 0 })
    enlace.recibir({ type: 'ping', brand: 'm1' })

    expect(recibidos).toEqual([
      expect.objectContaining({ type: 'error', code: 'invalid_message' }),
      expect.objectContaining({ type: 'error', code: 'invalid_token' }),
      expect.objectContaining({ type: 'error', code: 'invalid_token' }),
      { type: 'pong', brand: 'm1' },
    ])
  })
})
