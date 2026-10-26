import type { Catalog } from '@pos/sync'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { ConnectionIndicator } from '../ui/ConnectionIndicator'
import { minutes } from '../ui/format'
import { Icon, type IconName } from '../ui/icons'
import { SOFT_TONES, STRONG_TONES } from '../ui/Label'
import { useNow } from '../ui/now'
import { Group, Option } from '../ui/Options'
import { useTheme } from '../ui/theme'
import { useNotify } from '../ui/toasts'
import { floor, useFloor, useLocalView } from './context'
import type { PendingJob } from './engine'
import { FloorFrame } from './FloorFrame'
import { CHANNELS } from './order'
import { Confirm } from './Staff'
import { type Delay, delay, type KitchenTicket, timersOf } from './tickets'

// What is in the kitchen (ADR-015). At the register it is «Pedidos en cocina»: what was sent and
// not yet delivered, by station, with its time and color; whoever can mark it taps «Listo» when
// the kitchen calls out. On a kitchen screen it is all there is: big cards and one tap, «Listo».

/**
 * How each delay looks. «A tiempo» has no color, only a border (owner's decision): green in
 * the kitchen is reserved for «Listo para llevar», and what stands out is what is late.
 */
const DELAYS: Record<
  Delay,
  { icon: IconName; text: string; card: string; clock: string; label: string }
> = {
  on_time: {
    icon: 'clock',
    text: 'A tiempo',
    card: 'border-borde bg-superficie text-texto',
    clock: 'border-2 border-borde bg-superficie text-texto',
    label: 'border-2 border-borde bg-superficie text-texto',
  },
  late: {
    icon: 'clock',
    text: 'Demorada',
    card: `border-proceso-fuerte/60 ${SOFT_TONES.progress}`,
    clock: STRONG_TONES.progress,
    label: SOFT_TONES.progress,
  },
  very_late: {
    icon: 'warning',
    text: 'Muy demorada',
    card: `border-alerta-fuerte ${SOFT_TONES.warning}`,
    clock: STRONG_TONES.warning,
    label: SOFT_TONES.warning,
  },
}

const ALL = '__all'

function target(catalog: Catalog, c: KitchenTicket): string {
  const p = c.order.status
  if (p.tableId) {
    const table = catalog.tables.find((m) => m.id === p.tableId)
    return table ? `Mesa ${table.name}` : 'Mesa'
  }
  const channel = CHANNELS[p.channel as keyof typeof CHANNELS] ?? 'Pedido'
  return p.dayNumber ? `${channel} #${p.dayNumber}` : channel
}

/** «Pedidos en cocina», inside the register frame. */
export function OrdersInKitchen() {
  return (
    <FloorFrame title="Pedidos en cocina">
      <div className="mx-auto flex max-w-7xl flex-col gap-5 p-4 md:p-6">
        <PrinterAlert />
        <Dashboard mode="register" />
      </div>
    </FloorFrame>
  )
}

/** The kitchen screen: no frame, for a tablet or a touch TV in the kitchen or at the bar. */
export function KitchenScreen() {
  const { device, catalog, connection, pendingList, printers } = useFloor()
  const { dark, select } = useTheme()
  const now = useNow(15_000)
  const ownItem = (catalog?.screens ?? []).find((p) => p.deviceId === device?.deviceId)
  useEffect(() => {
    document.title = `${device?.name ?? 'Pantalla de cocina'} · Faro`
  }, [device?.name])
  useScreenOn()
  return (
    <div className="flex min-h-dvh flex-col bg-fondo text-texto">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-linea bg-lateral px-4 py-3">
        <h1 className="text-2xl font-bold tracking-tight">
          {device?.name ?? 'Pantalla de cocina'}
        </h1>
        <span className="cifras text-2xl font-semibold text-texto-suave">
          {new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit' }).format(now)}
        </span>
        <span className="flex-1" />
        <ConnectionIndicator
          status={
            connection === 'connected'
              ? 'local_only'
              : connection === 'connecting'
                ? 'connecting'
                : 'offline'
          }
          pendingList={pendingList}
          failingPrinters={printers.filter((i) => i.status === 'failed').length}
        />
        <WithSound />
        <Button
          variant="ghost"
          icon={dark ? 'sun' : 'moon'}
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
        <PrinterAlert large />
        {ownItem ? (
          <Dashboard mode="screen" stations={ownItem.stationIds} />
        ) : (
          // Without knowing its stations nothing is shown: the bar must not see kitchen items.
          <p className="text-xl text-texto-suave">Leyendo qué estaciones muestra esta pantalla…</p>
        )}
      </main>
    </div>
  )
}

/** Keeps the tablet from turning off or locking while it shows the tickets. */
function useScreenOn() {
  useEffect(() => {
    let wakeLock: { release: () => Promise<void> } | null = null
    const request = () => {
      if (document.hidden) return
      const wl = (
        navigator as unknown as {
          wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> }
        }
      ).wakeLock
      wl?.request('screen')
        .then((c) => {
          wakeLock = c
        })
        .catch(() => {})
    }
    request()
    document.addEventListener('visibilitychange', request)
    return () => {
      document.removeEventListener('visibilitychange', request)
      void wakeLock?.release().catch(() => {})
    }
  }, [])
}

const SOUND_KEY = 'pos-kitchen-sound'

function readSound() {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'no'
  } catch {
    return true
  }
}

let audio: AudioContext | null = null

/**
 * The sound context. Tablets keep it muted until someone touches the screen: it is
 * created and resumed on every touch, and the screen warns while it stays muted.
 */
function soundContext(): AudioContext | null {
  try {
    const ToastContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!ToastContext) return null
    audio ??= new ToastContext()
    if (audio.state === 'suspended') void audio.resume().catch(() => {})
    return audio
  } catch {
    return null
  }
}

/** A «ding» when a ticket arrives (brief §4.4): a short tone, no sound files. */
function playSound() {
  const ctx = soundContext()
  if (!ctx) return
  try {
    const tone = ctx.createOscillator()
    const volume = ctx.createGain()
    tone.frequency.value = 880
    volume.gain.setValueAtTime(0.3, ctx.currentTime)
    volume.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6)
    tone.connect(volume).connect(ctx.destination)
    tone.start()
    tone.stop(ctx.currentTime + 0.6)
  } catch {
    // Without sound nothing happens: the card still shows up.
  }
}

let soundActive = readSound()

function WithSound() {
  const [active, setActive] = useState(soundActive)
  const [muted, setMuted] = useState(false)
  // The first touch anywhere wakes up the sound.
  useEffect(() => {
    const wake = () => {
      const ctx = soundContext()
      setMuted(ctx?.state === 'suspended')
    }
    const review = setInterval(() => setMuted(audio?.state !== 'running'), 5000)
    window.addEventListener('pointerdown', wake)
    return () => {
      clearInterval(review)
      window.removeEventListener('pointerdown', wake)
    }
  }, [])
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      onClick={() => {
        soundActive = !active
        setActive(soundActive)
        try {
          localStorage.setItem(SOUND_KEY, soundActive ? 'yes' : 'no')
        } catch {
          // It is remembered only while the screen stays open.
        }
        if (soundActive) playSound()
      }}
      className={`inline-flex min-h-12 items-center gap-2 rounded-xl border px-4 font-semibold focus-visible:outline-3 focus-visible:outline-foco ${active && muted ? 'border-proceso-fuerte bg-proceso-suave text-proceso-texto' : 'border-borde bg-superficie'}`}
    >
      <Icon name={active ? 'check' : 'close'} />
      {!active ? 'Sonido: no' : muted ? 'Toca para activar el sonido' : 'Sonido: sí'}
    </button>
  )
}

/** The tickets, in cards; on the kitchen screen, only those of its stations. */
function Dashboard({
  mode,
  stations = null,
}: {
  mode: 'register' | 'screen'
  stations?: string[] | null
}) {
  const { catalog, session, device } = useFloor()
  const view = useLocalView()
  const notify = useNotify()
  const now = floor.hubNow(useNow(15_000))
  const [filter, setFilter] = useState(ALL)
  const seenItems = useRef<Set<string> | null>(null)
  const tickets = (view?.tickets ?? []).filter(
    (c) =>
      (stations === null || stations.includes(c.stationId)) &&
      (filter === ALL || c.stationId === filter),
  )

  // On the screen it rings once per incoming ticket (not on opening it with what was there).
  useEffect(() => {
    if (mode !== 'screen' || !view) return
    const ids = new Set(tickets.map((c) => c.key))
    if (seenItems.current && soundActive && [...ids].some((id) => !seenItems.current?.has(id)))
      playSound()
    seenItems.current = ids
  })

  if (!catalog || !view) return <p className="text-texto-suave">Leyendo lo de cocina…</p>
  const timers = timersOf(catalog.restaurant)
  // «Listo» is marked by the kitchen (its screen) or by the register when the kitchen calls out; on
  // the waiter's phone this view is read-only, and their action is «Entregar» in the order.
  const canMark =
    (session?.permissions.includes('mark_preparation') ?? false) &&
    (mode === 'screen' || device?.type === 'register')
  const canReprint = mode === 'register' && (session?.permissions.includes('take_order') ?? false)
  const inView =
    stations === null ? catalog.stations : catalog.stations.filter((e) => stations.includes(e.id))
  const inProgress = tickets.filter((c) => !c.list)
  const readyTickets = tickets.filter((c) => c.list)

  const markReady = async (c: KitchenTicket) => {
    const ids = c.items.filter((i) => i.status !== 'ready').map((i) => i.id)
    try {
      await floor.record('ItemReady', c.order.status.id, { item_ids: ids })
      notify(
        `${target(catalog, c)}: listo`,
        () =>
          void floor
            .record('ItemReturnedToQueue', c.order.status.id, { item_ids: ids })
            .catch(() => {}),
      )
    } catch (e) {
      notify(e instanceof Error ? e.message : 'No se pudo marcar')
    }
  }
  const recover = async (c: KitchenTicket) => {
    try {
      await floor.record('ItemReturnedToQueue', c.order.status.id, {
        item_ids: c.items.map((i) => i.id),
      })
      notify(`${target(catalog, c)} volvió a la cola`)
    } catch (e) {
      notify(e instanceof Error ? e.message : 'No se pudo recuperar')
    }
  }
  const reprint = async (c: KitchenTicket) => {
    try {
      await floor.record('TicketReprinted', c.order.status.id, { ticket_id: c.ticketId })
      notify(`Reimprimiendo ${target(catalog, c)}`)
    } catch (e) {
      notify(e instanceof Error ? e.message : 'No se pudo reimprimir')
    }
  }

  const withoutReceipt = inView.filter((e) => e.prints === false && e.screen === false)
  const tally = (d: Delay) => inProgress.filter((c) => delay(c.sentAt, now, timers) === d).length

  return (
    <div className="flex flex-col gap-4">
      {inView.length > 1 && (
        <Group label="Estación" className="flex flex-wrap gap-2">
          <Option selected={filter === ALL} onChoose={() => setFilter(ALL)}>
            Todas
          </Option>
          {inView.map((e) => (
            <Option key={e.id} selected={filter === e.id} onChoose={() => setFilter(e.id)}>
              {e.name}
            </Option>
          ))}
        </Group>
      )}

      {mode === 'register' && withoutReceipt.length > 0 && (
        <p className="rounded-2xl bg-proceso-suave p-4 text-proceso-texto">
          {`${withoutReceipt.map((e) => e.name).join(' y ')} no ${withoutReceipt.length === 1 ? 'tiene' : 'tienen'} impresora ni pantalla: lo que se envía allá no le llega a nadie. Configúralo en «Cocina e impresoras».`}
        </p>
      )}

      <ul
        className={`flex flex-wrap gap-x-5 gap-y-2 ${mode === 'screen' ? 'text-lg' : 'text-sm'}`}
        aria-label="Cómo va de tiempo"
      >
        {(Object.keys(DELAYS) as Delay[]).map((d) => (
          <li key={d} className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-semibold ${DELAYS[d].label}`}
            >
              <Icon name={DELAYS[d].icon} className="size-4" />
              {DELAYS[d].text}
            </span>
            <span className="cifras text-texto-suave">{tally(d)}</span>
          </li>
        ))}
        <li className="text-texto-suave">
          {`Demorada desde ${timers.yellow} min, muy demorada desde ${timers.red} min`}
        </li>
      </ul>

      {inProgress.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-borde p-8 text-center text-lg text-texto-suave">
          {mode === 'screen'
            ? 'Nada por preparar. Lo nuevo aparece aquí con un sonido.'
            : 'Nada en cocina por ahora.'}
        </p>
      ) : (
        <ul
          className={`grid gap-4 ${mode === 'screen' ? 'grid-cols-[repeat(auto-fill,minmax(18rem,1fr))]' : 'grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]'}`}
        >
          {inProgress.map((c) => (
            <li key={c.key}>
              <Card
                catalog={catalog}
                ticket={c}
                now={now}
                timers={timers}
                large={mode === 'screen'}
                actions={
                  <>
                    {canMark && (
                      <Button
                        variant="success"
                        large={mode === 'screen'}
                        icon="check"
                        className="flex-1"
                        onClick={() => markReady(c)}
                      >
                        Listo
                      </Button>
                    )}
                    {canReprint && catalog.stations.find((e) => e.id === c.stationId)?.prints && (
                      <Button
                        variant="ghost"
                        icon="printer"
                        aria-label={`Reimprimir ${target(catalog, c)}`}
                        onClick={() => reprint(c)}
                      >
                        Reimprimir
                      </Button>
                    )}
                  </>
                }
              />
            </li>
          ))}
        </ul>
      )}

      {readyTickets.length > 0 && (
        <section aria-labelledby="title-ready" className="flex flex-col gap-3">
          <h2 id="title-ready" className="text-lg font-semibold">
            {`Listo para llevar (${readyTickets.length})`}
          </h2>
          <ul className="flex flex-wrap gap-3">
            {readyTickets.map((c) => (
              <li
                key={c.key}
                className={`flex min-h-14 items-center gap-3 rounded-2xl py-2 pr-2 pl-4 ${SOFT_TONES.free}`}
              >
                <Icon name="serve" />
                <span className="font-semibold">{target(catalog, c)}</span>
                <span className="text-sm">
                  {c.items.reduce((s, i) => s + i.quantity - i.voidedQuantity, 0)} prod.
                </span>
                {canMark && (
                  <Button
                    variant="ghost"
                    large={mode === 'screen'}
                    icon="undo"
                    onClick={() => recover(c)}
                  >
                    Volver a cocina
                  </Button>
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

function Card({
  catalog,
  ticket: c,
  now,
  timers,
  large,
  actions,
}: {
  catalog: Catalog
  ticket: KitchenTicket
  now: number
  timers: { yellow: number; red: number }
  large: boolean
  actions: React.ReactNode
}) {
  const d = DELAYS[delay(c.sentAt, now, timers)]
  const station = catalog.stations.find((e) => e.id === c.stationId)?.name
  const waiter = catalog.staff.find((u) => u.id === c.order.status.assignedWaiterId)?.name
  const from = Math.max(0, (now - Date.parse(c.sentAt)) / 60_000)
  return (
    <article
      aria-label={`${target(catalog, c)}, ${d.text}, ${minutes(from)}`}
      className={`flex h-full flex-col gap-3 rounded-2xl border-2 p-4 ${d.card}`}
    >
      <header className="flex items-baseline justify-between gap-2">
        <span className={`font-bold ${large ? 'text-3xl' : 'text-xl'}`}>{target(catalog, c)}</span>
        {c.number !== null && (
          <span className={`cifras font-bold ${large ? 'text-3xl' : 'text-lg'}`}>#{c.number}</span>
        )}
      </header>
      <div className={`flex flex-wrap items-center gap-2 ${large ? 'text-lg' : 'text-sm'}`}>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full font-bold ${d.clock} ${large ? 'px-3 py-1 text-2xl' : 'px-2.5 py-0.5 text-sm'}`}
        >
          <Icon name={d.icon} className={large ? 'size-6' : 'size-4'} />
          <span className="cifras">{minutes(from)}</span>
        </span>
        <span>{[station, waiter].filter(Boolean).join(' · ')}</span>
      </div>
      {c.order.status.notes && (
        <p
          className={`flex items-start gap-2 rounded-lg border-2 border-borde bg-superficie px-2 py-1 text-texto ${large ? 'text-xl' : ''}`}
        >
          <Icon
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
                <Icon
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
 * If a printer is not responding: which one, why, and what has not printed (discard, for whoever
 * runs the register). On the kitchen screen, in large type and without discard.
 */
function PrinterAlert({ large = false }: { large?: boolean }) {
  const { printers, session } = useFloor()
  const notify = useNotify()
  const downPrinters = printers.filter((i) => i.status === 'failed')
  const canView =
    session?.permissions.some((p) => p === 'manage_devices' || p === 'record_payment') ?? false
  const [jobs, setJobs] = useState<PendingJob[] | null>(null)
  const [discarding, setDiscarding] = useState<string | null>(null)
  const key = downPrinters.map((i) => `${i.id}:${i.pendingList}`).join(',')

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` signals that the queue changed
  useEffect(() => {
    if (!canView || downPrinters.length === 0) {
      setJobs(null)
      return
    }
    floor
      .pendingPrints()
      .then(setJobs)
      .catch(() => setJobs(null))
  }, [key, canView])

  if (downPrinters.length === 0) return null
  const discard = async (t: PendingJob) => {
    setDiscarding(null)
    try {
      await floor.discardJob(t.id)
      setJobs((ts) => ts?.filter((x) => x.id !== t.id) ?? null)
      notify('Comanda descartada')
    } catch (e) {
      notify(e instanceof Error ? e.message : 'No se pudo descartar')
    }
  }
  return (
    <section
      role="alert"
      className={`flex flex-col gap-3 rounded-2xl border-2 border-alerta-fuerte bg-alerta-suave p-4 text-alerta-texto ${large ? 'text-xl' : ''}`}
    >
      {downPrinters.map((i) => (
        <p key={i.id} className="flex items-start gap-2">
          <Icon name="printer" className="mt-0.5 size-5 shrink-0" />
          <span>
            <span className="font-bold">{`${i.name} no imprime. `}</span>
            {i.error}
            {i.pendingList > 0 &&
              ` Hay ${i.pendingList} ${i.pendingList === 1 ? 'comanda esperando' : 'comandas esperando'}: salen solas cuando vuelva.`}
          </span>
        </p>
      ))}
      {jobs && jobs.length > 0 && (
        <ul className="flex flex-col gap-2">
          {jobs.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center gap-2 rounded-xl bg-superficie p-2 pl-3 text-texto"
            >
              <span className="flex-1">
                <span className="font-semibold">{t.what}</span>
                <span className="text-sm text-texto-suave">{` · ${t.printer} · ${t.attempts} ${t.attempts === 1 ? 'intento' : 'intentos'}`}</span>
              </span>
              {discarding === t.id ? (
                <div className="w-full">
                  <Confirm
                    question={`¿Descartar «${t.what}»? No se imprimirá: si la cocina no la tiene, díselo.`}
                    yes="Descartar"
                    taken={false}
                    onConfirm={() => discard(t)}
                    onCancel={() => setDiscarding(null)}
                  />
                </div>
              ) : (
                <Button variant="ghost" icon="erase" onClick={() => setDiscarding(t.id)}>
                  Descartar
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Notifies the waiter when something from their tables is ready to take out (ADR-015): a notice
 * and a vibration, once per ticket. It does not notify what was already ready when the app opened.
 */
export function ReadyAlert() {
  const { catalog, session } = useFloor()
  const view = useLocalView()
  const notify = useNotify()
  const knownIds = useRef<{ user: string; ids: Set<string> } | null>(null)
  useEffect(() => {
    if (!view || !catalog || !session) return
    // Another waiter signed in on this phone: what was already ready is not news to them.
    if (knownIds.current?.user !== session.user.id) knownIds.current = null
    const mine = view.tickets.filter(
      (c) => c.list && c.order.status.assignedWaiterId === session.user.id,
    )
    const ids = new Set(mine.map((c) => c.key))
    if (knownIds.current) {
      const newOnes = mine.filter((c) => !knownIds.current?.ids.has(c.key))
      for (const c of newOnes) notify(`${target(catalog, c)}: listo para llevar`)
      if (newOnes.length > 0) navigator.vibrate?.([80, 60, 80])
    }
    knownIds.current = { user: session.user.id, ids }
  }, [view, catalog, session, notify])
  return null
}
