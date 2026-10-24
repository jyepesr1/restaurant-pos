import { type EventoNuevo, nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { AlmacenMemoria } from './hub/almacen'
import { type Conexion, type ControlAcceso, HubSync, type VeredictoAcceso } from './hub/hub'
import { SalaSync } from './hub/sala'
import type { MensajeHub } from './protocolo'

// Cómo usa el hub su control de acceso (la implementación real está en apps/hub).

const AHORA = '2026-10-24T20:00:00.000Z'
const conexion: Conexion = { dispositivoId: nuevoId(), tipo: 'mesero', revocadoEn: null }
const usuario = nuevoId()

const abrir = (extras = {}) => ({
  id: nuevoId(),
  tipo: 'PedidoAbierto',
  version_esquema: 1,
  agregado_tipo: 'pedido',
  agregado_id: nuevoId(),
  relacionados: [],
  datos: { canal: 'barra', mesa_id: null, comensales: 1 },
  sesion_id: nuevoId(),
  usuario_id: usuario,
  dispositivo_id: conexion.dispositivoId,
  autorizacion_id: null,
  motivo: null,
  hora_dispositivo: AHORA,
  hora_estimada_hub: AHORA,
  secuencia_base: 0,
  ...extras,
})

/** Control de acceso que responde lo que diga la prueba y anota qué se usó. */
function acceso(veredicto: (evento: EventoNuevo) => VeredictoAcceso) {
  const usos: string[] = []
  const control: ControlAcceso = {
    verificar: (_c, evento) => veredicto(evento),
    registrarUso: (evento) => usos.push(evento.id),
  }
  return { control, usos }
}

function hubCon(control: ControlAcceso, almacen = new AlmacenMemoria()) {
  const hub = new HubSync(almacen, {
    restauranteId: '',
    zonaHoraria: 'America/Bogota',
    inicioDiaOperativo: '06:00',
    instancia: 'hub-1',
    reloj: () => AHORA,
    acceso: control,
  })
  return { hub, almacen }
}

describe('hub con control de acceso', () => {
  it('sin permiso se rechaza con el motivo del control y no se usa nada', () => {
    const { control, usos } = acceso(() => ({ ok: false, motivo: 'sin_permiso' }))
    const { hub, almacen } = hubCon(control)
    const r = hub.recibirLote(conexion, [abrir()])

    expect(r.resultados[0]).toMatchObject({ estado: 'rechazado', motivo: 'sin_permiso' })
    expect(almacen.eventos).toHaveLength(0)
    expect(usos).toEqual([])
  })

  it('una sesión desconocida va a cuarentena', () => {
    const { control } = acceso(() => ({
      ok: false,
      motivo: 'sesion_desconocida',
      cuarentena: true,
    }))
    const { hub, almacen } = hubCon(control)
    const r = hub.recibirLote(conexion, [abrir()])

    expect(r.resultados[0]).toMatchObject({ estado: 'cuarentena' })
    expect(almacen.cuarentenas[0]?.motivo).toBe('sesion_desconocida')
  })

  it('con comprobante, el supervisor queda en `autorizado_por_id` y el uso se registra al guardar', () => {
    const supervisor = nuevoId()
    const { control, usos } = acceso(() => ({
      ok: true,
      autorizadoPorId: supervisor,
      autorizacionId: nuevoId(),
    }))
    const { hub, almacen } = hubCon(control)
    const evento = abrir()
    const r = hub.recibirLote(conexion, [evento])

    expect(r.resultados[0]).toMatchObject({
      estado: 'confirmado',
      aceptacion: { autorizado_por_id: supervisor },
    })
    expect(almacen.eventos[0]?.evento.autorizado_por_id).toBe(supervisor)
    expect(usos).toEqual([evento.id])
  })

  it('un reenvío ya confirmado no vuelve a pasar por el control', () => {
    let llamadas = 0
    const { control, usos } = acceso(() => {
      llamadas += 1
      return { ok: true, autorizadoPorId: null, autorizacionId: null }
    })
    const { hub } = hubCon(control)
    const evento = abrir()
    hub.recibirLote(conexion, [evento])
    hub.recibirLote(conexion, [evento])

    expect(llamadas).toBe(1)
    expect(usos).toHaveLength(1)
  })

  it('si el evento se rechaza por otra regla, el comprobante no se usa', () => {
    const { control, usos } = acceso(() => ({
      ok: true,
      autorizadoPorId: null,
      autorizacionId: nuevoId(),
    }))
    const { hub } = hubCon(control)
    const r = hub.recibirLote(conexion, [
      abrir({ tipo: 'ComensalesCambiados', datos: { comensales: 3 } }),
    ])

    expect(r.resultados[0]).toMatchObject({ estado: 'rechazado', motivo: 'pedido_inexistente' })
    expect(usos).toEqual([])
  })
})

describe('sala: revocar en caliente', () => {
  it('avisa al dispositivo, deja de difundirle y le corta `traer`', () => {
    const { control } = acceso(() => ({ ok: true, autorizadoPorId: null, autorizacionId: null }))
    const { hub } = hubCon(control)
    const otro: Conexion = { dispositivoId: nuevoId(), tipo: 'caja', revocadoEn: null }
    const tokens = new Map([
      ['t-ana', { ...conexion }],
      ['t-caja', otro],
    ])
    const sala = new SalaSync(hub, (token) => tokens.get(token) ?? null)
    const aAna: MensajeHub[] = []
    const ana = sala.conectar((m) => aAna.push(m))
    const caja = sala.conectar(() => {})
    ana.recibir({ tipo: 'hola', token: 't-ana', hub_instancia: null, hasta: 0, version_app: 'x' })
    caja.recibir({ tipo: 'hola', token: 't-caja', hub_instancia: null, hasta: 0, version_app: 'x' })
    aAna.length = 0

    sala.revocar(conexion.dispositivoId, AHORA)
    caja.recibir({
      tipo: 'empujar',
      lote_id: 'l1',
      eventos: [abrir({ dispositivo_id: otro.dispositivoId })],
    })
    ana.recibir({ tipo: 'traer', desde: 0 })

    expect(aAna.map((m) => (m.tipo === 'error' ? m.codigo : m.tipo))).toEqual([
      'token_revocado',
      'token_revocado',
    ])
  })
})
