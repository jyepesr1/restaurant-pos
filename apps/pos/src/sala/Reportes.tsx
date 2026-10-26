import { methodKeyOf } from '@pos/core'
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { Etiqueta } from '../ui/Etiqueta'
import { pesos } from '../ui/formato'
import { Grupo, Opcion } from '../ui/Opciones'
import { navegar } from '../ui/ruta'
import { Diferencia } from './Caja'
import { sala, useSala } from './contexto'
import { methodName, nombreImpuesto, reglasDe } from './cuentas'
import { claseCampo } from './Entrar'
import { MarcoSala } from './MarcoSala'
import type { CierreReporte, Reporte } from './motor'
import {
  type Atajo,
  csvDeReporte,
  diaCorto,
  MAX_DIAS,
  nombreCsv,
  type Periodo,
  percent,
  periodoDe,
  periodoEnPalabras,
  puntosEnPorcentaje,
} from './periodos'

// Reportes básicos (tarea 1.9, docs/KPIS.md): ventas, medios de pago, meseros, productos,
// anulaciones y cierres de caja de un día o de un período. Solo para quien tiene «Ver todos los
// reportes». Todo sale del hub, calculado con @pos/core; aquí solo se muestra.

const ATAJOS: { value: Atajo | 'range'; name: string }[] = [
  { value: 'today', name: 'Hoy' },
  { value: 'yesterday', name: 'Ayer' },
  { value: 'week', name: 'Últimos 7 días' },
  { value: 'month', name: 'Este mes' },
  { value: 'lastMonth', name: 'Mes pasado' },
  { value: 'range', name: 'Otras fechas' },
]

/** Cuántos productos se ven antes de «Ver todos». */
const PRODUCTOS_VISIBLES = 10

/** Lo que se resta, con su signo («-$30.900»); en cero, «$0». */
const minus = (n: number) => (n === 0 ? pesos(0) : `-${pesos(n)}`)

const message = (e: unknown) => (e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.')

export function Reportes() {
  const avisar = useAvisar()
  const { catalog, session } = useSala()
  const reglas = reglasDe(catalog)
  const [atajo, setAtajo] = useState<Atajo | 'range'>('today')
  /** El período que se pidió (puede no haber llegado todavía) y el que se está mostrando. */
  const [order, setPedido] = useState<Periodo | null>(null)
  const [mostrado, setMostrado] = useState<{ report: Reporte; period: Periodo } | null>(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Solo cuenta la respuesta del último pedido: una lenta de antes no pisa la nueva.
  const ultimo = useRef(0)

  const cargar = useCallback((p: Periodo | null) => {
    const numero = ++ultimo.current
    setPedido(p)
    setCargando(true)
    setError(null)
    sala
      .report(p)
      .then((r) => {
        if (numero !== ultimo.current) return
        setMostrado({ report: r, period: p ?? { from: r.today, until: r.today } })
      })
      .catch((e) => {
        if (numero === ultimo.current) setError(message(e))
      })
      .finally(() => {
        if (numero === ultimo.current) setCargando(false)
      })
  }, [])
  useEffect(() => cargar(null), [cargar])

  const today = mostrado?.report.today ?? null
  const select = (value: Atajo | 'range') => {
    setAtajo(value)
    if (value !== 'range' && today) cargar(periodoDe(value, today))
  }

  const descargar = () => {
    if (!mostrado) return
    const { report, period } = mostrado
    const csv = csvDeReporte(report, period, reglas, catalog?.restaurant.name ?? '')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const enlace = document.createElement('a')
    enlace.href = url
    enlace.download = nombreCsv(period)
    enlace.click()
    URL.revokeObjectURL(url)
    avisar(`Descargaste ${nombreCsv(period)}`)
  }

  return (
    <MarcoSala
      titulo="Reportes"
      actions={
        mostrado && (
          <Boton icono="receipt" onClick={descargar}>
            Descargar CSV
          </Boton>
        )
      }
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 md:p-6">
        <Grupo etiqueta="Período" className="flex flex-wrap gap-2">
          {ATAJOS.map((a) => (
            <Opcion key={a.value} elegida={atajo === a.value} alElegir={() => select(a.value)}>
              {a.name}
            </Opcion>
          ))}
        </Grupo>
        {atajo === 'range' && today && (
          <Rango today={today} initial={mostrado?.period ?? null} alVer={(p) => cargar(p)} />
        )}

        {error && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-2xl border border-alerta-fuerte bg-alerta-suave p-4"
          >
            <p className="text-alerta-texto">
              {mostrado
                ? `${error} Abajo sigue lo de ${periodoEnPalabras(mostrado.period)}.`
                : error}
            </p>
            <Boton onClick={() => cargar(order)}>Intentar de nuevo</Boton>
          </div>
        )}
        {!mostrado && !error && <p className="text-texto-suave">Leyendo las ventas…</p>}
        {mostrado && (
          <Contenido
            report={mostrado.report}
            period={mostrado.period}
            cargando={cargando}
            reglas={reglas}
            puedeElegirImpresora={!!session?.permissions.includes('manage_devices')}
          />
        )}
      </div>
    </MarcoSala>
  )
}

/** Desde y hasta: carga sola al cambiar una fecha (las dos deben estar escritas). */
function Rango({
  today,
  initial,
  alVer,
}: {
  today: string
  initial: Periodo | null
  alVer: (p: Periodo) => void
}) {
  const [from, setDesde] = useState(initial?.from ?? today)
  const [until, setHasta] = useState(initial?.until ?? today)
  const ver = (d: string, h: string) => {
    if (d && h) alVer(d <= h ? { from: d, until: h } : { from: h, until: d })
  }
  const al = (e: FormEvent) => {
    e.preventDefault()
    ver(from, until)
  }
  return (
    <form onSubmit={al} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-sm text-texto-suave">Desde</span>
        <input
          type="date"
          className={`${claseCampo} w-auto`}
          value={from}
          max={today}
          required
          onChange={(e) => {
            setDesde(e.target.value)
            ver(e.target.value, until)
          }}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm text-texto-suave">Hasta</span>
        <input
          type="date"
          className={`${claseCampo} w-auto`}
          value={until}
          max={today}
          required
          onChange={(e) => {
            setHasta(e.target.value)
            ver(from, e.target.value)
          }}
        />
      </label>
      <p className="pb-3 text-sm text-texto-suave">Hasta {MAX_DIAS} días.</p>
    </form>
  )
}

function Contenido({
  report,
  period,
  cargando,
  reglas,
  puedeElegirImpresora,
}: {
  report: Reporte
  period: Periodo
  cargando: boolean
  reglas: ReturnType<typeof reglasDe>
  puedeElegirImpresora: boolean
}) {
  const { report: inf, usuarios } = report
  const v = inf.sales
  const quien = (id: string | null) => (id ? (usuarios[id] ?? 'Alguien') : '')
  const sinVentas = v.net === 0 && v.checks === 0 && inf.byMethod.length === 0
  return (
    <div
      aria-busy={cargando}
      className={`flex flex-col gap-4 transition-opacity ${cargando ? 'opacity-60' : ''}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="font-titulo text-2xl font-bold tracking-tight first-letter:uppercase">
          {periodoEnPalabras(period)}
        </h2>
        {cargando && <p className="text-sm text-texto-suave">Actualizando…</p>}
      </div>

      <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <Cifra name="Ventas" value={pesos(v.net)} destacada />
        <Cifra name="Cuentas" value={String(v.checks)} />
        <Cifra name="Ticket promedio" value={pesos(v.averageTicket)} />
        <Cifra
          name="Comensales"
          value={String(v.guests)}
          detalle={v.guests > 0 ? `${pesos(v.spendPerGuest)} por persona` : undefined}
        />
        <Cifra name="Propinas" value={pesos(v.tips)} />
      </dl>

      {sinVentas && (
        <p className="rounded-2xl border border-linea bg-superficie p-4 text-texto-suave">
          No hay ventas cerradas en este período.
        </p>
      )}

      <Tarjeta titulo="Cierres de caja">
        {report.closings.length === 0 ? (
          <EmptyState>Ninguna caja se cerró en este período.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-3">
            {report.closings.map((c) => (
              <Cierre
                key={c.shiftId}
                closeout={c}
                varios={period.from !== period.until}
                quien={quien}
                reglas={reglas}
                printer={report.printer}
                puedeElegirImpresora={puedeElegirImpresora}
              />
            ))}
          </ul>
        )}
      </Tarjeta>

      <div className="grid gap-4 lg:grid-cols-2">
        <Tarjeta titulo="Ventas">
          <Filas>
            <Fila name="Bruto" value={pesos(v.gross)} />
            {v.voided > 0 && <Fila name="Productos anulados" value={minus(v.voided)} />}
            {v.discounts > 0 && <Fila name="Descuentos" value={minus(v.discounts)} />}
            <Fila name="Ventas" value={pesos(v.net)} main />
            {v.settings !== 0 && (
              <Fila name="Ajuste por redondeo del efectivo" value={pesos(v.settings)} />
            )}
            {v.taxes.length > 0 && (
              <Fila
                name="Base sin impuestos"
                value={pesos(v.taxes.reduce((a, i) => a + i.base, 0))}
              />
            )}
            {v.taxes
              .filter((i) => i.tax > 0)
              .map((i) => (
                <Fila
                  key={`${i.type}${i.rate}`}
                  name={nombreImpuesto(i.type, i.rate)}
                  value={pesos(i.tax)}
                />
              ))}
          </Filas>
          <Nota>Impuestos informativos: valídalos con tu contador.</Nota>
        </Tarjeta>

        <Tarjeta titulo="Por medio de pago">
          {inf.byMethod.length === 0 ? (
            <EmptyState>Sin pagos en este período.</EmptyState>
          ) : (
            <Filas>
              {inf.byMethod.map((m) => (
                <Fila
                  key={methodKeyOf(m)}
                  name={`${methodName(m.method, m.customMethodId, reglas)}${m.payments > 0 ? ` · ${m.payments} ${m.payments === 1 ? 'pago' : 'pagos'}` : ''}`}
                  value={pesos(m.sale)}
                  detalle={m.tip !== 0 ? `+ propina ${pesos(m.tip)}` : undefined}
                />
              ))}
            </Filas>
          )}
          <Nota>Cuenta los pagos el día en que se cobraron, aunque la mesa cierre otro día.</Nota>
        </Tarjeta>

        <Tarjeta titulo="Por mesero">
          {inf.byWaiter.length === 0 ? (
            <EmptyState>Sin ventas en este período.</EmptyState>
          ) : (
            <Tabla
              columnas={['Mesero', 'Ventas', 'Cuentas', 'Ticket']}
              rows={inf.byWaiter.map((m) => ({
                key: m.userId,
                celdas: [quien(m.userId), pesos(m.net), String(m.checks), pesos(m.averageTicket)],
              }))}
            />
          )}
          <Nota>Las propinas van al fondo común: no se reparten por mesero.</Nota>
        </Tarjeta>

        <Productos report={report} />

        <Tarjeta titulo="Anulaciones y cancelaciones">
          {inf.voids.length === 0 && inf.cancellations.length === 0 ? (
            <EmptyState>Nada anulado ni cancelado.</EmptyState>
          ) : (
            <ul className="flex flex-col divide-y divide-linea">
              {inf.voids.map((a) => (
                <Evento
                  key={a.eventId}
                  titulo={`${a.units} × ${a.name}`}
                  value={pesos(a.value)}
                  reason={a.reason}
                  detalle={[
                    a.orderNumber ? `Pedido ${a.orderNumber}` : null,
                    quien(a.userId),
                    a.authorizedById && a.authorizedById !== a.userId
                      ? `autorizó ${quien(a.authorizedById)}`
                      : null,
                  ]}
                  etiqueta={
                    a.alreadyPrepared ? (
                      <Etiqueta tono="warning" icono="fire">
                        Ya preparado (merma)
                      </Etiqueta>
                    ) : null
                  }
                />
              ))}
              {inf.cancellations.map((c) => (
                <Evento
                  key={c.eventId}
                  titulo={c.orderNumber ? `Pedido ${c.orderNumber} cancelado` : 'Pedido cancelado'}
                  value={pesos(c.value)}
                  reason={c.reason}
                  detalle={[
                    quien(c.userId),
                    c.authorizedById && c.authorizedById !== c.userId
                      ? `autorizó ${quien(c.authorizedById)}`
                      : null,
                  ]}
                  etiqueta={null}
                />
              ))}
            </ul>
          )}
          <Nota>Cada anulación cuenta el día en que se hizo.</Nota>
        </Tarjeta>

        <Tarjeta titulo="Descuentos y cortesías">
          {inf.discounts.length === 0 ? (
            <EmptyState>Sin descuentos en este período.</EmptyState>
          ) : (
            <ul className="flex flex-col divide-y divide-linea">
              {inf.discounts.map((d, i) => (
                <Evento
                  // biome-ignore lint/suspicious/noArrayIndexKey: un pedido puede tener varios descuentos iguales
                  key={`${d.orderId}${i}`}
                  titulo={
                    d.rule === 'comp'
                      ? 'Cortesía'
                      : d.rule === 'percent'
                        ? `Descuento del ${puntosEnPorcentaje(d.value)}`
                        : 'Descuento por valor'
                  }
                  value={pesos(d.amount)}
                  reason={d.reason}
                  detalle={[d.orderNumber ? `Pedido ${d.orderNumber}` : null]}
                  etiqueta={null}
                />
              ))}
            </ul>
          )}
        </Tarjeta>

        <Tarjeta titulo="Fondo de propinas">
          <Filas>
            <Fila name="Propinas cobradas" value={pesos(inf.tipPool.tips)} />
            <Fila name="Pagadas desde la caja" value={minus(inf.tipPool.paidOut)} />
            <Fila name="Saldo del período" value={pesos(inf.tipPool.balance)} main />
          </Filas>
          <Nota>
            Entra la propina de cada pago cobrado en el período y sale lo que se entregó al equipo
            desde la caja.
          </Nota>
        </Tarjeta>
      </div>
    </div>
  )
}

function Productos({ report }: { report: Reporte }) {
  const [all, setTodos] = useState(false)
  const { byProduct } = report.report
  const net = report.report.sales.net
  const visibles = all ? byProduct : byProduct.slice(0, PRODUCTOS_VISIBLES)
  return (
    <Tarjeta titulo="Por producto">
      {byProduct.length === 0 ? (
        <EmptyState>Sin productos vendidos.</EmptyState>
      ) : (
        <>
          <Tabla
            columnas={['Producto', 'Unidades', 'Ventas', '% de ventas']}
            rows={visibles.map((p) => ({
              key: `${p.productId}${p.variantId ?? ''}`,
              celdas: [p.name, String(p.units), pesos(p.net), percent(p.net, net)],
            }))}
          />
          {byProduct.length > PRODUCTOS_VISIBLES && (
            <Boton variant="ghost" className="mt-2 self-start" onClick={() => setTodos(!all)}>
              {all ? 'Ver menos' : `Ver los ${byProduct.length} productos`}
            </Boton>
          )}
        </>
      )}
    </Tarjeta>
  )
}

function Cierre({
  closeout: c,
  varios,
  quien,
  reglas,
  printer,
  puedeElegirImpresora,
}: {
  closeout: CierreReporte
  varios: boolean
  quien: (id: string) => string
  reglas: ReturnType<typeof reglasDe>
  printer: boolean
  puedeElegirImpresora: boolean
}) {
  const avisar = useAvisar()
  const [imprimiendo, setImprimiendo] = useState(false)
  const [fallo, setFallo] = useState<string | null>(null)
  const reimprimir = async () => {
    setImprimiendo(true)
    setFallo(null)
    try {
      await sala.reimprimirCierre(c.shiftId)
      avisar('El cierre de caja salió a la impresora')
    } catch (e) {
      setFallo(message(e))
    } finally {
      setImprimiendo(false)
    }
  }
  const closed = c.closed
  const time = (iso: string) =>
    new Intl.DateTimeFormat('es-CO', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: reglas?.timeZone ?? 'America/Bogota',
    }).format(new Date(iso))
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-linea bg-superficie-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">
          {`${varios ? `${diaCorto(c.businessDay)} · ` : ''}Abrió ${quien(c.abiertoPor)} ${time(c.openedAt)} · Cerró ${quien(c.cerradoPor)} ${time(closed.time)}`}
        </p>
        <span className="flex items-center gap-2">
          <span className="text-sm text-texto-suave">Efectivo</span>
          <Diferencia value={closed.variance} />
        </span>
      </div>
      <dl className="cifras grid grid-cols-3 gap-x-4 gap-y-1">
        <Dato name="Base" value={pesos(c.base)} />
        <Dato name="Efectivo esperado" value={pesos(closed.expected)} />
        <Dato name="Contado" value={pesos(closed.counted)} />
      </dl>
      {closed.otherMethods.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {closed.otherMethods.map((m) => (
            <li key={methodKeyOf(m)} className="cifras flex flex-wrap justify-between gap-x-3">
              <span>{methodName(m.method, m.customMethodId, reglas)}</span>
              <span className="text-texto-suave">
                {`Según el sistema ${pesos(m.expected)} · Según su cierre ${pesos(m.reported)}`}
                {m.variance !== 0 &&
                  ` · ${m.variance > 0 ? 'Sobran' : 'Faltan'} ${pesos(Math.abs(m.variance))}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {closed.justification && (
        <p className="text-sm">
          <span className="font-semibold">Justificación: </span>
          {closed.justification}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {printer ? (
          <Boton icono="printer" onClick={reimprimir} disabled={imprimiendo}>
            {imprimiendo ? 'Imprimiendo…' : 'Reimprimir cierre'}
          </Boton>
        ) : puedeElegirImpresora ? (
          <>
            <Boton icono="printer" onClick={() => navegar('/register/settings')}>
              Elegir impresora
            </Boton>
            <p className="text-sm text-texto-suave">Para imprimir el cierre hace falta una.</p>
          </>
        ) : (
          <p className="text-sm text-texto-suave">
            Para imprimir el cierre, pide al administrador que elija la impresora en «Caja y pagos».
          </p>
        )}
        {fallo && (
          <p role="alert" className="text-sm text-alerta-texto">
            {fallo}
          </p>
        )}
      </div>
    </li>
  )
}

// ── Piezas ─────────────────────────────────────────────────────────────

function Cifra({
  name,
  value,
  detalle,
  destacada = false,
}: {
  name: string
  value: string
  detalle?: string
  destacada?: boolean
}) {
  return (
    <div
      className={`flex flex-col gap-1 rounded-2xl border p-4 ${
        destacada
          ? 'col-span-2 border-accion-fuerte bg-accion-suave md:col-span-1'
          : 'border-linea bg-superficie'
      }`}
    >
      <dt className={`text-sm ${destacada ? 'text-accion-texto' : 'text-texto-suave'}`}>{name}</dt>
      <dd className="cifras text-3xl font-bold tracking-tight">{value}</dd>
      {detalle && <dd className="cifras text-sm text-texto-suave">{detalle}</dd>}
    </div>
  )
}

function Tarjeta({
  titulo,
  ancha = false,
  children,
}: {
  titulo: string
  ancha?: boolean
  children: ReactNode
}) {
  return (
    <section
      aria-label={titulo}
      className={`flex flex-col rounded-2xl border border-linea bg-superficie p-4 ${ancha ? 'lg:col-span-2' : ''}`}
    >
      <h3 className="mb-3 text-lg font-semibold">{titulo}</h3>
      {children}
    </section>
  )
}

const Filas = ({ children }: { children: ReactNode }) => (
  <dl className="cifras grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">{children}</dl>
)

function Fila({
  name,
  value,
  detalle,
  main = false,
}: {
  name: string
  value: string
  detalle?: string
  main?: boolean
}) {
  return (
    <div className="contents">
      <dt className={main ? 'font-semibold' : ''}>{name}</dt>
      <dd className={`text-right ${main ? 'font-semibold' : ''}`}>
        {value}
        {detalle && <span className="block text-sm text-texto-suave">{detalle}</span>}
      </dd>
    </div>
  )
}

const Dato = ({ name, value }: { name: string; value: string }) => (
  <div>
    <dt className="text-sm text-texto-suave">{name}</dt>
    <dd className="font-semibold">{value}</dd>
  </div>
)

function Tabla({
  columnas,
  rows,
}: {
  columnas: string[]
  rows: { key: string; celdas: string[] }[]
}) {
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="cifras w-full border-collapse text-left">
        <thead>
          <tr className="text-sm text-texto-suave">
            {columnas.map((c, i) => (
              <th
                key={c}
                scope="col"
                className={`px-1 pb-1 font-normal ${i > 0 ? 'text-right' : ''}`}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-linea">
          {rows.map((f) => (
            <tr key={f.key}>
              {f.celdas.map((c, i) => (
                <td
                  // biome-ignore lint/suspicious/noArrayIndexKey: las columnas son fijas
                  key={i}
                  className={`px-1 py-1.5 ${i > 0 ? 'text-right whitespace-nowrap' : ''}`}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Evento({
  titulo,
  value,
  reason,
  detalle,
  etiqueta,
}: {
  titulo: string
  value: string
  reason: string | null
  detalle: (string | null)[]
  etiqueta: ReactNode
}) {
  const extra = detalle.filter(Boolean).join(' · ')
  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="font-semibold">{titulo}</span>
        <span className="cifras">{value}</span>
      </div>
      {reason && <p>{reason}</p>}
      {(extra || etiqueta) && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-texto-suave">
          {etiqueta}
          {extra && <span>{extra}</span>}
        </div>
      )}
    </li>
  )
}

const EmptyState = ({ children }: { children: ReactNode }) => (
  <p className="text-texto-suave">{children}</p>
)
const Nota = ({ children }: { children: ReactNode }) => (
  <p className="mt-3 text-sm text-texto-suave">{children}</p>
)
