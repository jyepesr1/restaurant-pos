import { useState } from 'react'
import { Button } from '../ui/Button'
import { BRANDS, type Brand as BrandId } from '../ui/brand'
import { FaroMark } from '../ui/Logo'
import { useNotify } from '../ui/toasts'
import { floor, useFloor } from './context'
import { FloorFrame } from './FloorFrame'

// The restaurant's brand (task 1.3c): how Faro looks on every device. It is optional:
// Faro is the system's style. The admin picks it; it reaches the devices with the menu.

/** What sets each brand apart at a glance: its background, its action, its title and its logo. */
const SAMPLE: Record<
  BrandId,
  { background: string; card: string; action: string; title: string; text: string; font: string }
> = {
  faro: {
    background: '#f2f5f5',
    card: '#ffffff',
    action: '#0f766e',
    title: '#12201f',
    text: '#51625f',
    font: '"Figtree Variable", system-ui, sans-serif',
  },
  'la-spritzzeria': {
    background: '#f8ecda',
    card: '#fff8ec',
    action: '#1d3552',
    title: '#dc5a0f',
    text: '#3c4f66',
    font: '"League Gothic", "Arial Narrow", sans-serif',
  },
}

export function Brand() {
  const { catalog } = useFloor()
  const notify = useNotify()
  const current = (catalog?.restaurant.brand ?? 'faro') as BrandId
  const [saving, setSaving] = useState<BrandId | null>(null)
  const [error, setError] = useState<string | null>(null)

  const select = async (brand: BrandId, undoable = true) => {
    const previous = current
    setSaving(brand)
    setError(null)
    try {
      await floor.changeBrand(brand)
      const text = `Ahora todos los equipos se ven con ${BRANDS.find((m) => m.brand === brand)?.name}`
      if (undoable) notify(text, () => void select(previous, false))
      else notify(text)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cambiar la marca')
    }
    setSaving(null)
  }

  return (
    <FloorFrame title="Marca del restaurante">
      <div className="mx-auto flex max-w-4xl flex-col gap-5 p-4 md:p-6">
        <p className="max-w-2xl text-muted">
          Elige cómo se ve el sistema en todos los equipos del restaurante. Los colores de estado
          (verde libre, ámbar en proceso, rojo demora) son los mismos con cualquier marca.
        </p>
        {error && (
          <p className="rounded-xl bg-alert-soft p-3 text-alert-text" role="alert">
            {error}
          </p>
        )}
        <ul className="grid gap-4 md:grid-cols-2">
          {BRANDS.map((m) => {
            const v = SAMPLE[m.brand]
            const selected = m.brand === current
            return (
              <li
                key={m.brand}
                className={`flex flex-col overflow-hidden rounded-2xl border-2 bg-surface ${selected ? 'border-action-strong' : 'border-divider'}`}
              >
                {/* A preview of the screen in that brand (deliberately outside the current theme). */}
                <div
                  aria-hidden="true"
                  className="flex flex-col gap-3 p-5"
                  style={{ background: v.background }}
                >
                  <div className="flex items-center gap-3">
                    {m.brand === 'faro' ? (
                      <FaroMark className="size-10" />
                    ) : (
                      <img
                        src="/brand/la-spritzzeria.svg"
                        alt=""
                        className="size-10 rounded-full border-2 bg-[#fff8ec] p-0.5"
                        style={{ borderColor: v.title }}
                      />
                    )}
                    <span className="text-2xl" style={{ color: v.title, fontFamily: v.font }}>
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
                    <p className="text-muted">{m.description}</p>
                  </div>
                  <span className="mt-auto">
                    {selected ? (
                      <span className="inline-flex min-h-12 items-center gap-2 font-semibold text-action-text">
                        Es la que usan los equipos
                      </span>
                    ) : (
                      <Button
                        variant="main"
                        disabled={saving !== null}
                        onClick={() => void select(m.brand)}
                      >
                        {saving === m.brand ? 'Cambiando…' : `Usar ${m.name}`}
                      </Button>
                    )}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </FloorFrame>
  )
}
