import { LIMITE_TOTAL_PEDIDO } from '../dinero/aritmetica'
import { cobradoEnEfectivo } from '../dinero/efectivo'
import type { CopiaItem, EventoAplicable, TipoEventoPedido } from '../eventos/pedido'
import type { EstadoItem, EstadoPedido, ItemPedido, Pago } from './estado'
import {
  precioUnidad,
  saldoCuenta,
  tienePagosVigentes,
  totalesItem,
  totalesPedido,
} from './totales'

/**
 * Por qué un evento no se pudo aplicar (o se aplicó en parte). El hub decide con esto si es
 * un rechazo o un conflicto (docs/SYNC.md#rechazos-cuarentena-y-conflictos).
 */
export type TipoProblema =
  | 'evento_ajeno'
  | 'evento_ya_aplicado'
  | 'pedido_inexistente'
  | 'pedido_ya_existe'
  | 'pedido_cerrado'
  | 'pedido_no_cerrado'
  | 'item_inexistente'
  | 'item_ya_existe'
  | 'item_ya_enviado'
  | 'item_no_enviado'
  | 'item_ya_anulado'
  | 'items_omitidos'
  | 'estado_item_invalido'
  | 'cantidad_invalida'
  | 'copia_distinta'
  | 'total_excede'
  | 'tiene_descuentos'
  | 'pedido_dividido'
  | 'pedido_no_dividido'
  | 'descuento_inexistente'
  | 'descuento_ya_existe'
  | 'descuento_invalido'
  | 'descuento_excede'
  | 'division_no_cuadra'
  | 'cuenta_inexistente'
  | 'pago_inexistente'
  | 'pago_ya_existe'
  | 'pago_ya_anulado'
  | 'pago_con_reembolsos'
  | 'pago_excede_saldo'
  | 'ajuste_invalido'
  | 'reembolso_ya_existe'
  | 'reembolso_excede'
  | 'medio_distinto'
  | 'usar_anulacion'
  | 'saldo_pendiente'
  | 'saldo_negativo'
  | 'tiene_pagos'
  | 'evento_invalido'

export interface Problema {
  tipo: TipoProblema
  descripcion: string
}

export interface Resultado {
  estado: EstadoPedido | null
  /** Por qué no se aplicó, o (con `items_omitidos`) qué parte no se aplicó. */
  problema: Problema | null
}

const sinCambio = (
  estado: EstadoPedido | null,
  tipo: TipoProblema,
  descripcion: string,
): Resultado => ({
  estado,
  problema: { tipo, descripcion },
})
const listo = (estado: EstadoPedido): Resultado => ({ estado, problema: null })

/** Copia profunda: la proyección anterior nunca se modifica. */
const copiar = (estado: EstadoPedido): EstadoPedido => structuredClone(estado)

/** El ítem de una copia del estado (existe porque ya se validó en el original). */
function itemDe(estado: EstadoPedido, id: string): ItemPedido {
  const item = estado.items[id]
  if (!item) throw new Error('ítem ausente en la copia')
  return item
}

function pagoDe(estado: EstadoPedido, id: string): Pago {
  const pago = estado.pagos[id]
  if (!pago) throw new Error('pago ausente en la copia')
  return pago
}

const ACTIVOS: readonly EstadoItem[] = [
  'retenido',
  'pendiente',
  'enviado',
  'en_preparacion',
  'listo',
  'entregado',
]

/** Eventos que no tocan montos y valen con el pedido ya cerrado o cancelado. */
const SIN_MONTOS: readonly TipoEventoPedido[] = [
  'ItemEnPreparacion',
  'ItemListo',
  'ItemEntregado',
  'ItemDevueltoACola',
  'ComandaReimpresa',
  'PrecuentaImpresa',
]

/** El evento toca al pedido: es su agregado o lo nombra en `relacionados` o `afecta`. */
export function afectaAPedido(evento: EventoAplicable, pedidoId: string): boolean {
  return (
    evento.agregado_id === pedidoId ||
    evento.relacionados.includes(pedidoId) ||
    (evento.afecta ?? []).includes(pedidoId)
  )
}

/**
 * Aplica un evento al estado de un pedido. Es total y determinista: nunca lanza y da el mismo
 * resultado en el celular, el hub y la nube. Acepta también eventos propios aún sin confirmar
 * (sin secuencia). `estado` es el pedido que se proyecta, que puede no ser el agregado del
 * evento (destino de ItemsMovidos, origen de PedidosUnidos, pedido de rescate en `afecta`).
 */
export function aplicarEvento(estado: EstadoPedido | null, evento: EventoAplicable): Resultado {
  try {
    if (estado && !afectaAPedido(evento, estado.id)) {
      return sinCambio(estado, 'evento_ajeno', 'El evento es de otro pedido')
    }
    if (estado && evento.secuencia !== undefined && evento.secuencia <= estado.ultimaSecuencia) {
      return sinCambio(estado, 'evento_ya_aplicado', 'El evento ya estaba aplicado')
    }
    const resultado = aplicar(estado, evento)
    if (resultado.estado && resultado.estado !== estado && evento.secuencia !== undefined) {
      resultado.estado.ultimaSecuencia = Math.max(
        resultado.estado.ultimaSecuencia,
        evento.secuencia,
      )
    }
    return resultado
  } catch {
    // Texto fijo: el mensaje de un error varía entre motores y rompería la igualdad entre nodos.
    return sinCambio(estado, 'evento_invalido', 'El evento trae datos inesperados')
  }
}

/** Reconstruye un pedido aplicando, en orden de secuencia, solo los eventos que lo tocan. */
export function reconstruir(
  eventos: readonly EventoAplicable[],
  pedidoId: string,
): EstadoPedido | null {
  const vistos = new Set<string>()
  return eventos
    .filter((evento) => {
      if (!afectaAPedido(evento, pedidoId) || vistos.has(evento.id)) return false
      vistos.add(evento.id)
      return true
    })
    .sort(
      (a, b) => (a.secuencia ?? Number.MAX_SAFE_INTEGER) - (b.secuencia ?? Number.MAX_SAFE_INTEGER),
    )
    .reduce<EstadoPedido | null>((estado, evento) => aplicarEvento(estado, evento).estado, null)
}

function nuevoItem(
  copia: CopiaItem,
  agregadoPor: string,
  orden: number,
  estado: EstadoItem,
): ItemPedido {
  return {
    id: copia.item_id,
    productoId: copia.producto_id,
    varianteId: copia.variante_id,
    nombre: copia.nombre,
    precioUnitario: copia.precio_unitario,
    impuestoTipo: copia.impuesto_tipo,
    tarifa: copia.tarifa,
    cantidad: copia.cantidad,
    cantidadAnulada: 0,
    comensal: copia.comensal,
    curso: copia.curso,
    estado,
    agregadoPor,
    notas: copia.notas,
    modificadores: copia.modificadores.map((m) => ({
      modificadorId: m.modificador_id,
      nombre: m.nombre,
      precioExtra: m.precio_extra,
    })),
    orden,
  }
}

const tieneDescuento = (estado: EstadoPedido, itemId: string) =>
  Object.values(estado.descuentos).some((d) => (d.montos[itemId] ?? 0) > 0)

const excedeTope = (estado: EstadoPedido) => totalesPedido(estado).bruto > LIMITE_TOTAL_PEDIDO

/** Estado de un ítem sin enviar según si su curso está retenido. */
const estadoSinEnviar = (estado: EstadoPedido, curso: ItemPedido['curso']): EstadoItem =>
  curso !== null && estado.cursosRetenidos.includes(curso) ? 'retenido' : 'pendiente'

interface Movido {
  item: CopiaItem
  estado: EstadoItem
  cantidad_anulada: number
  agregado_por: string
}

/** Comprueba que la copia movida coincide con el ítem real del pedido de origen. */
function mismaCopia(item: ItemPedido, movido: Movido): boolean {
  const c = movido.item
  return (
    c.producto_id === item.productoId &&
    c.precio_unitario === item.precioUnitario &&
    c.impuesto_tipo === item.impuestoTipo &&
    c.tarifa === item.tarifa &&
    c.cantidad === item.cantidad &&
    movido.cantidad_anulada === item.cantidadAnulada &&
    movido.estado === item.estado &&
    movido.agregado_por === item.agregadoPor &&
    c.modificadores.length === item.modificadores.length &&
    c.modificadores.every(
      (m, i) =>
        m.modificador_id === item.modificadores[i]?.modificadorId &&
        m.precio_extra === item.modificadores[i]?.precioExtra,
    )
  )
}

/**
 * Cambia el estado de varios ítems. Se aplica a los que pueden; si alguno no puede, se informa
 * con `items_omitidos` (el resto igual llega a cocina). Si ninguno puede, nada cambia.
 */
function transicion(
  estado: EstadoPedido,
  itemIds: readonly string[],
  desde: readonly EstadoItem[],
  hacia: EstadoItem,
): Resultado {
  const validos = itemIds.filter((id) => {
    const item = estado.items[id]
    return item !== undefined && desde.includes(item.estado)
  })
  if (validos.length === 0) {
    const inexistente = itemIds.some((id) => !estado.items[id])
    return sinCambio(
      estado,
      inexistente ? 'item_inexistente' : 'estado_item_invalido',
      `Ningún ítem puede pasar a ${hacia}`,
    )
  }
  const nuevo = copiar(estado)
  for (const id of validos) itemDe(nuevo, id).estado = hacia
  const omitidos = itemIds.length - validos.length
  if (omitidos === 0) return listo(nuevo)
  return {
    estado: nuevo,
    problema: { tipo: 'items_omitidos', descripcion: `${omitidos} ítem(s) no pasaron a ${hacia}` },
  }
}

function aplicar(estado: EstadoPedido | null, evento: EventoAplicable): Resultado {
  const hora = evento.recibido_en ?? evento.hora_estimada_hub

  if (evento.tipo === 'PedidoAbierto' || evento.tipo === 'PedidoRescateCreado') {
    if (estado) return sinCambio(estado, 'pedido_ya_existe', 'El pedido ya está abierto')
    const rescate = evento.tipo === 'PedidoRescateCreado'
    return listo({
      id: evento.agregado_id,
      canal: evento.datos.canal,
      mesaId: evento.datos.mesa_id,
      comensales: rescate ? 0 : evento.datos.comensales,
      meseroAsignadoId: rescate ? evento.datos.mesero_id : evento.usuario_id,
      estado: 'abierto',
      abiertoEn: hora,
      cerradoEn: null,
      diaOperativo: null,
      numeroDia: evento.asignaciones?.numero_dia ?? null,
      rescateDe: rescate ? evento.datos.pedido_original_id : null,
      unidoA: null,
      items: {},
      descuentos: {},
      cursosRetenidos: [],
      cuentas: null,
      pagos: {},
      ultimaPrecuenta: null,
      ultimaSecuencia: evento.secuencia ?? 0,
      siguienteOrden: 1,
    })
  }

  if (!estado) return sinCambio(null, 'pedido_inexistente', 'El pedido no existe')

  if (evento.tipo === 'PedidoReabierto') {
    if (estado.estado !== 'cerrado')
      return sinCambio(estado, 'pedido_no_cerrado', 'Solo se reabre un pedido cerrado')
    const nuevo = copiar(estado)
    nuevo.estado = 'abierto'
    nuevo.cerradoEn = null
    return listo(nuevo)
  }

  if (estado.estado !== 'abierto' && !SIN_MONTOS.includes(evento.tipo)) {
    return sinCambio(estado, 'pedido_cerrado', `El pedido está ${estado.estado}: hay que reabrirlo`)
  }

  switch (evento.tipo) {
    case 'MeseroAsignado': {
      const nuevo = copiar(estado)
      nuevo.meseroAsignadoId = evento.datos.mesero_id
      return listo(nuevo)
    }

    case 'ComensalesCambiados': {
      const nuevo = copiar(estado)
      nuevo.comensales = evento.datos.comensales
      return listo(nuevo)
    }

    case 'ItemAgregado': {
      const { item_id, curso } = evento.datos
      if (estado.items[item_id]) return sinCambio(estado, 'item_ya_existe', 'El ítem ya existe')
      const nuevo = copiar(estado)
      nuevo.items[item_id] = nuevoItem(
        evento.datos,
        evento.usuario_id,
        nuevo.siguienteOrden,
        estadoSinEnviar(nuevo, curso),
      )
      nuevo.siguienteOrden += 1
      if (excedeTope(nuevo))
        return sinCambio(estado, 'total_excede', 'El pedido pasaría del tope permitido')
      return listo(nuevo)
    }

    case 'ItemCambiado':
    case 'ItemQuitado': {
      const item = estado.items[evento.datos.item_id]
      if (!item) return sinCambio(estado, 'item_inexistente', 'El ítem no existe')
      if (item.estado !== 'pendiente' && item.estado !== 'retenido') {
        return sinCambio(estado, 'item_ya_enviado', `${item.nombre} ya se envió a cocina`)
      }
      // Solo lo que cambia montos exige retirar descuentos o deshacer la división.
      const cambiaMonto = evento.tipo === 'ItemQuitado' || evento.datos.cantidad !== undefined
      if (cambiaMonto && tieneDescuento(estado, item.id)) {
        return sinCambio(estado, 'tiene_descuentos', 'Primero retira el descuento')
      }
      if (cambiaMonto && estado.cuentas)
        return sinCambio(estado, 'pedido_dividido', 'Primero deshaz la división')
      const nuevo = copiar(estado)
      if (evento.tipo === 'ItemQuitado') {
        delete nuevo.items[item.id]
      } else {
        const cambio = itemDe(nuevo, item.id)
        const { cantidad, comensal, curso, notas } = evento.datos
        if (cantidad !== undefined) cambio.cantidad = cantidad
        if (comensal !== undefined) cambio.comensal = comensal
        if (notas !== undefined) cambio.notas = notas
        if (curso !== undefined) {
          cambio.curso = curso
          cambio.estado = estadoSinEnviar(nuevo, curso)
        }
      }
      if (totalesPedido(nuevo).saldo < 0) {
        return sinCambio(
          estado,
          'saldo_negativo',
          'Ya se pagó: primero anula el pago o registra un reembolso',
        )
      }
      if (excedeTope(nuevo))
        return sinCambio(estado, 'total_excede', 'El pedido pasaría del tope permitido')
      return listo(nuevo)
    }

    case 'ItemsEnviados':
      return transicion(
        estado,
        evento.datos.comandas.flatMap((c) => c.item_ids),
        ['pendiente'],
        'enviado',
      )

    case 'ItemModificadoTrasEnvio': {
      const item = estado.items[evento.datos.item_id]
      if (!item) return sinCambio(estado, 'item_inexistente', 'El ítem no existe')
      if (item.estado === 'pendiente' || item.estado === 'retenido') {
        return sinCambio(estado, 'item_no_enviado', 'El ítem aún no se envió: usa ItemCambiado')
      }
      if (item.estado === 'anulado')
        return sinCambio(estado, 'item_ya_anulado', 'El ítem está anulado')
      const { modificadores, notas } = evento.datos
      const extrasActuales = item.modificadores.reduce((a, m) => a + m.precioExtra, 0)
      const cambiaPrecio =
        modificadores !== undefined &&
        modificadores.reduce((a, m) => a + m.precio_extra, 0) !== extrasActuales
      if (cambiaPrecio && tieneDescuento(estado, item.id))
        return sinCambio(estado, 'tiene_descuentos', 'Primero retira el descuento')
      if (cambiaPrecio && estado.cuentas)
        return sinCambio(estado, 'pedido_dividido', 'Primero deshaz la división')
      const nuevo = copiar(estado)
      const cambio = itemDe(nuevo, item.id)
      if (notas !== undefined) cambio.notas = notas
      if (modificadores !== undefined) {
        cambio.modificadores = modificadores.map((m) => ({
          modificadorId: m.modificador_id,
          nombre: m.nombre,
          precioExtra: m.precio_extra,
        }))
      }
      if (totalesPedido(nuevo).saldo < 0)
        return sinCambio(estado, 'saldo_negativo', 'El pedido quedaría con saldo negativo')
      if (excedeTope(nuevo))
        return sinCambio(estado, 'total_excede', 'El pedido pasaría del tope permitido')
      return listo(nuevo)
    }

    case 'ComandaReimpresa':
      return listo({ ...estado })

    case 'CursoRetenido':
    case 'CursoMarchado': {
      const { curso } = evento.datos
      const retener = evento.tipo === 'CursoRetenido'
      const nuevo = copiar(estado)
      nuevo.cursosRetenidos = retener
        ? [...new Set([...nuevo.cursosRetenidos, curso])]
        : nuevo.cursosRetenidos.filter((c) => c !== curso)
      for (const item of Object.values(nuevo.items)) {
        if (item.curso !== curso) continue
        if (retener && item.estado === 'pendiente') item.estado = 'retenido'
        if (!retener && item.estado === 'retenido') item.estado = 'pendiente'
      }
      return listo(nuevo)
    }

    case 'ItemEnPreparacion':
      return transicion(estado, evento.datos.item_ids, ['enviado'], 'en_preparacion')
    case 'ItemListo':
      return transicion(estado, evento.datos.item_ids, ['enviado', 'en_preparacion'], 'listo')
    case 'ItemEntregado':
      // Sin KDS nadie marca "listo": el mesero puede entregar directo desde enviado.
      return transicion(
        estado,
        evento.datos.item_ids,
        ['enviado', 'en_preparacion', 'listo'],
        'entregado',
      )
    case 'ItemDevueltoACola':
      return transicion(estado, evento.datos.item_ids, ['listo', 'entregado'], 'enviado')

    case 'ItemAnulado': {
      const item = estado.items[evento.datos.item_id]
      if (!item) return sinCambio(estado, 'item_inexistente', 'El ítem no existe')
      if (item.estado === 'anulado')
        return sinCambio(estado, 'item_ya_anulado', `${item.nombre} ya está anulado`)
      if (item.estado === 'pendiente' || item.estado === 'retenido') {
        return sinCambio(estado, 'item_no_enviado', 'Un ítem no enviado se quita, no se anula')
      }
      if (evento.datos.cantidad > item.cantidad - item.cantidadAnulada) {
        return sinCambio(estado, 'cantidad_invalida', 'Se anulan más unidades de las que quedan')
      }
      if (tieneDescuento(estado, item.id))
        return sinCambio(estado, 'tiene_descuentos', 'Primero retira el descuento')
      if (estado.cuentas) return sinCambio(estado, 'pedido_dividido', 'Primero deshaz la división')
      const nuevo = copiar(estado)
      const anulado = itemDe(nuevo, item.id)
      anulado.cantidadAnulada += evento.datos.cantidad
      if (anulado.cantidadAnulada === anulado.cantidad) anulado.estado = 'anulado'
      if (totalesPedido(nuevo).saldo < 0) {
        return sinCambio(
          estado,
          'saldo_negativo',
          'Ya se pagó: primero anula el pago o registra un reembolso',
        )
      }
      return listo(nuevo)
    }

    case 'ItemsMovidos':
    case 'PedidosUnidos': {
      const mover = evento.tipo === 'ItemsMovidos'
      const origenId = mover ? evento.agregado_id : evento.datos.pedido_origen_id
      const destinoId = mover ? evento.datos.pedido_destino_id : evento.agregado_id
      const esOrigen = estado.id === origenId
      if (!esOrigen && estado.id !== destinoId)
        return sinCambio(estado, 'evento_invalido', 'El pedido no es ni origen ni destino')
      if (estado.cuentas) return sinCambio(estado, 'pedido_dividido', 'Primero deshaz la división')
      const nuevo = copiar(estado)

      if (esOrigen) {
        if (!mover) {
          if (tienePagosVigentes(estado))
            return sinCambio(estado, 'tiene_pagos', 'El pedido que se une tiene pagos')
          if (Object.keys(estado.descuentos).length > 0) {
            return sinCambio(
              estado,
              'tiene_descuentos',
              'Primero retira los descuentos del pedido que se une',
            )
          }
          const activos = Object.values(estado.items).filter((i) => i.estado !== 'anulado')
          if (activos.length !== evento.datos.items.length) {
            return sinCambio(
              estado,
              'copia_distinta',
              'La unión no trae todos los ítems del pedido',
            )
          }
        }
        for (const movido of evento.datos.items) {
          const item = nuevo.items[movido.item.item_id]
          if (!item || !ACTIVOS.includes(item.estado)) {
            return sinCambio(
              estado,
              'item_inexistente',
              'Un ítem que se mueve no está en el pedido',
            )
          }
          if (tieneDescuento(nuevo, item.id))
            return sinCambio(estado, 'tiene_descuentos', 'Primero retira el descuento')
          if (!mismaCopia(item, movido))
            return sinCambio(estado, 'copia_distinta', `La copia de ${item.nombre} no coincide`)
          delete nuevo.items[item.id]
        }
        if (!mover) {
          nuevo.items = {}
          nuevo.estado = 'cancelado'
          nuevo.unidoA = destinoId
        } else if (totalesPedido(nuevo).saldo < 0) {
          return sinCambio(estado, 'saldo_negativo', 'Se movería algo ya pagado')
        }
        return listo(nuevo)
      }

      for (const movido of evento.datos.items) {
        const id = movido.item.item_id
        if (nuevo.items[id])
          return sinCambio(estado, 'item_ya_existe', 'El ítem ya está en el destino')
        const item = nuevoItem(
          movido.item,
          movido.agregado_por,
          nuevo.siguienteOrden,
          movido.estado,
        )
        item.cantidadAnulada = movido.cantidad_anulada
        nuevo.items[id] = item
        nuevo.siguienteOrden += 1
      }
      if (excedeTope(nuevo))
        return sinCambio(estado, 'total_excede', 'El pedido pasaría del tope permitido')
      return listo(nuevo)
    }

    case 'PedidoMovidoDeMesa': {
      const nuevo = copiar(estado)
      nuevo.mesaId = evento.datos.mesa_destino_id
      return listo(nuevo)
    }

    case 'DescuentoAplicado': {
      const { descuento_id, montos, alcance, regla, valor, cantidad_unidades } = evento.datos
      if (estado.descuentos[descuento_id])
        return sinCambio(estado, 'descuento_ya_existe', 'El descuento ya existe')
      if (estado.cuentas) return sinCambio(estado, 'pedido_dividido', 'Primero deshaz la división')
      for (const { item_id, monto } of montos) {
        const item = estado.items[item_id]
        if (!item || item.estado === 'anulado')
          return sinCambio(estado, 'item_inexistente', 'No se puede descontar ese ítem')
        if (regla === 'cortesia') {
          const unidades = cantidad_unidades ?? 0
          if (
            unidades > item.cantidad - item.cantidadAnulada ||
            monto !== unidades * precioUnidad(item)
          ) {
            return sinCambio(
              estado,
              'descuento_invalido',
              'La cortesía no coincide con las unidades del ítem',
            )
          }
        }
      }
      const nuevo = copiar(estado)
      nuevo.descuentos[descuento_id] = {
        id: descuento_id,
        alcance,
        regla,
        valor,
        montos: Object.fromEntries(montos.map((m) => [m.item_id, m.monto])),
        motivo: evento.motivo,
      }
      for (const { item_id } of montos) {
        if (totalesItem(nuevo, itemDe(nuevo, item_id)).neto < 0) {
          return sinCambio(
            estado,
            'descuento_excede',
            'El descuento deja una línea por debajo de 0',
          )
        }
      }
      if (totalesPedido(nuevo).saldo < 0)
        return sinCambio(estado, 'saldo_negativo', 'El pedido ya está pagado')
      return listo(nuevo)
    }

    case 'DescuentoRetirado': {
      if (!estado.descuentos[evento.datos.descuento_id]) {
        return sinCambio(estado, 'descuento_inexistente', 'El descuento no existe')
      }
      if (estado.cuentas) return sinCambio(estado, 'pedido_dividido', 'Primero deshaz la división')
      const nuevo = copiar(estado)
      delete nuevo.descuentos[evento.datos.descuento_id]
      return listo(nuevo)
    }

    case 'PrecuentaImpresa': {
      const nuevo = copiar(estado)
      nuevo.ultimaPrecuenta = {
        cuentaId: evento.datos.cuenta_id,
        subtotal: evento.datos.subtotal,
        propinaSugerida: evento.datos.propina_sugerida,
      }
      return listo(nuevo)
    }

    case 'CuentaDividida': {
      if (estado.cuentas) return sinCambio(estado, 'pedido_dividido', 'El pedido ya está dividido')
      const referidos = evento.datos.cuentas.flatMap((c) => c.items.map((i) => i.item_id))
      if (referidos.some((id) => !estado.items[id])) {
        return sinCambio(estado, 'item_inexistente', 'Una cuenta nombra un ítem que no está')
      }
      const asignado = evento.datos.cuentas.reduce((a, c) => a + c.monto, 0)
      if (asignado > totalesPedido(estado).saldo) {
        return sinCambio(estado, 'division_no_cuadra', 'Las cuentas suman más que el saldo')
      }
      const nuevo = copiar(estado)
      nuevo.cuentas = evento.datos.cuentas.map((c) => ({
        id: c.cuenta_id,
        nombre: c.nombre,
        monto: c.monto,
        propinaSugerida: c.propina_sugerida,
      }))
      return listo(nuevo)
    }

    case 'DivisionDeshecha': {
      if (!estado.cuentas)
        return sinCambio(estado, 'pedido_no_dividido', 'El pedido no está dividido')
      const cuentas = new Set(estado.cuentas.map((c) => c.id))
      const conPagos = Object.values(estado.pagos).some(
        (p) => !p.anulado && p.cuentaId !== null && cuentas.has(p.cuentaId),
      )
      if (conPagos) return sinCambio(estado, 'tiene_pagos', 'Hay cuentas con pagos')
      const nuevo = copiar(estado)
      nuevo.cuentas = null
      return listo(nuevo)
    }

    case 'PagoRegistrado': {
      const d = evento.datos
      if (estado.pagos[d.pago_id])
        return sinCambio(estado, 'pago_ya_existe', 'El pago ya está registrado')
      let disponible: number | null
      if (d.cuenta_id === null && estado.cuentas) {
        // Sin cuenta en un pedido dividido: solo lo que quedó sin asignar.
        const enCuentas = estado.cuentas.reduce(
          (a, c) => a + Math.max(0, saldoCuenta(estado, c.id) ?? 0),
          0,
        )
        disponible = totalesPedido(estado).saldo - enCuentas
      } else {
        disponible = saldoCuenta(estado, d.cuenta_id)
      }
      if (disponible === null) return sinCambio(estado, 'cuenta_inexistente', 'La cuenta no existe')
      if (d.monto > disponible)
        return sinCambio(estado, 'pago_excede_saldo', `El pago supera el saldo (${disponible})`)
      if (d.redondeo !== null) {
        // El redondeo solo va en el pago en efectivo que deja el saldo en 0, y su ajuste debe ser
        // exactamente el de la regla (docs/DINERO.md#pagos).
        const esperado =
          cobradoEnEfectivo(disponible, d.redondeo.multiplo, d.redondeo.modo) - disponible
        if (d.monto !== disponible || d.ajuste_redondeo !== esperado) {
          return sinCambio(
            estado,
            'ajuste_invalido',
            'El ajuste no corresponde al redondeo del saldo',
          )
        }
      }
      const nuevo = copiar(estado)
      nuevo.pagos[d.pago_id] = {
        id: d.pago_id,
        cuentaId: d.cuenta_id,
        turnoCajaId: d.turno_caja_id,
        medio: d.medio,
        monto: d.monto,
        propina: d.propina,
        ajusteRedondeo: d.ajuste_redondeo,
        anulado: false,
        reembolsadoVenta: 0,
        reembolsadoPropina: 0,
        reembolsoIds: [],
      }
      return listo(nuevo)
    }

    case 'PagoAnulado': {
      const pago = estado.pagos[evento.datos.pago_id]
      if (!pago) return sinCambio(estado, 'pago_inexistente', 'El pago no existe')
      if (pago.anulado) return sinCambio(estado, 'pago_ya_anulado', 'El pago ya está anulado')
      // Una anulación devuelve lo cobrado completo: con reembolsos previos se devolvería dos veces.
      if (pago.reembolsadoVenta + pago.reembolsadoPropina > 0) {
        return sinCambio(
          estado,
          'pago_con_reembolsos',
          'El pago ya tiene reembolsos: reembolsa el resto',
        )
      }
      const nuevo = copiar(estado)
      pagoDe(nuevo, pago.id).anulado = true
      return listo(nuevo)
    }

    case 'ReembolsoRegistrado': {
      const d = evento.datos
      const pago = estado.pagos[d.pago_id]
      if (!pago) return sinCambio(estado, 'pago_inexistente', 'El pago no existe')
      if (pago.anulado) return sinCambio(estado, 'pago_ya_anulado', 'El pago está anulado')
      if (pago.reembolsoIds.includes(d.reembolso_id))
        return sinCambio(estado, 'reembolso_ya_existe', 'El reembolso ya se registró')
      if (d.medio !== pago.medio)
        return sinCambio(estado, 'medio_distinto', 'Se reembolsa por el mismo medio del pago')
      const venta = pago.reembolsadoVenta + d.monto_venta
      const propina = pago.reembolsadoPropina + d.monto_propina
      const cobrado = pago.monto + pago.ajusteRedondeo + pago.propina
      if (venta > pago.monto || propina > pago.propina || venta + propina > cobrado) {
        return sinCambio(estado, 'reembolso_excede', 'El reembolso supera lo pagado')
      }
      // Devolver toda la venta de un pago en efectivo con ajuste dejaría el ajuste suelto: se anula el pago.
      if (pago.ajusteRedondeo !== 0 && venta >= pago.monto + Math.min(0, pago.ajusteRedondeo)) {
        return sinCambio(estado, 'usar_anulacion', 'Para devolver todo este pago, anúlalo')
      }
      const nuevo = copiar(estado)
      const reembolsado = pagoDe(nuevo, pago.id)
      reembolsado.reembolsadoVenta = venta
      reembolsado.reembolsadoPropina = propina
      reembolsado.reembolsoIds.push(d.reembolso_id)
      return listo(nuevo)
    }

    case 'PedidoCerrado': {
      const { saldo } = totalesPedido(estado)
      if (saldo !== 0) return sinCambio(estado, 'saldo_pendiente', `Queda un saldo de ${saldo}`)
      const nuevo = copiar(estado)
      nuevo.estado = 'cerrado'
      nuevo.cerradoEn = hora
      nuevo.diaOperativo ??= evento.dia_operativo ?? null
      return listo(nuevo)
    }

    case 'PedidoCancelado': {
      if (tienePagosVigentes(estado))
        return sinCambio(estado, 'tiene_pagos', 'Primero anula los pagos')
      const nuevo = copiar(estado)
      nuevo.estado = 'cancelado'
      return listo(nuevo)
    }
  }
}
