import type { Catalog } from '@pos/sync'
import { minutes, pesos } from '../ui/format'
import { Icon, type IconName } from '../ui/icons'
import { Label, SOFT_TONES, type Tone } from '../ui/Label'
import { Canvas, ElementShape, placement, Seats, useScale } from './FloorPlanCanvas'
import { bounds } from './floor-plan'
import { CHANNELS } from './order'
import { type DemoTableStatus, tableStatus, type VisibleOrder } from './projection'

// The floor plan's pieces that do not depend on the device's engine (task 1.11c-2): the waiter's
// «Salón» (`Tables.tsx`) and the owner's panel (`panel/PanelFloor.tsx`) draw the same tables, with
// the same colors and texts. Each one brings its orders and decides what a tap does.

/** What the plan needs of the catalog: the hub's whole catalog, or the plan the cloud sends. */
export type FloorPlace = Pick<Catalog, 'zones' | 'tables' | 'elements' | 'staff'>

export const STATUSES: Record<DemoTableStatus, { tone: Tone; icon: IconName; text: string }> = {
  free: { tone: 'free', icon: 'circle', text: 'Libre' },
  taking: { tone: 'progress', icon: 'pencil', text: 'Tomando pedido' },
  ready: { tone: 'free', icon: 'serve', text: 'Listo para llevar' },
  check: { tone: 'action', icon: 'receipt', text: 'Pidió la cuenta' },
  in_kitchen: { tone: 'progress', icon: 'fire', text: 'En preparación' },
  served: { tone: 'neutral', icon: 'check', text: 'Servida' },
}

/** Table border and seat color, by the tone of its status (full classes). */
const BORDER: Record<Tone, string> = {
  free: 'border-free-strong/45',
  progress: 'border-progress-strong/45',
  warning: 'border-alert-strong/45',
  action: 'border-action-strong/45',
  neutral: 'border-neutral-strong/45',
}
const SEAT: Record<Tone, string> = {
  free: 'bg-free-strong/55',
  progress: 'bg-progress-strong/70',
  warning: 'bg-alert-strong/70',
  action: 'bg-action-strong/60',
  neutral: 'bg-neutral-strong/55',
}
/** The halo and the strip that join on the plan the tables of the same order (task 1.5). */
const UNION: Record<Tone, string> = {
  free: 'text-free-strong',
  progress: 'text-progress-strong',
  warning: 'text-alert-strong',
  action: 'text-action-strong',
  neutral: 'text-neutral-strong',
}
export const DOT: Record<Tone, string> = {
  free: 'bg-free-strong',
  progress: 'bg-progress-strong',
  warning: 'bg-alert-strong',
  action: 'bg-action-strong',
  neutral: 'bg-neutral-strong',
}

type Table = Catalog['tables'][number]

/** What is said about a table: status, time since it was opened, total and who is serving it. */
export interface TableSummary {
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

export function summarize(
  orders: VisibleOrder[],
  staff: Catalog['staff'],
  now: number,
): TableSummary {
  const first = orders[0]
  return {
    status: tableStatus(orders),
    orders,
    total: orders.reduce((s, p) => s + p.total, 0),
    minutes: first ? Math.max(0, (now - Date.parse(first.status.openedAt)) / 60_000) : null,
    waiter: first
      ? (staff.find((u) => u.id === first.status.assignedWaiterId)?.name ?? null)
      : null,
    pendingConfirmation: orders.some((p) => p.pendingConfirmation),
    mergedWith: null,
    mergedIntoTable: null,
  }
}

export const describeTable = (table: Table, r: TableSummary) =>
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

/**
 * What each table of the plan says, by its id: its orders (a group of merged tables takes all of
 * them), status, time, total and waiter.
 */
export function tableSummaries(
  catalog: FloorPlace,
  orders: readonly VisibleOrder[],
  now: number,
): Map<string, TableSummary> {
  const byTable = new Map<string, VisibleOrder[]>()
  // A group of merged tables (task 1.5) takes all of them: each one shows the same order.
  for (const p of orders)
    for (const m of p.status.tableId ? [p.status.tableId, ...p.status.mergedTables] : [])
      byTable.set(m, [...(byTable.get(m) ?? []), p])
  // A table of the group in another zone is not visible on this plan: it is named with its zone.
  const nameFrom = (from: Table) => (id: string) => {
    const table = catalog.tables.find((m) => m.id === id)
    if (!table) return '?'
    const zone = catalog.zones.find((z) => z.id === table.zoneId)
    return table.zoneId === from.zoneId || !zone ? table.name : `${table.name} (${zone.name})`
  }
  return new Map(
    (catalog.tables ?? []).map((m) => {
      const name = nameFrom(m)
      const r = summarize(byTable.get(m.id) ?? [], catalog.staff, now)
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
}

export const CHANNEL_ICON: Record<keyof typeof CHANNELS, IconName> = {
  takeout: 'bag',
  delivery: 'motorcycle',
  bar: 'glass',
}

/** Title of an order: its table or its channel, with the day's number. */
export function orderName(catalog: Pick<Catalog, 'tables'>, p: VisibleOrder): string {
  if (p.status.tableId) {
    const names = [p.status.tableId, ...p.status.mergedTables].map(
      (id) => catalog.tables.find((m) => m.id === id)?.name ?? '?',
    )
    return `Mesa ${names.join(' + ')}`
  }
  const channel = CHANNELS[p.status.channel as keyof typeof CHANNELS] ?? 'Pedido'
  return p.status.dayNumber ? `${channel} #${p.status.dayNumber}` : channel
}

export function ZoneFloorPlan({
  catalog,
  zoneId,
  name,
  summaries,
  onTap,
}: {
  catalog: FloorPlace
  zoneId: string
  name: string
  summaries: Map<string, TableSummary>
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
  const tone = (m: Table) => UNION[STATUSES[(summaries.get(m.id) as TableSummary).status].tone]
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
          r={summaries.get(m.id) as TableSummary}
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

const tableClass = (r: TableSummary) =>
  `${BORDER[STATUSES[r.status].tone]} ${SOFT_TONES[STATUSES[r.status].tone]}`

const seatClass = (r: TableSummary) => SEAT[STATUSES[r.status].tone]

function TableOnFloorPlan({
  table,
  r,
  style,
  scale,
  onTap,
}: {
  table: Table
  r: TableSummary
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
        className={`flex items-center justify-center border-2 p-1 shadow-float transition active:scale-95 focus-visible:outline-3 focus-visible:outline-focus ${
          table.shape === 'round' ? 'rounded-full' : 'rounded-2xl'
        } ${tableClass(r)}`}
      >
        {/* The content does not rotate with the table: it always reads upright. */}
        <span
          className="flex flex-col items-center text-center leading-tight"
          style={table.rotation ? { transform: `rotate(${-table.rotation}deg)` } : undefined}
        >
          <span className="flex items-center gap-1">
            <span className="font-heading text-xl font-bold">{table.name}</span>
            <Icon name={r.pendingConfirmation ? 'clock' : v.icon} className="size-4" />
          </span>
          {detail && r.mergedWith && (
            <span className="max-w-full truncate text-sm font-semibold">{`+ ${r.mergedWith}`}</span>
          )}
          {detail && r.mergedIntoTable && (
            <span className="max-w-full truncate text-sm font-semibold">{`con la ${r.mergedIntoTable}`}</span>
          )}
          {detail && r.status !== 'free' && !r.mergedIntoTable && (
            <span className="figures text-sm">
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

export function TableInList({
  table,
  r,
  onTap,
}: {
  table: Table
  r: TableSummary
  onTap: () => void
}) {
  const v = STATUSES[r.status]
  const takenPath = r.status !== 'free'
  return (
    <button
      type="button"
      onClick={onTap}
      aria-label={describeTable(table, r)}
      className="flex min-h-18 w-full items-center gap-3 rounded-2xl border border-divider bg-surface px-3 py-2 text-left transition-colors hover:border-border focus-visible:outline-3 focus-visible:outline-focus"
    >
      <span
        className={`font-heading flex size-12 shrink-0 items-center justify-center rounded-xl text-2xl font-bold ${tableClass(r)}`}
      >
        {table.name}
      </span>
      <span className="flex-1">
        <Label tone={v.tone} icon={r.pendingConfirmation ? 'clock' : v.icon}>
          {r.pendingConfirmation ? `${v.text} · sin confirmar` : v.text}
        </Label>
        {takenPath && (
          <span className="mt-1 block text-sm text-muted">
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
        <span className="figures font-semibold">{pesos(r.total)}</span>
      )}
    </button>
  )
}
