import { useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { pesos } from '../ui/formato'
import { Grupo, Opcion } from '../ui/Opciones'
import { navegar } from '../ui/ruta'
import {
  enPartesIguales,
  netoLinea,
  porItems,
  propinaSobre,
  propinasDeCuentas,
  recortarAsignaciones,
} from './cuenta'
import { cambiarMesa, useMesaDeLaRuta, useMesas } from './estado'
import { Marco } from './Marco'
import { currentOnes, lineaDe, nombreItem, saldoMesa, totalMesa } from './totales'

// Precuenta y división (brief §4.5, docs/DINERO.md#división-de-la-cuenta). Se divide el SALDO: lo
// ya pagado queda aparte. Los montos y la propina de cada cuenta los calcula `@pos/core`, y cada
// cuenta se cobra por separado.

type Modo = 'single' | 'even' | 'items'

export function PreBill() {
  const number = useMesaDeLaRuta(12)
  const table = useMesas().find((m) => m.number === number)
  const notify = useAvisar()
  const [mode, setModo] = useState<Modo>('single')
  const [people, setPersonas] = useState(2)
  const [checks, setCuentas] = useState(2)
  // Ítem → cuentas que lo pagan (más de una = compartido en partes iguales).
  const [asignadas, setAsignadas] = useState<Map<string, number[]>>(new Map())
  if (!table) return null

  const items = currentOnes(table)
  const total = totalMesa(table)
  const balance = saldoMesa(table)
  const paid = total - balance
  const tip = propinaSobre(balance)
  // Por ítems solo antes de cobrar algo: después, lo que queda se divide por partes.
  const porItemsPosible = paid === 0

  const tocarItem = (id: string, check: number) =>
    setAsignadas((a) => {
      const b = new Map(a)
      const actuales = b.get(id) ?? []
      const newOnes = actuales.includes(check)
        ? actuales.filter((c) => c !== check)
        : [...actuales, check].sort((x, y) => x - y)
      if (newOnes.length === 0) b.delete(id)
      else b.set(id, newOnes)
      return b
    })

  const cambiarCuentas = (n: number) => {
    setCuentas(n)
    setAsignadas((a) => recortarAsignaciones(a, n))
  }

  const amounts =
    mode === 'even'
      ? enPartesIguales(balance, people)
      : mode === 'items' && porItemsPosible
        ? porItems(items.map(lineaDe), asignadas, checks).amounts
        : [balance]
  const unassigned =
    mode === 'items' && porItemsPosible
      ? porItems(items.map(lineaDe), asignadas, checks).unassigned
      : 0
  const tips = propinasDeCuentas(amounts)

  const charge = (amount: number, propinaCuenta: number) =>
    navegar(`/mockups/checkout?table=${number}&amount=${amount}&tip=${propinaCuenta}`)

  const actions = (
    <>
      <Boton
        variant="secondary"
        large
        icono="receipt"
        className="flex-1"
        onClick={() => {
          cambiarMesa(number, (m) => ({ ...m, status: 'preBill' }))
          notify('Precuenta enviada a la impresora')
        }}
      >
        Imprimir
      </Boton>
      {mode === 'single' && (
        <Boton
          variant="main"
          large
          icono="bill"
          className="flex-1"
          disabled={balance === 0}
          onClick={() => charge(balance, tip)}
        >
          {`Cobrar ${pesos(balance)}`}
        </Boton>
      )}
    </>
  )

  return (
    <Marco title={`Precuenta · Mesa ${number}`} user="Caja" back="/mockups/floor-plan">
      <div className="mx-auto grid max-w-5xl gap-4 p-3 pb-28 md:grid-cols-[1fr_22rem] md:pb-3">
        <section className="rounded-2xl border border-borde bg-superficie" aria-label="Ítems">
          <ul>
            {items.map((i) => (
              <li key={i.id} className="border-b border-borde px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className="cifras w-6 font-semibold">{i.quantity}</span>
                  <span className="flex-1">
                    <span className="font-semibold">{nombreItem(i)}</span>
                    {i.options.length > 0 && (
                      <span className="block text-sm text-texto-suave">
                        {i.options.map((o) => o.name).join(' · ')}
                      </span>
                    )}
                  </span>
                  <span className="cifras">{pesos(netoLinea(lineaDe(i)))}</span>
                </div>
                {mode === 'items' && porItemsPosible && (
                  <Grupo
                    etiqueta={`Quién paga ${nombreItem(i)}`}
                    className="mt-2 flex flex-wrap gap-2 pl-9"
                  >
                    {Array.from({ length: checks }, (_, c) => (
                      <Opcion
                        // biome-ignore lint/suspicious/noArrayIndexKey: las cuentas son posiciones
                        key={c}
                        elegida={asignadas.get(i.id)?.includes(c) ?? false}
                        alElegir={() => tocarItem(i.id, c)}
                      >
                        {`Cuenta ${c + 1}`}
                      </Opcion>
                    ))}
                  </Grupo>
                )}
              </li>
            ))}
          </ul>
          <dl className="cifras grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 p-4">
            <dt>Total</dt>
            <dd className="text-right">{pesos(total)}</dd>
            {paid > 0 && (
              <>
                <dt className="text-libre-texto">Ya pagado</dt>
                <dd className="text-right text-libre-texto">{`-${pesos(paid)}`}</dd>
                <dt className="font-semibold">Saldo</dt>
                <dd className="text-right font-semibold">{pesos(balance)}</dd>
              </>
            )}
            <dt className="text-texto-suave">Propina sugerida (10 %, voluntaria)</dt>
            <dd className="text-right text-texto-suave">{pesos(tip)}</dd>
            <dt className="font-titulo text-2xl font-bold">Con propina</dt>
            <dd className="font-titulo text-right text-2xl font-bold">{pesos(balance + tip)}</dd>
          </dl>
          <p className="px-4 pb-4 text-sm text-texto-suave">Precios con INC incluido.</p>
        </section>

        <section className="flex flex-col gap-3" aria-label="Dividir">
          <Grupo etiqueta="Cómo se paga" className="grid grid-cols-3 gap-2">
            {(
              [
                ['single', 'Una cuenta'],
                ['even', 'Partes iguales'],
                ['items', 'Por ítems'],
              ] as const
            ).map(([m, text]) => (
              <Opcion key={m} shape="card" elegida={mode === m} alElegir={() => setModo(m)}>
                {text}
              </Opcion>
            ))}
          </Grupo>

          {mode === 'even' && (
            <Accountant
              name="Personas"
              value={people}
              minimum={2}
              maximum={20}
              onChange={setPersonas}
            />
          )}
          {mode === 'items' &&
            (porItemsPosible ? (
              <>
                <Accountant
                  name="Cuentas"
                  value={checks}
                  minimum={2}
                  maximum={10}
                  onChange={cambiarCuentas}
                />
                <p className="text-sm text-texto-suave">
                  Toca en cada ítem quién lo paga. Si lo tocan dos o más, se reparte entre ellos.
                </p>
              </>
            ) : (
              <p className="rounded-xl bg-proceso-suave p-3 text-proceso-texto">
                Ya hay pagos: divide el saldo en partes iguales.
              </p>
            ))}

          {mode !== 'single' && (
            <ul className="flex flex-col gap-2">
              {amounts.map((amount, c) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: las cuentas son posiciones
                  key={c}
                  className="flex items-center gap-2 rounded-xl border border-borde bg-superficie p-2 pl-3"
                >
                  <span className="flex-1">
                    <span className="block font-semibold">{`Cuenta ${c + 1}`}</span>
                    <span className="cifras text-sm text-texto-suave">
                      {`${pesos(amount)} + propina ${pesos(tips[c] ?? 0)}`}
                    </span>
                  </span>
                  <Boton
                    variant="main"
                    disabled={amount === 0}
                    onClick={() => charge(amount, tips[c] ?? 0)}
                  >
                    {`Cobrar ${pesos(amount)}`}
                  </Boton>
                </li>
              ))}
              {unassigned > 0 && (
                <li className="cifras flex justify-between rounded-xl bg-proceso-suave p-3 text-proceso-texto">
                  <span>Sin asignar</span>
                  <span className="font-semibold">{pesos(unassigned)}</span>
                </li>
              )}
            </ul>
          )}

          <div className="hidden gap-2 md:flex">{actions}</div>
        </section>
      </div>

      {/* Celular: las acciones abajo, al alcance del pulgar. */}
      <div className="fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-borde bg-superficie p-3 md:hidden">
        {actions}
      </div>
    </Marco>
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
    <div className="flex items-center gap-3 rounded-2xl border border-borde bg-superficie p-3">
      <span className="flex-1 font-semibold">{name}</span>
      <Boton
        icono="minus"
        aria-label={`Quitar ${name.toLowerCase()}: quedan ${value - 1}`}
        disabled={value <= minimum}
        onClick={() => onChange(value - 1)}
      />
      <span className="cifras w-8 text-center text-xl font-semibold">{value}</span>
      <Boton
        icono="more"
        aria-label={`Agregar ${name.toLowerCase()}: quedan ${value + 1}`}
        disabled={value >= maximum}
        onClick={() => onChange(value + 1)}
      />
    </div>
  )
}
