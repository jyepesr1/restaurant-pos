import type { EstadoPedido, EventoPedido, ItemPedido } from '@pos/core'
import { nuevoId } from '@pos/core'
import type { BaseSqlite, Fila } from '@pos/db'
import type { Comanda, ItemComanda, TipoComanda } from '@pos/printing'
import type { CambioPedido } from '@pos/sync'

// De un evento aceptado a los trabajos de impresión de sus comandas (ADR-015). Corre dentro de la
// transacción del evento (`ConfigHub.alGuardar`): si el hub se cae justo después, las comandas ya
// están en la cola. Solo arma datos; la cola (`cola.ts`) las convierte en bytes al imprimir, con
// el ancho de la impresora que finalmente la imprima (puede ser la de respaldo).

const EN_COCINA = new Set(['enviado', 'en_preparacion', 'listo'])

const CANALES: Record<string, string> = {
  salon: 'Mesa',
  para_llevar: 'Para llevar',
  domicilio: 'Domicilio',
  barra: 'Barra',
}

/** Una comanda ya enviada: de qué estación es, qué llevaba y su número del día. */
interface Enviada {
  comandaId: string
  estacionId: string
  itemIds: string[]
  numero: number | null
}

export interface OpcionesComandas {
  db: BaseSqlite
  restauranteId: string
  zonaHoraria: string
}

/** Crea los trabajos de impresión que pide el evento. Devuelve cuántos creó. */
export function trabajosDeEvento(
  o: OpcionesComandas,
  evento: EventoPedido,
  cambios: readonly CambioPedido[],
): number {
  const cambio = cambios[0]
  const antes = cambio?.antes ?? null
  const despues = cambio?.despues ?? null
  if (!despues) return 0

  const porCrear: { comandaId: string; estacionId: string; comanda: Comanda }[] = []
  const armar = (tipo: TipoComanda, enviada: Enviada, items: ItemComanda[]) => {
    if (items.length > 0)
      porCrear.push({
        comandaId: enviada.comandaId,
        estacionId: enviada.estacionId,
        comanda: datosComanda(o, evento, despues, tipo, enviada, items),
      })
  }

  switch (evento.tipo) {
    case 'ItemsEnviados': {
      // Solo lo que de verdad pasó a enviado: lo ya enviado por otro equipo no se repite.
      for (const c of evento.datos.comandas) {
        const items = c.item_ids
          .filter(
            (id) =>
              antes?.items[id]?.estado === 'pendiente' && despues.items[id]?.estado === 'enviado',
          )
          .map((id) => despues.items[id])
          .filter((i): i is ItemPedido => !!i)
          .map((i) => itemComanda(i))
        armar(
          'nueva',
          {
            comandaId: c.comanda_id,
            estacionId: c.estacion_id,
            itemIds: c.item_ids,
            numero: evento.asignaciones.numeros_comanda?.[c.comanda_id] ?? null,
          },
          items,
        )
      }
      break
    }
    case 'ComandaReimpresa': {
      const enviada = enviadas(o, despues.id).find((e) => e.comandaId === evento.datos.comanda_id)
      if (!enviada) break
      armar('reimpresion', enviada, itemsVigentes(despues, enviada.itemIds))
      break
    }
    case 'ItemAnulado': {
      const item = antes?.items[evento.datos.item_id]
      // Lo que no se había enviado no está en la cocina, y lo entregado ya salió: no hay nada
      // que avisar allá.
      if (!item || !['enviado', 'en_preparacion', 'listo'].includes(item.estado)) break
      const enviada = enviadaDe(o, despues.id, item.id)
      if (!enviada) break
      armar('anulacion', enviada, [
        itemComanda({ ...item, cantidad: evento.datos.cantidad, cantidadAnulada: 0 }),
      ])
      break
    }
    case 'NotaPedidoCambiada': {
      // Con platos ya en cocina, la nota nueva (o que se quitó) sale en papel a cada estación que
      // tiene algo pendiente de ese pedido: una alergia no puede quedar solo en la pantalla.
      if ((antes?.notas ?? null) === despues.notas) break
      const porEstacion = new Map<string, Enviada>()
      for (const e of enviadas(o, despues.id))
        if (e.itemIds.some((id) => EN_COCINA.has(despues.items[id]?.estado ?? '')))
          porEstacion.set(e.estacionId, e)
      for (const e of porEstacion.values())
        porCrear.push({
          comandaId: e.comandaId,
          estacionId: e.estacionId,
          comanda: datosComanda(o, evento, despues, 'nota', e, []),
        })
      break
    }
    case 'ItemModificadoTrasEnvio': {
      const item = despues.items[evento.datos.item_id]
      if (!item) break
      const enviada = enviadaDe(o, despues.id, item.id)
      if (!enviada) break
      armar('modificacion', enviada, [itemComanda(item)])
      break
    }
    default:
      return 0
  }

  // Todo o nada: la transacción del evento no tiene savepoints propios (`enTransaccion`), y una
  // comanda a medias es peor que ninguna (ADR-015).
  if (porCrear.length === 0) return 0
  o.db.exec('SAVEPOINT comandas')
  try {
    const creados = insertar(o, evento, porCrear)
    o.db.exec('RELEASE comandas')
    return creados
  } catch (error) {
    o.db.exec('ROLLBACK TO comandas')
    o.db.exec('RELEASE comandas')
    throw error
  }
}

function insertar(
  o: OpcionesComandas,
  evento: EventoPedido,
  porCrear: readonly { comandaId: string; estacionId: string; comanda: Comanda }[],
): number {
  let creados = 0
  for (const { comandaId, estacionId, comanda } of porCrear) {
    for (const impresoraId of impresorasDe(o, estacionId)) {
      o.db
        .prepare(
          `INSERT INTO trabajo_impresion
             (id, restaurante_id, impresora_id, tipo, evento_id, comanda_id, contenido, creado_en)
           VALUES (?, ?, ?, 'comanda', ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .run(
          nuevoId(),
          o.restauranteId,
          impresoraId,
          evento.id,
          comandaId,
          JSON.stringify(comanda),
          evento.recibido_en,
        )
      creados += 1
    }
  }
  return creados
}

/** Impresoras activas que imprimen esa estación. */
export function impresorasDe(o: OpcionesComandas, estacionId: string): string[] {
  return o.db
    .prepare(
      `SELECT i.id FROM impresora i, json_each(i.estacion_ids) e
       WHERE i.restaurante_id = ? AND i.activo = 1 AND e.value = ?
       ORDER BY i.creado_en, i.id`,
    )
    .all(o.restauranteId, estacionId)
    .map((f) => String(f.id))
}

/**
 * La comanda con que salió a cocina un ítem. Si el ítem se pasó de otro pedido (`ItemsMovidos`
 * conserva su id), el envío está en el pedido de origen: se busca en todo el restaurante.
 */
function enviadaDe(o: OpcionesComandas, pedidoId: string, itemId: string): Enviada | undefined {
  const delPedido = enviadas(o, pedidoId).find((e) => e.itemIds.includes(itemId))
  if (delPedido) return delPedido
  const filas = o.db
    .prepare(
      `SELECT e.datos, e.asignaciones FROM evento e
       WHERE e.restaurante_id = ? AND e.tipo = 'ItemsEnviados'
         AND EXISTS (SELECT 1 FROM json_each(e.datos, '$.comandas') c, json_each(c.value, '$.item_ids') i
                     WHERE i.value = ?)
       ORDER BY e.secuencia DESC LIMIT 1`,
    )
    .all(o.restauranteId, itemId)
  return deFilas(filas).find((e) => e.itemIds.includes(itemId))
}

/** Las comandas que se enviaron de ese pedido, con su número del día. */
function enviadas(o: OpcionesComandas, pedidoId: string): Enviada[] {
  const filas = o.db
    .prepare(
      `SELECT e.datos, e.asignaciones FROM evento_agregado a
       JOIN evento e ON e.restaurante_id = a.restaurante_id AND e.id = a.evento_id
       WHERE a.restaurante_id = ? AND a.agregado_id = ? AND e.tipo = 'ItemsEnviados'
       ORDER BY a.secuencia`,
    )
    .all(o.restauranteId, pedidoId)
  return deFilas(filas)
}

function deFilas(filas: readonly Fila[]): Enviada[] {
  return filas.flatMap((f) => {
    const datos = JSON.parse(String(f.datos)) as {
      comandas: { comanda_id: string; estacion_id: string; item_ids: string[] }[]
    }
    const numeros = (
      JSON.parse(String(f.asignaciones)) as { numeros_comanda?: Record<string, number> }
    ).numeros_comanda
    return datos.comandas.map((c) => ({
      comandaId: c.comanda_id,
      estacionId: c.estacion_id,
      itemIds: c.item_ids,
      numero: numeros?.[c.comanda_id] ?? null,
    }))
  })
}

/** Lo que sigue en pie de una comanda (sin lo anulado). */
function itemsVigentes(pedido: EstadoPedido, ids: readonly string[]): ItemComanda[] {
  return ids
    .map((id) => pedido.items[id])
    .filter((i): i is ItemPedido => !!i && i.estado !== 'anulado' && i.cantidad > i.cantidadAnulada)
    .map((i) => itemComanda(i))
}

function itemComanda(i: ItemPedido): ItemComanda {
  return {
    cantidad: i.cantidad - i.cantidadAnulada,
    nombre: i.nombre,
    comensal: i.comensal,
    curso: i.curso,
    opciones: i.modificadores.map((m) => m.nombre),
    notas: i.notas,
  }
}

const valor = (o: OpcionesComandas, sql: string, ...params: string[]) =>
  o.db.prepare(sql).get(o.restauranteId, ...params)

function datosComanda(
  o: OpcionesComandas,
  evento: EventoPedido,
  pedido: EstadoPedido,
  tipo: TipoComanda,
  enviada: Enviada,
  items: ItemComanda[],
): Comanda {
  const estacion = valor(
    o,
    'SELECT nombre FROM estacion WHERE restaurante_id = ? AND id = ?',
    enviada.estacionId,
  )
  const mesero = valor(
    o,
    'SELECT nombre FROM usuario WHERE restaurante_id = ? AND id = ?',
    pedido.meseroAsignadoId,
  )
  let destino = CANALES[pedido.canal] ?? 'Pedido'
  if (pedido.mesaId) {
    const mesa = valor(
      o,
      'SELECT nombre FROM mesa WHERE restaurante_id = ? AND id = ?',
      pedido.mesaId,
    )
    destino = mesa ? `Mesa ${String(mesa.nombre)}` : 'Mesa'
  }
  return {
    tipo,
    estacion: estacion ? String(estacion.nombre) : 'Estación',
    numero: enviada.numero,
    destino,
    pedido: pedido.numeroDia,
    mesero: mesero ? String(mesero.nombre) : '',
    hora: new Intl.DateTimeFormat('es-CO', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: o.zonaHoraria,
    }).format(new Date(evento.recibido_en)),
    comensales: pedido.comensales > 0 ? pedido.comensales : null,
    items,
    retenidos: tipo === 'nueva' ? pedido.cursosRetenidos.filter((c) => tieneCurso(pedido, c)) : [],
    // En una anulación o un cambio, la nota del pedido distrae: ya salió con la comanda original.
    notaPedido: tipo === 'nueva' || tipo === 'reimpresion' || tipo === 'nota' ? pedido.notas : null,
  }
}

/** Si el pedido tiene algo de ese curso todavía retenido. */
const tieneCurso = (pedido: EstadoPedido, curso: string) =>
  Object.values(pedido.items).some((i) => i.curso === curso && i.estado === 'retenido')
