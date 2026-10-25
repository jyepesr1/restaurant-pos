import { LIMITE_PRECIO, nuevoId } from '@pos/core'
import type { CambioCatalogo, CatalogoEdicion } from './motor'

// El editor de la carta trabaja sobre un borrador de cada producto o grupo de opciones; al
// guardar, el borrador se compara con lo que había y salen solo los cambios (un registro nuevo
// lleva todos sus campos). Nada se borra: quitar una variante o una opción la archiva.

/**
 * "40.900", "$ 40900" o "40 900" → 40900. `null` si no es un monto en pesos enteros válido. El
 * punto solo vale como separador de miles en su lugar: "1.5" o "40.90" son errores (no 15 ni
 * 4.090), y la coma nunca vale (no hay centavos).
 */
export function leerPesos(texto: string): number | null {
  const limpio = texto.trim().replace(/^\$\s*/, '')
  if (!/^\d+$/.test(limpio) && !/^\d{1,3}([. ]\d{3})+$/.test(limpio)) return null
  const digitos = limpio.replace(/[. ]/g, '')
  if (digitos.length > 9) return null
  const valor = Number(digitos)
  return valor <= LIMITE_PRECIO ? valor : null
}

export interface BorradorVariante {
  id: string
  nuevo: boolean
  nombre: string
  precio: number
  activo: boolean
}

export interface BorradorProducto {
  id: string
  nuevo: boolean
  nombre: string
  descripcion: string
  categoriaId: string
  /** El precio si no tiene variantes; con variantes, el del producto es el de la más barata. */
  precio: number
  impuestoId: string
  /** Sale en "Favoritos" al tomar el pedido. */
  favorito: boolean
  activo: boolean
  variantes: BorradorVariante[]
  /** Grupos de opciones, en el orden en que se muestran. */
  grupos: string[]
}

export function borradorDeProducto(c: CatalogoEdicion, id: string): BorradorProducto {
  const p = c.productos.find((x) => x.id === id)
  if (!p) throw new Error('Ese producto no existe')
  return {
    id,
    nuevo: false,
    nombre: p.nombre,
    descripcion: p.descripcion ?? '',
    categoriaId: p.categoria_id,
    precio: p.precio,
    impuestoId: p.impuesto_id,
    favorito: p.favorito,
    activo: p.activo,
    variantes: c.variantes
      .filter((v) => v.producto_id === id && v.activo)
      .sort((a, b) => a.orden - b.orden)
      .map((v) => ({ id: v.id, nuevo: false, nombre: v.nombre, precio: v.precio, activo: true })),
    grupos: c.enlaces
      .filter((e) => e.producto_id === id && e.activo)
      .sort((a, b) => a.orden - b.orden)
      .map((e) => e.grupo_id),
  }
}

export function productoNuevo(c: CatalogoEdicion, categoriaId: string): BorradorProducto {
  return {
    id: nuevoId(),
    nuevo: true,
    nombre: '',
    descripcion: '',
    categoriaId,
    precio: 0,
    impuestoId: c.impuestos.find((i) => i.activo)?.id ?? '',
    favorito: false,
    activo: true,
    variantes: [],
    grupos: [],
  }
}

/** Qué le falta al borrador para poder guardarlo, en palabras para la persona. */
export function problemasDeProducto(b: BorradorProducto): string[] {
  const problemas: string[] = []
  if (!b.nombre.trim()) problemas.push('Falta el nombre')
  if (b.nuevo && b.precio === 0 && !b.variantes.some((v) => v.activo))
    problemas.push('Escribe el precio')
  if (!b.categoriaId) problemas.push('Falta la categoría')
  if (!b.impuestoId) problemas.push('Falta el impuesto')
  const variantes = b.variantes.filter((v) => v.activo)
  if (variantes.some((v) => !v.nombre.trim())) problemas.push('Cada tamaño lleva nombre')
  if (new Set(variantes.map((v) => v.nombre.trim().toLowerCase())).size !== variantes.length)
    problemas.push('Hay dos tamaños con el mismo nombre')
  if (new Set(b.grupos).size !== b.grupos.length)
    problemas.push('Un grupo de opciones está dos veces')
  return problemas
}

/** Los campos de `despues` que cambian respecto a `antes` (todos si no había `antes`). */
export function diferencias<T extends Record<string, unknown>>(
  antes: object | undefined,
  despues: T,
): Partial<T> {
  if (!antes) return despues
  const previo = antes as Record<string, unknown>
  return Object.fromEntries(
    Object.entries(despues).filter(([k, v]) => previo[k] !== v),
  ) as Partial<T>
}

export function agregar(
  cambios: CambioCatalogo[],
  entidad: CambioCatalogo['entidad'],
  id: string,
  datos: CambioCatalogo['datos'],
) {
  if (Object.keys(datos).length > 0) cambios.push({ entidad, id, datos })
}

/**
 * El `orden` de cada elemento activo, en el orden de la lista. Se conserva el que ya tenían
 * mientras sigan en orden creciente (lo archivado deja huecos que no importan) y lo nuevo va
 * después del anterior: abrir y guardar sin tocar nada no cambia nada. Si así no se puede
 * (alguien reordenó), se numera de nuevo desde 0.
 */
export function ordenes(previos: readonly (number | undefined)[]): number[] {
  const resultado: number[] = []
  let ultimo = -1
  for (const [i, previo] of previos.entries()) {
    if (previo !== undefined && previo > ultimo) {
      resultado.push(previo)
      ultimo = previo
      continue
    }
    if (previo === undefined) {
      const siguiente = previos.slice(i + 1).find((x) => x !== undefined)
      if (siguiente === undefined || ultimo + 1 < siguiente) {
        ultimo += 1
        resultado.push(ultimo)
        continue
      }
    }
    return previos.map((_, j) => j)
  }
  return resultado
}

/**
 * Enlaces de un producto con sus grupos (o de un grupo con sus productos): reusa el enlace que
 * ya existía (la base exige uno solo por par), lo reactiva o lo archiva.
 */
function cambiosDeEnlaces(
  c: CatalogoEdicion,
  productoId: string,
  grupos: string[],
  cambios: CambioCatalogo[],
) {
  const deProducto = c.enlaces.filter((e) => e.producto_id === productoId)
  const lugar = ordenes(
    grupos.map((g) => deProducto.find((e) => e.grupo_id === g && e.activo)?.orden),
  )
  grupos.forEach((grupoId, i) => {
    const orden = lugar[i] as number
    const e = deProducto.find((x) => x.grupo_id === grupoId)
    if (!e)
      agregar(cambios, 'producto_grupo_modificador', nuevoId(), {
        producto_id: productoId,
        grupo_id: grupoId,
        orden,
        activo: true,
      })
    else
      agregar(cambios, 'producto_grupo_modificador', e.id, diferencias(e, { orden, activo: true }))
  })
  for (const e of deProducto)
    if (e.activo && !grupos.includes(e.grupo_id))
      agregar(cambios, 'producto_grupo_modificador', e.id, { activo: false })
}

/** Los cambios para dejar el producto como el borrador. */
export function cambiosDeProducto(c: CatalogoEdicion, b: BorradorProducto): CambioCatalogo[] {
  const cambios: CambioCatalogo[] = []
  const variantes = b.variantes.filter((v) => v.activo)
  const original = b.nuevo ? undefined : c.productos.find((p) => p.id === b.id)
  agregar(
    cambios,
    'producto',
    b.id,
    diferencias(original, {
      categoria_id: b.categoriaId,
      nombre: b.nombre.trim(),
      descripcion: b.descripcion.trim() || null,
      // Con variantes, el precio del producto solo sirve para mostrar "desde" (DINERO.md).
      precio: variantes.length > 0 ? Math.min(...variantes.map((v) => v.precio)) : b.precio,
      impuesto_id: b.impuestoId,
      favorito: b.favorito,
      activo: b.activo,
    }),
  )
  // Archivar el producto no toca sus tamaños ni sus grupos: el hub rechaza lo activo que
  // apunta a algo archivado, y al volver a ponerlo en la carta vuelven como estaban.
  if (!b.activo && !b.nuevo) return cambios
  const lugar = new Map(
    ordenes(variantes.map((v) => c.variantes.find((x) => x.id === v.id)?.orden)).map((o, i) => [
      variantes[i]?.id,
      o,
    ]),
  )
  for (const v of b.variantes) {
    if (v.nuevo && !v.activo) continue
    const antes = v.nuevo ? undefined : c.variantes.find((x) => x.id === v.id)
    agregar(
      cambios,
      'variante',
      v.id,
      diferencias(antes, {
        producto_id: b.id,
        nombre: v.nombre.trim(),
        precio: v.precio,
        orden: v.activo ? (lugar.get(v.id) ?? 0) : (antes?.orden ?? 0),
        activo: v.activo,
      }),
    )
  }
  cambiosDeEnlaces(c, b.id, b.grupos, cambios)
  return cambios
}

export interface BorradorOpcion {
  id: string
  nuevo: boolean
  nombre: string
  precioExtra: number
  activo: boolean
}

export interface BorradorGrupo {
  id: string
  nuevo: boolean
  nombre: string
  minimo: number
  maximo: number
  activo: boolean
  opciones: BorradorOpcion[]
}

export function borradorDeGrupo(c: CatalogoEdicion, id: string): BorradorGrupo {
  const g = c.grupos.find((x) => x.id === id)
  if (!g) throw new Error('Ese grupo no existe')
  return {
    id,
    nuevo: false,
    nombre: g.nombre,
    minimo: g.minimo,
    maximo: g.maximo,
    activo: g.activo,
    opciones: c.modificadores
      .filter((m) => m.grupo_id === id && m.activo)
      .sort((a, b) => a.orden - b.orden)
      .map((m) => ({
        id: m.id,
        nuevo: false,
        nombre: m.nombre,
        precioExtra: m.precio_extra,
        activo: true,
      })),
  }
}

export const grupoNuevo = (): BorradorGrupo => ({
  id: nuevoId(),
  nuevo: true,
  nombre: '',
  minimo: 0,
  maximo: 1,
  activo: true,
  opciones: [],
})

export function problemasDeGrupo(g: BorradorGrupo): string[] {
  const problemas: string[] = []
  const opciones = g.opciones.filter((o) => o.activo)
  if (!g.nombre.trim()) problemas.push('Falta el nombre')
  if (opciones.length === 0) problemas.push('Agrega al menos una opción')
  if (opciones.some((o) => !o.nombre.trim())) problemas.push('Cada opción lleva nombre')
  if (g.maximo < 1) problemas.push('Se debe poder elegir al menos una')
  if (g.minimo > g.maximo) problemas.push('El mínimo no puede pasar del máximo')
  if (g.minimo > opciones.length && opciones.length > 0)
    problemas.push(`El mínimo (${g.minimo}) es mayor que las opciones que hay (${opciones.length})`)
  return problemas
}

export function cambiosDeGrupo(c: CatalogoEdicion, g: BorradorGrupo): CambioCatalogo[] {
  const cambios: CambioCatalogo[] = []
  const original = g.nuevo ? undefined : c.grupos.find((x) => x.id === g.id)
  agregar(
    cambios,
    'grupo_modificador',
    g.id,
    diferencias(original, {
      nombre: g.nombre.trim(),
      minimo: g.minimo,
      maximo: g.maximo,
      activo: g.activo,
    }),
  )
  // Como con el producto: archivar el grupo no toca sus opciones.
  if (!g.activo && !g.nuevo) return cambios
  const activas = g.opciones.filter((o) => o.activo)
  const lugar = new Map(
    ordenes(activas.map((o) => c.modificadores.find((x) => x.id === o.id)?.orden)).map(
      (orden, i) => [activas[i]?.id, orden],
    ),
  )
  for (const o of g.opciones) {
    if (o.nuevo && !o.activo) continue
    const antes = o.nuevo ? undefined : c.modificadores.find((x) => x.id === o.id)
    agregar(
      cambios,
      'modificador',
      o.id,
      diferencias(antes, {
        grupo_id: g.id,
        nombre: o.nombre.trim(),
        precio_extra: o.precioExtra,
        orden: o.activo ? (lugar.get(o.id) ?? 0) : (antes?.orden ?? 0),
        activo: o.activo,
      }),
    )
  }
  return cambios
}

/** Los productos activos que usan el grupo: para avisar antes de cambiarlo o archivarlo. */
export const productosDeGrupo = (c: CatalogoEdicion, grupoId: string) =>
  c.productos.filter(
    (p) =>
      p.activo &&
      c.enlaces.some((e) => e.grupo_id === grupoId && e.activo && e.producto_id === p.id),
  )

export const productosConGrupo = (c: CatalogoEdicion, grupoId: string) =>
  productosDeGrupo(c, grupoId).length
