import { ALERT_TYPES, type AlertType } from '@pos/core'
import { useCallback, useEffect, useState } from 'react'
import type { CheckoutRules } from '../floor/checks'
import { addDays, shortDay } from '../floor/periods'
import { DOT } from '../floor/TablesView'
import { fieldClass } from '../ui/field'
import { Icon } from '../ui/icons'
import { SOFT_TONES } from '../ui/Label'
import { Group, Option } from '../ui/Options'
import { ALERT_KINDS, ALERT_LEGEND, alertText, kindLabel } from './alert-text'
import type { AlertsAnswer, PanelApi } from './api'
import { DataStatus, FirstAnswer } from './DataStatus'
import { usePolling } from './poller'
import { dataState, EVERY_MS, type Polled, timeOf, weekdayOf } from './summary'

// «Alertas» in the owner's panel (task 1.11c-2): what someone did that takes money away or changes
// what was charged (voids, cancellations, discounts and courtesies, voided payments, refunds,
// reopened orders and register variances), one sentence each, from the newest. By kind and by
// day, up to 14 days back.

/** How many days back the alerts can be seen (the cloud's `ALERT_DAYS`). */
export const ALERT_DAYS = 14

export interface AlertsPlace {
  timeZone: string
  rules: CheckoutRules | null
}

export function PanelAlerts({ api, place }: { api: Pick<PanelApi, 'alerts'>; place: AlertsPlace }) {
  // Null is today: the cloud says which day that is.
  const [day, setDay] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const fetchAlerts = useCallback(() => api.alerts(day), [api, day])
  const polled = usePolling(fetchAlerts, EVERY_MS)
  // A day the cloud no longer answers (it fell out of the 14 while the screen was open, or the
  // phone's date is off): back to today, saying so, instead of failing every 15 s.
  useEffect(() => {
    if (!outOfRange(polled, day)) return
    setDay(null)
    setNotice(DAY_OUT_OF_RANGE)
  }, [polled, day])
  return (
    <AlertsView
      polled={polled}
      place={place}
      day={day}
      notice={notice}
      onDay={(d) => {
        setNotice(null)
        setDay(d)
      }}
    />
  )
}

export const DAY_OUT_OF_RANGE = `Ese día ya no está entre los últimos ${ALERT_DAYS}: te mostramos las de hoy.`

/** The cloud said 400 for the day chosen: it is not among the days it answers. */
export const outOfRange = (polled: Polled<unknown>, day: string | null) =>
  day !== null && polled.failed && polled.errorKind === 'invalid'

/** «Hoy», «Ayer» or «jueves 22 de oct». */
export function dayName(day: string, today: string): string {
  if (day === today) return 'Hoy'
  if (day === addDays(today, -1)) return 'Ayer'
  return `${weekdayOf(day)} ${shortDay(day)}`
}

export function AlertsView({
  polled,
  place,
  day,
  onDay,
  initialKind = null,
  notice = null,
}: {
  polled: Polled<AlertsAnswer>
  place: AlertsPlace
  /** The day chosen (null: today). */
  day: string | null
  onDay: (day: string | null) => void
  initialKind?: AlertType | null
  /** Why it went back to today. */
  notice?: string | null
}) {
  const [kind, setKind] = useState<AlertType | null>(initialKind)
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
  // The answer is for another day than the one chosen while the new one arrives.
  const current = data && (day === null ? data.day === data.today : data.day === day) ? data : null

  return (
    <div className="flex flex-col gap-4">
      <DataStatus state={state} shown={Boolean(data)} onRetry={polled.retry} />

      {notice && (
        <p
          role="status"
          className="rounded-xl bg-progress-soft px-3 py-2 text-sm text-progress-text"
        >
          {notice}
        </p>
      )}

      {data && (
        <label className="flex flex-col gap-1 self-start">
          <span className="text-sm text-muted">Día</span>
          <select
            className={`${fieldClass} w-auto`}
            value={day ?? data.today}
            onChange={(e) => {
              setKind(null)
              onDay(e.target.value === data.today ? null : e.target.value)
            }}
          >
            {Array.from({ length: ALERT_DAYS + 1 }, (_, i) => addDays(data.today, -i)).map((d) => (
              <option key={d} value={d}>
                {dayName(d, data.today)}
              </option>
            ))}
          </select>
        </label>
      )}

      {!current ? (
        <FirstAnswer
          polled={polled}
          reading="Leyendo las alertas…"
          failure="No se pudieron leer las alertas."
        />
      ) : (
        <AlertList answer={current} place={place} kind={kind} onKind={setKind} />
      )}
    </div>
  )
}

function AlertList({
  answer,
  place,
  kind,
  onKind,
}: {
  answer: AlertsAnswer
  place: AlertsPlace
  kind: AlertType | null
  onKind: (kind: AlertType | null) => void
}) {
  const counts = new Map<AlertType, number>()
  for (const a of answer.alerts) counts.set(a.type, (counts.get(a.type) ?? 0) + 1)
  const kinds = ALERT_TYPES.filter((t) => counts.has(t))
  const shown = answer.alerts.filter((a) => kind === null || a.type === kind)
  const today = answer.day === answer.today
  const words = {
    users: answer.users,
    tables: answer.tables,
    rules: place.rules,
    time: (iso: string) => timeOf(iso, place.timeZone),
  }

  if (answer.alerts.length === 0)
    return (
      <p className="flex items-center gap-2 rounded-2xl border border-divider bg-surface p-4 text-muted">
        <Icon name="check" className="shrink-0 text-free-text" />
        {today ? 'Sin alertas hoy por ahora.' : 'Sin alertas ese día.'}
      </p>
    )

  return (
    <>
      <Group label="Tipo de alerta" className="flex flex-wrap gap-2">
        <Option selected={kind === null} onChoose={() => onKind(null)}>
          {`Todas (${answer.alerts.length})`}
        </Option>
        {kinds.map((t) => (
          <Option key={t} selected={kind === t} onChoose={() => onKind(t)}>
            {`${ALERT_KINDS[t].name} (${counts.get(t)})`}
          </Option>
        ))}
      </Group>

      <Legend />

      {shown.length === 0 ? (
        <p className="rounded-2xl border border-divider bg-surface p-4 text-muted">
          {`Sin ${ALERT_KINDS[kind as AlertType].name.toLowerCase()} ${today ? 'hoy' : 'ese día'}.`}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-divider rounded-2xl border border-divider bg-surface">
          {shown.map((a) => {
            const k = ALERT_KINDS[a.type]
            const t = alertText(a, words)
            return (
              <li key={a.id} className="flex gap-3 p-4">
                <span
                  className={`mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-full ${SOFT_TONES[k.tone]}`}
                >
                  <Icon name={k.icon} className="size-5" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="font-semibold">{t.sentence}</span>
                    <span className="figures text-sm text-muted">
                      {timeOf(a.time, place.timeZone)}
                    </span>
                  </p>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
                    <span
                      className={`rounded-full px-2 py-0.5 text-sm font-semibold ${SOFT_TONES[k.tone]}`}
                    >
                      {kindLabel(a)}
                    </span>
                    {t.details.length > 0 && <span>{t.details.join(' · ')}</span>}
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

/** What the two colors mean, said once above the list (never color alone: each row has its label). */
function Legend() {
  return (
    <ul aria-label="Colores" className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted">
      {(['warning', 'progress'] as const).map((tone) => (
        <li key={tone} className="flex items-center gap-2">
          <span aria-hidden="true" className={`size-3 rounded-full ${DOT[tone]}`} />
          {ALERT_LEGEND[tone]}
        </li>
      ))}
    </ul>
  )
}
