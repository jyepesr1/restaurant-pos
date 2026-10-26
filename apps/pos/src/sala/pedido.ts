import {
  itemDiscount,
  type NewEvent,
  newId,
  type OrderItem,
  type OrderState,
  priceWithExtras,
} from '@pos/core'
import type { Catalogo } from '@pos/sync'
import { itemsVigentes } from './proyeccion'

// Lo que se guarda al tomar un pedido, armado desde el catálogo. El ítem lleva copia del nombre,
// el precio y el impuesto vigentes (docs/MODELO_DATOS.md): si la carta cambia después, el pedido
// no cambia.

export type ProductoCatalogo = Catalogo['categories'][number]['products'][number]
export type GrupoCatalogo = ProductoCatalogo['groups'][number]
export type OpcionCatalogo = GrupoCatalogo['options'][number]

type DatosItem = Extract<NewEvent, { type: 'ItemAdded' }>['data']
type DatosEnvio = Extract<NewEvent, { type: 'ItemsSent' }>['data']

/** Las opciones del grupo que están elegidas; un id que no es del grupo no cuenta. */
const elegidasDe = (g: GrupoCatalogo, elegidas: Record<string, string[]>) =>
  g.options.filter((o) => elegidas[g.id]?.includes(o.id))

/** Si el producto pide elegir algo antes de agregarlo (tamaño o un grupo obligatorio). */
export const pideOpciones = (p: ProductoCatalogo) => p.variants.length > 0 || p.groups.length > 0

/**
 * Lo que falta elegir, en minúsculas para "Elige …". La variante es obligatoria si el producto
 * tiene; cada grupo pide entre su mínimo y su máximo.
 */
export function faltaElegir(
  p: ProductoCatalogo,
  variantId: string | null,
  elegidas: Record<string, string[]>,
): string[] {
  return [
    ...(p.variants.length > 0 && !p.variants.some((v) => v.id === variantId) ? ['tamaño'] : []),
    ...p.groups
      .filter((g) => elegidasDe(g, elegidas).length < g.minimum)
      .map((g) => g.name.toLowerCase()),
  ]
}

export function datosItem(
  catalog: Catalogo,
  p: ProductoCatalogo,
  variantId: string | null,
  elegidas: Record<string, string[]>,
  /** Para quién, en qué curso, cuántos y la nota para cocina. */
  extras: {
    quantity?: number
    guest?: number | null
    course?: Course | null
    notes?: string
  } = {},
): DatosItem {
  const missingOnes = faltaElegir(p, variantId, elegidas)
  if (missingOnes.length > 0) throw new Error(`Falta elegir: ${missingOnes.join(', ')}`)
  const variant = p.variants.find((v) => v.id === variantId) ?? null
  const modifiers = p.groups.flatMap((g) => {
    const elegidasGrupo = elegidasDe(g, elegidas)
    // Recortar en silencio cobraría distinto de lo que mostró el panel: mejor no guardar.
    if (elegidasGrupo.length > g.maximum)
      throw new Error(`En ${g.name.toLowerCase()} se eligen máximo ${g.maximum}`)
    return elegidasGrupo.map((o) => ({
      modifier_id: o.id,
      name: o.name,
      extra_price: o.extraPrice,
    }))
  })
  return {
    item_id: newId(),
    product_id: p.id,
    variant_id: variant?.id ?? null,
    name: variant ? `${p.name} · ${variant.name}` : p.name,
    unit_price: variant?.price ?? p.price,
    tax_type: p.tax.type,
    rate: p.tax.type === 'exempt' ? 0 : p.tax.rate,
    quantity: extras.quantity ?? 1,
    guest: extras.guest ?? null,
    course: extras.course ?? null,
    modifiers,
    notes: extras.notes?.trim() || null,
    catalog_version: catalog.version,
    price_channel_id: null,
  }
}

/**
 * Precio de una unidad con lo elegido hasta ahora (variante + extras), el mismo que llevará el
 * ítem guardado: lo muestra el botón "Agregar".
 */
export function precioElegido(
  p: ProductoCatalogo,
  variantId: string | null,
  elegidas: Record<string, string[]>,
): number {
  const base = p.variants.find((v) => v.id === variantId)?.price ?? p.price
  return priceWithExtras(
    base,
    p.groups.flatMap((g) => elegidasDe(g, elegidas).map((o) => o.extraPrice)),
  )
}

/** Los datos para volver a agregar un ítem quitado, igual pero con un id nuevo. */
export function copiaDe(item: OrderItem, catalogoVersion: number): DatosItem {
  return {
    item_id: newId(),
    product_id: item.productId,
    variant_id: item.variantId,
    name: item.name,
    unit_price: item.unitPrice,
    tax_type: item.taxType,
    rate: item.rate,
    quantity: item.quantity,
    guest: item.guest,
    course: item.course,
    modifiers: item.modifiers.map((m) => ({
      modifier_id: m.modifierId,
      name: m.name,
      extra_price: m.extraPrice,
    })),
    notes: item.notes,
    catalog_version: catalogoVersion,
    price_channel_id: null,
  }
}

/** Ítems que faltan por enviar a cocina o barra. */
export const porEnviar = (status: OrderState) =>
  itemsVigentes(status).filter((i) => i.status === 'pending')

/** Unidades por enviar (3 Aperol son 3, no 1 línea): lo que dice «Enviar» y el aviso. */
export const unidadesPorEnviar = (status: OrderState) =>
  porEnviar(status).reduce((n, i) => n + i.quantity - i.voidedQuantity, 0)

/**
 * Una comanda por estación con lo que falta enviar. La estación es la de la categoría del
 * producto; si no tiene, la primera del restaurante. Sin estaciones no hay a dónde enviar.
 */
export function comandasPorEstacion(catalog: Catalogo, status: OrderState): DatosEnvio | null {
  const estacionDe = new Map(
    catalog.categories.flatMap((c) => c.products.map((p) => [p.id, c.estacionId] as const)),
  )
  const porDefecto = catalog.stations[0]?.id ?? null
  const groups = new Map<string, string[]>()
  for (const item of porEnviar(status)) {
    const station = estacionDe.get(item.productId) ?? porDefecto
    if (!station) return null
    groups.set(station, [...(groups.get(station) ?? []), item.id])
  }
  if (groups.size === 0) return null
  return {
    tickets: [...groups].map(([station_id, item_ids]) => ({
      ticket_id: newId(),
      station_id,
      item_ids,
    })),
  }
}

export type Course = 'entry' | 'main' | 'dessert'
export const COURSES: { course: Course | null; name: string }[] = [
  { course: null, name: 'Sin curso' },
  { course: 'entry', name: 'Entrada' },
  { course: 'main', name: 'Fuerte' },
  { course: 'dessert', name: 'Postre' },
]

/**
 * Una línea sin enviar igual a lo que se va a agregar: el mismo producto otra vez suma a esa línea
 * en vez de abrir otra. Igual quiere decir mismo producto, tamaño, persona, curso, sin nota y con
 * **el mismo precio copiado** (precio, impuesto y cada opción con su precio extra): si la carta
 * cambió entre un toque y otro, va en otra línea con su precio (docs/DINERO.md#precio-copiado).
 * No se suma a una línea con descuento ni en un pedido dividido: el reductor no lo dejaría.
 */
export function lineaIgual(status: OrderState | null, d: DatosItem): OrderItem | null {
  if (!status || d.notes || status.checks) return null
  const options = (mods: { id: string; price: number }[]) =>
    mods
      .map((m) => `${m.id}:${m.price}`)
      .sort()
      .join()
  const buscadas = options(d.modifiers.map((m) => ({ id: m.modifier_id, price: m.extra_price })))
  return (
    itemsVigentes(status).find(
      (i) =>
        (i.status === 'pending' || i.status === 'held') &&
        i.voidedQuantity === 0 &&
        !i.notes &&
        i.productId === d.product_id &&
        i.variantId === d.variant_id &&
        i.guest === d.guest &&
        i.course === d.course &&
        i.unitPrice === d.unit_price &&
        i.taxType === d.tax_type &&
        i.rate === d.rate &&
        itemDiscount(status, i.id) === 0 &&
        options(i.modifiers.map((m) => ({ id: m.modifierId, price: m.extraPrice }))) === buscadas,
    ) ?? null
  )
}

/** Comandas solo con lo de un curso (al marcharlo), por estación. */
export function comandasDeCurso(
  catalog: Catalogo,
  status: OrderState,
  course: Course,
): DatosEnvio | null {
  const soloCurso = {
    ...status,
    items: Object.fromEntries(Object.entries(status.items).filter(([, i]) => i.course === course)),
  }
  return comandasPorEstacion(catalog, soloCurso)
}

/** Pedidos sin mesa: para llevar, domicilio o barra. */
export const CANALES = {
  takeout: 'Para llevar',
  delivery: 'Domicilio',
  bar: 'Barra',
} as const

/** "la entrada", "el fuerte": para los avisos. */
export const elCurso = (c: Course) => (c === 'entry' ? 'la entrada' : `el ${c}`)

/**
 * Motivos de anulación y de cancelación (tarea 1.5, decisión del dueño). Siempre se puede
 * escribir otro.
 */
export const MOTIVOS_ANULACION = [
  'Error del mesero',
  'El cliente cambió',
  'Demora',
  'Producto dañado o mal hecho',
] as const

type DatosMovido = Extract<NewEvent, { type: 'ItemsMoved' }>['data']['items'][number]

/**
 * Un ítem tal como se pasa a otro pedido: la copia exacta, su estado, lo anulado y quién lo
 * agregó (el reductor la compara con el ítem real, docs/MODELO_DATOS.md).
 */
export function movidoDe(i: OrderItem): DatosMovido {
  const { catalog_version: _v, price_channel_id: _c, ...copy } = copiaDe(i, 0)
  return {
    item: { ...copy, item_id: i.id },
    status: i.status as DatosMovido['status'],
    voided_quantity: i.voidedQuantity,
    added_by: i.addedBy,
  }
}
