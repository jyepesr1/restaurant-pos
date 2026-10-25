import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { montarImpresion } from './montaje-impresion'

// La nota de todo el pedido (`NotaPedidoCambiada`): entra por HubSync como cualquier evento del
// pedido, y la comanda nueva siguiente la lleva arriba como «NOTA DEL PEDIDO». Lo que ya salió
// no se vuelve a imprimir (la pantalla de la app lo avisa).

function montar() {
  const t = montarImpresion()
  const cocina = t.impresoraNueva('Cocina', [t.cocina])
  const barra = t.impresoraNueva('Barra', [t.barra])
  const ana = t.equipo('mesero')
  return { t, cocina, barra, ana }
}

const comoNota = (texto: string) => /NOTA DEL PEDIDO: ([^\]\n]*)/.exec(texto)?.[1]?.trim()

describe('NotaPedidoCambiada por HubSync', () => {
  it('se confirma, queda en la secuencia y no imprime nada por sí sola', async () => {
    const { t, ana } = montar()
    const pedido = t.abrir(ana)
    const r = ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'alérgico al maní' })
    expect(r.estado).toBe('confirmado')
    expect(r.aceptado?.secuencia).toBeGreaterThan(0)
    expect(t.trabajos()).toHaveLength(0)
    await t.cola.vuelta()
    expect(t.fallosGuardar).toEqual([])
  })

  it('el mismo evento reenviado (mismo id) no se aplica dos veces', () => {
    const { t, ana } = montar()
    const pedido = t.abrir(ana)
    const mismo = { id: nuevoId() }
    const a = ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'una vez' }, mismo)
    const b = ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'una vez' }, mismo)
    expect(a.estado).toBe('confirmado')
    // Idempotente: misma respuesta, sin aceptar otra vez.
    expect(b.estado).toBe('confirmado')
    expect(b.aceptado).toBeUndefined()
    const filas = t.db
      .prepare("SELECT count(*) AS n FROM evento WHERE tipo = 'NotaPedidoCambiada'")
      .get()
    expect(filas).toEqual({ n: 1 })
  })

  it('se rechaza si el texto pasa de 500 caracteres o no es texto', () => {
    const { t, ana } = montar()
    const pedido = t.abrir(ana)
    for (const datos of [{ notas: 'a'.repeat(501) }, { notas: 7 }, {}, { notas: 'x', y: 1 }]) {
      const r = ana.mandar(pedido, 'NotaPedidoCambiada', datos)
      expect(r.estado, JSON.stringify(datos).slice(0, 40)).toBe('rechazado')
    }
  })

  it('en un pedido cancelado se rechaza por el reductor (no se puede cambiar la nota)', () => {
    const { t, ana } = montar()
    const caja = t.equipo('admin', 'caja')
    const pedido = t.abrir(ana)
    expect(ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'antes' }).estado).toBe('confirmado')
    expect(
      caja.mandar(pedido, 'PedidoCancelado', {}, { motivo: 'Se fueron sin pedir' }).estado,
    ).toBe('confirmado')
    expect(ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'después' }).estado).toBe('rechazado')
  })

  it('un evento con nota de otro equipo sin estar al día se acepta (la nota no choca con ítems)', () => {
    const { t, ana } = montar()
    const luis = t.equipo('mesero2')
    const { pedido } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    // Luis no sabe de lo último que pasó en el hub: su base es 0.
    const r = luis.mandar(
      pedido,
      'NotaPedidoCambiada',
      { notas: 'todo junto' },
      { secuencia_base: 0 },
    )
    expect(r.estado).toBe('confirmado')
  })
})

describe('la comanda nueva lleva la nota del pedido', () => {
  it('el contenido guardado y el papel traen «NOTA DEL PEDIDO» con el texto', async () => {
    const { t, cocina, ana } = montar()
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'alérgico al maní' })
    t.enviar(ana, pedido, items)
    expect(t.contenido(t.trabajos()[0]).notaPedido).toBe('alérgico al maní')
    await t.cola.vuelta()
    const texto = cocina.papel.textos()[0] as string
    expect(texto).toContain('NOTA DEL PEDIDO: alérgico al maní')
    // Arriba, antes de los ítems.
    expect(texto.indexOf('NOTA DEL PEDIDO')).toBeLessThan(texto.indexOf('Tagliata'))
  })

  it('sin nota no sale el encabezado y el contenido lleva null', async () => {
    const { t, cocina, ana } = montar()
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    t.enviar(ana, pedido, items)
    expect(t.contenido(t.trabajos()[0]).notaPedido).toBeNull()
    await t.cola.vuelta()
    expect(cocina.papel.textos()[0]).not.toContain('NOTA DEL PEDIDO')
  })

  it('cada estación del mismo envío lleva la nota', async () => {
    const { t, cocina, barra, ana } = montar()
    const { pedido, items } = t.pedidoCon(ana, [
      { nombre: 'Tagliata', estacion: t.cocina },
      { nombre: 'Aperol Spritz', estacion: t.barra },
    ])
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'cumpleaños: velita en el postre' })
    t.enviar(ana, pedido, items)
    await t.cola.vuelta()
    for (const p of [cocina.papel, barra.papel]) {
      expect(p.textos()[0]).toContain('NOTA DEL PEDIDO: cumpleaños: velita en el postre')
    }
  })

  it('la nota se recorta: los espacios de los bordes no llegan al papel', async () => {
    const { t, cocina, ana } = montar()
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: '   sin sal   ' })
    t.enviar(ana, pedido, items)
    expect(t.contenido(t.trabajos()[0]).notaPedido).toBe('sin sal')
    await t.cola.vuelta()
    expect(comoNota(cocina.papel.textos()[0] as string)).toBe('sin sal')
  })

  it('una nota de solo espacios o vacía equivale a no tener nota', async () => {
    const { t, ana } = montar()
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'algo' })
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: '    ' })
    t.enviar(ana, pedido, items)
    expect(t.contenido(t.trabajos()[0]).notaPedido).toBeNull()
  })

  it('quitar la nota (null) antes de enviar: la comanda sale sin ella', async () => {
    const { t, cocina, ana } = montar()
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'algo' })
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: null })
    t.enviar(ana, pedido, items)
    await t.cola.vuelta()
    expect(cocina.papel.textos()[0]).not.toContain('NOTA DEL PEDIDO')
  })

  it('cambiar la nota entre dos envíos: cada comanda nueva lleva la que había al enviar', async () => {
    const { t, cocina, ana } = montar()
    const { pedido, items } = t.pedidoCon(ana, [
      { nombre: 'Tagliata', estacion: t.cocina },
      { nombre: 'Risotto', estacion: t.cocina },
    ])
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'primera' })
    t.enviar(ana, pedido, [items[0] as (typeof items)[0]])
    // Con la Tagliata ya en cocina, cambiar la nota saca además una comanda «NOTA NUEVA».
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'segunda' })
    t.enviar(ana, pedido, [items[1] as (typeof items)[0]])
    await t.cola.vuelta()
    const textos = cocina.papel.textos()
    expect(textos).toHaveLength(3)
    expect(comoNota(textos[0] as string)).toBe('primera')
    expect(textos[1]).toContain('NOTA NUEVA')
    expect(comoNota(textos[1] as string)).toBe('segunda')
    expect(textos[2]).not.toContain('NOTA NUEVA')
    expect(comoNota(textos[2] as string)).toBe('segunda')
  })

  it('poner la nota con platos en cocina saca una comanda «NOTA NUEVA» sin ítems; la original no se reimprime', async () => {
    const { t, cocina, ana } = montar()
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    t.enviar(ana, pedido, items)
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'tarde' })
    await t.cola.vuelta()
    const textos = cocina.papel.textos()
    expect(textos).toHaveLength(2)
    expect(textos[0]).not.toContain('NOTA DEL PEDIDO')
    expect(textos[1]).toContain('NOTA NUEVA')
    expect(textos[1]).toContain('NOTA DEL PEDIDO: tarde')
    expect(textos[1]).not.toContain('Tagliata')
    expect(t.contenido(t.trabajos()[1])).toMatchObject({
      tipo: 'nota',
      notaPedido: 'tarde',
      items: [],
    })
  })

  it('la siguiente comanda nueva (otro ítem agregado después) sí lleva la nota puesta tarde', async () => {
    const { t, cocina, ana } = montar()
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    t.enviar(ana, pedido, items)
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'tarde' })
    const otro = t.agregar(ana, pedido, { nombre: 'Risotto', estacion: t.cocina })
    t.enviar(ana, pedido, [otro])
    await t.cola.vuelta()
    const textos = cocina.papel.textos()
    // Original sin nota, el aviso «NOTA NUEVA» y la comanda nueva del Risotto.
    expect(textos).toHaveLength(3)
    expect(textos[0]).not.toContain('NOTA DEL PEDIDO')
    expect(textos[1]).toContain('NOTA NUEVA')
    expect(textos[2]).toContain('NOTA DEL PEDIDO: tarde')
    expect(textos[2]).not.toContain('NOTA NUEVA')
    expect(textos[2]).toContain('Risotto')
  })

  it('al marchar un curso retenido, la comanda que sale lleva la nota', async () => {
    const { t, cocina, ana } = montar()
    const pedido = t.abrir(ana)
    const fuerte = t.agregar(ana, pedido, {
      nombre: 'Tagliata',
      estacion: t.cocina,
      curso: 'fuerte',
    })
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'sin picante' })
    ana.mandar(pedido, 'CursoRetenido', { curso: 'fuerte' })
    ana.mandar(pedido, 'CursoMarchado', { curso: 'fuerte' })
    t.enviar(ana, pedido, [fuerte])
    await t.cola.vuelta()
    const textos = cocina.papel.textos()
    expect(textos.length).toBeGreaterThan(0)
    for (const texto of textos) expect(texto).toContain('NOTA DEL PEDIDO: sin picante')
  })

  it('una reimpresión lleva la nota vigente, no la que había al enviar', async () => {
    const { t, cocina, ana } = montar()
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    const enviado = t.enviar(ana, pedido, items)
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'cambió después' })
    ana.mandar(pedido, 'ComandaReimpresa', { comanda_id: enviado.comandas[0]?.comanda_id })
    await t.cola.vuelta()
    const textos = cocina.papel.textos()
    // Original, aviso «NOTA NUEVA» y la reimpresión.
    expect(textos).toHaveLength(3)
    expect(textos[0]).not.toContain('NOTA DEL PEDIDO')
    expect(textos[1]).toContain('NOTA NUEVA')
    expect(textos[2]).toContain('REIMPRESIÓN')
    expect(textos[2]).toContain('NOTA DEL PEDIDO: cambió después')
  })

  it('la comanda de anulación no repite la nota del pedido (ya salió con la original)', async () => {
    const { t, cocina, ana } = montar()
    const caja = t.equipo('admin', 'caja')
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'alérgico al maní' })
    t.enviar(ana, pedido, items)
    caja.mandar(pedido, 'ItemAnulado', {
      item_id: items[0]?.id,
      cantidad: 1,
      ya_preparado: false,
      comanda_id: null,
    })
    await t.cola.vuelta()
    const textos = cocina.papel.textos()
    expect(textos).toHaveLength(2)
    expect(textos[0]).toContain('NOTA DEL PEDIDO')
    expect(textos[1]).toContain('ANULA')
    expect(textos[1]).not.toContain('NOTA DEL PEDIDO')
    expect(t.contenido(t.trabajos()[1]).notaPedido).toBeNull()
  })

  it('acentos, eñes y signos pasan a la impresora sin perder letras', async () => {
    const { t, cocina, ana } = montar()
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'Alérgico al maní; ñandú ¡ya! (rápido)' })
    t.enviar(ana, pedido, items)
    await t.cola.vuelta()
    expect((cocina.papel.textos()[0] as string).replace(/\s+/g, ' ')).toContain(
      'Alérgico al maní; ñandú ¡ya! (rápido)',
    )
  })

  it('una nota de 500 caracteres no pierde palabras en el papel (se parte en renglones)', async () => {
    const { t, cocina, ana } = montar()
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    const palabras = Array.from({ length: 70 }, (_, i) => `p${String(i).padStart(2, '0')}xx`)
    const larga = palabras.join(' ').slice(0, 500)
    expect(larga.length).toBeLessThanOrEqual(500)
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: larga })
    t.enviar(ana, pedido, items)
    await t.cola.vuelta()
    const texto = (cocina.papel.textos()[0] as string).replace(/\s+/g, ' ')
    const completas = larga.split(' ').slice(0, -1) // la última pudo cortarse con el slice
    for (const palabra of completas) expect(texto, palabra).toContain(palabra)
  })
})

describe('comanda «NOTA NUEVA» al cambiar la nota con platos en cocina', () => {
  it('quitar la nota saca «SE QUITÓ LA NOTA DEL PEDIDO»', async () => {
    const { t, cocina, ana } = montar()
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'alérgico al maní' })
    t.enviar(ana, pedido, items)
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: null })
    await t.cola.vuelta()
    const textos = cocina.papel.textos()
    expect(textos).toHaveLength(2)
    expect(textos[1]).toContain('SE QUITÓ LA NOTA DEL PEDIDO')
    expect(textos[1]).not.toContain('NOTA DEL PEDIDO: ')
  })

  it('repetir la misma nota (o quitar la que no hay) no imprime nada', async () => {
    const { t, cocina, ana } = montar()
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'igual' })
    t.enviar(ana, pedido, items)
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: '  igual  ' })
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'igual' })
    await t.cola.vuelta()
    expect(cocina.papel.recibidos).toHaveLength(1)
    const otro = t.pedidoCon(ana, [{ nombre: 'Risotto', estacion: t.cocina }])
    t.enviar(ana, otro.pedido, otro.items)
    ana.mandar(otro.pedido, 'NotaPedidoCambiada', { notas: null })
    ana.mandar(otro.pedido, 'NotaPedidoCambiada', { notas: '   ' })
    await t.cola.vuelta()
    expect(cocina.papel.recibidos).toHaveLength(2)
  })

  it('con ítems solo sin enviar no imprime nada (la nota saldrá en la comanda nueva)', async () => {
    const { t, ana } = montar()
    const { pedido } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'algo' })
    expect(t.trabajos()).toHaveLength(0)
  })

  it('solo va a las estaciones con algo todavía en cocina: no a las que ya entregaron todo', async () => {
    const { t, cocina, barra, ana } = montar()
    const { pedido, items } = t.pedidoCon(ana, [
      { nombre: 'Tagliata', estacion: t.cocina },
      { nombre: 'Aperol Spritz', estacion: t.barra },
    ])
    t.enviar(ana, pedido, items)
    ana.mandar(pedido, 'ItemEntregado', { item_ids: [items[1]?.id] })
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'alérgico al maní' })
    await t.cola.vuelta()
    expect(cocina.papel.textos().at(-1)).toContain('NOTA NUEVA')
    expect(barra.papel.recibidos).toHaveLength(1)
    expect(barra.papel.textos()[0]).not.toContain('NOTA NUEVA')
  })

  it('con dos estaciones con platos en cocina, cada una recibe su aviso', async () => {
    const { t, cocina, barra, ana } = montar()
    const { pedido, items } = t.pedidoCon(ana, [
      { nombre: 'Tagliata', estacion: t.cocina },
      { nombre: 'Aperol Spritz', estacion: t.barra },
    ])
    t.enviar(ana, pedido, items)
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'cumpleaños' })
    await t.cola.vuelta()
    for (const p of [cocina.papel, barra.papel]) {
      expect(p.recibidos).toHaveLength(2)
      expect(p.textos()[1]).toContain('NOTA NUEVA')
    }
  })

  it('un plato anulado por completo ya no cuenta como «en cocina»', async () => {
    const { t, cocina, ana } = montar()
    const caja = t.equipo('admin', 'caja')
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    t.enviar(ana, pedido, items)
    caja.mandar(pedido, 'ItemAnulado', {
      item_id: items[0]?.id,
      cantidad: 1,
      ya_preparado: false,
      comanda_id: null,
    })
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'ya nada' })
    await t.cola.vuelta()
    // La comanda original y la de anulación; ningún «NOTA NUEVA».
    expect(cocina.papel.textos().some((x) => x.includes('NOTA NUEVA'))).toBe(false)
  })

  it('el mismo evento reenviado no imprime el aviso dos veces', async () => {
    const { t, cocina, ana } = montar()
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    t.enviar(ana, pedido, items)
    const mismo = { id: nuevoId() }
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'una vez' }, mismo)
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'una vez' }, mismo)
    await t.cola.vuelta()
    expect(cocina.papel.recibidos).toHaveLength(2)
  })
})
