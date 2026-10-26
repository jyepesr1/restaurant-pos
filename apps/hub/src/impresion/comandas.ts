import type { EstadoPedido, EventoPedido, ItemPedido } from '@pos/core'
import {
  configCompleta,
  impuestosDelPedido,
  nuevoId,
  propinaDelPedido,
  propinaPendienteDeCuenta,
  saldoCuenta,
  totalesItem,
  totalesPedido,
} from '@pos/core'
import type { BaseSqlite, Fila } from '@pos/db'
import {
  type Comanda,
  type ItemComanda,
  nombreImpuesto,
  type Precuenta,
  type TipoComanda,
} from '@pos/printing'
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
  if (evento.tipo === 'PrecuentaImpresa') return trabajoDePrecuenta(o, evento, despues)

  const porCrear: { comandaId: string; estacionId: string; comanda: Comanda }[] = []
  const armar = (
    tipo: TipoComanda,
    enviada: Enviada,
    items: ItemComanda[],
    pedido: EstadoPedido = despues,
    desde: string | null = null,
  ) => {
    if (items.length > 0)
      porCrear.push({
        comandaId: enviada.comandaId,
        estacionId: enviada.estacionId,
        comanda: { ...datosComanda(o, evento, pedido, tipo, enviada, items), antes: desde },
      })
  }
  /** Lo que sigue en cocina de un pedido, agrupado por la comanda con que salió. */
  const enCocinaPorComanda = (pedido: EstadoPedido, ids?: readonly string[]) => {
    const grupos = new Map<string, { enviada: Enviada; items: ItemComanda[] }>()
    for (const item of Object.values(pedido.items)) {
      if (ids && !ids.includes(item.id)) continue
      if (!EN_COCINA.has(item.estado) || item.cantidad <= item.cantidadAnulada) continue
      const enviada = enviadaDe(o, pedido.id, item.id)
      if (!enviada) continue
      const g = grupos.get(enviada.comandaId) ?? { enviada, items: [] }
      g.items.push(itemComanda(item))
      grupos.set(enviada.comandaId, g)
    }
    return [...grupos.values()]
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
      // Si sus platos pasaron a otra mesa, el envío está en el pedido de origen.
      const enviada =
        enviadas(o, despues.id).find((e) => e.comandaId === evento.datos.comanda_id) ??
        enviadaGlobal(o, evento.datos.comanda_id)
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
    case 'PedidoCancelado': {
      // Lo que la cocina tenía de un pedido cancelado sale como anulación.
      if (!antes) break
      for (const g of enCocinaPorComanda(antes)) armar('anulacion', g.enviada, g.items)
      break
    }
    case 'PedidoMovidoDeMesa': {
      if (!antes || antes.mesaId === despues.mesaId) break
      for (const g of enCocinaPorComanda(despues))
        armar('traslado', g.enviada, g.items, despues, destinoDe(o, antes))
      break
    }
    case 'ItemsMovidos': {
      // El evento va en el pedido de origen; el de destino viene como relacionado.
      const destino = cambios.find((c) => c.despues?.id === evento.datos.pedido_destino_id)?.despues
      if (!antes || !destino) break
      const ids = evento.datos.items.map((m) => m.item.item_id)
      for (const g of enCocinaPorComanda({ ...antes, items: pickItems(antes, ids) }))
        armar('traslado', g.enviada, g.items, destino, destinoDe(o, antes))
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

/**
 * La precuenta va a la impresora elegida en «Caja y pagos» (tarea 1.6). Sin impresora, o si la
 * elegida está archivada, solo se ve en pantalla: no se crea nada.
 */
function trabajoDePrecuenta(
  o: OpcionesComandas,
  evento: Extract<EventoPedido, { tipo: 'PrecuentaImpresa' }>,
  pedido: EstadoPedido,
): number {
  const fila = valor(o, 'SELECT nombre, config FROM restaurante WHERE id = ?')
  const config = configCompleta(JSON.parse(String(fila?.config ?? '{}')))
  const impresoraId = config.impresora_precuenta_id
  if (
    !impresoraId ||
    !valor(
      o,
      'SELECT 1 FROM impresora WHERE restaurante_id = ? AND id = ? AND activo = 1',
      impresoraId,
    )
  )
    return 0
  const mesero = valor(
    o,
    'SELECT nombre FROM usuario WHERE restaurante_id = ? AND id = ?',
    pedido.meseroAsignadoId,
  )
  const totales = totalesPedido(pedido)
  const cuenta = evento.datos.cuenta_id
    ? (pedido.cuentas?.find((c) => c.id === evento.datos.cuenta_id) ?? null)
    : null
  // Lo que se debe lo calcula el hub con el pedido: el evento solo dice qué cuenta se pidió. La
  // propina es voluntaria: va la que se eligió al pedir la precuenta (la sugerida, ninguna u otra).
  const subtotal = cuenta ? Math.max(0, saldoCuenta(pedido, cuenta.id) ?? 0) : totales.saldo
  const propina = evento.datos.propina_sugerida
  const sugerida = cuenta
    ? propinaPendienteDeCuenta(cuenta, subtotal)
    : propinaDelPedido(pedido, subtotal, config)
  const precuenta: Precuenta = {
    restaurante: String(fila?.nombre ?? ''),
    destino: destinoDe(o, pedido),
    pedido: pedido.numeroDia,
    mesero: mesero ? String(mesero.nombre) : '',
    hora: horaDe(o, evento.recibido_en),
    comensales: pedido.comensales > 0 ? pedido.comensales : null,
    lineas: Object.values(pedido.items)
      .filter((i) => i.estado !== 'anulado' && i.cantidad > i.cantidadAnulada)
      .sort((a, b) => a.orden - b.orden)
      .map((i) => ({
        cantidad: i.cantidad - i.cantidadAnulada,
        nombre: i.nombre,
        opciones: i.modificadores.map((m) => m.nombre),
        valor: totalesItem(pedido, i).neto,
      })),
    impuestos: impuestosDelPedido(pedido, config.redondeo_modo).map((i) => ({
      nombre: nombreImpuesto(i.tipo, i.tarifa),
      base: i.base,
      valor: i.impuesto,
    })),
    total: totales.neto,
    pagado: totales.pagado,
    cuenta: cuenta ? { nombre: cuenta.nombre, monto: subtotal } : null,
    subtotal,
    propina,
    tasaPropina: propina === sugerida ? config.propina_sugerida : null,
  }
  o.db
    .prepare(
      `INSERT INTO trabajo_impresion
         (id, restaurante_id, impresora_id, tipo, evento_id, comanda_id, contenido, creado_en)
       VALUES (?, ?, ?, 'precuenta', ?, 'precuenta', ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(
      nuevoId(),
      o.restauranteId,
      impresoraId,
      evento.id,
      JSON.stringify(precuenta),
      evento.recibido_en,
    )
  return 1
}

const horaDe = (o: OpcionesComandas, iso: string) =>
  new Intl.DateTimeFormat('es-CO', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: o.zonaHoraria,
  }).format(new Date(iso))

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

/** Una comanda por su id, en cualquier pedido del restaurante. */
function enviadaGlobal(o: OpcionesComandas, comandaId: string): Enviada | undefined {
  const filas = o.db
    .prepare(
      `SELECT e.datos, e.asignaciones FROM evento e
       WHERE e.restaurante_id = ? AND e.tipo = 'ItemsEnviados'
         AND EXISTS (SELECT 1 FROM json_each(e.datos, '$.comandas') c
                     WHERE json_extract(c.value, '$.comanda_id') = ?)
       LIMIT 1`,
    )
    .all(o.restauranteId, comandaId)
  return deFilas(filas).find((e) => e.comandaId === comandaId)
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

/** «Mesa 5», «Mesa 5 + 6» (un grupo con mesas unidas), «Para llevar»… */
function destinoDe(o: OpcionesComandas, pedido: EstadoPedido): string {
  if (!pedido.mesaId) return CANALES[pedido.canal] ?? 'Pedido'
  const nombre = (id: string) =>
    valor(o, 'SELECT nombre FROM mesa WHERE restaurante_id = ? AND id = ?', id)?.nombre
  const principal = nombre(pedido.mesaId)
  const unidas = (pedido.mesasUnidas ?? []).map(nombre).filter((n) => n !== undefined)
  return principal === undefined ? 'Mesa' : `Mesa ${[principal, ...unidas].map(String).join(' + ')}`
}

/** Solo esos ítems del pedido. */
function pickItems(pedido: EstadoPedido, ids: readonly string[]): EstadoPedido['items'] {
  return Object.fromEntries(Object.entries(pedido.items).filter(([id]) => ids.includes(id)))
}

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
  const destino = destinoDe(o, pedido)
  return {
    tipo,
    estacion: estacion ? String(estacion.nombre) : 'Estación',
    numero: enviada.numero,
    destino,
    pedido: pedido.numeroDia,
    mesero: mesero ? String(mesero.nombre) : '',
    hora: horaDe(o, evento.recibido_en),
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
