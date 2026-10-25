import { useState } from 'react'
import { TecladoPin } from '../ui/TecladoPin'
import { ErrorApi } from './api'
import { sala, useSala } from './contexto'
import { MarcoSala } from './MarcoSala'

// Entrar con el PIN (ADR-008). El PIN lo comprueba el hub: hace falta conexión para entrar, no
// para trabajar después (lo hecho sin conexión con la sesión abierta vale).

export function Entrar() {
  const { equipo, sesionCerradaPor } = useSala()
  const [error, setError] = useState<string | null>(null)
  const [intento, setIntento] = useState(0)
  const [esperaMs, setEsperaMs] = useState(0)
  const [ocupado, setOcupado] = useState(false)

  const enviar = async (pin: string) => {
    setOcupado(true)
    try {
      await sala.entrar(pin)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.')
      setEsperaMs(e instanceof ErrorApi ? e.esperaMs : 0)
      setIntento((i) => i + 1)
      setOcupado(false)
    }
  }

  return (
    <MarcoSala titulo={equipo?.nombre ?? 'Entrar'}>
      <div className="p-4 pt-10">
        <TecladoPin
          titulo={
            sesionCerradaPor === 'inactividad'
              ? 'Tu sesión se cerró por falta de uso. Escribe tu PIN'
              : 'Escribe tu PIN'
          }
          error={error}
          intento={intento}
          esperaMs={esperaMs}
          ocupado={ocupado}
          alCompletar={(pin) => void enviar(pin)}
        />
      </div>
    </MarcoSala>
  )
}
