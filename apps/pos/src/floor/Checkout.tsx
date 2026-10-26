import { newId, type OrderState, type PaymentMethod } from '@pos/core'
import type { Catalog } from '@pos/sync'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { digitsOnly, pesos, withDots } from '../ui/format'
import { Label } from '../ui/Label'
import { Group, Option } from '../ui/Options'
import { SidePanel } from '../ui/SidePanel'
import {
  type CheckoutOption,
  type CheckoutRules,
  cashPayment,
  cashTip,
  checkoutOptions,
  paymentTip,
  tipWithPercent,
} from './checks'
import { fieldClass } from './SignIn'

// Recording a payment (brief §4.5, docs/DINERO.md#pagos): the method (card, as credit or
// debit, and the restaurant's custom methods), the tip (the suggested one already selected;
// changed by percentage or by value) and, only in cash, what the guest hands over and their
// change. With digital methods the exact amount is always charged. Cash is rounded only in the
// payment that leaves the check at 0. Recording money asks for confirmation (brief §5, rule 5).

const CARD_TERMINAL_KEY = 'pos-last-card-terminal'

const PROVIDER: Record<string, string> = {
  bold: 'Bold',
  redeban: 'Redeban',
  credibanco: 'Credibanco',
}

const remembered = () => {
  try {
    return localStorage.getItem(CARD_TERMINAL_KEY)
  } catch {
    return null
  }
}
const remember = (id: string) => {
  try {
    localStorage.setItem(CARD_TERMINAL_KEY, id)
  } catch {}
}

/** What is charged: a check of the split, what did not end up in any, or the whole balance. */
export interface Charging {
  checkId: string | null
  name: string
  /** What that check (or the order) still owes: the payment's cap. */
  available: number
  /** The check of the split being charged (its amount and its tip), or null. */
  check: { amount: number; suggestedTip: number } | null
  /** The tip the guest asked for on the pre-bill (no tip, another value), or null. */
  initialTip: number | null
}

/** The `PaymentRecorded` data without the shift (whoever records it sets it). */
export interface NewPayment {
  payment_id: string
  check_id: string | null
  method: PaymentMethod
  amount: number
  tip: number
  tendered: number | null
  change: number | null
  rounding_adjustment: number
  rounding: { multiple: number; mode: CheckoutRules['cashRoundingMode'] } | null
  cardTerminal: {
    card_terminal_id: string
    franchise: null
    last4: null
    approval_code: null
    receipt: null
    card_type: 'credit' | 'debit' | null
  } | null
  charge_reference: null
  custom_method_id: string | null
}

/** How the tip was chosen: the suggested one, another percentage or a fixed value. */
type Choice =
  | { type: 'suggested' }
  | { type: 'percent'; points: number }
  | { type: 'value'; pesos: number }

const percent = (points: number) => `${`${points / 100}`.replace('.', ',')} %`

export function CheckoutPanel({
  charging,
  order,
  rules,
  cardTerminals,
  taken,
  onClose,
  onCharge,
}: {
  charging: Charging | null
  order: OrderState
  rules: CheckoutRules
  cardTerminals: NonNullable<Catalog['cardTerminals']>
  taken: boolean
  onClose: () => void
  onCharge: (payment: NewPayment) => void
}) {
  if (!charging)
    return (
      <SidePanel opened={false} title="Cobrar" onClose={onClose}>
        {null}
      </SidePanel>
    )
  return (
    <CheckoutForm
      key={`${charging.checkId}-${charging.available}`}
      charging={charging}
      order={order}
      rules={rules}
      cardTerminals={cardTerminals}
      taken={taken}
      onClose={onClose}
      onCharge={onCharge}
    />
  )
}

function CheckoutForm({
  charging,
  order,
  rules,
  cardTerminals,
  taken,
  onClose,
  onCharge,
}: {
  charging: Charging
  order: OrderState
  rules: CheckoutRules
  cardTerminals: NonNullable<Catalog['cardTerminals']>
  taken: boolean
  onClose: () => void
  onCharge: (payment: NewPayment) => void
}) {
  // The same id on every attempt: if the hub is slow and it is retried, there is no double payment.
  const [paymentId] = useState(newId)
  const options = checkoutOptions(rules)
  const { available } = charging
  const [key, setKey] = useState(options[0]?.key ?? 'cash')
  const option: CheckoutOption =
    options.find((o) => o.key === key) ??
    ({
      key: 'cash',
      name: 'Efectivo',
      method: 'cash',
      cardType: null,
      customMethodId: null,
    } as const)
  const isCash = option.method === 'cash'
  const [amount, setAmount] = useState(available)
  const [choice, setChoice] = useState<Choice>(() =>
    charging.initialTip !== null
      ? { type: 'value', pesos: charging.initialTip }
      : { type: 'suggested' },
  )
  // Typing another value: in pesos or as a percentage.
  const [inPercent, setInPercent] = useState(false)
  const [tendered, setTendered] = useState<number | null>(null)
  // One card terminal per provider: those from the same provider deliver a single settlement
  // (Bold joins all of its own), so it does not matter which one the card went through. It is only
  // chosen if there are different providers (Bold and Redeban), because each one is reconciled
  // separately at close.
  const latest = remembered()
  const byProvider = [
    ...cardTerminals
      .reduce((groups, d) => {
        // «Otro» does not say which: each of those goes separately.
        const key = d.provider && d.provider !== 'other' ? d.provider : d.id
        const current = groups.get(key)
        if (!current || d.id === latest) groups.set(key, d)
        return groups
      }, new Map<string, (typeof cardTerminals)[number]>())
      .entries(),
  ].map(([key, d]) => ({ id: d.id, name: PROVIDER[key] ?? d.name }))
  const [cardTerminal, setCardTerminal] = useState(
    () => byProvider.find((d) => d.id === latest)?.id ?? byProvider[0]?.id ?? null,
  )
  const [confirming, setConfirming] = useState(false)
  const confirm = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (confirming) confirm.current?.focus()
  }, [confirming])

  const validAmount = amount > 0 && amount <= available
  const value = validAmount ? amount : 0
  /** The tip with a percentage; in cash, rounded to pay it with bills. */
  const withPercent = (points: number) => {
    const exact =
      points === rules.suggestedTip
        ? paymentTip(order, charging.check, available, value, rules)
        : tipWithPercent(order, available, value, points, rules)
    return isCash ? cashTip(exact, rules) : exact
  }
  const tip =
    choice.type === 'value'
      ? choice.pesos
      : withPercent(choice.type === 'suggested' ? rules.suggestedTip : choice.points)
  const select = (e: Choice) => {
    setChoice(e)
    setConfirming(false)
  }
  const quickTips = [...new Set([0, 500, rules.suggestedTip])].sort((a, b) => a - b)

  const selectOption = (o: CheckoutOption) => {
    setKey(o.key)
    setTendered(null)
    setConfirming(false)
  }

  const cash = validAmount
    ? cashPayment({ balance: available, amount, tip, tendered: 0 }, rules)
    : null
  // By default, the guest hands over exactly what has to be charged (one tap less).
  const served = tendered ?? cash?.amountDue ?? 0
  const calculation = validAmount
    ? cashPayment({ balance: available, amount, tip, tendered: served }, rules)
    : null
  const toCharge = isCash ? (calculation?.amountDue ?? 0) : amount + tip
  const noCardTerminal = option.method === 'card' && cardTerminal === null
  const can = validAmount && !taken && !noCardTerminal && (!isCash || calculation?.missing === 0)

  const record = () => {
    if (!can || !calculation) return
    if (option.method === 'card' && cardTerminal) remember(cardTerminal)
    onCharge({
      payment_id: paymentId,
      check_id: charging.checkId,
      method: option.method,
      amount,
      tip,
      tendered: isCash ? served : null,
      change: isCash ? calculation.change : null,
      rounding_adjustment: isCash ? calculation.adjustment : 0,
      rounding: isCash ? calculation.rounding : null,
      cardTerminal:
        option.method === 'card' && cardTerminal
          ? {
              card_terminal_id: cardTerminal,
              franchise: null,
              last4: null,
              approval_code: null,
              receipt: null,
              card_type: option.cardType,
            }
          : null,
      charge_reference: null,
      custom_method_id: option.customMethodId,
    })
  }

  const cardTerminalName = byProvider.find((d) => d.id === cardTerminal)?.name
  const where =
    option.method === 'card' && cardTerminalName && byProvider.length > 1
      ? `${option.name.toLowerCase()} (${cardTerminalName})`
      : option.name.toLowerCase()

  // Register shortcuts (task 0.9): F2 cash, F3 credit, F4 debit, Enter charges and Esc goes back.
  // The shortcut never beats the button that has focus.
  const shortcut: Record<string, string> = { F2: 'cash', F3: 'credit', F4: 'debit' }
  // Shortcuts are only announced where there is a mouse and keyboard (the register); on the
  // phone they get in the way.
  const [withKeyboard] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches,
  )
  const hotkeys = useRef<(e: KeyboardEvent) => void>(() => {})
  hotkeys.current = (e: KeyboardEvent) => {
    if (e.repeat) return
    const onButton = (e.target as HTMLElement | null)?.closest('button, a')
    const fromShortcut = options.find((o) => o.key === shortcut[e.key])
    if (fromShortcut) {
      e.preventDefault()
      selectOption(fromShortcut)
    } else if (e.key === 'Escape' && confirming) {
      e.preventDefault()
      e.stopPropagation()
      setConfirming(false)
    } else if (e.key === 'Enter' && !onButton && can) {
      e.preventDefault()
      if (confirming) record()
      else setConfirming(true)
    }
  }
  useEffect(() => {
    const onKeystroke = (e: KeyboardEvent) => hotkeys.current(e)
    window.addEventListener('keydown', onKeystroke, true)
    return () => window.removeEventListener('keydown', onKeystroke, true)
  }, [])

  const footer = confirming ? (
    <div
      className="rounded-2xl border-2 border-accion-fuerte bg-accion-suave p-3 text-accion-texto"
      role="alertdialog"
      aria-labelledby="confirm-payment"
    >
      <p id="confirm-payment" className="mb-3 text-lg font-semibold">
        {`¿Registrar ${pesos(toCharge)} en ${where}?`}
      </p>
      <div className="flex gap-2">
        <Button onClick={() => setConfirming(false)}>Volver</Button>
        <button
          ref={confirm}
          type="button"
          disabled={taken}
          className="inline-flex min-h-12 flex-1 items-center justify-center rounded-xl bg-accion-fuerte px-4 font-semibold text-white focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-foco disabled:opacity-60"
          onClick={record}
        >
          {taken ? 'Registrando…' : `Sí, registrar ${pesos(toCharge)}`}
        </button>
      </div>
    </div>
  ) : (
    <Button
      variant="main"
      large
      className="w-full"
      disabled={!can}
      onClick={() => setConfirming(true)}
    >
      {`Cobrar ${pesos(toCharge)}`}
    </Button>
  )

  return (
    <SidePanel opened title={`Cobrar · ${charging.name}`} onClose={onClose} footer={footer}>
      <div className="flex flex-col gap-4">
        <section
          className="rounded-2xl border border-linea bg-superficie-2/60 p-4"
          aria-label="Saldo"
        >
          <p className="text-texto-suave">Por cobrar</p>
          <p className="cifras font-titulo text-4xl font-bold">{pesos(available)}</p>
          <label className="mt-3 block">
            <span className="font-semibold">Valor de este pago</span>
            <input
              inputMode="numeric"
              className={`${fieldClass} cifras mt-1 text-xl`}
              value={withDots(amount)}
              onChange={(e) => {
                setAmount(Math.min(digitsOnly(e.target.value), available))
                setTendered(null)
                setConfirming(false)
              }}
            />
          </label>
          {amount < available && amount > 0 && (
            <p className="mt-2 text-sm text-texto-suave">
              {`Pago parcial: quedan ${pesos(available - amount)} por cobrar.`}
            </p>
          )}
        </section>

        <Group label="Medio de pago" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {options.map((o) => (
            <Option
              key={o.key}
              shape="card"
              selected={key === o.key}
              onChoose={() => selectOption(o)}
              detail={(() => {
                const hotkey = Object.keys(shortcut).find((k) => shortcut[k] === o.key)
                return withKeyboard && hotkey ? `Tecla ${hotkey}` : undefined
              })()}
            >
              {o.name}
            </Option>
          ))}
        </Group>

        <section className="rounded-2xl border border-linea bg-superficie p-4" aria-label="Propina">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-semibold">Propina (voluntaria)</span>
            <span className="cifras font-titulo text-2xl font-bold">{pesos(tip)}</span>
          </div>
          <Group label="Propina" className="mt-3 flex flex-wrap gap-2">
            {quickTips.map((p) => {
              const selected =
                p === 0
                  ? choice.type === 'value' && choice.pesos === 0
                  : p === rules.suggestedTip
                    ? choice.type === 'suggested'
                    : choice.type === 'percent' && choice.points === p
              return (
                <Option
                  key={p}
                  selected={selected}
                  onChoose={() =>
                    select(
                      p === 0
                        ? { type: 'value', pesos: 0 }
                        : p === rules.suggestedTip
                          ? { type: 'suggested' }
                          : { type: 'percent', points: p },
                    )
                  }
                >
                  {p === 0
                    ? 'Sin propina'
                    : p === rules.suggestedTip
                      ? `${percent(p)} (sugerida)`
                      : percent(p)}
                </Option>
              )
            })}
          </Group>
          <div className="mt-3 flex items-end gap-2">
            <label className="min-w-0 flex-1">
              <span className="text-sm font-semibold">
                {inPercent ? 'Otro porcentaje' : 'Otro valor'}
              </span>
              <input
                inputMode="numeric"
                className={`${fieldClass} cifras mt-1`}
                placeholder={inPercent ? 'Ej. 12' : 'Ej. 5.000'}
                value={
                  inPercent
                    ? choice.type === 'percent' && !quickTips.includes(choice.points)
                      ? String(choice.points / 100)
                      : ''
                    : choice.type === 'value' && choice.pesos > 0
                      ? withDots(choice.pesos)
                      : ''
                }
                onChange={(e) => {
                  const n = digitsOnly(e.target.value)
                  if (inPercent) select({ type: 'percent', points: Math.min(n, 100) * 100 })
                  else select({ type: 'value', pesos: n })
                }}
              />
            </label>
            <Group label="Escribir en" className="flex gap-1">
              <Option selected={!inPercent} onChoose={() => setInPercent(false)}>
                $
              </Option>
              <Option selected={inPercent} onChoose={() => setInPercent(true)}>
                %
              </Option>
            </Group>
          </div>
        </section>

        {isCash && calculation && (
          <section
            className="rounded-2xl border border-linea bg-superficie p-4"
            aria-label="Efectivo"
          >
            <p className="text-texto-suave">
              {calculation.adjustment !== 0
                ? `A cobrar (venta redondeada a ${pesos(rules.cashRounding)} + propina)`
                : 'A cobrar (venta + propina)'}
            </p>
            <p className="cifras font-titulo text-3xl font-bold">{pesos(calculation.amountDue)}</p>
            <label className="mt-3 block">
              <span className="font-semibold">El cliente entrega</span>
              <input
                inputMode="numeric"
                className={`${fieldClass} cifras mt-1 min-h-14 text-2xl`}
                value={withDots(served)}
                onChange={(e) => {
                  setTendered(digitsOnly(e.target.value))
                  setConfirming(false)
                }}
              />
            </label>
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
                <Button onClick={() => select({ type: 'value', pesos: tip + calculation.change })}>
                  Deja el cambio de propina
                </Button>
              )}
            </div>
          </section>
        )}

        {!isCash && (
          <section
            className="rounded-2xl border border-linea bg-superficie p-4"
            aria-label="A cobrar"
          >
            <p className="text-texto-suave">
              {option.method === 'card'
                ? 'Total en el datáfono (venta + propina)'
                : `A cobrar por ${option.name} (venta + propina)`}
            </p>
            <p className="cifras font-titulo text-3xl font-bold">{pesos(toCharge)}</p>
            {option.method === 'card' &&
              (cardTerminals.length === 0 ? (
                <p className="mt-2 rounded-xl bg-proceso-suave p-3 text-proceso-texto">
                  No hay datáfonos: agrégalos en «Caja y pagos» para cobrar con tarjeta.
                </p>
              ) : (
                byProvider.length > 1 && (
                  <Group label="Datáfono" className="mt-3 flex flex-wrap gap-2">
                    {byProvider.map((d) => (
                      <Option
                        key={d.id}
                        selected={cardTerminal === d.id}
                        onChoose={() => setCardTerminal(d.id)}
                      >
                        {d.name}
                      </Option>
                    ))}
                  </Group>
                )
              ))}
            {option.method !== 'card' && (
              <p className="mt-2 text-sm text-texto-suave">
                Revisa que llegó antes de registrarlo.
              </p>
            )}
          </section>
        )}
      </div>
    </SidePanel>
  )
}
