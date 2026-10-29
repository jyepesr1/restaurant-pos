import { useMemo, useState } from 'react'
import { Button } from '../ui/Button'
import { minutes } from '../ui/format'
import { Icon, type IconName } from '../ui/icons'
import { Label, type Tone } from '../ui/Label'
import { Group, Option } from '../ui/Options'
import { useNotify } from '../ui/toasts'
import { stationOf, type Table } from './data'
import { Frame } from './Frame'
import { changeTable, useNow, useTables } from './state'
import { DELAY_MINUTES, inPreparation, itemName, minutesSince, SERVICE_MINUTES } from './totals'

// Kitchen and bar screen (brief §4.4): one card per table and station. The time comes from the
// ticket's send time (the same on every screen). Green is kept for "ready": normal time is gray,
// attention amber and delay red, each with its text. Tapping an item marks it ready; "Todo listo"
// dispatches the ticket (with Deshacer) and notifies the waiter on the floor plan.

type Filter = 'todas' | 'cocina' | 'barra'

export function ticketAge(m: number): { tone: Tone; icon: IconName; text: string } {
  if (m >= DELAY_MINUTES) return { tone: 'warning', icon: 'warning', text: 'demora' }
  if (m >= SERVICE_MINUTES) return { tone: 'progress', icon: 'clock', text: 'atención' }
  return { tone: 'neutral', icon: 'clock', text: 'a tiempo' }
}

/** Dispatching marks that station's items; if nothing remains in preparation, the table is ready. */
function dispatch(table: Table, ids: ReadonlySet<string>): Table {
  const items = table.items.map((i) => (ids.has(i.id) ? { ...i, dispatched: true } : i))
  const hasRemaining = items.some((i) => !i.voided && i.sentAt !== null && !i.dispatched)
  return {
    ...table,
    items,
    status: hasRemaining || table.status !== 'in_kitchen' ? table.status : 'ready',
  }
}

export function Kds() {
  const tables = useTables()
  const now = useNow(5000)
  const notify = useNotify()
  const [filter, setFilter] = useState<Filter>('todas')
  const [readyIds, setReadyIds] = useState<Set<string>>(new Set())

  const tickets = useMemo(
    () =>
      tables
        // A table already closed (to clean or free) has nothing to prepare.
        .filter((table) => table.status !== 'dirty' && table.status !== 'free')
        .flatMap((table) =>
          (['cocina', 'barra'] as const).map((station) => {
            const items = inPreparation(table).filter(
              (i) => stationOf.get(i.product.key) === station,
            )
            const from = Math.min(...items.map((i) => i.sentAt as number))
            return { key: `${table.number}-${station}`, table, station, items, from }
          }),
        )
        .filter((c) => c.items.length > 0)
        .filter((c) => filter === 'todas' || c.station === filter)
        .sort((a, b) => a.from - b.from),
    [tables, filter],
  )

  const toggle = (id: string) =>
    setReadyIds((a) => {
      const b = new Set(a)
      if (b.has(id)) b.delete(id)
      else b.add(id)
      return b
    })

  return (
    <Frame title="Cocina y barra" user="Cocina">
      <div className="p-3">
        <Group label="Estación" className="mb-3 flex flex-wrap gap-2">
          {(['todas', 'cocina', 'barra'] as const).map((f) => (
            <Option key={f} selected={filter === f} onChoose={() => setFilter(f)}>
              <span className="text-lg capitalize">{f}</span>
            </Option>
          ))}
        </Group>
        {tickets.length === 0 && (
          <p className="p-10 text-center text-xl text-muted">No hay comandas pendientes.</p>
        )}
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {tickets.map((c) => {
            const m = minutesSince(c.from, now)
            const t = ticketAge(m)
            const all = c.items.every((i) => readyIds.has(i.id))
            return (
              <li key={c.key} className="flex flex-col rounded-2xl border border-border bg-surface">
                <div className="flex items-center justify-between gap-2 border-b border-border p-3">
                  <div>
                    <p className="font-heading text-3xl font-bold">Mesa {c.table.number}</p>
                    <p className="text-muted">
                      {c.table.waiter} · <span className="capitalize">{c.station}</span>
                    </p>
                  </div>
                  <Label tone={t.tone} icon={t.icon} main>
                    <span className="figures text-lg">{minutes(m)}</span>
                    <span className="text-sm">{t.text}</span>
                  </Label>
                </div>
                <ul className="flex-1">
                  {c.items.map((i) => {
                    const ready = readyIds.has(i.id)
                    return (
                      <li key={i.id}>
                        <button
                          type="button"
                          aria-pressed={ready}
                          onClick={() => toggle(i.id)}
                          className={`flex min-h-14 w-full items-start gap-3 border-b border-border px-3 py-2 text-left text-lg ${ready ? 'bg-free-soft text-free-text' : ''}`}
                        >
                          <span className="figures w-8 font-bold">{i.quantity}×</span>
                          <span className="flex-1">
                            <span className={`font-semibold ${ready ? 'line-through' : ''}`}>
                              {itemName(i)}
                            </span>
                            {i.options.length > 0 && (
                              <span className="block rounded bg-progress-soft px-1 font-bold text-progress-text">
                                {i.options.map((o) => o.name).join(' · ')}
                              </span>
                            )}
                            {i.notes && (
                              <span className="block font-bold text-alert-text">¡{i.notes}!</span>
                            )}
                            {i.guest && (
                              <span className="block text-base text-muted">P{i.guest}</span>
                            )}
                          </span>
                          {ready && <Icon name="check" />}
                          <span className="sr-only">{ready ? 'listo' : 'pendiente'}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
                <div className="p-3">
                  <Button
                    variant={all ? 'success' : 'secondary'}
                    large
                    icon="check"
                    className="w-full"
                    onClick={() => {
                      const ids = new Set(c.items.map((i) => i.id))
                      changeTable(c.table.number, (table) => dispatch(table, ids))
                      notify(`Mesa ${c.table.number} despachada (${c.station})`, () =>
                        changeTable(c.table.number, (table) => ({
                          ...table,
                          status: table.status === 'ready' ? 'in_kitchen' : table.status,
                          items: table.items.map((i) =>
                            ids.has(i.id) ? { ...i, dispatched: false } : i,
                          ),
                        })),
                      )
                    }}
                  >
                    Todo listo
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </Frame>
  )
}
