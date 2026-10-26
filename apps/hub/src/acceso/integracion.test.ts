import { authorizableFingerprint, newId } from '@pos/core'
import { HubSync, type MensajeHub, SalaSync } from '@pos/sync'
import { AlmacenSqlite } from '@pos/sync/sqlite'
import { describe, expect, it } from 'vitest'
import { firmado, type MontajeAcceso, montarAcceso } from './montaje'

// Criterios de la tarea 0.7 con el hub completo (sincronización + acceso sobre la misma base):
// un dispositivo revocado es rechazado; un mesero no puede anular sin autorización, y cada
// autorización deja registro de quién la dio.

const item = () => ({
  item_id: newId(),
  product_id: newId(),
  variant_id: null,
  name: 'Aperol Spritz',
  unit_price: 32_000,
  tax_type: 'inc' as const,
  rate: 800,
  quantity: 1,
  guest: null,
  course: null,
  modifiers: [],
  notes: null,
  catalog_version: 1,
  price_channel_id: null,
})

function montarHub() {
  const m = montarAcceso()
  const hub = new HubSync(new AlmacenSqlite(m.db, m.restauranteId), {
    restauranteId: m.restauranteId,
    timeZone: 'America/Bogota',
    inicioDiaOperativo: '06:00',
    instancia: 'hub-1',
    clock: m.clock,
    access: m.access,
  })
  return { ...m, hub }
}

/** Un pedido abierto por el mesero con un ítem ya enviado a cocina. */
function pedidoConItemEnviado(m: MontajeAcceso & { hub: HubSync }) {
  const { connection } = m.emparejar('waiter')
  const s = m.entrar(connection, 'waiter')
  const order = newId()
  const it = item()
  const en = { aggregate_id: order }
  const r = m.hub.recibirLote(connection, [
    m.event(connection, s, 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 2 }, en),
    m.event(connection, s, 'ItemAdded', it, { ...en, base_sequence: 1 }),
    m.event(
      connection,
      s,
      'ItemsSent',
      { tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [it.item_id] }] },
      { ...en, base_sequence: 2 },
    ),
  ])
  expect(r.resultados.map((x) => x.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
  return { connection, session: s, order, itemId: it.item_id }
}

describe('acceso en el hub de sincronización', () => {
  it('un mesero no puede anular un ítem enviado sin autorización', () => {
    const m = montarHub()
    const { connection, session, order, itemId } = pedidoConItemEnviado(m)
    const voidItem = m.event(
      connection,
      session,
      'ItemVoided',
      { item_id: itemId, quantity: 1, already_prepared: false, ticket_id: null },
      { aggregate_id: order, reason: 'El cliente cambió de idea', base_sequence: 3 },
    )

    const r = m.hub.recibirLote(connection, [voidItem])
    expect(r.resultados[0]).toMatchObject({ status: 'rejected', reason: 'no_permission' })
    expect(m.hub.order(order)?.items[itemId]?.status).toBe('sent')
  })

  it('con el PIN de la gerente se anula, y queda quién lo autorizó', () => {
    const m = montarHub()
    const { connection, session, order, itemId } = pedidoConItemEnviado(m)
    // La app arma el evento, pide el comprobante con su huella y lo firma ya con el comprobante.
    const borrador = m.event(
      connection,
      session,
      'ItemVoided',
      { item_id: itemId, quantity: 1, already_prepared: false, ticket_id: null },
      { aggregate_id: order, reason: 'El cliente cambió de idea', base_sequence: 3 },
    )
    const eventId = borrador.id
    const a = m.access.autorizar(connection, {
      ...session,
      pin: m.people.manager.pin,
      action: 'void_sent_item',
      agregadoId: order,
      eventId,
      fingerprint: authorizableFingerprint(borrador),
    })
    if (!a.ok) throw new Error(a.message)
    const voidItem = firmado(session, { ...borrador, authorization_id: a.autorizacionId })

    const r = m.hub.recibirLote(connection, [voidItem])
    expect(r.resultados[0]).toMatchObject({
      status: 'confirmed',
      aceptacion: { authorized_by_id: m.people.manager.userId },
    })
    const saved = m.db
      .prepare('SELECT user_id, authorized_by_id FROM events WHERE id = ?')
      .get(eventId)
    expect(saved).toEqual({
      user_id: m.people.waiter.userId,
      authorized_by_id: m.people.manager.userId,
    })
    const comprobante = m.db.prepare('SELECT supervisor_id, used_at FROM authorizations').get()
    expect(comprobante).toEqual({
      supervisor_id: m.people.manager.userId,
      used_at: m.clock(),
    })

    // Reenviar el mismo evento (respuesta perdida) da la misma respuesta, no "comprobante usado".
    expect(m.hub.recibirLote(connection, [voidItem]).resultados).toEqual(r.resultados)
  })

  it('lo que el mesero hizo sin conexión cuenta como uso de su sesión', () => {
    const m = montarHub()
    const { session } = pedidoConItemEnviado(m)
    const row = m.db.prepare('SELECT last_used FROM sessions WHERE id = ?').get(session.sesionId)
    expect(row?.last_used).toBe(m.clock())
  })

  it('un dispositivo revocado es rechazado: no lee el salón y lo nuevo que envía no entra', () => {
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
    const before = m.event(phone.connection, session, 'OrderOpened', {
      channel: 'bar',
      table_id: null,
      guests: 1,
    })

    m.advance(60_000)
    const r = m.access.revocarDispositivo(register, {
      ...admin,
      dispositivoId: phone.connection.dispositivoId,
    })
    if (!r.ok) throw new Error(r.message)
    sala.revoke(phone.connection.dispositivoId, r.revocadoEn)
    m.advance(60_000)
    const after = m.event(phone.connection, session, 'OrderOpened', {
      channel: 'bar',
      table_id: null,
      guests: 1,
    })
    enlace.recibir({ type: 'push', lote_id: 'l1', events: [before, after] })
    enlace.recibir({ type: 'pull', from: 0 })

    const result = recibidos.find((x) => x.type === 'result')
    expect(result?.type === 'result' && result.resultados.map((x) => x.status)).toEqual([
      'quarantine',
      'rejected',
    ])
    expect(
      recibidos.filter((x) => x.type === 'error').map((x) => x.type === 'error' && x.code),
    ).toEqual(['revoked_token', 'revoked_token'])
    expect(m.db.prepare('SELECT count(*) AS n FROM events').get()?.n).toBe(0)

    // Al reconectar, el token sigue sirviendo solo para entregar lo pendiente: no abre sesión.
    expect(
      m.access.startSession(m.access.authenticate(phone.token) as never, m.people.waiter.pin),
    ).toMatchObject({
      code: 'revoked_device',
    })
  })

  it('un cajero cobra y cierra desde la caja; el mismo cajero en la pantalla de cocina, no', () => {
    const m = montarHub()
    const { order } = pedidoConItemEnviado(m)
    // En un celular entrar con contraseña lo vuelve de caja (ADR-013); en la de cocina, no.
    const phone = m.emparejar('kds').connection
    const s = m.entrar(phone, 'cashier')
    const closeout = m.event(phone, s, 'OrderClosed', {}, { aggregate_id: order, base_sequence: 3 })

    expect(m.hub.recibirLote(phone, [closeout]).resultados[0]).toMatchObject({
      status: 'rejected',
      reason: 'register_only',
    })
  })
})
