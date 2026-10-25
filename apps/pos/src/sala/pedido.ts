import {
  descuentoDeItem,
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
  /** Para quién, en qué curso, cuántos y la nota para cocina. */
  extras: {
    cantidad?: number
    comensal?: number | null
    curso?: Curso | null
    notas?: string
  } = {},
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
    cantidad: extras.cantidad ?? 1,
    comensal: extras.comensal ?? null,
    curso: extras.curso ?? null,
    modificadores,
    notas: extras.notas?.trim() || null,
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

export type Curso = 'entrada' | 'fuerte' | 'postre'
export const CURSOS: { curso: Curso | null; nombre: string }[] = [
  { curso: null, nombre: 'Sin curso' },
  { curso: 'entrada', nombre: 'Entrada' },
  { curso: 'fuerte', nombre: 'Fuerte' },
  { curso: 'postre', nombre: 'Postre' },
]

/**
 * Una línea sin enviar igual a lo que se va a agregar: el mismo producto otra vez suma a esa línea
 * en vez de abrir otra. Igual quiere decir mismo producto, tamaño, persona, curso, sin nota y con
 * **el mismo precio copiado** (precio, impuesto y cada opción con su precio extra): si la carta
 * cambió entre un toque y otro, va en otra línea con su precio (docs/DINERO.md#precio-copiado).
 * No se suma a una línea con descuento ni en un pedido dividido: el reductor no lo dejaría.
 */
export function lineaIgual(estado: EstadoPedido | null, d: DatosItem): ItemPedido | null {
  if (!estado || d.notas || estado.cuentas) return null
  const opciones = (mods: { id: string; precio: number }[]) =>
    mods
      .map((m) => `${m.id}:${m.precio}`)
      .sort()
      .join()
  const buscadas = opciones(
    d.modificadores.map((m) => ({ id: m.modificador_id, precio: m.precio_extra })),
  )
  return (
    itemsVigentes(estado).find(
      (i) =>
        (i.estado === 'pendiente' || i.estado === 'retenido') &&
        i.cantidadAnulada === 0 &&
        !i.notas &&
        i.productoId === d.producto_id &&
        i.varianteId === d.variante_id &&
        i.comensal === d.comensal &&
        i.curso === d.curso &&
        i.precioUnitario === d.precio_unitario &&
        i.impuestoTipo === d.impuesto_tipo &&
        i.tarifa === d.tarifa &&
        descuentoDeItem(estado, i.id) === 0 &&
        opciones(i.modificadores.map((m) => ({ id: m.modificadorId, precio: m.precioExtra }))) ===
          buscadas,
    ) ?? null
  )
}

/** Comandas solo con lo de un curso (al marcharlo), por estación. */
export function comandasDeCurso(
  catalogo: Catalogo,
  estado: EstadoPedido,
  curso: Curso,
): DatosEnvio | null {
  const soloCurso = {
    ...estado,
    items: Object.fromEntries(Object.entries(estado.items).filter(([, i]) => i.curso === curso)),
  }
  return comandasPorEstacion(catalogo, soloCurso)
}

/** Pedidos sin mesa: para llevar, domicilio o barra. */
export const CANALES = {
  para_llevar: 'Para llevar',
  domicilio: 'Domicilio',
  barra: 'Barra',
} as const

/** "la entrada", "el fuerte": para los avisos. */
export const elCurso = (c: Curso) => (c === 'entrada' ? 'la entrada' : `el ${c}`)
