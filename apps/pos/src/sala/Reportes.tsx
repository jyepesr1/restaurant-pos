import { claveDeMedio } from '@pos/core'
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { Etiqueta } from '../ui/Etiqueta'
import { pesos } from '../ui/formato'
import { Grupo, Opcion } from '../ui/Opciones'
import { navegar } from '../ui/ruta'
import { Diferencia } from './Caja'
import { sala, useSala } from './contexto'
import { nombreDeMedio, nombreImpuesto, reglasDe } from './cuentas'
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
  periodoDe,
  periodoEnPalabras,
  porcentaje,
  puntosEnPorcentaje,
} from './periodos'

// Reportes básicos (tarea 1.9, docs/KPIS.md): ventas, medios de pago, meseros, productos,
// anulaciones y cierres de caja de un día o de un período. Solo para quien tiene «Ver todos los
// reportes». Todo sale del hub, calculado con @pos/core; aquí solo se muestra.

const ATAJOS: { valor: Atajo | 'rango'; nombre: string }[] = [
  { valor: 'hoy', nombre: 'Hoy' },
  { valor: 'ayer', nombre: 'Ayer' },
  { valor: 'semana', nombre: 'Últimos 7 días' },
  { valor: 'mes', nombre: 'Este mes' },
  { valor: 'mesPasado', nombre: 'Mes pasado' },
  { valor: 'rango', nombre: 'Otras fechas' },
]

/** Cuántos productos se ven antes de «Ver todos». */
const PRODUCTOS_VISIBLES = 10

/** Lo que se resta, con su signo («-$30.900»); en cero, «$0». */
const menos = (n: number) => (n === 0 ? pesos(0) : `-${pesos(n)}`)

const mensaje = (e: unknown) => (e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.')

export function Reportes() {
  const avisar = useAvisar()
  const { catalogo, sesion } = useSala()
  const reglas = reglasDe(catalogo)
  const [atajo, setAtajo] = useState<Atajo | 'rango'>('hoy')
  /** El período que se pidió (puede no haber llegado todavía) y el que se está mostrando. */
  const [pedido, setPedido] = useState<Periodo | null>(null)
  const [mostrado, setMostrado] = useState<{ reporte: Reporte; periodo: Periodo } | null>(null)
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
      .reporte(p)
      .then((r) => {
        if (numero !== ultimo.current) return
        setMostrado({ reporte: r, periodo: p ?? { desde: r.hoy, hasta: r.hoy } })
      })
      .catch((e) => {
        if (numero === ultimo.current) setError(mensaje(e))
      })
      .finally(() => {
        if (numero === ultimo.current) setCargando(false)
      })
  }, [])
  useEffect(() => cargar(null), [cargar])

  const hoy = mostrado?.reporte.hoy ?? null
  const elegir = (valor: Atajo | 'rango') => {
    setAtajo(valor)
    if (valor !== 'rango' && hoy) cargar(periodoDe(valor, hoy))
  }

  const descargar = () => {
    if (!mostrado) return
    const { reporte, periodo } = mostrado
    const csv = csvDeReporte(reporte, periodo, reglas, catalogo?.restaurante.nombre ?? '')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const enlace = document.createElement('a')
    enlace.href = url
    enlace.download = nombreCsv(periodo)
    enlace.click()
    URL.revokeObjectURL(url)
    avisar(`Descargaste ${nombreCsv(periodo)}`)
  }

  return (
    <MarcoSala
      titulo="Reportes"
      acciones={
        mostrado && (
          <Boton icono="recibo" onClick={descargar}>
            Descargar CSV
          </Boton>
        )
      }
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 md:p-6">
        <Grupo etiqueta="Período" className="flex flex-wrap gap-2">
          {ATAJOS.map((a) => (
            <Opcion key={a.valor} elegida={atajo === a.valor} alElegir={() => elegir(a.valor)}>
              {a.nombre}
            </Opcion>
          ))}
        </Grupo>
        {atajo === 'rango' && hoy && (
          <Rango hoy={hoy} inicial={mostrado?.periodo ?? null} alVer={(p) => cargar(p)} />
        )}

        {error && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-2xl border border-alerta-fuerte bg-alerta-suave p-4"
          >
            <p className="text-alerta-texto">
              {mostrado
                ? `${error} Abajo sigue lo de ${periodoEnPalabras(mostrado.periodo)}.`
                : error}
            </p>
            <Boton onClick={() => cargar(pedido)}>Intentar de nuevo</Boton>
          </div>
        )}
        {!mostrado && !error && <p className="text-texto-suave">Leyendo las ventas…</p>}
        {mostrado && (
          <Contenido
            reporte={mostrado.reporte}
            periodo={mostrado.periodo}
            cargando={cargando}
            reglas={reglas}
            puedeElegirImpresora={!!sesion?.permisos.includes('administrar_dispositivos')}
          />
        )}
      </div>
    </MarcoSala>
  )
}

/** Desde y hasta: carga sola al cambiar una fecha (las dos deben estar escritas). */
function Rango({
  hoy,
  inicial,
  alVer,
}: {
  hoy: string
  inicial: Periodo | null
  alVer: (p: Periodo) => void
}) {
  const [desde, setDesde] = useState(inicial?.desde ?? hoy)
  const [hasta, setHasta] = useState(inicial?.hasta ?? hoy)
  const ver = (d: string, h: string) => {
    if (d && h) alVer(d <= h ? { desde: d, hasta: h } : { desde: h, hasta: d })
  }
  const al = (e: FormEvent) => {
    e.preventDefault()
    ver(desde, hasta)
  }
  return (
    <form onSubmit={al} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-sm text-texto-suave">Desde</span>
        <input
          type="date"
          className={`${claseCampo} w-auto`}
          value={desde}
          max={hoy}
          required
          onChange={(e) => {
            setDesde(e.target.value)
            ver(e.target.value, hasta)
          }}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm text-texto-suave">Hasta</span>
        <input
          type="date"
          className={`${claseCampo} w-auto`}
          value={hasta}
          max={hoy}
          required
          onChange={(e) => {
            setHasta(e.target.value)
            ver(desde, e.target.value)
          }}
        />
      </label>
      <p className="pb-3 text-sm text-texto-suave">Hasta {MAX_DIAS} días.</p>
    </form>
  )
}

function Contenido({
  reporte,
  periodo,
  cargando,
  reglas,
  puedeElegirImpresora,
}: {
  reporte: Reporte
  periodo: Periodo
  cargando: boolean
  reglas: ReturnType<typeof reglasDe>
  puedeElegirImpresora: boolean
}) {
  const { informe: inf, usuarios } = reporte
  const v = inf.ventas
  const quien = (id: string | null) => (id ? (usuarios[id] ?? 'Alguien') : '')
  const sinVentas = v.neto === 0 && v.cuentas === 0 && inf.porMedio.length === 0
  return (
    <div
      aria-busy={cargando}
      className={`flex flex-col gap-4 transition-opacity ${cargando ? 'opacity-60' : ''}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="font-titulo text-2xl font-bold tracking-tight first-letter:uppercase">
          {periodoEnPalabras(periodo)}
        </h2>
        {cargando && <p className="text-sm text-texto-suave">Actualizando…</p>}
      </div>

      <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <Cifra nombre="Ventas" valor={pesos(v.neto)} destacada />
        <Cifra nombre="Cuentas" valor={String(v.cuentas)} />
        <Cifra nombre="Ticket promedio" valor={pesos(v.ticketPromedio)} />
        <Cifra
          nombre="Comensales"
          valor={String(v.comensales)}
          detalle={v.comensales > 0 ? `${pesos(v.gastoPorComensal)} por persona` : undefined}
        />
        <Cifra nombre="Propinas" valor={pesos(v.propinas)} />
      </dl>

      {sinVentas && (
        <p className="rounded-2xl border border-linea bg-superficie p-4 text-texto-suave">
          No hay ventas cerradas en este período.
        </p>
      )}

      <Tarjeta titulo="Cierres de caja">
        {reporte.cierres.length === 0 ? (
          <Vacio>Ninguna caja se cerró en este período.</Vacio>
        ) : (
          <ul className="flex flex-col gap-3">
            {reporte.cierres.map((c) => (
              <Cierre
                key={c.turnoId}
                cierre={c}
                varios={periodo.desde !== periodo.hasta}
                quien={quien}
                reglas={reglas}
                impresora={reporte.impresora}
                puedeElegirImpresora={puedeElegirImpresora}
              />
            ))}
          </ul>
        )}
      </Tarjeta>

      <div className="grid gap-4 lg:grid-cols-2">
        <Tarjeta titulo="Ventas">
          <Filas>
            <Fila nombre="Bruto" valor={pesos(v.bruto)} />
            {v.anulado > 0 && <Fila nombre="Productos anulados" valor={menos(v.anulado)} />}
            {v.descuentos > 0 && <Fila nombre="Descuentos" valor={menos(v.descuentos)} />}
            <Fila nombre="Ventas" valor={pesos(v.neto)} fuerte />
            {v.ajustes !== 0 && (
              <Fila nombre="Ajuste por redondeo del efectivo" valor={pesos(v.ajustes)} />
            )}
            {v.impuestos.length > 0 && (
              <Fila
                nombre="Base sin impuestos"
                valor={pesos(v.impuestos.reduce((a, i) => a + i.base, 0))}
              />
            )}
            {v.impuestos
              .filter((i) => i.impuesto > 0)
              .map((i) => (
                <Fila
                  key={`${i.tipo}${i.tarifa}`}
                  nombre={nombreImpuesto(i.tipo, i.tarifa)}
                  valor={pesos(i.impuesto)}
                />
              ))}
          </Filas>
          <Nota>Impuestos informativos: valídalos con tu contador.</Nota>
        </Tarjeta>

        <Tarjeta titulo="Por medio de pago">
          {inf.porMedio.length === 0 ? (
            <Vacio>Sin pagos en este período.</Vacio>
          ) : (
            <Filas>
              {inf.porMedio.map((m) => (
                <Fila
                  key={claveDeMedio(m)}
                  nombre={`${nombreDeMedio(m.medio, m.medioPropioId, reglas)}${m.pagos > 0 ? ` · ${m.pagos} ${m.pagos === 1 ? 'pago' : 'pagos'}` : ''}`}
                  valor={pesos(m.venta)}
                  detalle={m.propina !== 0 ? `+ propina ${pesos(m.propina)}` : undefined}
                />
              ))}
            </Filas>
          )}
          <Nota>Cuenta los pagos el día en que se cobraron, aunque la mesa cierre otro día.</Nota>
        </Tarjeta>

        <Tarjeta titulo="Por mesero">
          {inf.porMesero.length === 0 ? (
            <Vacio>Sin ventas en este período.</Vacio>
          ) : (
            <Tabla
              columnas={['Mesero', 'Ventas', 'Cuentas', 'Ticket']}
              filas={inf.porMesero.map((m) => ({
                clave: m.usuarioId,
                celdas: [
                  quien(m.usuarioId),
                  pesos(m.neto),
                  String(m.cuentas),
                  pesos(m.ticketPromedio),
                ],
              }))}
            />
          )}
          <Nota>Las propinas van al fondo común: no se reparten por mesero.</Nota>
        </Tarjeta>

        <Productos reporte={reporte} />

        <Tarjeta titulo="Anulaciones y cancelaciones">
          {inf.anulaciones.length === 0 && inf.cancelaciones.length === 0 ? (
            <Vacio>Nada anulado ni cancelado.</Vacio>
          ) : (
            <ul className="flex flex-col divide-y divide-linea">
              {inf.anulaciones.map((a) => (
                <Evento
                  key={a.eventoId}
                  titulo={`${a.unidades} × ${a.nombre}`}
                  valor={pesos(a.valor)}
                  motivo={a.motivo}
                  detalle={[
                    a.pedidoNumero ? `Pedido ${a.pedidoNumero}` : null,
                    quien(a.usuarioId),
                    a.autorizadoPorId && a.autorizadoPorId !== a.usuarioId
                      ? `autorizó ${quien(a.autorizadoPorId)}`
                      : null,
                  ]}
                  etiqueta={
                    a.yaPreparado ? (
                      <Etiqueta tono="alerta" icono="fuego">
                        Ya preparado (merma)
                      </Etiqueta>
                    ) : null
                  }
                />
              ))}
              {inf.cancelaciones.map((c) => (
                <Evento
                  key={c.eventoId}
                  titulo={
                    c.pedidoNumero ? `Pedido ${c.pedidoNumero} cancelado` : 'Pedido cancelado'
                  }
                  valor={pesos(c.valor)}
                  motivo={c.motivo}
                  detalle={[
                    quien(c.usuarioId),
                    c.autorizadoPorId && c.autorizadoPorId !== c.usuarioId
                      ? `autorizó ${quien(c.autorizadoPorId)}`
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
          {inf.descuentos.length === 0 ? (
            <Vacio>Sin descuentos en este período.</Vacio>
          ) : (
            <ul className="flex flex-col divide-y divide-linea">
              {inf.descuentos.map((d, i) => (
                <Evento
                  // biome-ignore lint/suspicious/noArrayIndexKey: un pedido puede tener varios descuentos iguales
                  key={`${d.pedidoId}${i}`}
                  titulo={
                    d.regla === 'cortesia'
                      ? 'Cortesía'
                      : d.regla === 'porcentaje'
                        ? `Descuento del ${puntosEnPorcentaje(d.valor)}`
                        : 'Descuento por valor'
                  }
                  valor={pesos(d.monto)}
                  motivo={d.motivo}
                  detalle={[d.pedidoNumero ? `Pedido ${d.pedidoNumero}` : null]}
                  etiqueta={null}
                />
              ))}
            </ul>
          )}
        </Tarjeta>

        <Tarjeta titulo="Fondo de propinas">
          <Filas>
            <Fila nombre="Propinas cobradas" valor={pesos(inf.fondoPropinas.propinas)} />
            <Fila nombre="Pagadas desde la caja" valor={menos(inf.fondoPropinas.pagadas)} />
            <Fila nombre="Saldo del período" valor={pesos(inf.fondoPropinas.saldo)} fuerte />
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

function Productos({ reporte }: { reporte: Reporte }) {
  const [todos, setTodos] = useState(false)
  const { porProducto } = reporte.informe
  const neto = reporte.informe.ventas.neto
  const visibles = todos ? porProducto : porProducto.slice(0, PRODUCTOS_VISIBLES)
  return (
    <Tarjeta titulo="Por producto">
      {porProducto.length === 0 ? (
        <Vacio>Sin productos vendidos.</Vacio>
      ) : (
        <>
          <Tabla
            columnas={['Producto', 'Unidades', 'Ventas', '% de ventas']}
            filas={visibles.map((p) => ({
              clave: `${p.productoId}${p.varianteId ?? ''}`,
              celdas: [p.nombre, String(p.unidades), pesos(p.neto), porcentaje(p.neto, neto)],
            }))}
          />
          {porProducto.length > PRODUCTOS_VISIBLES && (
            <Boton variante="fantasma" className="mt-2 self-start" onClick={() => setTodos(!todos)}>
              {todos ? 'Ver menos' : `Ver los ${porProducto.length} productos`}
            </Boton>
          )}
        </>
      )}
    </Tarjeta>
  )
}

function Cierre({
  cierre: c,
  varios,
  quien,
  reglas,
  impresora,
  puedeElegirImpresora,
}: {
  cierre: CierreReporte
  varios: boolean
  quien: (id: string) => string
  reglas: ReturnType<typeof reglasDe>
  impresora: boolean
  puedeElegirImpresora: boolean
}) {
  const avisar = useAvisar()
  const [imprimiendo, setImprimiendo] = useState(false)
  const [fallo, setFallo] = useState<string | null>(null)
  const reimprimir = async () => {
    setImprimiendo(true)
    setFallo(null)
    try {
      await sala.reimprimirCierre(c.turnoId)
      avisar('El cierre de caja salió a la impresora')
    } catch (e) {
      setFallo(mensaje(e))
    } finally {
      setImprimiendo(false)
    }
  }
  const cerrado = c.cerrado
  const hora = (iso: string) =>
    new Intl.DateTimeFormat('es-CO', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: reglas?.zonaHoraria ?? 'America/Bogota',
    }).format(new Date(iso))
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-linea bg-superficie-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">
          {`${varios ? `${diaCorto(c.diaOperativo)} · ` : ''}Abrió ${quien(c.abiertoPor)} ${hora(c.abiertoEn)} · Cerró ${quien(c.cerradoPor)} ${hora(cerrado.hora)}`}
        </p>
        <span className="flex items-center gap-2">
          <span className="text-sm text-texto-suave">Efectivo</span>
          <Diferencia valor={cerrado.diferencia} />
        </span>
      </div>
      <dl className="cifras grid grid-cols-3 gap-x-4 gap-y-1">
        <Dato nombre="Base" valor={pesos(c.base)} />
        <Dato nombre="Efectivo esperado" valor={pesos(cerrado.esperado)} />
        <Dato nombre="Contado" valor={pesos(cerrado.contado)} />
      </dl>
      {cerrado.otrosMedios.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {cerrado.otrosMedios.map((m) => (
            <li key={claveDeMedio(m)} className="cifras flex flex-wrap justify-between gap-x-3">
              <span>{nombreDeMedio(m.medio, m.medioPropioId, reglas)}</span>
              <span className="text-texto-suave">
                {`Según el sistema ${pesos(m.esperado)} · Según su cierre ${pesos(m.reportado)}`}
                {m.diferencia !== 0 &&
                  ` · ${m.diferencia > 0 ? 'Sobran' : 'Faltan'} ${pesos(Math.abs(m.diferencia))}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {cerrado.justificacion && (
        <p className="text-sm">
          <span className="font-semibold">Justificación: </span>
          {cerrado.justificacion}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {impresora ? (
          <Boton icono="impresora" onClick={reimprimir} disabled={imprimiendo}>
            {imprimiendo ? 'Imprimiendo…' : 'Reimprimir cierre'}
          </Boton>
        ) : puedeElegirImpresora ? (
          <>
            <Boton icono="impresora" onClick={() => navegar('/caja/ajustes')}>
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
  nombre,
  valor,
  detalle,
  destacada = false,
}: {
  nombre: string
  valor: string
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
      <dt className={`text-sm ${destacada ? 'text-accion-texto' : 'text-texto-suave'}`}>
        {nombre}
      </dt>
      <dd className="cifras text-3xl font-bold tracking-tight">{valor}</dd>
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
  nombre,
  valor,
  detalle,
  fuerte = false,
}: {
  nombre: string
  valor: string
  detalle?: string
  fuerte?: boolean
}) {
  return (
    <div className="contents">
      <dt className={fuerte ? 'font-semibold' : ''}>{nombre}</dt>
      <dd className={`text-right ${fuerte ? 'font-semibold' : ''}`}>
        {valor}
        {detalle && <span className="block text-sm text-texto-suave">{detalle}</span>}
      </dd>
    </div>
  )
}

const Dato = ({ nombre, valor }: { nombre: string; valor: string }) => (
  <div>
    <dt className="text-sm text-texto-suave">{nombre}</dt>
    <dd className="font-semibold">{valor}</dd>
  </div>
)

function Tabla({
  columnas,
  filas,
}: {
  columnas: string[]
  filas: { clave: string; celdas: string[] }[]
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
          {filas.map((f) => (
            <tr key={f.clave}>
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
  valor,
  motivo,
  detalle,
  etiqueta,
}: {
  titulo: string
  valor: string
  motivo: string | null
  detalle: (string | null)[]
  etiqueta: ReactNode
}) {
  const extra = detalle.filter(Boolean).join(' · ')
  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="font-semibold">{titulo}</span>
        <span className="cifras">{valor}</span>
      </div>
      {motivo && <p>{motivo}</p>}
      {(extra || etiqueta) && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-texto-suave">
          {etiqueta}
          {extra && <span>{extra}</span>}
        </div>
      )}
    </li>
  )
}

const Vacio = ({ children }: { children: ReactNode }) => (
  <p className="text-texto-suave">{children}</p>
)
const Nota = ({ children }: { children: ReactNode }) => (
  <p className="mt-3 text-sm text-texto-suave">{children}</p>
)
