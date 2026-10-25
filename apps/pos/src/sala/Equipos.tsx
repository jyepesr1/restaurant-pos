import type { TipoDispositivo } from '@pos/sync'
import { useState } from 'react'
import { Boton } from '../ui/Boton'
import { navegar } from '../ui/ruta'
import { TecladoPin } from '../ui/TecladoPin'
import { ErrorApi } from './api'
import { sala } from './contexto'
import { DatosEquipo } from './Emparejar'
import { MarcoSala } from './MarcoSala'

// Aprobar otro equipo desde la caja: un administrador escribe su PIN y aparece el código que el
// equipo nuevo escribe en su pantalla de emparejar. Vence en pocos minutos y sirve una vez.

export function Equipos() {
  const [nombre, setNombre] = useState('')
  const [tipo, setTipo] = useState<TipoDispositivo>('mesero')
  const [error, setError] = useState<string | null>(null)
  const [intento, setIntento] = useState(0)
  const [esperaMs, setEsperaMs] = useState(0)
  const [ocupado, setOcupado] = useState(false)
  const [codigo, setCodigo] = useState<{ codigo: string; venceEn: string } | null>(null)

  const aprobar = async (pin: string) => {
    if (!nombre.trim()) {
      setError('Primero escribe el nombre del equipo')
      setIntento((i) => i + 1)
      return
    }
    setOcupado(true)
    try {
      const r = await sala.codigoParaOtroEquipo(pin, nombre, tipo)
      setCodigo({ codigo: r.codigo, venceEn: r.vence_en })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.')
      setEsperaMs(e instanceof ErrorApi ? e.esperaMs : 0)
      setIntento((i) => i + 1)
    }
    setOcupado(false)
  }

  return (
    <MarcoSala titulo="Equipos" volver="/">
      <div className="mx-auto flex max-w-md flex-col gap-6 p-4">
        {codigo ? (
          <section className="flex flex-col items-center gap-4 text-center" aria-live="polite">
            <p className="text-lg">
              En <strong>{nombre}</strong>, abre la app, toca <strong>Tengo un código</strong> y
              escribe:
            </p>
            <output className="font-titulo rounded-2xl bg-superficie-2 px-6 py-4 text-5xl tracking-[0.3em]">
              {codigo.codigo}
            </output>
            <p className="text-texto-suave">
              {`Vale una vez, hasta las ${new Date(codigo.venceEn).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}`}
            </p>
            <div className="flex w-full gap-2">
              <Boton
                variante="secundario"
                grande
                className="flex-1"
                onClick={() => {
                  setCodigo(null)
                  setNombre('')
                }}
              >
                Otro equipo
              </Boton>
              <Boton variante="principal" grande className="flex-1" onClick={() => navegar('/')}>
                Listo
              </Boton>
            </div>
          </section>
        ) : (
          <>
            <DatosEquipo
              nombre={nombre}
              tipo={tipo}
              alCambiarNombre={setNombre}
              alCambiarTipo={setTipo}
            />
            {nombre.trim() ? (
              <TecladoPin
                titulo="PIN del administrador"
                error={error}
                intento={intento}
                esperaMs={esperaMs}
                ocupado={ocupado}
                alCompletar={(pin) => void aprobar(pin)}
              />
            ) : (
              <p className="text-center text-texto-suave">
                Escribe el nombre del equipo para pedir el PIN del administrador.
              </p>
            )}
          </>
        )}
      </div>
    </MarcoSala>
  )
}
