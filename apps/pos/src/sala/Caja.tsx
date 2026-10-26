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
import type { Catalogo } from '@pos/sync'
import { useEffect, useRef, useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { Etiqueta } from '../ui/Etiqueta'
import { conPuntos, pesos, soloDigitos } from '../ui/formato'
import { Grupo, Opcion } from '../ui/Opciones'
import { PanelLateral } from '../ui/PanelLateral'
import { navegar } from '../ui/ruta'
import { sala, useSala, useVistaLocal } from './contexto'
import { methodName, type ReglasCobro, reglasDe } from './cuentas'
import { claseCampo } from './Entrar'
import { MarcoSala } from './MarcoSala'

// La caja de este equipo (tareas 1.6 y 1.7): abrirla con la base, ver lo cobrado en el turno,
// registrar entradas, salidas y el pago de propinas, y cerrarla con un arqueo ciego: primero se
// cuentan billetes y monedas (el conteo queda guardado), después se ve lo esperado y la diferencia,
// y desde el umbral del restaurante hay que justificarla. Todo pide conexión con el hub.

type Movement = 'entry' | 'output' | 'tip_payout'

const NOMBRE_MOVIMIENTO: Record<Movement, string> = {
  entry: 'Entrada',
  output: 'Salida',
  tip_payout: 'Pago de propinas',
}

const MOTIVOS: Record<Exclude<Movement, 'tip_payout'>, string[]> = {
  entry: ['Cambio para la caja'],
  output: ['Compra', 'Pago a proveedor'],
}

/** Lo que admite el esquema por denominación. */
const CANTIDAD_MAXIMA = 100_000

const SIN_RED =
  'Sin conexión con el hub del local: no se pueden registrar movimientos ni cerrar la caja hasta que vuelva. Revisa el cable o el Wi-Fi.'

const message = (e: unknown) => (e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.')

/** «las 6:30 p. m.» hoy; «ayer a las…» o la fecha si es de antes. */
function cuando(iso: string): string {
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

/** El día operativo de un instante, con la zona y el inicio del día del restaurante. */
const diaDe = (iso: string, reglas: ReglasCobro | null) =>
  businessDay(iso, reglas?.timeZone ?? 'America/Bogota', reglas?.inicioDiaOperativo ?? '06:00')

/** Un valor que puede ser negativo (un medio con solo devoluciones): «-5.000» → -5000. */
export const withSign = (text: string) =>
  (text.trim().startsWith('-') ? -1 : 1) * soloDigitos(text) || 0

/** «Mesa 4», «Mesa 5 + 6», «Para llevar». */
function nombreDePedido(catalog: Catalogo | null, tableId: string | null, merged: string[]) {
  if (!tableId) return 'Sin mesa'
  const names = [tableId, ...merged].map(
    (id) => catalog?.tables.find((m) => m.id === id)?.name ?? '?',
  )
  return `Mesa ${names.join(' + ')}`
}

/** Un medio que no es efectivo y se cuadra en el cierre con lo que dice su propio cierre. */
export interface MedioDelCierre {
  key: string
  method: Exclude<PaymentMethod, 'cash'>
  customMethodId: string | null
  /** «Cierre de Bold», «Llegó por Nequi». */
  etiqueta: string
  /** Su nombre en el resultado. */
  name: string
}

const PROVEEDOR: Record<string, string> = {
  bold: 'Bold',
  redeban: 'Redeban',
  credibanco: 'Credibanco',
}

const claveMedio = methodKeyOf

/**
 * Los medios a cuadrar al cerrar (tarea 1.8): los que recibe el restaurante y los que tuvieron
 * pagos en el turno (aunque ya estén apagados). La tarjeta va en una sola línea: los datáfonos de
 * un mismo proveedor entregan un solo cierre.
 */
export function mediosDelCierre(
  reglas: ReglasCobro | null,
  reconciliation: ShiftReconciliation,
  catalog: Catalogo | null,
): MedioDelCierre[] {
  const proveedores = [...new Set((catalog?.cardTerminals ?? []).map((d) => d.provider ?? 'other'))]
  const card =
    proveedores.length === 1 && proveedores[0] && PROVEEDOR[proveedores[0]]
      ? `Cierre de ${PROVEEDOR[proveedores[0]]} (total con propinas)`
      : 'Cierre de los datáfonos (la suma, con propinas)'
  const list: MedioDelCierre[] = []
  const add = (method: PaymentMethod, customMethodId: string | null) => {
    // Un medio propio sin decir cuál (un reembolso sin su pago aquí) no tiene cierre que pedir.
    if (method === 'cash' || (method === 'other' && !customMethodId)) return
    const key = claveMedio({ method, customMethodId })
    if (list.some((m) => m.key === key)) return
    const name = methodName(method, customMethodId, reglas)
    list.push({
      key,
      method,
      customMethodId,
      name,
      etiqueta: method === 'card' ? card : `Llegó por ${name}`,
    })
  }
  for (const m of reglas?.mediosPago ?? []) add(m, null)
  for (const m of reglas?.mediosPropios ?? []) add('other', m.id)
  for (const m of reconciliation.byMethod) add(m.method, m.customMethodId)
  return list
}

export function Caja() {
  const { device, connection, session, catalog } = useSala()
  const vista = useVistaLocal()
  const avisar = useAvisar()
  const [base, setBase] = useState(0)
  const [ocupado, setOcupado] = useState(false)
  const [moviendo, setMoviendo] = useState<Movement | null>(null)
  const [cerrando, setCerrando] = useState(false)
  // El conteo vive aquí: salir del cierre y volver no lo borra.
  const [cantidades, setCantidades] = useState<Record<string, number>>({})
  // Lo que dicen los cierres de los demás medios (Bold, Nequi…), con el conteo.
  const [reports, setReportes] = useState<Record<string, string>>({})
  // El último cierre de este equipo, para mostrar cómo quedó.
  const [closed, setCerrado] = useState<ShiftReconciliation | null>(null)

  if (!vista) return null
  const reglas = reglasDe(catalog)
  const esCaja = device?.type === 'register'
  const permissions = session?.permissions ?? []
  const puedeAbrir = permissions.includes('open_register_shift')
  const puedeMover = permissions.includes('cash_movement')
  const puedeCerrar = permissions.includes('close_register_shift')
  const enLinea = connection === 'connected'
  const shift = vista.shift
  const reconciliation = vista.reconciliation
  // Un turno de un día operativo anterior: hay que cerrarlo para cuadrar ese día.
  const deOtroDia =
    shift !== null && diaDe(shift.openedAt, reglas) !== diaDe(new Date().toISOString(), reglas)

  const hacer = async (trabajo: () => Promise<void>) => {
    if (ocupado) return
    setOcupado(true)
    try {
      await trabajo()
    } catch (e) {
      avisar(message(e))
    } finally {
      setOcupado(false)
    }
  }

  const open = () =>
    hacer(async () => {
      await sala.abrirTurno(base)
      setCerrado(null)
      avisar(`Caja abierta con ${pesos(base)} de base`)
      // Si venía de cobrar una cuenta, vuelve a ella.
      const back = new URLSearchParams(location.search).get('back')
      if (back?.startsWith('/check?')) navegar(back)
    })

  const sinRed = !enLinea && (
    <p className="rounded-xl bg-alerta-suave p-3 text-alerta-texto">{SIN_RED}</p>
  )

  return (
    <MarcoSala title="Caja">
      <div className="mx-auto flex max-w-xl flex-col gap-4 p-3 md:p-5">
        {!esCaja ? (
          <p className="rounded-2xl bg-proceso-suave p-4 text-proceso-texto">
            Este equipo no es de caja. Para cobrar, entra con el usuario y la contraseña de caja en
            el computador de la caja.
          </p>
        ) : shift && reconciliation && cerrando ? (
          <Cierre
            reconciliation={reconciliation}
            reglas={reglas}
            cantidades={cantidades}
            alCambiarCantidades={setCantidades}
            medios={mediosDelCierre(reglas, reconciliation, catalog)}
            reports={reports}
            alCambiarReportes={setReportes}
            mesasAbiertas={vista.orders
              .map((p) => ({
                id: p.status.id,
                name: nombreDePedido(catalog, p.status.tableId, p.status.mergedTables),
                balance: orderTotals(p.status).balance,
              }))
              .filter((m) => m.balance > 0)}
            sinRed={sinRed}
            enLinea={enLinea}
            alVolver={() => setCerrando(false)}
            alCerrar={(c) => {
              setCerrando(false)
              setCantidades({})
              setReportes({})
              setCerrado(c)
            }}
          />
        ) : shift && reconciliation ? (
          <>
            <section className="rounded-2xl border border-linea bg-superficie p-4 shadow-flota">
              <p className="text-lg font-semibold">
                {`Caja abierta desde ${cuando(shift.openedAt)}`}
                {shift.porConfirmar && (
                  <span className="ml-2 text-sm font-normal text-texto-suave">(sin confirmar)</span>
                )}
              </p>
              <p className="cifras text-texto-suave">{`Base: ${pesos(shift.base)}`}</p>
            </section>
            {deOtroDia && (
              <p className="rounded-xl bg-alerta-suave p-3 text-alerta-texto">
                Esta caja sigue abierta de un día anterior. Ciérrala para cuadrar ese día y ábrela
                de nuevo con la base de hoy.
              </p>
            )}
            <Cobrado
              reconciliation={reconciliation}
              reglas={reglas}
              conMontos={permissions.includes('view_reports')}
            />
            <Movimientos reconciliation={reconciliation} />
            {sinRed}
            {puedeMover && (
              <div className="grid grid-cols-3 gap-2">
                {(['entry', 'output', 'tip_payout'] as const).map((t) => (
                  <Boton key={t} disabled={!enLinea || ocupado} onClick={() => setMoviendo(t)}>
                    {NOMBRE_MOVIMIENTO[t]}
                  </Boton>
                ))}
              </div>
            )}
            {puedeCerrar && (
              <Boton
                variant="main"
                large
                icono="check"
                disabled={!enLinea || shift.porConfirmar}
                onClick={() => setCerrando(true)}
              >
                Cerrar la caja
              </Boton>
            )}
            <PanelMovimiento
              key={moviendo ?? 'closed'}
              type={moviendo}
              reconciliation={reconciliation}
              ocupado={ocupado}
              alCerrar={() => setMoviendo(null)}
              onSave={(data) =>
                hacer(async () => {
                  await sala.registrarConfirmado('CashMovementRecorded', shift.id, {
                    ...data,
                    days:
                      data.type === 'tip_payout' ? [diaDe(new Date().toISOString(), reglas)] : [],
                  })
                  setMoviendo(null)
                  avisar(`${NOMBRE_MOVIMIENTO[data.type]} de ${pesos(data.amount)} registrada`)
                })
              }
            />
          </>
        ) : (
          <>
            {closed && <Result reconciliation={closed} reglas={reglas} />}
            {!puedeAbrir ? (
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
                    className={`${claseCampo} cifras mt-2 min-h-14 text-2xl`}
                    value={conPuntos(base)}
                    placeholder="0"
                    onChange={(e) => setBase(soloDigitos(e.target.value))}
                  />
                </label>
                {sinRed}
                <Boton
                  variant="main"
                  large
                  icono="bill"
                  disabled={ocupado || !enLinea}
                  onClick={open}
                >
                  {base === 0 ? 'Abrir sin base' : `Abrir con ${pesos(base)}`}
                </Boton>
              </section>
            )}
          </>
        )}
      </div>
    </MarcoSala>
  )
}

/** «3 pagos»; nada si quedó en 0 o menos (una anulación de otro turno). */
const cuantos = (n: number) => (n > 0 ? ` · ${n === 1 ? '1 pago' : `${n} pagos`}` : '')

/**
 * Lo cobrado en el turno por medio, con el total. El cajero solo ve cuántos pagos hay: con los
 * montos podría saber lo esperado antes de contar y el arqueo dejaría de ser ciego. Quien ve los
 * reportes (el administrador) ve los montos.
 */
function Cobrado({
  reconciliation,
  reglas,
  conMontos,
}: {
  reconciliation: ShiftReconciliation
  reglas: ReglasCobro | null
  conMontos: boolean
}) {
  const sale = reconciliation.byMethod.reduce((a, m) => a + m.sale, 0)
  const tips = reconciliation.byMethod.reduce((a, m) => a + m.tip, 0)
  if (!conMontos)
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
                  {`${methodName(m.method, m.customMethodId, reglas)}${cuantos(m.payments)}`}
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
              <dt>{`${methodName(m.method, m.customMethodId, reglas)}${cuantos(m.payments)}`}</dt>
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

function Movimientos({ reconciliation }: { reconciliation: ShiftReconciliation }) {
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
              {NOMBRE_MOVIMIENTO[m.type]}
              <span className="text-texto-suave">{` · ${m.toWhom ?? m.description}`}</span>
            </span>
            <span>{`${m.type === 'entry' ? '+' : '-'}${pesos(m.amount)}`}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

interface DatosMovimiento {
  movement_id: string
  type: Movement
  amount: number
  description: string
  to_whom: string | null
}

/** Registrar una entrada, una salida o un pago de propinas, con su motivo y confirmando. */
function PanelMovimiento({
  type,
  reconciliation,
  ocupado,
  alCerrar,
  onSave,
}: {
  type: Movement | null
  reconciliation: ShiftReconciliation
  ocupado: boolean
  alCerrar: () => void
  onSave: (data: DatosMovimiento) => void
}) {
  // El mismo id en cada intento: reintentar no registra el movimiento dos veces.
  const [movimientoId] = useState(newId)
  const [amount, setMonto] = useState(0)
  const [reason, setMotivo] = useState<string | null>(null)
  const [other, setOtro] = useState('')
  const [toWhom, setAQuien] = useState('')
  const [confirmando, setConfirmando] = useState(false)
  const tips = reconciliation.byMethod.reduce((a, m) => a + m.tip, 0)
  const isOutflow = type === 'output' || type === 'tip_payout'
  const description =
    type === 'tip_payout' ? 'Pago de propinas' : reason === 'other' ? other.trim() : (reason ?? '')
  const ready =
    type !== null &&
    amount > 0 &&
    (type === 'tip_payout' ? toWhom.trim().length > 0 : description.length > 0)
  const guardar = () =>
    type &&
    onSave({
      movement_id: movimientoId,
      type,
      amount,
      description,
      to_whom: type === 'tip_payout' ? toWhom.trim() : null,
    })
  return (
    <PanelLateral
      opened={type !== null}
      title={type ? NOMBRE_MOVIMIENTO[type] : 'Movimiento'}
      alCerrar={alCerrar}
      pie={
        confirmando ? (
          <div
            className="flex flex-col gap-2"
            role="alertdialog"
            aria-labelledby="confirm-movement"
          >
            <p id="confirm-movement" className="text-lg font-semibold">
              {`¿${isOutflow ? 'Sacar' : 'Meter'} ${pesos(amount)} del cajón?`}
            </p>
            <div className="grid grid-cols-[2fr_3fr] gap-2">
              <Boton onClick={() => setConfirmando(false)}>Volver</Boton>
              <Boton variant="main" disabled={ocupado} onClick={guardar}>
                {ocupado ? 'Registrando…' : `Sí, registrar ${pesos(amount)}`}
              </Boton>
            </div>
          </div>
        ) : (
          <Boton
            variant="main"
            large
            className="w-full"
            disabled={!ready}
            onClick={() => setConfirmando(true)}
          >
            {`Registrar ${pesos(amount)}`}
          </Boton>
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
            className={`${claseCampo} cifras mt-1 min-h-14 text-2xl`}
            value={conPuntos(amount)}
            placeholder="0"
            // biome-ignore lint/a11y/noAutofocus: el panel se abre para escribir el monto
            autoFocus
            onChange={(e) => {
              setMonto(soloDigitos(e.target.value))
              setConfirmando(false)
            }}
          />
        </label>
        {/* Sin la cifra del esperado: el arqueo es ciego. */}
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
                className={`${claseCampo} mt-1`}
                maxLength={100}
                value={toWhom}
                placeholder="Nombre, o elige «Todo el equipo»"
                onChange={(e) => setAQuien(e.target.value)}
              />
            </label>
            <Opcion
              elegida={toWhom === 'Todo el equipo'}
              alElegir={() => setAQuien('Todo el equipo')}
            >
              Todo el equipo
            </Opcion>
          </>
        ) : (
          type && (
            <div className="flex flex-col gap-2">
              <span className="font-semibold">Motivo</span>
              <Grupo etiqueta="Motivo" className="flex flex-wrap gap-2">
                {MOTIVOS[type].map((m) => (
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
                  onChange={(e) => setOtro(e.target.value)}
                />
              )}
            </div>
          )
        )}
      </div>
    </PanelLateral>
  )
}

/**
 * El cierre con arqueo ciego: se cuenta sin ver lo esperado; al guardar el conteo se ve la
 * diferencia. «Volver a contar» empieza de cero y guarda otro conteo (el primero no se borra).
 * En la caja se cuenta con el teclado: el número y Enter pasan a la denominación siguiente.
 */
function Cierre({
  reconciliation,
  reglas,
  cantidades,
  alCambiarCantidades,
  medios,
  reports,
  alCambiarReportes,
  mesasAbiertas,
  sinRed,
  enLinea,
  alVolver,
  alCerrar,
}: {
  reconciliation: ShiftReconciliation
  reglas: ReglasCobro | null
  cantidades: Record<string, number>
  alCambiarCantidades: (c: Record<string, number>) => void
  medios: MedioDelCierre[]
  /** Lo escrito en cada medio (texto, para poder empezar con «-»). */
  reports: Record<string, string>
  alCambiarReportes: (r: Record<string, string>) => void
  mesasAbiertas: { id: string; name: string; balance: number }[]
  sinRed: React.ReactNode
  enLinea: boolean
  alVolver: () => void
  alCerrar: (reconciliation: ShiftReconciliation) => void
}) {
  const avisar = useAvisar()
  const [arqueoId, setArqueoId] = useState<string | null>(null)
  // El cuadre de los demás medios con lo reportado en el conteo guardado.
  const [others, setOtros] = useState<MethodReconciliation[]>([])
  const [justification, setJustificacion] = useState('')
  const [ocupado, setOcupado] = useState(false)
  const [confirmando, setConfirmando] = useState(false)
  // Lo esperado queda fijo al guardar el conteo: si después entra un pago, hay que recontar.
  const [esperadoAlContar, setEsperadoAlContar] = useState<number | null>(null)
  const fields = useRef<(HTMLInputElement | null)[]>([])
  const guardar = useRef<HTMLButtonElement>(null)
  const textoJustificacion = useRef<HTMLTextAreaElement>(null)
  const botonCerrar = useRef<HTMLButtonElement>(null)
  const key = (d: (typeof DENOMINATIONS)[number]) => `${d.type}${d.value}`
  const cantidadDe = (d: (typeof DENOMINATIONS)[number]) => cantidades[key(d)] ?? 0
  const counted = DENOMINATIONS.reduce((a, d) => a + d.value * cantidadDe(d), 0)
  const expected = esperadoAlContar ?? reconciliation.cash.expected
  const cambioDespues =
    esperadoAlContar !== null && esperadoAlContar !== reconciliation.cash.expected
  const variance = counted - expected
  // Los medios con cobros en el turno deben tener su cierre escrito (un vacío no es un 0).
  const conCobros = new Set(reconciliation.byMethod.map(methodKeyOf))
  const sinEscribir = medios.filter((m) => conCobros.has(m.key) && !(reports[m.key] ?? '').trim())
  const umbral = reglas?.umbralDiferencia ?? 1000
  const large = (d: number) => d !== 0 && Math.abs(d) >= Math.max(1, umbral)
  const pideJustificar = large(variance) || others.some((o) => large(o.variance))
  const hayDiferencia = variance !== 0 || others.some((o) => o.variance !== 0)
  // Las líneas que pasan el umbral, para decir qué hay que explicar.
  const nombreOtro = (o: MethodReconciliation) =>
    medios.find((m) => m.key === methodKeyOf(o))?.name ??
    methodName(o.method, o.customMethodId, reglas)
  const porExplicar = [
    ...(large(variance) ? ['cash'] : []),
    ...others.filter((o) => large(o.variance)).map(nombreOtro),
  ]
  const inicioDia = reglas?.inicioDiaOperativo ?? '06:00'

  // Al guardar el conteo, el foco sigue el camino: la justificación si hace falta, si no, cerrar.
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo al cambiar de conteo, no al escribir
  useEffect(() => {
    if (arqueoId === null) return
    if (pideJustificar) textoJustificacion.current?.focus()
    else botonCerrar.current?.focus()
  }, [arqueoId])

  const hacer = async (trabajo: () => Promise<void>) => {
    if (ocupado) return
    setOcupado(true)
    try {
      await trabajo()
    } catch (e) {
      avisar(message(e))
    } finally {
      setOcupado(false)
    }
  }

  const guardarConteo = () =>
    hacer(async () => {
      const id = newId()
      // Billete y moneda del mismo valor (los $1.000) van juntos en el conteo.
      const porValor = new Map<number, number>()
      for (const d of DENOMINATIONS)
        if (cantidadDe(d) > 0) porValor.set(d.value, (porValor.get(d.value) ?? 0) + cantidadDe(d))
      const reportados = medios.map((m) => ({
        method: m.method,
        custom_method_id: m.customMethodId,
        reported: withSign(reports[m.key] ?? ''),
      }))
      await sala.registrarConfirmado('CashCountRecorded', reconciliation.shiftId, {
        cash_count_id: id,
        tally: [...porValor].map(([value, quantity]) => ({ value, quantity })),
        counted_cash: counted,
        others: reportados,
      })
      setOtros(
        otherMethodsReconciliation(reconciliation, {
          id,
          tally: [],
          counted,
          others: reportados.map((r) => ({
            method: r.method,
            customMethodId: r.custom_method_id,
            reported: r.reported,
          })),
          time: '',
        }),
      )
      setEsperadoAlContar(reconciliation.cash.expected)
      setConfirmando(false)
      setArqueoId(id)
    })

  const close = () =>
    hacer(async () => {
      if (!arqueoId) return
      const final = justification.trim() || null
      await sala.registrarConfirmado('ShiftClosed', reconciliation.shiftId, {
        cash_count_id: arqueoId,
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
      avisar('Caja cerrada')
      alCerrar({
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

  const porCobrar = mesasAbiertas.reduce((a, m) => a + m.balance, 0)
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl font-bold tracking-tight">Cerrar la caja</h2>
        <Boton variant="ghost" onClick={alVolver}>
          Cancelar el cierre
        </Boton>
      </div>
      {mesasAbiertas.length > 0 && (
        <div className="rounded-xl bg-proceso-suave p-3 text-proceso-texto">
          <p>
            {`${mesasAbiertas.length === 1 ? 'Queda 1 mesa abierta' : `Quedan ${mesasAbiertas.length} mesas abiertas`} con ${pesos(porCobrar)} por cobrar. Lo que se cobre después de cerrar cae en el próximo turno.`}
          </p>
          <ul className="cifras mt-1">
            {mesasAbiertas.slice(0, 8).map((m) => (
              <li key={m.id}>{`${m.name} · ${pesos(m.balance)}`}</li>
            ))}
          </ul>
        </div>
      )}
      {arqueoId === null ? (
        <section
          className="flex flex-col gap-3 rounded-2xl border border-linea bg-superficie p-4"
          aria-label="Conteo del efectivo"
        >
          <p>Cuenta el efectivo del cajón: cuántos billetes y monedas hay de cada uno.</p>
          <p className="text-sm text-texto-suave">
            {umbral <= 1
              ? 'Si algo no cuadra, se pide explicarlo.'
              : `Si algo no cuadra desde ${pesos(umbral)}, se pide explicarlo.`}
          </p>
          <ul className="flex flex-col gap-2">
            {DENOMINATIONS.map((d, i) => {
              const n = cantidadDe(d)
              const name = `${d.type === 'bill' ? 'billetes' : 'monedas'} de ${pesos(d.value)}`
              const poner = (v: number) =>
                alCambiarCantidades({
                  ...cantidades,
                  [key(d)]: Math.min(CANTIDAD_MAXIMA, Math.max(0, v)),
                })
              return (
                <li key={key(d)} className="flex items-center gap-2">
                  <span className="cifras w-24 shrink-0 font-semibold">
                    {pesos(d.value)}
                    <span className="block text-sm font-normal text-texto-suave">{d.type}</span>
                  </span>
                  {/* − y + son para el dedo: con el teclado se escribe el número (no reciben foco). */}
                  <Boton
                    icono="minus"
                    tabIndex={-1}
                    aria-label={`Quitar uno: ${name}`}
                    disabled={n === 0}
                    onClick={() => poner(n - 1)}
                  />
                  <input
                    ref={(el) => {
                      fields.current[i] = el
                    }}
                    inputMode="numeric"
                    aria-label={`Cantidad de ${name}`}
                    className={`${claseCampo} cifras w-16 text-center`}
                    value={n ? String(n) : ''}
                    placeholder="0"
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => poner(soloDigitos(e.target.value))}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return
                      e.preventDefault()
                      const next = fields.current[i + 1]
                      if (next) next.focus()
                      else guardar.current?.focus()
                    }}
                  />
                  <Boton
                    icono="more"
                    tabIndex={-1}
                    aria-label={`Agregar uno: ${name}`}
                    onClick={() => poner(n + 1)}
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
          {medios.length > 0 && (
            <div className="flex flex-col gap-2 border-t border-linea pt-3">
              <h3 className="font-semibold">Los demás medios</h3>
              <p className="text-sm text-texto-suave">
                {`Escribe el total del cierre del datáfono (en su app o en el papel del cierre) y lo que llegó a cada app, desde las ${inicioDia} de hoy. Si solo hubo devoluciones, empieza con «-».`}
              </p>
              {medios.map((m, j) => (
                <label key={m.key} className="flex items-center gap-2">
                  <span className="flex-1">{m.etiqueta}</span>
                  <input
                    ref={(el) => {
                      fields.current[DENOMINATIONS.length + j] = el
                    }}
                    inputMode="numeric"
                    className={`${claseCampo} cifras w-40 text-right`}
                    value={reports[m.key] ?? ''}
                    placeholder={conCobros.has(m.key) ? 'Escríbelo' : '0'}
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) =>
                      alCambiarReportes({
                        ...reports,
                        [m.key]: e.target.value.replace(/[^\d.-]/g, '').slice(0, 13),
                      })
                    }
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return
                      e.preventDefault()
                      const next = fields.current[DENOMINATIONS.length + j + 1]
                      if (next) next.focus()
                      else guardar.current?.focus()
                    }}
                  />
                </label>
              ))}
            </div>
          )}
          {sinEscribir.length > 0 && (
            <p className="text-sm text-texto-suave">
              {`Falta escribir: ${sinEscribir.map((m) => m.name).join(', ')}.`}
            </p>
          )}
          {sinRed}
          <Boton
            ref={guardar}
            variant="main"
            large
            disabled={ocupado || !enLinea || sinEscribir.length > 0}
            onClick={guardarConteo}
          >
            {ocupado ? 'Guardando…' : 'Guardar el conteo'}
          </Boton>
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
            reglas={reglas}
            title="Así queda la caja"
          />
          {cambioDespues && (
            <p className="rounded-xl bg-alerta-suave p-3 text-alerta-texto">
              Entró un pago o un movimiento después del conteo: vuelve a contar.
            </p>
          )}
          {hayDiferencia && (
            <label>
              <span className="font-semibold">
                {pideJustificar
                  ? `Explica por qué no cuadra: ${porExplicar.join(', ')}`
                  : '¿Por qué no cuadra? (opcional)'}
              </span>
              {pideJustificar && (
                <span className="block text-sm text-texto-suave">
                  {umbral <= 1
                    ? 'Toda diferencia se explica; queda en el informe.'
                    : `Desde ${pesos(umbral)} de diferencia hay que explicarla; queda en el informe.`}
                </span>
              )}
              <textarea
                ref={textoJustificacion}
                className={`${claseCampo} mt-1 min-h-24 py-2`}
                maxLength={500}
                value={justification}
                onChange={(e) => setJustificacion(e.target.value)}
              />
            </label>
          )}
          {sinRed}
          {pideJustificar && !justification.trim() && (
            <p className="text-sm text-texto-suave">Para cerrar, falta explicar la diferencia.</p>
          )}
          {confirmando ? (
            <div
              className="rounded-2xl border-2 border-accion-fuerte bg-accion-suave p-3 text-accion-texto"
              role="alertdialog"
              aria-labelledby="confirm-close"
            >
              <p id="confirm-close" className="mb-3 text-lg font-semibold">
                ¿Cerrar la caja? Después de cerrar ya no se cobra en este turno.
              </p>
              <div className="grid grid-cols-[2fr_3fr] gap-2">
                <Boton onClick={() => setConfirmando(false)}>Volver</Boton>
                <Boton variant="main" disabled={ocupado} onClick={close}>
                  {ocupado ? 'Cerrando…' : 'Sí, cerrar la caja'}
                </Boton>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-[2fr_3fr] gap-2">
              <Boton
                disabled={ocupado}
                onClick={() => {
                  // Volver a contar guarda otro conteo (el anterior queda); lo escrito se puede
                  // corregir sin empezar de cero.
                  setArqueoId(null)
                  setOtros([])
                  setEsperadoAlContar(null)
                  setJustificacion('')
                }}
              >
                Volver a contar
              </Boton>
              <Boton
                ref={botonCerrar}
                variant="main"
                large
                disabled={
                  ocupado || !enLinea || cambioDespues || (pideJustificar && !justification.trim())
                }
                onClick={() => setConfirmando(true)}
              >
                Cerrar la caja
              </Boton>
            </div>
          )}
        </>
      )}
    </>
  )
}

/** Cómo quedó (o queda) la caja: lo esperado, lo contado, la diferencia y los otros medios. */
function Result({
  reconciliation,
  reglas,
  title = 'Cómo quedó la caja',
}: {
  reconciliation: ShiftReconciliation
  reglas: ReglasCobro | null
  title?: string
}) {
  const c = reconciliation.closed
  if (!c) return null
  const digitales = reconciliation.byMethod.filter((m) => m.method !== 'cash')
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
          <span className="ml-2 text-sm font-normal text-texto-suave">{`· cerrada a ${cuando(c.time)}`}</span>
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
        <Diferencia value={c.variance} />
      </p>
      {/* Un turno cerrado antes de la 1.8 no tiene el cuadre de los demás medios: solo lo registrado. */}
      {c.otherMethods.length > 0 ? (
        <div>
          <h3 className="font-semibold">Los demás medios</h3>
          <ul className="cifras mt-1 flex flex-col gap-2">
            {c.otherMethods.map((m) => (
              <li key={claveMedio(m)} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {methodName(m.method, m.customMethodId, reglas)}
                  <span className="block text-sm text-texto-suave">{`En la caja ${pesos(m.expected)} · según su cierre ${pesos(m.reported)}`}</span>
                </span>
                <Diferencia value={m.variance} />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        digitales.length > 0 && (
          <div>
            <h3 className="font-semibold">Los demás medios</h3>
            <ul className="cifras mt-1 flex flex-col gap-1">
              {digitales.map((m) => (
                <li key={claveMedio(m)} className="flex justify-between">
                  <span>{methodName(m.method, m.customMethodId, reglas)}</span>
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

/** «Cuadra», «Sobran $X» o «Faltan $X», con su ícono. */
export function Diferencia({ value }: { value: number }) {
  if (value === 0)
    return (
      <Etiqueta tono="free" icono="check">
        Cuadra
      </Etiqueta>
    )
  return value > 0 ? (
    <Etiqueta tono="progress" icono="more">
      {`Sobran ${pesos(value)}`}
    </Etiqueta>
  ) : (
    <Etiqueta tono="warning" icono="minus">
      {`Faltan ${pesos(-value)}`}
    </Etiqueta>
  )
}
