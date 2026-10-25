import { useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { MarcaFaro } from '../ui/Logo'
import { MARCAS, type Marca as MarcaId } from '../ui/marca'
import { sala, useSala } from './contexto'
import { MarcoSala } from './MarcoSala'

// La marca del restaurante (tarea 1.3c): con cuál se ve Faro en todos los equipos. Es opcional:
// Faro es el estilo del sistema. La elige el administrador; llega a los equipos con la carta.

/** Lo que distingue a cada marca a primera vista: su suelo, su acción, su título y su logo. */
const MUESTRA: Record<
  MarcaId,
  { fondo: string; tarjeta: string; accion: string; titulo: string; texto: string; letra: string }
> = {
  faro: {
    fondo: '#f2f5f5',
    tarjeta: '#ffffff',
    accion: '#0f766e',
    titulo: '#12201f',
    texto: '#51625f',
    letra: '"Figtree Variable", system-ui, sans-serif',
  },
  'la-spritzzeria': {
    fondo: '#f8ecda',
    tarjeta: '#fff8ec',
    accion: '#1d3552',
    titulo: '#dc5a0f',
    texto: '#3c4f66',
    letra: '"League Gothic", "Arial Narrow", sans-serif',
  },
}

export function Marca() {
  const { catalogo } = useSala()
  const avisar = useAvisar()
  const actual = (catalogo?.restaurante.marca ?? 'faro') as MarcaId
  const [guardando, setGuardando] = useState<MarcaId | null>(null)
  const [error, setError] = useState<string | null>(null)

  const elegir = async (marca: MarcaId, deshacible = true) => {
    const anterior = actual
    setGuardando(marca)
    setError(null)
    try {
      await sala.cambiarMarca(marca)
      const texto = `Ahora todos los equipos se ven con ${MARCAS.find((m) => m.marca === marca)?.nombre}`
      if (deshacible) avisar(texto, () => void elegir(anterior, false))
      else avisar(texto)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cambiar la marca')
    }
    setGuardando(null)
  }

  return (
    <MarcoSala titulo="Marca del restaurante">
      <div className="mx-auto flex max-w-4xl flex-col gap-5 p-4 md:p-6">
        <p className="max-w-2xl text-texto-suave">
          Elige cómo se ve el sistema en todos los equipos del restaurante. Los colores de estado
          (verde libre, ámbar en proceso, rojo demora) son los mismos con cualquier marca.
        </p>
        {error && (
          <p className="rounded-xl bg-alerta-suave p-3 text-alerta-texto" role="alert">
            {error}
          </p>
        )}
        <ul className="grid gap-4 md:grid-cols-2">
          {MARCAS.map((m) => {
            const v = MUESTRA[m.marca]
            const elegida = m.marca === actual
            return (
              <li
                key={m.marca}
                className={`flex flex-col overflow-hidden rounded-2xl border-2 bg-superficie ${elegida ? 'border-accion-fuerte' : 'border-linea'}`}
              >
                {/* Una muestra de la pantalla con esa marca (fuera del tema actual a propósito). */}
                <div
                  aria-hidden="true"
                  className="flex flex-col gap-3 p-5"
                  style={{ background: v.fondo }}
                >
                  <div className="flex items-center gap-3">
                    {m.marca === 'faro' ? (
                      <MarcaFaro className="size-10" />
                    ) : (
                      <img
                        src="/marca/la-spritzzeria.svg"
                        alt=""
                        className="size-10 rounded-full border-2 bg-[#fff8ec] p-0.5"
                        style={{ borderColor: v.titulo }}
                      />
                    )}
                    <span className="text-2xl" style={{ color: v.titulo, fontFamily: v.letra }}>
                      {m.marca === 'faro' ? 'Salón' : 'LA SPRITZZERÍA'}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    {['Mesa 4', 'Mesa 5'].map((mesa, i) => (
                      <span
                        key={mesa}
                        className="flex-1 rounded-xl p-3 text-sm font-semibold"
                        style={{ background: v.tarjeta, color: v.texto }}
                      >
                        {mesa}
                        <span
                          className="mt-1 block h-1.5 w-10 rounded-full"
                          style={{ background: i === 0 ? '#15803d' : '#b45309' }}
                        />
                      </span>
                    ))}
                  </div>
                  <span
                    className="rounded-xl py-2.5 text-center font-semibold text-white"
                    style={{ background: v.accion }}
                  >
                    Enviar a cocina
                  </span>
                </div>
                <div className="flex flex-1 flex-col gap-3 p-5">
                  <div>
                    <p className="text-lg font-bold">{m.nombre}</p>
                    <p className="text-texto-suave">{m.descripcion}</p>
                  </div>
                  <span className="mt-auto">
                    {elegida ? (
                      <span className="inline-flex min-h-12 items-center gap-2 font-semibold text-accion-texto">
                        Es la que usan los equipos
                      </span>
                    ) : (
                      <Boton
                        variante="principal"
                        disabled={guardando !== null}
                        onClick={() => void elegir(m.marca)}
                      >
                        {guardando === m.marca ? 'Cambiando…' : `Usar ${m.nombre}`}
                      </Boton>
                    )}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </MarcoSala>
  )
}
