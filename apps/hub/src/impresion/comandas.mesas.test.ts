import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { insertarVersionado, SISTEMA } from '../acceso/registros'
import { type Equipo, type MontajeImpresion, montarImpresion } from './montaje-impresion'

// Tarea 1.5 en la cocina (ADR-015): cancelar un pedido saca «ANULAR» de lo que tenía la cocina, y
// cambiar de mesa o mover productos saca «CAMBIO DE MESA» con la mesa nueva y «Antes: …».

function conImpresoras(t: MontajeImpresion) {
  return {
    kitchen: t.impresoraNueva('Cocina', [t.kitchen]),
    bar: t.impresoraNueva('Barra', [t.bar]),
  }
}

const trabajosTipo = (t: MontajeImpresion, type: string) =>
  t.trabajos().filter((f) => t.content(f).type === type)

/** El ítem movido tal como lo manda el equipo, tomado del pedido real. */
function movidoDe(t: MontajeImpresion, order: string, itemId: string) {
  const i = t.hub.order(order)?.items[itemId]
  if (!i) throw new Error('sin ítem')
  return {
    item: {
      item_id: i.id,
      product_id: i.productId,
      variant_id: i.variantId,
      name: i.name,
      unit_price: i.unitPrice,
      tax_type: i.taxType,
      rate: i.rate,
      quantity: i.quantity,
      guest: i.guest,
      course: i.course,
      modifiers: i.modifiers.map((m) => ({
        modifier_id: m.modifierId,
        name: m.name,
        extra_price: m.extraPrice,
      })),
      notes: i.notes,
    },
    status: i.status,
    voided_quantity: i.voidedQuantity,
    added_by: i.addedBy,
  }
}

function move(t: MontajeImpresion, e: Equipo, source: string, target: string, ids: string[]) {
  return e.mandar(
    source,
    'ItemsMoved',
    { target_order_id: target, items: ids.map((id) => movidoDe(t, source, id)) },
    { related: [target] },
  )
}

const cancel = (register: Equipo, order: string) =>
  register.mandar(order, 'OrderCanceled', {}, { reason: 'Error del mesero' })

describe('cancelar el pedido', () => {
  it('lo que tenía la cocina sale como ANULAR, una comanda por la que salió, con su número', async () => {
    const t = montarImpresion()
    const imp = conImpresoras(t)
    const ana = t.device('waiter')
    const register = t.device('admin', 'register')
    const { order, items } = t.orderWith(
      ana,
      [
        { name: 'Tagliata', station: t.kitchen, quantity: 2 },
        { name: 'Aperol Spritz', station: t.bar },
      ],
      t.table('5'),
    )
    t.send(ana, order, items)
    await t.cola.runOnce()
    expect(cancel(register, order).status).toBe('confirmed')
    const voids = trabajosTipo(t, 'voidEntry')
    expect(voids).toHaveLength(2)
    const porEstacion = Object.fromEntries(voids.map((f) => [t.content(f).station, t.content(f)]))
    expect(porEstacion.Cocina).toMatchObject({ target: 'Mesa 5', numero: 1 })
    expect(porEstacion.Cocina.items).toMatchObject([{ name: 'Tagliata', quantity: 2 }])
    expect(porEstacion.Barra.items).toMatchObject([{ name: 'Aperol Spritz', quantity: 1 }])
    await t.cola.runOnce()
    expect(imp.kitchen.papel.textos().at(-1)).toContain('ANULAR')
  })

  it('solo se anula lo que sigue en cocina: no lo entregado ni lo anulado, y las unidades que quedan', async () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const register = t.device('admin', 'register')
    const { order, items } = t.orderWith(
      ana,
      [
        { name: 'Tagliata', station: t.kitchen, quantity: 3 },
        { name: 'Risotto', station: t.kitchen },
        { name: 'Pizza', station: t.kitchen },
      ],
      t.table('5'),
    )
    t.send(ana, order, items)
    const [tagliata, risotto, pizza] = items
    ana.mandar(order, 'ItemServed', { item_ids: [risotto?.id] })
    register.mandar(order, 'ItemVoided', {
      item_id: tagliata?.id,
      quantity: 1,
      already_prepared: false,
      ticket_id: null,
    })
    register.mandar(order, 'ItemVoided', {
      item_id: pizza?.id,
      quantity: 1,
      already_prepared: false,
      ticket_id: null,
    })
    const before = trabajosTipo(t, 'voidEntry').length
    cancel(register, order)
    const newOnes = trabajosTipo(t, 'voidEntry').slice(before)
    expect(newOnes).toHaveLength(1)
    expect(t.content(newOnes[0]).items).toMatchObject([{ name: 'Tagliata', quantity: 2 }])
  })

  it('sin nada en cocina (solo pendientes, entregados o un pedido vacío) no imprime nada', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const register = t.device('admin', 'register')
    const empty = t.open(ana, t.table('1'))
    const pendingList = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], t.table('2'))
    const served = t.orderWith(ana, [{ name: 'Risotto', station: t.kitchen }], t.table('3'))
    t.send(ana, served.order, served.items)
    ana.mandar(served.order, 'ItemServed', { item_ids: [served.items[0]?.id] })
    const hechos = t.trabajos().length
    expect(cancel(register, empty).status).toBe('confirmed')
    expect(cancel(register, pendingList.order).status).toBe('confirmed')
    expect(cancel(register, served.order).status).toBe('confirmed')
    expect(t.trabajos()).toHaveLength(hechos)
    expect(t.fallosGuardar).toEqual([])
  })

  it('un platillo ya listo todavía se anula; una cancelación rechazada no imprime', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const register = t.device('admin', 'register')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    ana.mandar(order, 'ItemReady', { item_ids: [items[0]?.id] })
    // El mesero no puede cancelar: se rechaza y no hay comanda.
    expect(ana.mandar(order, 'OrderCanceled', {}, { reason: 'x' }).status).toBe('rejected')
    expect(trabajosTipo(t, 'voidEntry')).toHaveLength(0)
    cancel(register, order)
    expect(trabajosTipo(t, 'voidEntry')).toHaveLength(1)
  })

  it('lleva "Mesa 5 + 6" cuando el pedido tenía mesas unidas', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const register = t.device('admin', 'register')
    const [m5, m6] = [t.table('5'), t.table('6')]
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], m5)
    ana.mandar(order, 'TablesMerged', { table_ids: [m6] })
    t.send(ana, order, items)
    cancel(register, order)
    expect(t.content(trabajosTipo(t, 'voidEntry')[0]).target).toBe('Mesa 5 + 6')
  })
})

describe('cambiar de mesa (traslado)', () => {
  it('con platos en cocina, cada estación recibe CAMBIO DE MESA con la mesa nueva y «Antes: Mesa 5»', async () => {
    const t = montarImpresion()
    const imp = conImpresoras(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(
      ana,
      [
        { name: 'Tagliata', station: t.kitchen },
        { name: 'Aperol Spritz', station: t.bar },
      ],
      t.table('5'),
    )
    t.send(ana, order, items)
    await t.cola.runOnce()
    const m6 = t.table('6')
    expect(ana.mandar(order, 'OrderMovedTable', { target_table_id: m6 }).status).toBe('confirmed')
    const traslados = trabajosTipo(t, 'move')
    expect(traslados).toHaveLength(2)
    for (const f of traslados)
      expect(t.content(f)).toMatchObject({ target: 'Mesa 6', before: 'Mesa 5' })
    await t.cola.runOnce()
    const text = imp.kitchen.papel.textos().at(-1) as string
    expect(text).toContain('CAMBIO DE MESA')
    expect(text).toContain('Antes: Mesa 5')
    expect(text).toMatch(/Mesa 6 +#1/)
    expect(text).toContain('1 x Tagliata')
  })

  it('conserva el número de la comanda original y no lleva la nota del pedido', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(
      ana,
      [{ name: 'Tagliata', station: t.kitchen }],
      t.table('5'),
    )
    ana.mandar(order, 'OrderNoteChanged', { notes: 'alérgico al maní' })
    t.send(ana, order, items)
    ana.mandar(order, 'OrderMovedTable', { target_table_id: t.table('6') })
    const c = t.content(trabajosTipo(t, 'move')[0])
    expect(c.numero).toBe(1)
    expect(c.notaPedido ?? null).toBeNull()
  })

  it('nada en cocina, nada que avisar: pendientes, entregados y pedidos sin enviar no imprimen', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const a = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], t.table('1'))
    const b = t.orderWith(ana, [{ name: 'Risotto', station: t.kitchen }], t.table('2'))
    t.send(ana, b.order, b.items)
    ana.mandar(b.order, 'ItemServed', { item_ids: [b.items[0]?.id] })
    expect(ana.mandar(a.order, 'OrderMovedTable', { target_table_id: t.table('8') }).status).toBe(
      'confirmed',
    )
    expect(ana.mandar(b.order, 'OrderMovedTable', { target_table_id: t.table('9') }).status).toBe(
      'confirmed',
    )
    expect(trabajosTipo(t, 'move')).toHaveLength(0)
  })

  it('pasarse a la misma mesa no imprime', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const m5 = t.table('5')
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], m5)
    t.send(ana, order, items)
    ana.mandar(order, 'OrderMovedTable', { target_table_id: m5 })
    expect(trabajosTipo(t, 'move')).toHaveLength(0)
  })

  it('con mesas unidas: «Antes: Mesa 5 + 6» y la nueva sigue con su grupo', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const [m5, m6, m7] = [t.table('5'), t.table('6'), t.table('7')]
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], m5)
    ana.mandar(order, 'TablesMerged', { table_ids: [m6] })
    t.send(ana, order, items)
    ana.mandar(order, 'OrderMovedTable', { target_table_id: m7 })
    expect(t.content(trabajosTipo(t, 'move')[0])).toMatchObject({
      before: 'Mesa 5 + 6',
      target: 'Mesa 7 + 6',
    })
  })

  it('pasarse a una de sus mesas unidas: la nueva es solo esa', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const [m5, m6] = [t.table('5'), t.table('6')]
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], m5)
    ana.mandar(order, 'TablesMerged', { table_ids: [m6] })
    t.send(ana, order, items)
    ana.mandar(order, 'OrderMovedTable', { target_table_id: m6 })
    expect(t.content(trabajosTipo(t, 'move')[0])).toMatchObject({
      before: 'Mesa 5 + 6',
      target: 'Mesa 6',
    })
  })

  it('unir o separar mesas sin cambiar la principal no avisa a la cocina', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const [m5, m6] = [t.table('5'), t.table('6')]
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], m5)
    t.send(ana, order, items)
    const before = t.trabajos().length
    ana.mandar(order, 'TablesMerged', { table_ids: [m6] })
    ana.mandar(order, 'TablesSeparated', { table_ids: [m6] })
    expect(t.trabajos()).toHaveLength(before)
  })

  it('un pedido de barra que pasa a una mesa dice «Antes: Barra»', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], null, 'bar')
    t.send(ana, order, items)
    ana.mandar(order, 'OrderMovedTable', { target_table_id: t.table('4') })
    expect(t.content(trabajosTipo(t, 'move')[0])).toMatchObject({
      before: 'Barra',
      target: 'Mesa 4',
    })
  })
})

describe('mover productos (traslado)', () => {
  function origenConDosEstaciones() {
    const t = montarImpresion()
    const imp = conImpresoras(t)
    const ana = t.device('waiter')
    const m5 = t.table('5')
    const { order, items } = t.orderWith(
      ana,
      [
        { name: 'Tagliata', station: t.kitchen },
        { name: 'Risotto', station: t.kitchen },
        { name: 'Aperol Spritz', station: t.bar },
      ],
      m5,
    )
    t.send(ana, order, items)
    return { t, imp, ana, order, items, m5 }
  }

  it('a una mesa libre (pedido nuevo): solo lo movido sale, con el destino y «Antes: Mesa 5»', async () => {
    const { t, imp, ana, order, items } = origenConDosEstaciones()
    const target = newId()
    ana.mandar(target, 'OrderOpened', { channel: 'dine_in', table_id: t.table('8'), guests: 1 })
    expect(move(t, ana, order, target, [items[1]?.id as string]).status).toBe('confirmed')
    const traslados = trabajosTipo(t, 'move')
    expect(traslados).toHaveLength(1)
    expect(t.content(traslados[0])).toMatchObject({
      station: 'Cocina',
      target: 'Mesa 8',
      before: 'Mesa 5',
      numero: 1,
    })
    expect(t.content(traslados[0]).items).toMatchObject([{ name: 'Risotto' }])
    await t.cola.runOnce()
    expect(imp.kitchen.papel.textos().at(-1)).toContain('Antes: Mesa 5')
  })

  it('a un pedido que ya existe con productos: el destino es la mesa de ese pedido', () => {
    const { t, ana, order, items } = origenConDosEstaciones()
    const other = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], t.table('9'))
    move(t, ana, order, other.order, [items[0]?.id as string])
    expect(t.content(trabajosTipo(t, 'move')[0])).toMatchObject({
      target: 'Mesa 9',
      before: 'Mesa 5',
    })
    expect(t.content(trabajosTipo(t, 'move')[0]).items).toMatchObject([{ name: 'Tagliata' }])
  })

  it('un destino con mesas unidas se anuncia «Mesa 8 + 9»', () => {
    const { t, ana, order, items } = origenConDosEstaciones()
    const [m8, m9] = [t.table('8'), t.table('9')]
    const other = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], m8)
    ana.mandar(other.order, 'TablesMerged', { table_ids: [m9] })
    move(t, ana, order, other.order, [items[0]?.id as string])
    expect(t.content(trabajosTipo(t, 'move')[0]).target).toBe('Mesa 8 + 9')
  })

  it('platos de dos estaciones: una comanda de traslado por la que salieron', () => {
    const { t, ana, order, items } = origenConDosEstaciones()
    const target = newId()
    ana.mandar(target, 'OrderOpened', { channel: 'dine_in', table_id: t.table('8'), guests: 1 })
    move(
      t,
      ana,
      order,
      target,
      items.map((i) => i.id),
    )
    const porEstacion = Object.fromEntries(
      trabajosTipo(t, 'move').map((f) => [t.content(f).station, t.content(f).items.length]),
    )
    expect(porEstacion).toEqual({ Cocina: 2, Barra: 1 })
  })

  it('lo pendiente o entregado que se mueve no avisa a la cocina; lo demás, sí', () => {
    const { t, ana, order, items } = origenConDosEstaciones()
    const pending = t.add(ana, order, { name: 'Pan', station: t.kitchen })
    ana.mandar(order, 'ItemServed', { item_ids: [items[1]?.id] })
    const target = newId()
    ana.mandar(target, 'OrderOpened', { channel: 'dine_in', table_id: t.table('8'), guests: 1 })
    move(t, ana, order, target, [pending.id, items[1]?.id as string])
    expect(trabajosTipo(t, 'move')).toHaveLength(0)
    move(t, ana, order, target, [items[0]?.id as string])
    expect(trabajosTipo(t, 'move')).toHaveLength(1)
  })

  it('moverlo otra vez sigue encontrando la comanda de su envío original', () => {
    const { t, ana, order, items } = origenConDosEstaciones()
    const [one, two] = [newId(), newId()]
    ana.mandar(one, 'OrderOpened', { channel: 'dine_in', table_id: t.table('8'), guests: 1 })
    ana.mandar(two, 'OrderOpened', { channel: 'dine_in', table_id: t.table('9'), guests: 1 })
    move(t, ana, order, one, [items[0]?.id as string])
    move(t, ana, one, two, [items[0]?.id as string])
    const traslados = trabajosTipo(t, 'move')
    expect(traslados).toHaveLength(2)
    expect(t.content(traslados[1])).toMatchObject({
      target: 'Mesa 9',
      before: 'Mesa 8',
      numero: 1,
    })
  })

  it('un movimiento rechazado no imprime', () => {
    const { t, ana, order, items } = origenConDosEstaciones()
    const target = newId() // no existe
    const r = move(t, ana, order, target, [items[0]?.id as string])
    expect(r.status).toBe('rejected')
    expect(trabajosTipo(t, 'move')).toHaveLength(0)
  })
})

describe('reimprimir la comanda de platos que se movieron', () => {
  it('ComandaReimpresa en el pedido de destino encuentra la comanda del origen', async () => {
    const t = montarImpresion()
    const imp = conImpresoras(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(
      ana,
      [{ name: 'Tagliata', station: t.kitchen }],
      t.table('5'),
    )
    const sent = t.send(ana, order, items)
    const target = newId()
    ana.mandar(target, 'OrderOpened', { channel: 'dine_in', table_id: t.table('8'), guests: 1 })
    move(t, ana, order, target, [items[0]?.id as string])
    await t.cola.runOnce()
    const comandaId = sent.tickets[0]?.ticket_id
    expect(ana.mandar(target, 'TicketReprinted', { ticket_id: comandaId }).status).toBe('confirmed')
    const reimpresiones = trabajosTipo(t, 'reprinting')
    expect(reimpresiones).toHaveLength(1)
    expect(t.content(reimpresiones[0])).toMatchObject({ target: 'Mesa 8', numero: 1 })
    expect(t.content(reimpresiones[0]).items).toMatchObject([{ name: 'Tagliata' }])
    await t.cola.runOnce()
    expect(imp.kitchen.papel.textos().at(-1)).toContain('REIMPRESIÓN')
  })

  it('una comanda que no existe en ningún pedido no imprime nada', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const { order } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    ana.mandar(order, 'TicketReprinted', { ticket_id: newId() })
    expect(trabajosTipo(t, 'reprinting')).toHaveLength(0)
  })
})

describe('varios restaurantes en la misma base (mesas)', () => {
  it('el nombre de la mesa se busca en el restaurante del evento: una mesa de otro no se imprime', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const other = newId()
    t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
      )
      .run(other, other, '2026-10-24T20:00:00.000Z', '2026-10-24T20:00:00.000Z')
    const sedeOtro = insertarVersionado(
      t.db,
      'locations',
      other,
      { name: 'Sede', address: null, time_zone: 'America/Bogota' },
      SISTEMA,
      '2026-10-24T20:00:00.000Z',
    )
    const zonaOtro = insertarVersionado(
      t.db,
      'zones',
      other,
      { location_id: sedeOtro, name: 'Salón', position: 1, level: 1 },
      SISTEMA,
      '2026-10-24T20:00:00.000Z',
    )
    const mesaAjena = insertarVersionado(
      t.db,
      'dining_tables',
      other,
      {
        zone_id: zonaOtro,
        name: 'AJENA',
        shape: 'square',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        capacity: 4,
      },
      SISTEMA,
      '2026-10-24T20:00:00.000Z',
    )
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], t.table('5'))
    t.send(ana, order, items)
    ana.mandar(order, 'OrderMovedTable', { target_table_id: mesaAjena })
    const c = t.content(trabajosTipo(t, 'move')[0])
    expect(c.target).toBe('Mesa')
    expect(JSON.stringify(c)).not.toContain('AJENA')
    expect(c.before).toBe('Mesa 5')
  })

  it('una cancelación de otro restaurante no genera trabajos en este', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const register = t.device('admin', 'register')
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], t.table('5'))
    t.send(ana, order, items)
    cancel(register, order)
    const rows = t.db.prepare('SELECT DISTINCT restaurant_id AS r FROM print_jobs').all()
    expect(rows.map((f) => f.r)).toEqual([t.restauranteId])
  })
})
