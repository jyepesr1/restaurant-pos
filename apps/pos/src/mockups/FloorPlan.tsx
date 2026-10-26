import { useState } from 'react'
import { Button } from '../ui/Button'
import { minutes, pesos } from '../ui/format'
import { Icon, type IconName } from '../ui/icons'
import { Label, SOFT_TONES, type Tone } from '../ui/Label'
import { navigate } from '../ui/route'
import { useNotify } from '../ui/toasts'
import { freeTable, type Table, type TableStatus } from './data'
import { Frame } from './Frame'
import { changeTable, useNow, useTables } from './state'
import { DELAY_MINUTES, longestWait, minutesSince, tableBalance } from './totals'

// Floor plan: the waiter's home screen (brief §5, rule 1). A tap on a free table goes straight
// to order entry: tap table → tap products → Enviar. The table becomes occupied when the first
// product is added, not when it is opened: if it was opened by mistake, it is not taken.

interface Visible {
  tone: Tone
  icon: IconName
  text: string
}

export const STATUSES: Record<TableStatus, Visible> = {
  free: { tone: 'free', icon: 'circle', text: 'Libre' },
  taking: { tone: 'progress', icon: 'pencil', text: 'Tomando pedido' },
  in_kitchen: { tone: 'progress', icon: 'fire', text: 'En preparación' },
  ready: { tone: 'free', icon: 'serve', text: 'Listo para servir' },
  preBill: { tone: 'neutral', icon: 'receipt', text: 'Por cobrar' },
  reserved: { tone: 'neutral', icon: 'calendar', text: 'Reservada' },
  dirty: { tone: 'neutral', icon: 'broom', text: 'Por limpiar' },
}

/** The status shown: a ticket that has been in preparation for 20 min or more is a delay. */
export function visibleStatus(table: Table, now: number): Visible {
  if (table.status === 'in_kitchen' && longestWait(table, now) >= DELAY_MINUTES)
    return { tone: 'warning', icon: 'warning', text: 'Demora' }
  return STATUSES[table.status]
}

const ACTIVE_TABLE_STATUSES: readonly TableStatus[] = ['taking', 'in_kitchen', 'ready', 'preBill']
const active = (m: Table) => ACTIVE_TABLE_STATUSES.includes(m.status)

/** Free ones are shown in white: that way the ones needing attention stand out. */
const tableClass = (table: Table, v: Visible) =>
  table.status === 'free'
    ? 'border-borde bg-superficie text-libre-texto'
    : v.tone === 'warning'
      ? `border-alerta-fuerte ${SOFT_TONES.warning}`
      : `border-transparent ${SOFT_TONES[v.tone]}`

export function FloorPlan() {
  const tables = useTables()
  const now = useNow()
  const notify = useNotify()
  const [view, setView] = useState<'floorPlan' | 'list'>('floorPlan')

  const tap = (table: Table) => {
    if (table.status === 'dirty') {
      changeTable(table.number, () => freeTable(table.number))
      notify(`Mesa ${table.number} lista para usar`, () => changeTable(table.number, () => table))
      return
    }
    navigate(
      table.status === 'preBill'
        ? `/mockups/pre-bill?table=${table.number}`
        : `/mockups/order?table=${table.number}`,
    )
  }

  const openHandles = tables.filter(active)
  const count = (...statuses: TableStatus[]) =>
    tables.filter((m) => statuses.includes(m.status)).length

  return (
    <Frame
      title="Salón"
      actions={
        <Button
          variant="secondary"
          icon={view === 'floorPlan' ? 'list' : 'floorPlan'}
          onClick={() => setView(view === 'floorPlan' ? 'list' : 'floorPlan')}
        >
          {view === 'floorPlan' ? 'Lista' : 'Plano'}
        </Button>
      }
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-4 p-3 md:flex-row">
        <section className="flex-1" aria-label="Mesas">
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            <Label tone="free" icon="circle">{`${count('free')} libres`}</Label>
            <Label tone="progress" icon="fire">
              {`${count('taking', 'in_kitchen')} atendiendo`}
            </Label>
            <Label tone="free" icon="serve">{`${count('ready')} para servir`}</Label>
            <Label tone="neutral" icon="receipt">{`${count('preBill')} por cobrar`}</Label>
          </div>
          {view === 'floorPlan' ? (
            <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5">
              {tables.map((table) => (
                <li key={table.number}>
                  <TableOnFloorPlan table={table} now={now} onTap={() => tap(table)} />
                </li>
              ))}
            </ul>
          ) : (
            <ul className="flex flex-col gap-2">
              {tables.map((table) => (
                <li key={table.number}>
                  <TableInList table={table} now={now} onTap={() => tap(table)} />
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Register and tablet: plan + open checks (brief §5, rule 1). */}
        <aside className="hidden w-72 shrink-0 md:block" aria-label="Cuentas abiertas">
          <h2 className="mb-2 text-lg font-semibold">Cuentas abiertas</h2>
          <ul className="flex flex-col gap-2">
            {openHandles.map((table) => (
              <li key={table.number}>
                <button
                  type="button"
                  onClick={() => navigate(`/mockups/pre-bill?table=${table.number}`)}
                  className="flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border border-borde bg-superficie px-4 text-left hover:bg-superficie-2"
                >
                  <span>
                    <span className="font-semibold">Mesa {table.number}</span>
                    <span className="block text-sm text-texto-suave">
                      {visibleStatus(table, now).text}
                    </span>
                  </span>
                  <span className="cifras font-semibold">{pesos(tableBalance(table))}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </Frame>
  )
}

const detail = (table: Table, now: number) =>
  [
    table.waiter,
    `${table.guests} ${table.guests === 1 ? 'persona' : 'personas'}`,
    minutes(minutesSince(table.openedAt, now)),
  ]
    .filter(Boolean)
    .join(' · ')

function TableOnFloorPlan({ table, now, onTap }: { table: Table; now: number; onTap: () => void }) {
  const v = visibleStatus(table, now)
  const takenPath = active(table)
  const elapsed = minutes(minutesSince(table.openedAt, now))
  return (
    <button
      type="button"
      onClick={onTap}
      aria-label={`Mesa ${table.number}: ${v.text}${takenPath ? `, ${elapsed}, ${pesos(tableBalance(table))}` : ''}`}
      className={`flex aspect-square w-full flex-col justify-between rounded-2xl border-2 p-2 text-left transition active:scale-95 focus-visible:outline-3 focus-visible:outline-foco ${tableClass(table, v)}`}
    >
      <span className="flex items-start justify-between">
        <span className="font-titulo text-3xl font-bold leading-none">{table.number}</span>
        <Icon name={v.icon} />
      </span>
      <span className="text-sm leading-tight font-semibold">{v.text}</span>
      {takenPath && (
        <span className="cifras text-sm leading-tight">
          {elapsed}
          <br />
          {pesos(tableBalance(table))}
        </span>
      )}
    </button>
  )
}

function TableInList({ table, now, onTap }: { table: Table; now: number; onTap: () => void }) {
  const v = visibleStatus(table, now)
  return (
    <button
      type="button"
      onClick={onTap}
      className="flex min-h-16 w-full items-center gap-3 rounded-2xl border border-borde bg-superficie px-3 text-left hover:bg-superficie-2"
    >
      <span className="font-titulo w-10 text-center text-3xl font-bold">{table.number}</span>
      <span className="flex-1">
        <Label tone={v.tone} icon={v.icon}>
          {v.text}
        </Label>
        {active(table) && (
          <span className="mt-1 block text-sm text-texto-suave">{detail(table, now)}</span>
        )}
      </span>
      {active(table) && <span className="cifras font-semibold">{pesos(tableBalance(table))}</span>}
    </button>
  )
}
