import { newId, type OrderState, orderTaxes, orderTotals } from '@pos/core'
import type { Catalog } from '@pos/sync'
import { useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { Etiqueta } from '../ui/Etiqueta'
import { conPuntos, pesos, soloDigitos } from '../ui/formato'
import { Grupo, Opcion } from '../ui/Opciones'
import { PanelLateral } from '../ui/PanelLateral'
import { navegar, useRuta } from '../ui/ruta'
import { type Cobrando, type PagoNuevo, PanelCobro } from './Cobro'
import { floor, useSala, useVistaLocal } from './contexto'
import {
  enPartesIguales,
  linesOf,
  methodName,
  porCobrar,
  porProductos,
  propinaSugeridaDe,
  recortarAsignaciones,
  reglasDe,
  taxName,
} from './cuentas'
import { claseCampo } from './Entrar'
import { MarcoSala } from './MarcoSala'
import { CHANNELS, unidadesPorEnviar } from './pedido'

// La cuenta de un pedido (tarea 1.6, brief §4.5): la precuenta en pantalla y en papel, dividirla
// (en partes iguales o por productos) y cobrar cada parte. Se divide el SALDO: lo ya pagado queda
// aparte. Cobrar solo se puede en un equipo de caja con la caja abierta y conexión con el hub; al
// quedar el saldo en 0, el pedido se cierra solo y la mesa queda libre.

type Modo = 'single' | 'even' | 'products'

const MOTIVOS_ANULAR_PAGO = ['Se registró por error', 'Pagó con otro medio'] as const

const message = (e: unknown) => (e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.')

/** «Mesa 5 + 6», «Para llevar #12». */
function tituloDe(catalog: Catalog, order: OrderState): string {
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
  const { params } = useRuta()
  const orderId = params.get('order')
  const vista = useVistaLocal()
  const { catalog, session, device, connection } = useSala()
  const notify = useAvisar()
  // Lo cobrado que cerró el pedido: se sigue viendo (el cambio que hay que entregar).
  const [closed, setCerrado] = useState<{ title: string; change: number | null } | null>(null)
  const [ultimoCambio, setUltimoCambio] = useState<number | null>(null)
  const [mode, setModo] = useState<Modo>('single')
  const [people, setPersonas] = useState(2)
  const [checks, setCuentas] = useState(2)
  const [asignadas, setAsignadas] = useState<Map<string, number[]>>(new Map())
  const [cobrando, setCobrando] = useState<Cobrando | null>(null)
  const [anulando, setAnulando] = useState<string | null>(null)
  const [taken, setOcupado] = useState(false)
  const [propinaElegida, setPropinaElegida] = useState<number | null>(null)
  const [editandoPropina, setEditandoPropina] = useState(false)

  if (closed)
    return (
      <MarcoSala title={closed.title} back="/">
        <div className="mx-auto flex max-w-md flex-col gap-4 p-4">
          <p className="rounded-2xl bg-libre-suave p-4 text-libre-texto">
            <span className="block text-lg font-semibold">Pagado y cerrado</span>
            {closed.change !== null && closed.change > 0 && (
              <>
                <span className="mt-2 block">Cambio a entregar</span>
                <span className="cifras font-titulo text-4xl font-bold">
                  {pesos(closed.change)}
                </span>
              </>
            )}
          </p>
          <Boton variant="main" large icono="table" onClick={() => navegar('/')}>
            Volver al salón
          </Boton>
        </div>
      </MarcoSala>
    )

  if (!catalog || !vista) return null
  const pedidoVisible = vista.orders.find((p) => p.status.id === orderId)
  if (!pedidoVisible)
    return (
      <MarcoSala title="Cuenta" back="/">
        <p className="p-6 text-texto-suave">Este pedido ya no está abierto.</p>
      </MarcoSala>
    )
  const order = pedidoVisible.status
  const title = tituloDe(catalog, order)
  const volverAlPedido = `/order?order=${order.id}${order.tableId ? `&table=${order.tableId}` : ''}`
  const rules = reglasDe(catalog)
  if (!rules)
    return (
      <MarcoSala title={`Cuenta · ${title}`} back="/">
        <p className="p-6 text-texto-suave">
          La caja tiene una versión anterior que no sabe cobrar: hay que actualizarla.
        </p>
      </MarcoSala>
    )

  const permissions = session?.permissions ?? []
  const online = connection === 'connected'
  const esCaja = device?.type === 'register'
  const puedeDividir = permissions.includes('split_check')
  const puedeCobrar = esCaja && permissions.includes('record_payment')
  const puedeAnularPago = esCaja && permissions.includes('void_payment')
  const puedeCerrar = esCaja && permissions.includes('close_table')
  const shift = vista.shift
  const totals = orderTotals(order)
  const lines = linesOf(order)
  const { balance, checks: divididas, unassigned } = porCobrar(order)
  const propinaSaldo = propinaSugeridaDe(order, balance, rules)
  const propinaCinco = propinaSugeridaDe(order, balance, { ...rules, suggestedTip: 500 })
  // La que pide el cliente al ver la precuenta (sin propina, otro valor); va al papel y al cobro.
  const propinaVista = propinaElegida ?? propinaSaldo
  const taxes = orderTaxes(order, rules.roundingMode)
  const payments = Object.values(order.payments).filter((p) => !p.voided)
  const sinEnviar = unidadesPorEnviar(order)

  /** Un trabajo que registra eventos: uno a la vez, y el error se avisa. */
  const act = async (job: () => Promise<void>) => {
    if (taken) return
    setOcupado(true)
    try {
      await job()
    } catch (e) {
      notify(message(e))
    } finally {
      setOcupado(false)
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

  const split = (newOnes: ReturnType<typeof enPartesIguales>) =>
    act(async () => {
      await floor.record('CheckSplit', order.id, { checks: newOnes })
      setModo('single')
      setAsignadas(new Map())
    })

  const undo = () =>
    act(async () => {
      await floor.record('SplitUndone', order.id, {})
    })

  /** Cierra el pedido con saldo 0; el hub confirma antes de mostrarlo cerrado. */
  const close = async (change: number | null) => {
    await floor.registrarConfirmado('OrderClosed', order.id, {})
    setCerrado({ title, change })
    notify(`${title}: pagada y cerrada`)
  }

  // El dinero se muestra como cobrado solo cuando el hub lo acepta: un pago que el hub rechaza
  // desaparecería de la cuenta después de que el cliente ya pagó.
  const charge = (payment: PagoNuevo) =>
    act(async () => {
      if (!shift) throw new Error('Abre la caja para cobrar')
      await floor.registrarConfirmado('PaymentRecorded', order.id, {
        ...payment,
        register_shift_id: shift.id,
      })
      setCobrando(null)
      setUltimoCambio(payment.change)
      // Lo que queda según lo guardado ya con el pago (otro equipo pudo cobrar al mismo tiempo).
      const after = await floor.sync?.order(order.id)
      const queda = after ? orderTotals(after).balance : balance - payment.amount
      // La mesa se cierra sola al quedar en 0 (decisión del dueño, 26-oct-2026). Si el cierre
      // falla, el pago ya quedó y «Cerrar la mesa» lo vuelve a intentar.
      if (queda === 0 && puedeCerrar) await close(payment.change)
      else notify(queda === 0 ? 'Pago registrado' : `Pago registrado. Queda ${pesos(queda)}`)
    })

  const anularPago = (paymentId: string, reason: string) =>
    act(async () => {
      if (!shift) throw new Error('Abre la caja para anular un pago')
      await floor.registrarConfirmado(
        'PaymentVoided',
        order.id,
        { payment_id: paymentId, register_shift_id: shift.id },
        { reason },
      )
      setAnulando(null)
      notify('Pago anulado')
    })

  // Por qué no se puede cobrar aquí, si no se puede.
  const sinCobro = !puedeCobrar
    ? null
    : !online
      ? 'Sin conexión con el hub: para cobrar hace falta la red. Revisa el cable o el Wi-Fi.'
      : !shift
        ? 'La caja está cerrada: ábrela con la base para empezar a cobrar.'
        : shift.porConfirmar
          ? 'La caja se está abriendo: espera a que el hub lo confirme.'
          : null
  const abrirCobro = (c: Cobrando) => {
    if (!sinCobro) setCobrando(c)
  }

  const montosVista =
    mode === 'even'
      ? enPartesIguales(order, people, rules, newId)
      : mode === 'products'
        ? porProductos(order, asignadas, checks, rules, newId).checks
        : []
  const sinAsignarVista =
    mode === 'products' ? porProductos(order, asignadas, checks, rules, newId).unassigned : 0
  // Por productos solo antes del primer pago: después se divide lo que queda en partes iguales.
  const porProductosPosible = totals.paid === 0

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

  return (
    <MarcoSala title={`Cuenta · ${title}`} back={volverAlPedido}>
      <div className="mx-auto grid max-w-5xl gap-4 p-3 pb-28 md:grid-cols-[1fr_24rem] md:p-5">
        <section
          className="rounded-2xl border border-linea bg-superficie shadow-flota"
          aria-label="Precuenta"
        >
          <ul>
            {lines.map((l) => (
              <li key={l.id} className="border-b border-linea px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className="cifras w-6 font-semibold">{l.quantity}</span>
                  <span className="flex-1">
                    <span className="font-semibold">{l.name}</span>
                    {l.options.length > 0 && (
                      <span className="block text-sm text-texto-suave">
                        {l.options.join(' · ')}
                      </span>
                    )}
                  </span>
                  <span className="cifras">{pesos(l.net)}</span>
                </div>
                {mode === 'products' && porProductosPosible && !order.checks && (
                  <Grupo label={`Quién paga ${l.name}`} className="mt-2 flex flex-wrap gap-2 pl-9">
                    {Array.from({ length: checks }, (_, c) => (
                      <Opcion
                        // biome-ignore lint/suspicious/noArrayIndexKey: las cuentas son posiciones
                        key={c}
                        elegida={asignadas.get(l.id)?.includes(c) ?? false}
                        alElegir={() => tocarItem(l.id, c)}
                      >
                        {`Cuenta ${c + 1}`}
                      </Opcion>
                    ))}
                  </Grupo>
                )}
              </li>
            ))}
            {lines.length === 0 && (
              <li className="p-4 text-texto-suave">El pedido no tiene productos.</li>
            )}
          </ul>
          <dl className="cifras grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 p-4">
            {taxes.length > 0 && (
              <>
                <dt className="text-texto-suave">Base sin impuestos</dt>
                <dd className="text-right text-texto-suave">
                  {pesos(taxes.reduce((a, i) => a + i.base, 0))}
                </dd>
                {taxes
                  .filter((i) => i.tax > 0)
                  .map((i) => (
                    <div key={`${i.type}${i.rate}`} className="contents">
                      <dt className="text-texto-suave">{taxName(i.type, i.rate)}</dt>
                      <dd className="text-right text-texto-suave">{pesos(i.tax)}</dd>
                    </div>
                  ))}
              </>
            )}
            <dt className="font-semibold">Total</dt>
            <dd className="text-right font-semibold">{pesos(totals.net)}</dd>
            {totals.paid > 0 && (
              <>
                <dt className="text-libre-texto">Ya pagado</dt>
                <dd className="text-right text-libre-texto">{`-${pesos(totals.paid)}`}</dd>
                <dt className="font-semibold">Saldo</dt>
                <dd className="text-right font-semibold">{pesos(balance)}</dd>
              </>
            )}
            {balance > 0 && (
              <>
                <dt className="flex items-center gap-2 text-texto-suave">
                  {propinaElegida === null
                    ? `Propina sugerida (${rules.suggestedTip / 100} %, voluntaria)`
                    : 'Propina (voluntaria)'}
                  <Boton
                    variant="ghost"
                    className="min-h-10! px-2! text-sm"
                    onClick={() => setEditandoPropina((v) => !v)}
                  >
                    Cambiar
                  </Boton>
                </dt>
                <dd className="self-center text-right text-texto-suave">{pesos(propinaVista)}</dd>
                <dt className="font-titulo text-2xl font-bold">
                  {propinaVista > 0 ? 'Con propina' : 'A pagar'}
                </dt>
                <dd className="font-titulo text-right text-2xl font-bold">
                  {pesos(balance + propinaVista)}
                </dd>
              </>
            )}
          </dl>
          {editandoPropina && balance > 0 && (
            <div className="mx-4 mb-4 flex flex-col gap-2 rounded-xl bg-superficie-2/60 p-3">
              <Grupo label="Propina" className="flex flex-wrap gap-2">
                <Opcion
                  elegida={propinaElegida === null}
                  alElegir={() => {
                    setPropinaElegida(null)
                    setEditandoPropina(false)
                  }}
                >
                  {`${rules.suggestedTip / 100} % (sugerida) · ${pesos(propinaSaldo)}`}
                </Opcion>
                {rules.suggestedTip !== 500 && (
                  <Opcion
                    elegida={propinaElegida === propinaCinco}
                    alElegir={() => {
                      setPropinaElegida(propinaCinco)
                      setEditandoPropina(false)
                    }}
                  >
                    {`5 % · ${pesos(propinaCinco)}`}
                  </Opcion>
                )}
                <Opcion
                  elegida={propinaElegida === 0}
                  alElegir={() => {
                    setPropinaElegida(0)
                    setEditandoPropina(false)
                  }}
                >
                  Sin propina
                </Opcion>
              </Grupo>
              <label>
                <span className="text-sm font-semibold">Otro valor</span>
                <input
                  inputMode="numeric"
                  className={`${claseCampo} cifras mt-1`}
                  value={propinaElegida ? conPuntos(propinaElegida) : ''}
                  placeholder="0"
                  onChange={(e) => setPropinaElegida(soloDigitos(e.target.value))}
                  onKeyDown={(e) => e.key === 'Enter' && setEditandoPropina(false)}
                />
              </label>
            </div>
          )}
          {payments.length > 0 && (
            <div className="border-t border-linea p-4">
              <h2 className="mb-2 font-semibold">Pagos</h2>
              <ul className="cifras flex flex-col gap-2">
                {payments.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {methodName(p.method, p.customMethodId, rules)}
                      {p.checkId &&
                        ` · ${divididas.find((c) => c.id === p.checkId)?.name ?? 'Cuenta'}`}
                    </span>
                    <span className="flex items-center gap-2 text-right">
                      {pesos(p.amount)}
                      {p.tip > 0 && ` + propina ${pesos(p.tip)}`}
                      {p.roundingAdjustment !== 0 &&
                        ` (redondeo ${p.roundingAdjustment > 0 ? '+' : ''}${pesos(p.roundingAdjustment)})`}
                      {puedeAnularPago && shift && online && (
                        <Boton variant="ghost" onClick={() => setAnulando(p.id)}>
                          Anular
                        </Boton>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              {ultimoCambio !== null && ultimoCambio > 0 && (
                <p className="mt-3 rounded-xl bg-libre-suave p-3 text-libre-texto">
                  <span className="block">Cambio a entregar</span>
                  <span className="cifras text-3xl font-bold">{pesos(ultimoCambio)}</span>
                </p>
              )}
            </div>
          )}
        </section>

        {/* En el celular, lo que se hace va arriba, antes de la lista (el pulgar no baja tanto). */}
        <section
          className="order-first flex flex-col gap-3 md:order-none"
          aria-label="Cómo se paga"
        >
          <Boton
            variant="secondary"
            large
            icono="receipt"
            disabled={taken || balance === 0}
            onClick={() => print(null, balance, propinaVista)}
          >
            {rules.printsPreBill ? 'Imprimir precuenta' : 'Pidió la cuenta'}
          </Boton>
          {!rules.printsPreBill && (
            <p className="text-sm text-texto-suave">
              Sin impresora de precuentas: muéstrale esta pantalla al cliente.
            </p>
          )}

          {balance === 0 && puedeCerrar && (
            <Boton
              variant="main"
              large
              icono="check"
              disabled={taken || !online}
              onClick={() => act(() => close(ultimoCambio))}
            >
              Cerrar la mesa
            </Boton>
          )}

          {sinEnviar > 0 && (
            <div className="rounded-xl bg-proceso-suave p-3 text-proceso-texto">
              <p>
                {sinEnviar === 1
                  ? 'Hay 1 producto que no se ha enviado a cocina.'
                  : `Hay ${sinEnviar} productos que no se han enviado a cocina.`}
              </p>
              <Boton className="mt-2" onClick={() => navegar(volverAlPedido)}>
                Volver al pedido
              </Boton>
            </div>
          )}

          {!puedeCobrar && balance > 0 && (
            <p className="text-sm text-texto-suave">El cobro lo hace la caja.</p>
          )}

          {sinCobro && (
            <div className="rounded-xl bg-proceso-suave p-3 text-proceso-texto">
              <p>{sinCobro}</p>
              {!shift && online && (
                <Boton
                  className="mt-2"
                  onClick={() =>
                    navegar(`/register?back=${encodeURIComponent(`/check?order=${order.id}`)}`)
                  }
                >
                  Abrir la caja
                </Boton>
              )}
            </div>
          )}

          {order.checks ? (
            <Divididas
              checks={divididas}
              unassigned={unassigned}
              puedeCobrar={puedeCobrar && !sinCobro}
              puedeDeshacer={puedeDividir && !payments.some((p) => p.checkId !== null)}
              taken={taken}
              alCobrar={abrirCobro}
              alImprimir={(c) => print(c.id, c.balance, c.propinaPendiente)}
              alDeshacer={undo}
            />
          ) : (
            <>
              {puedeDividir && balance > 0 && (
                <Grupo label="Cómo se paga" className="grid grid-cols-3 gap-2">
                  {(
                    [
                      ['single', 'Una cuenta'],
                      ['even', 'Partes iguales'],
                      ['products', 'Por productos'],
                    ] as const
                  ).map(([m, text]) => (
                    <Opcion key={m} shape="card" elegida={mode === m} alElegir={() => setModo(m)}>
                      {text}
                    </Opcion>
                  ))}
                </Grupo>
              )}
              {mode === 'single' && puedeCobrar && balance > 0 && (
                <Boton
                  variant="main"
                  large
                  icono="bill"
                  disabled={!!sinCobro || taken}
                  onClick={() =>
                    abrirCobro({
                      checkId: null,
                      name: title,
                      available: balance,
                      check: null,
                      propinaInicial: propinaElegida,
                    })
                  }
                >
                  {`Cobrar ${pesos(balance)}`}
                </Boton>
              )}
              {mode === 'even' && (
                <Accountant
                  name="Personas"
                  value={people}
                  minimum={2}
                  maximum={20}
                  onChange={setPersonas}
                />
              )}
              {mode === 'products' &&
                (porProductosPosible ? (
                  <>
                    <Accountant
                      name="Cuentas"
                      value={checks}
                      minimum={2}
                      maximum={10}
                      onChange={(n) => {
                        setCuentas(n)
                        setAsignadas((a) => recortarAsignaciones(a, n))
                      }}
                    />
                    <p className="text-sm text-texto-suave">
                      Toca en cada producto quién lo paga. Si lo tocan dos o más, se reparte entre
                      ellos.
                    </p>
                  </>
                ) : (
                  <p className="rounded-xl bg-proceso-suave p-3 text-proceso-texto">
                    Ya hay pagos: divide lo que queda en partes iguales.
                  </p>
                ))}
              {mode !== 'single' && (mode === 'even' || porProductosPosible) && (
                <>
                  <ul className="flex flex-col gap-2">
                    {montosVista.map((c) => (
                      <li
                        key={c.check_id}
                        className="cifras flex justify-between rounded-xl border border-linea bg-superficie p-3"
                      >
                        <span className="font-semibold">{c.name}</span>
                        <span>{`${pesos(c.amount)} + propina ${pesos(c.suggested_tip)}`}</span>
                      </li>
                    ))}
                    {sinAsignarVista > 0 && (
                      <li className="cifras flex justify-between rounded-xl bg-proceso-suave p-3 text-proceso-texto">
                        <span>Sin asignar (se cobra aparte)</span>
                        <span className="font-semibold">{pesos(sinAsignarVista)}</span>
                      </li>
                    )}
                  </ul>
                  <Boton
                    variant="main"
                    large
                    disabled={taken || montosVista.every((c) => c.amount === 0)}
                    onClick={() => split(montosVista)}
                  >
                    {`Dividir en ${montosVista.length}`}
                  </Boton>
                </>
              )}
            </>
          )}
        </section>
      </div>

      <PanelCobro
        cobrando={cobrando}
        order={order}
        rules={rules}
        cardTerminals={catalog.cardTerminals ?? []}
        taken={taken}
        onClose={() => setCobrando(null)}
        alCobrar={charge}
      />
      <PanelAnularPago
        key={anulando ?? 'ninguno'}
        paymentId={anulando}
        taken={taken}
        onClose={() => setAnulando(null)}
        onVoid={anularPago}
      />
    </MarcoSala>
  )
}

function Divididas({
  checks,
  unassigned,
  puedeCobrar,
  puedeDeshacer,
  taken,
  alCobrar,
  alImprimir,
  alDeshacer,
}: {
  checks: ReturnType<typeof porCobrar>['checks']
  unassigned: number
  puedeCobrar: boolean
  puedeDeshacer: boolean
  taken: boolean
  alCobrar: (c: Cobrando) => void
  alImprimir: (c: ReturnType<typeof porCobrar>['checks'][number]) => void
  alDeshacer: () => void
}) {
  return (
    <>
      <ul className="flex flex-col gap-2">
        {checks.map((c) => (
          <li
            key={c.id}
            className="flex flex-col gap-2 rounded-xl border border-linea bg-superficie p-3"
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className="font-semibold">{c.name}</span>
              {c.balance === 0 ? (
                <Etiqueta tono="free" icono="check">
                  Pagada
                </Etiqueta>
              ) : (
                <span className="cifras text-sm text-texto-suave">{`${pesos(c.balance)} + propina ${pesos(c.propinaPendiente)}`}</span>
              )}
            </span>
            {c.balance > 0 && (
              <span className="flex gap-2">
                <Boton
                  icono="receipt"
                  aria-label={`Precuenta de ${c.name}`}
                  disabled={taken}
                  onClick={() => alImprimir(c)}
                >
                  Precuenta
                </Boton>
                {puedeCobrar && (
                  <Boton
                    variant="main"
                    className="flex-1"
                    disabled={taken}
                    onClick={() =>
                      alCobrar({
                        checkId: c.id,
                        name: c.name,
                        available: c.balance,
                        check: c,
                        propinaInicial: null,
                      })
                    }
                  >
                    {`Cobrar ${pesos(c.balance)}`}
                  </Boton>
                )}
              </span>
            )}
          </li>
        ))}
        {unassigned > 0 && (
          <li className="flex flex-col gap-2 rounded-xl bg-proceso-suave p-3 text-proceso-texto">
            <span className="cifras flex justify-between">
              <span className="font-semibold">Sin asignar</span>
              <span>{pesos(unassigned)}</span>
            </span>
            {puedeCobrar && (
              <Boton
                variant="main"
                disabled={taken}
                onClick={() =>
                  alCobrar({
                    checkId: null,
                    name: 'Sin asignar',
                    available: unassigned,
                    check: null,
                    propinaInicial: null,
                  })
                }
              >
                {`Cobrar ${pesos(unassigned)}`}
              </Boton>
            )}
          </li>
        )}
      </ul>
      {puedeDeshacer && (
        <Boton variant="ghost" disabled={taken} onClick={alDeshacer}>
          Deshacer la división
        </Boton>
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
    <div className="flex items-center gap-3 rounded-2xl border border-linea bg-superficie p-3">
      <span className="flex-1 font-semibold">{name}</span>
      <Boton
        icono="minus"
        aria-label={`Quitar: quedan ${value - 1}`}
        disabled={value <= minimum}
        onClick={() => onChange(value - 1)}
      />
      <span className="cifras w-8 text-center text-xl font-semibold">{value}</span>
      <Boton
        icono="more"
        aria-label={`Agregar: quedan ${value + 1}`}
        disabled={value >= maximum}
        onClick={() => onChange(value + 1)}
      />
    </div>
  )
}

/** Anular un pago mal registrado: con motivo. La reversa cae en el turno abierto de esta caja. */
function PanelAnularPago({
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
  const [reason, setMotivo] = useState<string | null>(null)
  const [other, setOtro] = useState('')
  const final = reason === 'other' ? other.trim() || null : reason
  return (
    <PanelLateral
      opened={paymentId !== null}
      title="Anular el pago"
      onClose={onClose}
      pie={
        <Boton
          variant="danger"
          large
          className="w-full"
          disabled={!final || taken}
          onClick={() => paymentId && final && onVoid(paymentId, final)}
        >
          Anular el pago
        </Boton>
      }
    >
      <div className="flex flex-col gap-3">
        <p>El saldo vuelve a quedar por cobrar. Si fue en efectivo, devuelve el dinero.</p>
        <Grupo label="Motivo" className="flex flex-wrap gap-2">
          {MOTIVOS_ANULAR_PAGO.map((m) => (
            <Opcion key={m} elegida={reason === m} alElegir={() => setMotivo(m)}>
              {m}
            </Opcion>
          ))}
          <Opcion elegida={reason === 'other'} alElegir={() => setMotivo('other')}>
            Otro
          </Opcion>
        </Grupo>
        {reason === 'other' && (
          <input
            className={claseCampo}
            maxLength={200}
            value={other}
            placeholder="Escribe el motivo"
            // biome-ignore lint/a11y/noAutofocus: se eligió «Otro» justo para escribirlo
            autoFocus
            onChange={(e) => setOtro(e.target.value)}
          />
        )}
      </div>
    </PanelLateral>
  )
}
