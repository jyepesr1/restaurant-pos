import { newId } from '@pos/core'
import type { BaseSqlite, ValorSql } from '../sqlite'

export const AHORA = '2026-10-24T15:00:00.000Z'

function insertar(db: BaseSqlite, tabla: string, fila: Record<string, ValorSql>): void {
  const columnas = Object.keys(fila)
  db.prepare(
    `INSERT INTO ${tabla} (${columnas.join(', ')}) VALUES (${columnas.map(() => '?').join(', ')})`,
  ).run(...Object.values(fila))
}

/** Inserta una fila con las columnas comunes de un registro versionado. */
export function insertarVersionado(
  db: BaseSqlite,
  tabla: string,
  restauranteId: string,
  fields: Record<string, ValorSql>,
  id = newId(),
): string {
  insertar(db, tabla, {
    id,
    restaurant_id: restauranteId,
    created_at: AHORA,
    updated_at: AHORA,
    version: 1,
    ...fields,
  })
  return id
}

/** Restaurante con sede, zona, impuesto, categoría y producto: lo mínimo para casi todo. */
export function sembrar(db: BaseSqlite) {
  const restaurant = newId()
  insertarVersionado(db, 'restaurants', restaurant, { name: 'Prueba', config: '{}' }, restaurant)
  const location = insertarVersionado(db, 'locations', restaurant, {
    name: 'Envigado',
    time_zone: 'America/Bogota',
  })
  const zone = insertarVersionado(db, 'zones', restaurant, { location_id: location, name: 'Salón' })
  const tax = insertarVersionado(db, 'taxes', restaurant, {
    name: 'INC 8 %',
    type: 'inc',
    rate: 800,
  })
  const category = insertarVersionado(db, 'categories', restaurant, { name: 'Pizzas' })
  const product = insertarVersionado(db, 'products', restaurant, {
    category_id: category,
    name: 'Margarita',
    price: 40900,
    tax_id: tax,
  })
  return { restaurant, location, zone, tax, category, product }
}

export function insertarEvento(
  db: BaseSqlite,
  restaurant: string,
  fields: Record<string, ValorSql> = {},
): Record<string, ValorSql> {
  const fila: Record<string, ValorSql> = {
    restaurant_id: restaurant,
    id: newId(),
    type: 'OrderOpened',
    schema_version: 1,
    aggregate_type: 'order',
    aggregate_id: newId(),
    data: '{"channel":"salon"}',
    user_id: newId(),
    device_id: newId(),
    device_time: AHORA,
    hub_estimated_time: AHORA,
    base_sequence: 0,
    sequence: 1,
    received_at: AHORA,
    business_day: '2026-10-24',
    content_hash: 'abc',
    ...fields,
  }
  insertar(db, 'events', fila)
  return fila
}

export function insertarPedido(
  db: BaseSqlite,
  restaurant: string,
  fields: Record<string, ValorSql> = {},
): string {
  const id = newId()
  insertar(db, 'orders', {
    id,
    restaurant_id: restaurant,
    channel: 'dine_in',
    status: 'open',
    opened_at: AHORA,
    last_sequence: 1,
    ...fields,
  })
  return id
}

export function insertarItem(
  db: BaseSqlite,
  restaurant: string,
  order: string,
  fields: Record<string, ValorSql> = {},
): string {
  const id = newId()
  insertar(db, 'order_items', {
    id,
    restaurant_id: restaurant,
    order_id: order,
    position: 1,
    product_id: newId(),
    name: 'Pinsa',
    unit_price: 20900,
    tax_type: 'inc',
    rate: 800,
    quantity: 1,
    status: 'pending',
    added_by: newId(),
    ...fields,
  })
  return id
}

export function insertarConflicto(
  db: BaseSqlite,
  restaurant: string,
  fields: Record<string, ValorSql> = {},
): void {
  insertar(db, 'conflicts', {
    id: newId(),
    restaurant_id: restaurant,
    type: 'duplicate_table',
    event_id: newId(),
    aggregate_id: newId(),
    description: 'Dos pedidos en la mesa 5',
    detected_at: AHORA,
    ...fields,
  })
}

export function insertarEnTabla(db: BaseSqlite, tabla: string, fila: Record<string, ValorSql>) {
  insertar(db, tabla, fila)
}
