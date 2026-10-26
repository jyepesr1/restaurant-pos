import type { Catalog } from '@pos/sync'
import { useMemo, useState } from 'react'
import { minutes, pesos } from '../ui/format'
import { Icon, type IconName } from '../ui/icons'
import { Label, SOFT_TONES, type Tone } from '../ui/Label'
import { useNow } from '../ui/now'
import { Group, Option } from '../ui/Options'
import { navigate } from '../ui/route'
import { useFloor, useOrders } from './context'
import { FloorFrame } from './FloorFrame'
import { Canvas, ElementShape, placement, Seats, useScale } from './FloorPlanCanvas'
import { bounds } from './floor-plan'
import { CHANNELS } from './order'
import { currentItems, type DemoTableStatus, tableStatus, type VisibleOrder } from './projection'

// Floor plan (brief §5, rule 1): the waiter's home screen. Each zone or floor with its
// tables in their real place with their seats, and on each occupied table the status, the time,
// the total and who is serving it. On the phone, or if preferred, the same information as a
// list. Beside it (at the register) or above (on the phone), the open orders in cards colored
// by their status, and the buttons for orders without a table. A tap on the table or the card
// goes to its order.

const STATUSES: Record<DemoTableStatus, { tone: Tone; icon: IconName; text: string }> = {
  free: { tone: 'free', icon: 'circle', text: 'Libre' },
  taking: { tone: 'progress', icon: 'pencil', text: 'Tomando pedido' },
  ready: { tone: 'free', icon: 'serve', text: 'Listo para llevar' },
  check: { tone: 'action', icon: 'receipt', text: 'Pidió la cuenta' },
  in_kitchen: { tone: 'progress', icon: 'fire', text: 'En preparación' },
  served: { tone: 'neutral', icon: 'check', text: 'Servida' },
}

/** Table border and seat color, by the tone of its status (full classes). */
const BORDER: Record<Tone, string> = {
  free: 'border-libre-fuerte/45',
  progress: 'border-proceso-fuerte/45',
  warning: 'border-alerta-fuerte/45',
  action: 'border-accion-fuerte/45',
  neutral: 'border-neutro-fuerte/45',
}
const SEAT: Record<Tone, string> = {
  free: 'bg-libre-fuerte/55',
  progress: 'bg-proceso-fuerte/70',
  warning: 'bg-alerta-fuerte/70',
  action: 'bg-accion-fuerte/60',
  neutral: 'bg-neutro-fuerte/55',
}
/** The halo and the strip that join on the plan the tables of the same order (task 1.5). */
const UNION: Record<Tone, string> = {
  free: 'text-libre-fuerte',
  progress: 'text-proceso-fuerte',
  warning: 'text-alerta-fuerte',
  action: 'text-accion-fuerte',
  neutral: 'text-neutro-fuerte',
}
const DOT: Record<Tone, string> = {
  free: 'bg-libre-fuerte',
  progress: 'bg-proceso-fuerte',
  warning: 'bg-alerta-fuerte',
  action: 'bg-accion-fuerte',
  neutral: 'bg-neutro-fuerte',
}

type Table = Catalog['tables'][number]
type View = 'floorPlan' | 'list'
const VIEW_KEY = 'pos-tables-view'
const ZONE_KEY = 'pos-tables-zone'

/** What this device remembers; if storage is not available, it goes on without it. */
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {}
}
const remembered = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** What is said about a table: status, time since it was opened, total and who is serving it. */
interface Summary {
  status: DemoTableStatus
  orders: VisibleOrder[]
  total: number
  minutes: number | null
  waiter: string | null
  pendingConfirmation: boolean
  /** On the main table of a group of merged tables (task 1.5), the other ones: «5, 6». */
  mergedWith: string | null
  /** On a table merged into another, the main one: the group's time and total show there. */
  mergedIntoTable: string | null
}

function summarize(orders: VisibleOrder[], staff: Catalog['staff'], now: number): Summary {
  const firstOne = orders[0]
  return {
    status: tableStatus(orders),
    orders,
    total: orders.reduce((s, p) => s + p.total, 0),
    minutes: firstOne ? Math.max(0, (now - Date.parse(firstOne.status.openedAt)) / 60_000) : null,
    waiter: firstOne
      ? (staff.find((u) => u.id === firstOne.status.assignedWaiterId)?.name ?? null)
      : null,
    pendingConfirmation: orders.some((p) => p.pendingConfirmation),
    mergedWith: null,
    mergedIntoTable: null,
  }
}

const describeTable = (table: Table, r: Summary) =>
  [
    `Mesa ${table.name}`,
    STATUSES[r.status].text,
    r.status !== 'free' && !r.mergedIntoTable && r.minutes !== null ? minutes(r.minutes) : '',
    r.status !== 'free' && !r.mergedIntoTable ? pesos(r.total) : '',
    r.mergedIntoTable ? '' : (r.waiter ?? ''),
    r.orders.length > 1 ? `${r.orders.length} pedidos` : '',
    r.mergedWith ? `unida con ${r.mergedWith}` : '',
    r.mergedIntoTable ? `unida a la mesa ${r.mergedIntoTable}` : '',
    r.pendingConfirmation ? 'sin confirmar' : '',
  ]
    .filter(Boolean)
    .join(', ')

export function Tables() {
  const { catalog, device } = useFloor()
  const isRegister = device?.type === 'register'
  const orders = useOrders()
  const now = useNow()
  const [view, setView] = useState<View>(
    () =>
      (['floorPlan', 'list'] as const).find((v) => v === remembered(VIEW_KEY)) ??
      (typeof window !== 'undefined' && window.innerWidth < 768 ? 'list' : 'floorPlan'),
  )
  const [selectedZone, setSelectedZone] = useState(() => remembered(ZONE_KEY))

  const summaries = useMemo(() => {
    const byTable = new Map<string, VisibleOrder[]>()
    // A group of merged tables (task 1.5) takes all of them: each one shows the same order.
    for (const p of orders ?? [])
      for (const m of p.status.tableId ? [p.status.tableId, ...p.status.mergedTables] : [])
        byTable.set(m, [...(byTable.get(m) ?? []), p])
    // A table of the group in another zone is not visible on this plan: it is named with its zone.
    const nameFrom = (from: Table) => (id: string) => {
      const table = catalog?.tables.find((m) => m.id === id)
      if (!table) return '?'
      const zone = catalog?.zones.find((z) => z.id === table.zoneId)
      return table.zoneId === from.zoneId || !zone ? table.name : `${table.name} (${zone.name})`
    }
    return new Map(
      (catalog?.tables ?? []).map((m) => {
        const name = nameFrom(m)
        const r = summarize(byTable.get(m.id) ?? [], catalog?.staff ?? [], now)
        const group = r.orders.find((p) => p.status.mergedTables.length > 0)?.status
        const main = group?.tableId === m.id
        return [
          m.id,
          {
            ...r,
            mergedWith: group && main ? group.mergedTables.map(name).join(', ') : null,
            mergedIntoTable: group?.tableId && !main ? name(group.tableId) : null,
          },
        ]
      }),
    )
  }, [catalog, orders, now])

  if (!catalog) return null
  const zones = catalog.zones
  const differentLevels = new Set(zones.map((z) => z.level)).size > 1
  const zone = zones.find((z) => z.id === selectedZone) ?? zones[0]
  const selectView = (v: View) => {
    setView(v)
    remember(VIEW_KEY, v)
  }
  /** A table merged into another opens the group's order, on its main table. */
  const tap = (table: Table) => {
    const r = summaries.get(table.id)
    // At the register, a table that asked for the check opens it directly (one tap less to charge).
    const single = r?.orders.length === 1 ? r.orders[0] : undefined
    if (isRegister && r?.status === 'check' && single) {
      navigate(`/check?order=${single.status.id}`)
      return
    }
    const group = r?.orders.find((p) => p.status.mergedTables.includes(table.id))
    navigate(
      group?.status.tableId
        ? `/order?table=${group.status.tableId}&order=${group.status.id}`
        : `/order?table=${table.id}`,
    )
  }

  const currentZone = view === 'floorPlan' ? zone : undefined
  const inZone = (status: DemoTableStatus) =>
    catalog.tables.filter(
      (m) =>
        (!currentZone || m.zoneId === currentZone.id) && summaries.get(m.id)?.status === status,
    ).length

  return (
    <FloorFrame title="Salón">
      <div className="mx-auto flex max-w-[96rem] flex-col gap-5 p-3 md:p-5 lg:flex-row lg:items-start">
        <OpenOrders catalog={catalog} orders={orders ?? []} now={now} />

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            {view === 'floorPlan' && zones.length > 1 && (
              <Group label="Zona" className="flex flex-wrap gap-2">
                {zones.map((z) => (
                  <Option
                    key={z.id}
                    selected={z.id === zone?.id}
                    onChoose={() => {
                      setSelectedZone(z.id)
                      remember(ZONE_KEY, z.id)
                    }}
                  >
                    {differentLevels ? `${z.name} · piso ${z.level}` : z.name}
                  </Option>
                ))}
              </Group>
            )}
            <span className="flex-1" />
            <Group label="Ver el salón como" className="flex rounded-xl bg-superficie-2 p-1">
              {(['floorPlan', 'list'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => selectView(v)}
                  className={`flex min-h-12 items-center gap-2 rounded-lg px-3 font-semibold transition-colors focus-visible:outline-3 focus-visible:outline-foco ${
                    view === v ? 'bg-superficie text-texto shadow-flota' : 'text-texto-suave'
                  }`}
                >
                  <Icon name={v === 'floorPlan' ? 'floorPlan' : 'list'} className="size-4" />
                  {v === 'floorPlan' ? 'Plano' : 'Lista'}
                </button>
              ))}
            </Group>
          </div>

          {/* What each color means, with how many tables are like that (in the visible zone). */}
          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm" aria-label="Estado de las mesas">
            {(['free', 'taking', 'ready', 'in_kitchen', 'served'] as const).map((status) => (
              <li key={status} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`size-3 rounded-full ${DOT[STATUSES[status].tone]}`}
                />
                <span className="font-medium">{STATUSES[status].text}</span>
                <span className="cifras text-texto-suave">{inZone(status)}</span>
              </li>
            ))}
          </ul>

          <OrdersOffFloorPlan catalog={catalog} orders={orders ?? []} />

          {zones.length === 0 && (
            <div className="rounded-2xl border border-dashed border-borde bg-superficie p-8 text-center">
              <p className="text-lg font-semibold">Todavía no hay mesas</p>
              <p className="mt-1 text-texto-suave">
                Quien administra el restaurante las dibuja en «Plano del salón».
              </p>
            </div>
          )}

          {view === 'list'
            ? zones.map((z) => (
                <section key={z.id} aria-label={z.name} className="flex flex-col gap-2">
                  {zones.length > 1 && <h2 className="text-lg font-semibold">{z.name}</h2>}
                  <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {catalog.tables
                      .filter((m) => m.zoneId === z.id)
                      .map((m) => (
                        <li key={m.id}>
                          <TableInList
                            table={m}
                            r={summaries.get(m.id) as Summary}
                            onTap={() => tap(m)}
                          />
                        </li>
                      ))}
                  </ul>
                </section>
              ))
            : zone && (
                <ZoneFloorPlan
                  catalog={catalog}
                  zoneId={zone.id}
                  name={zone.name}
                  summaries={summaries}
                  onTap={tap}
                />
              )}
        </div>
      </div>
    </FloorFrame>
  )
}

const CHANNEL_ICON: Record<keyof typeof CHANNELS, IconName> = {
  takeout: 'bag',
  delivery: 'motorcycle',
  bar: 'glass',
}

/** Title of an order: its table or its channel, with the day's number. */
function orderName(catalog: Catalog, p: VisibleOrder): string {
  if (p.status.tableId) {
    const names = [p.status.tableId, ...p.status.mergedTables].map(
      (id) => catalog.tables.find((m) => m.id === id)?.name ?? '?',
    )
    return `Mesa ${names.join(' + ')}`
  }
  const channel = CHANNELS[p.status.channel as keyof typeof CHANNELS] ?? 'Pedido'
  return p.status.dayNumber ? `${channel} #${p.status.dayNumber}` : channel
}

/**
 * The open orders, newest to oldest, in cards colored by their status, and the
 * buttons to open one without a table: takeout, delivery and bar (brief §4.1). At the register it
 * is a column beside the plan; on the phone, a strip that slides at the top.
 */
function OpenOrders({
  catalog,
  orders,
  now,
}: {
  catalog: Catalog
  orders: VisibleOrder[]
  now: number
}) {
  const openOnes = orders
    .filter((p) => currentItems(p.status).length > 0 || p.status.tableId === null)
    .sort((a, b) => Date.parse(b.status.openedAt) - Date.parse(a.status.openedAt))
  return (
    <section
      aria-labelledby="title-orders"
      className="order-last flex flex-col gap-3 lg:sticky lg:top-24 lg:w-80 lg:shrink-0"
    >
      <div className="flex items-baseline justify-between">
        <h2 id="title-orders" className="text-lg font-semibold">
          Pedidos abiertos
        </h2>
        <span className="cifras text-texto-suave">{openOnes.length}</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {(Object.keys(CHANNELS) as (keyof typeof CHANNELS)[]).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => navigate(`/order?channel=${c}`)}
            className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border border-linea bg-superficie px-2 text-sm font-semibold transition-colors hover:border-accion-fuerte hover:text-accion-texto focus-visible:outline-3 focus-visible:outline-foco"
          >
            <Icon name={CHANNEL_ICON[c]} className="size-5" />
            <span className="leading-tight">{CHANNELS[c]}</span>
          </button>
        ))}
      </div>
      {openOnes.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-borde p-5 text-center text-sm text-texto-suave">
          Sin pedidos por ahora. Toca una mesa para empezar uno.
        </p>
      ) : (
        <ul className="-mx-3 flex gap-3 overflow-x-auto px-3 pb-1 lg:mx-0 lg:max-h-[calc(100dvh-18rem)] lg:flex-col lg:overflow-y-auto lg:px-0">
          {openOnes.map((p) => {
            const status = tableStatus([p])
            const v = STATUSES[status]
            const items = currentItems(p.status).reduce(
              (s, i) => s + i.quantity - i.voidedQuantity,
              0,
            )
            const waiter = catalog.staff.find((u) => u.id === p.status.assignedWaiterId)
            const from = Math.max(0, (now - Date.parse(p.status.openedAt)) / 60_000)
            return (
              <li key={p.status.id} className="w-64 shrink-0 lg:w-auto">
                <button
                  type="button"
                  onClick={() =>
                    navigate(
                      p.status.tableId
                        ? `/order?table=${p.status.tableId}&order=${p.status.id}`
                        : `/order?order=${p.status.id}`,
                    )
                  }
                  className={`flex w-full flex-col gap-2 rounded-2xl p-4 text-left transition active:scale-[0.98] focus-visible:outline-3 focus-visible:outline-foco ${SOFT_TONES[v.tone]}`}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-lg font-bold">{orderName(catalog, p)}</span>
                    <span className="cifras font-semibold">{pesos(p.total)}</span>
                  </span>
                  <span className="text-sm">
                    {[
                      `${items} ${items === 1 ? 'producto' : 'productos'}`,
                      waiter?.name,
                      minutes(from),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <span className="flex items-center gap-2">
                    <Label tone={v.tone} icon={p.pendingConfirmation ? 'clock' : v.icon} main>
                      {p.pendingConfirmation ? `${v.text} · sin confirmar` : v.text}
                    </Label>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/**
 * Open orders whose table is no longer on the plan (it was archived while an offline waiter
 * was using it): they stay in sight. They are moved with «Mesa y pedido → Cambiar de mesa».
 */
function OrdersOffFloorPlan({ catalog, orders }: { catalog: Catalog; orders: VisibleOrder[] }) {
  const tables = new Set(catalog.tables.map((m) => m.id))
  const outside = orders.filter((p) => p.status.tableId !== null && !tables.has(p.status.tableId))
  if (outside.length === 0) return null
  return (
    <section
      aria-label="Pedidos en mesas que ya no están en el plano"
      className="mb-3 rounded-2xl border-2 border-alerta-fuerte bg-alerta-suave p-3 text-alerta-texto"
    >
      <p className="font-semibold">
        {outside.length === 1
          ? 'Hay un pedido abierto en una mesa que ya no está en el plano.'
          : `Hay ${outside.length} pedidos abiertos en mesas que ya no están en el plano.`}{' '}
        Avisa en caja.
      </p>
      <ul className="mt-1">
        {outside.map((p) => (
          <li key={p.status.id} className="cifras">
            {[catalog.staff.find((u) => u.id === p.status.assignedWaiterId)?.name, pesos(p.total)]
              .filter(Boolean)
              .join(' · ')}
          </li>
        ))}
      </ul>
    </section>
  )
}

function ZoneFloorPlan({
  catalog,
  zoneId,
  name,
  summaries,
  onTap,
}: {
  catalog: Catalog
  zoneId: string
  name: string
  summaries: Map<string, Summary>
  onTap: (m: Table) => void
}) {
  const tables = catalog.tables.filter((m) => m.zoneId === zoneId)
  const elements = catalog.elements.filter((e) => e.zoneId === zoneId)
  const box = bounds([...tables, ...elements])
  const { ref, scale } = useScale(box)
  const center = (m: Table) => {
    const e = placement(m, box, scale)
    return { x: Number(e.left) + Number(e.width) / 2, y: Number(e.top) + Number(e.height) / 2 }
  }
  // The tables of a group carry a halo of their color underneath, and each merged one a strip to
  // its main table; if the strip would cross another table, only the halos and the text remain.
  const groupOf = (m: Table) =>
    summaries
      .get(m.id)
      ?.orders.find((p) => p.status.tableId === m.id || p.status.mergedTables.includes(m.id))
      ?.status
  const inGroup = tables.filter((m) => (groupOf(m)?.mergedTables.length ?? 0) > 0)
  const merges = inGroup.flatMap((m) => {
    const main = tables.find((x) => x.id === groupOf(m)?.tableId)
    if (!main || main.id === m.id) return []
    const [src, a] = [center(main), center(m)]
    const crosses = tables.some(
      (x) => x.id !== m.id && x.id !== main.id && crossesBox(src, a, placement(x, box, scale)),
    )
    return crosses ? [] : [{ id: m.id, src, a }]
  })
  const thickness = Math.max(8, 20 * scale)
  const tone = (m: Table) => UNION[STATUSES[(summaries.get(m.id) as Summary).status].tone]
  return (
    <Canvas box={box} scale={scale} containerRef={ref} label={`Plano de ${name}`}>
      {inGroup.length > 0 && (
        <svg aria-hidden="true" className="pointer-events-none absolute inset-0 size-full">
          {merges.map((u) => {
            const m = inGroup.find((x) => x.id === u.id) as Table
            return (
              <line
                key={u.id}
                x1={u.src.x}
                y1={u.src.y}
                x2={u.a.x}
                y2={u.a.y}
                stroke="currentColor"
                strokeWidth={thickness}
                strokeLinecap="round"
                className={tone(m)}
              />
            )
          })}
          {inGroup.map((m) => {
            const e = placement(m, box, scale)
            const [x, y, w, h] = [e.left, e.top, e.width, e.height].map(Number) as [
              number,
              number,
              number,
              number,
            ]
            const halo = thickness / 2
            return (
              <rect
                key={m.id}
                x={x - halo}
                y={y - halo}
                width={w + 2 * halo}
                height={h + 2 * halo}
                rx={m.shape === 'round' ? (Math.min(w, h) + 2 * halo) / 2 : 16 + halo}
                fill="currentColor"
                transform={
                  m.rotation ? `rotate(${m.rotation} ${x + w / 2} ${y + h / 2})` : undefined
                }
                className={tone(m)}
              />
            )
          })}
        </svg>
      )}
      {elements.map((e) => (
        <div key={e.id} style={placement(e, box, scale)} aria-hidden="true">
          <ElementShape type={e.type} text={e.text} scale={scale} />
        </div>
      ))}
      {tables.map((m) => (
        <TableOnFloorPlan
          key={m.id}
          table={m}
          r={summaries.get(m.id) as Summary}
          style={placement(m, box, scale)}
          scale={scale}
          onTap={() => onTap(m)}
        />
      ))}
    </Canvas>
  )
}

/** Whether the segment from `src` to `a` goes through a table's box (not counting its rotation). */
function crossesBox(
  src: { x: number; y: number },
  a: { x: number; y: number },
  box: React.CSSProperties,
): boolean {
  const [x0, y0] = [Number(box.left), Number(box.top)]
  const [x1, y1] = [x0 + Number(box.width), y0 + Number(box.height)]
  // Liang-Barsky: clips the segment against the box; if anything remains, it crosses it.
  const [dx, dy] = [a.x - src.x, a.y - src.y]
  let [t0, t1] = [0, 1]
  for (const [p, q] of [
    [-dx, src.x - x0],
    [dx, x1 - src.x],
    [-dy, src.y - y0],
    [dy, y1 - src.y],
  ] as const) {
    if (p === 0) {
      if (q < 0) return false
    } else {
      const t = q / p
      if (p < 0) t0 = Math.max(t0, t)
      else t1 = Math.min(t1, t)
      if (t0 > t1) return false
    }
  }
  return true
}

const tableClass = (r: Summary) =>
  `${BORDER[STATUSES[r.status].tone]} ${SOFT_TONES[STATUSES[r.status].tone]}`

const seatClass = (r: Summary) => SEAT[STATUSES[r.status].tone]

function TableOnFloorPlan({
  table,
  r,
  style,
  scale,
  onTap,
}: {
  table: Table
  r: Summary
  style: React.CSSProperties
  scale: number
  onTap: () => void
}) {
  const v = STATUSES[r.status]
  // A small table on screen only fits the number and the icon; the list says the rest.
  const side = Math.min(table.width, table.height) * scale
  const detail = side >= 80
  const withWaiter = side >= 110
  // Make it tappable with a finger: at least 48 px, growing around its center.
  const grow = (size: number, start: number) => {
    const extra = Math.max(0, 48 - size)
    return { start: start - extra / 2, size: size + extra }
  }
  const width = grow(Number(style.width), Number(style.left))
  const height = grow(Number(style.height), Number(style.top))
  const tappable = {
    ...style,
    left: width.start,
    width: width.size,
    top: height.start,
    height: height.size,
  }
  return (
    <>
      <div style={style} aria-hidden="true" className="pointer-events-none">
        <Seats
          shape={table.shape}
          width={Number(style.width)}
          height={Number(style.height)}
          places={table.capacity}
          cssClass={seatClass(r)}
        />
      </div>
      <button
        type="button"
        onClick={onTap}
        aria-label={`${describeTable(table, r)}, ${table.capacity} ${table.capacity === 1 ? 'puesto' : 'puestos'}`}
        style={tappable}
        className={`flex items-center justify-center border-2 p-1 shadow-flota transition active:scale-95 focus-visible:outline-3 focus-visible:outline-foco ${
          table.shape === 'round' ? 'rounded-full' : 'rounded-2xl'
        } ${tableClass(r)}`}
      >
        {/* The content does not rotate with the table: it always reads upright. */}
        <span
          className="flex flex-col items-center text-center leading-tight"
          style={table.rotation ? { transform: `rotate(${-table.rotation}deg)` } : undefined}
        >
          <span className="flex items-center gap-1">
            <span className="font-titulo text-xl font-bold">{table.name}</span>
            <Icon name={r.pendingConfirmation ? 'clock' : v.icon} className="size-4" />
          </span>
          {detail && r.mergedWith && (
            <span className="max-w-full truncate text-sm font-semibold">{`+ ${r.mergedWith}`}</span>
          )}
          {detail && r.mergedIntoTable && (
            <span className="max-w-full truncate text-sm font-semibold">{`con la ${r.mergedIntoTable}`}</span>
          )}
          {detail && r.status !== 'free' && !r.mergedIntoTable && (
            <span className="cifras text-sm">
              {r.minutes !== null && minutes(r.minutes)}
              <br />
              {pesos(r.total)}
            </span>
          )}
          {withWaiter && r.waiter && !r.mergedIntoTable && (
            <span className="max-w-full truncate text-sm">{r.waiter}</span>
          )}
        </span>
      </button>
    </>
  )
}

function TableInList({ table, r, onTap }: { table: Table; r: Summary; onTap: () => void }) {
  const v = STATUSES[r.status]
  const takenPath = r.status !== 'free'
  return (
    <button
      type="button"
      onClick={onTap}
      aria-label={describeTable(table, r)}
      className="flex min-h-18 w-full items-center gap-3 rounded-2xl border border-linea bg-superficie px-3 py-2 text-left transition-colors hover:border-borde focus-visible:outline-3 focus-visible:outline-foco"
    >
      <span
        className={`font-titulo flex size-12 shrink-0 items-center justify-center rounded-xl text-2xl font-bold ${tableClass(r)}`}
      >
        {table.name}
      </span>
      <span className="flex-1">
        <Label tone={v.tone} icon={r.pendingConfirmation ? 'clock' : v.icon}>
          {r.pendingConfirmation ? `${v.text} · sin confirmar` : v.text}
        </Label>
        {takenPath && (
          <span className="mt-1 block text-sm text-texto-suave">
            {[
              r.mergedIntoTable ? null : r.waiter,
              r.minutes !== null && !r.mergedIntoTable ? minutes(r.minutes) : null,
              r.orders.length > 1 ? `${r.orders.length} pedidos` : null,
              r.mergedWith ? `Unida con ${r.mergedWith}` : null,
              r.mergedIntoTable ? `Unida a la mesa ${r.mergedIntoTable}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
      </span>
      {takenPath && !r.mergedIntoTable && (
        <span className="cifras font-semibold">{pesos(r.total)}</span>
      )}
    </button>
  )
}
