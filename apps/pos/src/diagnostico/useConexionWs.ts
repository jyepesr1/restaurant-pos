import { useEffect, useState } from 'react'
import { registrarEvento } from './registro'

const INTERVALO_PING_MS = 5000
/** El hub envía un latido cada 5 s: tres ciclos sin nada indican una conexión muerta. */
const SIN_RESPUESTA_MS = 15_000
const INTERVALO_VIGILANCIA_MS = 1000
const ESPERA_MAXIMA_RECONEXION_MS = 5000
/**
 * Un intento de conexión hecho con la pantalla bloqueada puede quedar colgado sin abrir ni
 * fallar (visto en Android: ~30 s). Pasado este tiempo se abandona y se intenta de nuevo.
 */
const TIEMPO_MAXIMO_CONEXION_MS = 4000
/** Al volver de segundo plano, cuánto se espera una respuesta para dar la conexión por viva. */
const ESPERA_COMPROBACION_MS = 3000
const MAXIMO_MUESTRAS = 200

export type EstadoCanal = 'connecting' | 'connected' | 'no-response' | 'disconnected'

export interface Latencia {
  ultimaMs: number
  medianaMs: number
  maximaMs: number
  muestras: number
}

export interface EstadoWs {
  channel: EstadoCanal
  latencia: Latencia | null
}

function calcularLatencia(muestras: number[]): Latencia | null {
  const ultimaMs = muestras.at(-1)
  if (ultimaMs === undefined) return null
  const ordenadas = [...muestras].sort((a, b) => a - b)
  return {
    ultimaMs,
    medianaMs: ordenadas[Math.floor(ordenadas.length / 2)] ?? ultimaMs,
    maximaMs: ordenadas.at(-1) ?? ultimaMs,
    muestras: muestras.length,
  }
}

/**
 * Mantiene un WebSocket con el hub, mide la latencia, detecta conexiones muertas y reconecta
 * solo. También registra cada vez que la pantalla se oculta y, al volver, comprueba si la
 * conexión sobrevivió: eso es lo que queremos medir en cada celular.
 */
export function useConexionWs(): EstadoWs {
  const [status, setEstado] = useState<EstadoWs>({ channel: 'connecting', latencia: null })

  useEffect(() => {
    let active = true
    let socket: WebSocket | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    let aperturas = 0
    let closings = 0
    let lastMessageAt = Date.now()
    // Cada ocultamiento invalida los pings en vuelo: su latencia incluiría el tiempo dormido.
    let generation = 0
    const muestras: number[] = []

    let ocultaDesde: number | null = null
    let visibleDesde: number | null = null
    let cierresAlOcultar = 0
    let pendingCheck: { recibioMensaje: boolean; terminar: () => void } | undefined

    const cambiarCanal = (channel: EstadoCanal) =>
      setEstado((previous) => (previous.channel === channel ? previous : { ...previous, channel }))

    function connect() {
      const protocolo = location.protocol === 'https:' ? 'wss' : 'ws'
      const fresh = new WebSocket(`${protocolo}://${location.host}/api/diagnostics/ws`)
      socket = fresh
      const limiteConexion = setTimeout(() => {
        if (fresh.readyState === WebSocket.CONNECTING) {
          discard(fresh, { reason: 'timed-out' }, 'disconnected')
        }
      }, TIEMPO_MAXIMO_CONEXION_MS)

      fresh.onopen = () => {
        clearTimeout(limiteConexion)
        attempts = 0
        lastMessageAt = Date.now()
        // Cuánto tardó en recuperarse la conexión desde que el usuario volvió a la pantalla.
        const recuperacion =
          visibleDesde === null ? {} : { msDesdeVisible: Date.now() - visibleDesde }
        visibleDesde = null
        registrarEvento('ws-open', { reconexiones: aperturas, ...recuperacion })
        aperturas += 1
        cambiarCanal('connected')
      }

      fresh.onmessage = ({ data }) => {
        lastMessageAt = Date.now()
        if (pendingCheck) pendingCheck.recibioMensaje = true
        cambiarCanal('connected')

        const text = String(data)
        if (!text.startsWith('pong:')) return
        const [gen, sent] = text.slice('pong:'.length).split(':').map(Number)
        if (gen !== generation || document.hidden || sent === undefined) return
        muestras.push(Math.round(performance.now() - sent))
        if (muestras.length > MAXIMO_MUESTRAS) muestras.shift()
        setEstado((previous) => ({ ...previous, latencia: calcularLatencia(muestras) }))
      }

      fresh.onclose = ({ code }) => {
        clearTimeout(limiteConexion)
        onClose(fresh, { code: code })
      }
    }

    /** Suelta un socket que ya no se usa: sus eventos tardíos no deben afectar el estado. */
    function release(oldOne: WebSocket) {
      oldOne.onopen = null
      oldOne.onmessage = null
      oldOne.onclose = null
      oldOne.close()
    }

    /** Abandona un socket colgado o muerto sin esperar a que el navegador lo cierre. */
    function discard(oldOne: WebSocket, detalle: Record<string, unknown>, channel: EstadoCanal) {
      onClose(oldOne, detalle, channel)
      release(oldOne)
    }

    /** Conecta ya, sin esperar el reintento programado (que el navegador pudo congelar). */
    function reconectarAhora() {
      clearTimeout(retry)
      attempts = 0
      connect()
    }

    function onClose(
      closed: WebSocket,
      detalle: Record<string, unknown>,
      channel: EstadoCanal = 'disconnected',
    ) {
      // Un socket viejo que ya se reemplazó no cuenta.
      if (!active || closed !== socket) return
      closings += 1
      registrarEvento('ws-closed', detalle)
      cambiarCanal(channel)
      attempts += 1
      retry = setTimeout(connect, Math.min(1000 * attempts, ESPERA_MAXIMA_RECONEXION_MS))
    }

    const ping = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN && !document.hidden) {
        socket.send(`ping:${generation}:${performance.now()}`)
      }
    }, INTERVALO_PING_MS)

    // El navegador puede tardar minutos en avisar que una conexión murió (Wi-Fi caído sin
    // cierre limpio): si no llega nada en un buen rato, se descarta y se abre otra.
    const watchdog = setInterval(() => {
      if (document.hidden || socket?.readyState !== WebSocket.OPEN) return
      if (Date.now() - lastMessageAt < SIN_RESPUESTA_MS) return
      discard(socket, { reason: 'no-response' }, 'no-response')
    }, INTERVALO_VIGILANCIA_MS)

    function alCambiarVisibilidad() {
      if (document.hidden) {
        pendingCheck?.terminar()
        generation += 1
        visibleDesde = null
        ocultaDesde = Date.now()
        cierresAlOcultar = closings
        registrarEvento('hidden')
        return
      }

      if (ocultaDesde === null) return
      const returnedAt = Date.now()
      const duracionMs = returnedAt - ocultaDesde
      ocultaDesde = null
      // Tras dormir, el vigilante no debe matar la conexión antes de que lleguen mensajes.
      lastMessageAt = returnedAt
      // Toda reconexión que ocurra desde ahora se mide desde que el usuario volvió.
      visibleDesde = returnedAt
      const abiertoAlVolver = socket?.readyState === WebSocket.OPEN
      // Solo este socket (el que sobrevivió al bloqueo) puede resultar mudo; uno reabierto tras
      // volver aún no ha recibido nada porque el hub no envía mensajes al abrir.
      const socketAlVolver = abiertoAlVolver ? socket : undefined
      if (abiertoAlVolver) {
        socket?.send(`ping:${generation}:${performance.now()}`)
      } else {
        // Sin conexión al volver: no esperar el reintento ni un intento colgado mientras dormía.
        if (socket?.readyState === WebSocket.CONNECTING) {
          discard(socket, { reason: 'retry-on-return' }, 'connecting')
        } else if (socket) {
          release(socket)
        }
        reconectarAhora()
      }

      const current = {
        recibioMensaje: false,
        terminar: () => {
          clearTimeout(limit)
          if (pendingCheck !== current) return
          pendingCheck = undefined
          const conexionMantenida =
            abiertoAlVolver && current.recibioMensaje && closings === cierresAlOcultar
          registrarEvento('visible', { duracionMs, conexionMantenida, abiertoAlVolver })
          if (conexionMantenida) {
            visibleDesde = null
            return
          }
          // Abierto pero mudo tras volver (típico en iPhone): está muerto. No esperar al vigilante.
          const mudo =
            socket === socketAlVolver &&
            socket?.readyState === WebSocket.OPEN &&
            !current.recibioMensaje
          if (!document.hidden && socket && mudo) {
            discard(socket, { reason: 'no-response-on-return' }, 'no-response')
            reconectarAhora()
          }
        },
      }
      const limit = setTimeout(() => current.terminar(), ESPERA_COMPROBACION_MS)
      pendingCheck = current
    }

    document.addEventListener('visibilitychange', alCambiarVisibilidad)
    connect()

    return () => {
      active = false
      document.removeEventListener('visibilitychange', alCambiarVisibilidad)
      clearInterval(ping)
      clearInterval(watchdog)
      clearTimeout(retry)
      socket?.close()
    }
  }, [])

  return status
}
