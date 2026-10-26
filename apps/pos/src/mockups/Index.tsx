import { buttonClass } from '../ui/Button'
import { type Brand, useBrand } from '../ui/brand'
import type { ConnectionState } from '../ui/ConnectionIndicator'
import { Icon, type IconName } from '../ui/icons'
import { Group, Option } from '../ui/Options'
import { navigate } from '../ui/route'
import { Frame } from './Frame'
import { resetMockups, simulate, useSimulation } from './state'

// Index of the task 0.9 mockups (brief §5): to open them on the phone and the tablet.

const SCREENS: { route: string; title: string; audience: string; icon: IconName }[] = [
  {
    route: '/mockups/floor-plan',
    title: 'Plano de mesas',
    audience: 'Mesero y caja',
    icon: 'floorPlan',
  },
  { route: '/mockups/order?table=2', title: 'Toma de pedido', audience: 'Mesero', icon: 'pencil' },
  {
    route: '/mockups/kds',
    title: 'Cocina y barra (KDS)',
    audience: 'Cocina y barra',
    icon: 'fire',
  },
  {
    route: '/mockups/pre-bill?table=12',
    title: 'Precuenta y división',
    audience: 'Caja',
    icon: 'receipt',
  },
  { route: '/mockups/checkout?table=12', title: 'Cobro', audience: 'Caja', icon: 'bill' },
  {
    route: '/mockups/components',
    title: 'Design system',
    audience: 'Colores y componentes',
    icon: 'check',
  },
]

// Faro is the system's style; La Spritzzería is the optional brand of the first customer (1.3c).
const DIRECTIONS: { brand: Brand; name: string; idea: string; samples: string[] }[] = [
  {
    brand: 'faro',
    name: 'Faro',
    idea: 'El estilo del sistema: claro, verde azulado, letra Figtree. Lo ve todo restaurante sin marca propia.',
    samples: ['#f2f5f5', '#ffffff', '#0f766e', '#12201f'],
  },
  {
    brand: 'la-spritzzeria',
    name: 'La Spritzzería',
    idea: 'El mundo de su carta: arena y marino de día, la terraza de noche; toldo a rayas y títulos en League Gothic.',
    samples: ['#f8ecda', '#1d3552', '#dc5a0f', '#0f1b2b'],
  },
]

const CONNECTIONS: [ConnectionState, string][] = [
  ['online', 'En línea'],
  ['local_only', 'Solo red local'],
  ['offline', 'Sin conexión'],
]

export function Index() {
  const simulation = useSimulation()
  const [brand, selectBrand] = useBrand()
  return (
    <Frame title="Bocetos del POS" back="/">
      <div className="mx-auto max-w-3xl p-4">
        <p className="mb-4 text-texto-suave">
          Bocetos navegables con la carta real de La Spritzzería. Los datos son de ejemplo y no se
          guardan: recargar la página los reinicia.
        </p>
        <section className="mb-6" aria-labelledby="address">
          <h2 id="address" className="font-titulo mb-1 text-2xl font-semibold">
            Dirección visual
          </h2>
          <p className="mb-3 text-sm text-texto-suave">
            Faro es el estilo del sistema. La Spritzzería muestra cómo se ve con la marca de un
            restaurante. Aquí se elige solo en este equipo, para comparar.
          </p>
          <Group label="Dirección visual" className="grid gap-2 sm:grid-cols-2">
            {DIRECTIONS.map((d) => (
              <Option
                key={d.brand}
                shape="card"
                selected={brand === d.brand}
                onChoose={() => selectBrand(d.brand)}
              >
                <span className="flex items-center gap-2">
                  <span className="text-lg">{d.name}</span>
                  <span className="ml-auto flex" aria-hidden="true">
                    {d.samples.map((color) => (
                      <span
                        key={color}
                        className="-ml-1 size-5 rounded-full border border-black/20"
                        style={{ background: color }}
                      />
                    ))}
                  </span>
                </span>
                <span className="mt-1 block text-sm font-normal">{d.idea}</span>
              </Option>
            ))}
          </Group>
        </section>
        <ul className="grid gap-3 sm:grid-cols-2">
          {SCREENS.map((p) => (
            <li key={p.route}>
              <a
                href={p.route}
                onClick={(e) => {
                  e.preventDefault()
                  navigate(p.route)
                }}
                className="flex min-h-20 items-center gap-4 rounded-2xl border border-borde bg-superficie p-4 hover:bg-superficie-2 focus-visible:outline-3 focus-visible:outline-foco"
              >
                <span className="rounded-xl bg-accion-suave p-3 text-accion-texto">
                  <Icon name={p.icon} width="1.5em" height="1.5em" />
                </span>
                <span>
                  <span className="font-titulo block text-2xl font-semibold">{p.title}</span>
                  <span className="text-texto-suave">{p.audience}</span>
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
          <Group label="Conexión" className="flex flex-wrap gap-2">
            {CONNECTIONS.map(([connection, text]) => (
              <Option
                key={connection}
                selected={simulation.connection === connection}
                onChoose={() =>
                  simulate({ connection, pendingList: connection === 'offline' ? 3 : 0 })
                }
              >
                {text}
              </Option>
            ))}
          </Group>
          <div className="mt-3 flex flex-wrap gap-2">
            <Option
              selected={simulation.failingPrinters > 0}
              onChoose={() => simulate({ failingPrinters: simulation.failingPrinters > 0 ? 0 : 1 })}
            >
              Impresora de barra caída
            </Option>
          </div>
        </section>
        <button type="button" className={`${buttonClass('secondary')} mt-6`} onClick={resetMockups}>
          Volver a los datos de ejemplo
        </button>
      </div>
    </Frame>
  )
}
