import type { Catalog } from '@pos/sync'
import type { ReactNode } from 'react'
import { minutes } from '../ui/format'
import { Icon, type IconName } from '../ui/icons'
import { SOFT_TONES, STRONG_TONES } from '../ui/Label'
import { CHANNELS } from './order'
import { type Delay, delay, type KitchenTicket } from './tickets'

// A kitchen card and how each delay looks, without the device's engine (task 1.11c-2): the
// register's «Pedidos en cocina», the kitchen screen and the owner's panel draw the same card.
// Each one brings its buttons (the panel, none).

/** What a card needs of the catalog: the hub's whole catalog, or the plan the cloud sends. */
export type KitchenPlace = Pick<Catalog, 'tables' | 'stations' | 'staff'>

/**
 * How each delay looks. «A tiempo» has no color, only a border (owner's decision): green in
 * the kitchen is reserved for «Listo para llevar», and what stands out is what is late.
 */
export const DELAYS: Record<
  Delay,
  { icon: IconName; text: string; card: string; clock: string; label: string }
> = {
  on_time: {
    icon: 'clock',
    text: 'A tiempo',
    card: 'border-border bg-surface text-foreground',
    clock: 'border-2 border-border bg-surface text-foreground',
    label: 'border-2 border-border bg-surface text-foreground',
  },
  late: {
    icon: 'clock',
    text: 'Demorada',
    card: `border-progress-strong/60 ${SOFT_TONES.progress}`,
    clock: STRONG_TONES.progress,
    label: SOFT_TONES.progress,
  },
  very_late: {
    icon: 'warning',
    text: 'Muy demorada',
    card: `border-alert-strong ${SOFT_TONES.warning}`,
    clock: STRONG_TONES.warning,
    label: SOFT_TONES.warning,
  },
}

export function ticketTarget(catalog: Pick<Catalog, 'tables'>, c: KitchenTicket): string {
  const p = c.order.status
  if (p.tableId) {
    const table = catalog.tables.find((m) => m.id === p.tableId)
    return table ? `Mesa ${table.name}` : 'Mesa'
  }
  const channel = CHANNELS[p.channel as keyof typeof CHANNELS] ?? 'Pedido'
  return p.dayNumber ? `${channel} #${p.dayNumber}` : channel
}

export function KitchenCard({
  catalog,
  ticket: c,
  now,
  timers,
  large,
  actions,
}: {
  catalog: KitchenPlace
  ticket: KitchenTicket
  now: number
  timers: { yellow: number; red: number }
  large: boolean
  actions?: ReactNode
}) {
  const d = DELAYS[delay(c.sentAt, now, timers)]
  const station = catalog.stations.find((e) => e.id === c.stationId)?.name
  const waiter = catalog.staff.find((u) => u.id === c.order.status.assignedWaiterId)?.name
  const from = Math.max(0, (now - Date.parse(c.sentAt)) / 60_000)
  return (
    <article
      aria-label={`${ticketTarget(catalog, c)}, ${d.text}, ${minutes(from)}`}
      className={`flex h-full flex-col gap-3 rounded-2xl border-2 p-4 ${d.card}`}
    >
      <header className="flex items-baseline justify-between gap-2">
        <span className={`font-bold ${large ? 'text-3xl' : 'text-xl'}`}>
          {ticketTarget(catalog, c)}
        </span>
        {c.number !== null && (
          <span className={`figures font-bold ${large ? 'text-3xl' : 'text-lg'}`}>#{c.number}</span>
        )}
      </header>
      <div className={`flex flex-wrap items-center gap-2 ${large ? 'text-lg' : 'text-sm'}`}>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full font-bold ${d.clock} ${large ? 'px-3 py-1 text-2xl' : 'px-2.5 py-0.5 text-sm'}`}
        >
          <Icon name={d.icon} className={large ? 'size-6' : 'size-4'} />
          <span className="figures">{minutes(from)}</span>
        </span>
        <span>{[station, waiter].filter(Boolean).join(' · ')}</span>
      </div>
      {c.order.status.notes && (
        <p
          className={`flex items-start gap-2 rounded-lg border-2 border-border bg-surface px-2 py-1 text-foreground ${large ? 'text-xl' : ''}`}
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
            <span className="figures font-bold">{i.quantity - i.voidedQuantity} ×</span>{' '}
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
                className={`mt-1 flex items-start gap-2 rounded-lg border-2 border-current bg-surface px-2 py-1 font-bold ${large ? 'text-xl' : ''}`}
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
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </article>
  )
}
