import type { EventoDiagnostico } from './registro'

/**
 * Si la página vuelve a cargar después de estar oculta más de este tiempo, no fue una recarga
 * manual: el navegador la descartó (Safari en iPhone no expone `document.wasDiscarded`).
 */
export const UMBRAL_RECARGA_FORZADA_MS = 2000

export interface Ocultamiento {
  duracionMs: number
  /** La conexión con el hub se cortó mientras la pantalla estaba oculta o bloqueada. */
  conexionPerdida: boolean
  /** El navegador recargó la página al volver. */
  recargada: boolean
  /** Si la conexión se perdió: cuánto tardó en volver tras regresar a la pantalla. */
  recuperacionMs: number | null
}

export interface ResumenDiagnostico {
  cargas: number
  /** Cargas en que el navegador había descartado la página y la tuvo que recargar sola. */
  descartes: number
  reconexiones: number
  ocultamientos: Ocultamiento[]
}

const porOrdenDeRegistro = (a: EventoDiagnostico, b: EventoDiagnostico) =>
  a.time - b.time || (a.id ?? 0) - (b.id ?? 0)

/** Resume el registro de eventos (en cualquier orden) para el informe de la prueba de conexión. */
export function resumirEventos(events: EventoDiagnostico[]): ResumenDiagnostico {
  const ocultamientos: Ocultamiento[] = []
  let cargas = 0
  let descartes = 0
  let reconexiones = 0
  let ocultaDesde: number | null = null
  let perdidaMientrasOculta = false
  // La reconexión puede registrarse antes que el evento "visible" (que espera la comprobación).
  let recuperacionPendiente: number | null = null
  let cargaTrasRecarga: number | null = null

  for (const { type, time, detalle } of [...events].sort(porOrdenDeRegistro)) {
    switch (type) {
      case 'load': {
        cargas += 1
        const trasOcultar = ocultaDesde !== null && time - ocultaDesde > UMBRAL_RECARGA_FORZADA_MS
        if (ocultaDesde !== null && trasOcultar) {
          ocultamientos.push({
            duracionMs: time - ocultaDesde,
            conexionPerdida: true,
            recargada: true,
            recuperacionMs: null,
          })
          cargaTrasRecarga = time
        }
        if (trasOcultar || detalle?.descartada === true) descartes += 1
        ocultaDesde = null
        break
      }
      case 'hidden':
        ocultaDesde = time
        perdidaMientrasOculta = false
        recuperacionPendiente = null
        break
      case 'visible':
        if (ocultaDesde !== null) {
          // El evento se registra tras comprobar la conexión: la duración real viene en el detalle.
          const duracionMs =
            typeof detalle?.duracionMs === 'number' ? detalle.duracionMs : time - ocultaDesde
          const conexionPerdida = perdidaMientrasOculta || detalle?.conexionMantenida === false
          ocultamientos.push({
            duracionMs,
            conexionPerdida,
            recargada: false,
            recuperacionMs: conexionPerdida ? recuperacionPendiente : null,
          })
        }
        ocultaDesde = null
        recuperacionPendiente = null
        break
      case 'ws-closed':
        if (ocultaDesde !== null) perdidaMientrasOculta = true
        break
      case 'ws-open': {
        if (typeof detalle?.reconexiones === 'number' && detalle.reconexiones > 0) reconexiones += 1
        const latest = ocultamientos.at(-1)
        if (cargaTrasRecarga !== null && latest?.recargada) {
          latest.recuperacionMs = time - cargaTrasRecarga
          cargaTrasRecarga = null
        } else if (typeof detalle?.msDesdeVisible === 'number') {
          if (ocultaDesde !== null) {
            recuperacionPendiente = detalle.msDesdeVisible
          } else if (latest?.conexionPerdida && latest.recuperacionMs === null) {
            latest.recuperacionMs = detalle.msDesdeVisible
          }
        } else if (ocultaDesde !== null && perdidaMientrasOculta) {
          // Se reconectó sola antes de que el usuario volviera.
          recuperacionPendiente = 0
        }
        break
      }
    }
  }

  return { cargas, descartes, reconexiones, ocultamientos }
}
