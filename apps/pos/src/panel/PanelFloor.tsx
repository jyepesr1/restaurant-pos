import { type OrderItem, orderTotals, pricePerUnit } from '@pos/core'
import { currentItems, tableStatus, type VisibleOrder } from '@pos/sync/views'
import { useMemo, useState } from 'react'
import {
  DOT,
  type FloorPlace,
  orderName,
  STATUSES,
  TableInList,
  type TableSummary,
  tableSummaries,
  ZoneFloorPlan,
} from '../floor/TablesView'
import { minutes, pesos } from '../ui/format'
import { Icon } from '../ui/icons'
import { Label, SOFT_TONES } from '../ui/Label'
import { useNow } from '../ui/now'
import { Group, Option } from '../ui/Options'
import { SidePanel } from '../ui/SidePanel'
import type { PanelApi } from './api'
import { DataStatus, FirstAnswer } from './DataStatus'
import {
  at,
  type FloorAnswer,
  floorFetcher,
  floorState,
  type LiveTime,
  placeOf,
  visibleOrders,
} from './live-floor'
import { FAST_GAP_MS, usePolling } from './poller'
import { EVERY_MS, type Polled, timeOf } from './summary'

// «Salón» in the owner's panel (task 1.11c-2): the tables as the waiters see them, by zone, on the
// plan or as a list, with the orders without a table. A tap on a table opens its whole order to
// read (nothing can be changed from here). It reads again when the cloud says something changed
// (at most every 3 s) and every so often anyway; the times run with the cloud's clock and stop
// when nothing arrives from the restaurant.

/** Asks for the floor while it is in view; the plan comes only when it changes. */
export function useLiveFloor(api: Pick<PanelApi, 'floor'>): Polled<FloorAnswer> {
  const fetch = useMemo(() => floorFetcher(api), [api])
  return usePolling(fetch, EVERY_MS, { minGapMs: FAST_GAP_MS })
}

export function PanelFloor({ api, timeZone }: { api: Pick<PanelApi, 'floor'>; timeZone: string }) {
  const polled = useLiveFloor(api)
  const deviceNow = useNow(15_000)
  return <FloorView polled={polled} deviceNow={deviceNow} timeZone={timeZone} />
}

type View = 'floorPlan' | 'list'
/** What is open in the side panel: a table (with its orders) or an order without a table. */
type Selected = { table: string } | { order: string } | null

export function FloorView({
  polled,
  deviceNow,
  timeZone,
  initialView,
}: {
  polled: Polled<FloorAnswer>
  deviceNow: number
  timeZone: string
  initialView?: View
}) {
  const [view, setView] = useState<View>(
    () =>
      initialView ??
      (typeof window !== 'undefined' && window.innerWidth < 768 ? 'list' : 'floorPlan'),
  )
  const [zoneId, setZoneId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Selected>(null)
  const { state, time } = floorState(polled, deviceNow, timeZone)
  const data = polled.data

  const orders = useMemo(() => visibleOrders(data?.orders ?? []), [data])
  const place = useMemo<FloorPlace | null>(() => (data ? placeOf(data) : null), [data])
  const summaries = useMemo(
    () => (place ? tableSummaries(place, orders, time.now) : new Map<string, TableSummary>()),
    [place, orders, time.now],
  )

  return (
    <div className="flex flex-col gap-4">
      <DataStatus state={state} shown={Boolean(data)} onRetry={polled.retry} />
      {!data || !place ? (
        <FirstAnswer
          polled={polled}
          reading="Leyendo el salón…"
          failure="No se pudo leer el salón."
        />
      ) : (
        <Floor
          place={place}
          orders={orders}
          summaries={summaries}
          time={time}
          view={view}
          onView={setView}
          zoneId={zoneId}
          onZone={setZoneId}
          onSelect={setSelected}
        />
      )}
      {data && place && (
        <OrderPanel
          selected={selected}
          place={place}
          orders={orders}
          summaries={summaries}
          users={data.users}
          time={time}
          timeZone={timeZone}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}

/** «Los tiempos van hasta las 9:41 p. m.»: they stopped because nothing arrives. */
export function FrozenTimes({ time }: { time: LiveTime }) {
  if (!time.frozenAt) return null
  return (
    <p className="flex items-center gap-2 text-sm text-muted">
      <Icon name="clock" className="shrink-0" />
      {`Los tiempos se quedaron en las ${time.frozenAt}: siguen cuando vuelvan los datos.`}
    </p>
  )
}

function Floor({
  place,
  orders,
  summaries,
  time,
  view,
  onView,
  zoneId,
  onZone,
  onSelect,
}: {
  place: FloorPlace
  orders: VisibleOrder[]
  summaries: Map<string, TableSummary>
  time: LiveTime
  view: View
  onView: (v: View) => void
  zoneId: string | null
  onZone: (id: string) => void
  onSelect: (s: Selected) => void
}) {
  const zones = place.zones
  const differentLevels = new Set(zones.map((z) => z.level)).size > 1
  const zone = zones.find((z) => z.id === zoneId) ?? zones[0]
  const onPlan = new Set(place.tables.map((m) => m.id))
  const withoutTable = orders.filter((p) => p.status.tableId === null)
  const offPlan = orders.filter(
    (p) =>
      p.status.tableId !== null &&
      !onPlan.has(p.status.tableId) &&
      currentItems(p.status).length > 0,
  )
  const currentZone = view === 'floorPlan' ? zone : undefined
  const inZone = (status: TableSummary['status']) =>
    place.tables.filter(
      (m) =>
        (!currentZone || m.zoneId === currentZone.id) && summaries.get(m.id)?.status === status,
    ).length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {view === 'floorPlan' && zones.length > 1 && (
          <Group label="Zona" className="flex flex-wrap gap-2">
            {zones.map((z) => (
              <Option key={z.id} selected={z.id === zone?.id} onChoose={() => onZone(z.id)}>
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
              onClick={() => onView(v)}
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

      <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm" aria-label="Estado de las mesas">
        {zones.length > 1 && (
          <li className="text-muted">
            {currentZone ? `En ${currentZone.name}:` : 'En todas las zonas:'}
          </li>
        )}
        {(['free', 'taking', 'ready', 'check', 'in_kitchen', 'served'] as const).map((status) => (
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

      {/* What is not on the plan goes after it; up here, a pill with how many that leads there. */}
      {(withoutTable.length > 0 || offPlan.length > 0) && (
        <p className="flex flex-wrap gap-2">
          {withoutTable.length > 0 && (
            <JumpTo id="without-table" text={`Pedidos sin mesa: ${withoutTable.length}`} />
          )}
          {offPlan.length > 0 && (
            <JumpTo id="off-plan" text={`Mesas quitadas del plano: ${offPlan.length}`} />
          )}
        </p>
      )}

      <FrozenTimes time={time} />

      {zones.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border bg-surface p-8 text-center">
          <p className="text-lg font-semibold">Todavía no hay mesas</p>
          <p className="mt-1 text-muted">
            El plano del salón llega cuando el PC de caja lo envía a la nube.
          </p>
        </div>
      )}

      {view === 'list'
        ? zones.map((z) => (
            <section key={z.id} aria-label={z.name} className="flex flex-col gap-2">
              {zones.length > 1 && <h2 className="text-lg font-semibold">{z.name}</h2>}
              <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {place.tables
                  .filter((m) => m.zoneId === z.id)
                  .map((m) => (
                    <li key={m.id}>
                      <TableInList
                        table={m}
                        r={summaries.get(m.id) as TableSummary}
                        onTap={() => onSelect({ table: m.id })}
                      />
                    </li>
                  ))}
              </ul>
            </section>
          ))
        : zone && (
            <ZoneFloorPlan
              catalog={place}
              zoneId={zone.id}
              name={zone.name}
              summaries={summaries}
              onTap={(m) => onSelect({ table: m.id })}
            />
          )}

      {withoutTable.length > 0 && (
        <OrderCards
          id="without-table"
          title="Pedidos sin mesa"
          orders={withoutTable}
          place={place}
          time={time}
          onSelect={(id) => onSelect({ order: id })}
        />
      )}
      {offPlan.length > 0 && (
        <OrderCards
          id="off-plan"
          title="Mesas quitadas del plano con cuenta abierta"
          orders={offPlan}
          place={place}
          time={time}
          onSelect={(id) => onSelect({ order: id })}
        />
      )}
    </div>
  )
}

/** A pill that leads to a section further down («Pedidos sin mesa: 2»). */
function JumpTo({ id, text }: { id: string; text: string }) {
  return (
    <button
      type="button"
      aria-controls={id}
      onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })}
      className="inline-flex min-h-12 items-center gap-2 rounded-full border border-border bg-surface px-4 font-semibold focus-visible:outline-3 focus-visible:outline-focus"
    >
      {text}
      <Icon name="arrowDown" className="size-4 shrink-0" />
    </button>
  )
}

/** Orders as cards colored by their state (takeout, delivery, bar…). */
function OrderCards({
  id,
  title,
  orders,
  place,
  time,
  onSelect,
}: {
  id: string
  title: string
  orders: VisibleOrder[]
  place: FloorPlace
  time: LiveTime
  onSelect: (orderId: string) => void
}) {
  return (
    <section id={id} aria-label={title} className="flex scroll-mt-20 flex-col gap-2">
      <h2 className="text-lg font-semibold">
        {title} <span className="figures text-muted">{orders.length}</span>
      </h2>
      <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {orders.map((p) => {
          const v = STATUSES[tableStatus([p])]
          const count = units(currentItems(p.status))
          const waiter = place.staff.find((u) => u.id === p.status.assignedWaiterId)?.name
          return (
            <li key={p.status.id}>
              <button
                type="button"
                onClick={() => onSelect(p.status.id)}
                className={`flex w-full flex-col gap-2 rounded-2xl p-4 text-left transition active:scale-[0.98] focus-visible:outline-3 focus-visible:outline-focus ${SOFT_TONES[v.tone]}`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-lg font-bold">{orderName(place, p)}</span>
                  <span className="figures font-semibold">{pesos(p.total)}</span>
                </span>
                <span className="text-sm">
                  {[
                    `${count} ${count === 1 ? 'producto' : 'productos'}`,
                    waiter,
                    at(minutes(elapsed(p.status.openedAt, time)), time),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <Label tone={v.tone} icon={v.icon} main>
                  {v.text}
                </Label>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

const units = (items: OrderItem[]) => items.reduce((s, i) => s + i.quantity - i.voidedQuantity, 0)
const elapsed = (since: string, time: LiveTime) =>
  Math.max(0, (time.now - Date.parse(since)) / 60_000)

function OrderPanel({
  selected,
  place,
  orders,
  summaries,
  users,
  time,
  timeZone,
  onClose,
}: {
  selected: Selected
  place: FloorPlace
  orders: VisibleOrder[]
  summaries: Map<string, TableSummary>
  users: Record<string, string>
  time: LiveTime
  timeZone: string
  onClose: () => void
}) {
  const table =
    selected && 'table' in selected ? place.tables.find((m) => m.id === selected.table) : null
  const shown =
    selected && 'table' in selected
      ? (summaries.get(selected.table)?.orders ?? [])
      : orders.filter((p) => selected && 'order' in selected && p.status.id === selected.order)
  const title = table ? `Mesa ${table.name}` : shown[0] ? orderName(place, shown[0]) : 'Pedido'
  return (
    <SidePanel opened={selected !== null} title={title} onClose={onClose}>
      {shown.length === 0 ? (
        <p className="text-muted">
          {table ? 'La mesa está libre.' : 'Este pedido ya no está abierto.'}
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {shown.map((p) => (
            <OrderDetail
              key={p.status.id}
              order={p}
              place={place}
              users={users}
              time={time}
              timeZone={timeZone}
              titled={shown.length > 1}
            />
          ))}
        </div>
      )}
    </SidePanel>
  )
}

const ITEM_STATUS: Record<OrderItem['status'], string> = {
  held: 'En espera',
  pending: 'Sin enviar',
  sent: 'En cocina',
  in_preparation: 'En preparación',
  ready: 'Listo para llevar',
  served: 'Entregado',
  voided: 'Anulado',
}

/**
 * The whole order, to read: who serves it, since when, its products with their state, the note,
 * the discounts and courtesies with their reason, and how much has been paid. Each product goes at
 * its price before discounts (what is left after voids) and the discounts are subtracted once,
 * below: the lines minus the discounts are the total.
 */
export function OrderDetail({
  order: p,
  place,
  users,
  time,
  timeZone,
  titled = false,
}: {
  order: VisibleOrder
  place: FloorPlace
  users: Record<string, string>
  time: LiveTime
  timeZone: string
  /** With several orders on the same table, each one says its name. */
  titled?: boolean
}) {
  const s = p.status
  const v = STATUSES[tableStatus([p])]
  const totals = orderTotals(s)
  const items = currentItems(s)
  const voided = Object.values(s.items)
    .filter((i) => i.voidedQuantity > 0)
    .sort((a, b) => a.position - b.position)
  const discounts = Object.values(s.discounts)
  const nameOf = (id: string) => users[id] ?? 'Alguien'
  const payments = Object.values(s.payments).filter((m) => !m.voided)
  const charged = payments.reduce((a, m) => a + m.amount, 0)
  const refunded = payments.reduce((a, m) => a + m.refundedSale, 0)
  return (
    <article aria-label={orderName(place, p)} className="flex flex-col gap-4">
      {titled && <h3 className="text-lg font-semibold">{orderName(place, p)}</h3>}
      <span className="self-start">
        <Label tone={v.tone} icon={v.icon} main>
          {v.text}
        </Label>
      </span>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted">Mesero</dt>
        <dd>{nameOf(s.assignedWaiterId)}</dd>
        <dt className="text-muted">Comensales</dt>
        <dd className="figures">{s.guests}</dd>
        <dt className="text-muted">Abierto</dt>
        <dd className="figures">
          {`${timeOf(s.openedAt, timeZone)} · ${at(minutes(elapsed(s.openedAt, time)), time)}`}
        </dd>
        {s.dayNumber !== null && (
          <>
            <dt className="text-muted">Pedido</dt>
            <dd className="figures">{`n.º ${s.dayNumber}`}</dd>
          </>
        )}
      </dl>

      {s.notes && (
        <p className="flex items-start gap-2 rounded-lg border-2 border-border bg-surface px-3 py-2">
          <Icon name="pencil" className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="block text-sm font-semibold uppercase">Nota del pedido</span>
            {s.notes}
          </span>
        </p>
      )}

      <section aria-label="Productos" className="flex flex-col gap-2">
        <h4 className="font-semibold">Productos</h4>
        {items.length === 0 ? (
          <p className="text-muted">Sin productos todavía.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-divider">
            {items.map((i) => {
              const count = i.quantity - i.voidedQuantity
              return (
                <li key={i.id} className="flex items-start justify-between gap-3 py-2">
                  <span className="flex flex-col">
                    <span>
                      <span className="figures font-semibold">{`${count} ×`}</span> {i.name}
                      {i.guest !== null && (
                        <span className="text-sm text-muted">{` · persona ${i.guest}`}</span>
                      )}
                    </span>
                    {i.modifiers.length > 0 && (
                      <span className="text-sm">{i.modifiers.map((m) => m.name).join(', ')}</span>
                    )}
                    {i.notes && <span className="text-sm font-semibold">{i.notes}</span>}
                    <span className="text-sm text-muted">{ITEM_STATUS[i.status]}</span>
                  </span>
                  {/* Before discounts: they are subtracted below, once. */}
                  <span className="figures shrink-0 font-semibold">
                    {pesos(count * pricePerUnit(i))}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {voided.length > 0 && (
        <section aria-label="Anulados" className="flex flex-col gap-1">
          <h4 className="font-semibold">Anulados</h4>
          <ul className="text-sm text-muted">
            {voided.map((i) => (
              <li key={i.id} className="figures">{`${i.voidedQuantity} × ${i.name}`}</li>
            ))}
          </ul>
        </section>
      )}

      {discounts.length > 0 && (
        <section aria-label="Descuentos y cortesías" className="flex flex-col gap-1">
          <h4 className="font-semibold">Descuentos y cortesías</h4>
          <ul className="flex flex-col gap-1">
            {discounts.map((d) => {
              const amount = Object.values(d.amounts).reduce((a, n) => a + n, 0)
              const on =
                d.scope === 'item'
                  ? Object.keys(d.amounts)
                      .map((id) => s.items[id]?.name)
                      .filter(Boolean)
                      .join(', ')
                  : 'todo el pedido'
              return (
                <li key={d.id} className="flex items-start justify-between gap-3">
                  <span>
                    {`${d.rule === 'comp' ? 'Cortesía' : 'Descuento'} en ${on}`}
                    {d.reason && <span className="block text-sm text-muted">{d.reason}</span>}
                  </span>
                  <span className="figures shrink-0">{pesos(-amount)}</span>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <dl className="figures grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t border-divider pt-3">
        {totals.discount > 0 && (
          <>
            <dt>Subtotal</dt>
            <dd className="text-right">{pesos(totals.net + totals.discount)}</dd>
            <dt>Descuentos</dt>
            <dd className="text-right">{pesos(-totals.discount)}</dd>
          </>
        )}
        <dt className="font-semibold">Total</dt>
        <dd className="text-right text-lg font-bold">{pesos(totals.net)}</dd>
        {refunded > 0 && (
          <>
            <dt>Cobrado</dt>
            <dd className="text-right">{pesos(charged)}</dd>
            <dt>Devuelto</dt>
            <dd className="text-right">{pesos(-refunded)}</dd>
          </>
        )}
        <dt>Pagado</dt>
        <dd className="text-right">{pesos(totals.paid)}</dd>
        {totals.tips > 0 && (
          <>
            <dt>Propinas</dt>
            <dd className="text-right">{pesos(totals.tips)}</dd>
          </>
        )}
        {totals.roundingAdjustments !== 0 && (
          <>
            <dt>Redondeo del efectivo</dt>
            <dd className="text-right">
              {`${totals.roundingAdjustments > 0 ? '+' : ''}${pesos(totals.roundingAdjustments)}`}
            </dd>
          </>
        )}
        <dt>{totals.balance < 0 ? 'Pagado de más' : 'Falta por pagar'}</dt>
        <dd className="text-right font-semibold">{pesos(Math.abs(totals.balance))}</dd>
      </dl>
    </article>
  )
}
