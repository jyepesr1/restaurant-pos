import {
  businessDay,
  DENOMINATIONS,
  type MethodReconciliation,
  methodKeyOf,
  newId,
  orderTotals,
  otherMethodsReconciliation,
  type PaymentMethod,
  type ShiftReconciliation,
} from '@pos/core'
import type { Catalog } from '@pos/sync'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { digitsOnly, pesos, withDots } from '../ui/format'
import { Label } from '../ui/Label'
import { Group, Option } from '../ui/Options'
import { navigate } from '../ui/route'
import { SidePanel } from '../ui/SidePanel'
import { useNotify } from '../ui/toasts'
import { type CheckoutRules, methodName, rulesOf } from './checks'
import { floor, useFloor, useLocalView } from './context'
import { FloorFrame } from './FloorFrame'
import { fieldClass } from './SignIn'

// This device's register (tasks 1.6 and 1.7): open it with the float, see what was charged in the
// shift, record cash in, cash out and tip payouts, and close it with a blind cash count: first the
// bills and coins are counted (the count is saved), then the expected amount and the variance are
// shown, and from the restaurant's threshold up it must be justified. Everything needs the hub.

type Movement = 'entry' | 'output' | 'tip_payout'

const MOVEMENT_NAME: Record<Movement, string> = {
  entry: 'Entrada',
  output: 'Salida',
  tip_payout: 'Pago de propinas',
}

const REASONS: Record<Exclude<Movement, 'tip_payout'>, string[]> = {
  entry: ['Cambio para la caja'],
  output: ['Compra', 'Pago a proveedor'],
}

/** What the schema accepts per denomination. */
const MAX_QUANTITY = 100_000

const NO_NETWORK =
  'Sin conexión con el hub del local: no se pueden registrar movimientos ni cerrar la caja hasta que vuelva. Revisa el cable o el Wi-Fi.'

const message = (e: unknown) => (e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.')

/** «las 6:30 p. m.» today; «ayer a las…» or the date if earlier. */
function when(iso: string): string {
  const date = new Date(iso)
  const time = new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit' }).format(date)
  const today = new Date()
  const days = Math.round(
    (new Date(today.toDateString()).getTime() - new Date(date.toDateString()).getTime()) /
      86_400_000,
  )
  if (days === 0) return `las ${time}`
  if (days === 1) return `ayer a las ${time}`
  return `el ${new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long' }).format(date)} a las ${time}`
}

/** The business day of an instant, with the restaurant's time zone and day start. */
const dayOf = (iso: string, rules: CheckoutRules | null) =>
  businessDay(iso, rules?.timeZone ?? 'America/Bogota', rules?.businessDayStart ?? '06:00')

/** A value that can be negative (a method with only refunds): «-5.000» → -5000. */
export const withSign = (text: string) =>
  (text.trim().startsWith('-') ? -1 : 1) * digitsOnly(text) || 0

/** «Mesa 4», «Mesa 5 + 6», «Para llevar». */
function orderLabel(catalog: Catalog | null, tableId: string | null, merged: string[]) {
  if (!tableId) return 'Sin mesa'
  const names = [tableId, ...merged].map(
    (id) => catalog?.tables.find((m) => m.id === id)?.name ?? '?',
  )
  return `Mesa ${names.join(' + ')}`
}

/** A non-cash method, reconciled at close against what its own closing report says. */
export interface ShiftCloseMethod {
  key: string
  method: Exclude<PaymentMethod, 'cash'>
  customMethodId: string | null
  /** «Cierre de Bold», «Llegó por Nequi». */
  label: string
  /** Its name in the result. */
  name: string
}

const PROVIDER: Record<string, string> = {
  bold: 'Bold',
  redeban: 'Redeban',
  credibanco: 'Credibanco',
}

const methodKey = methodKeyOf

/**
 * The methods to reconcile at close (task 1.8): the ones the restaurant accepts and the ones that
 * had payments in the shift (even if already turned off). Card goes on a single line: card
 * terminals from the same provider deliver a single closing report.
 */
/** How each kind of denomination reads on screen. */
const DENOMINATION_NAMES = { bill: 'billete', coin: 'moneda' } as const

export function shiftCloseMethods(
  rules: CheckoutRules | null,
  reconciliation: ShiftReconciliation,
  catalog: Catalog | null,
): ShiftCloseMethod[] {
  const providers = [...new Set((catalog?.cardTerminals ?? []).map((d) => d.provider ?? 'other'))]
  const card =
    providers.length === 1 && providers[0] && PROVIDER[providers[0]]
      ? `Cierre de ${PROVIDER[providers[0]]} (total con propinas)`
      : 'Cierre de los datáfonos (la suma, con propinas)'
  const list: ShiftCloseMethod[] = []
  const add = (method: PaymentMethod, customMethodId: string | null) => {
    // An unnamed custom method (a refund without its payment here) has no report to ask for.
    if (method === 'cash' || (method === 'other' && !customMethodId)) return
    const key = methodKey({ method, customMethodId })
    if (list.some((m) => m.key === key)) return
    const name = methodName(method, customMethodId, rules)
    list.push({
      key,
      method,
      customMethodId,
      name,
      label: method === 'card' ? card : `Llegó por ${name}`,
    })
  }
  for (const m of rules?.paymentMethods ?? []) add(m, null)
  for (const m of rules?.customMethods ?? []) add('other', m.id)
  for (const m of reconciliation.byMethod) add(m.method, m.customMethodId)
  return list
}

export function Register() {
  const { device, connection, session, catalog } = useFloor()
  const view = useLocalView()
  const notify = useNotify()
  const [base, setBase] = useState(0)
  const [taken, setTaken] = useState(false)
  const [moving, setMoving] = useState<Movement | null>(null)
  const [closing, setClosing] = useState(false)
  // The count lives here: leaving the close and coming back does not erase it.
  const [quantities, setQuantities] = useState<Record<string, number>>({})
  // What the closing reports of the other methods (Bold, Nequi…) say, with the count.
  const [reports, setReports] = useState<Record<string, string>>({})
  // This device's last close, to show how it ended.
  const [closed, setClosed] = useState<ShiftReconciliation | null>(null)

  if (!view) return null
  const rules = rulesOf(catalog)
  const isRegister = device?.type === 'register'
  const permissions = session?.permissions ?? []
  const canOpen = permissions.includes('open_register_shift')
  const canMove = permissions.includes('cash_movement')
  const canClose = permissions.includes('close_register_shift')
  const online = connection === 'connected'
  const shift = view.shift
  const reconciliation = view.reconciliation
  // A shift from an earlier business day: it must be closed to reconcile that day.
  const fromOtherDay =
    shift !== null && dayOf(shift.openedAt, rules) !== dayOf(new Date().toISOString(), rules)

  const act = async (job: () => Promise<void>) => {
    if (taken) return
    setTaken(true)
    try {
      await job()
    } catch (e) {
      notify(message(e))
    } finally {
      setTaken(false)
    }
  }

  const open = () =>
    act(async () => {
      await floor.openShift(base)
      setClosed(null)
      notify(`Caja abierta con ${pesos(base)} de base`)
      // If it came from charging a check, go back to it.
      const back = new URLSearchParams(location.search).get('back')
      if (back?.startsWith('/check?')) navigate(back)
    })

  const noNetwork = !online && (
    <p className="rounded-xl bg-alerta-suave p-3 text-alerta-texto">{NO_NETWORK}</p>
  )

  return (
    <FloorFrame title="Caja">
      <div className="mx-auto flex max-w-xl flex-col gap-4 p-3 md:p-5">
        {!isRegister ? (
          <p className="rounded-2xl bg-proceso-suave p-4 text-proceso-texto">
            Este equipo no es de caja. Para cobrar, entra con el usuario y la contraseña de caja en
            el computador de la caja.
          </p>
        ) : shift && reconciliation && closing ? (
          <Closeout
            reconciliation={reconciliation}
            rules={rules}
            quantities={quantities}
            onQuantitiesChange={setQuantities}
            methods={shiftCloseMethods(rules, reconciliation, catalog)}
            reports={reports}
            onReportsChange={setReports}
            openTables={view.orders
              .map((p) => ({
                id: p.status.id,
                name: orderLabel(catalog, p.status.tableId, p.status.mergedTables),
                balance: orderTotals(p.status).balance,
              }))
              .filter((m) => m.balance > 0)}
            noNetwork={noNetwork}
            online={online}
            onBack={() => setClosing(false)}
            onClose={(c) => {
              setClosing(false)
              setQuantities({})
              setReports({})
              setClosed(c)
            }}
          />
        ) : shift && reconciliation ? (
          <>
            <section className="rounded-2xl border border-linea bg-superficie p-4 shadow-flota">
              <p className="text-lg font-semibold">
                {`Caja abierta desde ${when(shift.openedAt)}`}
                {shift.pendingConfirmation && (
                  <span className="ml-2 text-sm font-normal text-texto-suave">(sin confirmar)</span>
                )}
              </p>
              <p className="cifras text-texto-suave">{`Base: ${pesos(shift.base)}`}</p>
            </section>
            {fromOtherDay && (
              <p className="rounded-xl bg-alerta-suave p-3 text-alerta-texto">
                Esta caja sigue abierta de un día anterior. Ciérrala para cuadrar ese día y ábrela
                de nuevo con la base de hoy.
              </p>
            )}
            <Charged
              reconciliation={reconciliation}
              rules={rules}
              withAmounts={permissions.includes('view_reports')}
            />
            <Movements reconciliation={reconciliation} />
            {noNetwork}
            {canMove && (
              <div className="grid grid-cols-3 gap-2">
                {(['entry', 'output', 'tip_payout'] as const).map((t) => (
                  <Button key={t} disabled={!online || taken} onClick={() => setMoving(t)}>
                    {MOVEMENT_NAME[t]}
                  </Button>
                ))}
              </div>
            )}
            {canClose && (
              <Button
                variant="main"
                large
                icon="check"
                disabled={!online || shift.pendingConfirmation}
                onClick={() => setClosing(true)}
              >
                Cerrar la caja
              </Button>
            )}
            <MovementPanel
              key={moving ?? 'closed'}
              type={moving}
              reconciliation={reconciliation}
              taken={taken}
              onClose={() => setMoving(null)}
              onSave={(data) =>
                act(async () => {
                  await floor.recordConfirmed('CashMovementRecorded', shift.id, {
                    ...data,
                    days:
                      data.type === 'tip_payout' ? [dayOf(new Date().toISOString(), rules)] : [],
                  })
                  setMoving(null)
                  notify(`${MOVEMENT_NAME[data.type]} de ${pesos(data.amount)} registrada`)
                })
              }
            />
          </>
        ) : (
          <>
            {closed && <Result reconciliation={closed} rules={rules} />}
            {!canOpen ? (
              <p className="rounded-2xl bg-proceso-suave p-4 text-proceso-texto">
                La caja está cerrada. Pídele a quien tenga el permiso que la abra.
              </p>
            ) : (
              <section className="flex flex-col gap-3 rounded-2xl border border-linea bg-superficie p-4 shadow-flota">
                <h2 className="text-lg font-semibold">Abrir la caja</h2>
                <label>
                  <span className="font-semibold">Base en efectivo</span>
                  <span className="block text-sm text-texto-suave">
                    El efectivo con que empieza la caja, para dar cambio.
                  </span>
                  <input
                    inputMode="numeric"
                    className={`${fieldClass} cifras mt-2 min-h-14 text-2xl`}
                    value={withDots(base)}
                    placeholder="0"
                    onChange={(e) => setBase(digitsOnly(e.target.value))}
                  />
                </label>
                {noNetwork}
                <Button variant="main" large icon="bill" disabled={taken || !online} onClick={open}>
                  {base === 0 ? 'Abrir sin base' : `Abrir con ${pesos(base)}`}
                </Button>
              </section>
            )}
          </>
        )}
      </div>
    </FloorFrame>
  )
}

/** «3 pagos»; nothing if it ended at 0 or less (a void from another shift). */
const howMany = (n: number) => (n > 0 ? ` · ${n === 1 ? '1 pago' : `${n} pagos`}` : '')

/**
 * What was charged in the shift per method, with the total. The cashier only sees how many
 * payments there are: with the amounts they could know the expected amount before counting and
 * the cash count would no longer be blind. Whoever sees the reports (the admin) sees the amounts.
 */
function Charged({
  reconciliation,
  rules,
  withAmounts,
}: {
  reconciliation: ShiftReconciliation
  rules: CheckoutRules | null
  withAmounts: boolean
}) {
  const sale = reconciliation.byMethod.reduce((a, m) => a + m.sale, 0)
  const tips = reconciliation.byMethod.reduce((a, m) => a + m.tip, 0)
  if (!withAmounts)
    return (
      <section
        className="rounded-2xl border border-linea bg-superficie p-4"
        aria-label="Cobrado en este turno"
      >
        <h2 className="mb-2 font-semibold">Cobrado en este turno</h2>
        {reconciliation.byMethod.length === 0 ? (
          <p className="text-texto-suave">Todavía no hay pagos.</p>
        ) : (
          <>
            <ul className="flex flex-col gap-1">
              {reconciliation.byMethod.map((m) => (
                <li key={methodKeyOf(m)}>
                  {`${methodName(m.method, m.customMethodId, rules)}${howMany(m.payments)}`}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-texto-suave">
              Los totales se ven al cerrar la caja, después de contar.
            </p>
          </>
        )}
      </section>
    )
  return (
    <section
      className="rounded-2xl border border-linea bg-superficie p-4"
      aria-label="Cobrado en este turno"
    >
      <h2 className="mb-2 font-semibold">Cobrado en este turno</h2>
      {reconciliation.byMethod.length === 0 ? (
        <p className="text-texto-suave">Todavía no hay pagos.</p>
      ) : (
        <dl className="cifras grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
          <dt className="font-semibold">Total</dt>
          <dd className="text-right font-semibold">
            {pesos(sale)}
            <span className="block text-sm font-normal text-texto-suave">{`+ propinas ${pesos(tips)}`}</span>
          </dd>
          {reconciliation.byMethod.map((m) => (
            <div key={`${m.method}${m.customMethodId ?? ''}`} className="contents">
              <dt>{`${methodName(m.method, m.customMethodId, rules)}${howMany(m.payments)}`}</dt>
              <dd className="text-right">
                {pesos(m.sale)}
                {m.tip !== 0 && (
                  <span className="block text-sm text-texto-suave">{`+ propina ${pesos(m.tip)}`}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

function Movements({ reconciliation }: { reconciliation: ShiftReconciliation }) {
  if (reconciliation.movements.length === 0) return null
  return (
    <section
      className="rounded-2xl border border-linea bg-superficie p-4"
      aria-label="Movimientos de efectivo"
    >
      <h2 className="mb-2 font-semibold">Movimientos de efectivo</h2>
      <ul className="cifras flex flex-col gap-1">
        {reconciliation.movements.map((m) => (
          <li key={m.id} className="flex justify-between gap-2">
            <span>
              {MOVEMENT_NAME[m.type]}
              <span className="text-texto-suave">{` · ${m.toWhom ?? m.description}`}</span>
            </span>
            <span>{`${m.type === 'entry' ? '+' : '-'}${pesos(m.amount)}`}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

interface MovementData {
  movement_id: string
  type: Movement
  amount: number
  description: string
  to_whom: string | null
}

/** Record cash in, cash out or a tip payout, with its reason and a confirmation. */
function MovementPanel({
  type,
  reconciliation,
  taken,
  onClose,
  onSave,
}: {
  type: Movement | null
  reconciliation: ShiftReconciliation
  taken: boolean
  onClose: () => void
  onSave: (data: MovementData) => void
}) {
  // The same id on every attempt: retrying does not record the movement twice.
  const [movementId] = useState(newId)
  const [amount, setAmount] = useState(0)
  const [reason, setReason] = useState<string | null>(null)
  const [other, setOther] = useState('')
  const [toWhom, setToWhom] = useState('')
  const [confirming, setConfirming] = useState(false)
  const tips = reconciliation.byMethod.reduce((a, m) => a + m.tip, 0)
  const isOutflow = type === 'output' || type === 'tip_payout'
  const description =
    type === 'tip_payout' ? 'Pago de propinas' : reason === 'other' ? other.trim() : (reason ?? '')
  const ready =
    type !== null &&
    amount > 0 &&
    (type === 'tip_payout' ? toWhom.trim().length > 0 : description.length > 0)
  const save = () =>
    type &&
    onSave({
      movement_id: movementId,
      type,
      amount,
      description,
      to_whom: type === 'tip_payout' ? toWhom.trim() : null,
    })
  return (
    <SidePanel
      opened={type !== null}
      title={type ? MOVEMENT_NAME[type] : 'Movimiento'}
      onClose={onClose}
      footer={
        confirming ? (
          <div
            className="flex flex-col gap-2"
            role="alertdialog"
            aria-labelledby="confirm-movement"
          >
            <p id="confirm-movement" className="text-lg font-semibold">
              {`¿${isOutflow ? 'Sacar' : 'Meter'} ${pesos(amount)} del cajón?`}
            </p>
            <div className="grid grid-cols-[2fr_3fr] gap-2">
              <Button onClick={() => setConfirming(false)}>Volver</Button>
              <Button variant="main" disabled={taken} onClick={save}>
                {taken ? 'Registrando…' : `Sí, registrar ${pesos(amount)}`}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="main"
            large
            className="w-full"
            disabled={!ready}
            onClick={() => setConfirming(true)}
          >
            {`Registrar ${pesos(amount)}`}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-4">
        <label>
          <span className="font-semibold">
            {isOutflow ? '¿Cuánto sale del cajón?' : '¿Cuánto entra al cajón?'}
          </span>
          <input
            inputMode="numeric"
            className={`${fieldClass} cifras mt-1 min-h-14 text-2xl`}
            value={withDots(amount)}
            placeholder="0"
            // biome-ignore lint/a11y/noAutofocus: the panel opens to type the amount
            autoFocus
            onChange={(e) => {
              setAmount(digitsOnly(e.target.value))
              setConfirming(false)
            }}
          />
        </label>
        {/* Without the expected figure: the cash count is blind. */}
        {isOutflow && amount > reconciliation.cash.expected && (
          <p className="rounded-xl bg-alerta-suave p-3 text-alerta-texto">
            Es más de lo que debería haber en el cajón. Revisa el valor.
          </p>
        )}
        {type === 'tip_payout' ? (
          <>
            <p className="text-sm text-texto-suave">{`Propinas de este turno: ${pesos(tips)} (de todos los medios).`}</p>
            <label>
              <span className="font-semibold">¿A quién se entregaron?</span>
              <input
                className={`${fieldClass} mt-1`}
                maxLength={100}
                value={toWhom}
                placeholder="Nombre, o elige «Todo el equipo»"
                onChange={(e) => setToWhom(e.target.value)}
              />
            </label>
            <Option
              selected={toWhom === 'Todo el equipo'}
              onChoose={() => setToWhom('Todo el equipo')}
            >
              Todo el equipo
            </Option>
          </>
        ) : (
          type && (
            <div className="flex flex-col gap-2">
              <span className="font-semibold">Motivo</span>
              <Group label="Motivo" className="flex flex-wrap gap-2">
                {REASONS[type].map((m) => (
                  <Option key={m} selected={reason === m} onChoose={() => setReason(m)}>
                    {m}
                  </Option>
                ))}
                <Option selected={reason === 'other'} onChoose={() => setReason('other')}>
                  Otro
                </Option>
              </Group>
              {reason === 'other' && (
                <input
                  className={fieldClass}
                  maxLength={200}
                  value={other}
                  placeholder="Escribe el motivo"
                  onChange={(e) => setOther(e.target.value)}
                />
              )}
            </div>
          )
        )}
      </div>
    </SidePanel>
  )
}

/**
 * The close with a blind cash count: counting happens without seeing the expected amount; saving
 * the count shows the variance. «Volver a contar» starts from zero and saves another count (the
 * first is not erased). At the register you count with the keyboard: the number and Enter move to
 * the next denomination.
 */
function Closeout({
  reconciliation,
  rules,
  quantities,
  onQuantitiesChange,
  methods,
  reports,
  onReportsChange,
  openTables,
  noNetwork,
  online,
  onBack,
  onClose,
}: {
  reconciliation: ShiftReconciliation
  rules: CheckoutRules | null
  quantities: Record<string, number>
  onQuantitiesChange: (c: Record<string, number>) => void
  methods: ShiftCloseMethod[]
  /** What was typed for each method (text, so it can start with «-»). */
  reports: Record<string, string>
  onReportsChange: (r: Record<string, string>) => void
  openTables: { id: string; name: string; balance: number }[]
  noNetwork: React.ReactNode
  online: boolean
  onBack: () => void
  onClose: (reconciliation: ShiftReconciliation) => void
}) {
  const notify = useNotify()
  const [cashCountId, setCashCountId] = useState<string | null>(null)
  // The reconciliation of the other methods with what was reported in the saved count.
  const [others, setOthers] = useState<MethodReconciliation[]>([])
  const [justification, setJustification] = useState('')
  const [taken, setTaken] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // The expected amount is fixed when the count is saved: if a payment comes in later, recount.
  const [expectedAtCount, setExpectedAtCount] = useState<number | null>(null)
  const fields = useRef<(HTMLInputElement | null)[]>([])
  const save = useRef<HTMLButtonElement>(null)
  const justificationText = useRef<HTMLTextAreaElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const key = (d: (typeof DENOMINATIONS)[number]) => `${d.type}${d.value}`
  const quantityOf = (d: (typeof DENOMINATIONS)[number]) => quantities[key(d)] ?? 0
  const counted = DENOMINATIONS.reduce((a, d) => a + d.value * quantityOf(d), 0)
  const expected = expectedAtCount ?? reconciliation.cash.expected
  const changedAfter = expectedAtCount !== null && expectedAtCount !== reconciliation.cash.expected
  const variance = counted - expected
  // Methods with charges in the shift must have their closing report typed (empty is not 0).
  const withCharges = new Set(reconciliation.byMethod.map(methodKeyOf))
  const notEntered = methods.filter((m) => withCharges.has(m.key) && !(reports[m.key] ?? '').trim())
  const threshold = rules?.varianceThreshold ?? 1000
  const large = (d: number) => d !== 0 && Math.abs(d) >= Math.max(1, threshold)
  const requiresJustification = large(variance) || others.some((o) => large(o.variance))
  const hasVariance = variance !== 0 || others.some((o) => o.variance !== 0)
  // The lines over the threshold, to say what has to be explained.
  const otherName = (o: MethodReconciliation) =>
    methods.find((m) => m.key === methodKeyOf(o))?.name ??
    methodName(o.method, o.customMethodId, rules)
  const unexplained = [
    ...(large(variance) ? ['cash'] : []),
    ...others.filter((o) => large(o.variance)).map(otherName),
  ]
  const dayStart = rules?.businessDayStart ?? '06:00'

  // On saving the count, focus follows the path: the justification if needed, otherwise close.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on a new count, not on typing
  useEffect(() => {
    if (cashCountId === null) return
    if (requiresJustification) justificationText.current?.focus()
    else closeButton.current?.focus()
  }, [cashCountId])

  const act = async (job: () => Promise<void>) => {
    if (taken) return
    setTaken(true)
    try {
      await job()
    } catch (e) {
      notify(message(e))
    } finally {
      setTaken(false)
    }
  }

  const saveCount = () =>
    act(async () => {
      const id = newId()
      // Bill and coin of the same value (the $1.000) go together in the count.
      const byValue = new Map<number, number>()
      for (const d of DENOMINATIONS)
        if (quantityOf(d) > 0) byValue.set(d.value, (byValue.get(d.value) ?? 0) + quantityOf(d))
      const reportedMethods = methods.map((m) => ({
        method: m.method,
        custom_method_id: m.customMethodId,
        reported: withSign(reports[m.key] ?? ''),
      }))
      await floor.recordConfirmed('CashCountRecorded', reconciliation.shiftId, {
        cash_count_id: id,
        tally: [...byValue].map(([value, quantity]) => ({ value, quantity })),
        counted_cash: counted,
        others: reportedMethods,
      })
      setOthers(
        otherMethodsReconciliation(reconciliation, {
          id,
          tally: [],
          counted,
          others: reportedMethods.map((r) => ({
            method: r.method,
            customMethodId: r.custom_method_id,
            reported: r.reported,
          })),
          time: '',
        }),
      )
      setExpectedAtCount(reconciliation.cash.expected)
      setConfirming(false)
      setCashCountId(id)
    })

  const close = () =>
    act(async () => {
      if (!cashCountId) return
      const final = justification.trim() || null
      await floor.recordConfirmed('ShiftClosed', reconciliation.shiftId, {
        cash_count_id: cashCountId,
        expected_cash: expected,
        counted_cash: counted,
        variance,
        justification: final,
        other_methods: others.map((o) => ({
          method: o.method,
          custom_method_id: o.customMethodId,
          expected: o.expected,
          reported: o.reported,
          variance: o.variance,
        })),
      })
      notify('Caja cerrada')
      onClose({
        ...reconciliation,
        closed: {
          expected,
          counted,
          variance,
          justification: final,
          otherMethods: others,
          time: new Date().toISOString(),
        },
      })
    })

  const outstanding = openTables.reduce((a, m) => a + m.balance, 0)
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl font-bold tracking-tight">Cerrar la caja</h2>
        <Button variant="ghost" onClick={onBack}>
          Cancelar el cierre
        </Button>
      </div>
      {openTables.length > 0 && (
        <div className="rounded-xl bg-proceso-suave p-3 text-proceso-texto">
          <p>
            {`${openTables.length === 1 ? 'Queda 1 mesa abierta' : `Quedan ${openTables.length} mesas abiertas`} con ${pesos(outstanding)} por cobrar. Lo que se cobre después de cerrar cae en el próximo turno.`}
          </p>
          <ul className="cifras mt-1">
            {openTables.slice(0, 8).map((m) => (
              <li key={m.id}>{`${m.name} · ${pesos(m.balance)}`}</li>
            ))}
          </ul>
        </div>
      )}
      {cashCountId === null ? (
        <section
          className="flex flex-col gap-3 rounded-2xl border border-linea bg-superficie p-4"
          aria-label="Conteo del efectivo"
        >
          <p>Cuenta el efectivo del cajón: cuántos billetes y monedas hay de cada uno.</p>
          <p className="text-sm text-texto-suave">
            {threshold <= 1
              ? 'Si algo no cuadra, se pide explicarlo.'
              : `Si algo no cuadra desde ${pesos(threshold)}, se pide explicarlo.`}
          </p>
          <ul className="flex flex-col gap-2">
            {DENOMINATIONS.map((d, i) => {
              const n = quantityOf(d)
              const name = `${d.type === 'bill' ? 'billetes' : 'monedas'} de ${pesos(d.value)}`
              const put = (v: number) =>
                onQuantitiesChange({
                  ...quantities,
                  [key(d)]: Math.min(MAX_QUANTITY, Math.max(0, v)),
                })
              return (
                <li key={key(d)} className="flex items-center gap-2">
                  <span className="cifras w-24 shrink-0 font-semibold">
                    {pesos(d.value)}
                    <span className="block text-sm font-normal text-texto-suave">
                      {DENOMINATION_NAMES[d.type]}
                    </span>
                  </span>
                  {/* − and + are for fingers: with a keyboard you type the number (no focus). */}
                  <Button
                    icon="minus"
                    tabIndex={-1}
                    aria-label={`Quitar uno: ${name}`}
                    disabled={n === 0}
                    onClick={() => put(n - 1)}
                  />
                  <input
                    ref={(el) => {
                      fields.current[i] = el
                    }}
                    inputMode="numeric"
                    aria-label={`Cantidad de ${name}`}
                    className={`${fieldClass} cifras w-16 text-center`}
                    value={n ? String(n) : ''}
                    placeholder="0"
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => put(digitsOnly(e.target.value))}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return
                      e.preventDefault()
                      const next = fields.current[i + 1]
                      if (next) next.focus()
                      else save.current?.focus()
                    }}
                  />
                  <Button
                    icon="more"
                    tabIndex={-1}
                    aria-label={`Agregar uno: ${name}`}
                    onClick={() => put(n + 1)}
                  />
                  <span className="cifras ml-auto text-right text-texto-suave">
                    {pesos(d.value * n)}
                  </span>
                </li>
              )
            })}
          </ul>
          <p className="cifras flex items-baseline justify-between border-t border-linea pt-3">
            <span className="font-semibold">Contado</span>
            <span className="font-titulo text-3xl font-bold">{pesos(counted)}</span>
          </p>
          {methods.length > 0 && (
            <div className="flex flex-col gap-2 border-t border-linea pt-3">
              <h3 className="font-semibold">Los demás medios</h3>
              <p className="text-sm text-texto-suave">
                {`Escribe el total del cierre del datáfono (en su app o en el papel del cierre) y lo que llegó a cada app, desde las ${dayStart} de hoy. Si solo hubo devoluciones, empieza con «-».`}
              </p>
              {methods.map((m, j) => (
                <label key={m.key} className="flex items-center gap-2">
                  <span className="flex-1">{m.label}</span>
                  <input
                    ref={(el) => {
                      fields.current[DENOMINATIONS.length + j] = el
                    }}
                    inputMode="numeric"
                    className={`${fieldClass} cifras w-40 text-right`}
                    value={reports[m.key] ?? ''}
                    placeholder={withCharges.has(m.key) ? 'Escríbelo' : '0'}
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) =>
                      onReportsChange({
                        ...reports,
                        [m.key]: e.target.value.replace(/[^\d.-]/g, '').slice(0, 13),
                      })
                    }
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return
                      e.preventDefault()
                      const next = fields.current[DENOMINATIONS.length + j + 1]
                      if (next) next.focus()
                      else save.current?.focus()
                    }}
                  />
                </label>
              ))}
            </div>
          )}
          {notEntered.length > 0 && (
            <p className="text-sm text-texto-suave">
              {`Falta escribir: ${notEntered.map((m) => m.name).join(', ')}.`}
            </p>
          )}
          {noNetwork}
          <Button
            ref={save}
            variant="main"
            large
            disabled={taken || !online || notEntered.length > 0}
            onClick={saveCount}
          >
            {taken ? 'Guardando…' : 'Guardar el conteo'}
          </Button>
          <p className="text-sm text-texto-suave">
            Lo que debería haber se ve después de guardar el conteo.
          </p>
        </section>
      ) : (
        <>
          <Result
            reconciliation={{
              ...reconciliation,
              closed: {
                expected,
                counted,
                variance,
                justification: null,
                otherMethods: others,
                time: '',
              },
            }}
            rules={rules}
            title="Así queda la caja"
          />
          {changedAfter && (
            <p className="rounded-xl bg-alerta-suave p-3 text-alerta-texto">
              Entró un pago o un movimiento después del conteo: vuelve a contar.
            </p>
          )}
          {hasVariance && (
            <label>
              <span className="font-semibold">
                {requiresJustification
                  ? `Explica por qué no cuadra: ${unexplained.join(', ')}`
                  : '¿Por qué no cuadra? (opcional)'}
              </span>
              {requiresJustification && (
                <span className="block text-sm text-texto-suave">
                  {threshold <= 1
                    ? 'Toda diferencia se explica; queda en el informe.'
                    : `Desde ${pesos(threshold)} de diferencia hay que explicarla; queda en el informe.`}
                </span>
              )}
              <textarea
                ref={justificationText}
                className={`${fieldClass} mt-1 min-h-24 py-2`}
                maxLength={500}
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
              />
            </label>
          )}
          {noNetwork}
          {requiresJustification && !justification.trim() && (
            <p className="text-sm text-texto-suave">Para cerrar, falta explicar la diferencia.</p>
          )}
          {confirming ? (
            <div
              className="rounded-2xl border-2 border-accion-fuerte bg-accion-suave p-3 text-accion-texto"
              role="alertdialog"
              aria-labelledby="confirm-close"
            >
              <p id="confirm-close" className="mb-3 text-lg font-semibold">
                ¿Cerrar la caja? Después de cerrar ya no se cobra en este turno.
              </p>
              <div className="grid grid-cols-[2fr_3fr] gap-2">
                <Button onClick={() => setConfirming(false)}>Volver</Button>
                <Button variant="main" disabled={taken} onClick={close}>
                  {taken ? 'Cerrando…' : 'Sí, cerrar la caja'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-[2fr_3fr] gap-2">
              <Button
                disabled={taken}
                onClick={() => {
                  // Counting again saves another count (the previous one stays); what was typed can
                  // be corrected without starting from zero.
                  setCashCountId(null)
                  setOthers([])
                  setExpectedAtCount(null)
                  setJustification('')
                }}
              >
                Volver a contar
              </Button>
              <Button
                ref={closeButton}
                variant="main"
                large
                disabled={
                  taken ||
                  !online ||
                  changedAfter ||
                  (requiresJustification && !justification.trim())
                }
                onClick={() => setConfirming(true)}
              >
                Cerrar la caja
              </Button>
            </div>
          )}
        </>
      )}
    </>
  )
}

/** How the register ended (or ends): expected, counted, variance and the other methods. */
function Result({
  reconciliation,
  rules,
  title = 'Cómo quedó la caja',
}: {
  reconciliation: ShiftReconciliation
  rules: CheckoutRules | null
  title?: string
}) {
  const c = reconciliation.closed
  if (!c) return null
  const digital = reconciliation.byMethod.filter((m) => m.method !== 'cash')
  const row = (name: string, value: number, sign = '') =>
    value > 0 && (
      <>
        <dt>{name}</dt>
        <dd className="text-right">{`${sign}${pesos(value)}`}</dd>
      </>
    )
  return (
    <section
      className="flex flex-col gap-3 rounded-2xl border border-linea bg-superficie p-4 shadow-flota"
      aria-label="Cuadre de la caja"
    >
      <h2 className="text-lg font-semibold">
        {title}
        {c.time && (
          <span className="ml-2 text-sm font-normal text-texto-suave">{`· cerrada a ${when(c.time)}`}</span>
        )}
      </h2>
      <dl className="cifras grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
        <dt>Base</dt>
        <dd className="text-right">{pesos(reconciliation.base)}</dd>
        {row('Efectivo cobrado (con propinas)', reconciliation.cash.charged, '+')}
        {row('Devoluciones', reconciliation.cash.refunds, '-')}
        {row('Entradas', reconciliation.cash.entries, '+')}
        {row('Salidas', reconciliation.cash.outflows, '-')}
        {row('Pago de propinas', reconciliation.cash.tipPayouts, '-')}
        <dt className="font-semibold">Debería haber</dt>
        <dd className="text-right font-semibold">{pesos(c.expected)}</dd>
        <dt className="font-semibold">Contado</dt>
        <dd className="text-right font-semibold">{pesos(c.counted)}</dd>
      </dl>
      <p className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">Efectivo</span>
        <Variance value={c.variance} />
      </p>
      {/* A shift closed before 1.8 lacks the other methods' reconciliation: only the record. */}
      {c.otherMethods.length > 0 ? (
        <div>
          <h3 className="font-semibold">Los demás medios</h3>
          <ul className="cifras mt-1 flex flex-col gap-2">
            {c.otherMethods.map((m) => (
              <li key={methodKey(m)} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {methodName(m.method, m.customMethodId, rules)}
                  <span className="block text-sm text-texto-suave">{`En la caja ${pesos(m.expected)} · según su cierre ${pesos(m.reported)}`}</span>
                </span>
                <Variance value={m.variance} />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        digital.length > 0 && (
          <div>
            <h3 className="font-semibold">Los demás medios</h3>
            <ul className="cifras mt-1 flex flex-col gap-1">
              {digital.map((m) => (
                <li key={methodKey(m)} className="flex justify-between">
                  <span>{methodName(m.method, m.customMethodId, rules)}</span>
                  <span>{pesos(m.sale + m.tip)}</span>
                </li>
              ))}
            </ul>
          </div>
        )
      )}
      {c.justification && (
        <p className="border-t border-linea pt-2 text-sm">
          <span className="font-semibold">Por qué no cuadra: </span>
          {c.justification}
        </p>
      )}
    </section>
  )
}

/** «Cuadra», «Sobran $X» or «Faltan $X», with its icon. */
export function Variance({ value }: { value: number }) {
  if (value === 0)
    return (
      <Label tone="free" icon="check">
        Cuadra
      </Label>
    )
  return value > 0 ? (
    <Label tone="progress" icon="more">
      {`Sobran ${pesos(value)}`}
    </Label>
  ) : (
    <Label tone="warning" icon="minus">
      {`Faltan ${pesos(-value)}`}
    </Label>
  )
}
