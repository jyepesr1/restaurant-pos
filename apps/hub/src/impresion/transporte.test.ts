import { escpos, leerEscpos, lineasPrueba } from '@pos/printing'
import { afterEach, describe, expect, it } from 'vitest'
import { ColaImpresion } from './cola'
import { abrirImpresoraDePrueba, type ImpresoraDePrueba } from './impresora-prueba'
import { montarImpresion } from './montaje-impresion'
import { ErrorImpresora, enviarPorRed } from './transporte'

// El transporte por red contra la impresora de prueba (un servidor TCP de mentira que se apaga y
// se prende), y la cola completa sobre sockets de verdad.

const abiertas: ImpresoraDePrueba[] = []
afterEach(async () => {
  for (const i of abiertas.splice(0)) await i.cerrar()
})
const abrir = async () => {
  const i = await abrirImpresoraDePrueba()
  abiertas.push(i)
  return i
}
const destino = (puerto: number) => ({ conexion: 'red' as const, direccion: '127.0.0.1', puerto })
const bytesDePrueba = () => {
  const formato = { columnas: 48, pagina: 'pc850' as const }
  return escpos(
    lineasPrueba({ impresora: 'X', estaciones: ['Cocina'], hora: '3:00 p. m.' }, formato),
    formato,
  )
}

describe('enviarPorRed', () => {
  it('entrega todos los bytes, en un solo trabajo, y la impresora los lee', async () => {
    const p = await abrir()
    const bytes = bytesDePrueba()
    await enviarPorRed(destino(p.puerto), bytes)
    await p.esperar(1)
    expect(p.recibidos).toHaveLength(1)
    expect([...(p.recibidos[0] as Uint8Array)]).toEqual([...bytes])
    expect(leerEscpos(p.recibidos[0] as Uint8Array).cortes).toBe(1)
  })

  it('entrega sin pérdida un documento grande (500 KB)', async () => {
    const p = await abrir()
    const grande = Uint8Array.from({ length: 500_000 }, (_, i) => 0x20 + (i % 90))
    await enviarPorRed(destino(p.puerto), grande)
    await p.esperar(1)
    expect(p.recibidos[0]?.length).toBe(500_000)
    expect([...(p.recibidos[0] as Uint8Array).slice(0, 5)]).toEqual([...grande.slice(0, 5)])
    expect(p.recibidos[0]?.at(-1)).toBe(grande.at(-1))
  })

  it('varios envíos al tiempo llegan completos y separados', async () => {
    const p = await abrir()
    const bytes = bytesDePrueba()
    await Promise.all(Array.from({ length: 6 }, () => enviarPorRed(destino(p.puerto), bytes)))
    await p.esperar(6)
    expect(p.recibidos).toHaveLength(6)
    for (const r of p.recibidos) expect(r.length).toBe(bytes.length)
  })

  it('un envío vacío no revienta', async () => {
    const p = await abrir()
    await enviarPorRed(destino(p.puerto), new Uint8Array())
    await p.esperar(1)
    expect(p.recibidos[0]?.length).toBe(0)
  })

  it('con la impresora apagada falla con un mensaje para la caja, y al prenderla vuelve a servir', async () => {
    const p = await abrir()
    await p.apagar(true)
    const error = await enviarPorRed(destino(p.puerto), bytesDePrueba()).catch((e) => e)
    expect(error).toBeInstanceOf(ErrorImpresora)
    expect(error.message).toBe(
      'La impresora rechazó la conexión: revisa el puerto (casi siempre 9100).',
    )
    await p.apagar(false)
    await enviarPorRed(destino(p.puerto), bytesDePrueba())
    await p.esperar(1)
    expect(p.recibidos).toHaveLength(1)
  })

  it('las impresoras USB no se pueden usar todavía y lo dicen', async () => {
    const error = await enviarPorRed(
      { conexion: 'usb', direccion: 'POS-80', puerto: null },
      bytesDePrueba(),
    ).catch((e) => e)
    expect(error).toBeInstanceOf(ErrorImpresora)
    expect(error.message).toMatch(/USB/)
  })

  it('un nombre que no existe falla con un mensaje claro (no se cuelga)', async () => {
    const error = await enviarPorRed(
      { conexion: 'red', direccion: 'no-existe.invalid', puerto: 9100 },
      bytesDePrueba(),
    ).catch((e) => e)
    expect(error).toBeInstanceOf(ErrorImpresora)
    expect(error.message).toMatch(/dirección|impresora/i)
  })
})

describe('la cola contra sockets de verdad', () => {
  it('reintenta mientras la impresora está apagada y sale en orden cuando se prende', async () => {
    const t = montarImpresion()
    const p = await abrir()
    t.db
      .prepare(
        `INSERT INTO impresora (id, restaurante_id, creado_en, actualizado_en, version, nombre, conexion, direccion, puerto, ancho, pagina_codigos, estacion_ids)
         VALUES ('01IMPRESORAREAL00000000AAA', ?, ?, ?, 9, 'Real', 'red', '127.0.0.1', ?, 80, 'pc850', ?)`,
      )
      .run(
        t.restauranteId,
        new Date(t.reloj()).toISOString(),
        new Date(t.reloj()).toISOString(),
        p.puerto,
        JSON.stringify([t.cocina]),
      )
    const cola = new ColaImpresion({
      db: t.db,
      restauranteId: t.restauranteId,
      reloj: t.reloj,
    })
    const ana = t.equipo('mesero')
    for (let i = 0; i < 3; i++) {
      const { pedido, items } = t.pedidoCon(ana, [{ nombre: `Plato ${i + 1}`, estacion: t.cocina }])
      t.enviar(ana, pedido, items)
    }
    await p.apagar(true)
    await cola.vuelta()
    expect(p.recibidos).toHaveLength(0)
    expect(cola.estado()[0]).toMatchObject({ estado: 'falla', pendientes: 3 })
    await p.apagar(false)
    t.avanzar(2000)
    await cola.vuelta()
    await p.esperar(3)
    expect(p.recibidos.map((b) => /Plato (\d)/.exec(leerEscpos(b).texto)?.[1])).toEqual([
      '1',
      '2',
      '3',
    ])
    expect(t.pendientes()).toBe(0)
    expect(cola.estado()[0]).toMatchObject({ estado: 'lista', error: null })
  })
})

describe('la impresora de prueba', () => {
  it('apagar y prender conserva lo ya recibido y el puerto', async () => {
    const p = await abrir()
    await enviarPorRed(destino(p.puerto), bytesDePrueba())
    await p.esperar(1)
    await p.apagar(true)
    await p.apagar(false)
    await enviarPorRed(destino(p.puerto), bytesDePrueba())
    await p.esperar(2)
    expect(p.recibidos).toHaveLength(2)
  })

  it('avisa a quien escucha cada trabajo que llega', async () => {
    const vistos: number[] = []
    const p = await abrirImpresoraDePrueba(0, (b) => vistos.push(b.length))
    abiertas.push(p)
    const bytes = bytesDePrueba()
    await enviarPorRed(destino(p.puerto), bytes)
    await p.esperar(1)
    expect(vistos).toEqual([bytes.length])
  })

  it('cerrar con conexiones abiertas no se cuelga', async () => {
    const p = await abrirImpresoraDePrueba()
    await p.cerrar()
    await p.cerrar()
  })
})
