import { useEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { digitsOnly, pesos, withDots } from '../ui/format'
import { Label } from '../ui/Label'
import { Group, Option } from '../ui/Options'
import { navigate, useRoute } from '../ui/route'
import { useNotify } from '../ui/toasts'
import { cardPayment, cashPayment, cashTip, tipOn } from './check'
import type { Method } from './data'
import { Frame } from './Frame'
import { changeTable, useRouteTable, useTables } from './state'
import { tableBalance, tableTotal } from './totals'

// Checkout at the register (brief §4.5, docs/DINERO.md#pagos). It charges the balance or the share
// of a split check (`?amount=`); cash is rounded to $100 only on the payment that leaves a balance
// of 0. The cash tip is suggested rounded and can be changed; if the customer leaves the change, it
// becomes tip. Recording a payment is a money action: it asks for confirmation (brief §5, rule 5).
// Shortcuts: F2 cash, F3 card, Enter charges, Esc cancels.

const BILLS = [20_000, 50_000, 100_000]

export function Checkout() {
  const number = useRouteTable(12)
  const { params } = useRoute()
  const table = useTables().find((m) => m.number === number)
  const notify = useNotify()

  const balance = table ? tableBalance(table) : 0
  const order = digitsOnly(params.get('amount') ?? '')
  const amount = order > 0 && order <= balance ? order : balance
  const suggested = params.has('tip') ? digitsOnly(params.get('tip') ?? '') : tipOn(amount)

  const [method, setMethod] = useState<Method>('cash')
  const [tip, setTip] = useState(() => cashTip(suggested))
  const [tendered, setTendered] = useState<number | null>(null)
  const [approval_code, setApprovalCode] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [lastChange, setLastChange] = useState<number | null>(null)
  const confirm = useRef<HTMLButtonElement>(null)

  const selectMethod = (m: Method) => {
    setMethod(m)
    setTip(m === 'cash' ? cashTip(suggested) : suggested)
    setTendered(null)
    setConfirming(false)
  }

  const cash = amount > 0 ? cashPayment({ balance, amount, tip, tendered: 0 }) : null
  // By default, the customer hands over exactly the amount to charge (one tap less).
  const served = tendered ?? cash?.amountDue ?? 0
  const calculation = amount > 0 ? cashPayment({ balance, amount, tip, tendered: served }) : null
  const card = amount > 0 ? cardPayment({ balance, amount, tip }) : null
  const toCharge = method === 'cash' ? (calculation?.amountDue ?? 0) : (card?.approved ?? 0)
  const can =
    amount > 0 && (method === 'cash' ? calculation?.missing === 0 : /^\d{4,8}$/.test(approval_code))

  const record = () => {
    if (!table || !calculation || !can) return
    const payment =
      method === 'cash'
        ? {
            method,
            amount,
            adjustment: calculation.adjustment,
            tip,
            tendered: served,
            change: calculation.change,
          }
        : { method, amount, adjustment: 0, tip, tendered: null, change: null }
    const closes = amount === balance
    changeTable(number, (m) => ({
      ...m,
      payments: [...m.payments, payment],
      status: closes ? 'dirty' : m.status,
    }))
    setConfirming(false)
    setLastChange(method === 'cash' ? calculation.change : null)
    if (closes) {
      // The table closes by itself when it reaches 0: one tap less. The close can be undone.
      notify(`Mesa ${number} pagada y cerrada`, () =>
        changeTable(number, (m) => ({ ...m, status: 'preBill' })),
      )
    } else {
      notify(`Pago registrado. Queda ${pesos(balance - amount)}`)
      navigate(`/mockups/pre-bill?table=${number}`)
    }
  }

  // When asking for confirmation, focus goes to "Confirmar": Enter confirms; Tab and Enter on
  // "Cancelar" cancels (the shortcut never beats the button that has focus).
  useEffect(() => {
    if (confirming) confirm.current?.focus()
  }, [confirming])

  const hotkeys = useRef<(e: KeyboardEvent) => void>(() => {})
  hotkeys.current = (e: KeyboardEvent) => {
    if (e.repeat) return
    const onButton = (e.target as HTMLElement | null)?.closest('button, a')
    if (e.key === 'F2' || e.key === 'F3') {
      e.preventDefault()
      selectMethod(e.key === 'F2' ? 'cash' : 'card')
    } else if (e.key === 'Escape') setConfirming(false)
    else if (e.key === 'Enter' && !onButton && can) {
      e.preventDefault()
      if (confirming) record()
      else setConfirming(true)
    }
  }
  useEffect(() => {
    const onKeystroke = (e: KeyboardEvent) => hotkeys.current(e)
    window.addEventListener('keydown', onKeystroke)
    return () => window.removeEventListener('keydown', onKeystroke)
  }, [])

  if (!table) return null
  const total = tableTotal(table)

  return (
    <Frame title={`Cobro · Mesa ${number}`} user="Caja" back={`/mockups/pre-bill?table=${number}`}>
      <div className="mx-auto grid max-w-4xl gap-4 p-3 md:grid-cols-2">
        <section className="rounded-2xl border border-borde bg-superficie p-4" aria-label="Saldo">
          <p className="text-texto-suave">Saldo pendiente</p>
          <p
            className={`cifras font-titulo text-5xl font-bold ${balance === 0 ? 'text-libre-texto' : ''}`}
          >
            {pesos(balance)}
          </p>
          <p className="cifras mt-1 text-texto-suave">{`de ${pesos(total)}`}</p>
          {amount > 0 && amount < balance && (
            <p className="mt-2">
              <Label tone="action" icon="people">{`Esta cuenta: ${pesos(amount)}`}</Label>
            </p>
          )}
          {lastChange !== null && (
            <p className="mt-4 rounded-xl bg-libre-suave p-3 text-libre-texto">
              <span className="block">Cambio a entregar</span>
              <span className="cifras text-3xl font-bold">{pesos(lastChange)}</span>
            </p>
          )}
          {table.payments.length > 0 && (
            <ul className="cifras mt-4 flex flex-col gap-1 border-t border-borde pt-3">
              {table.payments.map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: payments are never reordered
                <li key={i} className="flex justify-between gap-2">
                  <span className="capitalize">{p.method}</span>
                  <span className="text-right">
                    {pesos(p.amount)}
                    {p.tip > 0 && ` + propina ${pesos(p.tip)}`}
                    {p.adjustment !== 0 &&
                      ` (redondeo ${p.adjustment > 0 ? '+' : ''}${pesos(p.adjustment)})`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {balance === 0 && (
            <Button
              variant="secondary"
              large
              className="mt-6 w-full"
              onClick={() => navigate('/mockups/floor-plan')}
            >
              Volver al salón
            </Button>
          )}
        </section>

        {amount > 0 && (
          <section className="flex flex-col gap-3" aria-label="Pago">
            <Group label="Medio de pago" className="grid grid-cols-2 gap-2">
              {(
                [
                  ['cash', 'Efectivo', 'F2'],
                  ['card', 'Tarjeta', 'F3'],
                ] as const
              ).map(([m, text, hotkey]) => (
                <Option
                  key={m}
                  shape="card"
                  selected={method === m}
                  onChoose={() => selectMethod(m)}
                  detail={hotkey}
                >
                  {text}
                </Option>
              ))}
            </Group>

            <div className="rounded-2xl border border-borde bg-superficie p-4">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">Propina (voluntaria)</span>
                <span className="cifras text-sm text-texto-suave">{`sugerida ${pesos(suggested)}`}</span>
              </div>
              <input
                inputMode="numeric"
                aria-label="Propina"
                value={withDots(tip)}
                onChange={(e) => setTip(digitsOnly(e.target.value))}
                placeholder="0"
                className="cifras mt-2 min-h-12 w-full rounded-xl border border-borde bg-superficie px-3 text-xl focus-visible:outline-3 focus-visible:outline-foco"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <Button onClick={() => setTip(method === 'cash' ? cashTip(suggested) : suggested)}>
                  Sugerida
                </Button>
                <Button onClick={() => setTip(0)}>Sin propina</Button>
              </div>
            </div>

            {method === 'cash' && calculation ? (
              <div className="rounded-2xl border border-borde bg-superficie p-4">
                <p className="text-texto-suave">
                  {amount === balance
                    ? 'A cobrar (venta redondeada a $100 + propina)'
                    : 'A cobrar (venta + propina)'}
                </p>
                <p className="cifras font-titulo text-3xl font-bold">
                  {pesos(calculation.amountDue)}
                </p>
                <label className="mt-3 block">
                  <span className="font-semibold">El cliente entrega</span>
                  <input
                    inputMode="numeric"
                    value={withDots(served)}
                    onChange={(e) => setTendered(digitsOnly(e.target.value))}
                    className="cifras mt-2 min-h-14 w-full rounded-xl border border-borde bg-superficie px-3 text-2xl focus-visible:outline-3 focus-visible:outline-foco"
                  />
                </label>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-2 lg:grid-cols-4">
                  <Button onClick={() => setTendered(null)}>Exacto</Button>
                  {BILLS.map((b) => (
                    <Button key={b} onClick={() => setTendered(b)}>
                      {`${b / 1000} mil`}
                    </Button>
                  ))}
                </div>
                <div className="cifras mt-3 flex flex-wrap items-center gap-2 text-lg">
                  {calculation.missing > 0 ? (
                    <Label
                      tone="warning"
                      icon="warning"
                    >{`Faltan ${pesos(calculation.missing)}`}</Label>
                  ) : (
                    <Label tone="free" icon="check">{`Cambio ${pesos(calculation.change)}`}</Label>
                  )}
                  {calculation.change > 0 && (
                    <Button onClick={() => setTip(tip + calculation.change)}>
                      Deja el cambio de propina
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-borde bg-superficie p-4">
                <p className="text-texto-suave">Total en el datáfono (venta + propina)</p>
                <p className="cifras font-titulo text-3xl font-bold">{pesos(toCharge)}</p>
                <label className="mt-3 block">
                  <span className="font-semibold">Número de aprobación</span>
                  <input
                    inputMode="numeric"
                    value={approval_code}
                    onChange={(e) => setApprovalCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                    className="cifras mt-2 min-h-14 w-full rounded-xl border border-borde bg-superficie px-3 text-2xl focus-visible:outline-3 focus-visible:outline-foco"
                  />
                </label>
              </div>
            )}

            {confirming ? (
              <div
                className="rounded-2xl border-2 border-accion-fuerte bg-accion-suave p-4 text-accion-texto"
                role="alertdialog"
                aria-labelledby="confirm-payment"
              >
                <p id="confirm-payment" className="mb-3 text-lg font-semibold">
                  {`¿Registrar ${pesos(toCharge)} en ${method}?`}
                </p>
                <div className="flex gap-2">
                  <Button onClick={() => setConfirming(false)}>Cancelar</Button>
                  <button
                    ref={confirm}
                    type="button"
                    className="inline-flex min-h-12 flex-1 items-center justify-center rounded-xl bg-accion-fuerte px-4 font-semibold text-white focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-foco"
                    onClick={record}
                  >
                    Confirmar
                  </button>
                </div>
              </div>
            ) : (
              <Button variant="main" large disabled={!can} onClick={() => setConfirming(true)}>
                {`Cobrar ${pesos(toCharge)}`}
              </Button>
            )}
            <p className="text-sm text-texto-suave">
              Teclado: F2 efectivo · F3 tarjeta · Enter cobra · Esc cancela
            </p>
          </section>
        )}
      </div>
    </Frame>
  )
}
