import { useCallback, useEffect, useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { Etiqueta } from '../ui/Etiqueta'
import { Icono } from '../ui/iconos'
import { Grupo, Opcion } from '../ui/Opciones'
import { PanelLateral } from '../ui/PanelLateral'
import { navegar } from '../ui/ruta'
import { sala, useSala } from './contexto'
import { claseCampo } from './Entrar'
import { MarcoSala } from './MarcoSala'
import type { ConfiguracionCocina, ImpresoraCocina } from './motor'
import { Confirmar } from './Personal'

// «Cocina e impresoras» (ADR-015): cómo recibe cada estación sus comandas (impresora, pantalla o
// las dos), las impresoras con su página de prueba, las pantallas de cocina, convertir este equipo
// en una y los minutos del ámbar y el rojo. Para quien administra los equipos.

const PAGINAS: { value: ImpresoraCocina['code_page']; name: string; detalle: string }[] = [
  {
    value: 'pc850',
    name: 'Con tildes (recomendada)',
    detalle: 'La de casi todas: Jaltech, Epson, Xprinter',
  },
  {
    value: 'wpc1252',
    name: 'Con tildes de Windows',
    detalle: 'Si con la recomendada salen símbolos raros',
  },
  { value: 'no_accents', name: 'Sin tildes', detalle: 'Si ninguna imprime bien la ñ' },
]

const NUEVA: ImpresoraCocina = {
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

export function CocinaAjustes() {
  const avisar = useAvisar()
  const { printers: statuses } = useSala()
  const [config, setConfig] = useState<ConfiguracionCocina | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editando, setEditando] = useState<ImpresoraCocina | null>(null)

  const cargar = useCallback(() => {
    sala
      .kitchenConfig()
      .then((c) => {
        setConfig(c)
        setError(null)
      })
      .catch((e) => setError(message(e)))
  }, [])
  useEffect(cargar, [cargar])

  if (error && !config)
    return (
      <MarcoSala titulo="Cocina e impresoras">
        <div className="mx-auto flex max-w-3xl flex-col items-start gap-3 p-6">
          <p className="text-alerta-texto">{error}</p>
          <Boton onClick={cargar}>Intentar de nuevo</Boton>
        </div>
      </MarcoSala>
    )
  if (!config)
    return (
      <MarcoSala titulo="Cocina e impresoras">
        <p className="p-6 text-texto-suave">Leyendo la configuración de la caja…</p>
      </MarcoSala>
    )

  const stateOf = (id: string) =>
    statuses.find((e) => e.id === id) ?? config.statuses.find((e) => e.id === id)
  const activas = config.printers.filter((i) => i.active)
  const nombreEstacion = (id: string) =>
    config.stations.find((e) => e.id === id)?.name ?? 'Estación'

  const probar = async (id: string, name: string) => {
    try {
      await sala.testPrinter(id)
      avisar(`Prueba enviada a ${name}: revisa que salga el papel`)
    } catch (e) {
      avisar(message(e))
    }
  }

  return (
    <MarcoSala
      titulo="Cocina e impresoras"
      actions={
        <Boton variant="main" icono="more" onClick={() => setEditando({ ...NUEVA })}>
          Agregar impresora
        </Boton>
      }
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-8 p-4 md:p-6">
        <section aria-labelledby="title-stations" className="flex flex-col gap-3">
          <h2 id="title-stations" className="text-xl font-bold tracking-tight">
            Cómo recibe cada estación
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {config.stations.map((e) => {
              const imp = activas.filter((i) => i.station_ids.includes(e.id))
              const pan = config.pantallas.filter((p) => p.station_ids.includes(e.id))
              const nothing = imp.length === 0 && pan.length === 0
              return (
                <li
                  key={e.id}
                  className="flex flex-col gap-2 rounded-2xl border border-linea bg-superficie p-4"
                >
                  <span className="text-lg font-semibold">{e.name}</span>
                  {imp.map((i) => (
                    <span key={i.id} className="flex items-center gap-2">
                      <Icono name="printer" className="size-5" />
                      {i.name}
                    </span>
                  ))}
                  {pan.map((p) => (
                    <span key={p.device_id} className="flex items-center gap-2">
                      <Icono name="floorPlan" className="size-5" />
                      {p.name}
                    </span>
                  ))}
                  {nothing && (
                    <Etiqueta tono="progress" icono="warning">
                      No le llega nada: ponle una impresora o una pantalla
                    </Etiqueta>
                  )}
                </li>
              )
            })}
          </ul>
          <p className="text-sm text-texto-suave">
            Sin pantalla, el mesero marca «Entregado» al llevar el plato y la caja ve lo pendiente
            en «Pedidos en cocina».
          </p>
        </section>

        <section aria-labelledby="title-printers" className="flex flex-col gap-3">
          <h2 id="title-printers" className="text-xl font-bold tracking-tight">
            Impresoras de comandas
          </h2>
          {config.printers.length === 0 && (
            <div className="rounded-2xl border border-dashed border-borde p-6 text-center">
              <p className="text-texto-suave">
                Todavía no hay impresoras. Agrega la de cocina y la de barra con su dirección de
                red.
              </p>
              <Boton
                variant="main"
                icono="more"
                className="mt-3"
                onClick={() => setEditando({ ...NUEVA })}
              >
                Agregar impresora
              </Boton>
            </div>
          )}
          <ul className="flex flex-col gap-3">
            {config.printers.map((i) => {
              const status = stateOf(i.id)
              return (
                <li
                  key={i.id}
                  className={`flex flex-wrap items-center gap-3 rounded-2xl border border-linea bg-superficie p-4 ${i.active ? '' : 'opacity-60'}`}
                >
                  <Icono name="printer" className="size-6" />
                  <div className="flex min-w-48 flex-1 flex-col items-start gap-1">
                    <span className="text-lg font-semibold">{i.name}</span>
                    <span className="cifras text-sm text-texto-suave">
                      {i.connection === 'network'
                        ? `${i.address}:${i.port ?? 9100} · ${i.width} mm`
                        : `USB · ${i.width} mm`}
                      {i.station_ids.length > 0 &&
                        ` · ${i.station_ids.map(nombreEstacion).join(', ')}`}
                    </span>
                    {!i.active ? (
                      <Etiqueta tono="neutral" icono="close">
                        Archivada
                      </Etiqueta>
                    ) : status?.status === 'failed' ? (
                      <span className="text-sm font-semibold text-alerta-texto">
                        <Icono name="warning" className="mr-1 inline size-4" />
                        {status.error}
                        {status.pendingList > 0 && ` (${status.pendingList} esperando)`}
                      </span>
                    ) : (
                      <Etiqueta tono="free" icono="check">
                        {status?.pendingList ? `Imprimiendo (${status.pendingList})` : 'Lista'}
                      </Etiqueta>
                    )}
                  </div>
                  {i.active && (
                    <Boton icono="printer" onClick={() => probar(i.id, i.name)}>
                      Imprimir prueba
                    </Boton>
                  )}
                  <Boton variant="ghost" icono="pencil" onClick={() => setEditando({ ...i })}>
                    Editar
                  </Boton>
                </li>
              )
            })}
          </ul>
        </section>

        <Pantallas config={config} onChange={cargar} />
        <Tiempos config={config} onChange={cargar} />
        <Cursos config={config} onChange={cargar} />
      </div>

      {editando && (
        <EditarImpresora
          initial={editando}
          config={config}
          alCerrar={() => setEditando(null)}
          onSave={() => {
            setEditando(null)
            cargar()
          }}
        />
      )}
    </MarcoSala>
  )
}

function Estaciones({
  config,
  elegidas,
  onChange,
}: {
  config: ConfiguracionCocina
  elegidas: string[]
  onChange: (ids: string[]) => void
}) {
  return (
    <Grupo etiqueta="Estaciones" className="flex flex-wrap gap-2">
      {config.stations.map((e) => (
        <Opcion
          key={e.id}
          elegida={elegidas.includes(e.id)}
          alElegir={() =>
            onChange(
              elegidas.includes(e.id) ? elegidas.filter((x) => x !== e.id) : [...elegidas, e.id],
            )
          }
        >
          {e.name}
        </Opcion>
      ))}
    </Grupo>
  )
}

function EditarImpresora({
  initial,
  config,
  alCerrar,
  onSave,
}: {
  initial: ImpresoraCocina
  config: ConfiguracionCocina
  alCerrar: () => void
  onSave: () => void
}) {
  const avisar = useAvisar()
  const [b, setB] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const [archivando, setArchivando] = useState(false)
  const patch = (partial: Partial<ImpresoraCocina>) => setB((x) => ({ ...x, ...partial }))
  const otras = config.printers.filter((i) => i.active && i.id !== b.id)

  const guardar = async (changes: Partial<ImpresoraCocina> = {}) => {
    const data = { ...b, ...changes }
    if (!data.name.trim()) return setError('Ponle un nombre, por ejemplo «Cocina»')
    if (data.connection === 'network' && !data.address.trim())
      return setError('Escribe la IP de la impresora (sale en su hoja de configuración)')
    setOcupado(true)
    try {
      await sala.savePrinter({
        ...data,
        name: data.name.trim(),
        address: data.address.trim(),
      })
      avisar(data.active ? `Guardaste ${data.name.trim()}` : `Archivaste ${data.name.trim()}`)
      onSave()
    } catch (e) {
      setError(message(e))
      setOcupado(false)
    }
  }

  return (
    <PanelLateral
      opened
      titulo={initial.id ? `Editar ${initial.name}` : 'Impresora nueva'}
      alCerrar={alCerrar}
      pie={
        <div className="flex flex-col gap-2">
          {error && (
            <p role="alert" className="text-alerta-texto">
              {error}
            </p>
          )}
          {archivando ? (
            <Confirmar
              pregunta={
                b.fallback_id
                  ? `¿Archivar ${b.name}? Lo que esté esperando sale por la de respaldo. No se borra: se puede volver a usar.`
                  : `¿Archivar ${b.name}? No tiene respaldo: lo que esté esperando no saldrá y la caja lo verá en «Pedidos en cocina» para descartarlo o reimprimirlo. No se borra: se puede volver a usar.`
              }
              yes="Archivar"
              ocupado={ocupado}
              alConfirmar={() => guardar({ active: false })}
              alCancelar={() => setArchivando(false)}
            />
          ) : (
            <div className="flex gap-2">
              <Boton
                variant="main"
                large
                className="flex-1"
                disabled={ocupado}
                onClick={() => guardar()}
              >
                Guardar
              </Boton>
              {initial.id && initial.active && (
                <Boton variant="ghost" onClick={() => setArchivando(true)}>
                  Archivar
                </Boton>
              )}
              {initial.id && !initial.active && (
                <Boton disabled={ocupado} onClick={() => guardar({ active: true })}>
                  Volver a usar
                </Boton>
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
            className={claseCampo}
            value={b.name}
            maxLength={60}
            placeholder="Cocina"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </label>

        <div className="flex flex-col gap-2">
          <span className="font-semibold">Qué imprime</span>
          <Estaciones
            config={config}
            elegidas={b.station_ids}
            onChange={(ids) => patch({ station_ids: ids })}
          />
          {b.station_ids.length === 0 && (
            <span className="text-sm text-texto-suave">
              Sin cocina ni barra: solo imprime cuando otra impresora no responde.
            </span>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <span className="font-semibold">Conexión</span>
          <Grupo etiqueta="Conexión" className="flex flex-wrap gap-2">
            <Opcion
              elegida={b.connection === 'network'}
              alElegir={() => patch({ connection: 'network' })}
            >
              Cable de red
            </Opcion>
          </Grupo>
          <span className="text-sm text-texto-suave">
            Por USB, próximamente (con el programa de instalación para Windows). Por ahora, conecta
            la impresora con su cable de red al router.
          </span>
        </div>

        {b.connection === 'network' ? (
          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1">
              <span className="font-semibold">Dirección de red (IP)</span>
              <input
                className={`${claseCampo} cifras`}
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
                className={`${claseCampo} cifras`}
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
              className={claseCampo}
              value={b.address}
              onChange={(e) => patch({ address: e.target.value })}
            />
          </label>
        )}
        <p className="-mt-3 text-sm text-texto-suave">
          La IP sale al imprimir la hoja de configuración: con la impresora apagada, mantén
          presionado el botón de avance de papel y préndela.
        </p>

        <div className="flex flex-col gap-2">
          <span className="font-semibold">Ancho del papel</span>
          <Grupo etiqueta="Ancho del papel" className="flex flex-wrap gap-2">
            {([80, 58] as const).map((a) => (
              <Opcion key={a} elegida={b.width === a} alElegir={() => patch({ width: a })}>
                {`${a} mm`}
              </Opcion>
            ))}
          </Grupo>
        </div>

        <div className="flex flex-col gap-2">
          <span className="font-semibold">Tildes y eñes</span>
          <Grupo etiqueta="Tabla de caracteres" className="flex flex-col gap-2">
            {PAGINAS.map((p) => (
              <Opcion
                key={p.value}
                shape="card"
                detalle={p.detalle}
                elegida={b.code_page === p.value}
                alElegir={() => patch({ code_page: p.value })}
              >
                {p.name}
              </Opcion>
            ))}
          </Grupo>
          <span className="text-sm text-texto-suave">
            Guarda y toca «Imprimir prueba»: si la ñ y las tildes salen bien, queda así.
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <span className="font-semibold">Si no responde, imprimir en</span>
          <Grupo etiqueta="Impresora de respaldo" className="flex flex-wrap gap-2">
            <Opcion elegida={b.fallback_id === null} alElegir={() => patch({ fallback_id: null })}>
              Ninguna
            </Opcion>
            {otras.map((i) => (
              <Opcion
                key={i.id}
                elegida={b.fallback_id === i.id}
                alElegir={() => patch({ fallback_id: i.id })}
              >
                {i.name}
              </Opcion>
            ))}
          </Grupo>
          <span className="text-sm text-texto-suave">
            Tras 3 intentos fallidos, sus comandas salen por la de respaldo y todos ven la alerta.
          </span>
        </div>
      </div>
    </PanelLateral>
  )
}

function Pantallas({ config, onChange }: { config: ConfiguracionCocina; onChange: () => void }) {
  const avisar = useAvisar()
  const { device } = useSala()
  const [name, setNombre] = useState('Pantalla cocina')
  const [stations, setEstaciones] = useState<string[]>([])
  const [confirmando, setConfirmando] = useState(false)
  const [ocupado, setOcupado] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cambiarEstaciones = async (dispositivoId: string, ids: string[]) => {
    if (ids.length === 0) return avisar('Una pantalla muestra al menos una estación')
    try {
      await sala.screenStations(dispositivoId, ids)
      onChange()
    } catch (e) {
      avisar(message(e))
    }
  }
  const convertir = async () => {
    setOcupado(true)
    try {
      await sala.convertirEnPantalla(name.trim(), stations)
      navegar('/')
    } catch (e) {
      setError(message(e))
      setOcupado(false)
      setConfirmando(false)
    }
  }

  return (
    <section aria-labelledby="title-screens" className="flex flex-col gap-3">
      <h2 id="title-screens" className="text-xl font-bold tracking-tight">
        Pantallas de cocina
      </h2>
      <p className="text-texto-suave">
        Opcionales. Una tablet (o un televisor táctil) en la cocina o la barra muestra las comandas
        y el cocinero toca «Listo». Un televisor sin pantalla táctil solo sirve para mirar.
      </p>
      {config.pantallas.length > 0 && (
        <ul className="flex flex-col gap-3">
          {config.pantallas.map((p) => (
            <li
              key={p.device_id}
              className="flex flex-col gap-2 rounded-2xl border border-linea bg-superficie p-4"
            >
              <span className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-lg font-semibold">{p.name}</span>
                <span className="text-sm text-texto-suave">
                  {p.last_used
                    ? `Última señal: ${new Intl.DateTimeFormat('es-CO', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(p.last_used))}`
                    : 'Sin señal todavía'}
                </span>
              </span>
              <span className="text-sm font-semibold">Qué estaciones muestra</span>
              <Estaciones
                config={config}
                elegidas={p.station_ids}
                onChange={(ids) => cambiarEstaciones(p.device_id, ids)}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-3 rounded-2xl border border-linea bg-superficie-2/60 p-4">
        <span className="text-lg font-semibold">Usar este equipo como pantalla de cocina</span>
        <p className="text-sm text-texto-suave">
          Hazlo desde la tablet de la cocina: entra con tu usuario en ella, ven aquí y conviértela.
          Ese equipo ya no servirá para tomar pedidos ni para la caja. Para deshacerlo, desde la
          caja ve a Personal y roles, Equipos, y toca «Retirar» en la pantalla; luego en la tablet
          toca «Entrar de nuevo».
          {device?.type === 'waiter' && ' Este es un celular de mesero.'}
        </p>
        <label className="flex flex-col gap-1">
          <span className="font-semibold">Nombre de la pantalla</span>
          <input
            className={claseCampo}
            value={name}
            maxLength={60}
            onChange={(e) => setNombre(e.target.value)}
          />
        </label>
        <span className="font-semibold">Qué estaciones muestra</span>
        <Estaciones config={config} elegidas={stations} onChange={setEstaciones} />
        {stations.length === 0 && (
          <span className="text-sm text-texto-suave">Elige al menos una estación.</span>
        )}
        {error && (
          <p role="alert" className="text-alerta-texto">
            {error}
          </p>
        )}
        {confirmando ? (
          <Confirmar
            pregunta="Este equipo quedará siempre en la pantalla de cocina, sin pedir PIN, y tu sesión se cierra aquí. Para deshacerlo: desde la caja, Personal y roles, Equipos, «Retirar». ¿Seguimos?"
            yes="Convertir"
            ocupado={ocupado}
            alConfirmar={convertir}
            alCancelar={() => setConfirmando(false)}
          />
        ) : (
          <Boton
            variant="main"
            icono="check"
            disabled={stations.length === 0 || !name.trim()}
            onClick={() => {
              setError(null)
              setConfirmando(true)
            }}
          >
            Convertir este equipo
          </Boton>
        )}
      </div>
    </section>
  )
}

function Tiempos({ config, onChange }: { config: ConfiguracionCocina; onChange: () => void }) {
  const avisar = useAvisar()
  const [amarillo, setAmarillo] = useState(String(config.tiempos.amarillo))
  const [rojo, setRojo] = useState(String(config.tiempos.rojo))
  const a = Number(amarillo)
  const r = Number(rojo)
  const valid = Number.isInteger(a) && Number.isInteger(r) && a >= 1 && r > a && r <= 240
  const change = a !== config.tiempos.amarillo || r !== config.tiempos.rojo
  const guardar = async () => {
    try {
      await sala.kitchenTimers(a, r)
      avisar('Guardaste los tiempos de cocina')
      onChange()
    } catch (e) {
      avisar(message(e))
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
              className={`${claseCampo} cifras`}
              inputMode="numeric"
              value={amarillo}
              onChange={(e) => setAmarillo(e.target.value.replace(/\D/g, ''))}
            />
            min
          </span>
        </label>
        <label className="flex w-36 flex-col gap-1">
          <span className="font-semibold">Muy demorada desde</span>
          <span className="flex items-center gap-2">
            <input
              className={`${claseCampo} cifras`}
              inputMode="numeric"
              value={rojo}
              onChange={(e) => setRojo(e.target.value.replace(/\D/g, ''))}
            />
            min
          </span>
        </label>
        <Boton variant="main" disabled={!valid || !change} onClick={guardar}>
          Guardar
        </Boton>
      </div>
      {!valid && (
        <p className="text-sm text-alerta-texto">
          Escribe minutos enteros: «muy demorada» debe llegar después de «demorada», hasta 240.
        </p>
      )}
    </section>
  )
}

/**
 * Cursos (entrada, fuerte, postre; retener y marchar): casi no se usan en Colombia y vienen
 * apagados. Prenderlos muestra «Curso» al tomar el pedido.
 */
function Cursos({ config, onChange }: { config: ConfiguracionCocina; onChange: () => void }) {
  const avisar = useAvisar()
  const active = config.courses_enabled ?? false
  const patch = async () => {
    try {
      await sala.usarCursos(!active)
      avisar(active ? 'Apagaste los cursos' : 'Prendiste los cursos')
      onChange()
    } catch (e) {
      avisar(message(e))
    }
  }
  return (
    <section aria-labelledby="title-courses" className="flex flex-col gap-3">
      <h2 id="title-courses" className="text-xl font-bold tracking-tight">
        Cursos
      </h2>
      <p className="text-texto-suave">
        Entrada, fuerte y postre por separado, con «Retener» y «Marchar» para que el fuerte salga
        cuando lo pidan. Si no los usan, déjalos apagados: el pedido se toma más rápido.
      </p>
      <button
        type="button"
        role="switch"
        aria-checked={active}
        onClick={patch}
        className="inline-flex min-h-12 w-max items-center gap-3 rounded-xl border border-borde bg-superficie px-4 font-semibold focus-visible:outline-3 focus-visible:outline-foco"
      >
        <span
          aria-hidden="true"
          className={`relative h-7 w-12 rounded-full transition-colors ${active ? 'bg-accion-fuerte' : 'bg-borde'}`}
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
