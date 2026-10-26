import { newId, type OrderState, type PaymentMethod } from '@pos/core'
import type { Catalog } from '@pos/sync'
import { useEffect, useRef, useState } from 'react'
import { Boton } from '../ui/Boton'
import { Etiqueta } from '../ui/Etiqueta'
import { conPuntos, pesos, soloDigitos } from '../ui/formato'
import { Grupo, Opcion } from '../ui/Opciones'
import { PanelLateral } from '../ui/PanelLateral'
import {
  type OpcionCobro,
  opcionesDeCobro,
  pagoEnEfectivo,
  propinaConPorcentaje,
  propinaDePago,
  propinaParaEfectivo,
  type ReglasCobro,
} from './cuentas'
import { claseCampo } from './Entrar'

// Registrar un pago (brief §4.5, docs/DINERO.md#pagos): el medio (la tarjeta, como crédito o
// débito, y los medios propios del restaurante), la propina (la sugerida ya marcada; se cambia por
// porcentaje o por valor) y, solo en efectivo, lo que entrega el cliente y su cambio. Con los
// medios digitales se cobra siempre lo justo. El efectivo se redondea solo en el pago que deja la
// cuenta en 0. Registrar dinero pide confirmar (brief §5, regla 5).

const CLAVE_DATAFONO = 'pos-last-card-terminal'

const PROVEEDOR: Record<string, string> = {
  bold: 'Bold',
  redeban: 'Redeban',
  credibanco: 'Credibanco',
}

const recordado = () => {
  try {
    return localStorage.getItem(CLAVE_DATAFONO)
  } catch {
    return null
  }
}
const recordar = (id: string) => {
  try {
    localStorage.setItem(CLAVE_DATAFONO, id)
  } catch {}
}

/** Lo que se cobra: una cuenta de la división, lo que no quedó en ninguna, o todo el saldo. */
export interface Cobrando {
  checkId: string | null
  name: string
  /** Lo que le falta a esa cuenta (o al pedido): el tope del pago. */
  available: number
  /** La cuenta de la división que se cobra (su monto y su propina), o null. */
  check: { amount: number; suggestedTip: number } | null
  /** La propina que el cliente pidió en la precuenta (sin propina, otro valor), o null. */
  propinaInicial: number | null
}

/** Los datos de `PaymentRecorded` sin el turno (lo pone quien registra). */
export interface PagoNuevo {
  payment_id: string
  check_id: string | null
  method: PaymentMethod
  amount: number
  tip: number
  tendered: number | null
  change: number | null
  rounding_adjustment: number
  rounding: { multiple: number; mode: ReglasCobro['cashRoundingMode'] } | null
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

/** Cómo se eligió la propina: la sugerida, otro porcentaje o un valor fijo. */
type Eleccion =
  | { type: 'suggested' }
  | { type: 'percent'; puntos: number }
  | { type: 'value'; pesos: number }

const percent = (puntos: number) => `${`${puntos / 100}`.replace('.', ',')} %`

export function PanelCobro({
  cobrando,
  order,
  rules,
  cardTerminals,
  ocupado,
  onClose,
  alCobrar,
}: {
  cobrando: Cobrando | null
  order: OrderState
  rules: ReglasCobro
  cardTerminals: NonNullable<Catalog['cardTerminals']>
  ocupado: boolean
  onClose: () => void
  alCobrar: (payment: PagoNuevo) => void
}) {
  if (!cobrando)
    return (
      <PanelLateral opened={false} title="Cobrar" onClose={onClose}>
        {null}
      </PanelLateral>
    )
  return (
    <FormularioCobro
      key={`${cobrando.checkId}-${cobrando.available}`}
      cobrando={cobrando}
      order={order}
      rules={rules}
      cardTerminals={cardTerminals}
      ocupado={ocupado}
      onClose={onClose}
      alCobrar={alCobrar}
    />
  )
}

function FormularioCobro({
  cobrando,
  order,
  rules,
  cardTerminals,
  ocupado,
  onClose,
  alCobrar,
}: {
  cobrando: Cobrando
  order: OrderState
  rules: ReglasCobro
  cardTerminals: NonNullable<Catalog['cardTerminals']>
  ocupado: boolean
  onClose: () => void
  alCobrar: (payment: PagoNuevo) => void
}) {
  // El mismo id en cada intento: si el hub tarda y se reintenta, no queda un pago doble.
  const [paymentId] = useState(newId)
  const options = opcionesDeCobro(rules)
  const { available } = cobrando
  const [key, setClave] = useState(options[0]?.key ?? 'cash')
  const option: OpcionCobro =
    options.find((o) => o.key === key) ??
    ({
      key: 'cash',
      name: 'Efectivo',
      method: 'cash',
      tipoTarjeta: null,
      customMethodId: null,
    } as const)
  const esEfectivo = option.method === 'cash'
  const [amount, setMonto] = useState(available)
  const [eleccion, setEleccion] = useState<Eleccion>(() =>
    cobrando.propinaInicial !== null
      ? { type: 'value', pesos: cobrando.propinaInicial }
      : { type: 'suggested' },
  )
  // Escribir otro valor: en pesos o en porcentaje.
  const [enPorcentaje, setEnPorcentaje] = useState(false)
  const [tendered, setRecibido] = useState<number | null>(null)
  // Un datáfono por proveedor: los de un mismo proveedor entregan un solo cierre (Bold une todos
  // los suyos), así que da igual por cuál se pasó la tarjeta. Solo se elige si hay proveedores
  // distintos (Bold y Redeban), porque cada uno se concilia aparte en el cierre.
  const latest = recordado()
  const porProveedor = [
    ...cardTerminals
      .reduce((groups, d) => {
        // «Otro» no dice cuál: cada uno de esos va aparte.
        const key = d.provider && d.provider !== 'other' ? d.provider : d.id
        const current = groups.get(key)
        if (!current || d.id === latest) groups.set(key, d)
        return groups
      }, new Map<string, (typeof cardTerminals)[number]>())
      .entries(),
  ].map(([key, d]) => ({ id: d.id, name: PROVEEDOR[key] ?? d.name }))
  const [cardTerminal, setDatafono] = useState(
    () => porProveedor.find((d) => d.id === latest)?.id ?? porProveedor[0]?.id ?? null,
  )
  const [confirmando, setConfirmando] = useState(false)
  const confirm = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (confirmando) confirm.current?.focus()
  }, [confirmando])

  const montoValido = amount > 0 && amount <= available
  const value = montoValido ? amount : 0
  /** La propina con un porcentaje; en efectivo, redondeada para pagarla con billetes. */
  const conPorcentaje = (puntos: number) => {
    const exacta =
      puntos === rules.suggestedTip
        ? propinaDePago(order, cobrando.check, available, value, rules)
        : propinaConPorcentaje(order, available, value, puntos, rules)
    return esEfectivo ? propinaParaEfectivo(exacta, rules) : exacta
  }
  const tip =
    eleccion.type === 'value'
      ? eleccion.pesos
      : conPorcentaje(eleccion.type === 'suggested' ? rules.suggestedTip : eleccion.puntos)
  const select = (e: Eleccion) => {
    setEleccion(e)
    setConfirmando(false)
  }
  const rapidos = [...new Set([0, 500, rules.suggestedTip])].sort((a, b) => a - b)

  const elegirOpcion = (o: OpcionCobro) => {
    setClave(o.key)
    setRecibido(null)
    setConfirmando(false)
  }

  const cash = montoValido
    ? pagoEnEfectivo({ balance: available, amount, tip, tendered: 0 }, rules)
    : null
  // Por defecto, el cliente entrega justo lo que hay que cobrar (un toque menos).
  const served = tendered ?? cash?.aEntregar ?? 0
  const calculo = montoValido
    ? pagoEnEfectivo({ balance: available, amount, tip, tendered: served }, rules)
    : null
  const aCobrar = esEfectivo ? (calculo?.aEntregar ?? 0) : amount + tip
  const sinDatafono = option.method === 'card' && cardTerminal === null
  const puede = montoValido && !ocupado && !sinDatafono && (!esEfectivo || calculo?.missing === 0)

  const record = () => {
    if (!puede || !calculo) return
    if (option.method === 'card' && cardTerminal) recordar(cardTerminal)
    alCobrar({
      payment_id: paymentId,
      check_id: cobrando.checkId,
      method: option.method,
      amount,
      tip,
      tendered: esEfectivo ? served : null,
      change: esEfectivo ? calculo.change : null,
      rounding_adjustment: esEfectivo ? calculo.adjustment : 0,
      rounding: esEfectivo ? calculo.rounding : null,
      cardTerminal:
        option.method === 'card' && cardTerminal
          ? {
              card_terminal_id: cardTerminal,
              franchise: null,
              last4: null,
              approval_code: null,
              receipt: null,
              card_type: option.tipoTarjeta,
            }
          : null,
      charge_reference: null,
      custom_method_id: option.customMethodId,
    })
  }

  const nombreDatafono = porProveedor.find((d) => d.id === cardTerminal)?.name
  const donde =
    option.method === 'card' && nombreDatafono && porProveedor.length > 1
      ? `${option.name.toLowerCase()} (${nombreDatafono})`
      : option.name.toLowerCase()

  // Atajos de la caja (tarea 0.9): F2 efectivo, F3 crédito, F4 débito, Enter cobra y Esc vuelve.
  // El atajo nunca le gana al botón que tiene el foco.
  const atajo: Record<string, string> = { F2: 'cash', F3: 'credit', F4: 'debit' }
  // Los atajos solo se anuncian donde hay mouse y teclado (la caja); en el celular estorban.
  const [conTeclado] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches,
  )
  const teclas = useRef<(e: KeyboardEvent) => void>(() => {})
  teclas.current = (e: KeyboardEvent) => {
    if (e.repeat) return
    const enBoton = (e.target as HTMLElement | null)?.closest('button, a')
    const deAtajo = options.find((o) => o.key === atajo[e.key])
    if (deAtajo) {
      e.preventDefault()
      elegirOpcion(deAtajo)
    } else if (e.key === 'Escape' && confirmando) {
      e.preventDefault()
      e.stopPropagation()
      setConfirmando(false)
    } else if (e.key === 'Enter' && !enBoton && puede) {
      e.preventDefault()
      if (confirmando) record()
      else setConfirmando(true)
    }
  }
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => teclas.current(e)
    window.addEventListener('keydown', alTeclear, true)
    return () => window.removeEventListener('keydown', alTeclear, true)
  }, [])

  const pie = confirmando ? (
    <div
      className="rounded-2xl border-2 border-accion-fuerte bg-accion-suave p-3 text-accion-texto"
      role="alertdialog"
      aria-labelledby="confirm-payment"
    >
      <p id="confirm-payment" className="mb-3 text-lg font-semibold">
        {`¿Registrar ${pesos(aCobrar)} en ${donde}?`}
      </p>
      <div className="flex gap-2">
        <Boton onClick={() => setConfirmando(false)}>Volver</Boton>
        <button
          ref={confirm}
          type="button"
          disabled={ocupado}
          className="inline-flex min-h-12 flex-1 items-center justify-center rounded-xl bg-accion-fuerte px-4 font-semibold text-white focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-foco disabled:opacity-60"
          onClick={record}
        >
          {ocupado ? 'Registrando…' : `Sí, registrar ${pesos(aCobrar)}`}
        </button>
      </div>
    </div>
  ) : (
    <Boton
      variant="main"
      large
      className="w-full"
      disabled={!puede}
      onClick={() => setConfirmando(true)}
    >
      {`Cobrar ${pesos(aCobrar)}`}
    </Boton>
  )

  return (
    <PanelLateral opened title={`Cobrar · ${cobrando.name}`} onClose={onClose} pie={pie}>
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
              className={`${claseCampo} cifras mt-1 text-xl`}
              value={conPuntos(amount)}
              onChange={(e) => {
                setMonto(Math.min(soloDigitos(e.target.value), available))
                setRecibido(null)
                setConfirmando(false)
              }}
            />
          </label>
          {amount < available && amount > 0 && (
            <p className="mt-2 text-sm text-texto-suave">
              {`Pago parcial: quedan ${pesos(available - amount)} por cobrar.`}
            </p>
          )}
        </section>

        <Grupo etiqueta="Medio de pago" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {options.map((o) => (
            <Opcion
              key={o.key}
              shape="card"
              elegida={key === o.key}
              alElegir={() => elegirOpcion(o)}
              detalle={(() => {
                const tecla = Object.keys(atajo).find((k) => atajo[k] === o.key)
                return conTeclado && tecla ? `Tecla ${tecla}` : undefined
              })()}
            >
              {o.name}
            </Opcion>
          ))}
        </Grupo>

        <section className="rounded-2xl border border-linea bg-superficie p-4" aria-label="Propina">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-semibold">Propina (voluntaria)</span>
            <span className="cifras font-titulo text-2xl font-bold">{pesos(tip)}</span>
          </div>
          <Grupo etiqueta="Propina" className="mt-3 flex flex-wrap gap-2">
            {rapidos.map((p) => {
              const elegida =
                p === 0
                  ? eleccion.type === 'value' && eleccion.pesos === 0
                  : p === rules.suggestedTip
                    ? eleccion.type === 'suggested'
                    : eleccion.type === 'percent' && eleccion.puntos === p
              return (
                <Opcion
                  key={p}
                  elegida={elegida}
                  alElegir={() =>
                    select(
                      p === 0
                        ? { type: 'value', pesos: 0 }
                        : p === rules.suggestedTip
                          ? { type: 'suggested' }
                          : { type: 'percent', puntos: p },
                    )
                  }
                >
                  {p === 0
                    ? 'Sin propina'
                    : p === rules.suggestedTip
                      ? `${percent(p)} (sugerida)`
                      : percent(p)}
                </Opcion>
              )
            })}
          </Grupo>
          <div className="mt-3 flex items-end gap-2">
            <label className="min-w-0 flex-1">
              <span className="text-sm font-semibold">
                {enPorcentaje ? 'Otro porcentaje' : 'Otro valor'}
              </span>
              <input
                inputMode="numeric"
                className={`${claseCampo} cifras mt-1`}
                placeholder={enPorcentaje ? 'Ej. 12' : 'Ej. 5.000'}
                value={
                  enPorcentaje
                    ? eleccion.type === 'percent' && !rapidos.includes(eleccion.puntos)
                      ? String(eleccion.puntos / 100)
                      : ''
                    : eleccion.type === 'value' && eleccion.pesos > 0
                      ? conPuntos(eleccion.pesos)
                      : ''
                }
                onChange={(e) => {
                  const n = soloDigitos(e.target.value)
                  if (enPorcentaje) select({ type: 'percent', puntos: Math.min(n, 100) * 100 })
                  else select({ type: 'value', pesos: n })
                }}
              />
            </label>
            <Grupo etiqueta="Escribir en" className="flex gap-1">
              <Opcion elegida={!enPorcentaje} alElegir={() => setEnPorcentaje(false)}>
                $
              </Opcion>
              <Opcion elegida={enPorcentaje} alElegir={() => setEnPorcentaje(true)}>
                %
              </Opcion>
            </Grupo>
          </div>
        </section>

        {esEfectivo && calculo && (
          <section
            className="rounded-2xl border border-linea bg-superficie p-4"
            aria-label="Efectivo"
          >
            <p className="text-texto-suave">
              {calculo.adjustment !== 0
                ? `A cobrar (venta redondeada a ${pesos(rules.cashRounding)} + propina)`
                : 'A cobrar (venta + propina)'}
            </p>
            <p className="cifras font-titulo text-3xl font-bold">{pesos(calculo.aEntregar)}</p>
            <label className="mt-3 block">
              <span className="font-semibold">El cliente entrega</span>
              <input
                inputMode="numeric"
                className={`${claseCampo} cifras mt-1 min-h-14 text-2xl`}
                value={conPuntos(served)}
                onChange={(e) => {
                  setRecibido(soloDigitos(e.target.value))
                  setConfirmando(false)
                }}
              />
            </label>
            <div className="cifras mt-3 flex flex-wrap items-center gap-2 text-lg">
              {calculo.missing > 0 ? (
                <Etiqueta
                  tono="warning"
                  icono="warning"
                >{`Faltan ${pesos(calculo.missing)}`}</Etiqueta>
              ) : (
                <Etiqueta tono="free" icono="check">{`Cambio ${pesos(calculo.change)}`}</Etiqueta>
              )}
              {calculo.change > 0 && (
                <Boton onClick={() => select({ type: 'value', pesos: tip + calculo.change })}>
                  Deja el cambio de propina
                </Boton>
              )}
            </div>
          </section>
        )}

        {!esEfectivo && (
          <section
            className="rounded-2xl border border-linea bg-superficie p-4"
            aria-label="A cobrar"
          >
            <p className="text-texto-suave">
              {option.method === 'card'
                ? 'Total en el datáfono (venta + propina)'
                : `A cobrar por ${option.name} (venta + propina)`}
            </p>
            <p className="cifras font-titulo text-3xl font-bold">{pesos(aCobrar)}</p>
            {option.method === 'card' &&
              (cardTerminals.length === 0 ? (
                <p className="mt-2 rounded-xl bg-proceso-suave p-3 text-proceso-texto">
                  No hay datáfonos: agrégalos en «Caja y pagos» para cobrar con tarjeta.
                </p>
              ) : (
                porProveedor.length > 1 && (
                  <Grupo etiqueta="Datáfono" className="mt-3 flex flex-wrap gap-2">
                    {porProveedor.map((d) => (
                      <Opcion
                        key={d.id}
                        elegida={cardTerminal === d.id}
                        alElegir={() => setDatafono(d.id)}
                      >
                        {d.name}
                      </Opcion>
                    ))}
                  </Grupo>
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
    </PanelLateral>
  )
}
