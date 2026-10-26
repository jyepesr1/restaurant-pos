import type { NewEvent } from '@pos/core'
import type { Row, SqliteDatabase } from '@pos/db'
import type { PriceChecker } from '@pos/sync'

// Review of the copied price (docs/DINERO.md#precio-copiado): the item carries the price, the
// extras and the tax the device saw in its catalog, with the `catalog_version`. The hub looks up
// in the history (`catalog_changes`) how each record was in that version and compares. A
// mismatch does not reject the item: it stays as a `price_mismatch` conflict for the register.

type ItemAdded = Extract<NewEvent, { type: 'ItemAdded' }>

const pesos = (n: number) => `$${n.toLocaleString('es-CO')}`

export class CatalogHistory {
  private readonly db: SqliteDatabase
  private readonly restaurantId: string

  constructor(db: SqliteDatabase, restaurantId: string) {
    this.db = db
    this.restaurantId = restaurantId
  }

  /**
   * How the record was in that catalog version, or `undefined` if it did not exist yet.
   *
   * The history started with migration 3 (`history_since`): from before, only the state each
   * record had at that moment is known. For an earlier version that state, the oldest known, is
   * used, instead of treating as nonexistent something that was on the menu.
   */
  stateIn(entity: string, recordId: string, version: number): Row | undefined {
    const row =
      this.db
        .prepare(
          `SELECT after FROM catalog_changes
           WHERE restaurant_id = ? AND entity = ? AND record_id = ? AND version <= ?
           ORDER BY version DESC LIMIT 1`,
        )
        .get(this.restaurantId, entity, recordId, version) ??
      (version < this.counter('history_since')
        ? this.db
            .prepare(
              `SELECT after FROM catalog_changes
               WHERE restaurant_id = ? AND entity = ? AND record_id = ? AND before IS NULL
               ORDER BY version LIMIT 1`,
            )
            .get(this.restaurantId, entity, recordId)
        : undefined)
    return row ? (JSON.parse(String(row.after)) as Row) : undefined
  }

  /** The active variants of a product in that version (a variant does not change product). */
  variantsAt(productId: string, version: number): Row[] {
    return this.db
      .prepare('SELECT id FROM variants WHERE restaurant_id = ? AND product_id = ?')
      .all(this.restaurantId, productId)
      .map((f) => this.stateIn('variants', String(f.id), version))
      .filter((v): v is Row => v?.active === 1)
  }

  /** Whether the group was active and linked to the product in that version. */
  private groupOfProduct(productId: string, groupId: string, version: number): boolean {
    if (this.stateIn('modifier_groups', groupId, version)?.active !== 1) return false
    return this.db
      .prepare(
        'SELECT id FROM product_modifier_groups WHERE restaurant_id = ? AND product_id = ? AND group_id = ?',
      )
      .all(this.restaurantId, productId, groupId)
      .some((e) => this.stateIn('product_modifier_groups', String(e.id), version)?.active === 1)
  }

  private counter(name: string): number {
    const row = this.db
      .prepare('SELECT value FROM counters WHERE restaurant_id = ? AND name = ?')
      .get(this.restaurantId, name)
    return Number(row?.value ?? 0)
  }

  currentVersion(): number {
    return this.counter('catalog')
  }

  /** What does not match between the item and the catalog in its version; `null` if all matches. */
  variance({ data: d }: ItemAdded): string | null {
    const v = d.catalog_version
    if (v > this.currentVersion())
      return `El equipo usó una versión del catálogo (${v}) que el hub no tiene`
    // Prices by channel and time slot (happy hour) come later: today none is valid.
    if (d.price_channel_id !== null) return `«${d.name}» trae un precio especial que no existe`
    const product = this.stateIn('products', d.product_id, v)
    if (product?.active !== 1) return `«${d.name}» no estaba en la carta en esa versión`

    const variants = this.variantsAt(d.product_id, v)
    let basePrice: number
    if (variants.length > 0) {
      const variant = variants.find((x) => x.id === d.variant_id)
      if (!variant) return `«${d.name}» se pidió sin elegir una de sus opciones (copa, botella…)`
      basePrice = Number(variant.price)
    } else {
      if (d.variant_id !== null) return `«${d.name}» trae una opción que el producto no tiene`
      basePrice = Number(product.price)
    }
    if (d.unit_price !== basePrice)
      return `«${d.name}» se cobró a ${pesos(d.unit_price)} y la carta decía ${pesos(basePrice)}`

    const tax = this.stateIn('taxes', String(product.tax_id), v)
    if (tax?.active !== 1 || tax.type !== d.tax_type || Number(tax.rate) !== d.rate)
      return `El impuesto de «${d.name}» no coincide con el de la carta`

    const seenSet = new Set<string>()
    for (const m of d.modifiers) {
      if (seenSet.has(m.modifier_id)) return `La opción «${m.name}» viene dos veces`
      seenSet.add(m.modifier_id)
      const modifier = this.stateIn('modifiers', m.modifier_id, v)
      if (modifier?.active !== 1)
        return `La opción «${m.name}» no estaba en la carta en esa versión`
      if (!this.groupOfProduct(d.product_id, String(modifier.group_id), v))
        return `La opción «${m.name}» no es de «${d.name}»`
      if (Number(modifier.extra_price) !== m.extra_price)
        return `La opción «${m.name}» se cobró a ${pesos(m.extra_price)} y la carta decía ${pesos(Number(modifier.extra_price))}`
    }
    return null
  }
}

export function priceChecker(db: SqliteDatabase, restaurantId: string): PriceChecker {
  const history = new CatalogHistory(db, restaurantId)
  return {
    review: (event) => (event.type === 'ItemAdded' ? history.variance(event) : null),
  }
}
