import { useState } from 'react'
import { Button } from '../ui/Button'
import { pesos } from '../ui/format'
import { Group, Option } from '../ui/Options'
import { navigate } from '../ui/route'
import { useNotify } from '../ui/toasts'
import { byItems, checkTips, inEqualParts, lineNet, tipOn, trimAssignments } from './check'
import { Frame } from './Frame'
import { changeTable, useRouteTable, useTables } from './state'
import { currentOnes, itemName, lineOf, tableBalance, tableTotal } from './totals'

// Pre-bill and split (brief §4.5, docs/DINERO.md#división-de-la-cuenta). The BALANCE is split:
// what was already paid stays apart. The amounts and the tip of each check are calculated by
// `@pos/core`, and each check is charged separately.

type Mode = 'single' | 'even' | 'items'

export function PreBill() {
  const number = useRouteTable(12)
  const table = useTables().find((m) => m.number === number)
  const notify = useNotify()
  const [mode, setMode] = useState<Mode>('single')
  const [people, setPeople] = useState(2)
  const [checks, setChecks] = useState(2)
  // Item → checks that pay for it (more than one = shared in equal parts).
  const [assignedChecks, setAssignedChecks] = useState<Map<string, number[]>>(new Map())
  if (!table) return null

  const items = currentOnes(table)
  const total = tableTotal(table)
  const balance = tableBalance(table)
  const paid = total - balance
  const tip = tipOn(balance)
  // By items only before charging anything: afterwards, what is left is split in parts.
  const byItemsPossible = paid === 0

  const tapItem = (id: string, check: number) =>
    setAssignedChecks((a) => {
      const b = new Map(a)
      const currentChecks = b.get(id) ?? []
      const newOnes = currentChecks.includes(check)
        ? currentChecks.filter((c) => c !== check)
        : [...currentChecks, check].sort((x, y) => x - y)
      if (newOnes.length === 0) b.delete(id)
      else b.set(id, newOnes)
      return b
    })

  const changeChecks = (n: number) => {
    setChecks(n)
    setAssignedChecks((a) => trimAssignments(a, n))
  }

  const amounts =
    mode === 'even'
      ? inEqualParts(balance, people)
      : mode === 'items' && byItemsPossible
        ? byItems(items.map(lineOf), assignedChecks, checks).amounts
        : [balance]
  const unassigned =
    mode === 'items' && byItemsPossible
      ? byItems(items.map(lineOf), assignedChecks, checks).unassigned
      : 0
  const tips = checkTips(amounts)

  const charge = (amount: number, checkTip: number) =>
    navigate(`/mockups/checkout?table=${number}&amount=${amount}&tip=${checkTip}`)

  const actions = (
    <>
      <Button
        variant="secondary"
        large
        icon="receipt"
        className="flex-1"
        onClick={() => {
          changeTable(number, (m) => ({ ...m, status: 'preBill' }))
          notify('Precuenta enviada a la impresora')
        }}
      >
        Imprimir
      </Button>
      {mode === 'single' && (
        <Button
          variant="main"
          large
          icon="bill"
          className="flex-1"
          disabled={balance === 0}
          onClick={() => charge(balance, tip)}
        >
          {`Cobrar ${pesos(balance)}`}
        </Button>
      )}
    </>
  )

  return (
    <Frame title={`Precuenta · Mesa ${number}`} user="Caja" back="/mockups/floor-plan">
      <div className="mx-auto grid max-w-5xl gap-4 p-3 pb-28 md:grid-cols-[1fr_22rem] md:pb-3">
        <section className="rounded-2xl border border-border bg-surface" aria-label="Ítems">
          <ul>
            {items.map((i) => (
              <li key={i.id} className="border-b border-border px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className="figures w-6 font-semibold">{i.quantity}</span>
                  <span className="flex-1">
                    <span className="font-semibold">{itemName(i)}</span>
                    {i.options.length > 0 && (
                      <span className="block text-sm text-muted">
                        {i.options.map((o) => o.name).join(' · ')}
                      </span>
                    )}
                  </span>
                  <span className="figures">{pesos(lineNet(lineOf(i)))}</span>
                </div>
                {mode === 'items' && byItemsPossible && (
                  <Group
                    label={`Quién paga ${itemName(i)}`}
                    className="mt-2 flex flex-wrap gap-2 pl-9"
                  >
                    {Array.from({ length: checks }, (_, c) => (
                      <Option
                        // biome-ignore lint/suspicious/noArrayIndexKey: the checks are positions
                        key={c}
                        selected={assignedChecks.get(i.id)?.includes(c) ?? false}
                        onChoose={() => tapItem(i.id, c)}
                      >
                        {`Cuenta ${c + 1}`}
                      </Option>
                    ))}
                  </Group>
                )}
              </li>
            ))}
          </ul>
          <dl className="figures grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 p-4">
            <dt>Total</dt>
            <dd className="text-right">{pesos(total)}</dd>
            {paid > 0 && (
              <>
                <dt className="text-free-text">Ya pagado</dt>
                <dd className="text-right text-free-text">{`-${pesos(paid)}`}</dd>
                <dt className="font-semibold">Saldo</dt>
                <dd className="text-right font-semibold">{pesos(balance)}</dd>
              </>
            )}
            <dt className="text-muted">Propina sugerida (10 %, voluntaria)</dt>
            <dd className="text-right text-muted">{pesos(tip)}</dd>
            <dt className="font-heading text-2xl font-bold">Con propina</dt>
            <dd className="font-heading text-right text-2xl font-bold">{pesos(balance + tip)}</dd>
          </dl>
          <p className="px-4 pb-4 text-sm text-muted">Precios con INC incluido.</p>
        </section>

        <section className="flex flex-col gap-3" aria-label="Dividir">
          <Group label="Cómo se paga" className="grid grid-cols-3 gap-2">
            {(
              [
                ['single', 'Una cuenta'],
                ['even', 'Partes iguales'],
                ['items', 'Por ítems'],
              ] as const
            ).map(([m, text]) => (
              <Option key={m} shape="card" selected={mode === m} onChoose={() => setMode(m)}>
                {text}
              </Option>
            ))}
          </Group>

          {mode === 'even' && (
            <Accountant
              name="Personas"
              value={people}
              minimum={2}
              maximum={20}
              onChange={setPeople}
            />
          )}
          {mode === 'items' &&
            (byItemsPossible ? (
              <>
                <Accountant
                  name="Cuentas"
                  value={checks}
                  minimum={2}
                  maximum={10}
                  onChange={changeChecks}
                />
                <p className="text-sm text-muted">
                  Toca en cada ítem quién lo paga. Si lo tocan dos o más, se reparte entre ellos.
                </p>
              </>
            ) : (
              <p className="rounded-xl bg-progress-soft p-3 text-progress-text">
                Ya hay pagos: divide el saldo en partes iguales.
              </p>
            ))}

          {mode !== 'single' && (
            <ul className="flex flex-col gap-2">
              {amounts.map((amount, c) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: the checks are positions
                  key={c}
                  className="flex items-center gap-2 rounded-xl border border-border bg-surface p-2 pl-3"
                >
                  <span className="flex-1">
                    <span className="block font-semibold">{`Cuenta ${c + 1}`}</span>
                    <span className="figures text-sm text-muted">
                      {`${pesos(amount)} + propina ${pesos(tips[c] ?? 0)}`}
                    </span>
                  </span>
                  <Button
                    variant="main"
                    disabled={amount === 0}
                    onClick={() => charge(amount, tips[c] ?? 0)}
                  >
                    {`Cobrar ${pesos(amount)}`}
                  </Button>
                </li>
              ))}
              {unassigned > 0 && (
                <li className="figures flex justify-between rounded-xl bg-progress-soft p-3 text-progress-text">
                  <span>Sin asignar</span>
                  <span className="font-semibold">{pesos(unassigned)}</span>
                </li>
              )}
            </ul>
          )}

          <div className="hidden gap-2 md:flex">{actions}</div>
        </section>
      </div>

      {/* Phone: the actions at the bottom, within thumb reach. */}
      <div className="fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-border bg-surface p-3 md:hidden">
        {actions}
      </div>
    </Frame>
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
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-3">
      <span className="flex-1 font-semibold">{name}</span>
      <Button
        icon="minus"
        aria-label={`Quitar ${name.toLowerCase()}: quedan ${value - 1}`}
        disabled={value <= minimum}
        onClick={() => onChange(value - 1)}
      />
      <span className="figures w-8 text-center text-xl font-semibold">{value}</span>
      <Button
        icon="more"
        aria-label={`Agregar ${name.toLowerCase()}: quedan ${value + 1}`}
        disabled={value >= maximum}
        onClick={() => onChange(value + 1)}
      />
    </div>
  )
}
