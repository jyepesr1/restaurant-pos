import { escpos, readEscpos, testLines } from '@pos/printing'
import { afterEach, describe, expect, it } from 'vitest'
import { ColaImpresion } from './cola'
import { abrirImpresoraDePrueba, type ImpresoraDePrueba } from './impresora-prueba'
import { montarImpresion } from './montaje-impresion'
import { ErrorImpresora, enviarPorRed } from './transporte'

// El transporte por red contra la impresora de prueba (un servidor TCP de mentira que se apaga y
// se prende), y la cola completa sobre sockets de verdad.

const abiertas: ImpresoraDePrueba[] = []
afterEach(async () => {
  for (const i of abiertas.splice(0)) await i.close()
})
const open = async () => {
  const i = await abrirImpresoraDePrueba()
  abiertas.push(i)
  return i
}
const target = (port: number) => ({ connection: 'network' as const, address: '127.0.0.1', port })
const bytesDePrueba = () => {
  const format = { columns: 48, page: 'pc850' as const }
  return escpos(
    testLines({ printer: 'X', stations: ['Cocina'], time: '3:00 p. m.' }, format),
    format,
  )
}

describe('enviarPorRed', () => {
  it('entrega todos los bytes, en un solo trabajo, y la impresora los lee', async () => {
    const p = await open()
    const bytes = bytesDePrueba()
    await enviarPorRed(target(p.port), bytes)
    await p.esperar(1)
    expect(p.recibidos).toHaveLength(1)
    expect([...(p.recibidos[0] as Uint8Array)]).toEqual([...bytes])
    expect(readEscpos(p.recibidos[0] as Uint8Array).cuts).toBe(1)
  })

  it('entrega sin pérdida un documento grande (500 KB)', async () => {
    const p = await open()
    const large = Uint8Array.from({ length: 500_000 }, (_, i) => 0x20 + (i % 90))
    await enviarPorRed(target(p.port), large)
    await p.esperar(1)
    expect(p.recibidos[0]?.length).toBe(500_000)
    expect([...(p.recibidos[0] as Uint8Array).slice(0, 5)]).toEqual([...large.slice(0, 5)])
    expect(p.recibidos[0]?.at(-1)).toBe(large.at(-1))
  })

  it('varios envíos al tiempo llegan completos y separados', async () => {
    const p = await open()
    const bytes = bytesDePrueba()
    await Promise.all(Array.from({ length: 6 }, () => enviarPorRed(target(p.port), bytes)))
    await p.esperar(6)
    expect(p.recibidos).toHaveLength(6)
    for (const r of p.recibidos) expect(r.length).toBe(bytes.length)
  })

  it('un envío vacío no revienta', async () => {
    const p = await open()
    await enviarPorRed(target(p.port), new Uint8Array())
    await p.esperar(1)
    expect(p.recibidos[0]?.length).toBe(0)
  })

  it('con la impresora apagada falla con un mensaje para la caja, y al prenderla vuelve a servir', async () => {
    const p = await open()
    await p.apagar(true)
    const error = await enviarPorRed(target(p.port), bytesDePrueba()).catch((e) => e)
    expect(error).toBeInstanceOf(ErrorImpresora)
    expect(error.message).toBe(
      'La impresora rechazó la conexión: revisa el puerto (casi siempre 9100).',
    )
    await p.apagar(false)
    await enviarPorRed(target(p.port), bytesDePrueba())
    await p.esperar(1)
    expect(p.recibidos).toHaveLength(1)
  })

  it('las impresoras USB no se pueden usar todavía y lo dicen', async () => {
    const error = await enviarPorRed(
      { connection: 'usb', address: 'POS-80', port: null },
      bytesDePrueba(),
    ).catch((e) => e)
    expect(error).toBeInstanceOf(ErrorImpresora)
    expect(error.message).toMatch(/USB/)
  })

  it('un nombre que no existe falla con un mensaje claro (no se cuelga)', async () => {
    const error = await enviarPorRed(
      { connection: 'network', address: 'no-existe.invalid', port: 9100 },
      bytesDePrueba(),
    ).catch((e) => e)
    expect(error).toBeInstanceOf(ErrorImpresora)
    expect(error.message).toMatch(/dirección|impresora/i)
  })
})

describe('la cola contra sockets de verdad', () => {
  it('reintenta mientras la impresora está apagada y sale en orden cuando se prende', async () => {
    const t = montarImpresion()
    const p = await open()
    t.db
      .prepare(
        `INSERT INTO printers (id, restaurant_id, created_at, updated_at, version, name, connection, address, port, width, code_page, station_ids)
         VALUES ('01IMPRESORAREAL00000000AAA', ?, ?, ?, 9, 'Real', 'network', '127.0.0.1', ?, 80, 'pc850', ?)`,
      )
      .run(
        t.restauranteId,
        new Date(t.clock()).toISOString(),
        new Date(t.clock()).toISOString(),
        p.port,
        JSON.stringify([t.kitchen]),
      )
    const cola = new ColaImpresion({
      db: t.db,
      restauranteId: t.restauranteId,
      clock: t.clock,
    })
    const ana = t.device('waiter')
    for (let i = 0; i < 3; i++) {
      const { order, items } = t.orderWith(ana, [{ name: `Plato ${i + 1}`, station: t.kitchen }])
      t.send(ana, order, items)
    }
    await p.apagar(true)
    await cola.runOnce()
    expect(p.recibidos).toHaveLength(0)
    expect(cola.status()[0]).toMatchObject({ status: 'failed', pendingList: 3 })
    await p.apagar(false)
    t.advance(2000)
    await cola.runOnce()
    await p.esperar(3)
    expect(p.recibidos.map((b) => /Plato (\d)/.exec(readEscpos(b).text)?.[1])).toEqual([
      '1',
      '2',
      '3',
    ])
    expect(t.pendingList()).toBe(0)
    expect(cola.status()[0]).toMatchObject({ status: 'ready', error: null })
  })
})

describe('la impresora de prueba', () => {
  it('apagar y prender conserva lo ya recibido y el puerto', async () => {
    const p = await open()
    await enviarPorRed(target(p.port), bytesDePrueba())
    await p.esperar(1)
    await p.apagar(true)
    await p.apagar(false)
    await enviarPorRed(target(p.port), bytesDePrueba())
    await p.esperar(2)
    expect(p.recibidos).toHaveLength(2)
  })

  it('avisa a quien escucha cada trabajo que llega', async () => {
    const seenSet: number[] = []
    const p = await abrirImpresoraDePrueba(0, (b) => seenSet.push(b.length))
    abiertas.push(p)
    const bytes = bytesDePrueba()
    await enviarPorRed(target(p.port), bytes)
    await p.esperar(1)
    expect(seenSet).toEqual([bytes.length])
  })

  it('cerrar con conexiones abiertas no se cuelga', async () => {
    const p = await abrirImpresoraDePrueba()
    await p.close()
    await p.close()
  })
})
