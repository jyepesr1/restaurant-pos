import { type CategoriaCarta, convertirCarta, type ProductoCarta } from '@pos/core'
import { parse } from 'yaml'
import textoCarta from '../../../../docs/datos/carta-la-spritzzeria.yaml?raw'

// Datos de los bocetos: la carta real de La Spritzzería (la misma conversión que el seed) y el
// salón provisional de 25 mesas. Los pedidos son de ejemplo y viven en memoria.
//
// Ojo: esto NO es el modelo de la Fase 1. Allí todo cambio es un evento con ULID (ADR-005), nada
// se borra y los pagos los registra el hub; aquí se simplifica para poder navegar.

export const carta: CategoriaCarta[] = convertirCarta(parse(textoCarta))
export const productos: ProductoCarta[] = carta.flatMap((c) => c.productos)
export const estacionDe = new Map(
  carta.flatMap((c) => c.productos.map((p) => [p.clave, c.estacion])),
)
/** Texto en que se busca un producto: su nombre y su categoría ("hamburgesa" → Spritz Burguer). */
export const textoDeBusqueda = new Map(
  carta.flatMap((c) => c.productos.map((p) => [p.clave, `${p.nombre} ${c.nombre}`])),
)

export const producto = (nombre: string): ProductoCarta => {
  const p = productos.find((x) => x.nombre === nombre)
  if (!p) throw new Error(`La carta no tiene «${nombre}»`)
  return p
}

export type EstadoMesa =
  | 'libre'
  | 'tomando'
  | 'en_cocina'
  | 'listo'
  | 'precuenta'
  | 'reservada'
  | 'sucia'

export const MOTIVOS_ANULACION = [
  'Error del mesero',
  'El cliente cambió',
  'Demora',
  'Producto dañado',
] as const

export interface ItemPedido {
  id: string
  producto: ProductoCarta
  variante: string | null
  /** Opciones elegidas (sabor, término), con su precio extra. */
  opciones: { nombre: string; precioExtra: number }[]
  precioUnitario: number
  cantidad: number
  comensal: number | null
  notas: string
  /** Cuándo salió a cocina o barra (ms); null si aún no se envía. */
  enviadoEn: number | null
  /** Cocina o barra ya lo entregó. */
  despachado: boolean
  anulado: { motivo: string; yaPreparado: boolean } | null
}

export type Medio = 'efectivo' | 'tarjeta'

export interface PagoHecho {
  medio: Medio
  /** La parte del saldo que cancela. */
  monto: number
  ajuste: number
  propina: number
  recibido: number | null
  cambio: number | null
}

export interface Mesa {
  numero: number
  estado: EstadoMesa
  /** Cuándo se abrió (ms). */
  abiertaEn: number | null
  comensales: number
  mesero: string | null
  items: ItemPedido[]
  pagos: PagoHecho[]
}

let siguiente = 0
export const nuevoItemId = () => {
  siguiente += 1
  return `item-${siguiente}`
}

const MINUTO = 60_000
const haceMinutos = (m: number) => Date.now() - m * MINUTO

export function item(
  nombre: string,
  campos: Partial<Omit<ItemPedido, 'producto'>> & { enviadoHace?: number } = {},
): ItemPedido {
  const p = producto(nombre)
  const { enviadoHace, ...resto } = campos
  const variante = resto.variante ?? p.variantes[0]?.nombre ?? null
  const precio = p.variantes.find((v) => v.nombre === variante)?.precio ?? p.precio
  return {
    id: nuevoItemId(),
    producto: p,
    variante,
    opciones: [],
    precioUnitario: precio,
    cantidad: 1,
    comensal: null,
    notas: '',
    enviadoEn: enviadoHace === undefined ? null : haceMinutos(enviadoHace),
    despachado: false,
    anulado: null,
    ...resto,
  }
}

export const mesaLibre = (numero: number): Mesa => ({
  numero,
  estado: 'libre',
  abiertaEn: null,
  comensales: 0,
  mesero: null,
  items: [],
  pagos: [],
})

/** El salón de ejemplo: algunas mesas en cada estado, para ver cómo se distinguen. */
export function mesasIniciales(): Mesa[] {
  const mesas = Array.from({ length: 25 }, (_, i) => mesaLibre(i + 1))
  const poner = (numero: number, mesa: Partial<Mesa> & { abiertaHace?: number }) => {
    const { abiertaHace, ...resto } = mesa
    mesas[numero - 1] = {
      ...(mesas[numero - 1] as Mesa),
      ...(abiertaHace === undefined ? {} : { abiertaEn: haceMinutos(abiertaHace) }),
      ...resto,
    }
  }
  poner(2, {
    estado: 'tomando',
    abiertaHace: 3,
    comensales: 2,
    mesero: 'Mesero 1',
    items: [item('Aperol Spritz', { cantidad: 2 })],
  })
  poner(4, {
    estado: 'en_cocina',
    abiertaHace: 18,
    comensales: 4,
    mesero: 'Mesero 2',
    items: [
      item('Quattro Formaggi', { enviadoHace: 12 }),
      item('Burrata Spritz', { enviadoHace: 12 }),
      item('Aperol Spritz', { cantidad: 3, enviadoHace: 12 }),
      item('Ramón Bilbao Crianza', { variante: 'Botella', enviadoHace: 12 }),
    ],
  })
  poner(7, {
    estado: 'en_cocina',
    abiertaHace: 35,
    comensales: 2,
    mesero: 'Mesero 1',
    items: [
      item('Spritz Burguer', {
        opciones: [{ nombre: 'Medio', precioExtra: 0 }],
        notas: 'Sin cebolla',
        enviadoHace: 27,
      }),
      item('Té Hatsu', { opciones: [{ nombre: 'Rojo', precioExtra: 0 }], enviadoHace: 27 }),
    ],
  })
  poner(9, {
    estado: 'listo',
    abiertaHace: 22,
    comensales: 2,
    mesero: 'Mesero 3',
    items: [
      item('Margarita Spritz', { cantidad: 2, enviadoHace: 15, despachado: true }),
      item('Pinsa', { enviadoHace: 15, despachado: true }),
    ],
  })
  poner(12, {
    estado: 'precuenta',
    abiertaHace: 64,
    comensales: 3,
    mesero: 'Mesero 3',
    items: [
      item('Quattro Formaggi', { comensal: 1, enviadoHace: 50, despachado: true }),
      item('Tagliata di Manzo', {
        comensal: 2,
        opciones: [{ nombre: 'Tres cuartos', precioExtra: 0 }],
        enviadoHace: 50,
        despachado: true,
      }),
      item('Patatine al Tartufo', { comensal: 3, enviadoHace: 50, despachado: true }),
      item('Ramón Bilbao Crianza', { variante: 'Botella', enviadoHace: 50, despachado: true }),
      item('Té Hatsu', {
        comensal: 3,
        opciones: [{ nombre: 'Amarillo', precioExtra: 0 }],
        enviadoHace: 50,
        despachado: true,
      }),
    ],
  })
  poner(15, { estado: 'reservada' })
  poner(18, { estado: 'sucia' })
  poner(21, {
    estado: 'en_cocina',
    abiertaHace: 9,
    comensales: 5,
    mesero: 'Mesero 2',
    items: [
      item('Pinsa', { cantidad: 2, enviadoHace: 6 }),
      item('Limonada de Coco', { cantidad: 5, enviadoHace: 6 }),
    ],
  })
  return mesas
}
