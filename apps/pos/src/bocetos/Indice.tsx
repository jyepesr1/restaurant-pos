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

const DIRECCIONES: { marca: Marca; nombre: string; idea: string; muestras: string[] }[] = [
  {
    marca: 'bagno',
    nombre: 'Bagno',
    idea: 'El mundo de la carta: suelo de arena, marino que escribe y actúa, toldo a rayas y títulos en League Gothic. Con modo oscuro de noche.',
    muestras: ['#f8ecda', '#1d3552', '#dc5a0f', '#fff8ec'],
  },
  {
    marca: 'taller',
    nombre: 'Taller',
    idea: 'Como el panel de la carta: herramienta gris y neutra, letra del sistema y el naranja de marca solo en la acción principal.',
    muestras: ['#f1f2f4', '#ffffff', '#b8491a', '#1a1c1e'],
  },
  {
    marca: 'noche',
    nombre: 'Noche en la terraza',
    idea: 'Bagno en oscuro siempre: el marino del pie de la carta como suelo, para el bar de noche y la cocina.',
    muestras: ['#0f1b2b', '#172a40', '#c24e14', '#eedecb'],
  },
  {
    marca: 'neutra',
    nombre: 'Neutra (producto)',
    idea: 'Sin marca: la base que vería otro restaurante antes de configurar la suya.',
    muestras: ['#f4f5f7', '#ffffff', '#1d4ed8', '#111827'],
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
            Elige una y abre las pantallas: todas cambian. Se recuerda en este equipo.
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
