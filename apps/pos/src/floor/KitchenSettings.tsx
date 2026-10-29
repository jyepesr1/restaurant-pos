import { useCallback, useEffect, useState } from 'react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/icons'
import { Label } from '../ui/Label'
import { Group, Option } from '../ui/Options'
import { navigate } from '../ui/route'
import { SidePanel } from '../ui/SidePanel'
import { useNotify } from '../ui/toasts'
import { floor, useFloor } from './context'
import type { KitchenConfig, KitchenPrinter } from './engine'
import { FloorFrame } from './FloorFrame'
import { fieldClass } from './SignIn'
import { Confirm } from './Staff'

// «Cocina e impresoras» (ADR-015): how each station receives its tickets (printer, screen or
// both), the printers with their test page, the kitchen screens, turning this device into one,
// and the amber and red minutes. For whoever manages the devices.

const CODE_PAGE_OPTIONS: { value: KitchenPrinter['code_page']; name: string; detail: string }[] = [
  {
    value: 'pc850',
    name: 'Con tildes (recomendada)',
    detail: 'La de casi todas: Jaltech, Epson, Xprinter',
  },
  {
    value: 'wpc1252',
    name: 'Con tildes de Windows',
    detail: 'Si con la recomendada salen símbolos raros',
  },
  { value: 'no_accents', name: 'Sin tildes', detail: 'Si ninguna imprime bien la ñ' },
]

const NEW_PRINTER: KitchenPrinter = {
  name: '',
  connection: 'network',
  address: '',
  port: 9100,
  width: 80,
  code_page: 'pc850',
  fallback_id: null,
  station_ids: [],
  active: true,
}

const message = (e: unknown) => (e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.')

export function KitchenSettings() {
  const notify = useNotify()
  const { printers: statuses } = useFloor()
  const [config, setConfig] = useState<KitchenConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<KitchenPrinter | null>(null)

  const load = useCallback(() => {
    floor
      .kitchenConfig()
      .then((c) => {
        setConfig(c)
        setError(null)
      })
      .catch((e) => setError(message(e)))
  }, [])
  useEffect(load, [load])

  if (error && !config)
    return (
      <FloorFrame title="Cocina e impresoras">
        <div className="mx-auto flex max-w-3xl flex-col items-start gap-3 p-6">
          <p className="text-alert-text">{error}</p>
          <Button onClick={load}>Intentar de nuevo</Button>
        </div>
      </FloorFrame>
    )
  if (!config)
    return (
      <FloorFrame title="Cocina e impresoras">
        <p className="p-6 text-muted">Leyendo la configuración de la caja…</p>
      </FloorFrame>
    )

  const stateOf = (id: string) =>
    statuses.find((e) => e.id === id) ?? config.statuses.find((e) => e.id === id)
  const activePrinters = config.printers.filter((i) => i.active)
  const stationName = (id: string) => config.stations.find((e) => e.id === id)?.name ?? 'Estación'

  const attempt = async (id: string, name: string) => {
    try {
      await floor.testPrinter(id)
      notify(`Prueba enviada a ${name}: revisa que salga el papel`)
    } catch (e) {
      notify(message(e))
    }
  }

  return (
    <FloorFrame
      title="Cocina e impresoras"
      actions={
        <Button variant="main" icon="more" onClick={() => setEditing({ ...NEW_PRINTER })}>
          Agregar impresora
        </Button>
      }
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-8 p-4 md:p-6">
        <section aria-labelledby="title-stations" className="flex flex-col gap-3">
          <h2 id="title-stations" className="text-xl font-bold tracking-tight">
            Cómo recibe cada estación
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {config.stations.map((e) => {
              const stationPrinters = activePrinters.filter((i) => i.station_ids.includes(e.id))
              const stationScreens = config.screens.filter((p) => p.station_ids.includes(e.id))
              const nothing = stationPrinters.length === 0 && stationScreens.length === 0
              return (
                <li
                  key={e.id}
                  className="flex flex-col gap-2 rounded-2xl border border-divider bg-surface p-4"
                >
                  <span className="text-lg font-semibold">{e.name}</span>
                  {stationPrinters.map((i) => (
                    <span key={i.id} className="flex items-center gap-2">
                      <Icon name="printer" className="size-5" />
                      {i.name}
                    </span>
                  ))}
                  {stationScreens.map((p) => (
                    <span key={p.device_id} className="flex items-center gap-2">
                      <Icon name="floorPlan" className="size-5" />
                      {p.name}
                    </span>
                  ))}
                  {nothing && (
                    <Label tone="progress" icon="warning">
                      No le llega nada: ponle una impresora o una pantalla
                    </Label>
                  )}
                </li>
              )
            })}
          </ul>
          <p className="text-sm text-muted">
            Sin pantalla, el mesero marca «Entregado» al llevar el plato y la caja ve lo pendiente
            en «Pedidos en cocina».
          </p>
        </section>

        <section aria-labelledby="title-printers" className="flex flex-col gap-3">
          <h2 id="title-printers" className="text-xl font-bold tracking-tight">
            Impresoras de comandas
          </h2>
          {config.printers.length === 0 && (
            <div className="rounded-2xl border border-dashed border-border p-6 text-center">
              <p className="text-muted">
                Todavía no hay impresoras. Agrega la de cocina y la de barra con su dirección de
                red.
              </p>
              <Button
                variant="main"
                icon="more"
                className="mt-3"
                onClick={() => setEditing({ ...NEW_PRINTER })}
              >
                Agregar impresora
              </Button>
            </div>
          )}
          <ul className="flex flex-col gap-3">
            {config.printers.map((i) => {
              const status = stateOf(i.id)
              return (
                <li
                  key={i.id}
                  className={`flex flex-wrap items-center gap-3 rounded-2xl border border-divider bg-surface p-4 ${i.active ? '' : 'opacity-60'}`}
                >
                  <Icon name="printer" className="size-6" />
                  <div className="flex min-w-48 flex-1 flex-col items-start gap-1">
                    <span className="text-lg font-semibold">{i.name}</span>
                    <span className="figures text-sm text-muted">
                      {i.connection === 'network'
                        ? `${i.address}:${i.port ?? 9100} · ${i.width} mm`
                        : `USB · ${i.width} mm`}
                      {i.station_ids.length > 0 &&
                        ` · ${i.station_ids.map(stationName).join(', ')}`}
                    </span>
                    {!i.active ? (
                      <Label tone="neutral" icon="close">
                        Archivada
                      </Label>
                    ) : status?.status === 'failed' ? (
                      <span className="text-sm font-semibold text-alert-text">
                        <Icon name="warning" className="mr-1 inline size-4" />
                        {status.error}
                        {status.pendingList > 0 && ` (${status.pendingList} esperando)`}
                      </span>
                    ) : (
                      <Label tone="free" icon="check">
                        {status?.pendingList ? `Imprimiendo (${status.pendingList})` : 'Lista'}
                      </Label>
                    )}
                  </div>
                  {i.active && (
                    <Button icon="printer" onClick={() => attempt(i.id, i.name)}>
                      Imprimir prueba
                    </Button>
                  )}
                  <Button variant="ghost" icon="pencil" onClick={() => setEditing({ ...i })}>
                    Editar
                  </Button>
                </li>
              )
            })}
          </ul>
        </section>

        <Screens config={config} onChange={load} />
        <Timers config={config} onChange={load} />
        <Courses config={config} onChange={load} />
      </div>

      {editing && (
        <EditPrinter
          initial={editing}
          config={config}
          onClose={() => setEditing(null)}
          onSave={() => {
            setEditing(null)
            load()
          }}
        />
      )}
    </FloorFrame>
  )
}

function Stations({
  config,
  selectedIds,
  onChange,
}: {
  config: KitchenConfig
  selectedIds: string[]
  onChange: (ids: string[]) => void
}) {
  return (
    <Group label="Estaciones" className="flex flex-wrap gap-2">
      {config.stations.map((e) => (
        <Option
          key={e.id}
          selected={selectedIds.includes(e.id)}
          onChoose={() =>
            onChange(
              selectedIds.includes(e.id)
                ? selectedIds.filter((x) => x !== e.id)
                : [...selectedIds, e.id],
            )
          }
        >
          {e.name}
        </Option>
      ))}
    </Group>
  )
}

function EditPrinter({
  initial,
  config,
  onClose,
  onSave,
}: {
  initial: KitchenPrinter
  config: KitchenConfig
  onClose: () => void
  onSave: () => void
}) {
  const notify = useNotify()
  const [b, setB] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [taken, setTaken] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const patch = (partial: Partial<KitchenPrinter>) => setB((x) => ({ ...x, ...partial }))
  const others = config.printers.filter((i) => i.active && i.id !== b.id)

  const save = async (changes: Partial<KitchenPrinter> = {}) => {
    const data = { ...b, ...changes }
    if (!data.name.trim()) return setError('Ponle un nombre, por ejemplo «Cocina»')
    if (data.connection === 'network' && !data.address.trim())
      return setError('Escribe la IP de la impresora (sale en su hoja de configuración)')
    setTaken(true)
    try {
      await floor.savePrinter({
        ...data,
        name: data.name.trim(),
        address: data.address.trim(),
      })
      notify(data.active ? `Guardaste ${data.name.trim()}` : `Archivaste ${data.name.trim()}`)
      onSave()
    } catch (e) {
      setError(message(e))
      setTaken(false)
    }
  }

  return (
    <SidePanel
      opened
      title={initial.id ? `Editar ${initial.name}` : 'Impresora nueva'}
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-2">
          {error && (
            <p role="alert" className="text-alert-text">
              {error}
            </p>
          )}
          {archiving ? (
            <Confirm
              question={
                b.fallback_id
                  ? `¿Archivar ${b.name}? Lo que esté esperando sale por la de respaldo. No se borra: se puede volver a usar.`
                  : `¿Archivar ${b.name}? No tiene respaldo: lo que esté esperando no saldrá y la caja lo verá en «Pedidos en cocina» para descartarlo o reimprimirlo. No se borra: se puede volver a usar.`
              }
              yes="Archivar"
              taken={taken}
              onConfirm={() => save({ active: false })}
              onCancel={() => setArchiving(false)}
            />
          ) : (
            <div className="flex gap-2">
              <Button
                variant="main"
                large
                className="flex-1"
                disabled={taken}
                onClick={() => save()}
              >
                Guardar
              </Button>
              {initial.id && initial.active && (
                <Button variant="ghost" onClick={() => setArchiving(true)}>
                  Archivar
                </Button>
              )}
              {initial.id && !initial.active && (
                <Button disabled={taken} onClick={() => save({ active: true })}>
                  Volver a usar
                </Button>
              )}
            </div>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <label className="flex flex-col gap-1">
          <span className="font-semibold">Nombre</span>
          <input
            className={fieldClass}
            value={b.name}
            maxLength={60}
            placeholder="Cocina"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </label>

        <div className="flex flex-col gap-2">
          <span className="font-semibold">Qué imprime</span>
          <Stations
            config={config}
            selectedIds={b.station_ids}
            onChange={(ids) => patch({ station_ids: ids })}
          />
          {b.station_ids.length === 0 && (
            <span className="text-sm text-muted">
              Sin cocina ni barra: solo imprime cuando otra impresora no responde.
            </span>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <span className="font-semibold">Conexión</span>
          <Group label="Conexión" className="flex flex-wrap gap-2">
            <Option
              selected={b.connection === 'network'}
              onChoose={() => patch({ connection: 'network' })}
            >
              Cable de red
            </Option>
          </Group>
          <span className="text-sm text-muted">
            Por USB, próximamente (con el programa de instalación para Windows). Por ahora, conecta
            la impresora con su cable de red al router.
          </span>
        </div>

        {b.connection === 'network' ? (
          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1">
              <span className="font-semibold">Dirección de red (IP)</span>
              <input
                className={`${fieldClass} figures`}
                value={b.address}
                inputMode="decimal"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="192.168.1.50"
                onChange={(e) => patch({ address: e.target.value })}
              />
            </label>
            <label className="flex w-28 flex-col gap-1">
              <span className="font-semibold">Puerto</span>
              <input
                className={`${fieldClass} figures`}
                value={b.port ?? ''}
                inputMode="numeric"
                onChange={(e) => {
                  const n = Number(e.target.value.replace(/\D/g, ''))
                  patch({ port: n > 0 ? Math.min(n, 65535) : null })
                }}
              />
            </label>
          </div>
        ) : (
          <label className="flex flex-col gap-1">
            <span className="font-semibold">Nombre de la impresora en Windows</span>
            <input
              className={fieldClass}
              value={b.address}
              onChange={(e) => patch({ address: e.target.value })}
            />
          </label>
        )}
        <p className="-mt-3 text-sm text-muted">
          La IP sale al imprimir la hoja de configuración: con la impresora apagada, mantén
          presionado el botón de avance de papel y préndela.
        </p>

        <div className="flex flex-col gap-2">
          <span className="font-semibold">Ancho del papel</span>
          <Group label="Ancho del papel" className="flex flex-wrap gap-2">
            {([80, 58] as const).map((a) => (
              <Option key={a} selected={b.width === a} onChoose={() => patch({ width: a })}>
                {`${a} mm`}
              </Option>
            ))}
          </Group>
        </div>

        <div className="flex flex-col gap-2">
          <span className="font-semibold">Tildes y eñes</span>
          <Group label="Tabla de caracteres" className="flex flex-col gap-2">
            {CODE_PAGE_OPTIONS.map((p) => (
              <Option
                key={p.value}
                shape="card"
                detail={p.detail}
                selected={b.code_page === p.value}
                onChoose={() => patch({ code_page: p.value })}
              >
                {p.name}
              </Option>
            ))}
          </Group>
          <span className="text-sm text-muted">
            Guarda y toca «Imprimir prueba»: si la ñ y las tildes salen bien, queda así.
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <span className="font-semibold">Si no responde, imprimir en</span>
          <Group label="Impresora de respaldo" className="flex flex-wrap gap-2">
            <Option selected={b.fallback_id === null} onChoose={() => patch({ fallback_id: null })}>
              Ninguna
            </Option>
            {others.map((i) => (
              <Option
                key={i.id}
                selected={b.fallback_id === i.id}
                onChoose={() => patch({ fallback_id: i.id })}
              >
                {i.name}
              </Option>
            ))}
          </Group>
          <span className="text-sm text-muted">
            Tras 3 intentos fallidos, sus comandas salen por la de respaldo y todos ven la alerta.
          </span>
        </div>
      </div>
    </SidePanel>
  )
}

function Screens({ config, onChange }: { config: KitchenConfig; onChange: () => void }) {
  const notify = useNotify()
  const { device } = useFloor()
  const [name, setName] = useState('Pantalla cocina')
  const [stations, setStations] = useState<string[]>([])
  const [confirming, setConfirming] = useState(false)
  const [taken, setTaken] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const changeStations = async (deviceId: string, ids: string[]) => {
    if (ids.length === 0) return notify('Una pantalla muestra al menos una estación')
    try {
      await floor.screenStations(deviceId, ids)
      onChange()
    } catch (e) {
      notify(message(e))
    }
  }
  const convert = async () => {
    setTaken(true)
    try {
      await floor.convertToScreen(name.trim(), stations)
      navigate('/')
    } catch (e) {
      setError(message(e))
      setTaken(false)
      setConfirming(false)
    }
  }

  return (
    <section aria-labelledby="title-screens" className="flex flex-col gap-3">
      <h2 id="title-screens" className="text-xl font-bold tracking-tight">
        Pantallas de cocina
      </h2>
      <p className="text-muted">
        Opcionales. Una tablet (o un televisor táctil) en la cocina o la barra muestra las comandas
        y el cocinero toca «Listo». Un televisor sin pantalla táctil solo sirve para mirar.
      </p>
      {config.screens.length > 0 && (
        <ul className="flex flex-col gap-3">
          {config.screens.map((p) => (
            <li
              key={p.device_id}
              className="flex flex-col gap-2 rounded-2xl border border-divider bg-surface p-4"
            >
              <span className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-lg font-semibold">{p.name}</span>
                <span className="text-sm text-muted">
                  {p.last_used
                    ? `Última señal: ${new Intl.DateTimeFormat('es-CO', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(p.last_used))}`
                    : 'Sin señal todavía'}
                </span>
              </span>
              <span className="text-sm font-semibold">Qué estaciones muestra</span>
              <Stations
                config={config}
                selectedIds={p.station_ids}
                onChange={(ids) => changeStations(p.device_id, ids)}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-3 rounded-2xl border border-divider bg-surface-2/60 p-4">
        <span className="text-lg font-semibold">Usar este equipo como pantalla de cocina</span>
        <p className="text-sm text-muted">
          Hazlo desde la tablet de la cocina: entra con tu usuario en ella, ven aquí y conviértela.
          Ese equipo ya no servirá para tomar pedidos ni para la caja. Para deshacerlo, desde la
          caja ve a Personal y roles, Equipos, y toca «Retirar» en la pantalla; luego en la tablet
          toca «Entrar de nuevo».
          {device?.type === 'waiter' && ' Este es un celular de mesero.'}
        </p>
        <label className="flex flex-col gap-1">
          <span className="font-semibold">Nombre de la pantalla</span>
          <input
            className={fieldClass}
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <span className="font-semibold">Qué estaciones muestra</span>
        <Stations config={config} selectedIds={stations} onChange={setStations} />
        {stations.length === 0 && (
          <span className="text-sm text-muted">Elige al menos una estación.</span>
        )}
        {error && (
          <p role="alert" className="text-alert-text">
            {error}
          </p>
        )}
        {confirming ? (
          <Confirm
            question="Este equipo quedará siempre en la pantalla de cocina, sin pedir PIN, y tu sesión se cierra aquí. Para deshacerlo: desde la caja, Personal y roles, Equipos, «Retirar». ¿Seguimos?"
            yes="Convertir"
            taken={taken}
            onConfirm={convert}
            onCancel={() => setConfirming(false)}
          />
        ) : (
          <Button
            variant="main"
            icon="check"
            disabled={stations.length === 0 || !name.trim()}
            onClick={() => {
              setError(null)
              setConfirming(true)
            }}
          >
            Convertir este equipo
          </Button>
        )}
      </div>
    </section>
  )
}

function Timers({ config, onChange }: { config: KitchenConfig; onChange: () => void }) {
  const notify = useNotify()
  const [yellow, setYellow] = useState(String(config.timers.yellow))
  const [red, setRed] = useState(String(config.timers.red))
  const a = Number(yellow)
  const r = Number(red)
  const valid = Number.isInteger(a) && Number.isInteger(r) && a >= 1 && r > a && r <= 240
  const change = a !== config.timers.yellow || r !== config.timers.red
  const save = async () => {
    try {
      await floor.kitchenTimers(a, r)
      notify('Guardaste los tiempos de cocina')
      onChange()
    } catch (e) {
      notify(message(e))
    }
  }
  return (
    <section aria-labelledby="title-times" className="flex flex-col gap-3">
      <h2 id="title-times" className="text-xl font-bold tracking-tight">
        Cuándo se ve demorado
      </h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex w-36 flex-col gap-1">
          <span className="font-semibold">Demorada desde</span>
          <span className="flex items-center gap-2">
            <input
              className={`${fieldClass} figures`}
              inputMode="numeric"
              value={yellow}
              onChange={(e) => setYellow(e.target.value.replace(/\D/g, ''))}
            />
            min
          </span>
        </label>
        <label className="flex w-36 flex-col gap-1">
          <span className="font-semibold">Muy demorada desde</span>
          <span className="flex items-center gap-2">
            <input
              className={`${fieldClass} figures`}
              inputMode="numeric"
              value={red}
              onChange={(e) => setRed(e.target.value.replace(/\D/g, ''))}
            />
            min
          </span>
        </label>
        <Button variant="main" disabled={!valid || !change} onClick={save}>
          Guardar
        </Button>
      </div>
      {!valid && (
        <p className="text-sm text-alert-text">
          Escribe minutos enteros: «muy demorada» debe llegar después de «demorada», hasta 240.
        </p>
      )}
    </section>
  )
}

/**
 * Courses (starter, main, dessert; hold and fire): hardly used in Colombia and off by default.
 * Turning them on shows «Curso» during order entry.
 */
function Courses({ config, onChange }: { config: KitchenConfig; onChange: () => void }) {
  const notify = useNotify()
  const active = config.courses_enabled ?? false
  const patch = async () => {
    try {
      await floor.coursesEnabled(!active)
      notify(active ? 'Apagaste los cursos' : 'Prendiste los cursos')
      onChange()
    } catch (e) {
      notify(message(e))
    }
  }
  return (
    <section aria-labelledby="title-courses" className="flex flex-col gap-3">
      <h2 id="title-courses" className="text-xl font-bold tracking-tight">
        Cursos
      </h2>
      <p className="text-muted">
        Entrada, fuerte y postre por separado, con «Retener» y «Marchar» para que el fuerte salga
        cuando lo pidan. Si no los usan, déjalos apagados: el pedido se toma más rápido.
      </p>
      <button
        type="button"
        role="switch"
        aria-checked={active}
        onClick={patch}
        className="inline-flex min-h-12 w-max items-center gap-3 rounded-xl border border-border bg-surface px-4 font-semibold focus-visible:outline-3 focus-visible:outline-focus"
      >
        <span
          aria-hidden="true"
          className={`relative h-7 w-12 rounded-full transition-colors ${active ? 'bg-action-strong' : 'bg-border'}`}
        >
          <span
            className={`absolute top-1 size-5 rounded-full bg-white transition-all ${active ? 'left-6' : 'left-1'}`}
          />
        </span>
        {`Usar cursos: ${active ? 'sí' : 'no'}`}
      </button>
    </section>
  )
}
