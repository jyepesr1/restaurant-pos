import { convertMenu, type MenuCategory, type MenuProduct } from '@pos/core'
import { parse } from 'yaml'
import menuText from '../../../../docs/datos/carta-la-spritzzeria.yaml?raw'

// Mockup data: La Spritzzería's real menu (the same conversion as the seed) and the
// provisional dining room of 25 tables. The orders are examples and live in memory.
//
// Note: this is NOT the Phase 1 model. There every change is an event with a ULID (ADR-005),
// nothing is deleted and payments are recorded by the hub; here it is simplified to be navigable.

export const menu: MenuCategory[] = convertMenu(parse(menuText))
export const products: MenuProduct[] = menu.flatMap((c) => c.products)
export const stationOf = new Map(menu.flatMap((c) => c.products.map((p) => [p.key, c.station])))
/** Text a product is searched in: its name and its category ("hamburgesa" → Spritz Burguer). */
export const searchText = new Map(
  menu.flatMap((c) => c.products.map((p) => [p.key, `${p.name} ${c.name}`])),
)

export const product = (name: string): MenuProduct => {
  const p = products.find((x) => x.name === name)
  if (!p) throw new Error(`La carta no tiene «${name}»`)
  return p
}

export type TableStatus =
  | 'free'
  | 'taking'
  | 'in_kitchen'
  | 'ready'
  | 'preBill'
  | 'reserved'
  | 'dirty'

export const VOID_REASONS = [
  'Error del mesero',
  'El cliente cambió',
  'Demora',
  'Producto dañado',
] as const

export interface OrderItem {
  id: string
  product: MenuProduct
  variant: string | null
  /** Chosen options (flavor, doneness), with their extra price. */
  options: { name: string; extraPrice: number }[]
  unitPrice: number
  quantity: number
  guest: number | null
  notes: string
  /** When it went out to the kitchen or bar (ms); null if not sent yet. */
  sentAt: number | null
  /** The kitchen or bar already delivered it. */
  dispatched: boolean
  voided: { reason: string; alreadyPrepared: boolean } | null
}

export type Method = 'cash' | 'card'

export interface PaymentDone {
  method: Method
  /** The part of the balance it covers. */
  amount: number
  adjustment: number
  tip: number
  tendered: number | null
  change: number | null
}

export interface Table {
  number: number
  status: TableStatus
  /** When it was opened (ms). */
  openedAt: number | null
  guests: number
  waiter: string | null
  items: OrderItem[]
  payments: PaymentDone[]
}

let next = 0
export const newItemId = () => {
  next += 1
  return `item-${next}`
}

const MINUTE = 60_000
const minutesAgo = (m: number) => Date.now() - m * MINUTE

export function item(
  name: string,
  fields: Partial<Omit<OrderItem, 'product'>> & { sentAgo?: number } = {},
): OrderItem {
  const p = product(name)
  const { sentAgo, ...rest } = fields
  const variant = rest.variant ?? p.variants[0]?.name ?? null
  const price = p.variants.find((v) => v.name === variant)?.price ?? p.price
  return {
    id: newItemId(),
    product: p,
    variant,
    options: [],
    unitPrice: price,
    quantity: 1,
    guest: null,
    notes: '',
    sentAt: sentAgo === undefined ? null : minutesAgo(sentAgo),
    dispatched: false,
    voided: null,
    ...rest,
  }
}

export const freeTable = (number: number): Table => ({
  number,
  status: 'free',
  openedAt: null,
  guests: 0,
  waiter: null,
  items: [],
  payments: [],
})

/** The example dining room: some tables in each state, to see how they are told apart. */
export function initialTables(): Table[] {
  const tables = Array.from({ length: 25 }, (_, i) => freeTable(i + 1))
  const put = (number: number, table: Partial<Table> & { openedAgo?: number }) => {
    const { openedAgo, ...rest } = table
    tables[number - 1] = {
      ...(tables[number - 1] as Table),
      ...(openedAgo === undefined ? {} : { openedAt: minutesAgo(openedAgo) }),
      ...rest,
    }
  }
  put(2, {
    status: 'taking',
    openedAgo: 3,
    guests: 2,
    waiter: 'Mesero 1',
    items: [item('Aperol Spritz', { quantity: 2 })],
  })
  put(4, {
    status: 'in_kitchen',
    openedAgo: 18,
    guests: 4,
    waiter: 'Mesero 2',
    items: [
      item('Quattro Formaggi', { sentAgo: 12 }),
      item('Burrata Spritz', { sentAgo: 12 }),
      item('Aperol Spritz', { quantity: 3, sentAgo: 12 }),
      item('Ramón Bilbao Crianza', { variant: 'Botella', sentAgo: 12 }),
    ],
  })
  put(7, {
    status: 'in_kitchen',
    openedAgo: 35,
    guests: 2,
    waiter: 'Mesero 1',
    items: [
      item('Spritz Burguer', {
        options: [{ name: 'Medio', extraPrice: 0 }],
        notes: 'Sin cebolla',
        sentAgo: 27,
      }),
      item('Té Hatsu', { options: [{ name: 'Rojo', extraPrice: 0 }], sentAgo: 27 }),
    ],
  })
  put(9, {
    status: 'ready',
    openedAgo: 22,
    guests: 2,
    waiter: 'Mesero 3',
    items: [
      item('Margarita Spritz', { quantity: 2, sentAgo: 15, dispatched: true }),
      item('Pinsa', { sentAgo: 15, dispatched: true }),
    ],
  })
  put(12, {
    status: 'preBill',
    openedAgo: 64,
    guests: 3,
    waiter: 'Mesero 3',
    items: [
      item('Quattro Formaggi', { guest: 1, sentAgo: 50, dispatched: true }),
      item('Tagliata di Manzo', {
        guest: 2,
        options: [{ name: 'Tres cuartos', extraPrice: 0 }],
        sentAgo: 50,
        dispatched: true,
      }),
      item('Patatine al Tartufo', { guest: 3, sentAgo: 50, dispatched: true }),
      item('Ramón Bilbao Crianza', { variant: 'Botella', sentAgo: 50, dispatched: true }),
      item('Té Hatsu', {
        guest: 3,
        options: [{ name: 'Amarillo', extraPrice: 0 }],
        sentAgo: 50,
        dispatched: true,
      }),
    ],
  })
  put(15, { status: 'reserved' })
  put(18, { status: 'dirty' })
  put(21, {
    status: 'in_kitchen',
    openedAgo: 9,
    guests: 5,
    waiter: 'Mesero 2',
    items: [
      item('Pinsa', { quantity: 2, sentAgo: 6 }),
      item('Limonada de Coco', { quantity: 5, sentAgo: 6 }),
    ],
  })
  return tables
}
