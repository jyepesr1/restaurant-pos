import { newId } from '@pos/core'
import type { SqliteDatabase, SqlValue } from '../sqlite'

export const NOW = '2026-10-24T15:00:00.000Z'

function insert(db: SqliteDatabase, tableName: string, row: Record<string, SqlValue>): void {
  const columns = Object.keys(row)
  db.prepare(
    `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...Object.values(row))
}

/** Inserts a row with the common columns of a versioned record. */
export function insertVersioned(
  db: SqliteDatabase,
  tableName: string,
  restaurantId: string,
  fields: Record<string, SqlValue>,
  id = newId(),
): string {
  insert(db, tableName, {
    id,
    restaurant_id: restaurantId,
    created_at: NOW,
    updated_at: NOW,
    version: 1,
    ...fields,
  })
  return id
}

/** Restaurant with location, zone, tax, category and product: the minimum for almost everything. */
export function seed(db: SqliteDatabase) {
  const restaurant = newId()
  insertVersioned(db, 'restaurants', restaurant, { name: 'Prueba', config: '{}' }, restaurant)
  const location = insertVersioned(db, 'locations', restaurant, {
    name: 'Envigado',
    time_zone: 'America/Bogota',
  })
  const zone = insertVersioned(db, 'zones', restaurant, { location_id: location, name: 'Salón' })
  const tax = insertVersioned(db, 'taxes', restaurant, {
    name: 'INC 8 %',
    type: 'inc',
    rate: 800,
  })
  const category = insertVersioned(db, 'categories', restaurant, { name: 'Pizzas' })
  const product = insertVersioned(db, 'products', restaurant, {
    category_id: category,
    name: 'Margarita',
    price: 40900,
    tax_id: tax,
  })
  return { restaurant, location, zone, tax, category, product }
}

export function insertEvent(
  db: SqliteDatabase,
  restaurant: string,
  fields: Record<string, SqlValue> = {},
): Record<string, SqlValue> {
  const row: Record<string, SqlValue> = {
    restaurant_id: restaurant,
    id: newId(),
    type: 'OrderOpened',
    schema_version: 1,
    aggregate_type: 'order',
    aggregate_id: newId(),
    data: '{"channel":"dine_in"}',
    user_id: newId(),
    device_id: newId(),
    device_time: NOW,
    hub_estimated_time: NOW,
    base_sequence: 0,
    sequence: 1,
    received_at: NOW,
    business_day: '2026-10-24',
    content_hash: 'abc',
    ...fields,
  }
  insert(db, 'events', row)
  return row
}

export function insertOrder(
  db: SqliteDatabase,
  restaurant: string,
  fields: Record<string, SqlValue> = {},
): string {
  const id = newId()
  insert(db, 'orders', {
    id,
    restaurant_id: restaurant,
    channel: 'dine_in',
    status: 'open',
    opened_at: NOW,
    last_sequence: 1,
    ...fields,
  })
  return id
}

export function insertItem(
  db: SqliteDatabase,
  restaurant: string,
  order: string,
  fields: Record<string, SqlValue> = {},
): string {
  const id = newId()
  insert(db, 'order_items', {
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

export function insertConflict(
  db: SqliteDatabase,
  restaurant: string,
  fields: Record<string, SqlValue> = {},
): void {
  insert(db, 'conflicts', {
    id: newId(),
    restaurant_id: restaurant,
    type: 'duplicate_table',
    event_id: newId(),
    aggregate_id: newId(),
    description: 'Dos pedidos en la mesa 5',
    detected_at: NOW,
    ...fields,
  })
}

export function insertIntoTable(
  db: SqliteDatabase,
  tableName: string,
  row: Record<string, SqlValue>,
) {
  insert(db, tableName, row)
}
