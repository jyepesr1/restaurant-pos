import { type CuadreTurno, DENOMINACIONES, diaOperativo, nuevoId, totalesPedido } from '@pos/core'
import type { Catalogo } from '@pos/sync'
import { useRef, useState } from 'react'
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

/** «Mesa 4», «Mesa 5 + 6», «Para llevar». */
function nombreDePedido(catalogo: Catalogo | null, mesaId: string | null, unidas: string[]) {
  if (!mesaId) return 'Sin mesa'
  const nombres = [mesaId, ...unidas].map(
    (id) => catalogo?.mesas.find((m) => m.id === id)?.nombre ?? '?',
  )
  return `Mesa ${nombres.join(' + ')}`
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
            <Cobrado cuadre={cuadre} reglas={reglas} />
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

/** Lo cobrado en el turno por medio, con el total. */
function Cobrado({ cuadre, reglas }: { cuadre: CuadreTurno; reglas: ReglasCobro | null }) {
  const venta = cuadre.porMedio.reduce((a, m) => a + m.venta, 0)
  const propinas = cuadre.porMedio.reduce((a, m) => a + m.propina, 0)
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
  mesasAbiertas: { id: string; nombre: string; saldo: number }[]
  sinRed: React.ReactNode
  enLinea: boolean
  alVolver: () => void
  alCerrar: (cuadre: CuadreTurno) => void
}) {
  const avisar = useAvisar()
  const [arqueoId, setArqueoId] = useState<string | null>(null)
  const [justificacion, setJustificacion] = useState('')
  const [ocupado, setOcupado] = useState(false)
  const campos = useRef<(HTMLInputElement | null)[]>([])
  const guardar = useRef<HTMLButtonElement>(null)
  const clave = (d: (typeof DENOMINACIONES)[number]) => `${d.tipo}${d.valor}`
  const cantidadDe = (d: (typeof DENOMINACIONES)[number]) => cantidades[clave(d)] ?? 0
  const contado = DENOMINACIONES.reduce((a, d) => a + d.valor * cantidadDe(d), 0)
  const esperado = cuadre.efectivo.esperado
  const diferencia = contado - esperado
  const umbral = reglas?.umbralDiferencia ?? 1000
  const pideJustificar = diferencia !== 0 && Math.abs(diferencia) >= Math.max(1, umbral)

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
      await sala.registrarConfirmado('ArqueoRegistrado', cuadre.turnoId, {
        arqueo_id: id,
        conteo: [...porValor].map(([valor, cantidad]) => ({ valor, cantidad })),
        contado_efectivo: contado,
      })
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
      })
      avisar('Caja cerrada')
      alCerrar({
        ...cuadre,
        cerrado: {
          esperado,
          contado,
          diferencia,
          justificacion: final,
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
          {sinRed}
          <Boton
            ref={guardar}
            variante="principal"
            grande
            disabled={ocupado || !enLinea}
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
              cerrado: { esperado, contado, diferencia, justificacion: null, hora: '' },
            }}
            reglas={reglas}
          />
          {diferencia !== 0 && (
            <label>
              <span className="font-semibold">
                {pideJustificar ? '¿Por qué no cuadra?' : '¿Por qué no cuadra? (opcional)'}
              </span>
              {pideJustificar && (
                <span className="block text-sm text-texto-suave">
                  {umbral <= 1
                    ? 'Toda diferencia se explica; queda en el informe.'
                    : `Desde ${pesos(umbral)} de diferencia hay que explicarla; queda en el informe.`}
                </span>
              )}
              <textarea
                className={`${claseCampo} mt-1 min-h-24 py-2`}
                maxLength={500}
                value={justificacion}
                onChange={(e) => setJustificacion(e.target.value)}
              />
            </label>
          )}
          {sinRed}
          <div className="grid grid-cols-[2fr_3fr] gap-2">
            <Boton
              disabled={ocupado}
              onClick={() => {
                // Un conteo nuevo empieza de cero: no se acomoda al anterior.
                setArqueoId(null)
                setJustificacion('')
                alCambiarCantidades({})
              }}
            >
              Volver a contar
            </Boton>
            <Boton
              variante="principal"
              grande
              disabled={ocupado || !enLinea || (pideJustificar && !justificacion.trim())}
              onClick={cerrar}
            >
              {ocupado ? 'Cerrando…' : 'Cerrar la caja'}
            </Boton>
          </div>
        </>
      )}
    </>
  )
}

/** Cómo quedó (o queda) la caja: lo esperado, lo contado, la diferencia y los otros medios. */
function Resultado({ cuadre, reglas }: { cuadre: CuadreTurno; reglas: ReglasCobro | null }) {
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
        {c.diferencia === 0 ? (
          <Etiqueta tono="libre" icono="check">
            Cuadra
          </Etiqueta>
        ) : c.diferencia > 0 ? (
          <Etiqueta tono="proceso" icono="mas">
            {`Sobran ${pesos(c.diferencia)}`}
          </Etiqueta>
        ) : (
          <Etiqueta tono="alerta" icono="menos">
            {`Faltan ${pesos(-c.diferencia)}`}
          </Etiqueta>
        )}
        {c.justificacion && <span className="text-sm text-texto-suave">{c.justificacion}</span>}
      </p>
      {digitales.length > 0 && (
        <div>
          <h3 className="font-semibold">Otros medios</h3>
          <p className="text-sm text-texto-suave">
            Revísalos con el cierre del datáfono y de las apps (Nequi, Daviplata).
          </p>
          <ul className="cifras mt-1 flex flex-col gap-1">
            {digitales.map((m) => (
              <li key={`${m.medio}${m.medioPropioId ?? ''}`} className="flex justify-between">
                <span>{nombreDeMedio(m.medio, m.medioPropioId, reglas)}</span>
                <span>{pesos(m.venta + m.propina)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
