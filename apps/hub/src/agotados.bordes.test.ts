import { type NewEvent, newId } from '@pos/core'
import { HubSync, type MensajeHub, SalaSync } from '@pos/sync'
import { AlmacenSqlite } from '@pos/sync/sqlite'
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
    m.restauranteId,
    userId,
    { role_id: rolId },
    SISTEMA,
    m.clock(),
  )

const estadoEn = (m: MontajeHub, id: string) =>
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
    m.avanzar(10 * 60_000)
    cambiarRol(m, m.people.cashier.userId, m.roles.waiter)
    const change = m.clock()
    m.avanzar(10 * 60_000)
    const after = markSoldOut(add(change, 1000))

    const r = m.hub.recibirLote(connection, [before, after])

    expect(r.resultados.map((x) => x.status)).toEqual(['quarantine', 'rejected'])
    expect(r.resultados[1]).toMatchObject({ reason: 'no_permission' })
    expect(
      m.db.prepare('SELECT reason FROM quarantined_events WHERE event_id = ?').get(before.id)
        ?.reason,
    ).toBe('permissions_changed')
    // Ni lo uno ni lo otro entró a la secuencia ni cambió pedido alguno.
    expect(m.db.prepare('SELECT count(*) AS n FROM events').get()?.n).toBe(0)
    expect(r.aceptados).toEqual([])
  })

  it('al cajero lo archivan: lo de antes va a cuarentena y lo de después se rechaza', () => {
    const { m, connection, markSoldOut } = cajaConSesion()
    const before = markSoldOut()
    m.avanzar(10 * 60_000)
    m.access.archivarUsuario(m.people.cashier.userId)
    const archived = m.clock()
    m.avanzar(10 * 60_000)
    const after = markSoldOut(add(archived, 1000))

    const r = m.hub.recibirLote(connection, [before, after])

    expect(r.resultados.map((x) => x.status)).toEqual(['quarantine', 'rejected'])
    expect(
      m.db.prepare('SELECT reason FROM quarantined_events WHERE event_id = ?').get(before.id)
        ?.reason,
    ).toBe('user_archived')
    expect(r.resultados[1]).toMatchObject({ reason: 'user_inactive' })
  })

  it('un dispositivo revocado: el agotado de antes va a cuarentena y el de después se rechaza', () => {
    const { m, connection, markSoldOut } = cajaConSesion()
    const before = markSoldOut()
    m.avanzar(60_000)
    const revocado = { ...connection, revocadoEn: m.clock() }
    m.avanzar(60_000)
    const after = markSoldOut()

    const r = m.hub.recibirLote(revocado, [before, after])

    expect(r.resultados.map((x) => x.status)).toEqual(['quarantine', 'rejected'])
    expect(r.resultados[1]).toMatchObject({ reason: 'revoked_device' })
    expect(
      m.db.prepare('SELECT reason FROM quarantined_events WHERE event_id = ?').get(before.id)
        ?.reason,
    ).toBe('revoked_device')
  })

  it('una sesión que el hub no conoce va a cuarentena, sin tumbar al hub', () => {
    const { m, connection, session, product } = cajaConSesion()
    const ajena = { ...session, sesionId: newId() }
    const e = m.event(connection, ajena, 'ProductSoldOut', data(product), DE_PRODUCTO(product))
    expect(m.hub.recibirLote(connection, [e]).resultados).toEqual([
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
    const alterado = { ...markSoldOut(), data: data(product, newId()) }
    const fromOther = { ...markSoldOut(), device_id: newId() }

    const r = m.hub.recibirLote(connection, [sinSesion, alterado, fromOther])

    expect(r.resultados.map((x) => (x.status === 'rejected' ? x.reason : x.status))).toEqual([
      'no_session',
      'invalid_signature',
      'device_mismatch',
    ])
  })

  it('el mesero no puede, ni siquiera con el agotado de otro; cajero, gerente y administrador sí', () => {
    const m = montarHub()
    const product = newId()
    const probar = (quien: 'waiter' | 'cashier' | 'manager' | 'admin') => {
      const { connection } = m.emparejar(quien === 'cashier' ? 'register' : 'waiter')
      const session = m.entrar(connection, quien)
      const e = m.event(connection, session, 'ProductSoldOut', data(product), DE_PRODUCTO(product))
      return m.hub.recibirLote(connection, [e]).resultados[0]
    }
    expect(probar('waiter')).toMatchObject({ status: 'rejected', reason: 'no_permission' })
    for (const quien of ['cashier', 'manager', 'admin'] as const)
      expect(probar(quien), quien).toMatchObject({ status: 'confirmed' })
  })

  it('un agotado rechazado en el lote no arrastra al pedido ni a otros productos', () => {
    const m = montarHub()
    const { connection } = m.emparejar('waiter')
    const session = m.entrar(connection, 'waiter')
    const x = newId()
    const y = newId()
    const order = newId()
    const r = m.hub.recibirLote(connection, [
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
    expect(r.resultados.map((e) => (e.status === 'rejected' ? e.reason : e.status))).toEqual([
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

    const a = m.hub.recibirLote(connection, [e])
    const b = m.hub.recibirLote(connection, [e])
    expect(b.resultados).toEqual(a.resultados)
    expect(b.aceptados).toEqual([])
    expect(m.db.prepare('SELECT count(*) AS n FROM events').get()?.n).toBe(1)

    const other = m.firmado(session, { ...e, data: data(product, newId()) } as NewEvent)
    expect(m.hub.recibirLote(connection, [other]).resultados[0]).toMatchObject({
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
    expect(m.hub.recibirLote(connection, [e]).resultados[0]).toMatchObject({
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
    const r = m.hub.recibirLote(connection, [
      m.event(connection, session, 'OrderOpened', ABRIR, { aggregate_id: order }),
      m.event(connection, session, 'ProductSoldOut', data(product), DE_PRODUCTO(product)),
      m.event(connection, session, 'ItemAdded', item(), {
        aggregate_id: order,
        base_sequence: 1,
      }),
      m.event(connection, session, 'ProductAvailable', data(product), DE_PRODUCTO(product)),
    ])
    expect(r.resultados.map((x) => x.status)).toEqual(Array(4).fill('confirmed'))
    expect(
      m.db
        .prepare('SELECT aggregate_type, aggregate_id FROM events WHERE type = ?')
        .get('ProductSoldOut'),
    ).toEqual({ aggregate_type: 'product', aggregate_id: product })
    const before = structuredClone(m.hub.order(order))

    const reiniciado = new HubSync(new AlmacenSqlite(m.db, m.restauranteId), {
      restauranteId: m.restauranteId,
      timeZone: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      instancia: 'hub-1',
      clock: m.clock,
      access: m.access,
    })
    expect(reiniciado.order(order)).toEqual(before)
    expect(reiniciado.order(product)).toBeNull()
    expect(reiniciado.tienePedidoAbierto(newId())).toBe(false)
    expect(reiniciado.pull(0, 'register').events.map((e) => e.type)).toEqual([
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
    m.hub.recibirLote(register.connection, [
      m.event(register.connection, cashier, 'ProductSoldOut', data(product), DE_PRODUCTO(product)),
    ])
    const r = m.hub.recibirLote(phone.connection, [
      m.event(phone.connection, waiter, 'OrderOpened', ABRIR, { aggregate_id: order }),
      m.event(phone.connection, waiter, 'ItemAdded', it1, { aggregate_id: order }),
    ])

    expect(r.resultados.map((x) => x.status)).toEqual(['confirmed', 'confirmed'])
    expect(r.resultados[1]).toMatchObject({ conflict: null })
    expect(Object.keys(m.hub.order(order)?.items ?? {})).toEqual([it1.item_id])
    expect(m.hub.conflictos()).toEqual([])
  })

  it('tampoco se rechaza cuando el agotado llega después en el mismo lote', () => {
    const m = montarHub()
    const { connection } = m.emparejar('register')
    const session = m.entrar(connection, 'cashier')
    const order = newId()
    const product = newId()
    const r = m.hub.recibirLote(connection, [
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
    expect(r.resultados.map((x) => x.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
  })
})

describe('el aviso nuevo llega a los demás equipos', () => {
  it('un agotado de la caja lo reciben el celular y la cocina, sin la sesión de quien lo hizo', () => {
    const m = montarHub()
    const sala = new SalaSync(m.hub, m.access.authenticate)
    const register = m.emparejar('register')
    const phone = m.emparejar('waiter')
    const kitchen = m.emparejar('kds')
    const recibidos: Record<string, MensajeHub[]> = { register: [], phone: [], kitchen: [] }
    const open = (name: string, token: string) => {
      const enlace = sala.connect((x) => recibidos[name]?.push(x))
      enlace.recibir({ type: 'hello', token, hub_instancia: null, until: 0, version_app: 'x' })
      return enlace
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
    enCaja.recibir({ type: 'push', lote_id: 'l1', events: [e] })

    for (const name of ['phone', 'kitchen', 'register']) {
      const fresh = recibidos[name]?.find((x) => x.type === 'new')
      expect(fresh, name).toMatchObject({
        event: {
          id: e.id,
          type: 'ProductSoldOut',
          aggregate_type: 'product',
          sequence: 1,
          data: { product_id: product, variant_id: bottle },
        },
        hasta_anterior: 0,
        until: 1,
      })
    }
    // Los demás no reciben la sesión de quien lo creó; la caja, que es suya, sí.
    const deCelular = recibidos.phone?.find((x) => x.type === 'new')
    expect(deCelular?.type === 'new' && deCelular.event.session_id).toBeNull()
    const deCaja = recibidos.register?.find((x) => x.type === 'new')
    expect(deCaja?.type === 'new' && deCaja.event.session_id).toBe(cashier.sesionId)
  })

  it('un equipo revocado no recibe el aviso, y uno que se conecta después lo trae con `traer`', () => {
    const m = montarHub()
    const sala = new SalaSync(m.hub, m.access.authenticate)
    const register = m.emparejar('register')
    const phone = m.emparejar('waiter')
    const recibidos: MensajeHub[] = []
    const enlace = sala.connect((x) => recibidos.push(x))
    enlace.recibir({
      type: 'hello',
      token: phone.token,
      hub_instancia: null,
      until: 0,
      version_app: 'x',
    })
    sala.revoke(phone.connection.dispositivoId, m.clock())

    const cashier = m.entrar(register.connection, 'cashier')
    const product = newId()
    m.hub.recibirLote(register.connection, [
      m.event(register.connection, cashier, 'ProductSoldOut', data(product), DE_PRODUCTO(product)),
    ])
    expect(recibidos.some((x) => x.type === 'new')).toBe(false)

    const tarde: MensajeHub[] = []
    const other = sala.connect((x) => tarde.push(x))
    const nuevoCelular = m.emparejar('waiter')
    other.recibir({
      type: 'hello',
      token: nuevoCelular.token,
      hub_instancia: null,
      until: 0,
      version_app: 'x',
    })
    other.recibir({ type: 'pull', from: 0 })
    const events = tarde.find((x) => x.type === 'events')
    expect(events?.type === 'events' && events.events.map((e) => e.type)).toEqual([
      'ProductSoldOut',
    ])
  })
})

// Evita que el helper `estadoEn` quede sin uso si se simplifican las pruebas anteriores.
void estadoEn
