import { describe, expect, it } from 'vitest'
import type { EventoDiagnostico } from './registro'
import { resumirEventos, UMBRAL_RECARGA_FORZADA_MS } from './resumen'

describe('resumirEventos', () => {
  it('cuenta cargas, descartes y reconexiones', () => {
    const eventos: EventoDiagnostico[] = [
      { hora: 1, tipo: 'carga', detalle: { descartada: false } },
      { hora: 2, tipo: 'ws-abierto', detalle: { reconexiones: 0 } },
      { hora: 3, tipo: 'ws-abierto', detalle: { reconexiones: 1 } },
      { hora: 4, tipo: 'carga', detalle: { descartada: true } },
    ]

    expect(resumirEventos(eventos)).toMatchObject({ cargas: 2, descartes: 1, reconexiones: 1 })
  })

  it('mide cada ocultamiento y si se perdió la conexión mientras tanto', () => {
    const eventos: EventoDiagnostico[] = [
      { hora: 1000, tipo: 'oculta' },
      { hora: 4000, tipo: 'visible' },
      { hora: 10_000, tipo: 'oculta' },
      { hora: 12_000, tipo: 'ws-cerrado', detalle: { codigo: 1006 } },
      { hora: 70_000, tipo: 'visible' },
    ]

    expect(resumirEventos(eventos).ocultamientos).toEqual([
      { duracionMs: 3000, conexionPerdida: false, recargada: false, recuperacionMs: null },
      { duracionMs: 60_000, conexionPerdida: true, recargada: false, recuperacionMs: null },
    ])
  })

  it('usa la comprobación hecha al volver y la duración real que trae el evento', () => {
    const eventos: EventoDiagnostico[] = [
      { hora: 1000, tipo: 'oculta' },
      // Se registra 3 s después de volver, tras esperar respuesta del hub.
      { hora: 34_000, tipo: 'visible', detalle: { duracionMs: 30_000, conexionMantenida: false } },
    ]

    expect(resumirEventos(eventos).ocultamientos).toEqual([
      { duracionMs: 30_000, conexionPerdida: true, recargada: false, recuperacionMs: null },
    ])
  })

  it('cuenta como recarga forzada una carga que llega tras estar oculta (Safari en iPhone)', () => {
    const eventos: EventoDiagnostico[] = [
      { hora: 1000, tipo: 'carga', detalle: { descartada: false } },
      { hora: 2000, tipo: 'oculta' },
      { hora: 300_000, tipo: 'carga', detalle: { descartada: false } },
    ]

    const resumen = resumirEventos(eventos)
    expect(resumen.descartes).toBe(1)
    expect(resumen.ocultamientos).toEqual([
      { duracionMs: 298_000, conexionPerdida: true, recargada: true, recuperacionMs: null },
    ])
  })

  it('no cuenta como forzada una recarga manual (oculta solo un instante)', () => {
    const eventos: EventoDiagnostico[] = [
      { hora: 1000, tipo: 'oculta' },
      { hora: 1000 + UMBRAL_RECARGA_FORZADA_MS - 1, tipo: 'carga', detalle: { descartada: false } },
    ]

    const resumen = resumirEventos(eventos)
    expect(resumen.descartes).toBe(0)
    expect(resumen.ocultamientos).toEqual([])
  })

  it('con eventos del mismo milisegundo respeta el orden de registro (id)', () => {
    const eventos: EventoDiagnostico[] = [
      { id: 2, hora: 500, tipo: 'ws-cerrado', detalle: { codigo: 1006 } },
      { id: 1, hora: 500, tipo: 'oculta' },
      { id: 3, hora: 9000, tipo: 'visible' },
    ]

    expect(resumirEventos(eventos).ocultamientos[0]?.conexionPerdida).toBe(true)
  })

  it('mide cuánto tardó en reconectar tras volver, aunque se registre antes que "visible"', () => {
    const eventos: EventoDiagnostico[] = [
      { hora: 1000, tipo: 'oculta' },
      { hora: 6000, tipo: 'ws-cerrado', detalle: { codigo: 1006 } },
      // Vuelve en 46.000; reconecta 800 ms después; "visible" se registra al terminar la comprobación.
      { hora: 46_800, tipo: 'ws-abierto', detalle: { reconexiones: 1, msDesdeVisible: 800 } },
      { hora: 49_000, tipo: 'visible', detalle: { duracionMs: 45_000, conexionMantenida: false } },
    ]

    expect(resumirEventos(eventos).ocultamientos).toEqual([
      { duracionMs: 45_000, conexionPerdida: true, recargada: false, recuperacionMs: 800 },
    ])
  })

  it('mide la recuperación cuando la reconexión llega después de "visible"', () => {
    const eventos: EventoDiagnostico[] = [
      { hora: 1000, tipo: 'oculta' },
      { hora: 34_000, tipo: 'visible', detalle: { duracionMs: 30_000, conexionMantenida: false } },
      { hora: 61_000, tipo: 'ws-abierto', detalle: { reconexiones: 1, msDesdeVisible: 30_000 } },
    ]

    expect(resumirEventos(eventos).ocultamientos[0]?.recuperacionMs).toBe(30_000)
  })

  it('tras una recarga forzada mide desde la carga hasta que abre la conexión', () => {
    const eventos: EventoDiagnostico[] = [
      { hora: 2000, tipo: 'oculta' },
      { hora: 300_000, tipo: 'carga', detalle: { descartada: false } },
      { hora: 300_400, tipo: 'ws-abierto', detalle: { reconexiones: 0 } },
    ]

    expect(resumirEventos(eventos).ocultamientos[0]?.recuperacionMs).toBe(400)
  })

  it('si se reconectó sola mientras estaba oculta, la recuperación es 0', () => {
    const eventos: EventoDiagnostico[] = [
      { hora: 1000, tipo: 'oculta' },
      { hora: 2000, tipo: 'ws-cerrado', detalle: { codigo: 1006 } },
      { hora: 3000, tipo: 'ws-abierto', detalle: { reconexiones: 1 } },
      { hora: 9000, tipo: 'visible', detalle: { duracionMs: 5000, conexionMantenida: false } },
    ]

    expect(resumirEventos(eventos).ocultamientos[0]?.recuperacionMs).toBe(0)
  })

  it('con varios ocultamientos seguidos, cada reconexión se asigna a su propio ocultamiento', () => {
    const eventos: EventoDiagnostico[] = [
      { hora: 1000, tipo: 'oculta' },
      { hora: 2000, tipo: 'ws-cerrado', detalle: { codigo: 1006 } },
      { hora: 3000, tipo: 'visible', detalle: { duracionMs: 2000, conexionMantenida: false } },
      { hora: 3500, tipo: 'ws-abierto', detalle: { reconexiones: 1, msDesdeVisible: 500 } },
      { hora: 10_000, tipo: 'oculta' },
      { hora: 11_000, tipo: 'ws-cerrado', detalle: { codigo: 1006 } },
      { hora: 14_000, tipo: 'visible', detalle: { duracionMs: 4000, conexionMantenida: false } },
      { hora: 18_000, tipo: 'ws-abierto', detalle: { reconexiones: 2, msDesdeVisible: 4000 } },
    ]

    expect(resumirEventos(eventos).ocultamientos).toEqual([
      { duracionMs: 2000, conexionPerdida: true, recargada: false, recuperacionMs: 500 },
      { duracionMs: 4000, conexionPerdida: true, recargada: false, recuperacionMs: 4000 },
    ])
  })

  it('con ocultar y volver varias veces sin conexión, solo la última vuelta toma la reconexión', () => {
    const eventos: EventoDiagnostico[] = [
      { hora: 1000, tipo: 'oculta' },
      { hora: 1100, tipo: 'ws-cerrado', detalle: { codigo: 1006 } },
      // Cada "visible" se registra al instante porque la siguiente ocultación corta la comprobación.
      { hora: 1200, tipo: 'visible', detalle: { duracionMs: 200, conexionMantenida: false } },
      { hora: 1300, tipo: 'oculta' },
      { hora: 1400, tipo: 'visible', detalle: { duracionMs: 100, conexionMantenida: false } },
      { hora: 1500, tipo: 'oculta' },
      { hora: 1600, tipo: 'ws-abierto', detalle: { reconexiones: 1, msDesdeVisible: 80 } },
      { hora: 4700, tipo: 'visible', detalle: { duracionMs: 100, conexionMantenida: false } },
    ]

    const recuperaciones = resumirEventos(eventos).ocultamientos.map((o) => o.recuperacionMs)
    expect(recuperaciones).toEqual([null, null, 80])
  })

  it('una reconexión normal sin "msDesdeVisible" no cambia la recuperación ya medida', () => {
    const eventos: EventoDiagnostico[] = [
      { hora: 1000, tipo: 'oculta' },
      { hora: 2000, tipo: 'ws-cerrado', detalle: { codigo: 1006 } },
      { hora: 4000, tipo: 'ws-abierto', detalle: { reconexiones: 1, msDesdeVisible: 900 } },
      { hora: 5000, tipo: 'visible', detalle: { duracionMs: 4000, conexionMantenida: false } },
      // Corte posterior con la pantalla encendida: no es parte del bloqueo.
      { hora: 20_000, tipo: 'ws-cerrado', detalle: { codigo: 1006 } },
      { hora: 21_000, tipo: 'ws-abierto', detalle: { reconexiones: 2 } },
    ]

    const resumen = resumirEventos(eventos)
    expect(resumen.ocultamientos[0]?.recuperacionMs).toBe(900)
    expect(resumen.reconexiones).toBe(2)
  })

  it('si la conexión sobrevivió al bloqueo no inventa una recuperación', () => {
    const eventos: EventoDiagnostico[] = [
      { hora: 1000, tipo: 'oculta' },
      { hora: 4000, tipo: 'visible', detalle: { duracionMs: 3000, conexionMantenida: true } },
      // Un corte distinto, ya con la pantalla encendida, que también trae "msDesdeVisible".
      { hora: 9000, tipo: 'ws-abierto', detalle: { reconexiones: 1, msDesdeVisible: 700 } },
    ]

    expect(resumirEventos(eventos).ocultamientos).toEqual([
      { duracionMs: 3000, conexionPerdida: false, recargada: false, recuperacionMs: null },
    ])
  })

  it('un "visible" sin reconexión deja la recuperación pendiente (aún reconectando)', () => {
    const eventos: EventoDiagnostico[] = [
      { hora: 1000, tipo: 'oculta' },
      { hora: 2000, tipo: 'ws-cerrado', detalle: { codigo: 1006 } },
      {
        hora: 8000,
        tipo: 'visible',
        detalle: { duracionMs: 6000, conexionMantenida: false, abiertoAlVolver: false },
      },
      // Intentos fallidos al volver: se cierran sin abrir nunca.
      { hora: 8500, tipo: 'ws-cerrado', detalle: { codigo: 1011 } },
      { hora: 9500, tipo: 'ws-cerrado', detalle: { codigo: 1011 } },
    ]

    expect(resumirEventos(eventos).ocultamientos).toEqual([
      { duracionMs: 6000, conexionPerdida: true, recargada: false, recuperacionMs: null },
    ])
  })

  it('sin eventos devuelve un resumen vacío', () => {
    expect(resumirEventos([])).toEqual({
      cargas: 0,
      descartes: 0,
      reconexiones: 0,
      ocultamientos: [],
    })
  })
})
