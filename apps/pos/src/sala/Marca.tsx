import { useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { MarcaFaro } from '../ui/Logo'
import { BRANDS, type Marca as MarcaId } from '../ui/marca'
import { sala, useSala } from './contexto'
import { MarcoSala } from './MarcoSala'

// La marca del restaurante (tarea 1.3c): con cuál se ve Faro en todos los equipos. Es opcional:
// Faro es el estilo del sistema. La elige el administrador; llega a los equipos con la carta.

/** Lo que distingue a cada marca a primera vista: su suelo, su acción, su título y su logo. */
const MUESTRA: Record<
  MarcaId,
  { fondo: string; card: string; action: string; title: string; text: string; letra: string }
> = {
  faro: {
    fondo: '#f2f5f5',
    card: '#ffffff',
    action: '#0f766e',
    title: '#12201f',
    text: '#51625f',
    letra: '"Figtree Variable", system-ui, sans-serif',
  },
  'la-spritzzeria': {
    fondo: '#f8ecda',
    card: '#fff8ec',
    action: '#1d3552',
    title: '#dc5a0f',
    text: '#3c4f66',
    letra: '"League Gothic", "Arial Narrow", sans-serif',
  },
}

export function Marca() {
  const { catalog } = useSala()
  const avisar = useAvisar()
  const current = (catalog?.restaurant.brand ?? 'faro') as MarcaId
  const [guardando, setGuardando] = useState<MarcaId | null>(null)
  const [error, setError] = useState<string | null>(null)

  const select = async (brand: MarcaId, deshacible = true) => {
    const previous = current
    setGuardando(brand)
    setError(null)
    try {
      await sala.cambiarMarca(brand)
      const text = `Ahora todos los equipos se ven con ${BRANDS.find((m) => m.brand === brand)?.name}`
      if (deshacible) avisar(text, () => void select(previous, false))
      else avisar(text)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cambiar la marca')
    }
    setGuardando(null)
  }

  return (
    <MarcoSala title="Marca del restaurante">
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
          {BRANDS.map((m) => {
            const v = MUESTRA[m.brand]
            const elegida = m.brand === current
            return (
              <li
                key={m.brand}
                className={`flex flex-col overflow-hidden rounded-2xl border-2 bg-superficie ${elegida ? 'border-accion-fuerte' : 'border-linea'}`}
              >
                {/* Una muestra de la pantalla con esa marca (fuera del tema actual a propósito). */}
                <div
                  aria-hidden="true"
                  className="flex flex-col gap-3 p-5"
                  style={{ background: v.fondo }}
                >
                  <div className="flex items-center gap-3">
                    {m.brand === 'faro' ? (
                      <MarcaFaro className="size-10" />
                    ) : (
                      <img
                        src="/marca/la-spritzzeria.svg"
                        alt=""
                        className="size-10 rounded-full border-2 bg-[#fff8ec] p-0.5"
                        style={{ borderColor: v.title }}
                      />
                    )}
                    <span className="text-2xl" style={{ color: v.title, fontFamily: v.letra }}>
                      {m.brand === 'faro' ? 'Salón' : 'LA SPRITZZERÍA'}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    {['Mesa 4', 'Mesa 5'].map((table, i) => (
                      <span
                        key={table}
                        className="flex-1 rounded-xl p-3 text-sm font-semibold"
                        style={{ background: v.card, color: v.text }}
                      >
                        {table}
                        <span
                          className="mt-1 block h-1.5 w-10 rounded-full"
                          style={{ background: i === 0 ? '#15803d' : '#b45309' }}
                        />
                      </span>
                    ))}
                  </div>
                  <span
                    className="rounded-xl py-2.5 text-center font-semibold text-white"
                    style={{ background: v.action }}
                  >
                    Enviar a cocina
                  </span>
                </div>
                <div className="flex flex-1 flex-col gap-3 p-5">
                  <div>
                    <p className="text-lg font-bold">{m.name}</p>
                    <p className="text-texto-suave">{m.description}</p>
                  </div>
                  <span className="mt-auto">
                    {elegida ? (
                      <span className="inline-flex min-h-12 items-center gap-2 font-semibold text-accion-texto">
                        Es la que usan los equipos
                      </span>
                    ) : (
                      <Boton
                        variant="main"
                        disabled={guardando !== null}
                        onClick={() => void select(m.brand)}
                      >
                        {guardando === m.brand ? 'Cambiando…' : `Usar ${m.name}`}
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
