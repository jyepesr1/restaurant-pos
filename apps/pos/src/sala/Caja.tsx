import {
  type CuadreMedio,
  type CuadreTurno,
  claveDeMedio,
  cuadreDeOtrosMedios,
  DENOMINACIONES,
  diaOperativo,
  type MedioPago,
  nuevoId,
  totalesPedido,
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
import { nombreDeMedio, type ReglasCobro, reglasDe } from './cuentas'
import { claseCampo } from './Entrar'
import { MarcoSala } from './MarcoSala'

// La caja de este equipo (tareas 1.6 y 1.7): abrirla con la base, ver lo cobrado en el turno,
// registrar entradas, salidas y el pago de propinas, y cerrarla con un arqueo ciego: primero se
// cuentan billetes y monedas (el conteo queda guardado), después se ve lo esperado y la diferencia,
// y desde el umbral del restaurante hay que justificarla. Todo pide conexión con el hub.

type Movimiento = 'entrada' | 'salida' | 'pago_propinas'

const NOMBRE_MOVIMIENTO: Record<Movimiento, string> = {
  entrada: 'Entrada',
  salida: 'Salida',
  pago_propinas: 'Pago de propinas',
}

const MOTIVOS: Record<Exclude<Movimiento, 'pago_propinas'>, string[]> = {
  entrada: ['Cambio para la caja'],
  salida: ['Compra', 'Pago a proveedor'],
}

/** Lo que admite el esquema por denominación. */
const CANTIDAD_MAXIMA = 100_000

const SIN_RED =
  'Sin conexión con el hub del local: no se pueden registrar movimientos ni cerrar la caja hasta que vuelva. Revisa el cable o el Wi-Fi.'

const mensaje = (e: unknown) => (e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.')

/** «las 6:30 p. m.» hoy; «ayer a las…» o la fecha si es de antes. */
function cuando(iso: string): string {
  const fecha = new Date(iso)
  const hora = new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit' }).format(
    fecha,
  )
  const hoy = new Date()
  const dias = Math.round(
    (new Date(hoy.toDateString()).getTime() - new Date(fecha.toDateString()).getTime()) /
      86_400_000,
  )
  if (dias === 0) return `las ${hora}`
  if (dias === 1) return `ayer a las ${hora}`
  return `el ${new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long' }).format(fecha)} a las ${hora}`
}

/** El día operativo de un instante, con la zona y el inicio del día del restaurante. */
const diaDe = (iso: string, reglas: ReglasCobro | null) =>
  diaOperativo(iso, reglas?.zonaHoraria ?? 'America/Bogota', reglas?.inicioDiaOperativo ?? '06:00')

/** Un valor que puede ser negativo (un medio con solo devoluciones): «-5.000» → -5000. */
export const conSigno = (texto: string) =>
  (texto.trim().startsWith('-') ? -1 : 1) * soloDigitos(texto) || 0

/** «Mesa 4», «Mesa 5 + 6», «Para llevar». */
function nombreDePedido(catalogo: Catalogo | null, mesaId: string | null, unidas: string[]) {
  if (!mesaId) return 'Sin mesa'
  const nombres = [mesaId, ...unidas].map(
    (id) => catalogo?.mesas.find((m) => m.id === id)?.nombre ?? '?',
  )
  return `Mesa ${nombres.join(' + ')}`
}

/** Un medio que no es efectivo y se cuadra en el cierre con lo que dice su propio cierre. */
export interface MedioDelCierre {
  clave: string
  medio: Exclude<MedioPago, 'efectivo'>
  medioPropioId: string | null
  /** «Cierre de Bold», «Llegó por Nequi». */
  etiqueta: string
  /** Su nombre en el resultado. */
  nombre: string
}

const PROVEEDOR: Record<string, string> = {
  bold: 'Bold',
  redeban: 'Redeban',
  credibanco: 'Credibanco',
}

const claveMedio = claveDeMedio

/**
 * Los medios a cuadrar al cerrar (tarea 1.8): los que recibe el restaurante y los que tuvieron
 * pagos en el turno (aunque ya estén apagados). La tarjeta va en una sola línea: los datáfonos de
 * un mismo proveedor entregan un solo cierre.
 */
export function mediosDelCierre(
  reglas: ReglasCobro | null,
  cuadre: CuadreTurno,
  catalogo: Catalogo | null,
): MedioDelCierre[] {
  const proveedores = [...new Set((catalogo?.datafonos ?? []).map((d) => d.proveedor ?? 'otro'))]
  const tarjeta =
    proveedores.length === 1 && proveedores[0] && PROVEEDOR[proveedores[0]]
      ? `Cierre de ${PROVEEDOR[proveedores[0]]} (total con propinas)`
      : 'Cierre de los datáfonos (la suma, con propinas)'
  const lista: MedioDelCierre[] = []
  const agregar = (medio: MedioPago, medioPropioId: string | null) => {
    // Un medio propio sin decir cuál (un reembolso sin su pago aquí) no tiene cierre que pedir.
    if (medio === 'efectivo' || (medio === 'otro' && !medioPropioId)) return
    const clave = claveMedio({ medio, medioPropioId })
    if (lista.some((m) => m.clave === clave)) return
    const nombre = nombreDeMedio(medio, medioPropioId, reglas)
    lista.push({
      clave,
      medio,
      medioPropioId,
      nombre,
      etiqueta: medio === 'tarjeta' ? tarjeta : `Llegó por ${nombre}`,
    })
  }
  for (const m of reglas?.mediosPago ?? []) agregar(m, null)
  for (const m of reglas?.mediosPropios ?? []) agregar('otro', m.id)
  for (const m of cuadre.porMedio) agregar(m.medio, m.medioPropioId)
  return lista
}

export function Caja() {
  const { equipo, conexion, sesion, catalogo } = useSala()
  const vista = useVistaLocal()
  const avisar = useAvisar()
  const [base, setBase] = useState(0)
  const [ocupado, setOcupado] = useState(false)
  const [moviendo, setMoviendo] = useState<Movimiento | null>(null)
  const [cerrando, setCerrando] = useState(false)
  // El conteo vive aquí: salir del cierre y volver no lo borra.
  const [cantidades, setCantidades] = useState<Record<string, number>>({})
  // Lo que dicen los cierres de los demás medios (Bold, Nequi…), con el conteo.
  const [reportes, setReportes] = useState<Record<string, string>>({})
  // El último cierre de este equipo, para mostrar cómo quedó.
  const [cerrado, setCerrado] = useState<CuadreTurno | null>(null)

  if (!vista) return null
  const reglas = reglasDe(catalogo)
  const esCaja = equipo?.tipo === 'caja'
  const permisos = sesion?.permisos ?? []
  const puedeAbrir = permisos.includes('abrir_turno_caja')
  const puedeMover = permisos.includes('movimiento_caja')
  const puedeCerrar = permisos.includes('cerrar_turno_caja')
  const enLinea = conexion === 'conectado'
  const turno = vista.turno
  const cuadre = vista.cuadre
  // Un turno de un día operativo anterior: hay que cerrarlo para cuadrar ese día.
  const deOtroDia =
    turno !== null && diaDe(turno.abiertoEn, reglas) !== diaDe(new Date().toISOString(), reglas)

  const hacer = async (trabajo: () => Promise<void>) => {
    if (ocupado) return
    setOcupado(true)
    try {
      await trabajo()
    } catch (e) {
      avisar(mensaje(e))
    } finally {
      setOcupado(false)
    }
  }

  const abrir = () =>
    hacer(async () => {
      await sala.abrirTurno(base)
      setCerrado(null)
      avisar(`Caja abierta con ${pesos(base)} de base`)
      // Si venía de cobrar una cuenta, vuelve a ella.
      const volver = new URLSearchParams(location.search).get('volver')
      if (volver?.startsWith('/cuenta?')) navegar(volver)
    })

  const sinRed = !enLinea && (
    <p className="rounded-xl bg-alerta-suave p-3 text-alerta-texto">{SIN_RED}</p>
  )

  return (
    <MarcoSala titulo="Caja">
      <div className="mx-auto flex max-w-xl flex-col gap-4 p-3 md:p-5">
        {!esCaja ? (
          <p className="rounded-2xl bg-proceso-suave p-4 text-proceso-texto">
            Este equipo no es de caja. Para cobrar, entra con el usuario y la contraseña de caja en
            el computador de la caja.
          </p>
        ) : turno && cuadre && cerrando ? (
          <Cierre
            cuadre={cuadre}
            reglas={reglas}
            cantidades={cantidades}
            alCambiarCantidades={setCantidades}
            medios={mediosDelCierre(reglas, cuadre, catalogo)}
            reportes={reportes}
            alCambiarReportes={setReportes}
            mesasAbiertas={vista.pedidos
              .map((p) => ({
                id: p.estado.id,
                nombre: nombreDePedido(catalogo, p.estado.mesaId, p.estado.mesasUnidas),
                saldo: totalesPedido(p.estado).saldo,
              }))
              .filter((m) => m.saldo > 0)}
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
        ) : turno && cuadre ? (
          <>
            <section className="rounded-2xl border border-linea bg-superficie p-4 shadow-flota">
              <p className="text-lg font-semibold">
                {`Caja abierta desde ${cuando(turno.abiertoEn)}`}
                {turno.porConfirmar && (
                  <span className="ml-2 text-sm font-normal text-texto-suave">(sin confirmar)</span>
                )}
              </p>
              <p className="cifras text-texto-suave">{`Base: ${pesos(turno.base)}`}</p>
            </section>
            {deOtroDia && (
              <p className="rounded-xl bg-alerta-suave p-3 text-alerta-texto">
                Esta caja sigue abierta de un día anterior. Ciérrala para cuadrar ese día y ábrela
                de nuevo con la base de hoy.
              </p>
            )}
            <Cobrado
              cuadre={cuadre}
              reglas={reglas}
              conMontos={permisos.includes('ver_reportes')}
            />
            <Movimientos cuadre={cuadre} />
            {sinRed}
            {puedeMover && (
              <div className="grid grid-cols-3 gap-2">
                {(['entrada', 'salida', 'pago_propinas'] as const).map((t) => (
                  <Boton key={t} disabled={!enLinea || ocupado} onClick={() => setMoviendo(t)}>
                    {NOMBRE_MOVIMIENTO[t]}
                  </Boton>
                ))}
              </div>
            )}
            {puedeCerrar && (
              <Boton
                variante="principal"
                grande
                icono="check"
                disabled={!enLinea || turno.porConfirmar}
                onClick={() => setCerrando(true)}
              >
                Cerrar la caja
              </Boton>
            )}
            <PanelMovimiento
              key={moviendo ?? 'cerrado'}
              tipo={moviendo}
              cuadre={cuadre}
              ocupado={ocupado}
              alCerrar={() => setMoviendo(null)}
              alGuardar={(datos) =>
                hacer(async () => {
                  await sala.registrarConfirmado('MovimientoCajaRegistrado', turno.id, {
                    ...datos,
                    dias:
                      datos.tipo === 'pago_propinas'
                        ? [diaDe(new Date().toISOString(), reglas)]
                        : [],
                  })
                  setMoviendo(null)
                  avisar(`${NOMBRE_MOVIMIENTO[datos.tipo]} de ${pesos(datos.monto)} registrada`)
                })
              }
            />
          </>
        ) : (
          <>
            {cerrado && <Resultado cuadre={cerrado} reglas={reglas} />}
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
                  variante="principal"
                  grande
                  icono="billete"
                  disabled={ocupado || !enLinea}
                  onClick={abrir}
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
  cuadre,
  reglas,
  conMontos,
}: {
  cuadre: CuadreTurno
  reglas: ReglasCobro | null
  conMontos: boolean
}) {
  const venta = cuadre.porMedio.reduce((a, m) => a + m.venta, 0)
  const propinas = cuadre.porMedio.reduce((a, m) => a + m.propina, 0)
  if (!conMontos)
    return (
      <section
        className="rounded-2xl border border-linea bg-superficie p-4"
        aria-label="Cobrado en este turno"
      >
        <h2 className="mb-2 font-semibold">Cobrado en este turno</h2>
        {cuadre.porMedio.length === 0 ? (
          <p className="text-texto-suave">Todavía no hay pagos.</p>
        ) : (
          <>
            <ul className="flex flex-col gap-1">
              {cuadre.porMedio.map((m) => (
                <li key={claveDeMedio(m)}>
                  {`${nombreDeMedio(m.medio, m.medioPropioId, reglas)}${cuantos(m.pagos)}`}
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
      {cuadre.porMedio.length === 0 ? (
        <p className="text-texto-suave">Todavía no hay pagos.</p>
      ) : (
        <dl className="cifras grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
          <dt className="font-semibold">Total</dt>
          <dd className="text-right font-semibold">
            {pesos(venta)}
            <span className="block text-sm font-normal text-texto-suave">{`+ propinas ${pesos(propinas)}`}</span>
          </dd>
          {cuadre.porMedio.map((m) => (
            <div key={`${m.medio}${m.medioPropioId ?? ''}`} className="contents">
              <dt>{`${nombreDeMedio(m.medio, m.medioPropioId, reglas)}${cuantos(m.pagos)}`}</dt>
              <dd className="text-right">
                {pesos(m.venta)}
                {m.propina !== 0 && (
                  <span className="block text-sm text-texto-suave">{`+ propina ${pesos(m.propina)}`}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

function Movimientos({ cuadre }: { cuadre: CuadreTurno }) {
  if (cuadre.movimientos.length === 0) return null
  return (
    <section
      className="rounded-2xl border border-linea bg-superficie p-4"
      aria-label="Movimientos de efectivo"
    >
      <h2 className="mb-2 font-semibold">Movimientos de efectivo</h2>
      <ul className="cifras flex flex-col gap-1">
        {cuadre.movimientos.map((m) => (
          <li key={m.id} className="flex justify-between gap-2">
            <span>
              {NOMBRE_MOVIMIENTO[m.tipo]}
              <span className="text-texto-suave">{` · ${m.aQuien ?? m.descripcion}`}</span>
            </span>
            <span>{`${m.tipo === 'entrada' ? '+' : '-'}${pesos(m.monto)}`}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

interface DatosMovimiento {
  movimiento_id: string
  tipo: Movimiento
  monto: number
  descripcion: string
  a_quien: string | null
}

/** Registrar una entrada, una salida o un pago de propinas, con su motivo y confirmando. */
function PanelMovimiento({
  tipo,
  cuadre,
  ocupado,
  alCerrar,
  alGuardar,
}: {
  tipo: Movimiento | null
  cuadre: CuadreTurno
  ocupado: boolean
  alCerrar: () => void
  alGuardar: (datos: DatosMovimiento) => void
}) {
  // El mismo id en cada intento: reintentar no registra el movimiento dos veces.
  const [movimientoId] = useState(nuevoId)
  const [monto, setMonto] = useState(0)
  const [motivo, setMotivo] = useState<string | null>(null)
  const [otro, setOtro] = useState('')
  const [aQuien, setAQuien] = useState('')
  const [confirmando, setConfirmando] = useState(false)
  const propinas = cuadre.porMedio.reduce((a, m) => a + m.propina, 0)
  const sale = tipo === 'salida' || tipo === 'pago_propinas'
  const descripcion =
    tipo === 'pago_propinas' ? 'Pago de propinas' : motivo === 'otro' ? otro.trim() : (motivo ?? '')
  const listo =
    tipo !== null &&
    monto > 0 &&
    (tipo === 'pago_propinas' ? aQuien.trim().length > 0 : descripcion.length > 0)
  const guardar = () =>
    tipo &&
    alGuardar({
      movimiento_id: movimientoId,
      tipo,
      monto,
      descripcion,
      a_quien: tipo === 'pago_propinas' ? aQuien.trim() : null,
    })
  return (
    <PanelLateral
      abierto={tipo !== null}
      titulo={tipo ? NOMBRE_MOVIMIENTO[tipo] : 'Movimiento'}
      alCerrar={alCerrar}
      pie={
        confirmando ? (
          <div
            className="flex flex-col gap-2"
            role="alertdialog"
            aria-labelledby="confirmar-movimiento"
          >
            <p id="confirmar-movimiento" className="text-lg font-semibold">
              {`¿${sale ? 'Sacar' : 'Meter'} ${pesos(monto)} del cajón?`}
            </p>
            <div className="grid grid-cols-[2fr_3fr] gap-2">
              <Boton onClick={() => setConfirmando(false)}>Volver</Boton>
              <Boton variante="principal" disabled={ocupado} onClick={guardar}>
                {ocupado ? 'Registrando…' : `Sí, registrar ${pesos(monto)}`}
              </Boton>
            </div>
          </div>
        ) : (
          <Boton
            variante="principal"
            grande
            className="w-full"
            disabled={!listo}
            onClick={() => setConfirmando(true)}
          >
            {`Registrar ${pesos(monto)}`}
          </Boton>
        )
      }
    >
      <div className="flex flex-col gap-4">
        <label>
          <span className="font-semibold">
            {sale ? '¿Cuánto sale del cajón?' : '¿Cuánto entra al cajón?'}
          </span>
          <input
            inputMode="numeric"
            className={`${claseCampo} cifras mt-1 min-h-14 text-2xl`}
            value={conPuntos(monto)}
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
        {sale && monto > cuadre.efectivo.esperado && (
          <p className="rounded-xl bg-alerta-suave p-3 text-alerta-texto">
            Es más de lo que debería haber en el cajón. Revisa el valor.
          </p>
        )}
        {tipo === 'pago_propinas' ? (
          <>
            <p className="text-sm text-texto-suave">{`Propinas de este turno: ${pesos(propinas)} (de todos los medios).`}</p>
            <label>
              <span className="font-semibold">¿A quién se entregaron?</span>
              <input
                className={`${claseCampo} mt-1`}
                maxLength={100}
                value={aQuien}
                placeholder="Nombre, o elige «Todo el equipo»"
                onChange={(e) => setAQuien(e.target.value)}
              />
            </label>
            <Opcion
              elegida={aQuien === 'Todo el equipo'}
              alElegir={() => setAQuien('Todo el equipo')}
            >
              Todo el equipo
            </Opcion>
          </>
        ) : (
          tipo && (
            <div className="flex flex-col gap-2">
              <span className="font-semibold">Motivo</span>
              <Grupo etiqueta="Motivo" className="flex flex-wrap gap-2">
                {MOTIVOS[tipo].map((m) => (
                  <Opcion key={m} elegida={motivo === m} alElegir={() => setMotivo(m)}>
                    {m}
                  </Opcion>
                ))}
                <Opcion elegida={motivo === 'otro'} alElegir={() => setMotivo('otro')}>
                  Otro
                </Opcion>
              </Grupo>
              {motivo === 'otro' && (
                <input
                  className={claseCampo}
                  maxLength={200}
                  value={otro}
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
  cuadre,
  reglas,
  cantidades,
  alCambiarCantidades,
  medios,
  reportes,
  alCambiarReportes,
  mesasAbiertas,
  sinRed,
  enLinea,
  alVolver,
  alCerrar,
}: {
  cuadre: CuadreTurno
  reglas: ReglasCobro | null
  cantidades: Record<string, number>
  alCambiarCantidades: (c: Record<string, number>) => void
  medios: MedioDelCierre[]
  /** Lo escrito en cada medio (texto, para poder empezar con «-»). */
  reportes: Record<string, string>
  alCambiarReportes: (r: Record<string, string>) => void
  mesasAbiertas: { id: string; nombre: string; saldo: number }[]
  sinRed: React.ReactNode
  enLinea: boolean
  alVolver: () => void
  alCerrar: (cuadre: CuadreTurno) => void
}) {
  const avisar = useAvisar()
  const [arqueoId, setArqueoId] = useState<string | null>(null)
  // El cuadre de los demás medios con lo reportado en el conteo guardado.
  const [otros, setOtros] = useState<CuadreMedio[]>([])
  const [justificacion, setJustificacion] = useState('')
  const [ocupado, setOcupado] = useState(false)
  const [confirmando, setConfirmando] = useState(false)
  // Lo esperado queda fijo al guardar el conteo: si después entra un pago, hay que recontar.
  const [esperadoAlContar, setEsperadoAlContar] = useState<number | null>(null)
  const campos = useRef<(HTMLInputElement | null)[]>([])
  const guardar = useRef<HTMLButtonElement>(null)
  const textoJustificacion = useRef<HTMLTextAreaElement>(null)
  const botonCerrar = useRef<HTMLButtonElement>(null)
  const clave = (d: (typeof DENOMINACIONES)[number]) => `${d.tipo}${d.valor}`
  const cantidadDe = (d: (typeof DENOMINACIONES)[number]) => cantidades[clave(d)] ?? 0
  const contado = DENOMINACIONES.reduce((a, d) => a + d.valor * cantidadDe(d), 0)
  const esperado = esperadoAlContar ?? cuadre.efectivo.esperado
  const cambioDespues = esperadoAlContar !== null && esperadoAlContar !== cuadre.efectivo.esperado
  const diferencia = contado - esperado
  // Los medios con cobros en el turno deben tener su cierre escrito (un vacío no es un 0).
  const conCobros = new Set(cuadre.porMedio.map(claveDeMedio))
  const sinEscribir = medios.filter(
    (m) => conCobros.has(m.clave) && !(reportes[m.clave] ?? '').trim(),
  )
  const umbral = reglas?.umbralDiferencia ?? 1000
  const grande = (d: number) => d !== 0 && Math.abs(d) >= Math.max(1, umbral)
  const pideJustificar = grande(diferencia) || otros.some((o) => grande(o.diferencia))
  const hayDiferencia = diferencia !== 0 || otros.some((o) => o.diferencia !== 0)
  // Las líneas que pasan el umbral, para decir qué hay que explicar.
  const nombreOtro = (o: CuadreMedio) =>
    medios.find((m) => m.clave === claveDeMedio(o))?.nombre ??
    nombreDeMedio(o.medio, o.medioPropioId, reglas)
  const porExplicar = [
    ...(grande(diferencia) ? ['efectivo'] : []),
    ...otros.filter((o) => grande(o.diferencia)).map(nombreOtro),
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
      avisar(mensaje(e))
    } finally {
      setOcupado(false)
    }
  }

  const guardarConteo = () =>
    hacer(async () => {
      const id = nuevoId()
      // Billete y moneda del mismo valor (los $1.000) van juntos en el conteo.
      const porValor = new Map<number, number>()
      for (const d of DENOMINACIONES)
        if (cantidadDe(d) > 0) porValor.set(d.valor, (porValor.get(d.valor) ?? 0) + cantidadDe(d))
      const reportados = medios.map((m) => ({
        medio: m.medio,
        medio_propio_id: m.medioPropioId,
        reportado: conSigno(reportes[m.clave] ?? ''),
      }))
      await sala.registrarConfirmado('ArqueoRegistrado', cuadre.turnoId, {
        arqueo_id: id,
        conteo: [...porValor].map(([valor, cantidad]) => ({ valor, cantidad })),
        contado_efectivo: contado,
        otros: reportados,
      })
      setOtros(
        cuadreDeOtrosMedios(cuadre, {
          id,
          conteo: [],
          contado,
          otros: reportados.map((r) => ({
            medio: r.medio,
            medioPropioId: r.medio_propio_id,
            reportado: r.reportado,
          })),
          hora: '',
        }),
      )
      setEsperadoAlContar(cuadre.efectivo.esperado)
      setConfirmando(false)
      setArqueoId(id)
    })

  const cerrar = () =>
    hacer(async () => {
      if (!arqueoId) return
      const final = justificacion.trim() || null
      await sala.registrarConfirmado('TurnoCerrado', cuadre.turnoId, {
        arqueo_id: arqueoId,
        esperado_efectivo: esperado,
        contado_efectivo: contado,
        diferencia,
        justificacion: final,
        otros_medios: otros.map((o) => ({
          medio: o.medio,
          medio_propio_id: o.medioPropioId,
          esperado: o.esperado,
          reportado: o.reportado,
          diferencia: o.diferencia,
        })),
      })
      avisar('Caja cerrada')
      alCerrar({
        ...cuadre,
        cerrado: {
          esperado,
          contado,
          diferencia,
          justificacion: final,
          otrosMedios: otros,
          hora: new Date().toISOString(),
        },
      })
    })

  const porCobrar = mesasAbiertas.reduce((a, m) => a + m.saldo, 0)
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl font-bold tracking-tight">Cerrar la caja</h2>
        <Boton variante="fantasma" onClick={alVolver}>
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
              <li key={m.id}>{`${m.nombre} · ${pesos(m.saldo)}`}</li>
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
            {DENOMINACIONES.map((d, i) => {
              const n = cantidadDe(d)
              const nombre = `${d.tipo === 'billete' ? 'billetes' : 'monedas'} de ${pesos(d.valor)}`
              const poner = (v: number) =>
                alCambiarCantidades({
                  ...cantidades,
                  [clave(d)]: Math.min(CANTIDAD_MAXIMA, Math.max(0, v)),
                })
              return (
                <li key={clave(d)} className="flex items-center gap-2">
                  <span className="cifras w-24 shrink-0 font-semibold">
                    {pesos(d.valor)}
                    <span className="block text-sm font-normal text-texto-suave">{d.tipo}</span>
                  </span>
                  {/* − y + son para el dedo: con el teclado se escribe el número (no reciben foco). */}
                  <Boton
                    icono="menos"
                    tabIndex={-1}
                    aria-label={`Quitar uno: ${nombre}`}
                    disabled={n === 0}
                    onClick={() => poner(n - 1)}
                  />
                  <input
                    ref={(el) => {
                      campos.current[i] = el
                    }}
                    inputMode="numeric"
                    aria-label={`Cantidad de ${nombre}`}
                    className={`${claseCampo} cifras w-16 text-center`}
                    value={n ? String(n) : ''}
                    placeholder="0"
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => poner(soloDigitos(e.target.value))}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return
                      e.preventDefault()
                      const siguiente = campos.current[i + 1]
                      if (siguiente) siguiente.focus()
                      else guardar.current?.focus()
                    }}
                  />
                  <Boton
                    icono="mas"
                    tabIndex={-1}
                    aria-label={`Agregar uno: ${nombre}`}
                    onClick={() => poner(n + 1)}
                  />
                  <span className="cifras ml-auto text-right text-texto-suave">
                    {pesos(d.valor * n)}
                  </span>
                </li>
              )
            })}
          </ul>
          <p className="cifras flex items-baseline justify-between border-t border-linea pt-3">
            <span className="font-semibold">Contado</span>
            <span className="font-titulo text-3xl font-bold">{pesos(contado)}</span>
          </p>
          {medios.length > 0 && (
            <div className="flex flex-col gap-2 border-t border-linea pt-3">
              <h3 className="font-semibold">Los demás medios</h3>
              <p className="text-sm text-texto-suave">
                {`Escribe el total del cierre del datáfono (en su app o en el papel del cierre) y lo que llegó a cada app, desde las ${inicioDia} de hoy. Si solo hubo devoluciones, empieza con «-».`}
              </p>
              {medios.map((m, j) => (
                <label key={m.clave} className="flex items-center gap-2">
                  <span className="flex-1">{m.etiqueta}</span>
                  <input
                    ref={(el) => {
                      campos.current[DENOMINACIONES.length + j] = el
                    }}
                    inputMode="numeric"
                    className={`${claseCampo} cifras w-40 text-right`}
                    value={reportes[m.clave] ?? ''}
                    placeholder={conCobros.has(m.clave) ? 'Escríbelo' : '0'}
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) =>
                      alCambiarReportes({
                        ...reportes,
                        [m.clave]: e.target.value.replace(/[^\d.-]/g, '').slice(0, 13),
                      })
                    }
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return
                      e.preventDefault()
                      const siguiente = campos.current[DENOMINACIONES.length + j + 1]
                      if (siguiente) siguiente.focus()
                      else guardar.current?.focus()
                    }}
                  />
                </label>
              ))}
            </div>
          )}
          {sinEscribir.length > 0 && (
            <p className="text-sm text-texto-suave">
              {`Falta escribir: ${sinEscribir.map((m) => m.nombre).join(', ')}.`}
            </p>
          )}
          {sinRed}
          <Boton
            ref={guardar}
            variante="principal"
            grande
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
          <Resultado
            cuadre={{
              ...cuadre,
              cerrado: {
                esperado,
                contado,
                diferencia,
                justificacion: null,
                otrosMedios: otros,
                hora: '',
              },
            }}
            reglas={reglas}
            titulo="Así queda la caja"
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
                value={justificacion}
                onChange={(e) => setJustificacion(e.target.value)}
              />
            </label>
          )}
          {sinRed}
          {pideJustificar && !justificacion.trim() && (
            <p className="text-sm text-texto-suave">Para cerrar, falta explicar la diferencia.</p>
          )}
          {confirmando ? (
            <div
              className="rounded-2xl border-2 border-accion-fuerte bg-accion-suave p-3 text-accion-texto"
              role="alertdialog"
              aria-labelledby="confirmar-cierre"
            >
              <p id="confirmar-cierre" className="mb-3 text-lg font-semibold">
                ¿Cerrar la caja? Después de cerrar ya no se cobra en este turno.
              </p>
              <div className="grid grid-cols-[2fr_3fr] gap-2">
                <Boton onClick={() => setConfirmando(false)}>Volver</Boton>
                <Boton variante="principal" disabled={ocupado} onClick={cerrar}>
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
                variante="principal"
                grande
                disabled={
                  ocupado || !enLinea || cambioDespues || (pideJustificar && !justificacion.trim())
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
function Resultado({
  cuadre,
  reglas,
  titulo = 'Cómo quedó la caja',
}: {
  cuadre: CuadreTurno
  reglas: ReglasCobro | null
  titulo?: string
}) {
  const c = cuadre.cerrado
  if (!c) return null
  const digitales = cuadre.porMedio.filter((m) => m.medio !== 'efectivo')
  const fila = (nombre: string, valor: number, signo = '') =>
    valor > 0 && (
      <>
        <dt>{nombre}</dt>
        <dd className="text-right">{`${signo}${pesos(valor)}`}</dd>
      </>
    )
  return (
    <section
      className="flex flex-col gap-3 rounded-2xl border border-linea bg-superficie p-4 shadow-flota"
      aria-label="Cuadre de la caja"
    >
      <h2 className="text-lg font-semibold">
        {titulo}
        {c.hora && (
          <span className="ml-2 text-sm font-normal text-texto-suave">{`· cerrada a ${cuando(c.hora)}`}</span>
        )}
      </h2>
      <dl className="cifras grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
        <dt>Base</dt>
        <dd className="text-right">{pesos(cuadre.base)}</dd>
        {fila('Efectivo cobrado (con propinas)', cuadre.efectivo.cobrado, '+')}
        {fila('Devoluciones', cuadre.efectivo.devoluciones, '-')}
        {fila('Entradas', cuadre.efectivo.entradas, '+')}
        {fila('Salidas', cuadre.efectivo.salidas, '-')}
        {fila('Pago de propinas', cuadre.efectivo.pagosPropinas, '-')}
        <dt className="font-semibold">Debería haber</dt>
        <dd className="text-right font-semibold">{pesos(c.esperado)}</dd>
        <dt className="font-semibold">Contado</dt>
        <dd className="text-right font-semibold">{pesos(c.contado)}</dd>
      </dl>
      <p className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">Efectivo</span>
        <Diferencia valor={c.diferencia} />
      </p>
      {/* Un turno cerrado antes de la 1.8 no tiene el cuadre de los demás medios: solo lo registrado. */}
      {c.otrosMedios.length > 0 ? (
        <div>
          <h3 className="font-semibold">Los demás medios</h3>
          <ul className="cifras mt-1 flex flex-col gap-2">
            {c.otrosMedios.map((m) => (
              <li key={claveMedio(m)} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {nombreDeMedio(m.medio, m.medioPropioId, reglas)}
                  <span className="block text-sm text-texto-suave">{`En la caja ${pesos(m.esperado)} · según su cierre ${pesos(m.reportado)}`}</span>
                </span>
                <Diferencia valor={m.diferencia} />
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
                  <span>{nombreDeMedio(m.medio, m.medioPropioId, reglas)}</span>
                  <span>{pesos(m.venta + m.propina)}</span>
                </li>
              ))}
            </ul>
          </div>
        )
      )}
      {c.justificacion && (
        <p className="border-t border-linea pt-2 text-sm">
          <span className="font-semibold">Por qué no cuadra: </span>
          {c.justificacion}
        </p>
      )}
    </section>
  )
}

/** «Cuadra», «Sobran $X» o «Faltan $X», con su ícono. */
function Diferencia({ valor }: { valor: number }) {
  if (valor === 0)
    return (
      <Etiqueta tono="libre" icono="check">
        Cuadra
      </Etiqueta>
    )
  return valor > 0 ? (
    <Etiqueta tono="proceso" icono="mas">
      {`Sobran ${pesos(valor)}`}
    </Etiqueta>
  ) : (
    <Etiqueta tono="alerta" icono="menos">
      {`Faltan ${pesos(-valor)}`}
    </Etiqueta>
  )
}
