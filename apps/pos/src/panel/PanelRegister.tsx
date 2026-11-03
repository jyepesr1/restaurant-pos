import { isLargeVariance, methodKeyOf } from '@pos/core'
import { useCallback } from 'react'
import { type CheckoutRules, methodName } from '../floor/checks'
import type { ReportClose } from '../floor/engine'
import { Variance } from '../floor/Variance'
import { pesos } from '../ui/format'
import { Label } from '../ui/Label'
import type { OpenRegister, PanelApi, RegisterAnswer } from './api'
import { DataStatus, FirstAnswer } from './DataStatus'
import { usePolling } from './poller'
import { dataState, EVERY_MS, type Polled, timeOf } from './summary'

// «Caja» in the owner's panel (task 1.11c-2): each register open right now, with who opened it,
// the cash there should be and what was charged by each method, and those closed today with what
// was counted and the variance. The cloud does not know a register's name: it goes by who opened
// it. Only to look: the register is opened and closed at the register.

/** What the screen needs to know about the restaurant. */
export interface RegisterPlace {
  timeZone: string
  rules: CheckoutRules | null
}

export function PanelRegister({
  api,
  place,
}: {
  api: Pick<PanelApi, 'register'>
  place: RegisterPlace
}) {
  const fetchRegister = useCallback(() => api.register(), [api])
  const polled = usePolling(fetchRegister, EVERY_MS)
  return <RegisterView polled={polled} place={place} />
}

/** «9:41 p. m.», or «25 de oct, 9:41 p. m.» if it was another calendar day. */
function when(iso: string, now: string, timeZone: string): string {
  const day = (t: string) =>
    new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short', timeZone }).format(
      new Date(t),
    )
  const time = timeOf(iso, timeZone)
  return day(iso) === day(now) ? time : `${day(iso)}, ${time}`
}

export function RegisterView({
  polled,
  place,
}: {
  polled: Polled<RegisterAnswer>
  place: RegisterPlace
}) {
  const data = polled.data
  const state = dataState(
    data?.local ?? null,
    {
      failed: polled.failed,
      cause: polled.errorKind && polled.errorKind !== 'offline' ? 'other' : 'offline',
      receivedAt: data?.server_now ?? polled.receivedAt,
      now: data?.server_now ?? null,
    },
    place.timeZone,
  )
  if (!data)
    return (
      <div className="flex flex-col gap-4">
        <FirstAnswer
          polled={polled}
          reading="Leyendo la caja…"
          failure="No se pudo leer la caja."
        />
      </div>
    )

  const who = (id: string) => data.users[id] ?? 'Alguien'
  const at = (iso: string) => when(iso, data.server_now, place.timeZone)
  return (
    <div className="flex flex-col gap-4">
      <DataStatus state={state} shown onRetry={polled.retry} />

      <section aria-labelledby="title-open" className="flex flex-col gap-3">
        <h2 id="title-open" className="text-lg font-semibold">
          {`Cajas abiertas (${data.open.length})`}
        </h2>
        {data.open.length === 0 ? (
          <p className="rounded-2xl border border-divider bg-surface p-4 text-muted">
            No hay cajas abiertas ahora.
          </p>
        ) : (
          <ul className="grid gap-4 lg:grid-cols-2">
            {data.open.map((o) => (
              <OpenCard key={o.shift_id} open={o} who={who} at={at} rules={place.rules} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="title-closed" className="flex flex-col gap-3">
        <h2 id="title-closed" className="text-lg font-semibold">
          {`Cerradas hoy (${data.closed.length})`}
        </h2>
        {data.closed.length === 0 ? (
          <p className="rounded-2xl border border-divider bg-surface p-4 text-muted">
            Ninguna caja se ha cerrado hoy.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {data.closed.map((c) => (
              <ClosedCard
                key={c.shiftId}
                closeout={c}
                threshold={data.threshold}
                who={who}
                at={at}
                rules={place.rules}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function OpenCard({
  open,
  who,
  at,
  rules,
}: {
  open: OpenRegister
  who: (id: string) => string
  at: (iso: string) => string
  rules: CheckoutRules | null
}) {
  const r = open.reconciliation
  const row = (name: string, value: number, sign: '+' | '-') =>
    value > 0 && (
      <div className="contents">
        <dt>{name}</dt>
        <dd className="text-right">{`${sign}${pesos(value)}`}</dd>
      </div>
    )
  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-divider bg-surface p-4">
      <p className="font-semibold">{`Abrió ${who(open.opened_by)} · ${at(open.opened_at)}`}</p>
      <dl className="figures grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
        <dt>Fondo inicial</dt>
        <dd className="text-right">{pesos(r.base)}</dd>
        {row('Efectivo cobrado (con propinas)', r.cash.charged, '+')}
        {row('Devoluciones', r.cash.refunds, '-')}
        {row('Entradas', r.cash.cashIn, '+')}
        {row('Salidas', r.cash.cashOut, '-')}
        {row('Pago de propinas', r.cash.tipPayouts, '-')}
        <dt className="font-semibold">Debería haber en efectivo</dt>
        <dd className="text-right text-lg font-bold">{pesos(r.cash.expected)}</dd>
      </dl>
      <div>
        <h3 className="font-semibold">Cobrado por medio</h3>
        {r.byMethod.length === 0 ? (
          <p className="text-muted">Sin cobros todavía.</p>
        ) : (
          <dl className="figures mt-1 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
            {r.byMethod.map((m) => (
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
      </div>
    </li>
  )
}

function ClosedCard({
  closeout: c,
  threshold,
  who,
  at,
  rules,
}: {
  closeout: ReportClose
  threshold: number
  who: (id: string) => string
  at: (iso: string) => string
  rules: CheckoutRules | null
}) {
  const closed = c.closed
  const large =
    isLargeVariance(closed.variance, threshold) ||
    closed.otherMethods.some((m) => isLargeVariance(m.variance, threshold))
  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-divider bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-col font-semibold">
          <span>{`Abrió ${who(c.openedBy)} · ${at(c.openedAt)}`}</span>
          <span>{`Cerró ${who(c.closedBy)} · ${at(closed.time)}`}</span>
        </p>
        {large && (
          <Label tone="warning" icon="warning">
            {/* «mayor a» would be wrong at exactly the threshold: it counts from it (isLargeVariance). */}
            {`Descuadre de ${pesos(Math.max(1, threshold))} o más`}
          </Label>
        )}
      </div>
      <dl className="figures grid grid-cols-3 gap-x-4 gap-y-1">
        <div>
          <dt className="text-sm text-muted">Fondo inicial</dt>
          <dd className="font-semibold">{pesos(c.base)}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted">Efectivo esperado</dt>
          <dd className="font-semibold">{pesos(closed.expected)}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted">Contado</dt>
          <dd className="font-semibold">{pesos(closed.counted)}</dd>
        </div>
      </dl>
      <ul className="figures flex flex-col gap-2">
        <li className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold">Efectivo</span>
          <Variance value={closed.variance} />
        </li>
        {closed.otherMethods.map((m) => (
          <li key={methodKeyOf(m)} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {methodName(m.method, m.customMethodId, rules)}
              <span className="block text-sm text-muted">
                {`Según el sistema ${pesos(m.expected)} · según su cierre ${pesos(m.reported)}`}
              </span>
            </span>
            <Variance value={m.variance} />
          </li>
        ))}
      </ul>
      {closed.justification && (
        <p className="border-t border-divider pt-2 text-sm">
          <span className="font-semibold">Justificación: </span>
          {closed.justification}
        </p>
      )}
    </li>
  )
}
