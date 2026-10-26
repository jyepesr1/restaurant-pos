import { newId } from '@pos/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { aplicarMigraciones } from './migrar'
import { abrirBase } from './node'
import {
  AHORA,
  insertarConflicto,
  insertarEnTabla,
  insertarEvento,
  insertarItem,
  insertarPedido,
  insertarVersionado,
  sembrar,
} from './pruebas/utiles'
import type { BaseSqlite } from './sqlite'

describe('restricciones del esquema', () => {
  let db: BaseSqlite
  let base: ReturnType<typeof sembrar>

  beforeEach(() => {
    db = abrirBase(':memory:')
    aplicarMigraciones(db)
    base = sembrar(db)
  })

  const table = (fields: Record<string, string | number> = {}) =>
    insertarVersionado(db, 'dining_tables', base.restaurant, {
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

  describe('mesa', () => {
    it('acepta una mesa válida y los límites de rotación', () => {
      expect(() => table()).not.toThrow()
      expect(() => table({ rotation: 0 })).not.toThrow()
      expect(() => table({ rotation: 359 })).not.toThrow()
      expect(() => table({ capacity: 1 })).not.toThrow()
    })

    it.each(['hexagonal', '', 'ROUND'])('rechaza la forma "%s"', (shape) => {
      expect(() => table({ shape })).toThrow(/CHECK/)
    })

    it.each(['round', 'square', 'rectangular', 'bar'])('acepta la forma %s', (shape) => {
      expect(() => table({ shape })).not.toThrow()
    })

    it.each([-1, 360, 720])('rechaza la rotación %d', (rotation) => {
      expect(() => table({ rotation })).toThrow(/CHECK/)
    })

    it.each([0, -3])('rechaza la capacidad %d', (capacity) => {
      expect(() => table({ capacity })).toThrow(/CHECK/)
    })

    it.each([0, -1])('rechaza ancho o alto %d', (medida) => {
      expect(() => table({ width: medida })).toThrow(/CHECK/)
      expect(() => table({ height: medida })).toThrow(/CHECK/)
    })

    it('rechaza una rotación con decimales', () => {
      expect(() => table({ rotation: 45.5 })).toThrow()
    })
  })

  describe('dispositivo', () => {
    const device = (type: string) =>
      insertarVersionado(db, 'devices', base.restaurant, {
        location_id: base.location,
        name: 'Celular 1',
        type,
      })

    it.each(['waiter', 'register', 'kds'])('acepta el tipo %s', (type) => {
      expect(() => device(type)).not.toThrow()
    })

    it.each(['tablet', '', 'Caja'])('rechaza el tipo "%s"', (type) => {
      expect(() => device(type)).toThrow(/CHECK/)
    })
  })

  describe('pedido e ítems', () => {
    it.each(['open', 'closed', 'canceled'])('acepta el estado de pedido %s', (status) => {
      expect(() => insertarPedido(db, base.restaurant, { status })).not.toThrow()
    })

    it.each(['voided', 'pagado', ''])('rechaza el estado de pedido "%s"', (status) => {
      expect(() => insertarPedido(db, base.restaurant, { status })).toThrow(/CHECK/)
    })

    it('rechaza un canal de pedido desconocido', () => {
      expect(() => insertarPedido(db, base.restaurant, { channel: 'drone' })).toThrow(/CHECK/)
    })

    it('rechaza un número del día menor que 1', () => {
      expect(() => insertarPedido(db, base.restaurant, { day_number: 0 })).toThrow(/CHECK/)
    })

    it.each(['held', 'pending', 'sent', 'in_preparation', 'ready', 'served', 'voided'])(
      'acepta el estado de ítem %s',
      (status) => {
        const order = insertarPedido(db, base.restaurant)
        expect(() => insertarItem(db, base.restaurant, order, { status })).not.toThrow()
      },
    )

    it.each(['canceled', 'preparando', ''])('rechaza el estado de ítem "%s"', (status) => {
      const order = insertarPedido(db, base.restaurant)
      expect(() => insertarItem(db, base.restaurant, order, { status })).toThrow(/CHECK/)
    })

    it('rechaza un curso o un tipo de impuesto desconocidos', () => {
      const order = insertarPedido(db, base.restaurant)
      expect(() => insertarItem(db, base.restaurant, order, { course: 'aperitivo' })).toThrow(
        /CHECK/,
      )
      expect(() => insertarItem(db, base.restaurant, order, { tax_type: 'icui' })).toThrow(/CHECK/)
    })

    it('rechaza estacion_ids que no es JSON', () => {
      const order = insertarPedido(db, base.restaurant)
      expect(() => insertarItem(db, base.restaurant, order, { station_ids: '[1,' })).toThrow(
        /CHECK/,
      )
    })

    it('rechaza precio_extra negativo o con decimales en el modificador de un ítem', () => {
      const order = insertarPedido(db, base.restaurant)
      const item = insertarItem(db, base.restaurant, order)
      const modifier = (extra_price: number) =>
        insertarEnTabla(db, 'order_item_modifiers', {
          order_item_id: item,
          modifier_id: newId(),
          name: 'Extra queso',
          extra_price,
        })

      expect(() => modifier(3000)).not.toThrow()
      expect(() => modifier(-1)).toThrow(/CHECK/)
      expect(() => modifier(100.5)).toThrow()
    })

    it('al borrar un pedido se borran sus ítems (proyección reconstruible)', () => {
      const order = insertarPedido(db, base.restaurant)
      insertarItem(db, base.restaurant, order)

      db.prepare('DELETE FROM orders WHERE id = ?').run(order)

      expect(db.prepare('SELECT count(*) AS n FROM order_items').get()?.n).toBe(0)
    })
  })

  describe('grupos y modificadores', () => {
    const group = (minimum: number, maximum: number) =>
      insertarVersionado(db, 'modifier_groups', base.restaurant, {
        name: 'Salsas',
        minimum,
        maximum,
      })

    it('acepta mínimo igual al máximo y mínimo cero', () => {
      expect(() => group(0, 1)).not.toThrow()
      expect(() => group(2, 2)).not.toThrow()
    })

    it.each([
      [3, 2],
      [1, 0],
      [-1, 2],
      [0, 0],
    ])('rechaza el grupo con mínimo %d y máximo %d', (minimum, maximum) => {
      expect(() => group(minimum, maximum)).toThrow(/CHECK/)
    })

    it('rechaza precio_extra negativo y por encima del tope en un modificador', () => {
      const grupoId = group(0, 2)
      const modifier = (extra_price: number) =>
        insertarVersionado(db, 'modifiers', base.restaurant, {
          group_id: grupoId,
          name: 'Picante',
          extra_price,
        })

      expect(() => modifier(0)).not.toThrow()
      expect(() => modifier(-500)).toThrow(/CHECK/)
      expect(() => modifier(100_000_001)).toThrow(/CHECK/)
    })

    it('un producto no repite el mismo grupo', () => {
      const grupoId = group(0, 2)
      const vincular = () =>
        insertarVersionado(db, 'product_modifier_groups', base.restaurant, {
          product_id: base.product,
          group_id: grupoId,
        })

      vincular()
      expect(() => vincular()).toThrow(/UNIQUE/)
    })
  })

  describe('ids', () => {
    it.each(['', 'CORTO', '0'.repeat(25), '0'.repeat(27)])(
      'rechaza el id "%s" que no mide 26',
      (id) => {
        expect(() =>
          insertarVersionado(db, 'categories', base.restaurant, { name: 'X' }, id),
        ).toThrow(/CHECK/)
        expect(() => insertarEvento(db, base.restaurant, { id })).toThrow(/CHECK/)
        expect(() => insertarConflicto(db, base.restaurant, { id })).toThrow(/CHECK/)
      },
    )

    it('acepta un id de exactamente 26 caracteres', () => {
      expect(() =>
        insertarVersionado(db, 'categories', base.restaurant, { name: 'X' }, '0'.repeat(26)),
      ).not.toThrow()
    })

    it('rechaza un id de pedido de longitud incorrecta', () => {
      const order = newId().slice(0, 20)
      expect(() =>
        insertarEnTabla(db, 'orders', {
          id: order,
          restaurant_id: base.restaurant,
          channel: 'dine_in',
          status: 'open',
          opened_at: AHORA,
          last_sequence: 1,
        }),
      ).toThrow(/CHECK/)
    })

    it('el restaurante debe ser su propio restaurante_id', () => {
      const id = newId()
      expect(() =>
        insertarVersionado(db, 'restaurants', newId(), { name: 'X', config: '{}' }, id),
      ).toThrow(/CHECK/)
    })
  })

  describe('JSON', () => {
    it.each(['related', 'affects', 'assignments', 'data'])(
      'rechaza JSON inválido en evento.%s',
      (columna) => {
        expect(() => insertarEvento(db, base.restaurant, { [columna]: '{roto' })).toThrow(/CHECK/)
        expect(() => insertarEvento(db, base.restaurant, { [columna]: '' })).toThrow(/CHECK/)
      },
    )

    it.each([
      ['related', '["01HZX"]'],
      ['affects', '[]'],
      ['assignments', '{"day_number":4}'],
    ])('acepta JSON válido en evento.%s', (columna, value) => {
      expect(() => insertarEvento(db, base.restaurant, { [columna]: value })).not.toThrow()
    })

    it('los valores por defecto de relacionados, afecta y asignaciones son JSON vacío', () => {
      const event = insertarEvento(db, base.restaurant)
      const fila = db
        .prepare('SELECT related, affects, assignments FROM events WHERE id = ?')
        .get(event.id ?? null)

      expect(fila).toEqual({ related: '[]', affects: '[]', assignments: '{}' })
    })

    it('rechaza config del restaurante que no es JSON', () => {
      const id = newId()
      expect(() =>
        insertarVersionado(db, 'restaurants', id, { name: 'X', config: 'no json' }, id),
      ).toThrow(/CHECK/)
    })

    it('rechaza contenido de cuarentena que no es JSON', () => {
      const fila = (content: string) =>
        insertarEnTabla(db, 'quarantined_events', {
          restaurant_id: base.restaurant,
          event_id: newId(),
          device_id: newId(),
          reason: 'esquema desconocido',
          content,
          received_at: AHORA,
        })

      expect(() => fila('{"a":1}')).not.toThrow()
      expect(() => fila('<html>')).toThrow(/CHECK/)
    })
  })

  describe('eventos', () => {
    it.each(['order', 'table', 'product', 'catalog', 'register_shift', 'user', 'system'])(
      'acepta agregado_tipo %s',
      (aggregate_type) => {
        expect(() =>
          insertarEvento(db, base.restaurant, { aggregate_type, sequence: 1 }),
        ).not.toThrow()
      },
    )

    it.each(['cliente', '', 'Order'])('rechaza agregado_tipo "%s"', (aggregate_type) => {
      expect(() => insertarEvento(db, base.restaurant, { aggregate_type })).toThrow(/CHECK/)
    })

    it('rechaza secuencia 0, secuencia_base negativa y version_esquema 0', () => {
      expect(() => insertarEvento(db, base.restaurant, { sequence: 0 })).toThrow(/CHECK|siguiente/)
      expect(() => insertarEvento(db, base.restaurant, { base_sequence: -1 })).toThrow(/CHECK/)
      expect(() => insertarEvento(db, base.restaurant, { schema_version: 0 })).toThrow(/CHECK/)
    })

    it('rechaza un evento de un restaurante que no existe', () => {
      expect(() => insertarEvento(db, newId())).toThrow(/FOREIGN KEY/)
    })

    it('no admite el mismo evento rechazado dos veces ni modificarlo', () => {
      const id = newId()
      const reject = () =>
        insertarEnTabla(db, 'rejected_events', {
          restaurant_id: base.restaurant,
          event_id: id,
          device_id: newId(),
          reason: 'id repetido con otro contenido',
          content: '{}',
          content_hash: 'h',
          received_at: AHORA,
        })

      reject()
      expect(() => reject()).toThrow(/no se reemplazan|UNIQUE|PRIMARY KEY/)
      // El mismo id con otro contenido (id_repetido) sí se registra aparte.
      expect(() =>
        insertarEnTabla(db, 'rejected_events', {
          restaurant_id: base.restaurant,
          event_id: id,
          device_id: newId(),
          reason: 'duplicate_id',
          content: '{"other":1}',
          content_hash: 'h2',
          received_at: AHORA,
        }),
      ).not.toThrow()
      expect(() => db.exec("UPDATE rejected_events SET reason = 'other'")).toThrow(
        /no se modifican/,
      )
      expect(() => db.exec('DELETE FROM rejected_events')).toThrow(/no se borran/)
    })

    it('rechaza una resolución de cuarentena desconocida', () => {
      expect(() =>
        insertarEnTabla(db, 'quarantined_events', {
          restaurant_id: base.restaurant,
          event_id: newId(),
          device_id: newId(),
          reason: 'm',
          content: '{}',
          received_at: AHORA,
          resolution: 'ignorado',
        }),
      ).toThrow(/CHECK/)
    })
  })

  describe('evento_agregado', () => {
    const indexar = (event_id: string, aggregate_id = newId(), sequence = 1) =>
      insertarEnTabla(db, 'event_aggregates', {
        restaurant_id: base.restaurant,
        aggregate_id,
        sequence,
        event_id,
      })

    it('indexa un evento existente', () => {
      const event = insertarEvento(db, base.restaurant)

      expect(() => indexar(String(event.id), String(event.aggregate_id))).not.toThrow()
    })

    it('rechaza apuntar a un evento inexistente', () => {
      expect(() => indexar(newId())).toThrow(/FOREIGN KEY/)
    })

    it('rechaza apuntar a un evento de otro restaurante', () => {
      const other = newId()
      insertarVersionado(db, 'restaurants', other, { name: 'Otro', config: '{}' }, other)
      const ajeno = insertarEvento(db, other)

      expect(() => indexar(String(ajeno.id))).toThrow(/FOREIGN KEY/)
    })

    it('no se modifica ni se borra', () => {
      const event = insertarEvento(db, base.restaurant)
      indexar(String(event.id), String(event.aggregate_id))

      expect(() => db.exec('UPDATE event_aggregates SET sequence = 9')).toThrow(/no se modifican/)
      expect(() => db.exec('DELETE FROM event_aggregates')).toThrow(/no se borran/)
    })

    it('un evento no se puede borrar aunque lo referencie el índice', () => {
      const event = insertarEvento(db, base.restaurant)
      indexar(String(event.id), String(event.aggregate_id))

      expect(() => db.prepare('DELETE FROM events WHERE id = ?').run(String(event.id))).toThrow(
        /no se borran/,
      )
    })
  })

  describe('conflicto', () => {
    it.each([
      'duplicate_table',
      'table_locked',
      'item_not_found',
      'item_already_sent',
      'item_already_voided',
      'item_moved',
      'order_closed',
      'price_mismatch',
    ])('acepta el tipo %s', (type) => {
      expect(() => insertarConflicto(db, base.restaurant, { type })).not.toThrow()
    })

    it.each(['other', '', 'Duplicate_Table'])('rechaza el tipo "%s"', (type) => {
      expect(() => insertarConflicto(db, base.restaurant, { type })).toThrow(/CHECK/)
    })

    it('guarda un solo conflicto por evento en un restaurante', () => {
      const event_id = newId()
      insertarConflicto(db, base.restaurant, { event_id })

      expect(() =>
        insertarConflicto(db, base.restaurant, { event_id, type: 'table_locked' }),
      ).toThrow(/UNIQUE/)
    })

    it('el mismo evento_id puede tener conflicto en otro restaurante', () => {
      const other = newId()
      insertarVersionado(db, 'restaurants', other, { name: 'Otro', config: '{}' }, other)
      const event_id = newId()

      insertarConflicto(db, base.restaurant, { event_id })
      expect(() => insertarConflicto(db, other, { event_id })).not.toThrow()
    })
  })

  describe('otras tablas', () => {
    it('rechaza tipos de impuesto desconocidos', () => {
      expect(() =>
        insertarVersionado(db, 'taxes', base.restaurant, {
          name: 'X',
          type: 'icui',
          rate: 0,
        }),
      ).toThrow(/CHECK/)
    })

    it('un contador no puede ser negativo', () => {
      expect(() =>
        insertarEnTabla(db, 'counters', {
          restaurant_id: base.restaurant,
          name: 'catalog',
          value: -1,
        }),
      ).toThrow(/CHECK/)
    })

    it('activo solo admite 0 o 1', () => {
      expect(() =>
        insertarVersionado(db, 'categories', base.restaurant, { name: 'X', active: 2 }),
      ).toThrow(/CHECK/)
    })

    it('una credencial de dispositivo exige un token único', () => {
      const device = (name: string) =>
        insertarVersionado(db, 'devices', base.restaurant, {
          location_id: base.location,
          name,
          type: 'waiter',
        })
      const credential = (id: string) =>
        insertarEnTabla(db, 'device_credentials', {
          device_id: id,
          restaurant_id: base.restaurant,
          token_hash: 'mismo',
          created_at: AHORA,
        })

      credential(device('A'))
      expect(() => credential(device('B'))).toThrow(/UNIQUE/)
    })
  })
})
