import { methodKeyOf } from '@pos/core'
import { useCallback } from 'react'
import { type CheckoutRules, methodName } from '../floor/checks'
import { periodInWords } from '../floor/periods'
import { pesos } from '../ui/format'
import { Icon } from '../ui/icons'
import { SOFT_TONES } from '../ui/Label'
import type { PanelApi, Summary } from './api'
import { usePolling } from './poller'
import { type Comparison, compare, dataState, EVERY_MS, type Polled, weekdayOf } from './summary'

// Today's dashboard (task 1.11c-1): today's sales up to now against the same weekday last week
// up to the same time, and from when the data is. It asks every 15 s while it is in view.

/** What the dashboard needs to know about the restaurant. */
export interface Place {
  timeZone: string
  /** To name the restaurant's own payment methods. */
  rules: CheckoutRules | null
}

export function Dashboard({ api, place }: { api: Pick<PanelApi, 'summary'>; place: Place }) {
  const fetchSummary = useCallback(() => api.summary(), [api])
  const polled = usePolling(fetchSummary, EVERY_MS)
  return <DashboardView polled={polled} place={place} />
}

export function DashboardView({ polled, place }: { polled: Polled<Summary>; place: Place }) {
  const summary = polled.data
  const state = dataState(
    summary?.local ?? null,
    {
      failed: polled.failed,
      // Only a network failure is «sin conexión»; a closed session or a server error is not.
      cause: polled.errorKind && polled.errorKind !== 'offline' ? 'other' : 'offline',
      // «Cifras de las…»: the cloud's time in its last answer, not the phone's.
      receivedAt: summary?.server_now ?? polled.receivedAt,
      now: summary?.server_now ?? null,
    },
    place.timeZone,
  )

  return (
    <div className="flex flex-col gap-4">
      {/* Read aloud only when the state changes, not with every refresh of the time. */}
      <p aria-live="polite" className="sr-only">
        {summary || polled.failed ? state.announcement : ''}
      </p>
      {(summary || polled.failed) && (
        <div className="flex flex-col gap-2">
          <p
            className={`inline-flex items-center gap-2 self-start rounded-2xl px-3 py-1.5 text-sm font-semibold ${SOFT_TONES[state.tone]}`}
          >
            <Icon name={state.icon} className="shrink-0" />
            {state.text}
          </p>
          {state.pending && (
            <p className="inline-flex items-center gap-2 self-start rounded-2xl bg-progress-soft px-3 py-1.5 text-sm font-semibold text-progress-text">
              <Icon name="clock" className="shrink-0" />
              {state.pending}
            </p>
          )}
        </div>
      )}

      {!summary &&
        (polled.failed ? (
          <p className="rounded-2xl border border-alert-strong bg-alert-soft p-4 text-alert-text">
            {`${polled.error ?? 'No se pudieron leer las ventas.'} Lo intentamos de nuevo solos cada 15 s.`}
          </p>
        ) : (
          <p className="text-muted">Leyendo las ventas…</p>
        ))}

      {summary && <Today summary={summary} rules={place.rules} figuresAt={state.figuresAt} />}
    </div>
  )
}

/** The arrow and the percentage; never color alone. */
function Change({ change }: { change: Comparison }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ${SOFT_TONES[change.tone]}`}
    >
      {change.direction === 'up' && <Icon name="arrowUp" />}
      {change.direction === 'down' && <Icon name="arrowDown" />}
      {change.direction === 'same' && <Icon name="minus" />}
      {change.percent}
    </span>
  )
}

function Today({
  summary,
  rules,
  figuresAt,
}: {
  summary: Summary
  rules: CheckoutRules | null
  /** The time the figures are from, when they are not current. */
  figuresAt: string | null
}) {
  const v = summary.report.sales
  const before = summary.last_week.report_until_now.sales
  const full = summary.last_week.report_full.sales
  const weekday = weekdayOf(summary.last_week.day)
  const sales = compare(v.net, before.net)
  const noSales = v.net === 0 && v.checks === 0 && summary.report.byMethod.length === 0
  const until = figuresAt ? `hasta las ${figuresAt}` : 'hasta ahora'

  return (
    <>
      <p className="text-lg font-semibold first-letter:uppercase">
        {periodInWords({ from: summary.today, until: summary.today })}
      </p>

      <section
        aria-label="Ventas de hoy"
        className="flex flex-col gap-2 rounded-2xl border border-action-strong bg-action-soft p-4 md:p-5"
      >
        <h2 className="text-sm text-action-text">{`Ventas ${until}`}</h2>
        <p className="figures text-4xl font-bold tracking-tight">{pesos(v.net)}</p>
        {sales.direction === 'new' ? (
          <p className="text-sm">{`Ese ${weekday} a esta hora no había ventas`}</p>
        ) : (
          <p className="flex flex-wrap items-center gap-2">
            <Change change={sales} />
            <span className="text-sm">{`frente al ${weekday} pasado a esta hora`}</span>
          </p>
        )}
        <p className="figures text-sm text-muted first-letter:uppercase">
          {`${weekday} pasado a esta hora: ${pesos(before.net)} · ese día cerró en ${pesos(full.net)}`}
        </p>
      </section>

      {noSales && (
        <p className="rounded-2xl border border-divider bg-surface p-4 text-muted">
          Todavía no hay cuentas cerradas hoy.
        </p>
      )}

      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Figure
          name="Ticket promedio"
          value={pesos(v.averageTicket)}
          before={pesos(before.averageTicket)}
          change={compare(v.averageTicket, before.averageTicket)}
          weekday={weekday}
        />
        <Figure
          name="Comensales"
          value={String(v.guests)}
          before={String(before.guests)}
          change={compare(v.guests, before.guests)}
          weekday={weekday}
        />
        <Figure
          name="Propinas"
          value={pesos(v.tips)}
          before={pesos(before.tips)}
          change={compare(v.tips, before.tips)}
          weekday={weekday}
        />
        <Figure
          name="Cuentas cerradas"
          value={String(v.checks)}
          before={String(before.checks)}
          change={compare(v.checks, before.checks)}
          weekday={weekday}
        />
      </dl>

      <section
        aria-label="Por medio de pago"
        className="flex flex-col rounded-2xl border border-divider bg-surface p-4"
      >
        <h2 className="mb-3 text-lg font-semibold">Por medio de pago</h2>
        {summary.report.byMethod.length === 0 ? (
          <p className="text-muted">Sin pagos todavía.</p>
        ) : (
          <dl className="figures grid grid-cols-[1fr_auto] gap-x-4 gap-y-2">
            {summary.report.byMethod.map((m) => (
              <div key={methodKeyOf(m)} className="contents">
                <dt>
                  {methodName(m.method, m.customMethodId, rules)}
                  <span className="block text-sm text-muted">
                    {`${m.payments} ${m.payments === 1 ? 'pago' : 'pagos'}`}
                  </span>
                </dt>
                <dd className="text-right font-semibold">
                  {pesos(m.sale)}
                  {m.tip !== 0 && (
                    <span className="block text-sm font-normal text-muted">
                      {`+ propina ${pesos(m.tip)}`}
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </>
  )
}

function Figure({
  name,
  value,
  before,
  change,
  weekday,
}: {
  name: string
  value: string
  before: string
  change: Comparison
  weekday: string
}) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl border border-divider bg-surface p-4">
      <dt className="text-sm text-muted">{name}</dt>
      <dd className="figures text-2xl font-bold tracking-tight sm:text-3xl">{value}</dd>
      <dd className="figures text-sm text-muted first-letter:uppercase">
        {`${weekday} pasado a esta hora: ${before}`}
      </dd>
      {change.direction !== 'new' && (
        <dd>
          <Change change={change} />
        </dd>
      )}
    </div>
  )
}
