import { type NewEvent, newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { AlmacenMemoria } from './hub/almacen'
import { type Conexion, type ControlAcceso, HubSync, type VeredictoAcceso } from './hub/hub'
import { SalaSync } from './hub/sala'
import type { MensajeHub } from './protocolo'

// Cómo usa el hub su control de acceso (la implementación real está en apps/hub).

const AHORA = '2026-10-24T20:00:00.000Z'
const connection: Conexion = { dispositivoId: newId(), type: 'waiter', revocadoEn: null }
const user = newId()

const open = (extras = {}) => ({
  id: newId(),
  type: 'OrderOpened',
  schema_version: 1,
  aggregate_type: 'order',
  aggregate_id: newId(),
  related: [],
  data: { channel: 'bar', table_id: null, guests: 1 },
  session_id: newId(),
  user_id: user,
  device_id: connection.dispositivoId,
  authorization_id: null,
  reason: null,
  device_time: AHORA,
  hub_estimated_time: AHORA,
  base_sequence: 0,
  ...extras,
})

/** Control de acceso que responde lo que diga la prueba y anota qué se usó. */
function access(veredicto: (event: NewEvent) => VeredictoAcceso) {
  const usos: string[] = []
  const control: ControlAcceso = {
    verify: (_c, event) => veredicto(event),
    registrarUso: (event) => usos.push(event.id),
  }
  return { control, usos }
}

function hubCon(control: ControlAcceso, almacen = new AlmacenMemoria()) {
  const hub = new HubSync(almacen, {
    restauranteId: '',
    timeZone: 'America/Bogota',
    inicioDiaOperativo: '06:00',
    instancia: 'hub-1',
    clock: () => AHORA,
    access: control,
  })
  return { hub, almacen }
}

describe('hub con control de acceso', () => {
  it('sin permiso se rechaza con el motivo del control y no se usa nada', () => {
    const { control, usos } = access(() => ({ ok: false, reason: 'no_permission' }))
    const { hub, almacen } = hubCon(control)
    const r = hub.recibirLote(connection, [open()])

    expect(r.resultados[0]).toMatchObject({ status: 'rejected', reason: 'no_permission' })
    expect(almacen.events).toHaveLength(0)
    expect(usos).toEqual([])
  })

  it('una sesión desconocida va a cuarentena', () => {
    const { control } = access(() => ({
      ok: false,
      reason: 'unknown_session',
      quarantine: true,
    }))
    const { hub, almacen } = hubCon(control)
    const r = hub.recibirLote(connection, [open()])

    expect(r.resultados[0]).toMatchObject({ status: 'quarantine' })
    expect(almacen.cuarentenas[0]?.reason).toBe('unknown_session')
  })

  it('con comprobante, el supervisor queda en `autorizado_por_id` y el uso se registra al guardar', () => {
    const supervisor = newId()
    const { control, usos } = access(() => ({
      ok: true,
      authorizedById: supervisor,
      autorizacionId: newId(),
    }))
    const { hub, almacen } = hubCon(control)
    const event = open()
    const r = hub.recibirLote(connection, [event])

    expect(r.resultados[0]).toMatchObject({
      status: 'confirmed',
      aceptacion: { authorized_by_id: supervisor },
    })
    expect(almacen.events[0]?.event.authorized_by_id).toBe(supervisor)
    expect(usos).toEqual([event.id])
  })

  it('un reenvío ya confirmado no vuelve a pasar por el control', () => {
    let llamadas = 0
    const { control, usos } = access(() => {
      llamadas += 1
      return { ok: true, authorizedById: null, autorizacionId: null }
    })
    const { hub } = hubCon(control)
    const event = open()
    hub.recibirLote(connection, [event])
    hub.recibirLote(connection, [event])

    expect(llamadas).toBe(1)
    expect(usos).toHaveLength(1)
  })

  it('si el evento se rechaza por otra regla, el comprobante no se usa', () => {
    const { control, usos } = access(() => ({
      ok: true,
      authorizedById: null,
      autorizacionId: newId(),
    }))
    const { hub } = hubCon(control)
    const r = hub.recibirLote(connection, [open({ type: 'GuestsChanged', data: { guests: 3 } })])

    expect(r.resultados[0]).toMatchObject({ status: 'rejected', reason: 'order_not_found' })
    expect(usos).toEqual([])
  })
})

describe('sala: revocar en caliente', () => {
  it('avisa al dispositivo, deja de difundirle y le corta `traer`', () => {
    const { control } = access(() => ({ ok: true, authorizedById: null, autorizacionId: null }))
    const { hub } = hubCon(control)
    const other: Conexion = { dispositivoId: newId(), type: 'register', revocadoEn: null }
    const tokens = new Map([
      ['t-ana', { ...connection }],
      ['t-caja', other],
    ])
    const sala = new SalaSync(hub, (token) => tokens.get(token) ?? null)
    const aAna: MensajeHub[] = []
    const ana = sala.connect((m) => aAna.push(m))
    const register = sala.connect(() => {})
    ana.recibir({ type: 'hello', token: 't-ana', hub_instancia: null, until: 0, version_app: 'x' })
    register.recibir({
      type: 'hello',
      token: 't-caja',
      hub_instancia: null,
      until: 0,
      version_app: 'x',
    })
    aAna.length = 0

    sala.revoke(connection.dispositivoId, AHORA)
    register.recibir({
      type: 'push',
      lote_id: 'l1',
      events: [open({ device_id: other.dispositivoId })],
    })
    ana.recibir({ type: 'pull', from: 0 })

    expect(aAna.map((m) => (m.type === 'error' ? m.code : m.type))).toEqual([
      'revoked_token',
      'revoked_token',
    ])
  })
})
