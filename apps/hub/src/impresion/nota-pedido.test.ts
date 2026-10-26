import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { montarImpresion } from './montaje-impresion'

// La nota de todo el pedido (`OrderNoteChanged`): entra por HubSync como cualquier evento del
// pedido, y la comanda nueva siguiente la lleva arriba como «NOTA DEL PEDIDO». Lo que ya salió
// no se vuelve a imprimir (la pantalla de la app lo avisa).

function montar() {
  const t = montarImpresion()
  const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
  const bar = t.impresoraNueva('Barra', [t.bar])
  const ana = t.device('waiter')
  return { t, kitchen, bar, ana }
}

const comoNota = (text: string) => /NOTA DEL PEDIDO: ([^\]\n]*)/.exec(text)?.[1]?.trim()

describe('NotaPedidoCambiada por HubSync', () => {
  it('se confirma, queda en la secuencia y no imprime nada por sí sola', async () => {
    const { t, ana } = montar()
    const order = t.open(ana)
    const r = ana.mandar(order, 'OrderNoteChanged', { notes: 'alérgico al maní' })
    expect(r.status).toBe('confirmed')
    expect(r.accepted?.sequence).toBeGreaterThan(0)
    expect(t.trabajos()).toHaveLength(0)
    await t.cola.runOnce()
    expect(t.fallosGuardar).toEqual([])
  })

  it('el mismo evento reenviado (mismo id) no se aplica dos veces', () => {
    const { t, ana } = montar()
    const order = t.open(ana)
    const same = { id: newId() }
    const a = ana.mandar(order, 'OrderNoteChanged', { notes: 'una vez' }, same)
    const b = ana.mandar(order, 'OrderNoteChanged', { notes: 'una vez' }, same)
    expect(a.status).toBe('confirmed')
    // Idempotente: misma respuesta, sin aceptar otra vez.
    expect(b.status).toBe('confirmed')
    expect(b.accepted).toBeUndefined()
    const rows = t.db
      .prepare("SELECT count(*) AS n FROM events WHERE type = 'OrderNoteChanged'")
      .get()
    expect(rows).toEqual({ n: 1 })
  })

  it('se rechaza si el texto pasa de 500 caracteres o no es texto', () => {
    const { t, ana } = montar()
    const order = t.open(ana)
    for (const data of [{ notes: 'a'.repeat(501) }, { notes: 7 }, {}, { notes: 'x', y: 1 }]) {
      const r = ana.mandar(order, 'OrderNoteChanged', data)
      expect(r.status, JSON.stringify(data).slice(0, 40)).toBe('rejected')
    }
  })

  it('en un pedido cancelado se rechaza por el reductor (no se puede cambiar la nota)', () => {
    const { t, ana } = montar()
    const register = t.device('admin', 'register')
    const order = t.open(ana)
    expect(ana.mandar(order, 'OrderNoteChanged', { notes: 'antes' }).status).toBe('confirmed')
    expect(
      register.mandar(order, 'OrderCanceled', {}, { reason: 'Se fueron sin pedir' }).status,
    ).toBe('confirmed')
    expect(ana.mandar(order, 'OrderNoteChanged', { notes: 'después' }).status).toBe('rejected')
  })

  it('un evento con nota de otro equipo sin estar al día se acepta (la nota no choca con ítems)', () => {
    const { t, ana } = montar()
    const luis = t.device('waiter2')
    const { order } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    // Luis no sabe de lo último que pasó en el hub: su base es 0.
    const r = luis.mandar(order, 'OrderNoteChanged', { notes: 'todo junto' }, { base_sequence: 0 })
    expect(r.status).toBe('confirmed')
  })
})

describe('la comanda nueva lleva la nota del pedido', () => {
  it('el contenido guardado y el papel traen «NOTA DEL PEDIDO» con el texto', async () => {
    const { t, kitchen, ana } = montar()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    ana.mandar(order, 'OrderNoteChanged', { notes: 'alérgico al maní' })
    t.send(ana, order, items)
    expect(t.content(t.trabajos()[0]).orderNote).toBe('alérgico al maní')
    await t.cola.runOnce()
    const text = kitchen.papel.texts()[0] as string
    expect(text).toContain('NOTA DEL PEDIDO: alérgico al maní')
    // Arriba, antes de los ítems.
    expect(text.indexOf('NOTA DEL PEDIDO')).toBeLessThan(text.indexOf('Tagliata'))
  })

  it('sin nota no sale el encabezado y el contenido lleva null', async () => {
    const { t, kitchen, ana } = montar()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    expect(t.content(t.trabajos()[0]).orderNote).toBeNull()
    await t.cola.runOnce()
    expect(kitchen.papel.texts()[0]).not.toContain('NOTA DEL PEDIDO')
  })

  it('cada estación del mismo envío lleva la nota', async () => {
    const { t, kitchen, bar, ana } = montar()
    const { order, items } = t.orderWith(ana, [
      { name: 'Tagliata', station: t.kitchen },
      { name: 'Aperol Spritz', station: t.bar },
    ])
    ana.mandar(order, 'OrderNoteChanged', { notes: 'cumpleaños: velita en el postre' })
    t.send(ana, order, items)
    await t.cola.runOnce()
    for (const p of [kitchen.papel, bar.papel]) {
      expect(p.texts()[0]).toContain('NOTA DEL PEDIDO: cumpleaños: velita en el postre')
    }
  })

  it('la nota se recorta: los espacios de los bordes no llegan al papel', async () => {
    const { t, kitchen, ana } = montar()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    ana.mandar(order, 'OrderNoteChanged', { notes: '   sin sal   ' })
    t.send(ana, order, items)
    expect(t.content(t.trabajos()[0]).orderNote).toBe('sin sal')
    await t.cola.runOnce()
    expect(comoNota(kitchen.papel.texts()[0] as string)).toBe('sin sal')
  })

  it('una nota de solo espacios o vacía equivale a no tener nota', async () => {
    const { t, ana } = montar()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    ana.mandar(order, 'OrderNoteChanged', { notes: 'algo' })
    ana.mandar(order, 'OrderNoteChanged', { notes: '    ' })
    t.send(ana, order, items)
    expect(t.content(t.trabajos()[0]).orderNote).toBeNull()
  })

  it('quitar la nota (null) antes de enviar: la comanda sale sin ella', async () => {
    const { t, kitchen, ana } = montar()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    ana.mandar(order, 'OrderNoteChanged', { notes: 'algo' })
    ana.mandar(order, 'OrderNoteChanged', { notes: null })
    t.send(ana, order, items)
    await t.cola.runOnce()
    expect(kitchen.papel.texts()[0]).not.toContain('NOTA DEL PEDIDO')
  })

  it('cambiar la nota entre dos envíos: cada comanda nueva lleva la que había al enviar', async () => {
    const { t, kitchen, ana } = montar()
    const { order, items } = t.orderWith(ana, [
      { name: 'Tagliata', station: t.kitchen },
      { name: 'Risotto', station: t.kitchen },
    ])
    ana.mandar(order, 'OrderNoteChanged', { notes: 'primera' })
    t.send(ana, order, [items[0] as (typeof items)[0]])
    // Con la Tagliata ya en cocina, cambiar la nota saca además una comanda «NOTA NUEVA».
    ana.mandar(order, 'OrderNoteChanged', { notes: 'segunda' })
    t.send(ana, order, [items[1] as (typeof items)[0]])
    await t.cola.runOnce()
    const texts = kitchen.papel.texts()
    expect(texts).toHaveLength(3)
    expect(comoNota(texts[0] as string)).toBe('primera')
    expect(texts[1]).toContain('NOTA NUEVA')
    expect(comoNota(texts[1] as string)).toBe('segunda')
    expect(texts[2]).not.toContain('NOTA NUEVA')
    expect(comoNota(texts[2] as string)).toBe('segunda')
  })

  it('poner la nota con platos en cocina saca una comanda «NOTA NUEVA» sin ítems; la original no se reimprime', async () => {
    const { t, kitchen, ana } = montar()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    ana.mandar(order, 'OrderNoteChanged', { notes: 'tarde' })
    await t.cola.runOnce()
    const texts = kitchen.papel.texts()
    expect(texts).toHaveLength(2)
    expect(texts[0]).not.toContain('NOTA DEL PEDIDO')
    expect(texts[1]).toContain('NOTA NUEVA')
    expect(texts[1]).toContain('NOTA DEL PEDIDO: tarde')
    expect(texts[1]).not.toContain('Tagliata')
    expect(t.content(t.trabajos()[1])).toMatchObject({
      type: 'note',
      orderNote: 'tarde',
      items: [],
    })
  })

  it('la siguiente comanda nueva (otro ítem agregado después) sí lleva la nota puesta tarde', async () => {
    const { t, kitchen, ana } = montar()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    ana.mandar(order, 'OrderNoteChanged', { notes: 'tarde' })
    const other = t.add(ana, order, { name: 'Risotto', station: t.kitchen })
    t.send(ana, order, [other])
    await t.cola.runOnce()
    const texts = kitchen.papel.texts()
    // Original sin nota, el aviso «NOTA NUEVA» y la comanda nueva del Risotto.
    expect(texts).toHaveLength(3)
    expect(texts[0]).not.toContain('NOTA DEL PEDIDO')
    expect(texts[1]).toContain('NOTA NUEVA')
    expect(texts[2]).toContain('NOTA DEL PEDIDO: tarde')
    expect(texts[2]).not.toContain('NOTA NUEVA')
    expect(texts[2]).toContain('Risotto')
  })

  it('al marchar un curso retenido, la comanda que sale lleva la nota', async () => {
    const { t, kitchen, ana } = montar()
    const order = t.open(ana)
    const main = t.add(ana, order, {
      name: 'Tagliata',
      station: t.kitchen,
      course: 'main',
    })
    ana.mandar(order, 'OrderNoteChanged', { notes: 'sin picante' })
    ana.mandar(order, 'CourseHeld', { course: 'main' })
    ana.mandar(order, 'CourseFired', { course: 'main' })
    t.send(ana, order, [main])
    await t.cola.runOnce()
    const texts = kitchen.papel.texts()
    expect(texts.length).toBeGreaterThan(0)
    for (const text of texts) expect(text).toContain('NOTA DEL PEDIDO: sin picante')
  })

  it('una reimpresión lleva la nota vigente, no la que había al enviar', async () => {
    const { t, kitchen, ana } = montar()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    const sent = t.send(ana, order, items)
    ana.mandar(order, 'OrderNoteChanged', { notes: 'cambió después' })
    ana.mandar(order, 'TicketReprinted', { ticket_id: sent.tickets[0]?.ticket_id })
    await t.cola.runOnce()
    const texts = kitchen.papel.texts()
    // Original, aviso «NOTA NUEVA» y la reimpresión.
    expect(texts).toHaveLength(3)
    expect(texts[0]).not.toContain('NOTA DEL PEDIDO')
    expect(texts[1]).toContain('NOTA NUEVA')
    expect(texts[2]).toContain('REIMPRESIÓN')
    expect(texts[2]).toContain('NOTA DEL PEDIDO: cambió después')
  })

  it('la comanda de anulación no repite la nota del pedido (ya salió con la original)', async () => {
    const { t, kitchen, ana } = montar()
    const register = t.device('admin', 'register')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    ana.mandar(order, 'OrderNoteChanged', { notes: 'alérgico al maní' })
    t.send(ana, order, items)
    register.mandar(order, 'ItemVoided', {
      item_id: items[0]?.id,
      quantity: 1,
      already_prepared: false,
      ticket_id: null,
    })
    await t.cola.runOnce()
    const texts = kitchen.papel.texts()
    expect(texts).toHaveLength(2)
    expect(texts[0]).toContain('NOTA DEL PEDIDO')
    expect(texts[1]).toContain('ANULA')
    expect(texts[1]).not.toContain('NOTA DEL PEDIDO')
    expect(t.content(t.trabajos()[1]).orderNote).toBeNull()
  })

  it('acentos, eñes y signos pasan a la impresora sin perder letras', async () => {
    const { t, kitchen, ana } = montar()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    ana.mandar(order, 'OrderNoteChanged', { notes: 'Alérgico al maní; ñandú ¡ya! (rápido)' })
    t.send(ana, order, items)
    await t.cola.runOnce()
    expect((kitchen.papel.texts()[0] as string).replace(/\s+/g, ' ')).toContain(
      'Alérgico al maní; ñandú ¡ya! (rápido)',
    )
  })

  it('una nota de 500 caracteres no pierde palabras en el papel (se parte en renglones)', async () => {
    const { t, kitchen, ana } = montar()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    const words = Array.from({ length: 70 }, (_, i) => `p${String(i).padStart(2, '0')}xx`)
    const long = words.join(' ').slice(0, 500)
    expect(long.length).toBeLessThanOrEqual(500)
    ana.mandar(order, 'OrderNoteChanged', { notes: long })
    t.send(ana, order, items)
    await t.cola.runOnce()
    const text = (kitchen.papel.texts()[0] as string).replace(/\s+/g, ' ')
    const completas = long.split(' ').slice(0, -1) // la última pudo cortarse con el slice
    for (const word of completas) expect(text, word).toContain(word)
  })
})

describe('comanda «NOTA NUEVA» al cambiar la nota con platos en cocina', () => {
  it('quitar la nota saca «SE QUITÓ LA NOTA DEL PEDIDO»', async () => {
    const { t, kitchen, ana } = montar()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    ana.mandar(order, 'OrderNoteChanged', { notes: 'alérgico al maní' })
    t.send(ana, order, items)
    ana.mandar(order, 'OrderNoteChanged', { notes: null })
    await t.cola.runOnce()
    const texts = kitchen.papel.texts()
    expect(texts).toHaveLength(2)
    expect(texts[1]).toContain('SE QUITÓ LA NOTA DEL PEDIDO')
    expect(texts[1]).not.toContain('NOTA DEL PEDIDO: ')
  })

  it('repetir la misma nota (o quitar la que no hay) no imprime nada', async () => {
    const { t, kitchen, ana } = montar()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    ana.mandar(order, 'OrderNoteChanged', { notes: 'igual' })
    t.send(ana, order, items)
    ana.mandar(order, 'OrderNoteChanged', { notes: '  igual  ' })
    ana.mandar(order, 'OrderNoteChanged', { notes: 'igual' })
    await t.cola.runOnce()
    expect(kitchen.papel.recibidos).toHaveLength(1)
    const other = t.orderWith(ana, [{ name: 'Risotto', station: t.kitchen }])
    t.send(ana, other.order, other.items)
    ana.mandar(other.order, 'OrderNoteChanged', { notes: null })
    ana.mandar(other.order, 'OrderNoteChanged', { notes: '   ' })
    await t.cola.runOnce()
    expect(kitchen.papel.recibidos).toHaveLength(2)
  })

  it('con ítems solo sin enviar no imprime nada (la nota saldrá en la comanda nueva)', async () => {
    const { t, ana } = montar()
    const { order } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    ana.mandar(order, 'OrderNoteChanged', { notes: 'algo' })
    expect(t.trabajos()).toHaveLength(0)
  })

  it('solo va a las estaciones con algo todavía en cocina: no a las que ya entregaron todo', async () => {
    const { t, kitchen, bar, ana } = montar()
    const { order, items } = t.orderWith(ana, [
      { name: 'Tagliata', station: t.kitchen },
      { name: 'Aperol Spritz', station: t.bar },
    ])
    t.send(ana, order, items)
    ana.mandar(order, 'ItemServed', { item_ids: [items[1]?.id] })
    ana.mandar(order, 'OrderNoteChanged', { notes: 'alérgico al maní' })
    await t.cola.runOnce()
    expect(kitchen.papel.texts().at(-1)).toContain('NOTA NUEVA')
    expect(bar.papel.recibidos).toHaveLength(1)
    expect(bar.papel.texts()[0]).not.toContain('NOTA NUEVA')
  })

  it('con dos estaciones con platos en cocina, cada una recibe su aviso', async () => {
    const { t, kitchen, bar, ana } = montar()
    const { order, items } = t.orderWith(ana, [
      { name: 'Tagliata', station: t.kitchen },
      { name: 'Aperol Spritz', station: t.bar },
    ])
    t.send(ana, order, items)
    ana.mandar(order, 'OrderNoteChanged', { notes: 'cumpleaños' })
    await t.cola.runOnce()
    for (const p of [kitchen.papel, bar.papel]) {
      expect(p.recibidos).toHaveLength(2)
      expect(p.texts()[1]).toContain('NOTA NUEVA')
    }
  })

  it('un plato anulado por completo ya no cuenta como «en cocina»', async () => {
    const { t, kitchen, ana } = montar()
    const register = t.device('admin', 'register')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    register.mandar(order, 'ItemVoided', {
      item_id: items[0]?.id,
      quantity: 1,
      already_prepared: false,
      ticket_id: null,
    })
    ana.mandar(order, 'OrderNoteChanged', { notes: 'ya nada' })
    await t.cola.runOnce()
    // La comanda original y la de anulación; ningún «NOTA NUEVA».
    expect(kitchen.papel.texts().some((x) => x.includes('NOTA NUEVA'))).toBe(false)
  })

  it('el mismo evento reenviado no imprime el aviso dos veces', async () => {
    const { t, kitchen, ana } = montar()
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    const same = { id: newId() }
    ana.mandar(order, 'OrderNoteChanged', { notes: 'una vez' }, same)
    ana.mandar(order, 'OrderNoteChanged', { notes: 'una vez' }, same)
    await t.cola.runOnce()
    expect(kitchen.papel.recibidos).toHaveLength(2)
  })
})
