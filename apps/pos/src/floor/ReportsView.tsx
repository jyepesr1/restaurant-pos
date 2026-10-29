import { methodKeyOf } from '@pos/core'
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { fieldClass } from '../ui/field'
import { pesos } from '../ui/format'
import { Label } from '../ui/Label'
import { Group, Option } from '../ui/Options'
import { navigate } from '../ui/route'
import { useNotify } from '../ui/toasts'
import { type CheckoutRules, methodName, taxName } from './checks'
import type { PeriodReport, ReportClose } from './engine'
import {
  csvName,
  daysIn,
  type Period,
  percent,
  periodInWords,
  periodOf,
  pointsAsPercent,
  reportCsv,
  type Shortcut,
  shortDay,
} from './periods'
import { Variance } from './Variance'

// What the Reportes screen shows (task 1.9, docs/KPIS.md), without where the numbers come from:
// the register reads them from the hub and the owner's cloud panel (task 1.11c) from the cloud.
// It must not import the floor engine (`./context`): the panel has no local database.

/** Each shortcut with the most days it can cover (a month, 31). */
const SHORTCUTS: { value: Shortcut | 'range'; name: string; longest: number }[] = [
  { value: 'today', name: 'Hoy', longest: 1 },
  { value: 'yesterday', name: 'Ayer', longest: 1 },
  { value: 'week', name: 'Últimos 7 días', longest: 7 },
  { value: 'month', name: 'Este mes', longest: 31 },
  { value: 'lastMonth', name: 'Mes pasado', longest: 31 },
  { value: 'range', name: 'Otras fechas', longest: 1 },
]

/**
 * The shortcuts, and whether each always fits in `maxDays`: the cloud panel (14 days) shows the
 * months disabled, so it never asks for a period it would refuse. In the register (62) all fit.
 */
export const shortcutsFor = (maxDays: number) =>
  SHORTCUTS.map((a) => ({ ...a, disabled: a.longest > maxDays }))

/** Why a shortcut is disabled. */
export const longPeriodsSoon = (maxDays: number) =>
  `Los períodos de más de ${maxDays} días llegan pronto.`

/** How many products are shown before «Ver todos». */
const VISIBLE_PRODUCTS = 10

/** What is subtracted, with its sign («-$30.900»); at zero, «$0». */
const minus = (n: number) => (n === 0 ? pesos(0) : `-${pesos(n)}`)

const message = (e: unknown) => (e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.')

/** What is said when the chosen dates cover more days than allowed. */
export const tooLongMessage = (maxDays: number) => `Elige un período de ${maxDays} días o menos.`

/** Reprinting the Z report: only the register has it (the cloud panel has no printer). */
export interface Reprint {
  onReprint: (shiftId: string) => Promise<void>
  /** Whether whoever is signed in can pick the printer («Caja y pagos»). */
  canSelectPrinter: boolean
}

/** Without dates, today's business day according to whoever answers. */
export type FetchReport = (period: Period | null) => Promise<PeriodReport>

export interface ReportsState {
  shortcut: Shortcut | 'range'
  select: (value: Shortcut | 'range') => void
  /** The period requested (it may not have arrived yet); null is today. */
  requested: Period | null
  shown: { report: PeriodReport; period: Period } | null
  loading: boolean
  error: string | null
  load: (period: Period | null) => void
}

/** Loads the report of the chosen period; it starts with today's. */
export function useReports(fetchReport: FetchReport): ReportsState {
  const [shortcut, setShortcut] = useState<Shortcut | 'range'>('today')
  const [requested, setRequested] = useState<Period | null>(null)
  const [shown, setShown] = useState<{ report: PeriodReport; period: Period } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Only the latest request's response counts: a slow earlier one does not overwrite the new one.
  const latest = useRef(0)
  const fetcher = useRef(fetchReport)
  fetcher.current = fetchReport

  const load = useCallback((p: Period | null) => {
    const number = ++latest.current
    setRequested(p)
    setLoading(true)
    setError(null)
    fetcher
      .current(p)
      .then((r) => {
        if (number !== latest.current) return
        setShown({ report: r, period: p ?? { from: r.today, until: r.today } })
      })
      .catch((e) => {
        if (number === latest.current) setError(message(e))
      })
      .finally(() => {
        if (number === latest.current) setLoading(false)
      })
  }, [])
  useEffect(() => load(null), [load])

  const today = shown?.report.today ?? null
  const select = (value: Shortcut | 'range') => {
    setShortcut(value)
    if (value !== 'range' && today) load(periodOf(value, today))
  }
  return { shortcut, select, requested, shown, loading, error, load }
}

/** Downloads the shown report as CSV for Excel; returns the file name. */
export function downloadCsv(
  shown: { report: PeriodReport; period: Period },
  rules: CheckoutRules | null,
  restaurant: string,
): string {
  const { report, period } = shown
  const csv = reportCsv(report, period, rules, restaurant)
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = csvName(period)
  link.click()
  URL.revokeObjectURL(url)
  return csvName(period)
}

/** The period picker, the error with its retry and the report. */
export function ReportsBody({
  state,
  rules,
  maxDays,
  reprint,
}: {
  state: ReportsState
  rules: CheckoutRules | null
  maxDays: number
  reprint?: Reprint
}) {
  const { shortcut, select, shown, loading, error, load, requested } = state
  const today = shown?.report.today ?? null
  const shortcuts = shortcutsFor(maxDays)
  return (
    <>
      <Group label="Período" className="flex flex-wrap gap-2">
        {shortcuts.map((a) => (
          <Option
            key={a.value}
            selected={shortcut === a.value}
            onChoose={() => select(a.value)}
            disabled={a.disabled}
            describedBy={a.disabled ? 'reports-long-periods' : undefined}
          >
            {a.name}
          </Option>
        ))}
      </Group>
      {shortcuts.some((a) => a.disabled) && (
        <p id="reports-long-periods" className="-mt-2 text-sm text-muted">
          {longPeriodsSoon(maxDays)}
        </p>
      )}
      {shortcut === 'range' && today && (
        <DateRange
          today={today}
          initial={shown?.period ?? null}
          shown={shown?.period ?? null}
          maxDays={maxDays}
          onView={(p) => load(p)}
        />
      )}

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-2xl border border-alert-strong bg-alert-soft p-4"
        >
          <p className="text-alert-text">
            {shown ? `${error} Abajo sigue lo de ${periodInWords(shown.period)}.` : error}
          </p>
          <Button onClick={() => load(requested)}>Intentar de nuevo</Button>
        </div>
      )}
      {!shown && !error && <p className="text-muted">Leyendo las ventas…</p>}
      {shown && (
        <ReportContent
          report={shown.report}
          period={shown.period}
          loading={loading}
          rules={rules}
          reprint={reprint}
        />
      )}
    </>
  )
}

/** From and to: loads on its own when a date changes (both must be filled in). */
function DateRange({
  today,
  initial,
  shown,
  maxDays,
  onView,
}: {
  today: string
  initial: Period | null
  /** The period whose figures are below: said when the chosen one is not valid. */
  shown: Period | null
  maxDays: number
  onView: (p: Period) => void
}) {
  const [from, setFrom] = useState(initial?.from ?? today)
  const [until, setUntil] = useState(initial?.until ?? today)
  const [tooLong, setTooLong] = useState(false)
  const show = (d: string, h: string) => {
    if (!d || !h) return
    const period = d <= h ? { from: d, until: h } : { from: h, until: d }
    // Asked here, not to the server: the message is clear and nothing is loaded in vain.
    const long = daysIn(period) > maxDays
    setTooLong(long)
    if (!long) onView(period)
  }
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    show(from, until)
  }
  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-sm text-muted">Desde</span>
        <input
          type="date"
          className={`${fieldClass} w-auto`}
          value={from}
          max={today}
          required
          onChange={(e) => {
            setFrom(e.target.value)
            show(e.target.value, until)
          }}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm text-muted">Hasta</span>
        <input
          type="date"
          className={`${fieldClass} w-auto`}
          value={until}
          max={today}
          required
          onChange={(e) => {
            setUntil(e.target.value)
            show(from, e.target.value)
          }}
        />
      </label>
      <p
        role={tooLong ? 'alert' : undefined}
        className={`pb-3 text-sm ${tooLong ? 'font-semibold text-alert-text' : 'text-muted'}`}
      >
        {tooLong
          ? `${tooLongMessage(maxDays)}${shown ? ` Abajo siguen las cifras de ${periodInWords(shown)}.` : ''}`
          : `Hasta ${maxDays} días.`}
      </p>
    </form>
  )
}

export function ReportContent({
  report,
  period,
  loading,
  rules,
  reprint,
}: {
  report: PeriodReport
  period: Period
  loading: boolean
  rules: CheckoutRules | null
  reprint?: Reprint
}) {
  const { report: summary, users } = report
  const v = summary.sales
  const who = (id: string | null) => (id ? (users[id] ?? 'Alguien') : '')
  const noSales = v.net === 0 && v.checks === 0 && summary.byMethod.length === 0
  return (
    <div aria-busy={loading} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="font-heading text-2xl font-bold tracking-tight first-letter:uppercase">
          {periodInWords(period)}
        </h2>
        {loading && <p className="text-sm text-muted">Actualizando…</p>}
      </div>

      <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <Figure name="Ventas" value={pesos(v.net)} highlighted />
        <Figure name="Cuentas" value={String(v.checks)} />
        <Figure name="Ticket promedio" value={pesos(v.averageTicket)} />
        <Figure
          name="Comensales"
          value={String(v.guests)}
          detail={v.guests > 0 ? `${pesos(v.spendPerGuest)} por persona` : undefined}
        />
        <Figure name="Propinas" value={pesos(v.tips)} />
      </dl>

      {noSales && (
        <p className="rounded-2xl border border-divider bg-surface p-4 text-muted">
          No hay ventas cerradas en este período.
        </p>
      )}

      <Card title="Cierres de caja">
        {report.closings.length === 0 ? (
          <EmptyState>Ninguna caja se cerró en este período.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-3">
            {report.closings.map((c) => (
              <Closeout
                key={c.shiftId}
                closeout={c}
                many={period.from !== period.until}
                who={who}
                rules={rules}
                reprint={reprint && { ...reprint, printer: report.printer }}
              />
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Ventas">
          <Rows>
            <Row name="Bruto" value={pesos(v.gross)} />
            {v.voided > 0 && <Row name="Productos anulados" value={minus(v.voided)} />}
            {v.discounts > 0 && <Row name="Descuentos" value={minus(v.discounts)} />}
            <Row name="Ventas" value={pesos(v.net)} main />
            {v.roundingAdjustments !== 0 && (
              <Row name="Ajuste por redondeo del efectivo" value={pesos(v.roundingAdjustments)} />
            )}
            {v.taxes.length > 0 && (
              <Row
                name="Base sin impuestos"
                value={pesos(v.taxes.reduce((a, i) => a + i.base, 0))}
              />
            )}
            {v.taxes
              .filter((i) => i.tax > 0)
              .map((i) => (
                <Row
                  key={`${i.type}${i.rate}`}
                  name={taxName(i.type, i.rate)}
                  value={pesos(i.tax)}
                />
              ))}
          </Rows>
          <Note>Impuestos informativos: valídalos con tu contador.</Note>
        </Card>

        <Card title="Por medio de pago">
          {summary.byMethod.length === 0 ? (
            <EmptyState>Sin pagos en este período.</EmptyState>
          ) : (
            <Rows>
              {summary.byMethod.map((m) => (
                <Row
                  key={methodKeyOf(m)}
                  name={`${methodName(m.method, m.customMethodId, rules)}${m.payments > 0 ? ` · ${m.payments} ${m.payments === 1 ? 'pago' : 'pagos'}` : ''}`}
                  value={pesos(m.sale)}
                  detail={m.tip !== 0 ? `+ propina ${pesos(m.tip)}` : undefined}
                />
              ))}
            </Rows>
          )}
          <Note>Cuenta los pagos el día en que se cobraron, aunque la mesa cierre otro día.</Note>
        </Card>

        <Card title="Por mesero">
          {summary.byWaiter.length === 0 ? (
            <EmptyState>Sin ventas en este período.</EmptyState>
          ) : (
            <DataTable
              columns={['Mesero', 'Ventas', 'Cuentas', 'Ticket']}
              rows={summary.byWaiter.map((m) => ({
                key: m.userId,
                cells: [who(m.userId), pesos(m.net), String(m.checks), pesos(m.averageTicket)],
              }))}
            />
          )}
          <Note>Las propinas van al fondo común: no se reparten por mesero.</Note>
        </Card>

        <Products report={report} />

        <Card title="Anulaciones y cancelaciones">
          {summary.voids.length === 0 && summary.cancellations.length === 0 ? (
            <EmptyState>Nada anulado ni cancelado.</EmptyState>
          ) : (
            <ul className="flex flex-col divide-y divide-divider">
              {summary.voids.map((a) => (
                <EventItem
                  key={a.eventId}
                  title={`${a.units} × ${a.name}`}
                  value={pesos(a.value)}
                  reason={a.reason}
                  detail={[
                    a.orderNumber ? `Pedido ${a.orderNumber}` : null,
                    who(a.userId),
                    a.authorizedById && a.authorizedById !== a.userId
                      ? `autorizó ${who(a.authorizedById)}`
                      : null,
                  ]}
                  label={
                    a.alreadyPrepared ? (
                      <Label tone="warning" icon="fire">
                        Ya preparado (merma)
                      </Label>
                    ) : null
                  }
                />
              ))}
              {summary.cancellations.map((c) => (
                <EventItem
                  key={c.eventId}
                  title={c.orderNumber ? `Pedido ${c.orderNumber} cancelado` : 'Pedido cancelado'}
                  value={pesos(c.value)}
                  reason={c.reason}
                  detail={[
                    who(c.userId),
                    c.authorizedById && c.authorizedById !== c.userId
                      ? `autorizó ${who(c.authorizedById)}`
                      : null,
                  ]}
                  label={null}
                />
              ))}
            </ul>
          )}
          <Note>Cada anulación cuenta el día en que se hizo.</Note>
        </Card>

        <Card title="Descuentos y cortesías">
          {summary.discounts.length === 0 ? (
            <EmptyState>Sin descuentos en este período.</EmptyState>
          ) : (
            <ul className="flex flex-col divide-y divide-divider">
              {summary.discounts.map((d, i) => (
                <EventItem
                  // biome-ignore lint/suspicious/noArrayIndexKey: an order can have several identical discounts
                  key={`${d.orderId}${i}`}
                  title={
                    d.rule === 'comp'
                      ? 'Cortesía'
                      : d.rule === 'percent'
                        ? `Descuento del ${pointsAsPercent(d.value)}`
                        : 'Descuento por valor'
                  }
                  value={pesos(d.amount)}
                  reason={d.reason}
                  detail={[d.orderNumber ? `Pedido ${d.orderNumber}` : null]}
                  label={null}
                />
              ))}
            </ul>
          )}
        </Card>

        <Card title="Fondo de propinas">
          <Rows>
            <Row name="Propinas cobradas" value={pesos(summary.tipPool.tips)} />
            <Row name="Pagadas desde la caja" value={minus(summary.tipPool.paidOut)} />
            <Row name="Saldo del período" value={pesos(summary.tipPool.balance)} main />
          </Rows>
          <Note>
            Entra la propina de cada pago cobrado en el período y sale lo que se entregó al equipo
            desde la caja.
          </Note>
        </Card>
      </div>
    </div>
  )
}

function Products({ report }: { report: PeriodReport }) {
  const [all, setAll] = useState(false)
  const { byProduct } = report.report
  const net = report.report.sales.net
  const visibleProducts = all ? byProduct : byProduct.slice(0, VISIBLE_PRODUCTS)
  return (
    <Card title="Por producto">
      {byProduct.length === 0 ? (
        <EmptyState>Sin productos vendidos.</EmptyState>
      ) : (
        <>
          <DataTable
            columns={['Producto', 'Unidades', 'Ventas', '% de ventas']}
            // On the phone the units do not fit: they are in the CSV.
            hiddenOnPhone={[1]}
            rows={visibleProducts.map((p) => ({
              key: `${p.productId}${p.variantId ?? ''}`,
              cells: [p.name, String(p.units), pesos(p.net), percent(p.net, net)],
            }))}
          />
          {byProduct.length > VISIBLE_PRODUCTS && (
            <Button variant="ghost" className="mt-2 self-start" onClick={() => setAll(!all)}>
              {all ? 'Ver menos' : `Ver los ${byProduct.length} productos`}
            </Button>
          )}
        </>
      )}
    </Card>
  )
}

function Closeout({
  closeout: c,
  many,
  who,
  rules,
  reprint,
}: {
  closeout: ReportClose
  many: boolean
  who: (id: string) => string
  rules: CheckoutRules | null
  reprint: (Reprint & { printer: boolean }) | undefined
}) {
  const notify = useNotify()
  const [printing, setPrinting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const print = async () => {
    if (!reprint) return
    setPrinting(true)
    setFailure(null)
    try {
      await reprint.onReprint(c.shiftId)
      notify('El cierre de caja salió a la impresora')
    } catch (e) {
      setFailure(message(e))
    } finally {
      setPrinting(false)
    }
  }
  const closed = c.closed
  const time = (iso: string) =>
    new Intl.DateTimeFormat('es-CO', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: rules?.timeZone ?? 'America/Bogota',
    }).format(new Date(iso))
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-divider bg-surface-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">
          {`${many ? `${shortDay(c.businessDay)} · ` : ''}Abrió ${who(c.openedBy)} ${time(c.openedAt)} · Cerró ${who(c.closedBy)} ${time(closed.time)}`}
        </p>
        <span className="flex items-center gap-2">
          <span className="text-sm text-muted">Efectivo</span>
          <Variance value={closed.variance} />
        </span>
      </div>
      <dl className="figures grid grid-cols-3 gap-x-4 gap-y-1">
        <DataPoint name="Base" value={pesos(c.base)} />
        <DataPoint name="Efectivo esperado" value={pesos(closed.expected)} />
        <DataPoint name="Contado" value={pesos(closed.counted)} />
      </dl>
      {closed.otherMethods.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {closed.otherMethods.map((m) => (
            <li key={methodKeyOf(m)} className="figures flex flex-wrap justify-between gap-x-3">
              <span>{methodName(m.method, m.customMethodId, rules)}</span>
              <span className="text-muted">
                {`Según el sistema ${pesos(m.expected)} · Según su cierre ${pesos(m.reported)}`}
                {m.variance !== 0 &&
                  ` · ${m.variance > 0 ? 'Sobran' : 'Faltan'} ${pesos(Math.abs(m.variance))}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {closed.justification && (
        <p className="text-sm">
          <span className="font-semibold">Justificación: </span>
          {closed.justification}
        </p>
      )}
      {reprint && (
        <div className="flex flex-wrap items-center gap-3">
          {reprint.printer ? (
            <Button icon="printer" onClick={print} disabled={printing}>
              {printing ? 'Imprimiendo…' : 'Reimprimir cierre'}
            </Button>
          ) : reprint.canSelectPrinter ? (
            <>
              <Button icon="printer" onClick={() => navigate('/register/settings')}>
                Elegir impresora
              </Button>
              <p className="text-sm text-muted">Para imprimir el cierre hace falta una.</p>
            </>
          ) : (
            <p className="text-sm text-muted">
              Para imprimir el cierre, pide al administrador que elija la impresora en «Caja y
              pagos».
            </p>
          )}
          {failure && (
            <p role="alert" className="text-sm text-alert-text">
              {failure}
            </p>
          )}
        </div>
      )}
    </li>
  )
}

// ── Pieces ─────────────────────────────────────────────────────────────

function Figure({
  name,
  value,
  detail,
  highlighted = false,
}: {
  name: string
  value: string
  detail?: string
  highlighted?: boolean
}) {
  return (
    <div
      className={`flex flex-col gap-1 rounded-2xl border p-4 ${
        highlighted
          ? 'col-span-2 border-action-strong bg-action-soft md:col-span-1'
          : 'border-divider bg-surface'
      }`}
    >
      <dt className={`text-sm ${highlighted ? 'text-action-text' : 'text-muted'}`}>{name}</dt>
      <dd className="figures text-2xl font-bold tracking-tight sm:text-3xl">{value}</dd>
      {detail && <dd className="figures text-sm text-muted">{detail}</dd>}
    </div>
  )
}

function Card({
  title,
  wide = false,
  children,
}: {
  title: string
  wide?: boolean
  children: ReactNode
}) {
  return (
    <section
      aria-label={title}
      className={`flex flex-col rounded-2xl border border-divider bg-surface p-4 ${wide ? 'lg:col-span-2' : ''}`}
    >
      <h3 className="mb-3 text-lg font-semibold">{title}</h3>
      {children}
    </section>
  )
}

const Rows = ({ children }: { children: ReactNode }) => (
  <dl className="figures grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">{children}</dl>
)

function Row({
  name,
  value,
  detail,
  main = false,
}: {
  name: string
  value: string
  detail?: string
  main?: boolean
}) {
  return (
    <div className="contents">
      <dt className={main ? 'font-semibold' : ''}>{name}</dt>
      <dd className={`text-right ${main ? 'font-semibold' : ''}`}>
        {value}
        {detail && <span className="block text-sm text-muted">{detail}</span>}
      </dd>
    </div>
  )
}

const DataPoint = ({ name, value }: { name: string; value: string }) => (
  <div>
    <dt className="text-sm text-muted">{name}</dt>
    <dd className="font-semibold">{value}</dd>
  </div>
)

function DataTable({
  columns,
  rows,
  hiddenOnPhone = [],
}: {
  columns: string[]
  rows: { key: string; cells: string[] }[]
  /** Columns (by position) not shown below 640 px. */
  hiddenOnPhone?: number[]
}) {
  const phone = (i: number) => (hiddenOnPhone.includes(i) ? 'max-sm:hidden' : '')
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="figures w-full border-collapse text-left">
        <thead>
          <tr className="text-sm text-muted">
            {columns.map((c, i) => (
              <th
                key={c}
                scope="col"
                className={`px-1 pb-1 font-normal ${i > 0 ? 'text-right' : ''} ${phone(i)}`}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-divider">
          {rows.map((f) => (
            <tr key={f.key}>
              {f.cells.map((c, i) => (
                <td
                  // biome-ignore lint/suspicious/noArrayIndexKey: the columns are fixed
                  key={i}
                  className={`px-1 py-1.5 ${i > 0 ? 'text-right whitespace-nowrap' : ''} ${phone(i)}`}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function EventItem({
  title,
  value,
  reason,
  detail,
  label,
}: {
  title: string
  value: string
  reason: string | null
  detail: (string | null)[]
  label: ReactNode
}) {
  const extra = detail.filter(Boolean).join(' · ')
  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="font-semibold">{title}</span>
        <span className="figures">{value}</span>
      </div>
      {reason && <p>{reason}</p>}
      {(extra || label) && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          {label}
          {extra && <span>{extra}</span>}
        </div>
      )}
    </li>
  )
}

const EmptyState = ({ children }: { children: ReactNode }) => (
  <p className="text-muted">{children}</p>
)
const Note = ({ children }: { children: ReactNode }) => (
  <p className="mt-3 text-sm text-muted">{children}</p>
)
