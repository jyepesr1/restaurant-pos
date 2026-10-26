import { authorizableFingerprint, newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import {
  ABRIR,
  autorizarEvento,
  datosAnular,
  firmar,
  item,
  type MontajeHub,
  montarHub,
  pedidoConItemEnviado,
} from './montaje-hub'
import { ENTREGA_AUTORIZADO_MS, VIGENCIA_AUTORIZACION_MS } from './servicio'

// Tarea 1.5 con el hub completo (sincronización + acceso sobre la misma base): anular lo enviado,
// cancelar el pedido y abaratar un plato enviado piden el permiso o el comprobante de un
// supervisor (ADR-008); mover, cambiarse y unir mesas lo hace cualquier mesero.

const REASON = 'Error del mesero'

function scenario(modifiers: Parameters<typeof pedidoConItemEnviado>[1] = []) {
  const m = montarHub()
  const p = pedidoConItemEnviado(m, modifiers)
  const base = () =>
    Number(m.db.prepare('SELECT coalesce(max(sequence), 0) AS s FROM events').get()?.s)
  const crear = (type: string, data: unknown, extras: Record<string, unknown> = {}) =>
    m.event(p.connection, p.session, type, data, {
      aggregate_id: p.order,
      base_sequence: base(),
      ...extras,
    } as never)
  const voidItem = (extras: Record<string, unknown> = {}) =>
    crear('ItemVoided', datosAnular(p.itemId), { reason: REASON, ...extras })
  const cancel = (extras: Record<string, unknown> = {}) =>
    crear('OrderCanceled', {}, { reason: REASON, ...extras })
  const send = (e: unknown) => m.hub.recibirLote(p.connection, [e]).resultados[0]
  const autorizar = (pin: string, e: Parameters<typeof autorizarEvento>[4], action: string) =>
    autorizarEvento(m, p.connection, p.session, pin, e, action)
  return { m, ...p, crear, voidItem, cancel, send, autorizar, base }
}

const pinDe = (m: MontajeHub, quien: 'manager' | 'cashier' | 'admin' | 'waiter2') =>
  m.people[quien].pin

describe('anular lo enviado (ItemAnulado)', () => {
  it('el mesero sin el permiso y sin comprobante: se rechaza (sin_permiso) y el plato sigue', () => {
    const e = scenario()
    expect(e.send(e.voidItem())).toMatchObject({ status: 'rejected', reason: 'no_permission' })
    expect(e.m.hub.order(e.order)?.items[e.itemId]?.voidedQuantity).toBe(0)
  })

  it.each(['manager', 'cashier', 'admin'] as const)(
    'con el PIN de %s se acepta y queda quién lo autorizó',
    (quien) => {
      const e = scenario()
      const { event } = e.autorizar(pinDe(e.m, quien), e.voidItem(), 'void_sent_item')
      expect(e.send(event)).toMatchObject({
        status: 'confirmed',
        aceptacion: { authorized_by_id: e.m.people[quien].userId },
      })
      expect(e.m.hub.order(e.order)?.items[e.itemId]?.status).toBe('voided')
    },
  )

  it('el motivo queda guardado con el evento', () => {
    const e = scenario()
    const { event } = e.autorizar(pinDe(e.m, 'manager'), e.voidItem(), 'void_sent_item')
    e.send(event)
    const fila = e.m.db.prepare("SELECT reason FROM events WHERE type = 'ItemVoided'").get()
    expect(fila?.reason).toBe(REASON)
  })

  it('sin motivo ni siquiera con comprobante: el esquema lo rechaza', () => {
    const e = scenario()
    const sinMotivo = e.voidItem({ reason: null })
    const { event } = e.autorizar(pinDe(e.m, 'manager'), sinMotivo, 'void_sent_item')
    expect(e.send(event)).toMatchObject({ status: 'rejected' })
    expect(String((e.send(event) as { reason?: string }).reason)).toContain('esquema')
  })

  it('el PIN de otro mesero (sin el permiso) no autoriza: no hay comprobante', () => {
    const e = scenario()
    const a = e.m.access.autorizar(e.connection, {
      ...e.session,
      pin: pinDe(e.m, 'waiter2'),
      action: 'void_sent_item',
      agregadoId: e.order,
      eventId: newId(),
      fingerprint: 'a'.repeat(64),
    })
    expect(a.ok).toBe(false)
  })

  it('un comprobante vencido (el evento se crea más de 2 minutos después) no vale', () => {
    const e = scenario()
    const borrador = e.voidItem()
    const a = e.m.access.autorizar(e.connection, {
      ...e.session,
      pin: pinDe(e.m, 'manager'),
      action: 'void_sent_item',
      agregadoId: e.order,
      eventId: borrador.id,
      fingerprint: authorizableFingerprint(borrador),
    })
    if (!a.ok) throw new Error(a.message)
    e.m.avanzar(VIGENCIA_AUTORIZACION_MS + 1_000)
    // El evento se rehace con la hora de ahora (la huella incluye la hora, así que también
    // cambia): se prueba con la hora tardía puesta a mano sobre el mismo contenido.
    const tarde = firmar(e.session, {
      ...borrador,
      authorization_id: a.autorizacionId,
      hub_estimated_time: e.m.clock(),
    })
    expect(e.send(tarde)).toMatchObject({ status: 'rejected', reason: 'invalid_authorization' })
  })

  it('un comprobante que llega más de 12 horas después de emitido no vale', () => {
    const e = scenario()
    const { event } = e.autorizar(pinDe(e.m, 'manager'), e.voidItem(), 'void_sent_item')
    e.m.avanzar(ENTREGA_AUTORIZADO_MS + 1_000)
    expect(e.send(event)).toMatchObject({ status: 'rejected', reason: 'invalid_authorization' })
  })

  it('un comprobante de otra sesión del mismo equipo no vale', () => {
    const e = scenario()
    const borrador = e.voidItem()
    const { comprobante } = e.autorizar(pinDe(e.m, 'manager'), borrador, 'void_sent_item')
    // El mesero cierra su sesión y abre otra: el evento viene de la sesión nueva.
    e.m.access.cerrarSesion(e.connection, e.session)
    const newOne = e.m.entrar(e.connection, 'waiter')
    const deNueva = firmar(newOne, {
      ...borrador,
      session_id: newOne.sesionId,
      authorization_id: comprobante.autorizacionId,
    })
    expect(e.send(deNueva)).toMatchObject({
      status: 'rejected',
      reason: 'invalid_authorization',
    })
  })

  it('un comprobante para otra huella (el evento cambió después) no vale', () => {
    const e = scenario()
    const borrador = e.voidItem()
    const { comprobante } = e.autorizar(pinDe(e.m, 'manager'), borrador, 'void_sent_item')
    const changed = firmar(e.session, {
      ...borrador,
      data: { ...borrador.data, already_prepared: true },
      authorization_id: comprobante.autorizacionId,
    } as never)
    expect(e.send(changed)).toMatchObject({
      status: 'rejected',
      reason: 'invalid_authorization',
    })
    // Cambiar el motivo también cambia la huella.
    const otroMotivo = firmar(e.session, {
      ...borrador,
      reason: 'Demora',
      authorization_id: comprobante.autorizacionId,
    })
    expect(e.send(otroMotivo)).toMatchObject({
      status: 'rejected',
      reason: 'invalid_authorization',
    })
  })

  it('un comprobante usado no sirve para otro evento', () => {
    const e = scenario()
    const firstOne = e.voidItem()
    const { event, comprobante } = e.autorizar(pinDe(e.m, 'manager'), firstOne, 'void_sent_item')
    expect(e.send(event)?.status).toBe('confirmed')
    // Otro evento distinto con el mismo comprobante.
    const secondOne = firmar(e.session, {
      ...e.voidItem(),
      authorization_id: comprobante.autorizacionId,
    })
    expect(e.send(secondOne)).toMatchObject({
      status: 'rejected',
      reason: 'invalid_authorization',
    })
    // Y pedir otro comprobante para el mismo evento ya autorizado tampoco.
    const another = e.m.access.autorizar(e.connection, {
      ...e.session,
      pin: pinDe(e.m, 'admin'),
      action: 'void_sent_item',
      agregadoId: e.order,
      eventId: firstOne.id,
      fingerprint: authorizableFingerprint(firstOne),
    })
    expect(another).toMatchObject({ ok: false, code: 'already_authorized' })
  })

  it('un comprobante de otra acción (tomar_pedido) no sirve para anular', () => {
    const e = scenario()
    const borrador = e.voidItem()
    const { event } = e.autorizar(pinDe(e.m, 'manager'), borrador, 'take_order')
    expect(e.send(event)).toMatchObject({ status: 'rejected', reason: 'invalid_authorization' })
  })

  it('quien tiene el permiso no se autoriza solo con su propio PIN', () => {
    const m = montarHub()
    const p = pedidoConItemEnviado(m)
    // El cajero entra en el celular del mesero (otra sesión en otro equipo).
    const { connection } = m.emparejar('register', 'Caja 2')
    const s = m.entrar(connection, 'cashier')
    const a = m.access.autorizar(connection, {
      ...s,
      pin: m.people.cashier.pin,
      action: 'void_sent_item',
      agregadoId: p.order,
      eventId: newId(),
      fingerprint: 'b'.repeat(64),
    })
    expect(a).toMatchObject({ ok: false, code: 'self_authorization' })
  })

  it('el cajero anula directo, sin comprobante, desde su propio equipo', () => {
    const m = montarHub()
    const p = pedidoConItemEnviado(m)
    const { connection } = m.emparejar('register', 'Caja')
    const s = m.entrar(connection, 'cashier')
    const voidItem = m.event(connection, s, 'ItemVoided', datosAnular(p.itemId), {
      aggregate_id: p.order,
      reason: REASON,
      base_sequence: 3,
    })
    expect(m.hub.recibirLote(connection, [voidItem]).resultados[0]).toMatchObject({
      status: 'confirmed',
      aceptacion: { authorized_by_id: null },
    })
  })

  it('el comprobante se gasta solo si el evento se acepta: un rechazo por reglas lo deja usable', () => {
    const e = scenario()
    // Más unidades de las que hay: el reductor lo rechaza.
    const demasiadas = e.crear(
      'ItemVoided',
      { ...datosAnular(e.itemId), quantity: 5 },
      { reason: REASON },
    )
    const { event, comprobante } = e.autorizar(pinDe(e.m, 'manager'), demasiadas, 'void_sent_item')
    expect(e.send(event)).toMatchObject({ status: 'rejected', reason: 'invalid_quantity' })
    const fila = e.m.db
      .prepare('SELECT used_at FROM authorizations WHERE id = ?')
      .get(comprobante.autorizacionId)
    expect(fila?.used_at).toBeNull()
  })
})

describe('cancelar el pedido (PedidoCancelado)', () => {
  it('el mesero sin comprobante: sin_permiso, y el pedido sigue abierto', () => {
    const e = scenario()
    expect(e.send(e.cancel())).toMatchObject({ status: 'rejected', reason: 'no_permission' })
    expect(e.m.hub.order(e.order)?.status).toBe('open')
  })

  it.each(['manager', 'admin'] as const)('con el PIN de %s se cancela', (quien) => {
    const e = scenario()
    const { event } = e.autorizar(pinDe(e.m, quien), e.cancel(), 'cancel_order')
    expect(e.send(event)).toMatchObject({
      status: 'confirmed',
      aceptacion: { authorized_by_id: e.m.people[quien].userId },
    })
    expect(e.m.hub.order(e.order)?.status).toBe('canceled')
  })

  it('el cajero no tiene cancelar_pedido: su PIN no da comprobante', () => {
    const e = scenario()
    const a = e.m.access.autorizar(e.connection, {
      ...e.session,
      pin: pinDe(e.m, 'cashier'),
      action: 'cancel_order',
      agregadoId: e.order,
      eventId: newId(),
      fingerprint: 'c'.repeat(64),
    })
    expect(a.ok).toBe(false)
  })

  it('un comprobante de anular no sirve para cancelar (otra acción)', () => {
    const e = scenario()
    const { event } = e.autorizar(pinDe(e.m, 'manager'), e.cancel(), 'void_sent_item')
    expect(e.send(event)).toMatchObject({ status: 'rejected', reason: 'invalid_authorization' })
  })

  it('sin motivo se rechaza por el esquema aunque haya comprobante', () => {
    const e = scenario()
    const { event } = e.autorizar(pinDe(e.m, 'manager'), e.cancel({ reason: null }), 'cancel_order')
    expect(e.send(event)).toMatchObject({ status: 'rejected' })
    expect(e.m.hub.order(e.order)?.status).toBe('open')
  })

  it('cancelar un pedido ya cancelado se rechaza (pedido_cerrado)', () => {
    const e = scenario()
    const { event } = e.autorizar(pinDe(e.m, 'admin'), e.cancel(), 'cancel_order')
    e.send(event)
    const another = e.autorizar(pinDe(e.m, 'admin'), e.cancel(), 'cancel_order')
    expect(e.send(another.event)).toMatchObject({ status: 'rejected', reason: 'order_closed' })
  })

  it('cancelar libera la mesa y las unidas', () => {
    const m = montarHub()
    const { connection } = m.emparejar('waiter')
    const s = m.entrar(connection, 'waiter')
    const [m1, m2] = [newId(), newId()]
    const order = newId()
    const en = { aggregate_id: order }
    const r = m.hub.recibirLote(connection, [
      m.event(connection, s, 'OrderOpened', { ...ABRIR, table_id: m1 }, en),
      m.event(connection, s, 'TablesMerged', { table_ids: [m2] }, { ...en, base_sequence: 1 }),
    ])
    expect(r.resultados.map((x) => x.status)).toEqual(['confirmed', 'confirmed'])
    expect(m.hub.tienePedidoAbierto(m2)).toBe(true)
    const cancel = m.event(
      connection,
      s,
      'OrderCanceled',
      {},
      {
        ...en,
        reason: REASON,
        base_sequence: 2,
      },
    )
    const a = autorizarEvento(m, connection, s, m.people.admin.pin, cancel, 'cancel_order')
    expect(m.hub.recibirLote(connection, [a.event]).resultados[0]?.status).toBe('confirmed')
    expect(m.hub.tienePedidoAbierto(m1)).toBe(false)
    expect(m.hub.tienePedidoAbierto(m2)).toBe(false)
  })
})

describe('cambiar un plato ya enviado (ItemModificadoTrasEnvio)', () => {
  const extra = { modifier_id: newId(), name: 'Extra limón', extra_price: 3000 }

  it('cambiar solo la nota lo hace el mesero sin comprobante', () => {
    const e = scenario([extra])
    const r = e.send(
      e.crear('ItemModifiedAfterSend', {
        item_id: e.itemId,
        ticket_id: e.comandaId,
        notes: 'sin hielo',
      }),
    )
    expect(r?.status).toBe('confirmed')
    expect(e.m.hub.order(e.order)?.items[e.itemId]?.notes).toBe('sin hielo')
  })

  it('quitar el extra (abaratar) sin comprobante se rechaza; con el PIN del cajero se acepta', () => {
    const e = scenario([extra])
    const change = e.crear('ItemModifiedAfterSend', {
      item_id: e.itemId,
      ticket_id: e.comandaId,
      modifiers: [],
    })
    expect(e.send(change)).toMatchObject({ status: 'rejected', reason: 'no_permission' })
    const { event } = e.autorizar(pinDe(e.m, 'cashier'), change, 'void_sent_item')
    expect(e.send(event)?.status).toBe('confirmed')
    expect(e.m.hub.order(e.order)?.items[e.itemId]?.modifiers).toEqual([])
  })

  it('cambiar a un extra más caro lo hace el mesero solo', () => {
    const e = scenario([extra])
    const r = e.send(
      e.crear('ItemModifiedAfterSend', {
        item_id: e.itemId,
        ticket_id: e.comandaId,
        modifiers: [{ ...extra, extra_price: 5000 }],
      }),
    )
    expect(r?.status).toBe('confirmed')
  })
})

describe('mover, cambiar y unir mesas lo hace cualquier mesero', () => {
  it('PedidoMovidoDeMesa, MesasUnidas y MesasSeparadas sin comprobante', () => {
    const m = montarHub()
    const { connection } = m.emparejar('waiter')
    const s = m.entrar(connection, 'waiter')
    const [m1, m2, m3] = [newId(), newId(), newId()]
    const order = newId()
    const en = { aggregate_id: order }
    const r = m.hub.recibirLote(connection, [
      m.event(connection, s, 'OrderOpened', { ...ABRIR, table_id: m1 }, en),
      m.event(connection, s, 'TablesMerged', { table_ids: [m2] }, { ...en, base_sequence: 1 }),
      m.event(connection, s, 'TablesSeparated', { table_ids: [m2] }, { ...en, base_sequence: 2 }),
      m.event(
        connection,
        s,
        'OrderMovedTable',
        { target_table_id: m3 },
        { ...en, base_sequence: 3 },
      ),
    ])
    expect(r.resultados.map((x) => x.status)).toEqual([
      'confirmed',
      'confirmed',
      'confirmed',
      'confirmed',
    ])
    expect(m.hub.order(order)).toMatchObject({ tableId: m3, mergedTables: [] })
  })

  it('ItemsMovidos de un plato enviado a una mesa libre (lote con la apertura), sin comprobante', () => {
    const m = montarHub()
    const p = pedidoConItemEnviado(m)
    const original = m.hub.order(p.order)?.items[p.itemId]
    if (!original) throw new Error('sin ítem')
    const target = newId()
    const { catalog_version: _v, price_channel_id: _c, ...copy } = item()
    const moved = {
      item: {
        ...copy,
        item_id: original.id,
        product_id: original.productId,
        name: original.name,
        unit_price: original.unitPrice,
        rate: original.rate,
      },
      status: 'sent',
      voided_quantity: 0,
      added_by: m.people.waiter.userId,
    }
    const r = m.hub.recibirLote(p.connection, [
      m.event(
        p.connection,
        p.session,
        'OrderOpened',
        { ...ABRIR, table_id: newId() },
        { aggregate_id: target, base_sequence: 3 },
      ),
      m.event(
        p.connection,
        p.session,
        'ItemsMoved',
        { target_order_id: target, items: [moved] },
        { aggregate_id: p.order, related: [target], base_sequence: 3 },
      ),
    ])
    expect(r.resultados.map((x) => x.status)).toEqual(['confirmed', 'confirmed'])
    expect(m.hub.order(target)?.items[p.itemId]?.status).toBe('sent')
  })
})
