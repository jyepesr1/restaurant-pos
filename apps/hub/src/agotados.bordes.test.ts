import { type NewEvent, newId } from '@pos/core'
import { FloorSync, type HubMessage, HubSync } from '@pos/sync'
import { SqliteStore } from '@pos/sync/sqlite'
import { describe, expect, it } from 'vitest'
import { ABRIR, add, item, type MontajeHub, montarHub } from './acceso/montaje-hub'
import { actualizarVersionado, SISTEMA } from './acceso/registros'

// Agotado (86) con el control de acceso real del hub: cuarentena, revocación, difusión a los
// demás equipos y que un ítem de un producto agotado se acepte (docs/SYNC.md, tarea 1.3).

const DE_PRODUCTO = (product: string) => ({
  aggregate_type: 'product' as const,
  aggregate_id: product,
})
const data = (product: string, variant: string | null = null) => ({
  product_id: product,
  variant_id: variant,
})

const cambiarRol = (m: MontajeHub, userId: string, rolId: string) =>
  actualizarVersionado(
    m.db,
    'users',
    m.restaurantId,
    userId,
    { role_id: rolId },
    SISTEMA,
    m.clock(),
  )

const stateIn = (m: MontajeHub, id: string) =>
  m.db.prepare('SELECT status FROM quarantined_events WHERE event_id = ?').get(id) ??
  m.db.prepare('SELECT reason FROM rejected_events WHERE event_id = ?').get(id)

describe('cuarentena y rechazos de un agotado', () => {
  /** Un cajero con su sesión abierta en la caja, y una función para armar un agotado a una hora. */
  function cajaConSesion() {
    const m = montarHub()
    const { connection } = m.emparejar('register')
    const session = m.entrar(connection, 'cashier')
    const product = newId()
    const markSoldOut = (time = m.clock(), extras = {}) =>
      m.event(connection, session, 'ProductSoldOut', data(product), {
        ...DE_PRODUCTO(product),
        device_time: time,
        hub_estimated_time: time,
        ...extras,
      })
    return { m, connection, session, product, markSoldOut }
  }

  it('al cajero le quitan el permiso: lo de antes va a cuarentena y lo de después se rechaza', () => {
    const { m, connection, markSoldOut } = cajaConSesion()
    const before = markSoldOut()
    m.advance(10 * 60_000)
    cambiarRol(m, m.people.cashier.userId, m.roles.waiter)
    const change = m.clock()
    m.advance(10 * 60_000)
    const after = markSoldOut(add(change, 1000))

    const r = m.hub.receiveBatch(connection, [before, after])

    expect(r.results.map((x) => x.status)).toEqual(['quarantine', 'rejected'])
    expect(r.results[1]).toMatchObject({ reason: 'no_permission' })
    expect(
      m.db.prepare('SELECT reason FROM quarantined_events WHERE event_id = ?').get(before.id)
        ?.reason,
    ).toBe('permissions_changed')
    // Ni lo uno ni lo otro entró a la secuencia ni cambió pedido alguno.
    expect(m.db.prepare('SELECT count(*) AS n FROM events').get()?.n).toBe(0)
    expect(r.acceptedEvents).toEqual([])
  })

  it('al cajero lo archivan: lo de antes va a cuarentena y lo de después se rechaza', () => {
    const { m, connection, markSoldOut } = cajaConSesion()
    const before = markSoldOut()
    m.advance(10 * 60_000)
    m.access.archivarUsuario(m.people.cashier.userId)
    const archived = m.clock()
    m.advance(10 * 60_000)
    const after = markSoldOut(add(archived, 1000))

    const r = m.hub.receiveBatch(connection, [before, after])

    expect(r.results.map((x) => x.status)).toEqual(['quarantine', 'rejected'])
    expect(
      m.db.prepare('SELECT reason FROM quarantined_events WHERE event_id = ?').get(before.id)
        ?.reason,
    ).toBe('user_archived')
    expect(r.results[1]).toMatchObject({ reason: 'user_inactive' })
  })

  it('un dispositivo revocado: el agotado de antes va a cuarentena y el de después se rechaza', () => {
    const { m, connection, markSoldOut } = cajaConSesion()
    const before = markSoldOut()
    m.advance(60_000)
    const revocado = { ...connection, revokedAt: m.clock() }
    m.advance(60_000)
    const after = markSoldOut()

    const r = m.hub.receiveBatch(revocado, [before, after])

    expect(r.results.map((x) => x.status)).toEqual(['quarantine', 'rejected'])
    expect(r.results[1]).toMatchObject({ reason: 'revoked_device' })
    expect(
      m.db.prepare('SELECT reason FROM quarantined_events WHERE event_id = ?').get(before.id)
        ?.reason,
    ).toBe('revoked_device')
  })

  it('una sesión que el hub no conoce va a cuarentena, sin tumbar al hub', () => {
    const { m, connection, session, product } = cajaConSesion()
    const ajena = { ...session, sesionId: newId() }
    const e = m.event(connection, ajena, 'ProductSoldOut', data(product), DE_PRODUCTO(product))
    expect(m.hub.receiveBatch(connection, [e]).results).toEqual([
      { id: e.id, status: 'quarantine' },
    ])
  })

  it('sin sesión, con la firma alterada o de otro dispositivo se rechaza', () => {
    const { m, connection, session, product, markSoldOut } = cajaConSesion()
    const sinSesion = m.event(
      connection,
      { ...session, sesionId: null as unknown as string },
      'ProductSoldOut',
      data(product),
      { ...DE_PRODUCTO(product), session_id: null },
    )
    const tampered = { ...markSoldOut(), data: data(product, newId()) }
    const fromOther = { ...markSoldOut(), device_id: newId() }

    const r = m.hub.receiveBatch(connection, [sinSesion, tampered, fromOther])

    expect(r.results.map((x) => (x.status === 'rejected' ? x.reason : x.status))).toEqual([
      'no_session',
      'invalid_signature',
      'device_mismatch',
    ])
  })

  it('el mesero no puede, ni siquiera con el agotado de otro; cajero, gerente y administrador sí', () => {
    const m = montarHub()
    const product = newId()
    const probar = (who: 'waiter' | 'cashier' | 'manager' | 'admin') => {
      const { connection } = m.emparejar(who === 'cashier' ? 'register' : 'waiter')
      const session = m.entrar(connection, who)
      const e = m.event(connection, session, 'ProductSoldOut', data(product), DE_PRODUCTO(product))
      return m.hub.receiveBatch(connection, [e]).results[0]
    }
    expect(probar('waiter')).toMatchObject({ status: 'rejected', reason: 'no_permission' })
    for (const who of ['cashier', 'manager', 'admin'] as const)
      expect(probar(who), who).toMatchObject({ status: 'confirmed' })
  })

  it('un agotado rechazado en el lote no arrastra al pedido ni a otros productos', () => {
    const m = montarHub()
    const { connection } = m.emparejar('waiter')
    const session = m.entrar(connection, 'waiter')
    const x = newId()
    const y = newId()
    const order = newId()
    const r = m.hub.receiveBatch(connection, [
      m.event(connection, session, 'OrderOpened', ABRIR, { aggregate_id: order }),
      m.event(connection, session, 'ProductSoldOut', data(x), DE_PRODUCTO(x)),
      m.event(connection, session, 'ProductAvailable', data(x), DE_PRODUCTO(x)),
      m.event(connection, session, 'ItemAdded', item(), {
        aggregate_id: order,
        base_sequence: 1,
      }),
      m.event(connection, session, 'ProductSoldOut', data(y), DE_PRODUCTO(y)),
    ])
    // El mesero no tiene permiso: los de producto se rechazan (el permiso se juzga antes que la
    // dependencia), pero el pedido y su ítem siguen su camino.
    expect(r.results.map((e) => (e.status === 'rejected' ? e.reason : e.status))).toEqual([
      'confirmed',
      'no_permission',
      'no_permission',
      'confirmed',
      'no_permission',
    ])
  })
})

describe('contenido del agotado', () => {
  it('es idempotente: el mismo evento recibe la misma respuesta; con otro contenido, id_repetido', () => {
    const m = montarHub()
    const { connection } = m.emparejar('register')
    const session = m.entrar(connection, 'cashier')
    const product = newId()
    const e = m.event(connection, session, 'ProductSoldOut', data(product), DE_PRODUCTO(product))

    const a = m.hub.receiveBatch(connection, [e])
    const b = m.hub.receiveBatch(connection, [e])
    expect(b.results).toEqual(a.results)
    expect(b.acceptedEvents).toEqual([])
    expect(m.db.prepare('SELECT count(*) AS n FROM events').get()?.n).toBe(1)

    const other = m.firmado(session, { ...e, data: data(product, newId()) } as NewEvent)
    expect(m.hub.receiveBatch(connection, [other]).results[0]).toMatchObject({
      status: 'rejected',
      reason: 'duplicate_id',
    })
  })

  it('una secuencia_base inventada se rechaza igual que en un pedido', () => {
    const m = montarHub()
    const { connection } = m.emparejar('register')
    const session = m.entrar(connection, 'cashier')
    const product = newId()
    const e = m.event(connection, session, 'ProductSoldOut', data(product), {
      ...DE_PRODUCTO(product),
      base_sequence: 50,
    })
    expect(m.hub.receiveBatch(connection, [e]).results[0]).toMatchObject({
      status: 'rejected',
      reason: 'invalid_base_sequence',
    })
  })

  it('se guarda como evento del producto y sobrevive al reinicio sin tocar los pedidos', () => {
    const m = montarHub()
    const { connection } = m.emparejar('register')
    const session = m.entrar(connection, 'cashier')
    const order = newId()
    const product = newId()
    const r = m.hub.receiveBatch(connection, [
      m.event(connection, session, 'OrderOpened', ABRIR, { aggregate_id: order }),
      m.event(connection, session, 'ProductSoldOut', data(product), DE_PRODUCTO(product)),
      m.event(connection, session, 'ItemAdded', item(), {
        aggregate_id: order,
        base_sequence: 1,
      }),
      m.event(connection, session, 'ProductAvailable', data(product), DE_PRODUCTO(product)),
    ])
    expect(r.results.map((x) => x.status)).toEqual(Array(4).fill('confirmed'))
    expect(
      m.db
        .prepare('SELECT aggregate_type, aggregate_id FROM events WHERE type = ?')
        .get('ProductSoldOut'),
    ).toEqual({ aggregate_type: 'product', aggregate_id: product })
    const before = structuredClone(m.hub.order(order))

    const restarted = new HubSync(new SqliteStore(m.db, m.restaurantId), {
      restaurantId: m.restaurantId,
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      instance: 'hub-1',
      clock: m.clock,
      access: m.access,
    })
    expect(restarted.order(order)).toEqual(before)
    expect(restarted.order(product)).toBeNull()
    expect(restarted.hasOpenOrder(newId())).toBe(false)
    expect(restarted.pull(0, 'register').events.map((e) => e.type)).toEqual([
      'OrderOpened',
      'ProductSoldOut',
      'ItemAdded',
      'ProductAvailable',
    ])
  })
})

describe('un ítem de un producto agotado', () => {
  it('se acepta: quien lo pidió sin conexión no se queda sin su pedido', () => {
    const m = montarHub()
    const register = m.emparejar('register')
    const cashier = m.entrar(register.connection, 'cashier')
    const phone = m.emparejar('waiter')
    const waiter = m.entrar(phone.connection, 'waiter')
    const order = newId()
    const product = newId()
    const it1 = { ...item(), product_id: product }

    // La caja agota el producto (secuencia 1); el mesero, sin saberlo, pide el producto.
    m.hub.receiveBatch(register.connection, [
      m.event(register.connection, cashier, 'ProductSoldOut', data(product), DE_PRODUCTO(product)),
    ])
    const r = m.hub.receiveBatch(phone.connection, [
      m.event(phone.connection, waiter, 'OrderOpened', ABRIR, { aggregate_id: order }),
      m.event(phone.connection, waiter, 'ItemAdded', it1, { aggregate_id: order }),
    ])

    expect(r.results.map((x) => x.status)).toEqual(['confirmed', 'confirmed'])
    expect(r.results[1]).toMatchObject({ conflict: null })
    expect(Object.keys(m.hub.order(order)?.items ?? {})).toEqual([it1.item_id])
    expect(m.hub.conflicts()).toEqual([])
  })

  it('tampoco se rechaza cuando el agotado llega después en el mismo lote', () => {
    const m = montarHub()
    const { connection } = m.emparejar('register')
    const session = m.entrar(connection, 'cashier')
    const order = newId()
    const product = newId()
    const r = m.hub.receiveBatch(connection, [
      m.event(connection, session, 'OrderOpened', ABRIR, { aggregate_id: order }),
      m.event(connection, session, 'ProductSoldOut', data(product), DE_PRODUCTO(product)),
      m.event(
        connection,
        session,
        'ItemAdded',
        { ...item(), product_id: product },
        {
          aggregate_id: order,
          base_sequence: 1,
        },
      ),
    ])
    expect(r.results.map((x) => x.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
  })
})

describe('el aviso nuevo llega a los demás equipos', () => {
  it('un agotado de la caja lo reciben el celular y la cocina, sin la sesión de quien lo hizo', () => {
    const m = montarHub()
    const floor = new FloorSync(m.hub, m.access.authenticate)
    const register = m.emparejar('register')
    const phone = m.emparejar('waiter')
    const kitchen = m.emparejar('kds')
    const received: Record<string, HubMessage[]> = { register: [], phone: [], kitchen: [] }
    const open = (name: string, token: string) => {
      const link = floor.connect((x) => received[name]?.push(x))
      link.receive({ type: 'hello', token, hub_instance: null, until: 0, version_app: 'x' })
      return link
    }
    const enCaja = open('register', register.token)
    open('phone', phone.token)
    open('kitchen', kitchen.token)

    const cashier = m.entrar(register.connection, 'cashier')
    const product = newId()
    const bottle = newId()
    const e = m.event(
      register.connection,
      cashier,
      'ProductSoldOut',
      data(product, bottle),
      DE_PRODUCTO(product),
    )
    enCaja.receive({ type: 'push', batch_id: 'l1', events: [e] })

    for (const name of ['phone', 'kitchen', 'register']) {
      const fresh = received[name]?.find((x) => x.type === 'new')
      expect(fresh, name).toMatchObject({
        event: {
          id: e.id,
          type: 'ProductSoldOut',
          aggregate_type: 'product',
          sequence: 1,
          data: { product_id: product, variant_id: bottle },
        },
        previous_until: 0,
        until: 1,
      })
    }
    // Los demás no reciben la sesión de quien lo creó; la caja, que es suya, sí.
    const deCelular = received.phone?.find((x) => x.type === 'new')
    expect(deCelular?.type === 'new' && deCelular.event.session_id).toBeNull()
    const fromRegister = received.register?.find((x) => x.type === 'new')
    expect(fromRegister?.type === 'new' && fromRegister.event.session_id).toBe(cashier.sesionId)
  })

  it('un equipo revocado no recibe el aviso, y uno que se conecta después lo trae con `traer`', () => {
    const m = montarHub()
    const floor = new FloorSync(m.hub, m.access.authenticate)
    const register = m.emparejar('register')
    const phone = m.emparejar('waiter')
    const received: HubMessage[] = []
    const link = floor.connect((x) => received.push(x))
    link.receive({
      type: 'hello',
      token: phone.token,
      hub_instance: null,
      until: 0,
      version_app: 'x',
    })
    floor.revoke(phone.connection.deviceId, m.clock())

    const cashier = m.entrar(register.connection, 'cashier')
    const product = newId()
    m.hub.receiveBatch(register.connection, [
      m.event(register.connection, cashier, 'ProductSoldOut', data(product), DE_PRODUCTO(product)),
    ])
    expect(received.some((x) => x.type === 'new')).toBe(false)

    const late: HubMessage[] = []
    const other = floor.connect((x) => late.push(x))
    const nuevoCelular = m.emparejar('waiter')
    other.receive({
      type: 'hello',
      token: nuevoCelular.token,
      hub_instance: null,
      until: 0,
      version_app: 'x',
    })
    other.receive({ type: 'pull', from: 0 })
    const events = late.find((x) => x.type === 'events')
    expect(events?.type === 'events' && events.events.map((e) => e.type)).toEqual([
      'ProductSoldOut',
    ])
  })
})

// Evita que el helper `stateIn` quede sin uso si se simplifican las pruebas anteriores.
void stateIn
