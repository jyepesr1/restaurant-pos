import { useEffect, useState } from 'react'

export type EstadoHub = 'conectando' | 'conectado' | 'sin-conexion'

const INTERVALO_MS = 3000
const TIEMPO_ESPERA_MS = 2000

/** Consulta periódicamente si el hub responde en la red local. */
export function useEstadoHub(): EstadoHub {
  const [estado, setEstado] = useState<EstadoHub>('conectando')

  useEffect(() => {
    let activo = true

    async function consultar() {
      try {
        const res = await fetch('/api/salud', { signal: AbortSignal.timeout(TIEMPO_ESPERA_MS) })
        if (activo) setEstado(res.ok ? 'conectado' : 'sin-conexion')
      } catch {
        if (activo) setEstado('sin-conexion')
      }
    }

    consultar()
    const intervalo = setInterval(consultar, INTERVALO_MS)
    return () => {
      activo = false
      clearInterval(intervalo)
    }
  }, [])

  return estado
}
