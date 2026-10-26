import { newId } from '@pos/core'
import { type MensajeHub, SalaSync } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import {
  ABRIR,
  add,
  autorizarEvento,
  datosAnular,
  type MontajeHub,
  montarHub,
  pedidoConItemEnviado,
} from './montaje-hub'
import { actualizarVersionado, SISTEMA } from './registros'
import { ENTREGA_AUTORIZADO_MS, VIGENCIA_AUTORIZACION_MS } from './servicio'

// Carreras entre el comprobante de supervisor, la sesión, el reloj del dispositivo y la
// revocación, con el hub de sincronización completo (docs/SYNC.md#seguridad).

interface OpcionesComprobante {
  quien?: 'manager' | 'admin'
  /** Hora del evento respecto de la emisión del comprobante (la fija el dispositivo al pedirlo). */
  desfase?: number
  /** Ítem que se anula (por defecto, el que sí existe). */
  itemId?: string
}

/** El mesero tiene un ítem enviado y pide que la gerente autorice anularlo. */
function conComprobante(m: MontajeHub, o: OpcionesComprobante = {}) {
  const base = pedidoConItemEnviado(m)
  // Un rato después de abrir la sesión, para poder probar eventos «anteriores» al comprobante.
  m.avanzar(5 * 60_000)
  const emitida = m.clock()
  const time = add(emitida, o.desfase ?? 0)
  const sinComprobante = m.event(
    base.connection,
    base.session,
    'ItemVoided',
    datosAnular(o.itemId ?? base.itemId),
    {
      aggregate_id: base.order,
      reason: 'El cliente cambió de idea',
      base_sequence: 3,
      device_time: time,
      hub_estimated_time: time,
    },
  )
  const { comprobante, event } = autorizarEvento(
    m,
    base.connection,
    base.session,
    m.people[o.quien ?? 'manager'].pin,
    sinComprobante,
  )
  /** El evento autorizado, con ajustes que el dispositivo no debería poder hacer (y se firma de nuevo). */
  const voidItem = (extras: object = {}) => m.firmado(base.session, { ...event, ...extras })
  return {
    ...base,
    event,
    eventId: event.id,
    autorizacionId: comprobante.autorizacionId,
    emitida,
    voidItem,
  }
}

const comprobante = (m: MontajeHub) =>
  m.db.prepare('SELECT supervisor_id, used_at FROM authorizations').get()
const events = (m: MontajeHub) => Number(m.db.prepare('SELECT count(*) AS n FROM events').get()?.n)
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

describe('un comprobante, un solo evento', () => {
  it('dos eventos con el mismo comprobante en un lote: solo el suyo pasa', () => {
    const m = montarHub()
    const c = conComprobante(m)
    const other = c.voidItem({ id: newId() })
    const r = m.hub.recibirLote(c.connection, [c.voidItem(), other])

    expect(r.resultados.map((x) => x.status)).toEqual(['confirmed', 'rejected'])
    expect(r.resultados[1]).toMatchObject({ reason: 'invalid_authorization' })
    expect(comprobante(m)).toMatchObject({ used_at: m.clock() })
  })

  it('un intruso que va antes con el comprobante ajeno no lo gasta: el legítimo entra en otro lote', () => {
    const m = montarHub()
    const c = conComprobante(m)
    const other = c.voidItem({ id: newId() })

    // En el mismo lote, el rechazo arrastra a los siguientes del mismo pedido (depende de él).
    const junto = m.hub.recibirLote(c.connection, [other, c.voidItem()])
    expect(junto.resultados.map((x) => x.status)).toEqual(['rejected', 'rejected'])
    expect(comprobante(m)).toMatchObject({ used_at: null })

    // Pero el comprobante sigue siendo del suyo: en un lote aparte, el legítimo pasa.
    const aparte = montarHub()
    const d = conComprobante(aparte)
    aparte.hub.recibirLote(d.connection, [d.voidItem({ id: newId() })])
    expect(aparte.hub.recibirLote(d.connection, [d.voidItem()]).resultados[0]?.status).toBe(
      'confirmed',
    )
  })

  it('el mismo evento dos veces en el lote se guarda una vez y ambas dan la misma respuesta', () => {
    const m = montarHub()
    const c = conComprobante(m)
    const before = events(m)
    const r = m.hub.recibirLote(c.connection, [c.voidItem(), c.voidItem()])

    expect(r.resultados.map((x) => x.status)).toEqual(['confirmed', 'confirmed'])
    expect(r.resultados[0]).toEqual(r.resultados[1])
    expect(events(m)).toBe(before + 1)
  })

  it('el mismo id con otro contenido no aprovecha el comprobante ya usado', () => {
    const m = montarHub()
    const c = conComprobante(m)
    m.hub.recibirLote(c.connection, [c.voidItem()])
    const other = m.hub.recibirLote(c.connection, [c.voidItem({ reason: 'Otro motivo' })])

    expect(other.resultados[0]).toMatchObject({ status: 'rejected', reason: 'duplicate_id' })
  })

  it('un evento rechazado por una regla del pedido no gasta el comprobante', () => {
    const m = montarHub()
    // El ítem no existe: el comprobante es válido para ese contenido, pero la regla lo rechaza.
    const c = conComprobante(m, { itemId: newId() })
    const r = m.hub.recibirLote(c.connection, [c.voidItem()])

    expect(r.resultados[0]?.status).toBe('rejected')
    expect(r.resultados[0]).not.toMatchObject({ reason: 'invalid_authorization' })
    expect(comprobante(m)).toMatchObject({ used_at: null })
    expect(events(m)).toBe(3)
  })

  it('un comprobante con el evento rechazado por esquema tampoco se gasta', () => {
    const m = montarHub()
    const c = conComprobante(m)
    const r = m.hub.recibirLote(c.connection, [{ ...c.voidItem(), data: 'no es un objeto' }])

    expect(r.resultados[0]?.status).toBe('rejected')
    expect(comprobante(m)).toMatchObject({ used_at: null })
  })

  it('el comprobante es para ese contenido exacto: cualquier cambio lo invalida y no lo gasta', () => {
    const m = montarHub()
    const c = conComprobante(m)
    const changes: Record<string, object> = {
      anotherOrder: { aggregate_id: newId() },
      otraCantidad: { data: { ...datosAnular(c.itemId), quantity: 2 } },
      otroItem: { data: { ...datosAnular(newId()) } },
      alreadyPrepared: { data: { ...datosAnular(c.itemId), already_prepared: true } },
      otroMotivo: { reason: 'Cambiado a escondidas' },
      otraHora: {
        device_time: add(c.emitida, 1000),
        hub_estimated_time: add(c.emitida, 1000),
      },
    }
    for (const [name, change] of Object.entries(changes)) {
      const r = m.hub.recibirLote(c.connection, [c.voidItem(change)])
      expect(r.resultados[0], name).toMatchObject({ status: 'rejected' })
      expect(comprobante(m), name).toMatchObject({ used_at: null })
    }
    // El evento original, tras tantos intentos fallidos con el mismo id, sigue valiendo.
    expect(m.hub.recibirLote(c.connection, [c.voidItem()]).resultados[0]?.status).toBe('confirmed')
  })

  it('lo que el dispositivo sí puede ajustar al reenviar (secuencia_base) no invalida el comprobante', () => {
    const m = montarHub()
    const c = conComprobante(m)
    expect(
      m.hub.recibirLote(c.connection, [c.voidItem({ base_sequence: 0 })]).resultados[0]?.status,
    ).toBe('confirmed')
  })

  it('el comprobante es de la sesión que lo pidió: otra sesión del mismo usuario no lo usa', () => {
    const m = montarHub()
    const c = conComprobante(m)
    m.avanzar(1000)
    const another = m.entrar(c.connection, 'waiter')
    const robado = m.firmado(another, { ...c.event, session_id: another.sesionId })

    expect(m.hub.recibirLote(c.connection, [robado]).resultados[0]).toMatchObject({
      status: 'rejected',
      reason: 'invalid_authorization',
    })
    // Y el evento de la sesión original, creado antes del cambio, sigue valiendo.
    expect(m.hub.recibirLote(c.connection, [c.voidItem()]).resultados[0]?.status).toBe('confirmed')
  })

  it('el comprobante de un celular no sirve en otro dispositivo, aunque sea el mismo usuario', () => {
    const m = montarHub()
    const c = conComprobante(m)
    const other = m.emparejar('waiter', 'Otro celular').connection
    const s = m.entrar(other, 'waiter')
    const copy = m.firmado(s, {
      ...c.event,
      session_id: s.sesionId,
      device_id: other.dispositivoId,
    })

    expect(m.hub.recibirLote(other, [copy]).resultados[0]).toMatchObject({
      status: 'rejected',
      reason: 'invalid_authorization',
    })
  })
})

describe('el supervisor cambia antes de que llegue el evento', () => {
  const rechazoPorComprobante = { status: 'rejected', reason: 'invalid_authorization' }

  it('si el supervisor se archiva después de autorizar, el comprobante ya no vale', () => {
    const m = montarHub()
    const c = conComprobante(m)
    m.access.archivarUsuario(m.people.manager.userId)

    const r = m.hub.recibirLote(c.connection, [c.voidItem()])
    expect(r.resultados[0]).toMatchObject(rechazoPorComprobante)
    expect(m.hub.order(c.order)?.items[c.itemId]?.status).toBe('sent')
  })

  it('si cambia al supervisor a un rol sin el permiso, deja de valer', () => {
    const m = montarHub()
    const c = conComprobante(m)
    cambiarRol(m, m.people.manager.userId, m.roles.waiter)

    expect(m.hub.recibirLote(c.connection, [c.voidItem()]).resultados[0]).toMatchObject(
      rechazoPorComprobante,
    )
  })

  it('si al rol del supervisor se le quita el permiso, deja de valer', () => {
    const m = montarHub()
    const c = conComprobante(m)
    m.db
      .prepare(
        "UPDATE role_permissions SET active = 0 WHERE role_id = ? AND permission = 'void_sent_item'",
      )
      .run(m.roles.manager)

    expect(m.hub.recibirLote(c.connection, [c.voidItem()]).resultados[0]).toMatchObject(
      rechazoPorComprobante,
    )
  })

  it('si se archiva el rol entero del supervisor, deja de valer', () => {
    const m = montarHub()
    const c = conComprobante(m)
    m.db.prepare('UPDATE roles SET active = 0 WHERE id = ?').run(m.roles.manager)

    expect(m.hub.recibirLote(c.connection, [c.voidItem()]).resultados[0]).toMatchObject(
      rechazoPorComprobante,
    )
  })

  it('un supervisor que cambió de PIN sigue siendo el mismo supervisor: el comprobante vale', () => {
    const m = montarHub()
    const c = conComprobante(m)
    m.access.regenerarPin(m.people.manager.userId)

    expect(m.hub.recibirLote(c.connection, [c.voidItem()]).resultados[0]).toMatchObject({
      status: 'confirmed',
      aceptacion: { authorized_by_id: m.people.manager.userId },
    })
  })

  it('si el propio mesero ya tiene el permiso al llegar el evento, no hace falta el comprobante', () => {
    const m = montarHub()
    const c = conComprobante(m)
    cambiarRol(m, m.people.waiter.userId, m.roles.manager)

    const r = m.hub.recibirLote(c.connection, [c.voidItem()])
    expect(r.resultados[0]).toMatchObject({
      status: 'confirmed',
      aceptacion: { authorized_by_id: null },
    })
    // El comprobante no se gastó: no hizo falta.
    expect(comprobante(m)).toMatchObject({ used_at: null })
  })

  describe('al autor del evento le quitan el permiso o lo archivan', () => {
    /** La gerente anula un ítem sin conexión; luego el administrador cambia su situación. */
    function gerenteSinConexion() {
      const m = montarHub()
      const { connection } = m.emparejar('waiter')
      const session = m.entrar(connection, 'manager')
      const voidItem = (time: string) =>
        m.event(connection, session, 'ItemVoided', datosAnular(newId()), {
          reason: 'x',
          device_time: time,
          hub_estimated_time: time,
        })
      return { m, connection, session, voidItem }
    }

    it('lo que hizo antes del cambio va a cuarentena para que alguien lo revise; lo de después, rechazado', () => {
      const { m, connection, voidItem } = gerenteSinConexion()
      const before = voidItem(m.clock())
      m.avanzar(10 * 60_000)
      cambiarRol(m, m.people.manager.userId, m.roles.waiter)
      const change = m.clock()
      m.avanzar(10 * 60_000)
      const after = voidItem(add(change, 1000))

      const r = m.hub.recibirLote(connection, [before, after])
      expect(r.resultados.map((x) => x.status)).toEqual(['quarantine', 'rejected'])
      expect(r.resultados[1]).toMatchObject({ reason: 'no_permission' })
      expect(
        m.db.prepare('SELECT reason FROM quarantined_events WHERE event_id = ?').get(before.id)
          ?.reason,
      ).toBe('permissions_changed')
      expect(events(m)).toBe(0)
    })

    it('el borde: justo en el instante del cambio ya cuenta como posterior', () => {
      const { m, connection, voidItem } = gerenteSinConexion()
      m.avanzar(10 * 60_000)
      cambiarRol(m, m.people.manager.userId, m.roles.waiter)
      const change = m.clock()

      const r = m.hub.recibirLote(connection, [voidItem(add(change, -1)), voidItem(change)])
      expect(r.resultados.map((x) => x.status)).toEqual(['quarantine', 'rejected'])
    })

    it('un usuario archivado: lo anterior al archivado se revisa, lo posterior se rechaza', () => {
      const { m, connection, voidItem } = gerenteSinConexion()
      const before = voidItem(m.clock())
      m.avanzar(10 * 60_000)
      m.access.archivarUsuario(m.people.manager.userId)
      const closeout = m.clock()
      const justoDespues = voidItem(add(closeout, 1000))
      const muchoDespues = voidItem(add(closeout, 61_000))

      const r = m.hub.recibirLote(connection, [before, justoDespues, muchoDespues])
      expect(r.resultados.map((x) => x.status)).toEqual(['quarantine', 'rejected', 'rejected'])
      expect(r.resultados.slice(1)).toMatchObject([
        { reason: 'user_inactive' },
        { reason: 'session_closed' },
      ])
    })

    it('el cambio de otro usuario no pone en duda lo de este: sin permiso sigue siendo un rechazo', () => {
      const m = montarHub()
      const { connection } = m.emparejar('waiter')
      const session = m.entrar(connection, 'waiter')
      const before = m.event(connection, session, 'ItemVoided', datosAnular(newId()), {
        reason: 'x',
      })
      m.avanzar(10 * 60_000)
      cambiarRol(m, m.people.cashier.userId, m.roles.reports)

      expect(m.hub.recibirLote(connection, [before]).resultados[0]).toMatchObject({
        status: 'rejected',
        reason: 'no_permission',
      })
    })
  })
})

describe('evento que llega tarde pero se creó a tiempo', () => {
  it('sin conexión: creado a los 119 s del comprobante y recibido media hora después, vale', () => {
    const m = montarHub()
    const c = conComprobante(m, { desfase: 119_000 })
    m.avanzar(30 * 60_000)

    const r = m.hub.recibirLote(c.connection, [c.voidItem()])
    expect(r.resultados[0]).toMatchObject({
      status: 'confirmed',
      aceptacion: { authorized_by_id: m.people.manager.userId },
    })
  })

  it('los bordes de la vigencia: -60 s y +120 s valen; un milisegundo más, no', () => {
    const casos: [number, 'confirmed' | 'rejected'][] = [
      [-60_001, 'rejected'],
      [-60_000, 'confirmed'],
      [0, 'confirmed'],
      [VIGENCIA_AUTORIZACION_MS, 'confirmed'],
      [VIGENCIA_AUTORIZACION_MS + 1, 'rejected'],
    ]
    for (const [desfase, expected] of casos) {
      const m = montarHub()
      const c = conComprobante(m, { desfase })
      const r = m.hub.recibirLote(c.connection, [c.voidItem()])
      expect(r.resultados[0]?.status, `desfase ${desfase}`).toBe(expected)
      if (expected === 'rejected')
        expect(r.resultados[0]).toMatchObject({ reason: 'invalid_authorization' })
    }
  })

  it('un evento con hora de mucho después del comprobante (reloj adelantado) no estira la vigencia', () => {
    const m = montarHub()
    const c = conComprobante(m, { desfase: 10 * 60_000 })

    expect(m.hub.recibirLote(c.connection, [c.voidItem()]).resultados[0]).toMatchObject({
      status: 'rejected',
      reason: 'invalid_authorization',
    })
  })

  it('el comprobante se entrega al hub en 12 horas, a más tardar', () => {
    const casos: [number, 'confirmed' | 'rejected'][] = [
      [ENTREGA_AUTORIZADO_MS - 1, 'confirmed'],
      [ENTREGA_AUTORIZADO_MS, 'confirmed'],
      [ENTREGA_AUTORIZADO_MS + 1, 'rejected'],
    ]
    for (const [delay, expected] of casos) {
      const m = montarHub()
      const c = conComprobante(m)
      m.avanzar(delay)
      const r = m.hub.recibirLote(c.connection, [c.voidItem()])
      expect(r.resultados[0]?.status, `espera ${delay}`).toBe(expected)
    }
  })
})

describe('sesiones y reloj', () => {
  it('los bordes de la tolerancia de 60 s al inicio de la sesión', () => {
    const casos: [number, 'confirmed' | 'rejected'][] = [
      [-60_001, 'rejected'],
      [-60_000, 'confirmed'],
      [0, 'confirmed'],
    ]
    for (const [desfase, expected] of casos) {
      const m = montarHub()
      m.avanzar(60 * 60_000)
      const { connection } = m.emparejar('waiter')
      const session = m.entrar(connection, 'waiter')
      const time = add(m.clock(), desfase)
      const ev = m.event(connection, session, 'OrderOpened', ABRIR, {
        device_time: time,
        hub_estimated_time: time,
      })
      const r = m.hub.recibirLote(connection, [ev])
      expect(r.resultados[0]?.status, `desfase ${desfase}`).toBe(expected)
      if (expected === 'rejected')
        expect(r.resultados[0]).toMatchObject({ reason: 'session_closed' })
    }
  })

  it('los bordes de la tolerancia de 60 s al cierre de la sesión', () => {
    const casos: [number, 'confirmed' | 'rejected'][] = [
      [0, 'confirmed'],
      [60_000, 'confirmed'],
      [60_001, 'rejected'],
    ]
    for (const [desfase, expected] of casos) {
      const m = montarHub()
      const { connection } = m.emparejar('waiter')
      const session = m.entrar(connection, 'waiter')
      m.avanzar(30 * 60_000)
      const closeout = m.clock()
      expect(m.access.cerrarSesion(connection, session)).toEqual({ ok: true })
      const time = add(closeout, desfase)
      const ev = m.event(connection, session, 'OrderOpened', ABRIR, {
        device_time: time,
        hub_estimated_time: time,
      })
      // Se recibe mucho después: lo que cuenta es la hora del evento.
      m.avanzar(60 * 60_000)
      const r = m.hub.recibirLote(connection, [ev])
      expect(r.resultados[0]?.status, `desfase ${desfase}`).toBe(expected)
    }
  })

  it('con la sesión abierta, un evento con hora futura se acepta pero el hub usa su propia hora', () => {
    const m = montarHub()
    const { connection } = m.emparejar('waiter')
    const session = m.entrar(connection, 'waiter')
    const futura = add(m.clock(), 3 * 60 * 60_000)
    const ev = m.event(connection, session, 'OrderOpened', ABRIR, {
      device_time: futura,
      hub_estimated_time: futura,
    })

    const r = m.hub.recibirLote(connection, [ev])
    expect(r.resultados[0]?.status).toBe('confirmed')
    const fila = m.db.prepare('SELECT received_at, business_day FROM events').get()
    expect(fila?.received_at).toBe(m.clock())
    // 20:00 UTC = 15:00 en Bogotá: el día operativo es el de hoy, no el de las 23:00 del reloj adelantado.
    expect(fila?.business_day).toBe('2026-10-24')
  })

  it('con la sesión cerrada, la hora futura no sirve para colarse después del cierre', () => {
    const m = montarHub()
    const { connection } = m.emparejar('waiter')
    const session = m.entrar(connection, 'waiter')
    m.avanzar(10 * 60_000)
    m.access.cerrarSesion(connection, session)
    const futura = add(m.clock(), 10 * 60_000)
    const ev = m.event(connection, session, 'OrderOpened', ABRIR, {
      device_time: futura,
      hub_estimated_time: futura,
    })

    expect(m.hub.recibirLote(connection, [ev]).resultados[0]).toMatchObject({
      status: 'rejected',
      reason: 'session_closed',
    })
  })

  it('una hora que no es una hora se rechaza por esquema, no se cuela por la comparación', () => {
    const m = montarHub()
    const { connection } = m.emparejar('waiter')
    const session = m.entrar(connection, 'waiter')
    for (const garbage of ['mañana', '', '2026-13-45T99:99:99Z', 'NaN', '0']) {
      const ev = m.event(connection, session, 'OrderOpened', ABRIR, {
        hub_estimated_time: garbage,
      })
      const r = m.hub.recibirLote(connection, [ev])
      expect(r.resultados[0]?.status, garbage).toBe('rejected')
    }
    expect(events(m)).toBe(0)
  })

  it('el cambio de usuario en el dispositivo: lo del primero creado antes vale, lo creado después no', () => {
    const m = montarHub()
    const { connection } = m.emparejar('waiter')
    const ana = m.entrar(connection, 'waiter')
    const before = m.event(connection, ana, 'OrderOpened', ABRIR)
    m.avanzar(10 * 60_000)
    m.entrar(connection, 'waiter2')
    m.avanzar(5 * 60_000)
    const after = m.event(connection, ana, 'OrderOpened', ABRIR)

    const r = m.hub.recibirLote(connection, [before, after])
    expect(r.resultados.map((x) => x.status)).toEqual(['confirmed', 'rejected'])
    expect(r.resultados[1]).toMatchObject({ reason: 'session_closed' })
  })

  it('recibir eventos cuenta como uso de la sesión, sin pasar de la hora del hub ni retroceder', () => {
    const m = montarHub()
    const { connection } = m.emparejar('waiter')
    const session = m.entrar(connection, 'waiter')
    const ultimo = () =>
      m.db.prepare('SELECT last_used FROM sessions WHERE id = ?').get(session.sesionId)?.last_used

    m.avanzar(10 * 60_000)
    const reciente = m.event(connection, session, 'OrderOpened', ABRIR)
    m.hub.recibirLote(connection, [reciente])
    expect(ultimo()).toBe(m.clock())

    // Un evento viejo que llega después no retrocede el último uso.
    const oldOne = add(m.clock(), -5 * 60_000)
    m.avanzar(1000)
    m.hub.recibirLote(connection, [
      m.event(connection, session, 'OrderOpened', ABRIR, {
        device_time: oldOne,
        hub_estimated_time: oldOne,
      }),
    ])
    expect(ultimo()).toBe(add(m.clock(), -1000))

    // Uno con hora futura no lo adelanta más allá del reloj del hub.
    const futura = add(m.clock(), 30_000)
    m.hub.recibirLote(connection, [
      m.event(connection, session, 'OrderOpened', ABRIR, {
        device_time: futura,
        hub_estimated_time: futura,
      }),
    ])
    expect(ultimo()).toBe(m.clock())
  })

  it('el secreto de la sesión, no su id, es lo que permite pedir un comprobante', () => {
    const m = montarHub()
    const { connection, session } = pedidoConItemEnviado(m)
    const r = m.access.autorizar(connection, {
      sesionId: session.sesionId,
      secret: 'x'.repeat(43),
      pin: m.people.manager.pin,
      action: 'void_sent_item',
      agregadoId: newId(),
      eventId: newId(),
      fingerprint: '0'.repeat(64),
    })
    expect(r).toMatchObject({ ok: false, code: 'invalid_session' })
    expect(m.db.prepare('SELECT count(*) AS n FROM authorizations').get()?.n).toBe(0)
  })
})

describe('la firma de los eventos', () => {
  function enSesion() {
    const m = montarHub()
    const { connection } = m.emparejar('waiter')
    const session = m.entrar(connection, 'waiter')
    return { m, connection, session }
  }

  it('sin firma, o con una firma que no es de esta sesión, el evento se rechaza', () => {
    const { m, connection, session } = enSesion()
    const another = m.entrar(m.emparejar('waiter', 'Otro').connection, 'waiter2')
    const ev = m.event(connection, session, 'OrderOpened', ABRIR)
    const { signature: _firma, ...sinFirma } = ev
    const casos = {
      sinFirma,
      firmaAjena: m.firmado(another, ev),
      firmaCero: { ...ev, signature: '0'.repeat(64) },
    }
    for (const [name, badCase] of Object.entries(casos)) {
      const r = m.hub.recibirLote(connection, [{ ...badCase, id: newId() }])
      expect(r.resultados[0], name).toMatchObject({
        status: 'rejected',
        reason: 'invalid_signature',
      })
    }
    expect(events(m)).toBe(0)
  })

  it('cambiar cualquier campo después de firmar invalida la firma', () => {
    const { m, connection, session } = enSesion()
    const ev = m.event(connection, session, 'OrderOpened', ABRIR)
    const changes: Record<string, object> = {
      data: { data: { ...ABRIR, guests: 9 } },
      time: { hub_estimated_time: add(m.clock(), 1000) },
      reason: { reason: 'other' },
      aggregate: { aggregate_id: newId() },
    }
    for (const [name, change] of Object.entries(changes)) {
      const r = m.hub.recibirLote(connection, [{ ...ev, id: newId(), ...change }])
      expect(r.resultados[0], name).toMatchObject({ reason: 'invalid_signature' })
    }
  })

  it('el id del evento va dentro de la firma: no se puede reusar la firma con otro id', () => {
    const { m, connection, session } = enSesion()
    const ev = m.event(connection, session, 'OrderOpened', ABRIR)
    expect(m.hub.recibirLote(connection, [{ ...ev, id: newId() }]).resultados[0]).toMatchObject({
      reason: 'invalid_signature',
    })
  })

  it('sesión y usuario se revisan antes que la firma', () => {
    const { m, connection, session } = enSesion()
    const ev = m.event(connection, session, 'OrderOpened', ABRIR)
    const other = m.event(connection, session, 'OrderOpened', ABRIR, {
      user_id: m.people.manager.userId,
    })

    expect(m.access.verify(connection, { ...ev, session_id: newId() }, null)).toMatchObject({
      reason: 'unknown_session',
      quarantine: true,
    })
    expect(m.access.verify(connection, other, null)).toMatchObject({ reason: 'user_mismatch' })
  })

  it('la secuencia_base no está firmada: el dispositivo la baja a 0 al reenviar a un hub restaurado', () => {
    const { m, connection, session } = enSesion()
    const ev = m.event(connection, session, 'OrderOpened', ABRIR, { base_sequence: 7 })
    const r = m.hub.recibirLote(connection, [{ ...ev, base_sequence: 0 }])

    expect(r.resultados[0]?.status).toBe('confirmed')
  })

  it('la firma no queda guardada con el evento', () => {
    const { m, connection, session } = enSesion()
    const ev = m.event(connection, session, 'OrderOpened', ABRIR)
    m.hub.recibirLote(connection, [ev])

    const saved = JSON.stringify(m.db.prepare('SELECT * FROM events').get())
    expect(saved).not.toContain(String(ev.signature))
  })
})

describe('el permiso depende del contenido y del estado del pedido', () => {
  const extra = (price: number) => ({
    modifier_id: newId(),
    name: 'Extra',
    extra_price: price,
  })

  function conItemConExtra() {
    const m = montarHub()
    const base = pedidoConItemEnviado(m, [extra(3000)])
    const patch = (modifiers: object[], extras: object = {}) =>
      m.event(
        base.connection,
        base.session,
        'ItemModifiedAfterSend',
        { item_id: base.itemId, ticket_id: base.comandaId, modifiers },
        { aggregate_id: base.order, base_sequence: 3, ...extras },
      )
    return { m, base, patch }
  }

  it('abaratar un ítem ya enviado es una anulación parcial: el mesero no puede, ni quitando todos los extras', () => {
    const { m, base, patch } = conItemConExtra()
    for (const modifiers of [[], [extra(1000)], [extra(2999)]]) {
      const r = m.hub.recibirLote(base.connection, [patch(modifiers, { id: newId() })])
      expect(r.resultados[0], JSON.stringify(modifiers.map((x) => x.extra_price))).toMatchObject({
        status: 'rejected',
        reason: 'no_permission',
      })
    }
  })

  it('cambiar por algo igual o más caro, o solo las notas, lo hace cualquiera con «tomar_pedido»', () => {
    const { m, base, patch } = conItemConExtra()
    const notes = m.event(
      base.connection,
      base.session,
      'ItemModifiedAfterSend',
      { item_id: base.itemId, ticket_id: base.comandaId, notes: 'sin hielo' },
      { aggregate_id: base.order, base_sequence: 3 },
    )
    const r = m.hub.recibirLote(base.connection, [
      patch([extra(3000)]),
      patch([extra(8000)], { base_sequence: 4 }),
      { ...notes, base_sequence: 5 },
    ])
    expect(r.resultados.map((x) => x.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
  })

  it('con el comprobante de «anular_item_enviado» sí se abarata, y el supervisor queda registrado', () => {
    const { m, base, patch } = conItemConExtra()
    const { event } = autorizarEvento(
      m,
      base.connection,
      base.session,
      m.people.manager.pin,
      patch([]),
    )

    expect(m.hub.recibirLote(base.connection, [event]).resultados[0]).toMatchObject({
      status: 'confirmed',
      aceptacion: { authorized_by_id: m.people.manager.userId },
    })
  })

  it('un comprobante de «tomar_pedido» no alcanza para abaratar', () => {
    const { m, base, patch } = conItemConExtra()
    // La gerente tiene los dos permisos; el comprobante se emite solo para el más débil.
    const { event } = autorizarEvento(
      m,
      base.connection,
      base.session,
      m.people.manager.pin,
      patch([]),
      'take_order',
    )

    expect(m.hub.recibirLote(base.connection, [event]).resultados[0]).toMatchObject({
      status: 'rejected',
      reason: 'invalid_authorization',
    })
  })
})

describe('revocar un dispositivo con trabajo pendiente', () => {
  /** Un celular conectado a la sala, con su sesión abierta y una caja con el administrador. */
  function conSala() {
    const m = montarHub()
    const sala = new SalaSync(m.hub, m.access.authenticate)
    const phone = m.emparejar('waiter')
    const session = m.entrar(phone.connection, 'waiter')
    const register = m.emparejar('register').connection
    const admin = m.entrar(register, 'admin')
    const recibidos: MensajeHub[] = []
    const enlace = sala.connect((x) => recibidos.push(x))
    enlace.recibir({
      type: 'hello',
      token: phone.token,
      hub_instancia: null,
      until: 0,
      version_app: 'x',
    })
    const revoke = () => {
      const r = m.access.revocarDispositivo(register, {
        ...admin,
        dispositivoId: phone.connection.dispositivoId,
      })
      if (!r.ok) throw new Error(r.message)
      sala.revoke(phone.connection.dispositivoId, r.revocadoEn)
      return r.revocadoEn
    }
    const resultados = () => recibidos.flatMap((x) => (x.type === 'result' ? x.resultados : []))
    return { m, sala, phone, session, register, admin, enlace, recibidos, revoke, resultados }
  }

  const open = (c: ReturnType<typeof conSala>, time: string) =>
    c.m.event(c.phone.connection, c.session, 'OrderOpened', ABRIR, {
      device_time: time,
      hub_estimated_time: time,
    })

  it('revocar entre dos lotes: el primero entra, el segundo no', () => {
    const c = conSala()
    c.enlace.recibir({
      type: 'push',
      lote_id: 'l1',
      events: [open(c, c.m.clock())],
    })
    c.m.avanzar(1000)
    c.revoke()
    c.m.avanzar(1000)
    c.enlace.recibir({
      type: 'push',
      lote_id: 'l2',
      events: [open(c, c.m.clock())],
    })

    expect(c.resultados().map((x) => x.status)).toEqual(['confirmed', 'rejected'])
    expect(events(c.m)).toBe(1)
  })

  it('un lote creado antes de la revocación pero recibido después va a cuarentena, no se pierde ni entra', () => {
    const c = conSala()
    const before = open(c, c.m.clock())
    c.m.avanzar(5000)
    const revocadoEn = c.revoke()
    c.enlace.recibir({ type: 'push', lote_id: 'l1', events: [before] })

    expect(c.resultados().map((x) => x.status)).toEqual(['quarantine'])
    expect(events(c.m)).toBe(0)
    expect(
      c.m.db.prepare('SELECT reason FROM quarantined_events WHERE event_id = ?').get(before.id)
        ?.reason,
    ).toBe('revoked_device')
    expect(revocadoEn).toBe(c.m.clock())
  })

  it('el borde: un evento con la hora exacta de la revocación ya no cuenta como anterior', () => {
    const c = conSala()
    c.m.avanzar(5000)
    const revocadoEn = c.revoke()
    c.enlace.recibir({
      type: 'push',
      lote_id: 'l1',
      events: [open(c, add(revocadoEn, -1)), open(c, revocadoEn), open(c, add(revocadoEn, 1))],
    })

    expect(c.resultados().map((x) => x.status)).toEqual(['quarantine', 'rejected', 'rejected'])
  })

  it('un lote mixto de un dispositivo revocado: cada evento sigue su camino y el lote no se corta', () => {
    const c = conSala()
    const a = open(c, c.m.clock())
    c.m.avanzar(5000)
    c.revoke()
    c.m.avanzar(5000)
    const b = open(c, c.m.clock())
    c.enlace.recibir({ type: 'push', lote_id: 'l1', events: [a, b, a] })

    // El tercero repite al primero: misma respuesta.
    expect(c.resultados().map((x) => x.status)).toEqual(['quarantine', 'rejected', 'quarantine'])
  })

  it('un comprobante pedido antes de la revocación no se gasta con lo que queda en cuarentena', () => {
    const c = conSala()
    const sinComprobante = c.m.event(
      c.phone.connection,
      c.session,
      'ItemVoided',
      datosAnular(newId()),
      { reason: 'x' },
    )
    const { event } = autorizarEvento(
      c.m,
      c.phone.connection,
      c.session,
      c.m.people.manager.pin,
      sinComprobante,
    )
    c.m.avanzar(10_000)
    c.revoke()
    c.enlace.recibir({ type: 'push', lote_id: 'l1', events: [event] })

    expect(c.resultados().map((x) => x.status)).toEqual(['quarantine'])
    expect(comprobante(c.m)).toMatchObject({ used_at: null })
    expect(events(c.m)).toBe(0)
  })

  it('revocar cierra las sesiones del equipo: aunque una conexión vieja no se entere, no pide comprobantes', () => {
    const c = conSala()
    const viejaConexion = c.phone.connection // sigue creyendo que no está revocado
    c.revoke()

    expect(
      c.m.access.autorizar(viejaConexion, {
        ...c.session,
        pin: c.m.people.manager.pin,
        action: 'void_sent_item',
        agregadoId: newId(),
        eventId: newId(),
        fingerprint: '0'.repeat(64),
      }),
    ).toMatchObject({ ok: false, code: 'invalid_session' })
    expect(c.m.access.cerrarSesion(viejaConexion, c.session)).toMatchObject({ ok: false })
    const alDia = c.m.access.authenticate(c.phone.token)
    expect(alDia?.revocadoEn).toBe(c.m.clock())
    expect(c.m.access.startSession(alDia as never, c.m.people.waiter.pin)).toMatchObject({
      code: 'revoked_device',
    })
  })

  it('un equipo revocado no aprueba emparejamientos aunque tenga el PIN del administrador', () => {
    const c = conSala()
    c.revoke()
    const alDia = c.m.access.authenticate(c.phone.token) as never

    expect(
      c.m.access.crearEmparejamiento(
        { pin: c.m.people.admin.pin, name: 'Intruso', type: 'register' },
        alDia,
      ),
    ).toMatchObject({ ok: false, code: 'revoked_device' })
  })

  it('revocar dos veces no cambia la fecha ni avisa dos veces', () => {
    const c = conSala()
    const first = c.revoke()
    c.m.avanzar(60_000)
    const r2 = c.m.access.revocarDispositivo(c.register, {
      ...c.admin,
      dispositivoId: c.phone.connection.dispositivoId,
    })

    expect(r2).toEqual({ ok: true, revocadoEn: first })
    expect(c.m.revocados).toEqual([c.phone.connection.dispositivoId])
  })

  it('no se puede retirar un equipo que no existe, ni con el id de otra cosa', () => {
    const c = conSala()
    for (const id of [newId(), '', c.m.restauranteId, c.m.people.waiter.userId])
      expect(
        c.m.access.revocarDispositivo(c.register, { ...c.admin, dispositivoId: id }),
        id,
      ).toMatchObject({ ok: false, code: 'invalid_data' })
    expect(c.m.revocados).toEqual([])
  })

  it('la secuencia de revocación queda en el dispositivo, con quién lo retiró', () => {
    const c = conSala()
    pedidoConItemEnviado(c.m)
    c.revoke()
    const fila = c.m.db
      .prepare(
        'SELECT revoked_at, revocation_sequence, user_id, device_id FROM devices WHERE id = ?',
      )
      .get(c.phone.connection.dispositivoId)

    expect(fila).toEqual({
      revoked_at: c.m.clock(),
      revocation_sequence: 3,
      user_id: c.m.people.admin.userId,
      device_id: c.register.dispositivoId,
    })
  })

  it('tras 500 eventos en cuarentena de un equipo revocado, los siguientes se rechazan', () => {
    const c = conSala()
    const eventosViejos = Array.from({ length: 501 }, () => open(c, c.m.clock()))
    c.m.avanzar(5000)
    c.revoke()
    for (let i = 0; i < eventosViejos.length; i += 100)
      c.enlace.recibir({
        type: 'push',
        lote_id: `l${i}`,
        events: eventosViejos.slice(i, i + 100),
      })

    const statuses = c.resultados().map((x) => x.status)
    expect(statuses.filter((e) => e === 'quarantine')).toHaveLength(500)
    expect(statuses.at(-1)).toBe('rejected')
  })
})
