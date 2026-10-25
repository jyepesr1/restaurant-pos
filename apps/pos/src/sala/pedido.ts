import {
  type EstadoPedido,
  type EventoNuevo,
  type ItemPedido,
  nuevoId,
  precioConExtras,
} from '@pos/core'
import type { Catalogo } from '@pos/sync'
import { itemsVigentes } from './proyeccion'

// Lo que se guarda al tomar un pedido, armado desde el catálogo. El ítem lleva copia del nombre,
// el precio y el impuesto vigentes (docs/MODELO_DATOS.md): si la carta cambia después, el pedido
// no cambia.

export type ProductoCatalogo = Catalogo['categorias'][number]['productos'][number]
export type GrupoCatalogo = ProductoCatalogo['grupos'][number]
export type OpcionCatalogo = GrupoCatalogo['opciones'][number]

type DatosItem = Extract<EventoNuevo, { tipo: 'ItemAgregado' }>['datos']
type DatosEnvio = Extract<EventoNuevo, { tipo: 'ItemsEnviados' }>['datos']

/** Las opciones del grupo que están elegidas; un id que no es del grupo no cuenta. */
const elegidasDe = (g: GrupoCatalogo, elegidas: Record<string, string[]>) =>
  g.opciones.filter((o) => elegidas[g.id]?.includes(o.id))

/** Si el producto pide elegir algo antes de agregarlo (tamaño o un grupo obligatorio). */
export const pideOpciones = (p: ProductoCatalogo) => p.variantes.length > 0 || p.grupos.length > 0

/**
 * Lo que falta elegir, en minúsculas para "Elige …". La variante es obligatoria si el producto
 * tiene; cada grupo pide entre su mínimo y su máximo.
 */
export function faltaElegir(
  p: ProductoCatalogo,
  varianteId: string | null,
  elegidas: Record<string, string[]>,
): string[] {
  return [
    ...(p.variantes.length > 0 && !p.variantes.some((v) => v.id === varianteId) ? ['tamaño'] : []),
    ...p.grupos
      .filter((g) => elegidasDe(g, elegidas).length < g.minimo)
      .map((g) => g.nombre.toLowerCase()),
  ]
}

export function datosItem(
  catalogo: Catalogo,
  p: ProductoCatalogo,
  varianteId: string | null,
  elegidas: Record<string, string[]>,
): DatosItem {
  const faltan = faltaElegir(p, varianteId, elegidas)
  if (faltan.length > 0) throw new Error(`Falta elegir: ${faltan.join(', ')}`)
  const variante = p.variantes.find((v) => v.id === varianteId) ?? null
  const modificadores = p.grupos.flatMap((g) => {
    const elegidasGrupo = elegidasDe(g, elegidas)
    // Recortar en silencio cobraría distinto de lo que mostró el panel: mejor no guardar.
    if (elegidasGrupo.length > g.maximo)
      throw new Error(`En ${g.nombre.toLowerCase()} se eligen máximo ${g.maximo}`)
    return elegidasGrupo.map((o) => ({
      modificador_id: o.id,
      nombre: o.nombre,
      precio_extra: o.precioExtra,
    }))
  })
  return {
    item_id: nuevoId(),
    producto_id: p.id,
    variante_id: variante?.id ?? null,
    nombre: variante ? `${p.nombre} · ${variante.nombre}` : p.nombre,
    precio_unitario: variante?.precio ?? p.precio,
    impuesto_tipo: p.impuesto.tipo,
    tarifa: p.impuesto.tipo === 'exento' ? 0 : p.impuesto.tarifa,
    cantidad: 1,
    comensal: null,
    curso: null,
    modificadores,
    notas: null,
    catalogo_version: catalogo.version,
    precio_canal_id: null,
  }
}

/**
 * Precio de una unidad con lo elegido hasta ahora (variante + extras), el mismo que llevará el
 * ítem guardado: lo muestra el botón "Agregar".
 */
export function precioElegido(
  p: ProductoCatalogo,
  varianteId: string | null,
  elegidas: Record<string, string[]>,
): number {
  const base = p.variantes.find((v) => v.id === varianteId)?.precio ?? p.precio
  return precioConExtras(
    base,
    p.grupos.flatMap((g) => elegidasDe(g, elegidas).map((o) => o.precioExtra)),
  )
}

/** Los datos para volver a agregar un ítem quitado, igual pero con un id nuevo. */
export function copiaDe(item: ItemPedido, catalogoVersion: number): DatosItem {
  return {
    item_id: nuevoId(),
    producto_id: item.productoId,
    variante_id: item.varianteId,
    nombre: item.nombre,
    precio_unitario: item.precioUnitario,
    impuesto_tipo: item.impuestoTipo,
    tarifa: item.tarifa,
    cantidad: item.cantidad,
    comensal: item.comensal,
    curso: item.curso,
    modificadores: item.modificadores.map((m) => ({
      modificador_id: m.modificadorId,
      nombre: m.nombre,
      precio_extra: m.precioExtra,
    })),
    notas: item.notas,
    catalogo_version: catalogoVersion,
    precio_canal_id: null,
  }
}

/** Ítems que faltan por enviar a cocina o barra. */
export const porEnviar = (estado: EstadoPedido) =>
  itemsVigentes(estado).filter((i) => i.estado === 'pendiente')

/**
 * Una comanda por estación con lo que falta enviar. La estación es la de la categoría del
 * producto; si no tiene, la primera del restaurante. Sin estaciones no hay a dónde enviar.
 */
export function comandasPorEstacion(catalogo: Catalogo, estado: EstadoPedido): DatosEnvio | null {
  const estacionDe = new Map(
    catalogo.categorias.flatMap((c) => c.productos.map((p) => [p.id, c.estacionId] as const)),
  )
  const porDefecto = catalogo.estaciones[0]?.id ?? null
  const grupos = new Map<string, string[]>()
  for (const item of porEnviar(estado)) {
    const estacion = estacionDe.get(item.productoId) ?? porDefecto
    if (!estacion) return null
    grupos.set(estacion, [...(grupos.get(estacion) ?? []), item.id])
  }
  if (grupos.size === 0) return null
  return {
    comandas: [...grupos].map(([estacion_id, item_ids]) => ({
      comanda_id: nuevoId(),
      estacion_id,
      item_ids,
    })),
  }
}
