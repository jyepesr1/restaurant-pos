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
      { duracionMs: 3000, conexionPerdida: false, recargada: false },
      { duracionMs: 60_000, conexionPerdida: true, recargada: false },
    ])
  })

  it('usa la comprobación hecha al volver y la duración real que trae el evento', () => {
    const eventos: EventoDiagnostico[] = [
      { hora: 1000, tipo: 'oculta' },
      // Se registra 3 s después de volver, tras esperar respuesta del hub.
      { hora: 34_000, tipo: 'visible', detalle: { duracionMs: 30_000, conexionMantenida: false } },
    ]

    expect(resumirEventos(eventos).ocultamientos).toEqual([
      { duracionMs: 30_000, conexionPerdida: true, recargada: false },
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
      { duracionMs: 298_000, conexionPerdida: true, recargada: true },
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

  it('sin eventos devuelve un resumen vacío', () => {
    expect(resumirEventos([])).toEqual({
      cargas: 0,
      descartes: 0,
      reconexiones: 0,
      ocultamientos: [],
    })
  })
})
