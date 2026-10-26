import { describe, expect, it } from 'vitest'
import type { EventoDiagnostico } from './registro'
import { resumirEventos, UMBRAL_RECARGA_FORZADA_MS } from './resumen'

describe('resumirEventos', () => {
  it('cuenta cargas, descartes y reconexiones', () => {
    const events: EventoDiagnostico[] = [
      { time: 1, type: 'load', detalle: { descartada: false } },
      { time: 2, type: 'ws-open', detalle: { reconexiones: 0 } },
      { time: 3, type: 'ws-open', detalle: { reconexiones: 1 } },
      { time: 4, type: 'load', detalle: { descartada: true } },
    ]

    expect(resumirEventos(events)).toMatchObject({ cargas: 2, descartes: 1, reconexiones: 1 })
  })

  it('mide cada ocultamiento y si se perdió la conexión mientras tanto', () => {
    const events: EventoDiagnostico[] = [
      { time: 1000, type: 'hidden' },
      { time: 4000, type: 'visible' },
      { time: 10_000, type: 'hidden' },
      { time: 12_000, type: 'ws-closed', detalle: { code: 1006 } },
      { time: 70_000, type: 'visible' },
    ]

    expect(resumirEventos(events).ocultamientos).toEqual([
      { duracionMs: 3000, conexionPerdida: false, recargada: false, recuperacionMs: null },
      { duracionMs: 60_000, conexionPerdida: true, recargada: false, recuperacionMs: null },
    ])
  })

  it('usa la comprobación hecha al volver y la duración real que trae el evento', () => {
    const events: EventoDiagnostico[] = [
      { time: 1000, type: 'hidden' },
      // Se registra 3 s después de volver, tras esperar respuesta del hub.
      { time: 34_000, type: 'visible', detalle: { duracionMs: 30_000, conexionMantenida: false } },
    ]

    expect(resumirEventos(events).ocultamientos).toEqual([
      { duracionMs: 30_000, conexionPerdida: true, recargada: false, recuperacionMs: null },
    ])
  })

  it('cuenta como recarga forzada una carga que llega tras estar oculta (Safari en iPhone)', () => {
    const events: EventoDiagnostico[] = [
      { time: 1000, type: 'load', detalle: { descartada: false } },
      { time: 2000, type: 'hidden' },
      { time: 300_000, type: 'load', detalle: { descartada: false } },
    ]

    const resumen = resumirEventos(events)
    expect(resumen.descartes).toBe(1)
    expect(resumen.ocultamientos).toEqual([
      { duracionMs: 298_000, conexionPerdida: true, recargada: true, recuperacionMs: null },
    ])
  })

  it('no cuenta como forzada una recarga manual (oculta solo un instante)', () => {
    const events: EventoDiagnostico[] = [
      { time: 1000, type: 'hidden' },
      { time: 1000 + UMBRAL_RECARGA_FORZADA_MS - 1, type: 'load', detalle: { descartada: false } },
    ]

    const resumen = resumirEventos(events)
    expect(resumen.descartes).toBe(0)
    expect(resumen.ocultamientos).toEqual([])
  })

  it('con eventos del mismo milisegundo respeta el orden de registro (id)', () => {
    const events: EventoDiagnostico[] = [
      { id: 2, time: 500, type: 'ws-closed', detalle: { code: 1006 } },
      { id: 1, time: 500, type: 'hidden' },
      { id: 3, time: 9000, type: 'visible' },
    ]

    expect(resumirEventos(events).ocultamientos[0]?.conexionPerdida).toBe(true)
  })

  it('mide cuánto tardó en reconectar tras volver, aunque se registre antes que "visible"', () => {
    const events: EventoDiagnostico[] = [
      { time: 1000, type: 'hidden' },
      { time: 6000, type: 'ws-closed', detalle: { code: 1006 } },
      // Vuelve en 46.000; reconecta 800 ms después; "visible" se registra al terminar la comprobación.
      { time: 46_800, type: 'ws-open', detalle: { reconexiones: 1, msDesdeVisible: 800 } },
      { time: 49_000, type: 'visible', detalle: { duracionMs: 45_000, conexionMantenida: false } },
    ]

    expect(resumirEventos(events).ocultamientos).toEqual([
      { duracionMs: 45_000, conexionPerdida: true, recargada: false, recuperacionMs: 800 },
    ])
  })

  it('mide la recuperación cuando la reconexión llega después de "visible"', () => {
    const events: EventoDiagnostico[] = [
      { time: 1000, type: 'hidden' },
      { time: 34_000, type: 'visible', detalle: { duracionMs: 30_000, conexionMantenida: false } },
      { time: 61_000, type: 'ws-open', detalle: { reconexiones: 1, msDesdeVisible: 30_000 } },
    ]

    expect(resumirEventos(events).ocultamientos[0]?.recuperacionMs).toBe(30_000)
  })

  it('tras una recarga forzada mide desde la carga hasta que abre la conexión', () => {
    const events: EventoDiagnostico[] = [
      { time: 2000, type: 'hidden' },
      { time: 300_000, type: 'load', detalle: { descartada: false } },
      { time: 300_400, type: 'ws-open', detalle: { reconexiones: 0 } },
    ]

    expect(resumirEventos(events).ocultamientos[0]?.recuperacionMs).toBe(400)
  })

  it('si se reconectó sola mientras estaba oculta, la recuperación es 0', () => {
    const events: EventoDiagnostico[] = [
      { time: 1000, type: 'hidden' },
      { time: 2000, type: 'ws-closed', detalle: { code: 1006 } },
      { time: 3000, type: 'ws-open', detalle: { reconexiones: 1 } },
      { time: 9000, type: 'visible', detalle: { duracionMs: 5000, conexionMantenida: false } },
    ]

    expect(resumirEventos(events).ocultamientos[0]?.recuperacionMs).toBe(0)
  })

  it('con varios ocultamientos seguidos, cada reconexión se asigna a su propio ocultamiento', () => {
    const events: EventoDiagnostico[] = [
      { time: 1000, type: 'hidden' },
      { time: 2000, type: 'ws-closed', detalle: { code: 1006 } },
      { time: 3000, type: 'visible', detalle: { duracionMs: 2000, conexionMantenida: false } },
      { time: 3500, type: 'ws-open', detalle: { reconexiones: 1, msDesdeVisible: 500 } },
      { time: 10_000, type: 'hidden' },
      { time: 11_000, type: 'ws-closed', detalle: { code: 1006 } },
      { time: 14_000, type: 'visible', detalle: { duracionMs: 4000, conexionMantenida: false } },
      { time: 18_000, type: 'ws-open', detalle: { reconexiones: 2, msDesdeVisible: 4000 } },
    ]

    expect(resumirEventos(events).ocultamientos).toEqual([
      { duracionMs: 2000, conexionPerdida: true, recargada: false, recuperacionMs: 500 },
      { duracionMs: 4000, conexionPerdida: true, recargada: false, recuperacionMs: 4000 },
    ])
  })

  it('con ocultar y volver varias veces sin conexión, solo la última vuelta toma la reconexión', () => {
    const events: EventoDiagnostico[] = [
      { time: 1000, type: 'hidden' },
      { time: 1100, type: 'ws-closed', detalle: { code: 1006 } },
      // Cada "visible" se registra al instante porque la siguiente ocultación corta la comprobación.
      { time: 1200, type: 'visible', detalle: { duracionMs: 200, conexionMantenida: false } },
      { time: 1300, type: 'hidden' },
      { time: 1400, type: 'visible', detalle: { duracionMs: 100, conexionMantenida: false } },
      { time: 1500, type: 'hidden' },
      { time: 1600, type: 'ws-open', detalle: { reconexiones: 1, msDesdeVisible: 80 } },
      { time: 4700, type: 'visible', detalle: { duracionMs: 100, conexionMantenida: false } },
    ]

    const recuperaciones = resumirEventos(events).ocultamientos.map((o) => o.recuperacionMs)
    expect(recuperaciones).toEqual([null, null, 80])
  })

  it('una reconexión normal sin "msDesdeVisible" no cambia la recuperación ya medida', () => {
    const events: EventoDiagnostico[] = [
      { time: 1000, type: 'hidden' },
      { time: 2000, type: 'ws-closed', detalle: { code: 1006 } },
      { time: 4000, type: 'ws-open', detalle: { reconexiones: 1, msDesdeVisible: 900 } },
      { time: 5000, type: 'visible', detalle: { duracionMs: 4000, conexionMantenida: false } },
      // Corte posterior con la pantalla encendida: no es parte del bloqueo.
      { time: 20_000, type: 'ws-closed', detalle: { code: 1006 } },
      { time: 21_000, type: 'ws-open', detalle: { reconexiones: 2 } },
    ]

    const resumen = resumirEventos(events)
    expect(resumen.ocultamientos[0]?.recuperacionMs).toBe(900)
    expect(resumen.reconexiones).toBe(2)
  })

  it('si la conexión sobrevivió al bloqueo no inventa una recuperación', () => {
    const events: EventoDiagnostico[] = [
      { time: 1000, type: 'hidden' },
      { time: 4000, type: 'visible', detalle: { duracionMs: 3000, conexionMantenida: true } },
      // Un corte distinto, ya con la pantalla encendida, que también trae "msDesdeVisible".
      { time: 9000, type: 'ws-open', detalle: { reconexiones: 1, msDesdeVisible: 700 } },
    ]

    expect(resumirEventos(events).ocultamientos).toEqual([
      { duracionMs: 3000, conexionPerdida: false, recargada: false, recuperacionMs: null },
    ])
  })

  it('un "visible" sin reconexión deja la recuperación pendiente (aún reconectando)', () => {
    const events: EventoDiagnostico[] = [
      { time: 1000, type: 'hidden' },
      { time: 2000, type: 'ws-closed', detalle: { code: 1006 } },
      {
        time: 8000,
        type: 'visible',
        detalle: { duracionMs: 6000, conexionMantenida: false, abiertoAlVolver: false },
      },
      // Intentos fallidos al volver: se cierran sin abrir nunca.
      { time: 8500, type: 'ws-closed', detalle: { code: 1011 } },
      { time: 9500, type: 'ws-closed', detalle: { code: 1011 } },
    ]

    expect(resumirEventos(events).ocultamientos).toEqual([
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
