import { type Delay, delay } from '@pos/sync/views'
import { useMemo, useState } from 'react'
import { DELAYS, KitchenCard, ticketTarget } from '../floor/KitchenCard'
import { Icon } from '../ui/icons'
import { SOFT_TONES } from '../ui/Label'
import { useNow } from '../ui/now'
import { Group, Option } from '../ui/Options'
import type { PanelApi } from './api'
import { DataStatus, FirstAnswer } from './DataStatus'
import { type FloorAnswer, floorState, kitchenOf, placeOf, visibleOrders } from './live-floor'
import { FrozenTimes, useLiveFloor } from './PanelFloor'
import type { Polled } from './summary'

// «Cocina» in the owner's panel (task 1.11c-2): what was sent and not yet delivered, by station,
// with its time and color as the kitchen screen shows it, and what is ready to take to the table.
// Only to look: «Listo» is marked in the kitchen.

const ALL = '__all'

/** «1 producto», «3 productos» (in units, voided ones left out). */
const productCount = (items: readonly { quantity: number; voidedQuantity: number }[]) => {
  const n = items.reduce((s, i) => s + i.quantity - i.voidedQuantity, 0)
  return `${n} ${n === 1 ? 'producto' : 'productos'}`
}

export function PanelKitchen({
  api,
  timeZone,
}: {
  api: Pick<PanelApi, 'floor'>
  timeZone: string
}) {
  const polled = useLiveFloor(api)
  const deviceNow = useNow(15_000)
  return <KitchenView polled={polled} deviceNow={deviceNow} timeZone={timeZone} />
}

export function KitchenView({
  polled,
  deviceNow,
  timeZone,
  initialStation = ALL,
}: {
  polled: Polled<FloorAnswer>
  deviceNow: number
  timeZone: string
  initialStation?: string
}) {
  const [filter, setFilter] = useState(initialStation)
  const { state, time } = floorState(polled, deviceNow, timeZone)
  const data = polled.data
  const all = useMemo(() => (data ? kitchenOf(data, visibleOrders(data.orders)) : []), [data])
  const place = useMemo(() => (data ? placeOf(data) : null), [data])

  if (!data || !place)
    return (
      <div className="flex flex-col gap-4">
        <FirstAnswer
          polled={polled}
          reading="Leyendo lo de cocina…"
          failure="No se pudo leer la cocina."
        />
      </div>
    )

  const stations = place.stations
  const tickets = all.filter((c) => filter === ALL || c.stationId === filter)
  const inProgress = tickets.filter((c) => !c.list)
  const ready = tickets.filter((c) => c.list)
  const timers = data.timers
  const tally = (d: Delay) =>
    inProgress.filter((c) => delay(c.sentAt, time.now, timers) === d).length

  return (
    <div className="flex flex-col gap-4">
      <DataStatus state={state} shown onRetry={polled.retry} />

      {stations.length > 1 && (
        <Group label="Estación" className="flex flex-wrap gap-2">
          <Option selected={filter === ALL} onChoose={() => setFilter(ALL)}>
            Todas
          </Option>
          {stations.map((e) => (
            <Option key={e.id} selected={filter === e.id} onChoose={() => setFilter(e.id)}>
              {e.name}
            </Option>
          ))}
        </Group>
      )}

      <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm" aria-label="Cómo va de tiempo">
        {(Object.keys(DELAYS) as Delay[]).map((d) => (
          <li key={d} className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-semibold ${DELAYS[d].label}`}
            >
              <Icon name={DELAYS[d].icon} className="size-4" />
              {DELAYS[d].text}
            </span>
            <span className="figures text-muted">{tally(d)}</span>
          </li>
        ))}
        <li className="text-muted">
          {`Demorada desde ${timers.yellow} min, muy demorada desde ${timers.red} min`}
        </li>
      </ul>

      <FrozenTimes time={time} />

      {inProgress.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border p-8 text-center text-lg text-muted">
          Nada en cocina por ahora.
        </p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-4">
          {inProgress.map((c) => (
            <li key={c.key}>
              <KitchenCard
                catalog={place}
                ticket={c}
                now={time.now}
                timers={timers}
                large={false}
              />
            </li>
          ))}
        </ul>
      )}

      {ready.length > 0 && (
        <section aria-labelledby="title-ready" className="flex flex-col gap-3">
          <h2 id="title-ready" className="text-lg font-semibold">
            {`Listos para llevar (${ready.length})`}
          </h2>
          <ul className="flex flex-wrap gap-3">
            {ready.map((c) => (
              <li
                key={c.key}
                className={`flex min-h-14 items-center gap-3 rounded-2xl px-4 py-2 ${SOFT_TONES.free}`}
              >
                <Icon name="serve" />
                <span className="font-semibold">{ticketTarget(place, c)}</span>
                <span className="text-sm">{productCount(c.items)}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted">
            Salen de aquí cuando el mesero los entrega en la mesa.
          </p>
        </section>
      )}
    </div>
  )
}
