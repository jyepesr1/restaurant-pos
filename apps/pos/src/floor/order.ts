import {
  itemDiscount,
  type NewEvent,
  newId,
  type OrderItem,
  type OrderState,
  priceWithExtras,
} from '@pos/core'
import type { Catalog } from '@pos/sync'
import { currentItems } from './projection'

// What is stored when taking an order, built from the catalog. The item carries a copy of the
// current name, price and tax (docs/MODELO_DATOS.md): if the menu changes afterwards, the order
// does not change.

export type CatalogProduct = Catalog['categories'][number]['products'][number]
export type CatalogGroup = CatalogProduct['groups'][number]
export type CatalogOption = CatalogGroup['options'][number]

type ItemData = Extract<NewEvent, { type: 'ItemAdded' }>['data']
type SendData = Extract<NewEvent, { type: 'ItemsSent' }>['data']

/** The group's options that are selected; an id that is not from the group does not count. */
const selectedOf = (g: CatalogGroup, selectedIds: Record<string, string[]>) =>
  g.options.filter((o) => selectedIds[g.id]?.includes(o.id))

/** Whether the product requires choosing something before adding it (size or a required group). */
export const asksForOptions = (p: CatalogProduct) => p.variants.length > 0 || p.groups.length > 0

/**
 * What is left to choose, in lowercase for "Elige …". The variant is required if the product
 * has any; each group asks for between its minimum and its maximum.
 */
export function missingSelection(
  p: CatalogProduct,
  variantId: string | null,
  selectedIds: Record<string, string[]>,
): string[] {
  return [
    ...(p.variants.length > 0 && !p.variants.some((v) => v.id === variantId) ? ['tamaño'] : []),
    ...p.groups
      .filter((g) => selectedOf(g, selectedIds).length < g.minimum)
      .map((g) => g.name.toLowerCase()),
  ]
}

export function itemData(
  catalog: Catalog,
  p: CatalogProduct,
  variantId: string | null,
  selectedIds: Record<string, string[]>,
  /** For whom, in which course, how many and the note for the kitchen. */
  extras: {
    quantity?: number
    guest?: number | null
    course?: Course | null
    notes?: string
  } = {},
): ItemData {
  const missing = missingSelection(p, variantId, selectedIds)
  if (missing.length > 0) throw new Error(`Falta elegir: ${missing.join(', ')}`)
  const variant = p.variants.find((v) => v.id === variantId) ?? null
  const modifiers = p.groups.flatMap((g) => {
    const groupSelected = selectedOf(g, selectedIds)
    // Trimming silently would charge differently from what the panel showed: better not to save.
    if (groupSelected.length > g.maximum)
      throw new Error(`En ${g.name.toLowerCase()} se eligen máximo ${g.maximum}`)
    return groupSelected.map((o) => ({
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
 * Price of one unit with what has been chosen so far (variant + extras), the same the saved
 * item will carry: the "Agregar" button shows it.
 */
export function selectedPrice(
  p: CatalogProduct,
  variantId: string | null,
  selectedIds: Record<string, string[]>,
): number {
  const base = p.variants.find((v) => v.id === variantId)?.price ?? p.price
  return priceWithExtras(
    base,
    p.groups.flatMap((g) => selectedOf(g, selectedIds).map((o) => o.extraPrice)),
  )
}

/** The data to add a removed item again, identical but with a new id. */
export function copyOf(item: OrderItem, catalogVersion: number): ItemData {
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
    catalog_version: catalogVersion,
    price_channel_id: null,
  }
}

/** Items still to be sent to the kitchen or bar. */
export const pendingSend = (status: OrderState) =>
  currentItems(status).filter((i) => i.status === 'pending')

/** Units to send (3 Aperol are 3, not 1 line): what «Enviar» and the notice say. */
export const unitsToSend = (status: OrderState) =>
  pendingSend(status).reduce((n, i) => n + i.quantity - i.voidedQuantity, 0)

/**
 * One ticket per station with what is left to send. The station is the one of the product's
 * category; if it has none, the restaurant's first one. Without stations there is nowhere to send.
 */
export function ticketsByStation(catalog: Catalog, status: OrderState): SendData | null {
  const stationOf = new Map(
    catalog.categories.flatMap((c) => c.products.map((p) => [p.id, c.stationId] as const)),
  )
  const defaultValue = catalog.stations[0]?.id ?? null
  const groups = new Map<string, string[]>()
  for (const item of pendingSend(status)) {
    const station = stationOf.get(item.productId) ?? defaultValue
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

export type Course = 'starter' | 'main' | 'dessert'
export const COURSES: { course: Course | null; name: string }[] = [
  { course: null, name: 'Sin curso' },
  { course: 'starter', name: 'Entrada' },
  { course: 'main', name: 'Fuerte' },
  { course: 'dessert', name: 'Postre' },
]

/**
 * An unsent line identical to what is about to be added: the same product again adds to that line
 * instead of opening another. Identical means same product, size, person, course, no note and with
 * **the same copied price** (price, tax and each option with its extra price): if the menu
 * changed between taps, it goes on another line with its price (docs/DINERO.md#precio-copiado).
 * It does not add to a line with a discount nor in a split order: the reducer would not allow it.
 */
export function matchingLine(status: OrderState | null, d: ItemData): OrderItem | null {
  if (!status || d.notes || status.checks) return null
  const options = (mods: { id: string; price: number }[]) =>
    mods
      .map((m) => `${m.id}:${m.price}`)
      .sort()
      .join()
  const wantedOptions = options(
    d.modifiers.map((m) => ({ id: m.modifier_id, price: m.extra_price })),
  )
  return (
    currentItems(status).find(
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
        options(i.modifiers.map((m) => ({ id: m.modifierId, price: m.extraPrice }))) ===
          wantedOptions,
    ) ?? null
  )
}

/** Tickets with only one course's items (when firing it), by station. */
export function courseTickets(
  catalog: Catalog,
  status: OrderState,
  course: Course,
): SendData | null {
  const courseOnly = {
    ...status,
    items: Object.fromEntries(Object.entries(status.items).filter(([, i]) => i.course === course)),
  }
  return ticketsByStation(catalog, courseOnly)
}

/** Orders without a table: takeout, delivery or bar. */
export const CHANNELS = {
  takeout: 'Para llevar',
  delivery: 'Domicilio',
  bar: 'Barra',
} as const

/** "la entrada", "el fuerte": for the notices. */
const COURSE_NAMES: Record<Course, string> = {
  starter: 'la entrada',
  main: 'el fuerte',
  dessert: 'el postre',
}
export const courseName = (c: Course) => COURSE_NAMES[c]

/**
 * Void and cancellation reasons (task 1.5, owner's decision). Another one can always be
 * written.
 */
export const VOID_REASONS = [
  'Error del mesero',
  'El cliente cambió',
  'Demora',
  'Producto dañado o mal hecho',
] as const

type MovedData = Extract<NewEvent, { type: 'ItemsMoved' }>['data']['items'][number]

/**
 * An item as it is moved to another order: the exact copy, its status, what was voided and who
 * added it (the reducer compares it with the real item, docs/MODELO_DATOS.md).
 */
export function movedFrom(i: OrderItem): MovedData {
  const { catalog_version: _v, price_channel_id: _c, ...copy } = copyOf(i, 0)
  return {
    item: { ...copy, item_id: i.id },
    status: i.status as MovedData['status'],
    voided_quantity: i.voidedQuantity,
    added_by: i.addedBy,
  }
}
