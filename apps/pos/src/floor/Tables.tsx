import type { Catalog } from '@pos/sync'
import { useMemo, useState } from 'react'
import { minutes, pesos } from '../ui/format'
import { Icon } from '../ui/icons'
import { Label, SOFT_TONES } from '../ui/Label'
import { useNow } from '../ui/now'
import { Group, Option } from '../ui/Options'
import { navigate } from '../ui/route'
import { useFloor, useOrders } from './context'
import { FloorFrame } from './FloorFrame'
import { CHANNELS } from './order'
import { currentItems, type DemoTableStatus, tableStatus, type VisibleOrder } from './projection'
import {
  CHANNEL_ICON,
  DOT,
  orderName,
  STATUSES,
  TableInList,
  type TableSummary,
  tableSummaries,
  ZoneFloorPlan,
} from './TablesView'

// Floor plan (brief §5, rule 1): the waiter's home screen. Each zone or floor with its
// tables in their real place with their seats, and on each occupied table the status, the time,
// the total and who is serving it. On the phone, or if preferred, the same information as a
// list. Beside it (at the register) or above (on the phone), the open orders in cards colored
// by their status, and the buttons for orders without a table. A tap on the table or the card
// goes to its order.

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

  const summaries = useMemo(
    () => (catalog ? tableSummaries(catalog, orders ?? [], now) : new Map<string, TableSummary>()),
    [catalog, orders, now],
  )

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
            <Group label="Ver el salón como" className="flex rounded-xl bg-surface-2 p-1">
              {(['floorPlan', 'list'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => selectView(v)}
                  className={`flex min-h-12 items-center gap-2 rounded-lg px-3 font-semibold transition-colors focus-visible:outline-3 focus-visible:outline-focus ${
                    view === v ? 'bg-surface text-foreground shadow-float' : 'text-muted'
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
                <span className="figures text-muted">{inZone(status)}</span>
              </li>
            ))}
          </ul>

          <OrdersOffFloorPlan catalog={catalog} orders={orders ?? []} />

          {zones.length === 0 && (
            <div className="rounded-2xl border border-dashed border-border bg-surface p-8 text-center">
              <p className="text-lg font-semibold">Todavía no hay mesas</p>
              <p className="mt-1 text-muted">
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
                            r={summaries.get(m.id) as TableSummary}
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
  const openOrders = orders
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
        <span className="figures text-muted">{openOrders.length}</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {(Object.keys(CHANNELS) as (keyof typeof CHANNELS)[]).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => navigate(`/order?channel=${c}`)}
            className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border border-divider bg-surface px-2 text-sm font-semibold transition-colors hover:border-action-strong hover:text-action-text focus-visible:outline-3 focus-visible:outline-focus"
          >
            <Icon name={CHANNEL_ICON[c]} className="size-5" />
            <span className="leading-tight">{CHANNELS[c]}</span>
          </button>
        ))}
      </div>
      {openOrders.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border p-5 text-center text-sm text-muted">
          Sin pedidos por ahora. Toca una mesa para empezar uno.
        </p>
      ) : (
        <ul className="-mx-3 flex gap-3 overflow-x-auto px-3 pb-1 lg:mx-0 lg:max-h-[calc(100dvh-18rem)] lg:flex-col lg:overflow-y-auto lg:px-0">
          {openOrders.map((p) => {
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
                  className={`flex w-full flex-col gap-2 rounded-2xl p-4 text-left transition active:scale-[0.98] focus-visible:outline-3 focus-visible:outline-focus ${SOFT_TONES[v.tone]}`}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-lg font-bold">{orderName(catalog, p)}</span>
                    <span className="figures font-semibold">{pesos(p.total)}</span>
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
      className="mb-3 rounded-2xl border-2 border-alert-strong bg-alert-soft p-3 text-alert-text"
    >
      <p className="font-semibold">
        {outside.length === 1
          ? 'Hay un pedido abierto en una mesa que ya no está en el plano.'
          : `Hay ${outside.length} pedidos abiertos en mesas que ya no están en el plano.`}{' '}
        Avisa en caja.
      </p>
      <ul className="mt-1">
        {outside.map((p) => (
          <li key={p.status.id} className="figures">
            {[catalog.staff.find((u) => u.id === p.status.assignedWaiterId)?.name, pesos(p.total)]
              .filter(Boolean)
              .join(' · ')}
          </li>
        ))}
      </ul>
    </section>
  )
}
