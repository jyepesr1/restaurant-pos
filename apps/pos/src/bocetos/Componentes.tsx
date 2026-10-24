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

const TONOS: { tono: Tono; nombre: string; uso: string }[] = [
  { tono: 'libre', nombre: 'Verde', uso: 'Libre, listo, pagado' },
  { tono: 'proceso', nombre: 'Ámbar', uso: 'En proceso, en espera' },
  { tono: 'alerta', nombre: 'Rojo', uso: 'Demora, error, quitar' },
  { tono: 'accion', nombre: 'Azul', uso: 'La acción principal' },
  { tono: 'neutro', nombre: 'Gris', uso: 'Lo demás' },
]

export function Componentes() {
  const avisar = useAvisar()
  const [panel, setPanel] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [espera, setEspera] = useState(0)
  const [intentos, setIntentos] = useState(0)

  return (
    <Marco titulo="Design system">
      <div className="mx-auto flex max-w-4xl flex-col gap-8 p-4">
        <section>
          <h2 className="font-titulo mb-3 text-2xl font-semibold">Colores con significado</h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {TONOS.map((t) => (
              <li
                key={t.tono}
                className="flex items-center gap-3 rounded-xl border border-borde bg-superficie p-3"
              >
                <Etiqueta tono={t.tono} fuerte>
                  {t.nombre}
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
            <Boton variante="principal" icono="enviar">
              Enviar
            </Boton>
            <Boton variante="secundario">Secundario</Boton>
            <Boton variante="exito" icono="check">
              Cerrar mesa
            </Boton>
            <Boton variante="peligro" icono="cerrar">
              Anular
            </Boton>
            <Boton variante="fantasma" icono="mas" aria-label="Agregar" />
            <Boton variante="principal" grande>
              Grande · 56 px
            </Boton>
            <Boton disabled>Deshabilitado</Boton>
          </div>
        </section>

        <section>
          <h2 className="font-titulo mb-3 text-2xl font-semibold">Estado de conexión</h2>
          <div className="flex flex-col gap-2">
            <IndicadorConexion estado="en_linea" />
            <IndicadorConexion estado="solo_local" />
            <IndicadorConexion estado="sin_conexion" pendientes={3} impresorasConFalla={1} />
          </div>
        </section>

        <section>
          <h2 className="font-titulo mb-3 text-2xl font-semibold">
            Aviso con Deshacer y panel lateral
          </h2>
          <div className="flex flex-wrap gap-2">
            <Boton
              onClick={() => avisar('Quitaste Aperol Spritz', () => avisar('Volvió Aperol Spritz'))}
            >
              Mostrar aviso
            </Boton>
            <Boton onClick={() => setPanel(true)}>Abrir panel lateral</Boton>
          </div>
          <PanelLateral
            abierto={panel}
            titulo="Panel lateral"
            alCerrar={() => setPanel(false)}
            pie={
              <Boton variante="principal" className="w-full" onClick={() => setPanel(false)}>
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
              intento={intentos}
              esperaMs={espera}
              alCompletar={(pin) => {
                if (pin === '2468') {
                  setError(null)
                  setEspera(0)
                  avisar('Hola, Mesero 1')
                  return
                }
                const n = intentos + 1
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
