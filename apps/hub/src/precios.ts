import type { NewEvent } from '@pos/core'
import type { BaseSqlite, Fila } from '@pos/db'
import type { RevisorPrecios } from '@pos/sync'

// Revisión del precio copiado (docs/DINERO.md#precio-copiado): el ítem trae el precio, los
// extras y el impuesto que vio el equipo en su catálogo, con la `catalog_version`. El hub busca
// en el historial (`catalog_changes`) cómo estaba cada registro en esa versión y compara. Una
// diferencia no rechaza el ítem: queda como conflicto `precio_distinto` para la caja.

type ItemAdded = Extract<NewEvent, { type: 'ItemAdded' }>

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
  estadoEn(entity: string, registroId: string, version: number): Fila | undefined {
    const fila =
      this.db
        .prepare(
          `SELECT after FROM catalog_changes
           WHERE restaurant_id = ? AND entity = ? AND record_id = ? AND version <= ?
           ORDER BY version DESC LIMIT 1`,
        )
        .get(this.restauranteId, entity, registroId, version) ??
      (version < this.counter('history_since')
        ? this.db
            .prepare(
              `SELECT after FROM catalog_changes
               WHERE restaurant_id = ? AND entity = ? AND record_id = ? AND before IS NULL
               ORDER BY version LIMIT 1`,
            )
            .get(this.restauranteId, entity, registroId)
        : undefined)
    return fila ? (JSON.parse(String(fila.after)) as Fila) : undefined
  }

  /** Las variantes activas de un producto en esa versión (una variante no cambia de producto). */
  variantesEn(productId: string, version: number): Fila[] {
    return this.db
      .prepare('SELECT id FROM variants WHERE restaurant_id = ? AND product_id = ?')
      .all(this.restauranteId, productId)
      .map((f) => this.estadoEn('variants', String(f.id), version))
      .filter((v): v is Fila => v?.active === 1)
  }

  /** Si el grupo estaba activo y enlazado al producto en esa versión. */
  private grupoDelProducto(productId: string, grupoId: string, version: number): boolean {
    if (this.estadoEn('modifier_groups', grupoId, version)?.active !== 1) return false
    return this.db
      .prepare(
        'SELECT id FROM product_modifier_groups WHERE restaurant_id = ? AND product_id = ? AND group_id = ?',
      )
      .all(this.restauranteId, productId, grupoId)
      .some((e) => this.estadoEn('product_modifier_groups', String(e.id), version)?.active === 1)
  }

  private counter(name: string): number {
    const fila = this.db
      .prepare('SELECT value FROM counters WHERE restaurant_id = ? AND name = ?')
      .get(this.restauranteId, name)
    return Number(fila?.value ?? 0)
  }

  versionActual(): number {
    return this.counter('catalog')
  }

  /** Qué no coincide entre el ítem y el catálogo en su versión; `null` si todo cuadra. */
  variance({ data: d }: ItemAdded): string | null {
    const v = d.catalog_version
    if (v > this.versionActual())
      return `El equipo usó una versión del catálogo (${v}) que el hub no tiene`
    // Los precios por canal y franja (happy hour) llegan después: hoy ninguno es válido.
    if (d.price_channel_id !== null) return `«${d.name}» trae un precio especial que no existe`
    const product = this.estadoEn('products', d.product_id, v)
    if (product?.active !== 1) return `«${d.name}» no estaba en la carta en esa versión`

    const variants = this.variantesEn(d.product_id, v)
    let precioBase: number
    if (variants.length > 0) {
      const variant = variants.find((x) => x.id === d.variant_id)
      if (!variant) return `«${d.name}» se pidió sin elegir una de sus opciones (copa, botella…)`
      precioBase = Number(variant.price)
    } else {
      if (d.variant_id !== null) return `«${d.name}» trae una opción que el producto no tiene`
      precioBase = Number(product.price)
    }
    if (d.unit_price !== precioBase)
      return `«${d.name}» se cobró a ${pesos(d.unit_price)} y la carta decía ${pesos(precioBase)}`

    const tax = this.estadoEn('taxes', String(product.tax_id), v)
    if (tax?.active !== 1 || tax.type !== d.tax_type || Number(tax.rate) !== d.rate)
      return `El impuesto de «${d.name}» no coincide con el de la carta`

    const seenSet = new Set<string>()
    for (const m of d.modifiers) {
      if (seenSet.has(m.modifier_id)) return `La opción «${m.name}» viene dos veces`
      seenSet.add(m.modifier_id)
      const modifier = this.estadoEn('modifiers', m.modifier_id, v)
      if (modifier?.active !== 1)
        return `La opción «${m.name}» no estaba en la carta en esa versión`
      if (!this.grupoDelProducto(d.product_id, String(modifier.group_id), v))
        return `La opción «${m.name}» no es de «${d.name}»`
      if (Number(modifier.extra_price) !== m.extra_price)
        return `La opción «${m.name}» se cobró a ${pesos(m.extra_price)} y la carta decía ${pesos(Number(modifier.extra_price))}`
    }
    return null
  }
}

export function revisorPrecios(db: BaseSqlite, restauranteId: string): RevisorPrecios {
  const historial = new HistorialCatalogo(db, restauranteId)
  return {
    revisar: (event) => (event.type === 'ItemAdded' ? historial.variance(event) : null),
  }
}
