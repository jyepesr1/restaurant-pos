import { newId } from '@pos/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from './migrate'
import { openDatabase } from './node'
import type { SqliteDatabase } from './sqlite'
import {
  insertConflict,
  insertEvent,
  insertIntoTable,
  insertItem,
  insertOrder,
  insertVersioned,
  NOW,
  seed,
} from './testing/utils'

describe('schema constraints', () => {
  let db: SqliteDatabase
  let base: ReturnType<typeof seed>

  beforeEach(() => {
    db = openDatabase(':memory:')
    applyMigrations(db)
    base = seed(db)
  })

  const table = (fields: Record<string, string | number> = {}) =>
    insertVersioned(db, 'dining_tables', base.restaurant, {
      zone_id: base.zone,
      name: '1',
      shape: 'round',
      x: 0,
      y: 0,
      width: 2,
      height: 2,
      capacity: 4,
      ...fields,
    })

  describe('table', () => {
    it('accepts a valid table and the rotation limits', () => {
      expect(() => table()).not.toThrow()
      expect(() => table({ rotation: 0 })).not.toThrow()
      expect(() => table({ rotation: 359 })).not.toThrow()
      expect(() => table({ capacity: 1 })).not.toThrow()
    })

    it.each(['hexagonal', '', 'ROUND'])('rejects the shape "%s"', (shape) => {
      expect(() => table({ shape })).toThrow(/CHECK/)
    })

    it.each(['round', 'square', 'rectangular', 'bar'])('accepts the shape %s', (shape) => {
      expect(() => table({ shape })).not.toThrow()
    })

    it.each([-1, 360, 720])('rejects the rotation %d', (rotation) => {
      expect(() => table({ rotation })).toThrow(/CHECK/)
    })

    it.each([0, -3])('rejects the capacity %d', (capacity) => {
      expect(() => table({ capacity })).toThrow(/CHECK/)
    })

    it.each([0, -1])('rejects width or height %d', (size) => {
      expect(() => table({ width: size })).toThrow(/CHECK/)
      expect(() => table({ height: size })).toThrow(/CHECK/)
    })

    it('rejects a rotation with decimals', () => {
      expect(() => table({ rotation: 45.5 })).toThrow()
    })
  })

  describe('device', () => {
    const device = (type: string) =>
      insertVersioned(db, 'devices', base.restaurant, {
        location_id: base.location,
        name: 'Celular 1',
        type,
      })

    it.each(['waiter', 'register', 'kds'])('accepts the type %s', (type) => {
      expect(() => device(type)).not.toThrow()
    })

    it.each(['tablet', '', 'Caja'])('rejects the type "%s"', (type) => {
      expect(() => device(type)).toThrow(/CHECK/)
    })
  })

  describe('order and items', () => {
    it.each(['open', 'closed', 'canceled'])('accepts the order status %s', (status) => {
      expect(() => insertOrder(db, base.restaurant, { status })).not.toThrow()
    })

    it.each(['voided', 'pagado', ''])('rejects the order status "%s"', (status) => {
      expect(() => insertOrder(db, base.restaurant, { status })).toThrow(/CHECK/)
    })

    it('rejects an unknown order channel', () => {
      expect(() => insertOrder(db, base.restaurant, { channel: 'drone' })).toThrow(/CHECK/)
    })

    it('rejects a day number less than 1', () => {
      expect(() => insertOrder(db, base.restaurant, { day_number: 0 })).toThrow(/CHECK/)
    })

    it.each(['held', 'pending', 'sent', 'in_preparation', 'ready', 'served', 'voided'])(
      'accepts the item status %s',
      (status) => {
        const order = insertOrder(db, base.restaurant)
        expect(() => insertItem(db, base.restaurant, order, { status })).not.toThrow()
      },
    )

    it.each(['canceled', 'preparando', ''])('rejects the item status "%s"', (status) => {
      const order = insertOrder(db, base.restaurant)
      expect(() => insertItem(db, base.restaurant, order, { status })).toThrow(/CHECK/)
    })

    it('rejects an unknown course or tax type', () => {
      const order = insertOrder(db, base.restaurant)
      expect(() => insertItem(db, base.restaurant, order, { course: 'aperitivo' })).toThrow(/CHECK/)
      expect(() => insertItem(db, base.restaurant, order, { tax_type: 'icui' })).toThrow(/CHECK/)
    })

    it('rejects station_ids that is not JSON', () => {
      const order = insertOrder(db, base.restaurant)
      expect(() => insertItem(db, base.restaurant, order, { station_ids: '[1,' })).toThrow(/CHECK/)
    })

    it('rejects a negative or fractional extra_price on an item modifier', () => {
      const order = insertOrder(db, base.restaurant)
      const item = insertItem(db, base.restaurant, order)
      const modifier = (extra_price: number) =>
        insertIntoTable(db, 'order_item_modifiers', {
          order_item_id: item,
          modifier_id: newId(),
          name: 'Extra queso',
          extra_price,
        })

      expect(() => modifier(3000)).not.toThrow()
      expect(() => modifier(-1)).toThrow(/CHECK/)
      expect(() => modifier(100.5)).toThrow()
    })

    it('deleting an order deletes its items (rebuildable projection)', () => {
      const order = insertOrder(db, base.restaurant)
      insertItem(db, base.restaurant, order)

      db.prepare('DELETE FROM orders WHERE id = ?').run(order)

      expect(db.prepare('SELECT count(*) AS n FROM order_items').get()?.n).toBe(0)
    })
  })

  describe('groups and modifiers', () => {
    const group = (minimum: number, maximum: number) =>
      insertVersioned(db, 'modifier_groups', base.restaurant, {
        name: 'Salsas',
        minimum,
        maximum,
      })

    it('accepts minimum equal to maximum and minimum zero', () => {
      expect(() => group(0, 1)).not.toThrow()
      expect(() => group(2, 2)).not.toThrow()
    })

    it.each([
      [3, 2],
      [1, 0],
      [-1, 2],
      [0, 0],
    ])('rejects the group with minimum %d and maximum %d', (minimum, maximum) => {
      expect(() => group(minimum, maximum)).toThrow(/CHECK/)
    })

    it('rejects a negative extra_price and one above the limit on a modifier', () => {
      const groupId = group(0, 2)
      const modifier = (extra_price: number) =>
        insertVersioned(db, 'modifiers', base.restaurant, {
          group_id: groupId,
          name: 'Picante',
          extra_price,
        })

      expect(() => modifier(0)).not.toThrow()
      expect(() => modifier(-500)).toThrow(/CHECK/)
      expect(() => modifier(100_000_001)).toThrow(/CHECK/)
    })

    it('a product does not repeat the same group', () => {
      const groupId = group(0, 2)
      const link = () =>
        insertVersioned(db, 'product_modifier_groups', base.restaurant, {
          product_id: base.product,
          group_id: groupId,
        })

      link()
      expect(() => link()).toThrow(/UNIQUE/)
    })
  })

  describe('ids', () => {
    it.each(['', 'CORTO', '0'.repeat(25), '0'.repeat(27)])(
      'rejects the id "%s" that is not 26 long',
      (id) => {
        expect(() => insertVersioned(db, 'categories', base.restaurant, { name: 'X' }, id)).toThrow(
          /CHECK/,
        )
        expect(() => insertEvent(db, base.restaurant, { id })).toThrow(/CHECK/)
        expect(() => insertConflict(db, base.restaurant, { id })).toThrow(/CHECK/)
      },
    )

    it('accepts an id of exactly 26 characters', () => {
      expect(() =>
        insertVersioned(db, 'categories', base.restaurant, { name: 'X' }, '0'.repeat(26)),
      ).not.toThrow()
    })

    it('rejects an order id of the wrong length', () => {
      const order = newId().slice(0, 20)
      expect(() =>
        insertIntoTable(db, 'orders', {
          id: order,
          restaurant_id: base.restaurant,
          channel: 'dine_in',
          status: 'open',
          opened_at: NOW,
          last_sequence: 1,
        }),
      ).toThrow(/CHECK/)
    })

    it('the restaurant must be its own restaurant_id', () => {
      const id = newId()
      expect(() =>
        insertVersioned(db, 'restaurants', newId(), { name: 'X', config: '{}' }, id),
      ).toThrow(/CHECK/)
    })
  })

  describe('JSON', () => {
    it.each(['related', 'affects', 'assignments', 'data'])(
      'rejects invalid JSON in event.%s',
      (column) => {
        expect(() => insertEvent(db, base.restaurant, { [column]: '{roto' })).toThrow(/CHECK/)
        expect(() => insertEvent(db, base.restaurant, { [column]: '' })).toThrow(/CHECK/)
      },
    )

    it.each([
      ['related', '["01HZX"]'],
      ['affects', '[]'],
      ['assignments', '{"day_number":4}'],
    ])('accepts valid JSON in event.%s', (column, value) => {
      expect(() => insertEvent(db, base.restaurant, { [column]: value })).not.toThrow()
    })

    it('the defaults of related, affects and assignments are empty JSON', () => {
      const event = insertEvent(db, base.restaurant)
      const row = db
        .prepare('SELECT related, affects, assignments FROM events WHERE id = ?')
        .get(event.id ?? null)

      expect(row).toEqual({ related: '[]', affects: '[]', assignments: '{}' })
    })

    it('rejects restaurant config that is not JSON', () => {
      const id = newId()
      expect(() =>
        insertVersioned(db, 'restaurants', id, { name: 'X', config: 'no json' }, id),
      ).toThrow(/CHECK/)
    })

    it('rejects quarantine content that is not JSON', () => {
      const row = (content: string) =>
        insertIntoTable(db, 'quarantined_events', {
          restaurant_id: base.restaurant,
          event_id: newId(),
          device_id: newId(),
          reason: 'esquema desconocido',
          content,
          received_at: NOW,
        })

      expect(() => row('{"a":1}')).not.toThrow()
      expect(() => row('<html>')).toThrow(/CHECK/)
    })
  })

  describe('events', () => {
    it.each(['order', 'table', 'product', 'catalog', 'register_shift', 'user', 'system'])(
      'accepts aggregate_type %s',
      (aggregate_type) => {
        expect(() =>
          insertEvent(db, base.restaurant, { aggregate_type, sequence: 1 }),
        ).not.toThrow()
      },
    )

    it.each(['cliente', '', 'Order'])('rejects aggregate_type "%s"', (aggregate_type) => {
      expect(() => insertEvent(db, base.restaurant, { aggregate_type })).toThrow(/CHECK/)
    })

    it('rejects sequence 0, negative base_sequence and schema_version 0', () => {
      expect(() => insertEvent(db, base.restaurant, { sequence: 0 })).toThrow(/CHECK|siguiente/)
      expect(() => insertEvent(db, base.restaurant, { base_sequence: -1 })).toThrow(/CHECK/)
      expect(() => insertEvent(db, base.restaurant, { schema_version: 0 })).toThrow(/CHECK/)
    })

    it('rejects an event from a restaurant that does not exist', () => {
      expect(() => insertEvent(db, newId())).toThrow(/FOREIGN KEY/)
    })

    it('does not allow the same rejected event twice or modifying it', () => {
      const id = newId()
      const reject = () =>
        insertIntoTable(db, 'rejected_events', {
          restaurant_id: base.restaurant,
          event_id: id,
          device_id: newId(),
          reason: 'id repetido con otro contenido',
          content: '{}',
          content_hash: 'h',
          received_at: NOW,
        })

      reject()
      expect(() => reject()).toThrow(/no se reemplazan|UNIQUE|PRIMARY KEY/)
      // The same id with different content (duplicate_id) is recorded separately.
      expect(() =>
        insertIntoTable(db, 'rejected_events', {
          restaurant_id: base.restaurant,
          event_id: id,
          device_id: newId(),
          reason: 'duplicate_id',
          content: '{"other":1}',
          content_hash: 'h2',
          received_at: NOW,
        }),
      ).not.toThrow()
      expect(() => db.exec("UPDATE rejected_events SET reason = 'other'")).toThrow(
        /no se modifican/,
      )
      expect(() => db.exec('DELETE FROM rejected_events')).toThrow(/no se borran/)
    })

    it('rejects an unknown quarantine resolution', () => {
      expect(() =>
        insertIntoTable(db, 'quarantined_events', {
          restaurant_id: base.restaurant,
          event_id: newId(),
          device_id: newId(),
          reason: 'm',
          content: '{}',
          received_at: NOW,
          resolution: 'ignorado',
        }),
      ).toThrow(/CHECK/)
    })
  })

  describe('event_aggregates', () => {
    const indexEvent = (event_id: string, aggregate_id = newId(), sequence = 1) =>
      insertIntoTable(db, 'event_aggregates', {
        restaurant_id: base.restaurant,
        aggregate_id,
        sequence,
        event_id,
      })

    it('indexes an existing event', () => {
      const event = insertEvent(db, base.restaurant)

      expect(() => indexEvent(String(event.id), String(event.aggregate_id))).not.toThrow()
    })

    it('rejects pointing to a nonexistent event', () => {
      expect(() => indexEvent(newId())).toThrow(/FOREIGN KEY/)
    })

    it('rejects pointing to an event from another restaurant', () => {
      const other = newId()
      insertVersioned(db, 'restaurants', other, { name: 'Otro', config: '{}' }, other)
      const outsider = insertEvent(db, other)

      expect(() => indexEvent(String(outsider.id))).toThrow(/FOREIGN KEY/)
    })

    it('is not modified or deleted', () => {
      const event = insertEvent(db, base.restaurant)
      indexEvent(String(event.id), String(event.aggregate_id))

      expect(() => db.exec('UPDATE event_aggregates SET sequence = 9')).toThrow(/no se modifican/)
      expect(() => db.exec('DELETE FROM event_aggregates')).toThrow(/no se borran/)
    })

    it('an event cannot be deleted even if the index references it', () => {
      const event = insertEvent(db, base.restaurant)
      indexEvent(String(event.id), String(event.aggregate_id))

      expect(() => db.prepare('DELETE FROM events WHERE id = ?').run(String(event.id))).toThrow(
        /no se borran/,
      )
    })
  })

  describe('conflict', () => {
    it.each([
      'duplicate_table',
      'table_locked',
      'item_not_found',
      'item_already_sent',
      'item_already_voided',
      'item_moved',
      'order_closed',
      'price_mismatch',
    ])('accepts the type %s', (type) => {
      expect(() => insertConflict(db, base.restaurant, { type })).not.toThrow()
    })

    it.each(['other', '', 'Duplicate_Table'])('rejects the type "%s"', (type) => {
      expect(() => insertConflict(db, base.restaurant, { type })).toThrow(/CHECK/)
    })

    it('stores a single conflict per event in a restaurant', () => {
      const event_id = newId()
      insertConflict(db, base.restaurant, { event_id })

      expect(() => insertConflict(db, base.restaurant, { event_id, type: 'table_locked' })).toThrow(
        /UNIQUE/,
      )
    })

    it('the same event_id can have a conflict in another restaurant', () => {
      const other = newId()
      insertVersioned(db, 'restaurants', other, { name: 'Otro', config: '{}' }, other)
      const event_id = newId()

      insertConflict(db, base.restaurant, { event_id })
      expect(() => insertConflict(db, other, { event_id })).not.toThrow()
    })
  })

  describe('other tables', () => {
    it('rejects unknown tax types', () => {
      expect(() =>
        insertVersioned(db, 'taxes', base.restaurant, {
          name: 'X',
          type: 'icui',
          rate: 0,
        }),
      ).toThrow(/CHECK/)
    })

    it('a counter cannot be negative', () => {
      expect(() =>
        insertIntoTable(db, 'counters', {
          restaurant_id: base.restaurant,
          name: 'catalog',
          value: -1,
        }),
      ).toThrow(/CHECK/)
    })

    it('active only allows 0 or 1', () => {
      expect(() =>
        insertVersioned(db, 'categories', base.restaurant, { name: 'X', active: 2 }),
      ).toThrow(/CHECK/)
    })

    it('a device credential requires a unique token', () => {
      const device = (name: string) =>
        insertVersioned(db, 'devices', base.restaurant, {
          location_id: base.location,
          name,
          type: 'waiter',
        })
      const credential = (id: string) =>
        insertIntoTable(db, 'device_credentials', {
          device_id: id,
          restaurant_id: base.restaurant,
          token_hash: 'mismo',
          created_at: NOW,
        })

      credential(device('A'))
      expect(() => credential(device('B'))).toThrow(/UNIQUE/)
    })
  })
})
