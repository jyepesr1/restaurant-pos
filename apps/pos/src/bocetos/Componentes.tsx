import { useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { Etiqueta, type Tono } from '../ui/Etiqueta'
import { IndicadorConexion } from '../ui/IndicadorConexion'
import { PanelLateral } from '../ui/PanelLateral'
import { TecladoPin } from '../ui/TecladoPin'
import { Marco } from './Marco'

// El design system a la vista: colores con significado, botones, etiquetas, indicador de
// conexión, teclado del PIN, panel lateral y aviso con Deshacer.

const TONOS: { tono: Tono; name: string; uso: string }[] = [
  { tono: 'free', name: 'Verde', uso: 'Libre, listo, pagado' },
  { tono: 'progress', name: 'Ámbar', uso: 'En proceso, en espera' },
  { tono: 'warning', name: 'Rojo', uso: 'Demora, error, quitar' },
  { tono: 'action', name: 'Azul', uso: 'La acción principal' },
  { tono: 'neutral', name: 'Gris', uso: 'Lo demás' },
]

export function Componentes() {
  const notify = useAvisar()
  const [panel, setPanel] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [delay, setEspera] = useState(0)
  const [attempts, setIntentos] = useState(0)

  return (
    <Marco title="Design system">
      <div className="mx-auto flex max-w-4xl flex-col gap-8 p-4">
        <section>
          <h2 className="font-titulo mb-3 text-2xl font-semibold">Colores con significado</h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {TONOS.map((t) => (
              <li
                key={t.tono}
                className="flex items-center gap-3 rounded-xl border border-borde bg-superficie p-3"
              >
                <Etiqueta tono={t.tono} main>
                  {t.name}
                </Etiqueta>
                <Etiqueta tono={t.tono}>{t.uso}</Etiqueta>
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
            <Boton variant="main" icono="send">
              Enviar
            </Boton>
            <Boton variant="secondary">Secundario</Boton>
            <Boton variant="success" icono="check">
              Cerrar mesa
            </Boton>
            <Boton variant="danger" icono="close">
              Anular
            </Boton>
            <Boton variant="ghost" icono="more" aria-label="Agregar" />
            <Boton variant="main" large>
              Grande · 56 px
            </Boton>
            <Boton disabled>Deshabilitado</Boton>
          </div>
        </section>

        <section>
          <h2 className="font-titulo mb-3 text-2xl font-semibold">Estado de conexión</h2>
          <div className="flex flex-col gap-2">
            <IndicadorConexion status="online" />
            <IndicadorConexion status="local_only" />
            <IndicadorConexion status="offline" pendingList={3} impresorasConFalla={1} />
          </div>
        </section>

        <section>
          <h2 className="font-titulo mb-3 text-2xl font-semibold">
            Aviso con Deshacer y panel lateral
          </h2>
          <div className="flex flex-wrap gap-2">
            <Boton
              onClick={() => notify('Quitaste Aperol Spritz', () => notify('Volvió Aperol Spritz'))}
            >
              Mostrar aviso
            </Boton>
            <Boton onClick={() => setPanel(true)}>Abrir panel lateral</Boton>
          </div>
          <PanelLateral
            opened={panel}
            title="Panel lateral"
            onClose={() => setPanel(false)}
            pie={
              <Boton variant="main" className="w-full" onClick={() => setPanel(false)}>
                Listo
              </Boton>
            }
          >
            <p>En el celular sube desde abajo; en tablet y caja sale por la derecha.</p>
          </PanelLateral>
        </section>

        <section>
          <h2 className="font-titulo mb-3 text-2xl font-semibold">Teclado del PIN</h2>
          <p className="mb-3 text-sm text-texto-suave">
            De prueba: el PIN correcto es 2468. Tras tres errores pide esperar.
          </p>
          <div className="rounded-2xl border border-borde bg-superficie p-4">
            <TecladoPin
              error={error}
              attempt={attempts}
              waitMs={delay}
              alCompletar={(pin) => {
                if (pin === '2468') {
                  setError(null)
                  setEspera(0)
                  notify('Hola, Mesero 1')
                  return
                }
                const n = attempts + 1
                setIntentos(n)
                setError('PIN incorrecto')
                setEspera(n >= 3 ? 2000 * 2 ** (n - 3) : 0)
              }}
            />
          </div>
        </section>
      </div>
    </Marco>
  )
}
