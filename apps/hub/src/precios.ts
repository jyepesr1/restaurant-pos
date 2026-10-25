import type { EventoNuevo } from '@pos/core'
import type { BaseSqlite, Fila } from '@pos/db'
import type { RevisorPrecios } from '@pos/sync'

// Revisión del precio copiado (docs/DINERO.md#precio-copiado): el ítem trae el precio, los
// extras y el impuesto que vio el equipo en su catálogo, con la `catalogo_version`. El hub busca
// en el historial (`catalogo_cambio`) cómo estaba cada registro en esa versión y compara. Una
// diferencia no rechaza el ítem: queda como conflicto `precio_distinto` para la caja.

type ItemAgregado = Extract<EventoNuevo, { tipo: 'ItemAgregado' }>

const pesos = (n: number) => `$${n.toLocaleString('es-CO')}`

export class HistorialCatalogo {
  private readonly db: BaseSqlite
  private readonly restauranteId: string

  constructor(db: BaseSqlite, restauranteId: string) {
    this.db = db
    this.restauranteId = restauranteId
  }

  /**
   * Cómo estaba el registro en esa versión del catálogo, o `undefined` si aún no existía.
   *
   * El historial empezó con la migración 3 (`historial_desde`): de antes solo se sabe el estado
   * que tenía cada registro en ese momento. Para una versión anterior se usa ese estado, el más
   * viejo conocido, en vez de dar por inexistente algo que sí estaba en la carta.
   */
  estadoEn(entidad: string, registroId: string, version: number): Fila | undefined {
    const fila =
      this.db
        .prepare(
          `SELECT despues FROM catalogo_cambio
           WHERE restaurante_id = ? AND entidad = ? AND registro_id = ? AND version <= ?
           ORDER BY version DESC LIMIT 1`,
        )
        .get(this.restauranteId, entidad, registroId, version) ??
      (version < this.contador('historial_desde')
        ? this.db
            .prepare(
              `SELECT despues FROM catalogo_cambio
               WHERE restaurante_id = ? AND entidad = ? AND registro_id = ? AND antes IS NULL
               ORDER BY version LIMIT 1`,
            )
            .get(this.restauranteId, entidad, registroId)
        : undefined)
    return fila ? (JSON.parse(String(fila.despues)) as Fila) : undefined
  }

  /** Las variantes activas de un producto en esa versión (una variante no cambia de producto). */
  variantesEn(productoId: string, version: number): Fila[] {
    return this.db
      .prepare('SELECT id FROM variante WHERE restaurante_id = ? AND producto_id = ?')
      .all(this.restauranteId, productoId)
      .map((f) => this.estadoEn('variante', String(f.id), version))
      .filter((v): v is Fila => v?.activo === 1)
  }

  /** Si el grupo estaba activo y enlazado al producto en esa versión. */
  private grupoDelProducto(productoId: string, grupoId: string, version: number): boolean {
    if (this.estadoEn('grupo_modificador', grupoId, version)?.activo !== 1) return false
    return this.db
      .prepare(
        'SELECT id FROM producto_grupo_modificador WHERE restaurante_id = ? AND producto_id = ? AND grupo_id = ?',
      )
      .all(this.restauranteId, productoId, grupoId)
      .some((e) => this.estadoEn('producto_grupo_modificador', String(e.id), version)?.activo === 1)
  }

  private contador(nombre: string): number {
    const fila = this.db
      .prepare('SELECT valor FROM contador WHERE restaurante_id = ? AND nombre = ?')
      .get(this.restauranteId, nombre)
    return Number(fila?.valor ?? 0)
  }

  versionActual(): number {
    return this.contador('catalogo')
  }

  /** Qué no coincide entre el ítem y el catálogo en su versión; `null` si todo cuadra. */
  diferencia({ datos: d }: ItemAgregado): string | null {
    const v = d.catalogo_version
    if (v > this.versionActual())
      return `El equipo usó una versión del catálogo (${v}) que el hub no tiene`
    // Los precios por canal y franja (happy hour) llegan después: hoy ninguno es válido.
    if (d.precio_canal_id !== null) return `«${d.nombre}» trae un precio especial que no existe`
    const producto = this.estadoEn('producto', d.producto_id, v)
    if (producto?.activo !== 1) return `«${d.nombre}» no estaba en la carta en esa versión`

    const variantes = this.variantesEn(d.producto_id, v)
    let precioBase: number
    if (variantes.length > 0) {
      const variante = variantes.find((x) => x.id === d.variante_id)
      if (!variante) return `«${d.nombre}» se pidió sin elegir una de sus opciones (copa, botella…)`
      precioBase = Number(variante.precio)
    } else {
      if (d.variante_id !== null) return `«${d.nombre}» trae una opción que el producto no tiene`
      precioBase = Number(producto.precio)
    }
    if (d.precio_unitario !== precioBase)
      return `«${d.nombre}» se cobró a ${pesos(d.precio_unitario)} y la carta decía ${pesos(precioBase)}`

    const impuesto = this.estadoEn('impuesto', String(producto.impuesto_id), v)
    if (
      impuesto?.activo !== 1 ||
      impuesto.tipo !== d.impuesto_tipo ||
      Number(impuesto.tarifa) !== d.tarifa
    )
      return `El impuesto de «${d.nombre}» no coincide con el de la carta`

    const vistos = new Set<string>()
    for (const m of d.modificadores) {
      if (vistos.has(m.modificador_id)) return `La opción «${m.nombre}» viene dos veces`
      vistos.add(m.modificador_id)
      const modificador = this.estadoEn('modificador', m.modificador_id, v)
      if (modificador?.activo !== 1)
        return `La opción «${m.nombre}» no estaba en la carta en esa versión`
      if (!this.grupoDelProducto(d.producto_id, String(modificador.grupo_id), v))
        return `La opción «${m.nombre}» no es de «${d.nombre}»`
      if (Number(modificador.precio_extra) !== m.precio_extra)
        return `La opción «${m.nombre}» se cobró a ${pesos(m.precio_extra)} y la carta decía ${pesos(Number(modificador.precio_extra))}`
    }
    return null
  }
}

export function revisorPrecios(db: BaseSqlite, restauranteId: string): RevisorPrecios {
  const historial = new HistorialCatalogo(db, restauranteId)
  return {
    revisar: (evento) => (evento.tipo === 'ItemAgregado' ? historial.diferencia(evento) : null),
  }
}
