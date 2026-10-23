import { useEffect, useState } from 'react'
import { registrarEvento } from './registro'

const INTERVALO_PING_MS = 5000
/** El hub envía un latido cada 5 s: tres ciclos sin nada indican una conexión muerta. */
const SIN_RESPUESTA_MS = 15_000
const INTERVALO_VIGILANCIA_MS = 1000
const ESPERA_MAXIMA_RECONEXION_MS = 5000
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
    let cierresAlOcultar = 0
    let comprobacion: { recibioMensaje: boolean; terminar: () => void } | undefined

    const cambiarCanal = (canal: EstadoCanal) =>
      setEstado((previo) => (previo.canal === canal ? previo : { ...previo, canal }))

    function conectar() {
      const protocolo = location.protocol === 'https:' ? 'wss' : 'ws'
      const nuevo = new WebSocket(`${protocolo}://${location.host}/api/diagnostico/ws`)
      socket = nuevo

      nuevo.onopen = () => {
        intentos = 0
        ultimoMensajeEn = Date.now()
        registrarEvento('ws-abierto', { reconexiones: aperturas })
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

      nuevo.onclose = ({ code }) => alCerrar(nuevo, { codigo: code })
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
      const muerto = socket
      alCerrar(muerto, { motivo: 'sin-respuesta' }, 'sin-respuesta')
      muerto.onclose = null
      muerto.close()
    }, INTERVALO_VIGILANCIA_MS)

    function alCambiarVisibilidad() {
      if (document.hidden) {
        comprobacion?.terminar()
        generacion += 1
        ocultaDesde = Date.now()
        cierresAlOcultar = cierres
        registrarEvento('oculta')
        return
      }

      if (ocultaDesde === null) return
      const duracionMs = Date.now() - ocultaDesde
      ocultaDesde = null
      // Tras dormir, el vigilante no debe matar la conexión antes de que lleguen mensajes.
      ultimoMensajeEn = Date.now()
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(`ping:${generacion}:${performance.now()}`)

      const actual = {
        recibioMensaje: false,
        terminar: () => {
          clearTimeout(limite)
          if (comprobacion !== actual) return
          comprobacion = undefined
          const conexionMantenida = actual.recibioMensaje && cierres === cierresAlOcultar
          registrarEvento('visible', { duracionMs, conexionMantenida })
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
