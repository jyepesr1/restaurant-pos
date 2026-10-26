import { useState } from 'react'
import { Button } from '../ui/Button'
import { ConnectionIndicator } from '../ui/ConnectionIndicator'
import { Label, type Tone } from '../ui/Label'
import { PinPad } from '../ui/PinPad'
import { SidePanel } from '../ui/SidePanel'
import { useNotify } from '../ui/toasts'
import { Frame } from './Frame'

// The design system at a glance: meaningful colors, buttons, tags, connection indicator,
// PIN keypad, side panel and toast with Undo.

const TONES: { tone: Tone; name: string; use: string }[] = [
  { tone: 'free', name: 'Verde', use: 'Libre, listo, pagado' },
  { tone: 'progress', name: 'Ámbar', use: 'En proceso, en espera' },
  { tone: 'warning', name: 'Rojo', use: 'Demora, error, quitar' },
  { tone: 'action', name: 'Azul', use: 'La acción principal' },
  { tone: 'neutral', name: 'Gris', use: 'Lo demás' },
]

export function Components() {
  const notify = useNotify()
  const [panel, setPanel] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [delay, setDelay] = useState(0)
  const [attempts, setAttempts] = useState(0)

  return (
    <Frame title="Design system">
      <div className="mx-auto flex max-w-4xl flex-col gap-8 p-4">
        <section>
          <h2 className="font-titulo mb-3 text-2xl font-semibold">Colores con significado</h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {TONES.map((t) => (
              <li
                key={t.tone}
                className="flex items-center gap-3 rounded-xl border border-borde bg-superficie p-3"
              >
                <Label tone={t.tone} main>
                  {t.name}
                </Label>
                <Label tone={t.tone}>{t.use}</Label>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm text-texto-suave">
            Contraste AA en claro y oscuro (lo verifica una prueba automática). El color siempre va
            con un ícono y un texto.
          </p>
        </section>

        <section>
          <h2 className="font-titulo mb-3 text-2xl font-semibold">Botones (mínimo 48 px)</h2>
          <div className="flex flex-wrap gap-2">
            <Button variant="main" icon="send">
              Enviar
            </Button>
            <Button variant="secondary">Secundario</Button>
            <Button variant="success" icon="check">
              Cerrar mesa
            </Button>
            <Button variant="danger" icon="close">
              Anular
            </Button>
            <Button variant="ghost" icon="more" aria-label="Agregar" />
            <Button variant="main" large>
              Grande · 56 px
            </Button>
            <Button disabled>Deshabilitado</Button>
          </div>
        </section>

        <section>
          <h2 className="font-titulo mb-3 text-2xl font-semibold">Estado de conexión</h2>
          <div className="flex flex-col gap-2">
            <ConnectionIndicator status="online" />
            <ConnectionIndicator status="local_only" />
            <ConnectionIndicator status="offline" pendingList={3} failingPrinters={1} />
          </div>
        </section>

        <section>
          <h2 className="font-titulo mb-3 text-2xl font-semibold">
            Aviso con Deshacer y panel lateral
          </h2>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => notify('Quitaste Aperol Spritz', () => notify('Volvió Aperol Spritz'))}
            >
              Mostrar aviso
            </Button>
            <Button onClick={() => setPanel(true)}>Abrir panel lateral</Button>
          </div>
          <SidePanel
            opened={panel}
            title="Panel lateral"
            onClose={() => setPanel(false)}
            footer={
              <Button variant="main" className="w-full" onClick={() => setPanel(false)}>
                Listo
              </Button>
            }
          >
            <p>En el celular sube desde abajo; en tablet y caja sale por la derecha.</p>
          </SidePanel>
        </section>

        <section>
          <h2 className="font-titulo mb-3 text-2xl font-semibold">Teclado del PIN</h2>
          <p className="mb-3 text-sm text-texto-suave">
            De prueba: el PIN correcto es 2468. Tras tres errores pide esperar.
          </p>
          <div className="rounded-2xl border border-borde bg-superficie p-4">
            <PinPad
              error={error}
              attempt={attempts}
              waitMs={delay}
              onComplete={(pin) => {
                if (pin === '2468') {
                  setError(null)
                  setDelay(0)
                  notify('Hola, Mesero 1')
                  return
                }
                const n = attempts + 1
                setAttempts(n)
                setError('PIN incorrecto')
                setDelay(n >= 3 ? 2000 * 2 ** (n - 3) : 0)
              }}
            />
          </div>
        </section>
      </div>
    </Frame>
  )
}
