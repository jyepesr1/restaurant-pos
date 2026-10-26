import type { Catalogo } from '@pos/sync'
import { useEffect, useRef, useState } from 'react'
import { useAhora } from '../ui/ahora'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { TONOS_FUERTES, TONOS_SUAVES } from '../ui/Etiqueta'
import { minutos } from '../ui/formato'
import { IndicadorConexion } from '../ui/IndicadorConexion'
import { Icono, type NombreIcono } from '../ui/iconos'
import { Grupo, Opcion } from '../ui/Opciones'
import { useTema } from '../ui/tema'
import { type ComandaEnCocina, type Demora, demora, tiemposDe } from './comandas'
import { sala, useSala, useVistaLocal } from './contexto'
import { MarcoSala } from './MarcoSala'
import type { TrabajoPendiente } from './motor'
import { Confirmar } from './Personal'
import { CANALES } from './pedido'

// Lo que está en cocina (ADR-015). En la caja es «Pedidos en cocina»: lo enviado que falta
// entregar, por estación, con su tiempo y su color; quien puede marcar toca «Listo» si cocina
// avisa. En una pantalla de cocina es todo lo que hay: tarjetas grandes y un solo toque, «Listo».

/**
 * Cómo se ve cada demora. «A tiempo» va sin color, solo con borde (decisión del dueño): el verde
 * en cocina queda para «Listo para llevar», y lo que resalta es lo demorado.
 */
const DEMORAS: Record<
  Demora,
  { icono: NombreIcono; text: string; card: string; clock: string; etiqueta: string }
> = {
  on_time: {
    icono: 'clock',
    text: 'A tiempo',
    card: 'border-borde bg-superficie text-texto',
    clock: 'border-2 border-borde bg-superficie text-texto',
    etiqueta: 'border-2 border-borde bg-superficie text-texto',
  },
  late: {
    icono: 'clock',
    text: 'Demorada',
    card: `border-proceso-fuerte/60 ${TONOS_SUAVES.progress}`,
    clock: TONOS_FUERTES.progress,
    etiqueta: TONOS_SUAVES.progress,
  },
  very_late: {
    icono: 'warning',
    text: 'Muy demorada',
    card: `border-alerta-fuerte ${TONOS_SUAVES.warning}`,
    clock: TONOS_FUERTES.warning,
    etiqueta: TONOS_SUAVES.warning,
  },
}

const TODAS = '__all'

function target(catalog: Catalogo, c: ComandaEnCocina): string {
  const p = c.order.status
  if (p.tableId) {
    const table = catalog.tables.find((m) => m.id === p.tableId)
    return table ? `Mesa ${table.name}` : 'Mesa'
  }
  const channel = CANALES[p.channel as keyof typeof CANALES] ?? 'Pedido'
  return p.dayNumber ? `${channel} #${p.dayNumber}` : channel
}

/** «Pedidos en cocina», dentro del marco de la caja. */
export function PedidosEnCocina() {
  return (
    <MarcoSala titulo="Pedidos en cocina">
      <div className="mx-auto flex max-w-7xl flex-col gap-5 p-4 md:p-6">
        <AvisoImpresoras />
        <Tablero mode="register" />
      </div>
    </MarcoSala>
  )
}

/** La pantalla de cocina: sin marco, para una tablet o un televisor táctil en la cocina o la barra. */
export function PantallaCocina() {
  const { device, catalog, connection, pendingList, printers } = useSala()
  const { dark, select } = useTema()
  const ahora = useAhora(15_000)
  const propia = (catalog?.pantallas ?? []).find((p) => p.dispositivoId === device?.dispositivoId)
  useEffect(() => {
    document.title = `${device?.name ?? 'Pantalla de cocina'} · Faro`
  }, [device?.name])
  usePantallaEncendida()
  return (
    <div className="flex min-h-dvh flex-col bg-fondo text-texto">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-linea bg-lateral px-4 py-3">
        <h1 className="text-2xl font-bold tracking-tight">
          {device?.name ?? 'Pantalla de cocina'}
        </h1>
        <span className="cifras text-2xl font-semibold text-texto-suave">
          {new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit' }).format(ahora)}
        </span>
        <span className="flex-1" />
        <IndicadorConexion
          status={
            connection === 'connected'
              ? 'local_only'
              : connection === 'connecting'
                ? 'connecting'
                : 'offline'
          }
          pendingList={pendingList}
          impresorasConFalla={printers.filter((i) => i.status === 'failed').length}
        />
        <ConSonido />
        <Boton
          variant="ghost"
          icono={dark ? 'sun' : 'moon'}
          aria-label={dark ? 'Modo claro' : 'Modo oscuro'}
          onClick={() => select(dark ? 'light' : 'dark')}
        />
      </header>
      <main className="flex flex-1 flex-col gap-4 p-4">
        {connection !== 'connected' && (
          <p className="rounded-2xl bg-alerta-suave p-4 text-xl font-semibold text-alerta-texto">
            Sin conexión con la caja: los pedidos nuevos no llegan hasta que vuelva. Revisa el
            Wi-Fi.
          </p>
        )}
        <AvisoImpresoras large />
        {propia ? (
          <Tablero mode="screen" stations={propia.estacionIds} />
        ) : (
          // Sin saber sus estaciones no se muestra nada: la de barra no debe ver lo de cocina.
          <p className="text-xl text-texto-suave">Leyendo qué estaciones muestra esta pantalla…</p>
        )}
      </main>
    </div>
  )
}

/** Que la tablet no se apague ni se bloquee mientras muestra las comandas. */
function usePantallaEncendida() {
  useEffect(() => {
    let candado: { release: () => Promise<void> } | null = null
    const request = () => {
      if (document.hidden) return
      const wl = (
        navigator as unknown as {
          wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> }
        }
      ).wakeLock
      wl?.request('screen')
        .then((c) => {
          candado = c
        })
        .catch(() => {})
    }
    request()
    document.addEventListener('visibilitychange', request)
    return () => {
      document.removeEventListener('visibilitychange', request)
      void candado?.release().catch(() => {})
    }
  }, [])
}

const CLAVE_SONIDO = 'pos-kitchen-sound'

function leerSonido() {
  try {
    return localStorage.getItem(CLAVE_SONIDO) !== 'no'
  } catch {
    return true
  }
}

let audio: AudioContext | null = null

/**
 * El contexto de sonido. Las tablets lo dejan callado hasta que alguien toca la pantalla: se
 * crea y se reanuda con cada toque, y la pantalla avisa mientras siga callado.
 */
function contextoSonido(): AudioContext | null {
  try {
    const Contexto =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Contexto) return null
    audio ??= new Contexto()
    if (audio.state === 'suspended') void audio.resume().catch(() => {})
    return audio
  } catch {
    return null
  }
}

/** Un «ding» al llegar una comanda (brief §4.4): un tono corto, sin archivos de sonido. */
function sonar() {
  const ctx = contextoSonido()
  if (!ctx) return
  try {
    const tono = ctx.createOscillator()
    const volumen = ctx.createGain()
    tono.frequency.value = 880
    volumen.gain.setValueAtTime(0.3, ctx.currentTime)
    volumen.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6)
    tono.connect(volumen).connect(ctx.destination)
    tono.start()
    tono.stop(ctx.currentTime + 0.6)
  } catch {
    // Sin sonido no pasa nada: la tarjeta igual aparece.
  }
}

let sonidoActivo = leerSonido()

function ConSonido() {
  const [active, setActivo] = useState(sonidoActivo)
  const [callado, setCallado] = useState(false)
  // El primer toque en cualquier parte despierta el sonido.
  useEffect(() => {
    const despertar = () => {
      const ctx = contextoSonido()
      setCallado(ctx?.state === 'suspended')
    }
    const revisar = setInterval(() => setCallado(audio?.state !== 'running'), 5000)
    window.addEventListener('pointerdown', despertar)
    return () => {
      clearInterval(revisar)
      window.removeEventListener('pointerdown', despertar)
    }
  }, [])
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      onClick={() => {
        sonidoActivo = !active
        setActivo(sonidoActivo)
        try {
          localStorage.setItem(CLAVE_SONIDO, sonidoActivo ? 'yes' : 'no')
        } catch {
          // Se recuerda solo mientras la pantalla esté abierta.
        }
        if (sonidoActivo) sonar()
      }}
      className={`inline-flex min-h-12 items-center gap-2 rounded-xl border px-4 font-semibold focus-visible:outline-3 focus-visible:outline-foco ${active && callado ? 'border-proceso-fuerte bg-proceso-suave text-proceso-texto' : 'border-borde bg-superficie'}`}
    >
      <Icono name={active ? 'check' : 'close'} />
      {!active ? 'Sonido: no' : callado ? 'Toca para activar el sonido' : 'Sonido: sí'}
    </button>
  )
}

/** Las comandas, en tarjetas; en la pantalla de cocina, solo las de sus estaciones. */
function Tablero({
  mode,
  stations = null,
}: {
  mode: 'register' | 'screen'
  stations?: string[] | null
}) {
  const { catalog, session, device } = useSala()
  const vista = useVistaLocal()
  const avisar = useAvisar()
  const ahora = sala.ahoraHub(useAhora(15_000))
  const [filtro, setFiltro] = useState(TODAS)
  const seenItems = useRef<Set<string> | null>(null)
  const tickets = (vista?.tickets ?? []).filter(
    (c) =>
      (stations === null || stations.includes(c.estacionId)) &&
      (filtro === TODAS || c.estacionId === filtro),
  )

  // En la pantalla suena una vez por cada comanda que llega (no al abrirla con lo que ya había).
  useEffect(() => {
    if (mode !== 'screen' || !vista) return
    const ids = new Set(tickets.map((c) => c.key))
    if (seenItems.current && sonidoActivo && [...ids].some((id) => !seenItems.current?.has(id)))
      sonar()
    seenItems.current = ids
  })

  if (!catalog || !vista) return <p className="text-texto-suave">Leyendo lo de cocina…</p>
  const tiempos = tiemposDe(catalog.restaurant)
  // «Listo» lo marca la cocina (su pantalla) o la caja cuando cocina avisa; en el celular del
  // mesero esta vista es solo para mirar, y lo suyo es «Entregar» en el pedido.
  const puedeMarcar =
    (session?.permissions.includes('mark_preparation') ?? false) &&
    (mode === 'screen' || device?.type === 'register')
  const puedeReimprimir =
    mode === 'register' && (session?.permissions.includes('take_order') ?? false)
  const deLaVista =
    stations === null ? catalog.stations : catalog.stations.filter((e) => stations.includes(e.id))
  const enCurso = tickets.filter((c) => !c.list)
  const listas = tickets.filter((c) => c.list)

  const marcarListo = async (c: ComandaEnCocina) => {
    const ids = c.items.filter((i) => i.status !== 'ready').map((i) => i.id)
    try {
      await sala.record('ItemReady', c.order.status.id, { item_ids: ids })
      avisar(
        `${target(catalog, c)}: listo`,
        () =>
          void sala
            .record('ItemReturnedToQueue', c.order.status.id, { item_ids: ids })
            .catch(() => {}),
      )
    } catch (e) {
      avisar(e instanceof Error ? e.message : 'No se pudo marcar')
    }
  }
  const recuperar = async (c: ComandaEnCocina) => {
    try {
      await sala.record('ItemReturnedToQueue', c.order.status.id, {
        item_ids: c.items.map((i) => i.id),
      })
      avisar(`${target(catalog, c)} volvió a la cola`)
    } catch (e) {
      avisar(e instanceof Error ? e.message : 'No se pudo recuperar')
    }
  }
  const reimprimir = async (c: ComandaEnCocina) => {
    try {
      await sala.record('TicketReprinted', c.order.status.id, { ticket_id: c.comandaId })
      avisar(`Reimprimiendo ${target(catalog, c)}`)
    } catch (e) {
      avisar(e instanceof Error ? e.message : 'No se pudo reimprimir')
    }
  }

  const sinRecepcion = deLaVista.filter((e) => e.imprime === false && e.screen === false)
  const tally = (d: Demora) =>
    enCurso.filter((c) => demora(c.enviadaEn, ahora, tiempos) === d).length

  return (
    <div className="flex flex-col gap-4">
      {deLaVista.length > 1 && (
        <Grupo etiqueta="Estación" className="flex flex-wrap gap-2">
          <Opcion elegida={filtro === TODAS} alElegir={() => setFiltro(TODAS)}>
            Todas
          </Opcion>
          {deLaVista.map((e) => (
            <Opcion key={e.id} elegida={filtro === e.id} alElegir={() => setFiltro(e.id)}>
              {e.name}
            </Opcion>
          ))}
        </Grupo>
      )}

      {mode === 'register' && sinRecepcion.length > 0 && (
        <p className="rounded-2xl bg-proceso-suave p-4 text-proceso-texto">
          {`${sinRecepcion.map((e) => e.name).join(' y ')} no ${sinRecepcion.length === 1 ? 'tiene' : 'tienen'} impresora ni pantalla: lo que se envía allá no le llega a nadie. Configúralo en «Cocina e impresoras».`}
        </p>
      )}

      <ul
        className={`flex flex-wrap gap-x-5 gap-y-2 ${mode === 'screen' ? 'text-lg' : 'text-sm'}`}
        aria-label="Cómo va de tiempo"
      >
        {(Object.keys(DEMORAS) as Demora[]).map((d) => (
          <li key={d} className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-semibold ${DEMORAS[d].etiqueta}`}
            >
              <Icono name={DEMORAS[d].icono} className="size-4" />
              {DEMORAS[d].text}
            </span>
            <span className="cifras text-texto-suave">{tally(d)}</span>
          </li>
        ))}
        <li className="text-texto-suave">
          {`Demorada desde ${tiempos.amarillo} min, muy demorada desde ${tiempos.rojo} min`}
        </li>
      </ul>

      {enCurso.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-borde p-8 text-center text-lg text-texto-suave">
          {mode === 'screen'
            ? 'Nada por preparar. Lo nuevo aparece aquí con un sonido.'
            : 'Nada en cocina por ahora.'}
        </p>
      ) : (
        <ul
          className={`grid gap-4 ${mode === 'screen' ? 'grid-cols-[repeat(auto-fill,minmax(18rem,1fr))]' : 'grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]'}`}
        >
          {enCurso.map((c) => (
            <li key={c.key}>
              <Tarjeta
                catalog={catalog}
                ticket={c}
                ahora={ahora}
                tiempos={tiempos}
                large={mode === 'screen'}
                actions={
                  <>
                    {puedeMarcar && (
                      <Boton
                        variant="success"
                        large={mode === 'screen'}
                        icono="check"
                        className="flex-1"
                        onClick={() => marcarListo(c)}
                      >
                        Listo
                      </Boton>
                    )}
                    {puedeReimprimir &&
                      catalog.stations.find((e) => e.id === c.estacionId)?.imprime && (
                        <Boton
                          variant="ghost"
                          icono="printer"
                          aria-label={`Reimprimir ${target(catalog, c)}`}
                          onClick={() => reimprimir(c)}
                        >
                          Reimprimir
                        </Boton>
                      )}
                  </>
                }
              />
            </li>
          ))}
        </ul>
      )}

      {listas.length > 0 && (
        <section aria-labelledby="title-ready" className="flex flex-col gap-3">
          <h2 id="title-ready" className="text-lg font-semibold">
            {`Listo para llevar (${listas.length})`}
          </h2>
          <ul className="flex flex-wrap gap-3">
            {listas.map((c) => (
              <li
                key={c.key}
                className={`flex min-h-14 items-center gap-3 rounded-2xl py-2 pr-2 pl-4 ${TONOS_SUAVES.free}`}
              >
                <Icono name="serve" />
                <span className="font-semibold">{target(catalog, c)}</span>
                <span className="text-sm">
                  {c.items.reduce((s, i) => s + i.quantity - i.voidedQuantity, 0)} prod.
                </span>
                {puedeMarcar && (
                  <Boton
                    variant="ghost"
                    large={mode === 'screen'}
                    icono="undo"
                    onClick={() => recuperar(c)}
                  >
                    Volver a cocina
                  </Boton>
                )}
              </li>
            ))}
          </ul>
          <p className="text-sm text-texto-suave">
            Salen de aquí cuando el mesero toca «Entregar».
          </p>
        </section>
      )}
    </div>
  )
}

function Tarjeta({
  catalog,
  ticket: c,
  ahora,
  tiempos,
  large,
  actions,
}: {
  catalog: Catalogo
  ticket: ComandaEnCocina
  ahora: number
  tiempos: { amarillo: number; rojo: number }
  large: boolean
  actions: React.ReactNode
}) {
  const d = DEMORAS[demora(c.enviadaEn, ahora, tiempos)]
  const station = catalog.stations.find((e) => e.id === c.estacionId)?.name
  const waiter = catalog.staff.find((u) => u.id === c.order.status.assignedWaiterId)?.name
  const from = Math.max(0, (ahora - Date.parse(c.enviadaEn)) / 60_000)
  return (
    <article
      aria-label={`${target(catalog, c)}, ${d.text}, ${minutos(from)}`}
      className={`flex h-full flex-col gap-3 rounded-2xl border-2 p-4 ${d.card}`}
    >
      <header className="flex items-baseline justify-between gap-2">
        <span className={`font-bold ${large ? 'text-3xl' : 'text-xl'}`}>{target(catalog, c)}</span>
        {c.numero !== null && (
          <span className={`cifras font-bold ${large ? 'text-3xl' : 'text-lg'}`}>#{c.numero}</span>
        )}
      </header>
      <div className={`flex flex-wrap items-center gap-2 ${large ? 'text-lg' : 'text-sm'}`}>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full font-bold ${d.clock} ${large ? 'px-3 py-1 text-2xl' : 'px-2.5 py-0.5 text-sm'}`}
        >
          <Icono name={d.icono} className={large ? 'size-6' : 'size-4'} />
          <span className="cifras">{minutos(from)}</span>
        </span>
        <span>{[station, waiter].filter(Boolean).join(' · ')}</span>
      </div>
      {c.order.status.notes && (
        <p
          className={`flex items-start gap-2 rounded-lg border-2 border-borde bg-superficie px-2 py-1 text-texto ${large ? 'text-xl' : ''}`}
        >
          <Icono
            name="pencil"
            className={large ? 'mt-0.5 size-6 shrink-0' : 'mt-0.5 size-4 shrink-0'}
          />
          <span>
            <span className="block text-sm font-semibold uppercase">Para todo el pedido</span>
            <span className="font-bold">{c.order.status.notes}</span>
          </span>
        </p>
      )}
      <ul className="flex flex-1 flex-col gap-3">
        {c.items.map((i) => (
          <li key={i.id} className={large ? 'text-2xl' : ''}>
            <span className="cifras font-bold">{i.quantity - i.voidedQuantity} ×</span>{' '}
            <span className="font-semibold">{i.name}</span>
            {i.guest !== null && (
              <span className={large ? 'text-xl' : 'text-sm'}> · P{i.guest}</span>
            )}
            {i.status === 'ready' && (
              <span className={`font-semibold ${large ? 'text-xl' : 'text-sm'}`}> · listo</span>
            )}
            {i.modifiers.length > 0 && (
              <span className={`block font-bold ${large ? 'text-xl' : ''}`}>
                {i.modifiers.map((m) => `> ${m.name}`).join('  ')}
              </span>
            )}
            {i.notes && (
              <span
                className={`mt-1 flex items-start gap-2 rounded-lg border-2 border-current bg-superficie px-2 py-1 font-bold ${large ? 'text-xl' : ''}`}
              >
                <Icono
                  name="warning"
                  className={large ? 'mt-0.5 size-6 shrink-0' : 'mt-0.5 size-4 shrink-0'}
                />
                {i.notes}
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">{actions}</div>
    </article>
  )
}

/**
 * Si alguna impresora no responde: cuál, por qué, y lo que no ha salido (descartar, para quien
 * maneja la caja). En la pantalla de cocina, en letra grande y sin descartar.
 */
function AvisoImpresoras({ large = false }: { large?: boolean }) {
  const { printers, session } = useSala()
  const avisar = useAvisar()
  const caidas = printers.filter((i) => i.status === 'failed')
  const puedeVer =
    session?.permissions.some((p) => p === 'manage_devices' || p === 'record_payment') ?? false
  const [trabajos, setTrabajos] = useState<TrabajoPendiente[] | null>(null)
  const [descartando, setDescartando] = useState<string | null>(null)
  const key = caidas.map((i) => `${i.id}:${i.pendingList}`).join(',')

  // biome-ignore lint/correctness/useExhaustiveDependencies: `clave` avisa que cambió la cola
  useEffect(() => {
    if (!puedeVer || caidas.length === 0) {
      setTrabajos(null)
      return
    }
    sala
      .pendingPrints()
      .then(setTrabajos)
      .catch(() => setTrabajos(null))
  }, [key, puedeVer])

  if (caidas.length === 0) return null
  const descartar = async (t: TrabajoPendiente) => {
    setDescartando(null)
    try {
      await sala.discardJob(t.id)
      setTrabajos((ts) => ts?.filter((x) => x.id !== t.id) ?? null)
      avisar('Comanda descartada')
    } catch (e) {
      avisar(e instanceof Error ? e.message : 'No se pudo descartar')
    }
  }
  return (
    <section
      role="alert"
      className={`flex flex-col gap-3 rounded-2xl border-2 border-alerta-fuerte bg-alerta-suave p-4 text-alerta-texto ${large ? 'text-xl' : ''}`}
    >
      {caidas.map((i) => (
        <p key={i.id} className="flex items-start gap-2">
          <Icono name="printer" className="mt-0.5 size-5 shrink-0" />
          <span>
            <span className="font-bold">{`${i.name} no imprime. `}</span>
            {i.error}
            {i.pendingList > 0 &&
              ` Hay ${i.pendingList} ${i.pendingList === 1 ? 'comanda esperando' : 'comandas esperando'}: salen solas cuando vuelva.`}
          </span>
        </p>
      ))}
      {trabajos && trabajos.length > 0 && (
        <ul className="flex flex-col gap-2">
          {trabajos.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center gap-2 rounded-xl bg-superficie p-2 pl-3 text-texto"
            >
              <span className="flex-1">
                <span className="font-semibold">{t.que}</span>
                <span className="text-sm text-texto-suave">{` · ${t.printer} · ${t.attempts} ${t.attempts === 1 ? 'intento' : 'intentos'}`}</span>
              </span>
              {descartando === t.id ? (
                <div className="w-full">
                  <Confirmar
                    pregunta={`¿Descartar «${t.que}»? No se imprimirá: si la cocina no la tiene, díselo.`}
                    yes="Descartar"
                    ocupado={false}
                    alConfirmar={() => descartar(t)}
                    alCancelar={() => setDescartando(null)}
                  />
                </div>
              ) : (
                <Boton variant="ghost" icono="erase" onClick={() => setDescartando(t.id)}>
                  Descartar
                </Boton>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Avisa al mesero cuando algo de sus mesas queda listo para llevar (ADR-015): un aviso y una
 * vibración, una vez por comanda. No avisa lo que ya estaba listo al abrir la app.
 */
export function AvisoListos() {
  const { catalog, session } = useSala()
  const vista = useVistaLocal()
  const avisar = useAvisar()
  const conocidas = useRef<{ user: string; ids: Set<string> } | null>(null)
  useEffect(() => {
    if (!vista || !catalog || !session) return
    // Otro mesero entró en este celular: lo que ya estaba listo no es una novedad para él.
    if (conocidas.current?.user !== session.user.id) conocidas.current = null
    const mias = vista.tickets.filter(
      (c) => c.list && c.order.status.assignedWaiterId === session.user.id,
    )
    const ids = new Set(mias.map((c) => c.key))
    if (conocidas.current) {
      const newOnes = mias.filter((c) => !conocidas.current?.ids.has(c.key))
      for (const c of newOnes) avisar(`${target(catalog, c)}: listo para llevar`)
      if (newOnes.length > 0) navigator.vibrate?.([80, 60, 80])
    }
    conocidas.current = { user: session.user.id, ids }
  }, [vista, catalog, session, avisar])
  return null
}
