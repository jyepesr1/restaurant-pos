import { convertMenu, type MenuCategory, type MenuProduct } from '@pos/core'
import { parse } from 'yaml'
import textoCarta from '../../../../docs/datos/carta-la-spritzzeria.yaml?raw'

// Datos de los bocetos: la carta real de La Spritzzería (la misma conversión que el seed) y el
// salón provisional de 25 mesas. Los pedidos son de ejemplo y viven en memoria.
//
// Ojo: esto NO es el modelo de la Fase 1. Allí todo cambio es un evento con ULID (ADR-005), nada
// se borra y los pagos los registra el hub; aquí se simplifica para poder navegar.

export const menu: MenuCategory[] = convertMenu(parse(textoCarta))
export const products: MenuProduct[] = menu.flatMap((c) => c.products)
export const estacionDe = new Map(menu.flatMap((c) => c.products.map((p) => [p.key, c.station])))
/** Texto en que se busca un producto: su nombre y su categoría ("hamburgesa" → Spritz Burguer). */
export const textoDeBusqueda = new Map(
  menu.flatMap((c) => c.products.map((p) => [p.key, `${p.name} ${c.name}`])),
)

export const product = (name: string): MenuProduct => {
  const p = products.find((x) => x.name === name)
  if (!p) throw new Error(`La carta no tiene «${name}»`)
  return p
}

export type EstadoMesa =
  | 'free'
  | 'taking'
  | 'in_kitchen'
  | 'ready'
  | 'preBill'
  | 'reserved'
  | 'dirty'

export const MOTIVOS_ANULACION = [
  'Error del mesero',
  'El cliente cambió',
  'Demora',
  'Producto dañado',
] as const

export interface OrderItem {
  id: string
  product: MenuProduct
  variant: string | null
  /** Opciones elegidas (sabor, término), con su precio extra. */
  options: { name: string; extraPrice: number }[]
  unitPrice: number
  quantity: number
  guest: number | null
  notes: string
  /** Cuándo salió a cocina o barra (ms); null si aún no se envía. */
  enviadoEn: number | null
  /** Cocina o barra ya lo entregó. */
  despachado: boolean
  voided: { reason: string; alreadyPrepared: boolean } | null
}

export type Medio = 'cash' | 'card'

export interface PagoHecho {
  method: Medio
  /** La parte del saldo que cancela. */
  amount: number
  adjustment: number
  tip: number
  tendered: number | null
  change: number | null
}

export interface Mesa {
  number: number
  status: EstadoMesa
  /** Cuándo se abrió (ms). */
  abiertaEn: number | null
  guests: number
  waiter: string | null
  items: OrderItem[]
  payments: PagoHecho[]
}

let next = 0
export const nuevoItemId = () => {
  next += 1
  return `item-${next}`
}

const MINUTO = 60_000
const haceMinutos = (m: number) => Date.now() - m * MINUTO

export function item(
  name: string,
  fields: Partial<Omit<OrderItem, 'product'>> & { enviadoHace?: number } = {},
): OrderItem {
  const p = product(name)
  const { enviadoHace, ...rest } = fields
  const variant = rest.variant ?? p.variants[0]?.name ?? null
  const price = p.variants.find((v) => v.name === variant)?.price ?? p.price
  return {
    id: nuevoItemId(),
    product: p,
    variant,
    options: [],
    unitPrice: price,
    quantity: 1,
    guest: null,
    notes: '',
    enviadoEn: enviadoHace === undefined ? null : haceMinutos(enviadoHace),
    despachado: false,
    voided: null,
    ...rest,
  }
}

export const mesaLibre = (number: number): Mesa => ({
  number,
  status: 'free',
  abiertaEn: null,
  guests: 0,
  waiter: null,
  items: [],
  payments: [],
})

/** El salón de ejemplo: algunas mesas en cada estado, para ver cómo se distinguen. */
export function mesasIniciales(): Mesa[] {
  const tables = Array.from({ length: 25 }, (_, i) => mesaLibre(i + 1))
  const poner = (number: number, table: Partial<Mesa> & { abiertaHace?: number }) => {
    const { abiertaHace, ...rest } = table
    tables[number - 1] = {
      ...(tables[number - 1] as Mesa),
      ...(abiertaHace === undefined ? {} : { abiertaEn: haceMinutos(abiertaHace) }),
      ...rest,
    }
  }
  poner(2, {
    status: 'taking',
    abiertaHace: 3,
    guests: 2,
    waiter: 'Mesero 1',
    items: [item('Aperol Spritz', { quantity: 2 })],
  })
  poner(4, {
    status: 'in_kitchen',
    abiertaHace: 18,
    guests: 4,
    waiter: 'Mesero 2',
    items: [
      item('Quattro Formaggi', { enviadoHace: 12 }),
      item('Burrata Spritz', { enviadoHace: 12 }),
      item('Aperol Spritz', { quantity: 3, enviadoHace: 12 }),
      item('Ramón Bilbao Crianza', { variant: 'Botella', enviadoHace: 12 }),
    ],
  })
  poner(7, {
    status: 'in_kitchen',
    abiertaHace: 35,
    guests: 2,
    waiter: 'Mesero 1',
    items: [
      item('Spritz Burguer', {
        options: [{ name: 'Medio', extraPrice: 0 }],
        notes: 'Sin cebolla',
        enviadoHace: 27,
      }),
      item('Té Hatsu', { options: [{ name: 'Rojo', extraPrice: 0 }], enviadoHace: 27 }),
    ],
  })
  poner(9, {
    status: 'ready',
    abiertaHace: 22,
    guests: 2,
    waiter: 'Mesero 3',
    items: [
      item('Margarita Spritz', { quantity: 2, enviadoHace: 15, despachado: true }),
      item('Pinsa', { enviadoHace: 15, despachado: true }),
    ],
  })
  poner(12, {
    status: 'preBill',
    abiertaHace: 64,
    guests: 3,
    waiter: 'Mesero 3',
    items: [
      item('Quattro Formaggi', { guest: 1, enviadoHace: 50, despachado: true }),
      item('Tagliata di Manzo', {
        guest: 2,
        options: [{ name: 'Tres cuartos', extraPrice: 0 }],
        enviadoHace: 50,
        despachado: true,
      }),
      item('Patatine al Tartufo', { guest: 3, enviadoHace: 50, despachado: true }),
      item('Ramón Bilbao Crianza', { variant: 'Botella', enviadoHace: 50, despachado: true }),
      item('Té Hatsu', {
        guest: 3,
        options: [{ name: 'Amarillo', extraPrice: 0 }],
        enviadoHace: 50,
        despachado: true,
      }),
    ],
  })
  poner(15, { status: 'reserved' })
  poner(18, { status: 'dirty' })
  poner(21, {
    status: 'in_kitchen',
    abiertaHace: 9,
    guests: 5,
    waiter: 'Mesero 2',
    items: [
      item('Pinsa', { quantity: 2, enviadoHace: 6 }),
      item('Limonada de Coco', { quantity: 5, enviadoHace: 6 }),
    ],
  })
  return tables
}
