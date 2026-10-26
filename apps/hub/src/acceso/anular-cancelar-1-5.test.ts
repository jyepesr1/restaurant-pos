import { huellaAutorizable, nuevoId } from '@pos/core'
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

const MOTIVO = 'Error del mesero'

function escenario(modificadores: Parameters<typeof pedidoConItemEnviado>[1] = []) {
  const m = montarHub()
  const p = pedidoConItemEnviado(m, modificadores)
  const base = () =>
    Number(m.db.prepare('SELECT coalesce(max(secuencia), 0) AS s FROM evento').get()?.s)
  const crear = (tipo: string, datos: unknown, extras: Record<string, unknown> = {}) =>
    m.evento(p.conexion, p.sesion, tipo, datos, {
      agregado_id: p.pedido,
      secuencia_base: base(),
      ...extras,
    } as never)
  const anular = (extras: Record<string, unknown> = {}) =>
    crear('ItemAnulado', datosAnular(p.itemId), { motivo: MOTIVO, ...extras })
  const cancelar = (extras: Record<string, unknown> = {}) =>
    crear('PedidoCancelado', {}, { motivo: MOTIVO, ...extras })
  const enviar = (e: unknown) => m.hub.recibirLote(p.conexion, [e]).resultados[0]
  const autorizar = (pin: string, e: Parameters<typeof autorizarEvento>[4], accion: string) =>
    autorizarEvento(m, p.conexion, p.sesion, pin, e, accion)
  return { m, ...p, crear, anular, cancelar, enviar, autorizar, base }
}

const pinDe = (m: MontajeHub, quien: 'gerente' | 'cajero' | 'admin' | 'mesero2') =>
  m.personas[quien].pin

describe('anular lo enviado (ItemAnulado)', () => {
  it('el mesero sin el permiso y sin comprobante: se rechaza (sin_permiso) y el plato sigue', () => {
    const e = escenario()
    expect(e.enviar(e.anular())).toMatchObject({ estado: 'rechazado', motivo: 'sin_permiso' })
    expect(e.m.hub.pedido(e.pedido)?.items[e.itemId]?.cantidadAnulada).toBe(0)
  })

  it.each(['gerente', 'cajero', 'admin'] as const)(
    'con el PIN de %s se acepta y queda quién lo autorizó',
    (quien) => {
      const e = escenario()
      const { evento } = e.autorizar(pinDe(e.m, quien), e.anular(), 'anular_item_enviado')
      expect(e.enviar(evento)).toMatchObject({
        estado: 'confirmado',
        aceptacion: { autorizado_por_id: e.m.personas[quien].usuarioId },
      })
      expect(e.m.hub.pedido(e.pedido)?.items[e.itemId]?.estado).toBe('anulado')
    },
  )

  it('el motivo queda guardado con el evento', () => {
    const e = escenario()
    const { evento } = e.autorizar(pinDe(e.m, 'gerente'), e.anular(), 'anular_item_enviado')
    e.enviar(evento)
    const fila = e.m.db.prepare("SELECT motivo FROM evento WHERE tipo = 'ItemAnulado'").get()
    expect(fila?.motivo).toBe(MOTIVO)
  })

  it('sin motivo ni siquiera con comprobante: el esquema lo rechaza', () => {
    const e = escenario()
    const sinMotivo = e.anular({ motivo: null })
    const { evento } = e.autorizar(pinDe(e.m, 'gerente'), sinMotivo, 'anular_item_enviado')
    expect(e.enviar(evento)).toMatchObject({ estado: 'rechazado' })
    expect(String((e.enviar(evento) as { motivo?: string }).motivo)).toContain('esquema')
  })

  it('el PIN de otro mesero (sin el permiso) no autoriza: no hay comprobante', () => {
    const e = escenario()
    const a = e.m.acceso.autorizar(e.conexion, {
      ...e.sesion,
      pin: pinDe(e.m, 'mesero2'),
      accion: 'anular_item_enviado',
      agregadoId: e.pedido,
      eventoId: nuevoId(),
      huella: 'a'.repeat(64),
    })
    expect(a.ok).toBe(false)
  })

  it('un comprobante vencido (el evento se crea más de 2 minutos después) no vale', () => {
    const e = escenario()
    const borrador = e.anular()
    const a = e.m.acceso.autorizar(e.conexion, {
      ...e.sesion,
      pin: pinDe(e.m, 'gerente'),
      accion: 'anular_item_enviado',
      agregadoId: e.pedido,
      eventoId: borrador.id,
      huella: huellaAutorizable(borrador),
    })
    if (!a.ok) throw new Error(a.mensaje)
    e.m.avanzar(VIGENCIA_AUTORIZACION_MS + 1_000)
    // El evento se rehace con la hora de ahora (la huella incluye la hora, así que también
    // cambia): se prueba con la hora tardía puesta a mano sobre el mismo contenido.
    const tarde = firmar(e.sesion, {
      ...borrador,
      autorizacion_id: a.autorizacionId,
      hora_estimada_hub: e.m.reloj(),
    })
    expect(e.enviar(tarde)).toMatchObject({ estado: 'rechazado', motivo: 'autorizacion_invalida' })
  })

  it('un comprobante que llega más de 12 horas después de emitido no vale', () => {
    const e = escenario()
    const { evento } = e.autorizar(pinDe(e.m, 'gerente'), e.anular(), 'anular_item_enviado')
    e.m.avanzar(ENTREGA_AUTORIZADO_MS + 1_000)
    expect(e.enviar(evento)).toMatchObject({ estado: 'rechazado', motivo: 'autorizacion_invalida' })
  })

  it('un comprobante de otra sesión del mismo equipo no vale', () => {
    const e = escenario()
    const borrador = e.anular()
    const { comprobante } = e.autorizar(pinDe(e.m, 'gerente'), borrador, 'anular_item_enviado')
    // El mesero cierra su sesión y abre otra: el evento viene de la sesión nueva.
    e.m.acceso.cerrarSesion(e.conexion, e.sesion)
    const nueva = e.m.entrar(e.conexion, 'mesero')
    const deNueva = firmar(nueva, {
      ...borrador,
      sesion_id: nueva.sesionId,
      autorizacion_id: comprobante.autorizacionId,
    })
    expect(e.enviar(deNueva)).toMatchObject({
      estado: 'rechazado',
      motivo: 'autorizacion_invalida',
    })
  })

  it('un comprobante para otra huella (el evento cambió después) no vale', () => {
    const e = escenario()
    const borrador = e.anular()
    const { comprobante } = e.autorizar(pinDe(e.m, 'gerente'), borrador, 'anular_item_enviado')
    const cambiado = firmar(e.sesion, {
      ...borrador,
      datos: { ...borrador.datos, ya_preparado: true },
      autorizacion_id: comprobante.autorizacionId,
    } as never)
    expect(e.enviar(cambiado)).toMatchObject({
      estado: 'rechazado',
      motivo: 'autorizacion_invalida',
    })
    // Cambiar el motivo también cambia la huella.
    const otroMotivo = firmar(e.sesion, {
      ...borrador,
      motivo: 'Demora',
      autorizacion_id: comprobante.autorizacionId,
    })
    expect(e.enviar(otroMotivo)).toMatchObject({
      estado: 'rechazado',
      motivo: 'autorizacion_invalida',
    })
  })

  it('un comprobante usado no sirve para otro evento', () => {
    const e = escenario()
    const primero = e.anular()
    const { evento, comprobante } = e.autorizar(
      pinDe(e.m, 'gerente'),
      primero,
      'anular_item_enviado',
    )
    expect(e.enviar(evento)?.estado).toBe('confirmado')
    // Otro evento distinto con el mismo comprobante.
    const segundo = firmar(e.sesion, {
      ...e.anular(),
      autorizacion_id: comprobante.autorizacionId,
    })
    expect(e.enviar(segundo)).toMatchObject({
      estado: 'rechazado',
      motivo: 'autorizacion_invalida',
    })
    // Y pedir otro comprobante para el mismo evento ya autorizado tampoco.
    const otra = e.m.acceso.autorizar(e.conexion, {
      ...e.sesion,
      pin: pinDe(e.m, 'admin'),
      accion: 'anular_item_enviado',
      agregadoId: e.pedido,
      eventoId: primero.id,
      huella: huellaAutorizable(primero),
    })
    expect(otra).toMatchObject({ ok: false, codigo: 'ya_autorizado' })
  })

  it('un comprobante de otra acción (tomar_pedido) no sirve para anular', () => {
    const e = escenario()
    const borrador = e.anular()
    const { evento } = e.autorizar(pinDe(e.m, 'gerente'), borrador, 'tomar_pedido')
    expect(e.enviar(evento)).toMatchObject({ estado: 'rechazado', motivo: 'autorizacion_invalida' })
  })

  it('quien tiene el permiso no se autoriza solo con su propio PIN', () => {
    const m = montarHub()
    const p = pedidoConItemEnviado(m)
    // El cajero entra en el celular del mesero (otra sesión en otro equipo).
    const { conexion } = m.emparejar('caja', 'Caja 2')
    const s = m.entrar(conexion, 'cajero')
    const a = m.acceso.autorizar(conexion, {
      ...s,
      pin: m.personas.cajero.pin,
      accion: 'anular_item_enviado',
      agregadoId: p.pedido,
      eventoId: nuevoId(),
      huella: 'b'.repeat(64),
    })
    expect(a).toMatchObject({ ok: false, codigo: 'autoautorizacion' })
  })

  it('el cajero anula directo, sin comprobante, desde su propio equipo', () => {
    const m = montarHub()
    const p = pedidoConItemEnviado(m)
    const { conexion } = m.emparejar('caja', 'Caja')
    const s = m.entrar(conexion, 'cajero')
    const anular = m.evento(conexion, s, 'ItemAnulado', datosAnular(p.itemId), {
      agregado_id: p.pedido,
      motivo: MOTIVO,
      secuencia_base: 3,
    })
    expect(m.hub.recibirLote(conexion, [anular]).resultados[0]).toMatchObject({
      estado: 'confirmado',
      aceptacion: { autorizado_por_id: null },
    })
  })

  it('el comprobante se gasta solo si el evento se acepta: un rechazo por reglas lo deja usable', () => {
    const e = escenario()
    // Más unidades de las que hay: el reductor lo rechaza.
    const demasiadas = e.crear(
      'ItemAnulado',
      { ...datosAnular(e.itemId), cantidad: 5 },
      { motivo: MOTIVO },
    )
    const { evento, comprobante } = e.autorizar(
      pinDe(e.m, 'gerente'),
      demasiadas,
      'anular_item_enviado',
    )
    expect(e.enviar(evento)).toMatchObject({ estado: 'rechazado', motivo: 'cantidad_invalida' })
    const fila = e.m.db
      .prepare('SELECT usada_en FROM autorizacion WHERE id = ?')
      .get(comprobante.autorizacionId)
    expect(fila?.usada_en).toBeNull()
  })
})

describe('cancelar el pedido (PedidoCancelado)', () => {
  it('el mesero sin comprobante: sin_permiso, y el pedido sigue abierto', () => {
    const e = escenario()
    expect(e.enviar(e.cancelar())).toMatchObject({ estado: 'rechazado', motivo: 'sin_permiso' })
    expect(e.m.hub.pedido(e.pedido)?.estado).toBe('abierto')
  })

  it.each(['gerente', 'admin'] as const)('con el PIN de %s se cancela', (quien) => {
    const e = escenario()
    const { evento } = e.autorizar(pinDe(e.m, quien), e.cancelar(), 'cancelar_pedido')
    expect(e.enviar(evento)).toMatchObject({
      estado: 'confirmado',
      aceptacion: { autorizado_por_id: e.m.personas[quien].usuarioId },
    })
    expect(e.m.hub.pedido(e.pedido)?.estado).toBe('cancelado')
  })

  it('el cajero no tiene cancelar_pedido: su PIN no da comprobante', () => {
    const e = escenario()
    const a = e.m.acceso.autorizar(e.conexion, {
      ...e.sesion,
      pin: pinDe(e.m, 'cajero'),
      accion: 'cancelar_pedido',
      agregadoId: e.pedido,
      eventoId: nuevoId(),
      huella: 'c'.repeat(64),
    })
    expect(a.ok).toBe(false)
  })

  it('un comprobante de anular no sirve para cancelar (otra acción)', () => {
    const e = escenario()
    const { evento } = e.autorizar(pinDe(e.m, 'gerente'), e.cancelar(), 'anular_item_enviado')
    expect(e.enviar(evento)).toMatchObject({ estado: 'rechazado', motivo: 'autorizacion_invalida' })
  })

  it('sin motivo se rechaza por el esquema aunque haya comprobante', () => {
    const e = escenario()
    const { evento } = e.autorizar(
      pinDe(e.m, 'gerente'),
      e.cancelar({ motivo: null }),
      'cancelar_pedido',
    )
    expect(e.enviar(evento)).toMatchObject({ estado: 'rechazado' })
    expect(e.m.hub.pedido(e.pedido)?.estado).toBe('abierto')
  })

  it('cancelar un pedido ya cancelado se rechaza (pedido_cerrado)', () => {
    const e = escenario()
    const { evento } = e.autorizar(pinDe(e.m, 'admin'), e.cancelar(), 'cancelar_pedido')
    e.enviar(evento)
    const otra = e.autorizar(pinDe(e.m, 'admin'), e.cancelar(), 'cancelar_pedido')
    expect(e.enviar(otra.evento)).toMatchObject({ estado: 'rechazado', motivo: 'pedido_cerrado' })
  })

  it('cancelar libera la mesa y las unidas', () => {
    const m = montarHub()
    const { conexion } = m.emparejar('mesero')
    const s = m.entrar(conexion, 'mesero')
    const [m1, m2] = [nuevoId(), nuevoId()]
    const pedido = nuevoId()
    const en = { agregado_id: pedido }
    const r = m.hub.recibirLote(conexion, [
      m.evento(conexion, s, 'PedidoAbierto', { ...ABRIR, mesa_id: m1 }, en),
      m.evento(conexion, s, 'MesasUnidas', { mesa_ids: [m2] }, { ...en, secuencia_base: 1 }),
    ])
    expect(r.resultados.map((x) => x.estado)).toEqual(['confirmado', 'confirmado'])
    expect(m.hub.tienePedidoAbierto(m2)).toBe(true)
    const cancelar = m.evento(
      conexion,
      s,
      'PedidoCancelado',
      {},
      {
        ...en,
        motivo: MOTIVO,
        secuencia_base: 2,
      },
    )
    const a = autorizarEvento(m, conexion, s, m.personas.admin.pin, cancelar, 'cancelar_pedido')
    expect(m.hub.recibirLote(conexion, [a.evento]).resultados[0]?.estado).toBe('confirmado')
    expect(m.hub.tienePedidoAbierto(m1)).toBe(false)
    expect(m.hub.tienePedidoAbierto(m2)).toBe(false)
  })
})

describe('cambiar un plato ya enviado (ItemModificadoTrasEnvio)', () => {
  const extra = { modificador_id: nuevoId(), nombre: 'Extra limón', precio_extra: 3000 }

  it('cambiar solo la nota lo hace el mesero sin comprobante', () => {
    const e = escenario([extra])
    const r = e.enviar(
      e.crear('ItemModificadoTrasEnvio', {
        item_id: e.itemId,
        comanda_id: e.comandaId,
        notas: 'sin hielo',
      }),
    )
    expect(r?.estado).toBe('confirmado')
    expect(e.m.hub.pedido(e.pedido)?.items[e.itemId]?.notas).toBe('sin hielo')
  })

  it('quitar el extra (abaratar) sin comprobante se rechaza; con el PIN del cajero se acepta', () => {
    const e = escenario([extra])
    const cambio = e.crear('ItemModificadoTrasEnvio', {
      item_id: e.itemId,
      comanda_id: e.comandaId,
      modificadores: [],
    })
    expect(e.enviar(cambio)).toMatchObject({ estado: 'rechazado', motivo: 'sin_permiso' })
    const { evento } = e.autorizar(pinDe(e.m, 'cajero'), cambio, 'anular_item_enviado')
    expect(e.enviar(evento)?.estado).toBe('confirmado')
    expect(e.m.hub.pedido(e.pedido)?.items[e.itemId]?.modificadores).toEqual([])
  })

  it('cambiar a un extra más caro lo hace el mesero solo', () => {
    const e = escenario([extra])
    const r = e.enviar(
      e.crear('ItemModificadoTrasEnvio', {
        item_id: e.itemId,
        comanda_id: e.comandaId,
        modificadores: [{ ...extra, precio_extra: 5000 }],
      }),
    )
    expect(r?.estado).toBe('confirmado')
  })
})

describe('mover, cambiar y unir mesas lo hace cualquier mesero', () => {
  it('PedidoMovidoDeMesa, MesasUnidas y MesasSeparadas sin comprobante', () => {
    const m = montarHub()
    const { conexion } = m.emparejar('mesero')
    const s = m.entrar(conexion, 'mesero')
    const [m1, m2, m3] = [nuevoId(), nuevoId(), nuevoId()]
    const pedido = nuevoId()
    const en = { agregado_id: pedido }
    const r = m.hub.recibirLote(conexion, [
      m.evento(conexion, s, 'PedidoAbierto', { ...ABRIR, mesa_id: m1 }, en),
      m.evento(conexion, s, 'MesasUnidas', { mesa_ids: [m2] }, { ...en, secuencia_base: 1 }),
      m.evento(conexion, s, 'MesasSeparadas', { mesa_ids: [m2] }, { ...en, secuencia_base: 2 }),
      m.evento(
        conexion,
        s,
        'PedidoMovidoDeMesa',
        { mesa_destino_id: m3 },
        { ...en, secuencia_base: 3 },
      ),
    ])
    expect(r.resultados.map((x) => x.estado)).toEqual([
      'confirmado',
      'confirmado',
      'confirmado',
      'confirmado',
    ])
    expect(m.hub.pedido(pedido)).toMatchObject({ mesaId: m3, mesasUnidas: [] })
  })

  it('ItemsMovidos de un plato enviado a una mesa libre (lote con la apertura), sin comprobante', () => {
    const m = montarHub()
    const p = pedidoConItemEnviado(m)
    const original = m.hub.pedido(p.pedido)?.items[p.itemId]
    if (!original) throw new Error('sin ítem')
    const destino = nuevoId()
    const { catalogo_version: _v, precio_canal_id: _c, ...copia } = item()
    const movido = {
      item: {
        ...copia,
        item_id: original.id,
        producto_id: original.productoId,
        nombre: original.nombre,
        precio_unitario: original.precioUnitario,
        tarifa: original.tarifa,
      },
      estado: 'enviado',
      cantidad_anulada: 0,
      agregado_por: m.personas.mesero.usuarioId,
    }
    const r = m.hub.recibirLote(p.conexion, [
      m.evento(
        p.conexion,
        p.sesion,
        'PedidoAbierto',
        { ...ABRIR, mesa_id: nuevoId() },
        { agregado_id: destino, secuencia_base: 3 },
      ),
      m.evento(
        p.conexion,
        p.sesion,
        'ItemsMovidos',
        { pedido_destino_id: destino, items: [movido] },
        { agregado_id: p.pedido, relacionados: [destino], secuencia_base: 3 },
      ),
    ])
    expect(r.resultados.map((x) => x.estado)).toEqual(['confirmado', 'confirmado'])
    expect(m.hub.pedido(destino)?.items[p.itemId]?.estado).toBe('enviado')
  })
})
