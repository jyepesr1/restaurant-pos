import { claseBoton } from '../ui/Boton'
import type { EstadoConexion } from '../ui/IndicadorConexion'
import { Icono, type NombreIcono } from '../ui/iconos'
import { type Marca, useMarca } from '../ui/marca'
import { Grupo, Opcion } from '../ui/Opciones'
import { navegar } from '../ui/ruta'
import { reiniciarBocetos, simular, useSimulacion } from './estado'
import { Marco } from './Marco'

// Índice de los bocetos de la tarea 0.9 (brief §5): para abrirlos en el celular y la tablet.

const PANTALLAS: { ruta: string; titulo: string; para: string; icono: NombreIcono }[] = [
  { ruta: '/bocetos/plano', titulo: 'Plano de mesas', para: 'Mesero y caja', icono: 'plano' },
  { ruta: '/bocetos/pedido?mesa=2', titulo: 'Toma de pedido', para: 'Mesero', icono: 'lapiz' },
  { ruta: '/bocetos/kds', titulo: 'Cocina y barra (KDS)', para: 'Cocina y barra', icono: 'fuego' },
  {
    ruta: '/bocetos/precuenta?mesa=12',
    titulo: 'Precuenta y división',
    para: 'Caja',
    icono: 'recibo',
  },
  { ruta: '/bocetos/cobro?mesa=12', titulo: 'Cobro', para: 'Caja', icono: 'billete' },
  {
    ruta: '/bocetos/componentes',
    titulo: 'Design system',
    para: 'Colores y componentes',
    icono: 'check',
  },
]

// Faro es el estilo del sistema; La Spritzzería es la marca opcional del primer cliente (1.3c).
const DIRECCIONES: { marca: Marca; nombre: string; idea: string; muestras: string[] }[] = [
  {
    marca: 'faro',
    nombre: 'Faro',
    idea: 'El estilo del sistema: claro, verde azulado, letra Figtree. Lo ve todo restaurante sin marca propia.',
    muestras: ['#f2f5f5', '#ffffff', '#0f766e', '#12201f'],
  },
  {
    marca: 'la-spritzzeria',
    nombre: 'La Spritzzería',
    idea: 'El mundo de su carta: arena y marino de día, la terraza de noche; toldo a rayas y títulos en League Gothic.',
    muestras: ['#f8ecda', '#1d3552', '#dc5a0f', '#0f1b2b'],
  },
]

const CONEXIONES: [EstadoConexion, string][] = [
  ['en_linea', 'En línea'],
  ['solo_local', 'Solo red local'],
  ['sin_conexion', 'Sin conexión'],
]

export function Indice() {
  const simulacion = useSimulacion()
  const [marca, elegirMarca] = useMarca()
  return (
    <Marco titulo="Bocetos del POS" volver="/">
      <div className="mx-auto max-w-3xl p-4">
        <p className="mb-4 text-texto-suave">
          Bocetos navegables con la carta real de La Spritzzería. Los datos son de ejemplo y no se
          guardan: recargar la página los reinicia.
        </p>
        <section className="mb-6" aria-labelledby="direccion">
          <h2 id="direccion" className="font-titulo mb-1 text-2xl font-semibold">
            Dirección visual
          </h2>
          <p className="mb-3 text-sm text-texto-suave">
            Faro es el estilo del sistema. La Spritzzería muestra cómo se ve con la marca de un
            restaurante. Aquí se elige solo en este equipo, para comparar.
          </p>
          <Grupo etiqueta="Dirección visual" className="grid gap-2 sm:grid-cols-2">
            {DIRECCIONES.map((d) => (
              <Opcion
                key={d.marca}
                forma="tarjeta"
                elegida={marca === d.marca}
                alElegir={() => elegirMarca(d.marca)}
              >
                <span className="flex items-center gap-2">
                  <span className="text-lg">{d.nombre}</span>
                  <span className="ml-auto flex" aria-hidden="true">
                    {d.muestras.map((color) => (
                      <span
                        key={color}
                        className="-ml-1 size-5 rounded-full border border-black/20"
                        style={{ background: color }}
                      />
                    ))}
                  </span>
                </span>
                <span className="mt-1 block text-sm font-normal">{d.idea}</span>
              </Opcion>
            ))}
          </Grupo>
        </section>
        <ul className="grid gap-3 sm:grid-cols-2">
          {PANTALLAS.map((p) => (
            <li key={p.ruta}>
              <a
                href={p.ruta}
                onClick={(e) => {
                  e.preventDefault()
                  navegar(p.ruta)
                }}
                className="flex min-h-20 items-center gap-4 rounded-2xl border border-borde bg-superficie p-4 hover:bg-superficie-2 focus-visible:outline-3 focus-visible:outline-foco"
              >
                <span className="rounded-xl bg-accion-suave p-3 text-accion-texto">
                  <Icono nombre={p.icono} width="1.5em" height="1.5em" />
                </span>
                <span>
                  <span className="font-titulo block text-2xl font-semibold">{p.titulo}</span>
                  <span className="text-texto-suave">{p.para}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
        <section className="mt-8 rounded-2xl border border-borde bg-superficie p-4">
          <h2 className="mb-1 text-lg font-semibold">Simular</h2>
          <p className="mb-3 text-sm text-texto-suave">
            Para ver en cada pantalla el indicador de conexión, los eventos por enviar y una
            impresora que no responde.
          </p>
          <Grupo etiqueta="Conexión" className="flex flex-wrap gap-2">
            {CONEXIONES.map(([conexion, texto]) => (
              <Opcion
                key={conexion}
                elegida={simulacion.conexion === conexion}
                alElegir={() =>
                  simular({ conexion, pendientes: conexion === 'sin_conexion' ? 3 : 0 })
                }
              >
                {texto}
              </Opcion>
            ))}
          </Grupo>
          <div className="mt-3 flex flex-wrap gap-2">
            <Opcion
              elegida={simulacion.impresorasConFalla > 0}
              alElegir={() =>
                simular({ impresorasConFalla: simulacion.impresorasConFalla > 0 ? 0 : 1 })
              }
            >
              Impresora de barra caída
            </Opcion>
          </div>
        </section>
        <button
          type="button"
          className={`${claseBoton('secundario')} mt-6`}
          onClick={reiniciarBocetos}
        >
          Volver a los datos de ejemplo
        </button>
      </div>
    </Marco>
  )
}
