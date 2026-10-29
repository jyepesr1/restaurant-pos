import { newId, type OrderState, orderTaxes, orderTotals } from '@pos/core'
import type { Catalog } from '@pos/sync'
import { useState } from 'react'
import { Button } from '../ui/Button'
import { digitsOnly, pesos, withDots } from '../ui/format'
import { Label } from '../ui/Label'
import { Group, Option } from '../ui/Options'
import { navigate, useRoute } from '../ui/route'
import { SidePanel } from '../ui/SidePanel'
import { useNotify } from '../ui/toasts'
import { type Charging, CheckoutPanel, type NewPayment } from './Checkout'
import {
  byProducts,
  inEqualParts,
  linesOf,
  methodName,
  outstanding,
  rulesOf,
  suggestedTipOf,
  taxName,
  trimAssignments,
} from './checks'
import { floor, useFloor, useLocalView } from './context'
import { FloorFrame } from './FloorFrame'
import { CHANNELS, unitsToSend } from './order'
import { fieldClass } from './SignIn'

// The check for an order (task 1.6, brief §4.5): the pre-bill on screen and on paper, splitting it
// (into equal parts or by products) and charging each part. The BALANCE is split: what was already
// paid stays aside. Charging only works on a register device with the register open and connected
// to the hub; when the balance reaches 0, the order closes itself and the table becomes free.

type Mode = 'single' | 'even' | 'products'

const PAYMENT_VOID_REASONS = ['Se registró por error', 'Pagó con otro medio'] as const

const message = (e: unknown) => (e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.')

/** «Mesa 5 + 6», «Para llevar #12». */
function titleOf(catalog: Catalog, order: OrderState): string {
  if (order.tableId) {
    const names = [order.tableId, ...order.mergedTables].map(
      (id) => catalog.tables.find((m) => m.id === id)?.name ?? '?',
    )
    return `Mesa ${names.join(' + ')}`
  }
  const channel = CHANNELS[order.channel as keyof typeof CHANNELS] ?? 'Pedido'
  return order.dayNumber ? `${channel} #${order.dayNumber}` : channel
}

export function Check() {
  const { params } = useRoute()
  const orderId = params.get('order')
  const view = useLocalView()
  const { catalog, session, device, connection } = useFloor()
  const notify = useNotify()
  // What was charged and closed the order: it stays visible (the change to hand back).
  const [closed, setClosed] = useState<{ title: string; change: number | null } | null>(null)
  const [lastChange, setLastChange] = useState<number | null>(null)
  const [mode, setMode] = useState<Mode>('single')
  const [people, setPeople] = useState(2)
  const [checks, setChecks] = useState(2)
  const [assignedChecks, setAssignedChecks] = useState<Map<string, number[]>>(new Map())
  const [charging, setCharging] = useState<Charging | null>(null)
  const [voiding, setVoiding] = useState<string | null>(null)
  const [taken, setTaken] = useState(false)
  const [selectedTip, setSelectedTip] = useState<number | null>(null)
  const [editingTip, setEditingTip] = useState(false)

  if (closed)
    return (
      <FloorFrame title={closed.title} back="/">
        <div className="mx-auto flex max-w-md flex-col gap-4 p-4">
          <p className="rounded-2xl bg-free-soft p-4 text-free-text">
            <span className="block text-lg font-semibold">Pagado y cerrado</span>
            {closed.change !== null && closed.change > 0 && (
              <>
                <span className="mt-2 block">Cambio a entregar</span>
                <span className="figures font-heading text-4xl font-bold">
                  {pesos(closed.change)}
                </span>
              </>
            )}
          </p>
          <Button variant="main" large icon="table" onClick={() => navigate('/')}>
            Volver al salón
          </Button>
        </div>
      </FloorFrame>
    )

  if (!catalog || !view) return null
  const visibleOrder = view.orders.find((p) => p.status.id === orderId)
  if (!visibleOrder)
    return (
      <FloorFrame title="Cuenta" back="/">
        <p className="p-6 text-muted">Este pedido ya no está abierto.</p>
      </FloorFrame>
    )
  const order = visibleOrder.status
  const title = titleOf(catalog, order)
  const backToOrder = `/order?order=${order.id}${order.tableId ? `&table=${order.tableId}` : ''}`
  const rules = rulesOf(catalog)
  if (!rules)
    return (
      <FloorFrame title={`Cuenta · ${title}`} back="/">
        <p className="p-6 text-muted">
          La caja tiene una versión anterior que no sabe cobrar: hay que actualizarla.
        </p>
      </FloorFrame>
    )

  const permissions = session?.permissions ?? []
  const online = connection === 'connected'
  const isRegister = device?.type === 'register'
  const canSplit = permissions.includes('split_check')
  const canCharge = isRegister && permissions.includes('record_payment')
  const canVoidPayment = isRegister && permissions.includes('void_payment')
  const canClose = isRegister && permissions.includes('close_table')
  const shift = view.shift
  const totals = orderTotals(order)
  const lines = linesOf(order)
  const { balance, checks: splitChecks, unassigned } = outstanding(order)
  const balanceTip = suggestedTipOf(order, balance, rules)
  const tipFive = suggestedTipOf(order, balance, { ...rules, suggestedTip: 500 })
  // The tip the customer asks for on seeing the pre-bill (no tip, another amount); it goes on
  // paper and to checkout.
  const shownTip = selectedTip ?? balanceTip
  const taxes = orderTaxes(order, rules.roundingMode)
  const payments = Object.values(order.payments).filter((p) => !p.voided)
  const unsent = unitsToSend(order)

  /** A job that records events: one at a time, and the error is reported. */
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

  const print = (checkId: string | null, subtotal: number, tip: number) =>
    act(async () => {
      await floor.record('PreBillPrinted', order.id, {
        check_id: checkId,
        subtotal,
        suggested_tip: tip,
      })
      notify(rules.printsPreBill ? 'Precuenta enviada a la impresora' : `${title}: pidió la cuenta`)
    })

  const split = (equalParts: ReturnType<typeof inEqualParts>) =>
    act(async () => {
      await floor.record('CheckSplit', order.id, { checks: equalParts })
      setMode('single')
      setAssignedChecks(new Map())
    })

  const undo = () =>
    act(async () => {
      await floor.record('SplitUndone', order.id, {})
    })

  /** Closes the order with a 0 balance; the hub confirms before it is shown as closed. */
  const close = async (change: number | null) => {
    await floor.recordConfirmed('OrderClosed', order.id, {})
    setClosed({ title, change })
    notify(`${title}: pagada y cerrada`)
  }

  // Money is shown as charged only when the hub accepts it: a payment the hub rejects would
  // disappear from the check after the customer already paid.
  const charge = (payment: NewPayment) =>
    act(async () => {
      if (!shift) throw new Error('Abre la caja para cobrar')
      await floor.recordConfirmed('PaymentRecorded', order.id, {
        ...payment,
        register_shift_id: shift.id,
      })
      setCharging(null)
      setLastChange(payment.change)
      // What is left according to what is already saved with the payment (another device may have
      // charged at the same time).
      const after = await floor.sync?.order(order.id)
      const hasRemaining = after ? orderTotals(after).balance : balance - payment.amount
      // The table closes itself when the balance reaches 0 (owner decision, 26-oct-2026). If the
      // close fails, the payment is already recorded and «Cerrar la mesa» tries again.
      if (hasRemaining === 0 && canClose) await close(payment.change)
      else
        notify(
          hasRemaining === 0 ? 'Pago registrado' : `Pago registrado. Queda ${pesos(hasRemaining)}`,
        )
    })

  const voidPayment = (paymentId: string, reason: string) =>
    act(async () => {
      if (!shift) throw new Error('Abre la caja para anular un pago')
      await floor.recordConfirmed(
        'PaymentVoided',
        order.id,
        { payment_id: paymentId, register_shift_id: shift.id },
        { reason },
      )
      setVoiding(null)
      notify('Pago anulado')
    })

  // Why checkout is not possible here, if it is not.
  const noCheckout = !canCharge
    ? null
    : !online
      ? 'Sin conexión con el hub: para cobrar hace falta la red. Revisa el cable o el Wi-Fi.'
      : !shift
        ? 'La caja está cerrada: ábrela con la base para empezar a cobrar.'
        : shift.pendingConfirmation
          ? 'La caja se está abriendo: espera a que el hub lo confirme.'
          : null
  const openCheckout = (c: Charging) => {
    if (!noCheckout) setCharging(c)
  }

  const viewAmounts =
    mode === 'even'
      ? inEqualParts(order, people, rules, newId)
      : mode === 'products'
        ? byProducts(order, assignedChecks, checks, rules, newId).checks
        : []
  const unassignedView =
    mode === 'products' ? byProducts(order, assignedChecks, checks, rules, newId).unassigned : 0
  // By products only before the first payment: afterwards what is left is split into equal parts.
  const byProductsPossible = totals.paid === 0

  const tapItem = (id: string, check: number) =>
    setAssignedChecks((a) => {
      const b = new Map(a)
      const currentChecks = b.get(id) ?? []
      const nextChecks = currentChecks.includes(check)
        ? currentChecks.filter((c) => c !== check)
        : [...currentChecks, check].sort((x, y) => x - y)
      if (nextChecks.length === 0) b.delete(id)
      else b.set(id, nextChecks)
      return b
    })

  return (
    <FloorFrame title={`Cuenta · ${title}`} back={backToOrder}>
      <div className="mx-auto grid max-w-5xl gap-4 p-3 pb-28 md:grid-cols-[1fr_24rem] md:p-5">
        <section
          className="rounded-2xl border border-divider bg-surface shadow-float"
          aria-label="Precuenta"
        >
          <ul>
            {lines.map((l) => (
              <li key={l.id} className="border-b border-divider px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className="figures w-6 font-semibold">{l.quantity}</span>
                  <span className="flex-1">
                    <span className="font-semibold">{l.name}</span>
                    {l.options.length > 0 && (
                      <span className="block text-sm text-muted">{l.options.join(' · ')}</span>
                    )}
                  </span>
                  <span className="figures">{pesos(l.net)}</span>
                </div>
                {mode === 'products' && byProductsPossible && !order.checks && (
                  <Group label={`Quién paga ${l.name}`} className="mt-2 flex flex-wrap gap-2 pl-9">
                    {Array.from({ length: checks }, (_, c) => (
                      <Option
                        // biome-ignore lint/suspicious/noArrayIndexKey: the checks are positions
                        key={c}
                        selected={assignedChecks.get(l.id)?.includes(c) ?? false}
                        onChoose={() => tapItem(l.id, c)}
                      >
                        {`Cuenta ${c + 1}`}
                      </Option>
                    ))}
                  </Group>
                )}
              </li>
            ))}
            {lines.length === 0 && (
              <li className="p-4 text-muted">El pedido no tiene productos.</li>
            )}
          </ul>
          <dl className="figures grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 p-4">
            {taxes.length > 0 && (
              <>
                <dt className="text-muted">Base sin impuestos</dt>
                <dd className="text-right text-muted">
                  {pesos(taxes.reduce((a, i) => a + i.base, 0))}
                </dd>
                {taxes
                  .filter((i) => i.tax > 0)
                  .map((i) => (
                    <div key={`${i.type}${i.rate}`} className="contents">
                      <dt className="text-muted">{taxName(i.type, i.rate)}</dt>
                      <dd className="text-right text-muted">{pesos(i.tax)}</dd>
                    </div>
                  ))}
              </>
            )}
            <dt className="font-semibold">Total</dt>
            <dd className="text-right font-semibold">{pesos(totals.net)}</dd>
            {totals.paid > 0 && (
              <>
                <dt className="text-free-text">Ya pagado</dt>
                <dd className="text-right text-free-text">{`-${pesos(totals.paid)}`}</dd>
                <dt className="font-semibold">Saldo</dt>
                <dd className="text-right font-semibold">{pesos(balance)}</dd>
              </>
            )}
            {balance > 0 && (
              <>
                <dt className="flex items-center gap-2 text-muted">
                  {selectedTip === null
                    ? `Propina sugerida (${rules.suggestedTip / 100} %, voluntaria)`
                    : 'Propina (voluntaria)'}
                  <Button
                    variant="ghost"
                    className="min-h-10! px-2! text-sm"
                    onClick={() => setEditingTip((v) => !v)}
                  >
                    Cambiar
                  </Button>
                </dt>
                <dd className="self-center text-right text-muted">{pesos(shownTip)}</dd>
                <dt className="font-heading text-2xl font-bold">
                  {shownTip > 0 ? 'Con propina' : 'A pagar'}
                </dt>
                <dd className="font-heading text-right text-2xl font-bold">
                  {pesos(balance + shownTip)}
                </dd>
              </>
            )}
          </dl>
          {editingTip && balance > 0 && (
            <div className="mx-4 mb-4 flex flex-col gap-2 rounded-xl bg-surface-2/60 p-3">
              <Group label="Propina" className="flex flex-wrap gap-2">
                <Option
                  selected={selectedTip === null}
                  onChoose={() => {
                    setSelectedTip(null)
                    setEditingTip(false)
                  }}
                >
                  {`${rules.suggestedTip / 100} % (sugerida) · ${pesos(balanceTip)}`}
                </Option>
                {rules.suggestedTip !== 500 && (
                  <Option
                    selected={selectedTip === tipFive}
                    onChoose={() => {
                      setSelectedTip(tipFive)
                      setEditingTip(false)
                    }}
                  >
                    {`5 % · ${pesos(tipFive)}`}
                  </Option>
                )}
                <Option
                  selected={selectedTip === 0}
                  onChoose={() => {
                    setSelectedTip(0)
                    setEditingTip(false)
                  }}
                >
                  Sin propina
                </Option>
              </Group>
              <label>
                <span className="text-sm font-semibold">Otro valor</span>
                <input
                  inputMode="numeric"
                  className={`${fieldClass} figures mt-1`}
                  value={selectedTip ? withDots(selectedTip) : ''}
                  placeholder="0"
                  onChange={(e) => setSelectedTip(digitsOnly(e.target.value))}
                  onKeyDown={(e) => e.key === 'Enter' && setEditingTip(false)}
                />
              </label>
            </div>
          )}
          {payments.length > 0 && (
            <div className="border-t border-divider p-4">
              <h2 className="mb-2 font-semibold">Pagos</h2>
              <ul className="figures flex flex-col gap-2">
                {payments.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {methodName(p.method, p.customMethodId, rules)}
                      {p.checkId &&
                        ` · ${splitChecks.find((c) => c.id === p.checkId)?.name ?? 'Cuenta'}`}
                    </span>
                    <span className="flex items-center gap-2 text-right">
                      {pesos(p.amount)}
                      {p.tip > 0 && ` + propina ${pesos(p.tip)}`}
                      {p.roundingAdjustment !== 0 &&
                        ` (redondeo ${p.roundingAdjustment > 0 ? '+' : ''}${pesos(p.roundingAdjustment)})`}
                      {canVoidPayment && shift && online && (
                        <Button variant="ghost" onClick={() => setVoiding(p.id)}>
                          Anular
                        </Button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              {lastChange !== null && lastChange > 0 && (
                <p className="mt-3 rounded-xl bg-free-soft p-3 text-free-text">
                  <span className="block">Cambio a entregar</span>
                  <span className="figures text-3xl font-bold">{pesos(lastChange)}</span>
                </p>
              )}
            </div>
          )}
        </section>

        {/* On the phone, actions go on top, before the list (the thumb does not reach down). */}
        <section
          className="order-first flex flex-col gap-3 md:order-none"
          aria-label="Cómo se paga"
        >
          <Button
            variant="secondary"
            large
            icon="receipt"
            disabled={taken || balance === 0}
            onClick={() => print(null, balance, shownTip)}
          >
            {rules.printsPreBill ? 'Imprimir precuenta' : 'Pidió la cuenta'}
          </Button>
          {!rules.printsPreBill && (
            <p className="text-sm text-muted">
              Sin impresora de precuentas: muéstrale esta pantalla al cliente.
            </p>
          )}

          {balance === 0 && canClose && (
            <Button
              variant="main"
              large
              icon="check"
              disabled={taken || !online}
              onClick={() => act(() => close(lastChange))}
            >
              Cerrar la mesa
            </Button>
          )}

          {unsent > 0 && (
            <div className="rounded-xl bg-progress-soft p-3 text-progress-text">
              <p>
                {unsent === 1
                  ? 'Hay 1 producto que no se ha enviado a cocina.'
                  : `Hay ${unsent} productos que no se han enviado a cocina.`}
              </p>
              <Button className="mt-2" onClick={() => navigate(backToOrder)}>
                Volver al pedido
              </Button>
            </div>
          )}

          {!canCharge && balance > 0 && (
            <p className="text-sm text-muted">El cobro lo hace la caja.</p>
          )}

          {noCheckout && (
            <div className="rounded-xl bg-progress-soft p-3 text-progress-text">
              <p>{noCheckout}</p>
              {!shift && online && (
                <Button
                  className="mt-2"
                  onClick={() =>
                    navigate(`/register?back=${encodeURIComponent(`/check?order=${order.id}`)}`)
                  }
                >
                  Abrir la caja
                </Button>
              )}
            </div>
          )}

          {order.checks ? (
            <SplitChecks
              checks={splitChecks}
              unassigned={unassigned}
              canCharge={canCharge && !noCheckout}
              canUndo={canSplit && !payments.some((p) => p.checkId !== null)}
              taken={taken}
              onCharge={openCheckout}
              onPrint={(c) => print(c.id, c.balance, c.pendingTip)}
              onUndo={undo}
            />
          ) : (
            <>
              {canSplit && balance > 0 && (
                <Group label="Cómo se paga" className="grid grid-cols-3 gap-2">
                  {(
                    [
                      ['single', 'Una cuenta'],
                      ['even', 'Partes iguales'],
                      ['products', 'Por productos'],
                    ] as const
                  ).map(([m, text]) => (
                    <Option key={m} shape="card" selected={mode === m} onChoose={() => setMode(m)}>
                      {text}
                    </Option>
                  ))}
                </Group>
              )}
              {mode === 'single' && canCharge && balance > 0 && (
                <Button
                  variant="main"
                  large
                  icon="bill"
                  disabled={!!noCheckout || taken}
                  onClick={() =>
                    openCheckout({
                      checkId: null,
                      name: title,
                      available: balance,
                      check: null,
                      initialTip: selectedTip,
                    })
                  }
                >
                  {`Cobrar ${pesos(balance)}`}
                </Button>
              )}
              {mode === 'even' && (
                <Accountant
                  name="Personas"
                  value={people}
                  minimum={2}
                  maximum={20}
                  onChange={setPeople}
                />
              )}
              {mode === 'products' &&
                (byProductsPossible ? (
                  <>
                    <Accountant
                      name="Cuentas"
                      value={checks}
                      minimum={2}
                      maximum={10}
                      onChange={(n) => {
                        setChecks(n)
                        setAssignedChecks((a) => trimAssignments(a, n))
                      }}
                    />
                    <p className="text-sm text-muted">
                      Toca en cada producto quién lo paga. Si lo tocan dos o más, se reparte entre
                      ellos.
                    </p>
                  </>
                ) : (
                  <p className="rounded-xl bg-progress-soft p-3 text-progress-text">
                    Ya hay pagos: divide lo que queda en partes iguales.
                  </p>
                ))}
              {mode !== 'single' && (mode === 'even' || byProductsPossible) && (
                <>
                  <ul className="flex flex-col gap-2">
                    {viewAmounts.map((c) => (
                      <li
                        key={c.check_id}
                        className="figures flex justify-between rounded-xl border border-divider bg-surface p-3"
                      >
                        <span className="font-semibold">{c.name}</span>
                        <span>{`${pesos(c.amount)} + propina ${pesos(c.suggested_tip)}`}</span>
                      </li>
                    ))}
                    {unassignedView > 0 && (
                      <li className="figures flex justify-between rounded-xl bg-progress-soft p-3 text-progress-text">
                        <span>Sin asignar (se cobra aparte)</span>
                        <span className="font-semibold">{pesos(unassignedView)}</span>
                      </li>
                    )}
                  </ul>
                  <Button
                    variant="main"
                    large
                    disabled={taken || viewAmounts.every((c) => c.amount === 0)}
                    onClick={() => split(viewAmounts)}
                  >
                    {`Dividir en ${viewAmounts.length}`}
                  </Button>
                </>
              )}
            </>
          )}
        </section>
      </div>

      <CheckoutPanel
        charging={charging}
        order={order}
        rules={rules}
        cardTerminals={catalog.cardTerminals ?? []}
        taken={taken}
        onClose={() => setCharging(null)}
        onCharge={charge}
      />
      <VoidPaymentPanel
        key={voiding ?? 'ninguno'}
        paymentId={voiding}
        taken={taken}
        onClose={() => setVoiding(null)}
        onVoid={voidPayment}
      />
    </FloorFrame>
  )
}

function SplitChecks({
  checks,
  unassigned,
  canCharge,
  canUndo,
  taken,
  onCharge,
  onPrint,
  onUndo,
}: {
  checks: ReturnType<typeof outstanding>['checks']
  unassigned: number
  canCharge: boolean
  canUndo: boolean
  taken: boolean
  onCharge: (c: Charging) => void
  onPrint: (c: ReturnType<typeof outstanding>['checks'][number]) => void
  onUndo: () => void
}) {
  return (
    <>
      <ul className="flex flex-col gap-2">
        {checks.map((c) => (
          <li
            key={c.id}
            className="flex flex-col gap-2 rounded-xl border border-divider bg-surface p-3"
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className="font-semibold">{c.name}</span>
              {c.balance === 0 ? (
                <Label tone="free" icon="check">
                  Pagada
                </Label>
              ) : (
                <span className="figures text-sm text-muted">{`${pesos(c.balance)} + propina ${pesos(c.pendingTip)}`}</span>
              )}
            </span>
            {c.balance > 0 && (
              <span className="flex gap-2">
                <Button
                  icon="receipt"
                  aria-label={`Precuenta de ${c.name}`}
                  disabled={taken}
                  onClick={() => onPrint(c)}
                >
                  Precuenta
                </Button>
                {canCharge && (
                  <Button
                    variant="main"
                    className="flex-1"
                    disabled={taken}
                    onClick={() =>
                      onCharge({
                        checkId: c.id,
                        name: c.name,
                        available: c.balance,
                        check: c,
                        initialTip: null,
                      })
                    }
                  >
                    {`Cobrar ${pesos(c.balance)}`}
                  </Button>
                )}
              </span>
            )}
          </li>
        ))}
        {unassigned > 0 && (
          <li className="flex flex-col gap-2 rounded-xl bg-progress-soft p-3 text-progress-text">
            <span className="figures flex justify-between">
              <span className="font-semibold">Sin asignar</span>
              <span>{pesos(unassigned)}</span>
            </span>
            {canCharge && (
              <Button
                variant="main"
                disabled={taken}
                onClick={() =>
                  onCharge({
                    checkId: null,
                    name: 'Sin asignar',
                    available: unassigned,
                    check: null,
                    initialTip: null,
                  })
                }
              >
                {`Cobrar ${pesos(unassigned)}`}
              </Button>
            )}
          </li>
        )}
      </ul>
      {canUndo && (
        <Button variant="ghost" disabled={taken} onClick={onUndo}>
          Deshacer la división
        </Button>
      )}
    </>
  )
}

function Accountant({
  name,
  value,
  minimum,
  maximum,
  onChange,
}: {
  name: string
  value: number
  minimum: number
  maximum: number
  onChange: (n: number) => void
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-divider bg-surface p-3">
      <span className="flex-1 font-semibold">{name}</span>
      <Button
        icon="minus"
        aria-label={`Quitar: quedan ${value - 1}`}
        disabled={value <= minimum}
        onClick={() => onChange(value - 1)}
      />
      <span className="figures w-8 text-center text-xl font-semibold">{value}</span>
      <Button
        icon="more"
        aria-label={`Agregar: quedan ${value + 1}`}
        disabled={value >= maximum}
        onClick={() => onChange(value + 1)}
      />
    </div>
  )
}

/** Void a misrecorded payment, with a reason. The reversal goes to this register's open shift. */
function VoidPaymentPanel({
  paymentId,
  taken,
  onClose,
  onVoid,
}: {
  paymentId: string | null
  taken: boolean
  onClose: () => void
  onVoid: (paymentId: string, reason: string) => void
}) {
  const [reason, setReason] = useState<string | null>(null)
  const [other, setOther] = useState('')
  const final = reason === 'other' ? other.trim() || null : reason
  return (
    <SidePanel
      opened={paymentId !== null}
      title="Anular el pago"
      onClose={onClose}
      footer={
        <Button
          variant="danger"
          large
          className="w-full"
          disabled={!final || taken}
          onClick={() => paymentId && final && onVoid(paymentId, final)}
        >
          Anular el pago
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p>El saldo vuelve a quedar por cobrar. Si fue en efectivo, devuelve el dinero.</p>
        <Group label="Motivo" className="flex flex-wrap gap-2">
          {PAYMENT_VOID_REASONS.map((m) => (
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
            // biome-ignore lint/a11y/noAutofocus: «Otro» was chosen precisely to type it
            autoFocus
            onChange={(e) => setOther(e.target.value)}
          />
        )}
      </div>
    </SidePanel>
  )
}
