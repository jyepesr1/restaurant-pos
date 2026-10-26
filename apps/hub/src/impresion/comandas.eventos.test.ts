import { newId } from '@pos/core'
import { readEscpos } from '@pos/printing'
import { describe, expect, it } from 'vitest'
import { insertVersioned, SISTEMA } from '../acceso/registros'
import { trabajosDeEvento } from './comandas'
import { type MontajeImpresion, montarImpresion } from './montaje-impresion'

// De un evento aceptado a las comandas en la cola (ADR-015): numeración, ítems repetidos, los
// tipos de comanda (nueva, reimpresión, anulación, cambio), cursos retenidos, estaciones sin
// impresora, archivadas, un fallo del gancho y varios restaurantes en la misma base.

const TIME = /(\d{1,2}):(\d{2})\s*([ap])\.\s*m\./

/** Una impresora para cada estación (cocina, barra, postres), cada una con su papel. */
function conImpresoras(t: MontajeImpresion) {
  return {
    kitchen: t.impresoraNueva('Cocina', [t.kitchen]),
    bar: t.impresoraNueva('Barra', [t.bar]),
    postres: t.impresoraNueva('Postres', [t.postres]),
  }
}

describe('numeración de las comandas por día operativo', () => {
  it('varias estaciones en un envío: un número por comanda, seguidos, y cada una con el suyo', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [
      { name: 'Tagliata', station: t.kitchen },
      { name: 'Aperol Spritz', station: t.bar },
      { name: 'Tiramisú', station: t.postres },
    ])
    const r = t.send(ana, order, items)
    expect(r.status).toBe('confirmed')
    const numbers = r.accepted?.assignments.ticket_numbers as Record<string, number>
    expect(r.tickets.map((c) => numbers[c.ticket_id])).toEqual([1, 2, 3])
    const porEstacion = Object.fromEntries(
      t.trabajos().map((f) => [t.content(f).station, t.content(f).number]),
    )
    expect(porEstacion).toEqual({ Cocina: 1, Barra: 2, Postres: 3 })
  })

  it('al cambiar de día operativo (6:00 a. m.) la numeración vuelve a 1', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const sendOne = () => {
      const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
      t.send(ana, order, items)
    }
    sendOne() // 3:00 p. m. del 24
    t.advance(14 * 3_600_000 + 59 * 60_000) // 5:59 a. m. del 25: sigue siendo el día 24
    sendOne()
    t.advance(60_000) // 6:00 a. m.
    sendOne()
    t.advance(60_000)
    sendOne()
    expect(t.trabajos().map((f) => t.content(f).number)).toEqual([1, 2, 1, 2])
  })

  it('la hora de la comanda sale en la zona horaria del restaurante', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    // INICIO = 20:00 UTC = 3:00 p. m. en Bogotá.
    const time = TIME.exec(String(t.content(t.trabajos()[0]).time))
    expect(time?.slice(1, 5)).toEqual(['3', '00', 'p'])
  })

  it('otra zona horaria cambia la hora impresa pero no los números', () => {
    const t = montarImpresion({ timeZone: 'Europe/Madrid' })
    conImpresoras(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    expect(TIME.exec(String(t.content(t.trabajos()[0]).time))?.[1]).toBe('10')
  })
})

describe('ItemsEnviados con ítems ya enviados por otro equipo', () => {
  /** Dos meseros ven el mismo pedido; el segundo no se enteró de lo que mandó el primero. */
  function dosEquipos() {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const luis = t.device('waiter2')
    const { order, items } = t.orderWith(ana, [
      { name: 'Tagliata', station: t.kitchen },
      { name: 'Risotto', station: t.kitchen },
    ])
    const baseDeLuis = Number(t.db.prepare('SELECT max(sequence) AS s FROM events').get()?.s)
    return { t, ana, luis, order, items, baseDeLuis }
  }

  it('lo ya enviado no se imprime dos veces: la segunda comanda lleva solo lo que faltaba', () => {
    const { t, ana, luis, order, items, baseDeLuis } = dosEquipos()
    t.send(ana, order, [items[0] as (typeof items)[0]])
    const r = luis.submit(
      order,
      'ItemsSent',
      {
        tickets: [{ ticket_id: newId(), station_id: t.kitchen, item_ids: items.map((i) => i.id) }],
      },
      { base_sequence: baseDeLuis },
    )
    expect(r.status).toBe('confirmed')
    const trabajos = t.trabajos()
    expect(trabajos).toHaveLength(2)
    expect(t.content(trabajos[0]).items.map((i: { name: string }) => i.name)).toEqual(['Tagliata'])
    expect(t.content(trabajos[1]).items.map((i: { name: string }) => i.name)).toEqual(['Risotto'])
  })

  it('un envío donde todo ya salió, sin estar al día, se acepta y no imprime nada', () => {
    const { t, ana, luis, order, items, baseDeLuis } = dosEquipos()
    t.send(ana, order, items)
    expect(t.trabajos()).toHaveLength(1)
    const r = luis.submit(
      order,
      'ItemsSent',
      {
        tickets: [{ ticket_id: newId(), station_id: t.kitchen, item_ids: items.map((i) => i.id) }],
      },
      { base_sequence: baseDeLuis },
    )
    expect(r.status).toBe('confirmed')
    expect(t.trabajos()).toHaveLength(1)
    expect(t.fallosGuardar).toEqual([])
  })

  it('el mismo envío reenviado por el mismo equipo no duplica la comanda', () => {
    const { t, ana, order, items } = dosEquipos()
    const r = t.send(ana, order, items)
    expect(t.trabajos()).toHaveLength(1)
    // El hub vuelve a recibir exactamente el mismo evento (reintento tras un corte).
    const equal = ana.submit(order, 'ItemsSent', { tickets: r.tickets })
    expect(equal.status).toBe('rejected')
    expect(t.trabajos()).toHaveLength(1)
  })

  it('la llamada directa al gancho con un evento ya aplicado no crea nada', () => {
    const { t, ana, order, items } = dosEquipos()
    const r = t.send(ana, order, items)
    if (!r.accepted) throw new Error('sin evento')
    const already = t.hub.order(order)
    expect(
      trabajosDeEvento(t.opcionesComandas, r.accepted, [{ before: already, after: already }]),
    ).toBe(0)
    expect(t.trabajos()).toHaveLength(1)
  })

  it('un envío que no imprime nada no gasta número de comanda', () => {
    // El hub numera antes de saber si algo pasará a «enviado»: la cocina vería la comanda 1 y la
    // 3 sin que la 2 exista en papel.
    const { t, ana, luis, order, items, baseDeLuis } = dosEquipos()
    t.send(ana, order, items)
    luis.submit(
      order,
      'ItemsSent',
      {
        tickets: [{ ticket_id: newId(), station_id: t.kitchen, item_ids: items.map((i) => i.id) }],
      },
      { base_sequence: baseDeLuis },
    )
    const other = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }])
    t.send(ana, other.order, other.items)
    const latest = t.trabajos().at(-1)
    expect(t.content(latest).number).toBe(2)
  })
})

describe('un envío hecho sin conexión que llega tarde', () => {
  it('se imprime al llegar, con la hora de llegada y el número del día en que se hizo', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const luis = t.device('waiter2')
    // Luis arma el pedido y lo envía a las 11:30 p. m. sin red; llega a las 6:40 a. m.
    const { order, items } = t.orderWith(luis, [{ name: 'Tagliata', station: t.kitchen }])
    const before = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }])
    t.send(ana, before.order, before.items) // número 1 del día 24
    const horaDelEnvio = new Date(t.clock() + 8.5 * 3_600_000).toISOString() // 11:30 p. m. del 24
    t.advance(15 * 3_600_000 + 40 * 60_000) // 6:40 a. m. del 25
    const r = luis.submit(
      order,
      'ItemsSent',
      { tickets: [{ ticket_id: newId(), station_id: t.kitchen, item_ids: [items[0]?.id] }] },
      { device_time: horaDelEnvio, hub_estimated_time: horaDelEnvio },
    )
    expect(r.status).toBe('confirmed')
    expect(r.accepted?.business_day).toBe('2026-10-24')
    const latest = t.trabajos().at(-1)
    expect(t.content(latest).number).toBe(2)
    expect(String(latest?.created_at)).toBe(r.accepted?.received_at)
    expect(TIME.exec(String(t.content(latest).time))?.slice(1, 5)).toEqual(['6', '40', 'a'])
    // Hoy la cuenta empieza en 1.
    const today = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }])
    t.send(ana, today.order, today.items)
    expect(t.content(t.trabajos().at(-1)).number).toBe(1)
  })

  it('sale por la impresora aunque el envío llegue horas después, y solo una vez', async () => {
    const t = montarImpresion()
    const { kitchen } = conImpresoras(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.advance(3 * 3_600_000)
    t.send(ana, order, items)
    await t.queue.runOnce()
    await t.queue.runOnce()
    expect(kitchen.papel.received).toHaveLength(1)
  })
})

describe('reimpresión, anulación y cambio de lo ya enviado', () => {
  async function conPedidoEnviado() {
    const t = montarImpresion()
    const imp = conImpresoras(t)
    const ana = t.device('waiter')
    const register = t.device('admin', 'register')
    const table = t.table('12')
    const { order, items } = t.orderWith(
      ana,
      [
        {
          name: 'Tagliata',
          station: t.kitchen,
          options: ['Término medio'],
          quantity: 3,
          guest: 2,
        },
        { name: 'Risotto', station: t.kitchen, notes: 'sin queso' },
        { name: 'Aperol Spritz', station: t.bar },
      ],
      table,
    )
    const sent = t.send(ana, order, items)
    await t.queue.runOnce()
    return { t, imp, ana, register, order, items, sent, table }
  }

  it('ComandaReimpresa saca otra vez la comanda con su número original, marcada como reimpresión', async () => {
    const { t, imp, ana, order, sent } = await conPedidoEnviado()
    const kitchen = sent.tickets.find((c) => c.station_id === t.kitchen)
    ana.submit(order, 'TicketReprinted', { ticket_id: kitchen?.ticket_id })
    expect(t.pendingList()).toBe(1)
    await t.queue.runOnce()
    expect(imp.kitchen.papel.received).toHaveLength(2)
    const text = imp.kitchen.papel.texts()[1] as string
    expect(text).toContain('REIMPRESIÓN')
    expect(text).toMatch(/Mesa 12 +#1/)
    expect(text).toContain('3 x Tagliata')
    expect(text).toContain('Risotto')
    // La barra no imprime lo de la cocina.
    expect(imp.bar.papel.received).toHaveLength(1)
  })

  it('reimprimir dos veces saca dos comandas (cada evento es distinto)', async () => {
    const { t, imp, ana, order, sent } = await conPedidoEnviado()
    const bar = sent.tickets.find((c) => c.station_id === t.bar)
    ana.submit(order, 'TicketReprinted', { ticket_id: bar?.ticket_id })
    ana.submit(order, 'TicketReprinted', { ticket_id: bar?.ticket_id })
    await t.queue.runOnce()
    expect(imp.bar.papel.received).toHaveLength(3)
  })

  it('reimprimir una comanda que no existe, o de otro pedido, no imprime nada y el evento se acepta', async () => {
    const { t, ana, order, sent } = await conPedidoEnviado()
    const other = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }])
    const r1 = ana.submit(order, 'TicketReprinted', { ticket_id: newId() })
    const r2 = ana.submit(other.order, 'TicketReprinted', {
      ticket_id: sent.tickets[0]?.ticket_id,
    })
    expect([r1.status, r2.status]).toEqual(['confirmed', 'confirmed'])
    expect(t.pendingList()).toBe(0)
    expect(t.fallosGuardar).toEqual([])
  })

  it('la reimpresión no incluye lo anulado y muestra las unidades que quedan', async () => {
    const { t, imp, register, ana, order, items, sent } = await conPedidoEnviado()
    register.submit(order, 'ItemVoided', {
      item_id: items[0]?.id,
      quantity: 1,
      already_prepared: false,
      ticket_id: null,
    })
    register.submit(order, 'ItemVoided', {
      item_id: items[1]?.id,
      quantity: 1,
      already_prepared: false,
      ticket_id: null,
    })
    await t.queue.runOnce()
    const kitchen = sent.tickets.find((c) => c.station_id === t.kitchen)
    ana.submit(order, 'TicketReprinted', { ticket_id: kitchen?.ticket_id })
    await t.queue.runOnce()
    const text = imp.kitchen.papel.texts().at(-1) as string
    expect(text).toContain('REIMPRESIÓN')
    expect(text).toContain('2 x Tagliata')
    expect(text).not.toContain('Risotto')
  })

  it('si se anuló todo, la reimpresión no saca una comanda vacía', async () => {
    const { t, register, ana, order, items, sent } = await conPedidoEnviado()
    for (const i of [items[0], items[1]])
      register.submit(order, 'ItemVoided', {
        item_id: i?.id,
        quantity: i?.name === 'Tagliata' ? 3 : 1,
        already_prepared: false,
        ticket_id: null,
      })
    await t.queue.runOnce()
    const before = t.trabajos().length
    const kitchen = sent.tickets.find((c) => c.station_id === t.kitchen)
    ana.submit(order, 'TicketReprinted', { ticket_id: kitchen?.ticket_id })
    expect(t.trabajos()).toHaveLength(before)
  })

  it('ItemAnulado de lo que está en cocina saca la comanda de anulación con la cantidad anulada', async () => {
    const { t, imp, register, order, items } = await conPedidoEnviado()
    const r = register.submit(order, 'ItemVoided', {
      item_id: items[0]?.id,
      quantity: 2,
      already_prepared: false,
      ticket_id: null,
    })
    expect(r.status).toBe('confirmed')
    await t.queue.runOnce()
    const text = imp.kitchen.papel.texts().at(-1) as string
    expect(text).toContain('ANULAR')
    expect(text).toMatch(/Mesa 12 +#1/)
    expect(text).toContain('-2 x Tagliata')
    expect(text).toContain('> Término medio')
    expect(text).not.toContain('Risotto')
    expect(imp.bar.papel.received).toHaveLength(1)
  })

  it.each(['sent', 'in_preparation', 'ready'] as const)(
    'ItemAnulado avisa a la cocina si el plato está «%s»',
    async (status) => {
      const { t, ana, register, order, items } = await conPedidoEnviado()
      const id = items[1]?.id
      if (status === 'in_preparation') ana.submit(order, 'ItemInPreparation', { item_ids: [id] })
      if (status === 'ready') ana.submit(order, 'ItemReady', { item_ids: [id] })
      expect(t.hub.order(order)?.items[id as string]?.status).toBe(status)
      const before = t.trabajos().length
      register.submit(order, 'ItemVoided', {
        item_id: id,
        quantity: 1,
        already_prepared: status === 'ready',
        ticket_id: null,
      })
      expect(t.trabajos()).toHaveLength(before + 1)
    },
  )

  it('ItemAnulado de algo ya entregado no avisa a la cocina', async () => {
    const { t, ana, register, order, items } = await conPedidoEnviado()
    ana.submit(order, 'ItemServed', { item_ids: [items[1]?.id] })
    const before = t.trabajos().length
    const r = register.submit(order, 'ItemVoided', {
      item_id: items[1]?.id,
      quantity: 1,
      already_prepared: true,
      ticket_id: null,
    })
    expect(r.status).toBe('confirmed')
    expect(t.trabajos()).toHaveLength(before)
  })

  it('anular lo que aún no se envió se rechaza y no imprime (se quita, no se anula)', async () => {
    const { t, ana, register } = await conPedidoEnviado()
    const fresh = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }])
    const before = t.trabajos().length
    const r = register.submit(fresh.order, 'ItemVoided', {
      item_id: fresh.items[0]?.id,
      quantity: 1,
      already_prepared: false,
      ticket_id: null,
    })
    expect(r.status).toBe('rejected')
    expect(t.trabajos()).toHaveLength(before)
  })

  it('anular dos veces el mismo plato (cantidad parcial y luego el resto) saca dos anulaciones', async () => {
    const { t, imp, register, order, items } = await conPedidoEnviado()
    for (const quantity of [1, 2])
      register.submit(order, 'ItemVoided', {
        item_id: items[0]?.id,
        quantity,
        already_prepared: false,
        ticket_id: null,
      })
    await t.queue.runOnce()
    const texts = imp.kitchen.papel.texts()
    expect(texts.at(-2)).toContain('-1 x Tagliata')
    expect(texts.at(-1)).toContain('-2 x Tagliata')
  })

  it('ItemModificadoTrasEnvio saca la comanda de cambio con las opciones y notas nuevas', async () => {
    const { t, imp, ana, order, items, sent } = await conPedidoEnviado()
    const kitchen = sent.tickets.find((c) => c.station_id === t.kitchen)
    const r = ana.submit(order, 'ItemModifiedAfterSend', {
      item_id: items[1]?.id,
      ticket_id: kitchen?.ticket_id,
      notes: 'sin queso y sin sal',
    })
    expect(r.status).toBe('confirmed')
    await t.queue.runOnce()
    const text = imp.kitchen.papel.texts().at(-1) as string
    expect(text).toContain('CAMBIO')
    expect(text).toMatch(/Mesa 12 +#1/)
    expect(text).toContain('Risotto')
    expect(text).toContain('NOTA: sin queso y sin sal')
    expect(text).not.toContain('Tagliata')
  })

  it('un cambio de opciones imprime las nuevas; quitar la nota la deja sin NOTA', async () => {
    const { t, imp, ana, order, items, sent } = await conPedidoEnviado()
    const kitchen = sent.tickets.find((c) => c.station_id === t.kitchen)
    ana.submit(order, 'ItemModifiedAfterSend', {
      item_id: items[1]?.id,
      ticket_id: kitchen?.ticket_id,
      notes: null,
      modifiers: [{ modifier_id: newId(), name: 'Bien cocido', extra_price: 0 }],
    })
    await t.queue.runOnce()
    const text = imp.kitchen.papel.texts().at(-1) as string
    expect(text).toContain('> Bien cocido')
    expect(text).not.toContain('NOTA')
  })

  it('modificar algo que no se ha enviado se rechaza y no imprime', async () => {
    const { t, ana } = await conPedidoEnviado()
    const fresh = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }])
    const before = t.trabajos().length
    const r = ana.submit(fresh.order, 'ItemModifiedAfterSend', {
      item_id: fresh.items[0]?.id,
      ticket_id: newId(),
      notes: 'x',
    })
    expect(r.status).toBe('rejected')
    expect(t.trabajos()).toHaveLength(before)
  })

  it('los eventos que no son de comandas (listo, entregado, descuentos…) no crean trabajos', async () => {
    const { t, ana, order, items } = await conPedidoEnviado()
    const before = t.trabajos().length
    ana.submit(order, 'ItemReady', { item_ids: [items[0]?.id] })
    ana.submit(order, 'ItemServed', { item_ids: [items[0]?.id] })
    ana.submit(order, 'ItemReturnedToQueue', { item_ids: [items[0]?.id] })
    ana.submit(order, 'GuestsChanged', { guests: 5 })
    expect(t.trabajos()).toHaveLength(before)
  })

  it('anular un plato que se pasó a otro pedido (cambio de mesa de un ítem) avisa a la cocina', async () => {
    // El plato sigue en cocina, pero su comanda quedó en los eventos del pedido de origen.
    const { t, ana, register, order, items } = await conPedidoEnviado()
    const target = newId()
    ana.submit(target, 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 1 })
    const original = t.hub.order(order)?.items[items[1]?.id as string]
    if (!original) throw new Error('sin ítem')
    const moved = ana.submit(
      order,
      'ItemsMoved',
      {
        target_order_id: target,
        items: [
          {
            item: {
              item_id: original.id,
              product_id: original.productId,
              variant_id: original.variantId,
              name: original.name,
              unit_price: original.unitPrice,
              tax_type: original.taxType,
              rate: original.rate,
              quantity: original.quantity,
              guest: original.guest,
              course: original.course,
              modifiers: original.modifiers.map((m) => ({
                modifier_id: m.modifierId,
                name: m.name,
                extra_price: m.extraPrice,
              })),
              notes: original.notes,
            },
            status: 'sent',
            voided_quantity: 0,
            added_by: original.addedBy,
          },
        ],
      },
      { related: [target] },
    )
    expect(moved.result).toMatchObject({ status: 'confirmed' })
    const before = t.trabajos().length
    const r = register.submit(target, 'ItemVoided', {
      item_id: original.id,
      quantity: 1,
      already_prepared: false,
      ticket_id: null,
    })
    expect(r.status).toBe('confirmed')
    expect(t.trabajos()).toHaveLength(before + 1)
  })
})

describe('datos que lleva la comanda', () => {
  it.each([
    ['dine_in', 'Mesa'],
    ['takeout', 'Para llevar'],
    ['delivery', 'Domicilio'],
    ['bar', 'Barra'],
  ])('el canal %s sin mesa se anuncia como «%s»', (channel, target) => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(
      ana,
      [{ name: 'Pizza', station: t.kitchen }],
      null,
      channel,
    )
    t.send(ana, order, items)
    expect(t.content(t.trabajos()[0]).target).toBe(target)
  })

  it('con mesa lleva «Mesa N», el mesero, el número de pedido del día y los comensales', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], t.table('7'))
    t.send(ana, order, items)
    expect(t.content(t.trabajos()[0])).toMatchObject({
      type: 'newOne',
      station: 'Cocina',
      target: 'Mesa 7',
      waiter: 'Ana',
      order: 1,
      guests: 2,
      number: 1,
    })
  })

  it('las opciones, notas, comensal y curso de cada plato viajan en el trabajo', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [
      {
        name: 'Tagliata',
        station: t.kitchen,
        options: ['Término medio', 'Sin sal'],
        notes: 'alergia al maní',
        guest: 3,
        course: 'main',
        quantity: 2,
      },
    ])
    t.send(ana, order, items)
    expect(t.content(t.trabajos()[0]).items).toEqual([
      {
        quantity: 2,
        name: 'Tagliata',
        guest: 3,
        course: 'main',
        options: ['Término medio', 'Sin sal'],
        notes: 'alergia al maní',
      },
    ])
  })

  it('una mesa que ya no existe no rompe la comanda', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], newId())
    t.send(ana, order, items)
    expect(t.content(t.trabajos()[0]).target).toBe('Mesa')
  })

  it('el nombre de la mesa con caracteres raros se imprime sin órdenes de impresora', async () => {
    const t = montarImpresion()
    const imp = conImpresoras(t)
    const ana = t.device('waiter')
    const table = t.table('\x1bp\x00T\x1dV1')
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza\x1b@', station: t.kitchen }], table)
    t.send(ana, order, items)
    await t.queue.runOnce()
    const bytes = imp.kitchen.papel.received[0] as Uint8Array
    expect(readEscpos(bytes).cuts).toBe(1)
    expect(readEscpos(bytes).text).toContain('Pizza')
  })
})

describe('cursos retenidos', () => {
  it('la comanda avisa los cursos que siguen en espera y deja de avisarlos al marcharlos', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const order = t.open(ana)
    ana.submit(order, 'CourseHeld', { course: 'dessert' })
    const main = t.add(ana, order, {
      name: 'Tagliata',
      station: t.kitchen,
      course: 'main',
    })
    const dessert = t.add(ana, order, {
      name: 'Tiramisú',
      station: t.postres,
      course: 'dessert',
    })
    expect(t.hub.order(order)?.items[dessert.id]?.status).toBe('held')
    t.send(ana, order, [main])
    expect(t.content(t.trabajos()[0]).heldCourses).toEqual(['dessert'])
    // Se marcha el postre: ahora sí se envía y ya no hay nada en espera.
    ana.submit(order, 'CourseFired', { course: 'dessert' })
    t.send(ana, order, [dessert])
    expect(t.content(t.trabajos().at(-1)).heldCourses).toEqual([])
  })

  it('varios cursos retenidos se avisan todos, y solo los que tienen platos', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const order = t.open(ana)
    ana.submit(order, 'CourseHeld', { course: 'main' })
    ana.submit(order, 'CourseHeld', { course: 'dessert' })
    const entry = t.add(ana, order, {
      name: 'Burrata',
      station: t.kitchen,
      course: 'entry',
    })
    t.add(ana, order, { name: 'Tagliata', station: t.kitchen, course: 'main' })
    t.send(ana, order, [entry])
    expect(t.content(t.trabajos()[0]).heldCourses).toEqual(['main'])
  })

  it('si el curso está retenido pero no hay platos de ese curso, no se avisa en espera', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const order = t.open(ana)
    ana.submit(order, 'CourseHeld', { course: 'dessert' })
    const dish = t.add(ana, order, { name: 'Risotto', station: t.kitchen })
    t.send(ana, order, [dish])
    expect(t.content(t.trabajos().at(-1)).heldCourses).toEqual([])
  })

  it('las reimpresiones no llevan el aviso de espera', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.device('waiter')
    const order = t.open(ana)
    const dish = t.add(ana, order, {
      name: 'Tagliata',
      station: t.kitchen,
      course: 'main',
    })
    t.add(ana, order, { name: 'Tiramisú', station: t.postres, course: 'dessert' })
    ana.submit(order, 'CourseHeld', { course: 'dessert' })
    const r = t.send(ana, order, [dish])
    expect(t.content(t.trabajos()[0]).heldCourses).toEqual(['dessert'])
    ana.submit(order, 'TicketReprinted', { ticket_id: r.tickets[0]?.ticket_id })
    expect(t.content(t.trabajos().at(-1))).toMatchObject({ type: 'reprinting', heldCourses: [] })
  })
})

describe('estaciones e impresoras', () => {
  it('una estación sin impresora no deja trabajos y el envío no falla', () => {
    const t = montarImpresion()
    t.impresoraNueva('Barra', [t.bar])
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [
      { name: 'Tagliata', station: t.kitchen },
      { name: 'Aperol', station: t.bar },
    ])
    const r = t.send(ana, order, items)
    expect(r.status).toBe('confirmed')
    expect(t.trabajos().map((f) => t.content(f).station)).toEqual(['Barra'])
    expect(t.fallosGuardar).toEqual([])
  })

  it('sin ninguna impresora no se crea nada', () => {
    const t = montarImpresion()
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    expect(t.send(ana, order, items).status).toBe('confirmed')
    expect(t.trabajos()).toEqual([])
  })

  it('dos impresoras para la misma estación: cada una recibe su copia', async () => {
    const t = montarImpresion()
    const a = t.impresoraNueva('Cocina 1', [t.kitchen])
    const b = t.impresoraNueva('Cocina 2', [t.kitchen])
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    expect(t.trabajos()).toHaveLength(2)
    await t.queue.runOnce()
    expect(a.papel.received).toHaveLength(1)
    expect(b.papel.received).toHaveLength(1)
  })

  it('una impresora de varias estaciones imprime las dos comandas, en orden', async () => {
    const t = montarImpresion()
    const unica = t.impresoraNueva('Todo', [t.kitchen, t.bar])
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [
      { name: 'Tagliata', station: t.kitchen },
      { name: 'Aperol', station: t.bar },
    ])
    t.send(ana, order, items)
    await t.queue.runOnce()
    expect(unica.papel.texts().map((x) => (x.includes('COCINA') ? 'cocina' : 'barra'))).toEqual([
      'cocina',
      'barra',
    ])
  })

  it('una impresora archivada no recibe comandas nuevas', () => {
    const t = montarImpresion()
    t.impresoraNueva('Vieja', [t.kitchen], { active: 0 })
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    expect(t.trabajos()).toEqual([])
  })

  it('una estación archivada con comandas viejas sigue imprimiendo con su nombre', async () => {
    const t = montarImpresion()
    const imp = t.impresoraNueva('Cocina', [t.kitchen])
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    t.db.prepare('UPDATE stations SET active = 0 WHERE id = ?').run(t.kitchen)
    await t.queue.runOnce()
    expect(imp.papel.texts()[0]).toContain('COCINA')
  })

  it('una estación que no existe en la base se imprime como «Estación»', () => {
    const t = montarImpresion()
    const ghost = newId()
    t.db.exec('PRAGMA foreign_keys = OFF')
    t.impresoraNueva('Fantasma', [ghost])
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: ghost }])
    t.send(ana, order, items)
    expect(t.content(t.trabajos()[0]).station).toBe('Estación')
  })
})

describe('un fallo al armar la comanda', () => {
  it('no rechaza el evento: el pedido queda enviado y el fallo se avisa', () => {
    const t = montarImpresion()
    t.impresoraNueva('Cocina', [t.kitchen])
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    // La tabla de la cola desaparece: insertar en ella revienta.
    t.db.exec('DROP TRIGGER print_jobs_no_delete')
    t.db.exec('DROP TABLE print_jobs')
    const r = t.send(ana, order, items)
    expect(r.status).toBe('confirmed')
    expect(t.hub.order(order)?.items[items[0]?.id as string]?.status).toBe('sent')
    expect(t.fallosGuardar).toHaveLength(1)
    expect(t.fallosGuardar[0]?.id).toBe(r.accepted?.id)
  })

  it('todo o nada: si falla la comanda de la barra no queda a medias la de la cocina', () => {
    const t = montarImpresion()
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    const bar = t.impresoraNueva('Barra', [t.bar])
    t.db.exec(
      `CREATE TRIGGER falla_barra BEFORE INSERT ON print_jobs
       WHEN NEW.printer_id = '${bar.id}'
       BEGIN SELECT RAISE(ABORT, 'impresora de la barra rota'); END`,
    )
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [
      { name: 'Tagliata', station: t.kitchen },
      { name: 'Aperol', station: t.bar },
    ])
    const r = t.send(ana, order, items)
    expect(r.status).toBe('confirmed')
    expect(t.fallosGuardar).toHaveLength(1)
    expect(t.trabajos()).toEqual([])
    void kitchen
    // El hub sigue aceptando eventos después.
    expect(ana.submit(order, 'ItemReady', { item_ids: [items[0]?.id] }).status).toBe('confirmed')
  })

  it('el error de armar una comanda viene con el id del evento para poder reimprimirla', () => {
    const t = montarImpresion()
    t.impresoraNueva('Cocina', [t.kitchen])
    t.db.exec('DROP TRIGGER print_jobs_no_delete')
    t.db.exec('DROP TABLE print_jobs')
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    const r = t.send(ana, order, items)
    expect(t.fallosGuardar.map((f) => f.id)).toEqual([r.accepted?.id])
  })
})

describe('varios restaurantes en la misma base', () => {
  function conOtroRestaurante(t: MontajeImpresion) {
    const other = newId()
    const now = t.clock
    t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
      )
      .run(other, other, '2026-10-24T20:00:00.000Z', '2026-10-24T20:00:00.000Z')
    void now
    const station = insertVersioned(
      t.db,
      'stations',
      other,
      { name: 'Cocina de otro', position: 1 },
      SISTEMA,
      '2026-10-24T20:00:00.000Z',
    )
    return { other, station }
  }

  it('una impresora de otro restaurante nunca recibe comandas de este, ni siquiera con la misma estación', async () => {
    const t = montarImpresion()
    const mia = t.impresoraNueva('Cocina', [t.kitchen])
    const { other } = conOtroRestaurante(t)
    const ajena = insertVersioned(
      t.db,
      'printers',
      other,
      {
        name: 'Ajena',
        connection: 'network',
        address: '10.9.9.9',
        port: 9100,
        width: 80,
        // Apunta (mal) a la estación de este restaurante.
        station_ids: JSON.stringify([t.kitchen]),
      },
      SISTEMA,
      '2026-10-24T20:00:00.000Z',
    )
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    const rows = t.trabajos()
    expect(rows.map((f) => f.printer_id)).toEqual([mia.id])
    expect(rows.some((f) => f.printer_id === ajena)).toBe(false)
  })

  it('la cola de un restaurante no imprime ni cuenta los trabajos del otro', async () => {
    const t = montarImpresion()
    const mia = t.impresoraNueva('Cocina', [t.kitchen])
    const { other } = conOtroRestaurante(t)
    const colaDelOtro = t.crearCola({ restaurantId: other })
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    await colaDelOtro.runOnce()
    expect(mia.papel.received).toHaveLength(0)
    expect(colaDelOtro.status()).toEqual([])
    expect(t.queue.status()).toMatchObject([{ id: mia.id, pendingList: 1 }])
    await t.queue.runOnce()
    expect(mia.papel.received).toHaveLength(1)
  })

  it('el mesero, la mesa y la estación se buscan en el restaurante del evento', () => {
    const t = montarImpresion()
    t.impresoraNueva('Cocina', [t.kitchen])
    const { other } = conOtroRestaurante(t)
    // Otro restaurante con un usuario del mismo nombre no cambia el mesero impreso.
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], t.table('3'))
    t.send(ana, order, items)
    expect(t.content(t.trabajos()[0])).toMatchObject({
      waiter: 'Ana',
      target: 'Mesa 3',
      station: 'Cocina',
    })
    void other
  })
})
