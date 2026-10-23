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
}

export interface ResumenDiagnostico {
  cargas: number
  /** Cargas en que el navegador había descartado la página y la tuvo que recargar sola. */
  descartes: number
  reconexiones: number
  ocultamientos: Ocultamiento[]
}

const porOrdenDeRegistro = (a: EventoDiagnostico, b: EventoDiagnostico) =>
  a.hora - b.hora || (a.id ?? 0) - (b.id ?? 0)

/** Resume el registro de eventos (en cualquier orden) para el informe de la prueba de conexión. */
export function resumirEventos(eventos: EventoDiagnostico[]): ResumenDiagnostico {
  const ocultamientos: Ocultamiento[] = []
  let cargas = 0
  let descartes = 0
  let reconexiones = 0
  let ocultaDesde: number | null = null
  let perdidaMientrasOculta = false

  for (const { tipo, hora, detalle } of [...eventos].sort(porOrdenDeRegistro)) {
    switch (tipo) {
      case 'carga': {
        cargas += 1
        const trasOcultar = ocultaDesde !== null && hora - ocultaDesde > UMBRAL_RECARGA_FORZADA_MS
        if (ocultaDesde !== null && trasOcultar) {
          ocultamientos.push({
            duracionMs: hora - ocultaDesde,
            conexionPerdida: true,
            recargada: true,
          })
        }
        if (trasOcultar || detalle?.descartada === true) descartes += 1
        ocultaDesde = null
        break
      }
      case 'oculta':
        ocultaDesde = hora
        perdidaMientrasOculta = false
        break
      case 'visible':
        if (ocultaDesde !== null) {
          // El evento se registra tras comprobar la conexión: la duración real viene en el detalle.
          const duracionMs =
            typeof detalle?.duracionMs === 'number' ? detalle.duracionMs : hora - ocultaDesde
          ocultamientos.push({
            duracionMs,
            conexionPerdida: perdidaMientrasOculta || detalle?.conexionMantenida === false,
            recargada: false,
          })
        }
        ocultaDesde = null
        break
      case 'ws-cerrado':
        if (ocultaDesde !== null) perdidaMientrasOculta = true
        break
      case 'ws-abierto':
        if (typeof detalle?.reconexiones === 'number' && detalle.reconexiones > 0) reconexiones += 1
        break
    }
  }

  return { cargas, descartes, reconexiones, ocultamientos }
}
