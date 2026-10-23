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

export type EstadoCanal = 'conectando' | 'conectado' | 'sin-respuesta' | 'desconectado'

export interface Latencia {
  ultimaMs: number
  medianaMs: number
  maximaMs: number
  muestras: number
}

export interface EstadoWs {
  canal: EstadoCanal
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
  const [estado, setEstado] = useState<EstadoWs>({ canal: 'conectando', latencia: null })

  useEffect(() => {
    let activo = true
    let socket: WebSocket | undefined
    let reintento: ReturnType<typeof setTimeout> | undefined
    let intentos = 0
    let aperturas = 0
    let cierres = 0
    let ultimoMensajeEn = Date.now()
    // Cada ocultamiento invalida los pings en vuelo: su latencia incluiría el tiempo dormido.
    let generacion = 0
    const muestras: number[] = []

    let ocultaDesde: number | null = null
    let visibleDesde: number | null = null
    let cierresAlOcultar = 0
    let comprobacion: { recibioMensaje: boolean; terminar: () => void } | undefined

    const cambiarCanal = (canal: EstadoCanal) =>
      setEstado((previo) => (previo.canal === canal ? previo : { ...previo, canal }))

    function conectar() {
      const protocolo = location.protocol === 'https:' ? 'wss' : 'ws'
      const nuevo = new WebSocket(`${protocolo}://${location.host}/api/diagnostico/ws`)
      socket = nuevo
      const limiteConexion = setTimeout(() => {
        if (nuevo.readyState === WebSocket.CONNECTING) {
          descartar(nuevo, { motivo: 'tiempo-agotado' }, 'desconectado')
        }
      }, TIEMPO_MAXIMO_CONEXION_MS)

      nuevo.onopen = () => {
        clearTimeout(limiteConexion)
        intentos = 0
        ultimoMensajeEn = Date.now()
        // Cuánto tardó en recuperarse la conexión desde que el usuario volvió a la pantalla.
        const recuperacion =
          visibleDesde === null ? {} : { msDesdeVisible: Date.now() - visibleDesde }
        visibleDesde = null
        registrarEvento('ws-abierto', { reconexiones: aperturas, ...recuperacion })
        aperturas += 1
        cambiarCanal('conectado')
      }

      nuevo.onmessage = ({ data }) => {
        ultimoMensajeEn = Date.now()
        if (comprobacion) comprobacion.recibioMensaje = true
        cambiarCanal('conectado')

        const texto = String(data)
        if (!texto.startsWith('pong:')) return
        const [gen, enviado] = texto.slice('pong:'.length).split(':').map(Number)
        if (gen !== generacion || document.hidden || enviado === undefined) return
        muestras.push(Math.round(performance.now() - enviado))
        if (muestras.length > MAXIMO_MUESTRAS) muestras.shift()
        setEstado((previo) => ({ ...previo, latencia: calcularLatencia(muestras) }))
      }

      nuevo.onclose = ({ code }) => {
        clearTimeout(limiteConexion)
        alCerrar(nuevo, { codigo: code })
      }
    }

    /** Suelta un socket que ya no se usa: sus eventos tardíos no deben afectar el estado. */
    function soltar(viejo: WebSocket) {
      viejo.onopen = null
      viejo.onmessage = null
      viejo.onclose = null
      viejo.close()
    }

    /** Abandona un socket colgado o muerto sin esperar a que el navegador lo cierre. */
    function descartar(viejo: WebSocket, detalle: Record<string, unknown>, canal: EstadoCanal) {
      alCerrar(viejo, detalle, canal)
      soltar(viejo)
    }

    /** Conecta ya, sin esperar el reintento programado (que el navegador pudo congelar). */
    function reconectarAhora() {
      clearTimeout(reintento)
      intentos = 0
      conectar()
    }

    function alCerrar(
      cerrado: WebSocket,
      detalle: Record<string, unknown>,
      canal: EstadoCanal = 'desconectado',
    ) {
      // Un socket viejo que ya se reemplazó no cuenta.
      if (!activo || cerrado !== socket) return
      cierres += 1
      registrarEvento('ws-cerrado', detalle)
      cambiarCanal(canal)
      intentos += 1
      reintento = setTimeout(conectar, Math.min(1000 * intentos, ESPERA_MAXIMA_RECONEXION_MS))
    }

    const ping = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN && !document.hidden) {
        socket.send(`ping:${generacion}:${performance.now()}`)
      }
    }, INTERVALO_PING_MS)

    // El navegador puede tardar minutos en avisar que una conexión murió (Wi-Fi caído sin
    // cierre limpio): si no llega nada en un buen rato, se descarta y se abre otra.
    const vigilancia = setInterval(() => {
      if (document.hidden || socket?.readyState !== WebSocket.OPEN) return
      if (Date.now() - ultimoMensajeEn < SIN_RESPUESTA_MS) return
      descartar(socket, { motivo: 'sin-respuesta' }, 'sin-respuesta')
    }, INTERVALO_VIGILANCIA_MS)

    function alCambiarVisibilidad() {
      if (document.hidden) {
        comprobacion?.terminar()
        generacion += 1
        visibleDesde = null
        ocultaDesde = Date.now()
        cierresAlOcultar = cierres
        registrarEvento('oculta')
        return
      }

      if (ocultaDesde === null) return
      const volvioEn = Date.now()
      const duracionMs = volvioEn - ocultaDesde
      ocultaDesde = null
      // Tras dormir, el vigilante no debe matar la conexión antes de que lleguen mensajes.
      ultimoMensajeEn = volvioEn
      // Toda reconexión que ocurra desde ahora se mide desde que el usuario volvió.
      visibleDesde = volvioEn
      const abiertoAlVolver = socket?.readyState === WebSocket.OPEN
      // Solo este socket (el que sobrevivió al bloqueo) puede resultar mudo; uno reabierto tras
      // volver aún no ha recibido nada porque el hub no envía mensajes al abrir.
      const socketAlVolver = abiertoAlVolver ? socket : undefined
      if (abiertoAlVolver) {
        socket?.send(`ping:${generacion}:${performance.now()}`)
      } else {
        // Sin conexión al volver: no esperar el reintento ni un intento colgado mientras dormía.
        if (socket?.readyState === WebSocket.CONNECTING) {
          descartar(socket, { motivo: 'reintento-al-volver' }, 'conectando')
        } else if (socket) {
          soltar(socket)
        }
        reconectarAhora()
      }

      const actual = {
        recibioMensaje: false,
        terminar: () => {
          clearTimeout(limite)
          if (comprobacion !== actual) return
          comprobacion = undefined
          const conexionMantenida =
            abiertoAlVolver && actual.recibioMensaje && cierres === cierresAlOcultar
          registrarEvento('visible', { duracionMs, conexionMantenida, abiertoAlVolver })
          if (conexionMantenida) {
            visibleDesde = null
            return
          }
          // Abierto pero mudo tras volver (típico en iPhone): está muerto. No esperar al vigilante.
          const mudo =
            socket === socketAlVolver &&
            socket?.readyState === WebSocket.OPEN &&
            !actual.recibioMensaje
          if (!document.hidden && socket && mudo) {
            descartar(socket, { motivo: 'sin-respuesta-al-volver' }, 'sin-respuesta')
            reconectarAhora()
          }
        },
      }
      const limite = setTimeout(() => actual.terminar(), ESPERA_COMPROBACION_MS)
      comprobacion = actual
    }

    document.addEventListener('visibilitychange', alCambiarVisibilidad)
    conectar()

    return () => {
      activo = false
      document.removeEventListener('visibilitychange', alCambiarVisibilidad)
      clearInterval(ping)
      clearInterval(vigilancia)
      clearTimeout(reintento)
      socket?.close()
    }
  }, [])

  return estado
}
