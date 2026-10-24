import { huellaAutorizable, nuevoId } from '@pos/core'
import { HubSync, type MensajeHub, SalaSync } from '@pos/sync'
import { AlmacenSqlite } from '@pos/sync/sqlite'
import { describe, expect, it } from 'vitest'
import { firmado, type MontajeAcceso, montarAcceso } from './montaje'

// Criterios de la tarea 0.7 con el hub completo (sincronización + acceso sobre la misma base):
// un dispositivo revocado es rechazado; un mesero no puede anular sin autorización, y cada
// autorización deja registro de quién la dio.

const item = () => ({
  item_id: nuevoId(),
  producto_id: nuevoId(),
  variante_id: null,
  nombre: 'Aperol Spritz',
  precio_unitario: 32_000,
  impuesto_tipo: 'inc' as const,
  tarifa: 800,
  cantidad: 1,
  comensal: null,
  curso: null,
  modificadores: [],
  notas: null,
  catalogo_version: 1,
  precio_canal_id: null,
})

function montarHub() {
  const m = montarAcceso()
  const hub = new HubSync(new AlmacenSqlite(m.db, m.restauranteId), {
    restauranteId: m.restauranteId,
    zonaHoraria: 'America/Bogota',
    inicioDiaOperativo: '06:00',
    instancia: 'hub-1',
    reloj: m.reloj,
    acceso: m.acceso,
  })
  return { ...m, hub }
}

/** Un pedido abierto por el mesero con un ítem ya enviado a cocina. */
function pedidoConItemEnviado(m: MontajeAcceso & { hub: HubSync }) {
  const { conexion } = m.emparejar('mesero')
  const s = m.entrar(conexion, 'mesero')
  const pedido = nuevoId()
  const it = item()
  const en = { agregado_id: pedido }
  const r = m.hub.recibirLote(conexion, [
    m.evento(conexion, s, 'PedidoAbierto', { canal: 'salon', mesa_id: null, comensales: 2 }, en),
    m.evento(conexion, s, 'ItemAgregado', it, { ...en, secuencia_base: 1 }),
    m.evento(
      conexion,
      s,
      'ItemsEnviados',
      { comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [it.item_id] }] },
      { ...en, secuencia_base: 2 },
    ),
  ])
  expect(r.resultados.map((x) => x.estado)).toEqual(['confirmado', 'confirmado', 'confirmado'])
  return { conexion, sesion: s, pedido, itemId: it.item_id }
}

describe('acceso en el hub de sincronización', () => {
  it('un mesero no puede anular un ítem enviado sin autorización', () => {
    const m = montarHub()
    const { conexion, sesion, pedido, itemId } = pedidoConItemEnviado(m)
    const anular = m.evento(
      conexion,
      sesion,
      'ItemAnulado',
      { item_id: itemId, cantidad: 1, ya_preparado: false, comanda_id: null },
      { agregado_id: pedido, motivo: 'El cliente cambió de idea', secuencia_base: 3 },
    )

    const r = m.hub.recibirLote(conexion, [anular])
    expect(r.resultados[0]).toMatchObject({ estado: 'rechazado', motivo: 'sin_permiso' })
    expect(m.hub.pedido(pedido)?.items[itemId]?.estado).toBe('enviado')
  })

  it('con el PIN de la gerente se anula, y queda quién lo autorizó', () => {
    const m = montarHub()
    const { conexion, sesion, pedido, itemId } = pedidoConItemEnviado(m)
    // La app arma el evento, pide el comprobante con su huella y lo firma ya con el comprobante.
    const borrador = m.evento(
      conexion,
      sesion,
      'ItemAnulado',
      { item_id: itemId, cantidad: 1, ya_preparado: false, comanda_id: null },
      { agregado_id: pedido, motivo: 'El cliente cambió de idea', secuencia_base: 3 },
    )
    const eventoId = borrador.id
    const a = m.acceso.autorizar(conexion, {
      ...sesion,
      pin: m.personas.gerente.pin,
      accion: 'anular_item_enviado',
      agregadoId: pedido,
      eventoId,
      huella: huellaAutorizable(borrador),
    })
    if (!a.ok) throw new Error(a.mensaje)
    const anular = firmado(sesion, { ...borrador, autorizacion_id: a.autorizacionId })

    const r = m.hub.recibirLote(conexion, [anular])
    expect(r.resultados[0]).toMatchObject({
      estado: 'confirmado',
      aceptacion: { autorizado_por_id: m.personas.gerente.usuarioId },
    })
    const guardado = m.db
      .prepare('SELECT usuario_id, autorizado_por_id FROM evento WHERE id = ?')
      .get(eventoId)
    expect(guardado).toEqual({
      usuario_id: m.personas.mesero.usuarioId,
      autorizado_por_id: m.personas.gerente.usuarioId,
    })
    const comprobante = m.db.prepare('SELECT supervisor_id, usada_en FROM autorizacion').get()
    expect(comprobante).toEqual({
      supervisor_id: m.personas.gerente.usuarioId,
      usada_en: m.reloj(),
    })

    // Reenviar el mismo evento (respuesta perdida) da la misma respuesta, no "comprobante usado".
    expect(m.hub.recibirLote(conexion, [anular]).resultados).toEqual(r.resultados)
  })

  it('lo que el mesero hizo sin conexión cuenta como uso de su sesión', () => {
    const m = montarHub()
    const { sesion } = pedidoConItemEnviado(m)
    const fila = m.db.prepare('SELECT ultimo_uso FROM sesion WHERE id = ?').get(sesion.sesionId)
    expect(fila?.ultimo_uso).toBe(m.reloj())
  })

  it('un dispositivo revocado es rechazado: no lee el salón y lo nuevo que envía no entra', () => {
    const m = montarHub()
    const sala = new SalaSync(m.hub, m.acceso.autenticar)
    const celular = m.emparejar('mesero')
    const sesion = m.entrar(celular.conexion, 'mesero')
    const caja = m.emparejar('caja').conexion
    const admin = m.entrar(caja, 'admin')
    const recibidos: MensajeHub[] = []
    const enlace = sala.conectar((x) => recibidos.push(x))
    enlace.recibir({
      tipo: 'hola',
      token: celular.token,
      hub_instancia: null,
      hasta: 0,
      version_app: 'x',
    })
    const antes = m.evento(celular.conexion, sesion, 'PedidoAbierto', {
      canal: 'barra',
      mesa_id: null,
      comensales: 1,
    })

    m.avanzar(60_000)
    const r = m.acceso.revocarDispositivo(caja, {
      ...admin,
      dispositivoId: celular.conexion.dispositivoId,
    })
    if (!r.ok) throw new Error(r.mensaje)
    sala.revocar(celular.conexion.dispositivoId, r.revocadoEn)
    m.avanzar(60_000)
    const despues = m.evento(celular.conexion, sesion, 'PedidoAbierto', {
      canal: 'barra',
      mesa_id: null,
      comensales: 1,
    })
    enlace.recibir({ tipo: 'empujar', lote_id: 'l1', eventos: [antes, despues] })
    enlace.recibir({ tipo: 'traer', desde: 0 })

    const resultado = recibidos.find((x) => x.tipo === 'resultado')
    expect(resultado?.tipo === 'resultado' && resultado.resultados.map((x) => x.estado)).toEqual([
      'cuarentena',
      'rechazado',
    ])
    expect(
      recibidos.filter((x) => x.tipo === 'error').map((x) => x.tipo === 'error' && x.codigo),
    ).toEqual(['token_revocado', 'token_revocado'])
    expect(m.db.prepare('SELECT count(*) AS n FROM evento').get()?.n).toBe(0)

    // Al reconectar, el token sigue sirviendo solo para entregar lo pendiente: no abre sesión.
    expect(
      m.acceso.iniciarSesion(m.acceso.autenticar(celular.token) as never, m.personas.mesero.pin),
    ).toMatchObject({
      codigo: 'dispositivo_revocado',
    })
  })

  it('un cajero cobra y cierra desde la caja; el mismo cajero en un celular, no', () => {
    const m = montarHub()
    const { pedido } = pedidoConItemEnviado(m)
    const celular = m.emparejar('mesero').conexion
    const s = m.entrar(celular, 'cajero')
    const cierre = m.evento(
      celular,
      s,
      'PedidoCerrado',
      {},
      { agregado_id: pedido, secuencia_base: 3 },
    )

    expect(m.hub.recibirLote(celular, [cierre]).resultados[0]).toMatchObject({
      estado: 'rechazado',
      motivo: 'solo_caja',
    })
  })
})
