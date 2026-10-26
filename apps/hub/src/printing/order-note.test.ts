import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { setupPrinting } from './printing-setup'

// The note for the whole order (`OrderNoteChanged`): it comes in through HubSync like any order
// event, and the next new ticket carries it at the top as «NOTA DEL PEDIDO». What already printed
// is not printed again (the app screen alerts about it).

function setup() {
  const t = setupPrinting()
  const kitchen = t.newPrinter('Cocina', [t.kitchen])
  const bar = t.newPrinter('Barra', [t.bar])
  const ana = t.device('waiter')
  return { t, kitchen, bar, ana }
}

const asNote = (text: string) => /NOTA DEL PEDIDO: ([^\]\n]*)/.exec(text)?.[1]?.trim()

describe('OrderNoteChanged through HubSync', () => {
  it('is confirmed, stays in the sequence and prints nothing by itself', async () => {
    const { t, ana } = setup()
    const order = t.open(ana)
    const r = ana.submit(order, 'OrderNoteChanged', { notes: 'alérgico al maní' })
    expect(r.status).toBe('confirmed')
    expect(r.accepted?.sequence).toBeGreaterThan(0)
    expect(t.jobs()).toHaveLength(0)
    await t.queue.runOnce()
    expect(t.saveFailures).toEqual([])
  })

  it('the same event resent (same id) is not applied twice', () => {
    const { t, ana } = setup()
    const order = t.open(ana)
    const same = { id: newId() }
    const a = ana.submit(order, 'OrderNoteChanged', { notes: 'una vez' }, same)
    const b = ana.submit(order, 'OrderNoteChanged', { notes: 'una vez' }, same)
    expect(a.status).toBe('confirmed')
    // Idempotent: same response, without accepting again.
    expect(b.status).toBe('confirmed')
    expect(b.accepted).toBeUndefined()
    const rows = t.db
      .prepare("SELECT count(*) AS n FROM events WHERE type = 'OrderNoteChanged'")
      .get()
    expect(rows).toEqual({ n: 1 })
  })

  it('is rejected if the text exceeds 500 characters or is not text', () => {
    const { t, ana } = setup()
    const order = t.open(ana)
    for (const data of [{ notes: 'a'.repeat(501) }, { notes: 7 }, {}, { notes: 'x', y: 1 }]) {
      const r = ana.submit(order, 'OrderNoteChanged', data)
      expect(r.status, JSON.stringify(data).slice(0, 40)).toBe('rejected')
    }
  })

  it('on a canceled order it is rejected by the reducer (the note cannot be changed)', () => {
    const { t, ana } = setup()
    const register = t.device('admin', 'register')
    const order = t.open(ana)
    expect(ana.submit(order, 'OrderNoteChanged', { notes: 'antes' }).status).toBe('confirmed')
    expect(
      register.submit(order, 'OrderCanceled', {}, { reason: 'Se fueron sin pedir' }).status,
    ).toBe('confirmed')
    expect(ana.submit(order, 'OrderNoteChanged', { notes: 'después' }).status).toBe('rejected')
  })

  it('a note event from another device that is not up to date is accepted (the note does not conflict with items)', () => {
    const { t, ana } = setup()
    const luis = t.device('waiter2')
    const { order } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    // Luis does not know about the latest on the hub: his base is 0.
    const r = luis.submit(order, 'OrderNoteChanged', { notes: 'todo junto' }, { base_sequence: 0 })
    expect(r.status).toBe('confirmed')
  })
})

describe('the new ticket carries the order note', () => {
  it('the saved content and the paper carry «NOTA DEL PEDIDO» with the text', async () => {
    const { t, kitchen, ana } = setup()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    ana.submit(order, 'OrderNoteChanged', { notes: 'alérgico al maní' })
    t.send(ana, order, items)
    expect(t.content(t.jobs()[0]).orderNote).toBe('alérgico al maní')
    await t.queue.runOnce()
    const text = kitchen.paper.texts()[0] as string
    expect(text).toContain('NOTA DEL PEDIDO: alérgico al maní')
    // At the top, before the items.
    expect(text.indexOf('NOTA DEL PEDIDO')).toBeLessThan(text.indexOf('Tagliata'))
  })

  it('without a note the header is not printed and the content has null', async () => {
    const { t, kitchen, ana } = setup()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    expect(t.content(t.jobs()[0]).orderNote).toBeNull()
    await t.queue.runOnce()
    expect(kitchen.paper.texts()[0]).not.toContain('NOTA DEL PEDIDO')
  })

  it('each station of the same send carries the note', async () => {
    const { t, kitchen, bar, ana } = setup()
    const { order, items } = t.orderWith(ana, [
      { name: 'Tagliata', station: t.kitchen },
      { name: 'Aperol Spritz', station: t.bar },
    ])
    ana.submit(order, 'OrderNoteChanged', { notes: 'cumpleaños: velita en el postre' })
    t.send(ana, order, items)
    await t.queue.runOnce()
    for (const p of [kitchen.paper, bar.paper]) {
      expect(p.texts()[0]).toContain('NOTA DEL PEDIDO: cumpleaños: velita en el postre')
    }
  })

  it('the note is trimmed: leading and trailing spaces do not reach the paper', async () => {
    const { t, kitchen, ana } = setup()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    ana.submit(order, 'OrderNoteChanged', { notes: '   sin sal   ' })
    t.send(ana, order, items)
    expect(t.content(t.jobs()[0]).orderNote).toBe('sin sal')
    await t.queue.runOnce()
    expect(asNote(kitchen.paper.texts()[0] as string)).toBe('sin sal')
  })

  it('a note of only spaces or empty is the same as no note', async () => {
    const { t, ana } = setup()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    ana.submit(order, 'OrderNoteChanged', { notes: 'algo' })
    ana.submit(order, 'OrderNoteChanged', { notes: '    ' })
    t.send(ana, order, items)
    expect(t.content(t.jobs()[0]).orderNote).toBeNull()
  })

  it('removing the note (null) before sending: the ticket prints without it', async () => {
    const { t, kitchen, ana } = setup()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    ana.submit(order, 'OrderNoteChanged', { notes: 'algo' })
    ana.submit(order, 'OrderNoteChanged', { notes: null })
    t.send(ana, order, items)
    await t.queue.runOnce()
    expect(kitchen.paper.texts()[0]).not.toContain('NOTA DEL PEDIDO')
  })

  it('changing the note between two sends: each new ticket carries the one there at send time', async () => {
    const { t, kitchen, ana } = setup()
    const { order, items } = t.orderWith(ana, [
      { name: 'Tagliata', station: t.kitchen },
      { name: 'Risotto', station: t.kitchen },
    ])
    ana.submit(order, 'OrderNoteChanged', { notes: 'primera' })
    t.send(ana, order, [items[0] as (typeof items)[0]])
    // With the Tagliata already in the kitchen, changing the note also prints a «NOTA NUEVA».
    ana.submit(order, 'OrderNoteChanged', { notes: 'segunda' })
    t.send(ana, order, [items[1] as (typeof items)[0]])
    await t.queue.runOnce()
    const texts = kitchen.paper.texts()
    expect(texts).toHaveLength(3)
    expect(asNote(texts[0] as string)).toBe('primera')
    expect(texts[1]).toContain('NOTA NUEVA')
    expect(asNote(texts[1] as string)).toBe('segunda')
    expect(texts[2]).not.toContain('NOTA NUEVA')
    expect(asNote(texts[2] as string)).toBe('segunda')
  })

  it('setting the note with dishes in the kitchen prints a «NOTA NUEVA» ticket without items; the original is not reprinted', async () => {
    const { t, kitchen, ana } = setup()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    ana.submit(order, 'OrderNoteChanged', { notes: 'tarde' })
    await t.queue.runOnce()
    const texts = kitchen.paper.texts()
    expect(texts).toHaveLength(2)
    expect(texts[0]).not.toContain('NOTA DEL PEDIDO')
    expect(texts[1]).toContain('NOTA NUEVA')
    expect(texts[1]).toContain('NOTA DEL PEDIDO: tarde')
    expect(texts[1]).not.toContain('Tagliata')
    expect(t.content(t.jobs()[1])).toMatchObject({
      type: 'note',
      orderNote: 'tarde',
      items: [],
    })
  })

  it('the next new ticket (another item added later) does carry the note set late', async () => {
    const { t, kitchen, ana } = setup()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    ana.submit(order, 'OrderNoteChanged', { notes: 'tarde' })
    const other = t.add(ana, order, { name: 'Risotto', station: t.kitchen })
    t.send(ana, order, [other])
    await t.queue.runOnce()
    const texts = kitchen.paper.texts()
    // Original without a note, the «NOTA NUEVA» alert and the new Risotto ticket.
    expect(texts).toHaveLength(3)
    expect(texts[0]).not.toContain('NOTA DEL PEDIDO')
    expect(texts[1]).toContain('NOTA NUEVA')
    expect(texts[2]).toContain('NOTA DEL PEDIDO: tarde')
    expect(texts[2]).not.toContain('NOTA NUEVA')
    expect(texts[2]).toContain('Risotto')
  })

  it('when firing a held course, the ticket that prints carries the note', async () => {
    const { t, kitchen, ana } = setup()
    const order = t.open(ana)
    const main = t.add(ana, order, {
      name: 'Tagliata',
      station: t.kitchen,
      course: 'main',
    })
    ana.submit(order, 'OrderNoteChanged', { notes: 'sin picante' })
    ana.submit(order, 'CourseHeld', { course: 'main' })
    ana.submit(order, 'CourseFired', { course: 'main' })
    t.send(ana, order, [main])
    await t.queue.runOnce()
    const texts = kitchen.paper.texts()
    expect(texts.length).toBeGreaterThan(0)
    for (const text of texts) expect(text).toContain('NOTA DEL PEDIDO: sin picante')
  })

  it('a reprint carries the current note, not the one there at send time', async () => {
    const { t, kitchen, ana } = setup()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    const sent = t.send(ana, order, items)
    ana.submit(order, 'OrderNoteChanged', { notes: 'cambió después' })
    ana.submit(order, 'TicketReprinted', { ticket_id: sent.tickets[0]?.ticket_id })
    await t.queue.runOnce()
    const texts = kitchen.paper.texts()
    // Original, «NOTA NUEVA» alert and the reprint.
    expect(texts).toHaveLength(3)
    expect(texts[0]).not.toContain('NOTA DEL PEDIDO')
    expect(texts[1]).toContain('NOTA NUEVA')
    expect(texts[2]).toContain('REIMPRESIÓN')
    expect(texts[2]).toContain('NOTA DEL PEDIDO: cambió después')
  })

  it('the void ticket does not repeat the order note (it already printed with the original)', async () => {
    const { t, kitchen, ana } = setup()
    const register = t.device('admin', 'register')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    ana.submit(order, 'OrderNoteChanged', { notes: 'alérgico al maní' })
    t.send(ana, order, items)
    register.submit(order, 'ItemVoided', {
      item_id: items[0]?.id,
      quantity: 1,
      already_prepared: false,
      ticket_id: null,
    })
    await t.queue.runOnce()
    const texts = kitchen.paper.texts()
    expect(texts).toHaveLength(2)
    expect(texts[0]).toContain('NOTA DEL PEDIDO')
    expect(texts[1]).toContain('ANULA')
    expect(texts[1]).not.toContain('NOTA DEL PEDIDO')
    expect(t.content(t.jobs()[1]).orderNote).toBeNull()
  })

  it('accents, ñ and symbols reach the printer without losing letters', async () => {
    const { t, kitchen, ana } = setup()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    ana.submit(order, 'OrderNoteChanged', { notes: 'Alérgico al maní; ñandú ¡ya! (rápido)' })
    t.send(ana, order, items)
    await t.queue.runOnce()
    expect((kitchen.paper.texts()[0] as string).replace(/\s+/g, ' ')).toContain(
      'Alérgico al maní; ñandú ¡ya! (rápido)',
    )
  })

  it('a 500-character note loses no words on paper (it wraps into lines)', async () => {
    const { t, kitchen, ana } = setup()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    const words = Array.from({ length: 70 }, (_, i) => `p${String(i).padStart(2, '0')}xx`)
    const long = words.join(' ').slice(0, 500)
    expect(long.length).toBeLessThanOrEqual(500)
    ana.submit(order, 'OrderNoteChanged', { notes: long })
    t.send(ana, order, items)
    await t.queue.runOnce()
    const text = (kitchen.paper.texts()[0] as string).replace(/\s+/g, ' ')
    const completeWords = long.split(' ').slice(0, -1) // the last one may be cut by the slice
    for (const word of completeWords) expect(text, word).toContain(word)
  })
})

describe('«NOTA NUEVA» ticket when changing the note with dishes in the kitchen', () => {
  it('removing the note prints «SE QUITÓ LA NOTA DEL PEDIDO»', async () => {
    const { t, kitchen, ana } = setup()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    ana.submit(order, 'OrderNoteChanged', { notes: 'alérgico al maní' })
    t.send(ana, order, items)
    ana.submit(order, 'OrderNoteChanged', { notes: null })
    await t.queue.runOnce()
    const texts = kitchen.paper.texts()
    expect(texts).toHaveLength(2)
    expect(texts[1]).toContain('SE QUITÓ LA NOTA DEL PEDIDO')
    expect(texts[1]).not.toContain('NOTA DEL PEDIDO: ')
  })

  it('repeating the same note (or removing a nonexistent one) prints nothing', async () => {
    const { t, kitchen, ana } = setup()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    ana.submit(order, 'OrderNoteChanged', { notes: 'igual' })
    t.send(ana, order, items)
    ana.submit(order, 'OrderNoteChanged', { notes: '  igual  ' })
    ana.submit(order, 'OrderNoteChanged', { notes: 'igual' })
    await t.queue.runOnce()
    expect(kitchen.paper.received).toHaveLength(1)
    const other = t.orderWith(ana, [{ name: 'Risotto', station: t.kitchen }])
    t.send(ana, other.order, other.items)
    ana.submit(other.order, 'OrderNoteChanged', { notes: null })
    ana.submit(other.order, 'OrderNoteChanged', { notes: '   ' })
    await t.queue.runOnce()
    expect(kitchen.paper.received).toHaveLength(2)
  })

  it('with only unsent items it prints nothing (the note will go on the new ticket)', async () => {
    const { t, ana } = setup()
    const { order } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    ana.submit(order, 'OrderNoteChanged', { notes: 'algo' })
    expect(t.jobs()).toHaveLength(0)
  })

  it('only goes to stations with something still in the kitchen: not to those that delivered everything', async () => {
    const { t, kitchen, bar, ana } = setup()
    const { order, items } = t.orderWith(ana, [
      { name: 'Tagliata', station: t.kitchen },
      { name: 'Aperol Spritz', station: t.bar },
    ])
    t.send(ana, order, items)
    ana.submit(order, 'ItemServed', { item_ids: [items[1]?.id] })
    ana.submit(order, 'OrderNoteChanged', { notes: 'alérgico al maní' })
    await t.queue.runOnce()
    expect(kitchen.paper.texts().at(-1)).toContain('NOTA NUEVA')
    expect(bar.paper.received).toHaveLength(1)
    expect(bar.paper.texts()[0]).not.toContain('NOTA NUEVA')
  })

  it('with two stations with dishes in the kitchen, each gets its alert', async () => {
    const { t, kitchen, bar, ana } = setup()
    const { order, items } = t.orderWith(ana, [
      { name: 'Tagliata', station: t.kitchen },
      { name: 'Aperol Spritz', station: t.bar },
    ])
    t.send(ana, order, items)
    ana.submit(order, 'OrderNoteChanged', { notes: 'cumpleaños' })
    await t.queue.runOnce()
    for (const p of [kitchen.paper, bar.paper]) {
      expect(p.received).toHaveLength(2)
      expect(p.texts()[1]).toContain('NOTA NUEVA')
    }
  })

  it('a fully voided dish no longer counts as «in the kitchen»', async () => {
    const { t, kitchen, ana } = setup()
    const register = t.device('admin', 'register')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    register.submit(order, 'ItemVoided', {
      item_id: items[0]?.id,
      quantity: 1,
      already_prepared: false,
      ticket_id: null,
    })
    ana.submit(order, 'OrderNoteChanged', { notes: 'ya nada' })
    await t.queue.runOnce()
    // The original ticket and the void ticket; no «NOTA NUEVA».
    expect(kitchen.paper.texts().some((x) => x.includes('NOTA NUEVA'))).toBe(false)
  })

  it('the same event resent does not print the alert twice', async () => {
    const { t, kitchen, ana } = setup()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    const same = { id: newId() }
    ana.submit(order, 'OrderNoteChanged', { notes: 'una vez' }, same)
    ana.submit(order, 'OrderNoteChanged', { notes: 'una vez' }, same)
    await t.queue.runOnce()
    expect(kitchen.paper.received).toHaveLength(2)
  })
})
