import { useEffect, useRef, useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { Etiqueta } from '../ui/Etiqueta'
import { conPuntos, pesos, soloDigitos } from '../ui/formato'
import { Grupo, Opcion } from '../ui/Opciones'
import { navegar, useRuta } from '../ui/ruta'
import { pagoConTarjeta, pagoEnEfectivo, propinaParaEfectivo, propinaSobre } from './cuenta'
import type { Medio } from './datos'
import { cambiarMesa, useMesaDeLaRuta, useMesas } from './estado'
import { Marco } from './Marco'
import { saldoMesa, totalMesa } from './totales'

// Cobro en la caja (brief §4.5, docs/DINERO.md#pagos). Se cobra el saldo o la parte de una cuenta
// dividida (`?monto=`); el efectivo se redondea a $100 solo en el pago que deja el saldo en 0. La
// propina en efectivo se sugiere redondeada y se puede cambiar; si el cliente deja el cambio, pasa
// a propina. Registrar un pago es una acción de dinero: pide confirmar (brief §5, regla 5).
// Atajos: F2 efectivo, F3 tarjeta, Enter cobra, Esc cancela.

const BILLETES = [20_000, 50_000, 100_000]

export function Cobro() {
  const number = useMesaDeLaRuta(12)
  const { params } = useRuta()
  const table = useMesas().find((m) => m.number === number)
  const notify = useAvisar()

  const balance = table ? saldoMesa(table) : 0
  const order = soloDigitos(params.get('amount') ?? '')
  const amount = order > 0 && order <= balance ? order : balance
  const suggested = params.has('tip') ? soloDigitos(params.get('tip') ?? '') : propinaSobre(amount)

  const [method, setMedio] = useState<Medio>('cash')
  const [tip, setPropina] = useState(() => propinaParaEfectivo(suggested))
  const [tendered, setRecibido] = useState<number | null>(null)
  const [approval_code, setAprobacion] = useState('')
  const [confirmando, setConfirmando] = useState(false)
  const [ultimoCambio, setUltimoCambio] = useState<number | null>(null)
  const confirm = useRef<HTMLButtonElement>(null)

  const elegirMedio = (m: Medio) => {
    setMedio(m)
    setPropina(m === 'cash' ? propinaParaEfectivo(suggested) : suggested)
    setRecibido(null)
    setConfirmando(false)
  }

  const cash = amount > 0 ? pagoEnEfectivo({ balance, amount, tip, tendered: 0 }) : null
  // Por defecto, el cliente entrega justo lo que hay que cobrar (un toque menos).
  const served = tendered ?? cash?.aEntregar ?? 0
  const calculo = amount > 0 ? pagoEnEfectivo({ balance, amount, tip, tendered: served }) : null
  const card = amount > 0 ? pagoConTarjeta({ balance, amount, tip }) : null
  const aCobrar = method === 'cash' ? (calculo?.aEntregar ?? 0) : (card?.aprobado ?? 0)
  const puede =
    amount > 0 && (method === 'cash' ? calculo?.missing === 0 : /^\d{4,8}$/.test(approval_code))

  const record = () => {
    if (!table || !calculo || !puede) return
    const payment =
      method === 'cash'
        ? {
            method,
            amount,
            adjustment: calculo.adjustment,
            tip,
            tendered: served,
            change: calculo.change,
          }
        : { method, amount, adjustment: 0, tip, tendered: null, change: null }
    const closes = amount === balance
    cambiarMesa(number, (m) => ({
      ...m,
      payments: [...m.payments, payment],
      status: closes ? 'dirty' : m.status,
    }))
    setConfirmando(false)
    setUltimoCambio(method === 'cash' ? calculo.change : null)
    if (closes) {
      // La mesa se cierra sola al quedar en 0: un toque menos. Se puede deshacer el cierre.
      notify(`Mesa ${number} pagada y cerrada`, () =>
        cambiarMesa(number, (m) => ({ ...m, status: 'preBill' })),
      )
    } else {
      notify(`Pago registrado. Queda ${pesos(balance - amount)}`)
      navegar(`/mockups/pre-bill?table=${number}`)
    }
  }

  // Al pedir confirmación, el foco va a "Confirmar": Enter confirma; Tab y Enter en "Cancelar",
  // cancela (el atajo nunca le gana al botón que tiene el foco).
  useEffect(() => {
    if (confirmando) confirm.current?.focus()
  }, [confirmando])

  const teclas = useRef<(e: KeyboardEvent) => void>(() => {})
  teclas.current = (e: KeyboardEvent) => {
    if (e.repeat) return
    const enBoton = (e.target as HTMLElement | null)?.closest('button, a')
    if (e.key === 'F2' || e.key === 'F3') {
      e.preventDefault()
      elegirMedio(e.key === 'F2' ? 'cash' : 'card')
    } else if (e.key === 'Escape') setConfirmando(false)
    else if (e.key === 'Enter' && !enBoton && puede) {
      e.preventDefault()
      if (confirmando) record()
      else setConfirmando(true)
    }
  }
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => teclas.current(e)
    window.addEventListener('keydown', alTeclear)
    return () => window.removeEventListener('keydown', alTeclear)
  }, [])

  if (!table) return null
  const total = totalMesa(table)

  return (
    <Marco title={`Cobro · Mesa ${number}`} user="Caja" back={`/mockups/pre-bill?table=${number}`}>
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
              <Etiqueta tono="action" icono="people">{`Esta cuenta: ${pesos(amount)}`}</Etiqueta>
            </p>
          )}
          {ultimoCambio !== null && (
            <p className="mt-4 rounded-xl bg-libre-suave p-3 text-libre-texto">
              <span className="block">Cambio a entregar</span>
              <span className="cifras text-3xl font-bold">{pesos(ultimoCambio)}</span>
            </p>
          )}
          {table.payments.length > 0 && (
            <ul className="cifras mt-4 flex flex-col gap-1 border-t border-borde pt-3">
              {table.payments.map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: los pagos no se reordenan
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
            <Boton
              variant="secondary"
              large
              className="mt-6 w-full"
              onClick={() => navegar('/mockups/floor-plan')}
            >
              Volver al salón
            </Boton>
          )}
        </section>

        {amount > 0 && (
          <section className="flex flex-col gap-3" aria-label="Pago">
            <Grupo etiqueta="Medio de pago" className="grid grid-cols-2 gap-2">
              {(
                [
                  ['cash', 'Efectivo', 'F2'],
                  ['card', 'Tarjeta', 'F3'],
                ] as const
              ).map(([m, text, tecla]) => (
                <Opcion
                  key={m}
                  shape="card"
                  elegida={method === m}
                  alElegir={() => elegirMedio(m)}
                  detalle={tecla}
                >
                  {text}
                </Opcion>
              ))}
            </Grupo>

            <div className="rounded-2xl border border-borde bg-superficie p-4">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">Propina (voluntaria)</span>
                <span className="cifras text-sm text-texto-suave">{`sugerida ${pesos(suggested)}`}</span>
              </div>
              <input
                inputMode="numeric"
                aria-label="Propina"
                value={conPuntos(tip)}
                onChange={(e) => setPropina(soloDigitos(e.target.value))}
                placeholder="0"
                className="cifras mt-2 min-h-12 w-full rounded-xl border border-borde bg-superficie px-3 text-xl focus-visible:outline-3 focus-visible:outline-foco"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <Boton
                  onClick={() =>
                    setPropina(method === 'cash' ? propinaParaEfectivo(suggested) : suggested)
                  }
                >
                  Sugerida
                </Boton>
                <Boton onClick={() => setPropina(0)}>Sin propina</Boton>
              </div>
            </div>

            {method === 'cash' && calculo ? (
              <div className="rounded-2xl border border-borde bg-superficie p-4">
                <p className="text-texto-suave">
                  {amount === balance
                    ? 'A cobrar (venta redondeada a $100 + propina)'
                    : 'A cobrar (venta + propina)'}
                </p>
                <p className="cifras font-titulo text-3xl font-bold">{pesos(calculo.aEntregar)}</p>
                <label className="mt-3 block">
                  <span className="font-semibold">El cliente entrega</span>
                  <input
                    inputMode="numeric"
                    value={conPuntos(served)}
                    onChange={(e) => setRecibido(soloDigitos(e.target.value))}
                    className="cifras mt-2 min-h-14 w-full rounded-xl border border-borde bg-superficie px-3 text-2xl focus-visible:outline-3 focus-visible:outline-foco"
                  />
                </label>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-2 lg:grid-cols-4">
                  <Boton onClick={() => setRecibido(null)}>Exacto</Boton>
                  {BILLETES.map((b) => (
                    <Boton key={b} onClick={() => setRecibido(b)}>
                      {`${b / 1000} mil`}
                    </Boton>
                  ))}
                </div>
                <div className="cifras mt-3 flex flex-wrap items-center gap-2 text-lg">
                  {calculo.missing > 0 ? (
                    <Etiqueta
                      tono="warning"
                      icono="warning"
                    >{`Faltan ${pesos(calculo.missing)}`}</Etiqueta>
                  ) : (
                    <Etiqueta
                      tono="free"
                      icono="check"
                    >{`Cambio ${pesos(calculo.change)}`}</Etiqueta>
                  )}
                  {calculo.change > 0 && (
                    <Boton onClick={() => setPropina(tip + calculo.change)}>
                      Deja el cambio de propina
                    </Boton>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-borde bg-superficie p-4">
                <p className="text-texto-suave">Total en el datáfono (venta + propina)</p>
                <p className="cifras font-titulo text-3xl font-bold">{pesos(aCobrar)}</p>
                <label className="mt-3 block">
                  <span className="font-semibold">Número de aprobación</span>
                  <input
                    inputMode="numeric"
                    value={approval_code}
                    onChange={(e) => setAprobacion(e.target.value.replace(/\D/g, '').slice(0, 8))}
                    className="cifras mt-2 min-h-14 w-full rounded-xl border border-borde bg-superficie px-3 text-2xl focus-visible:outline-3 focus-visible:outline-foco"
                  />
                </label>
              </div>
            )}

            {confirmando ? (
              <div
                className="rounded-2xl border-2 border-accion-fuerte bg-accion-suave p-4 text-accion-texto"
                role="alertdialog"
                aria-labelledby="confirm-payment"
              >
                <p id="confirm-payment" className="mb-3 text-lg font-semibold">
                  {`¿Registrar ${pesos(aCobrar)} en ${method}?`}
                </p>
                <div className="flex gap-2">
                  <Boton onClick={() => setConfirmando(false)}>Cancelar</Boton>
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
              <Boton variant="main" large disabled={!puede} onClick={() => setConfirmando(true)}>
                {`Cobrar ${pesos(aCobrar)}`}
              </Boton>
            )}
            <p className="text-sm text-texto-suave">
              Teclado: F2 efectivo · F3 tarjeta · Enter cobra · Esc cancela
            </p>
          </section>
        )}
      </div>
    </Marco>
  )
}
