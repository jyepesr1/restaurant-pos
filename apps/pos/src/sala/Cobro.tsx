import { type EstadoPedido, type MedioPago, nuevoId } from '@pos/core'
import type { Catalogo } from '@pos/sync'
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

const CLAVE_DATAFONO = 'pos-ultimo-datafono'

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
  cuentaId: string | null
  nombre: string
  /** Lo que le falta a esa cuenta (o al pedido): el tope del pago. */
  disponible: number
  /** La cuenta de la división que se cobra (su monto y su propina), o null. */
  cuenta: { monto: number; propinaSugerida: number } | null
  /** La propina que el cliente pidió en la precuenta (sin propina, otro valor), o null. */
  propinaInicial: number | null
}

/** Los datos de `PagoRegistrado` sin el turno (lo pone quien registra). */
export interface PagoNuevo {
  pago_id: string
  cuenta_id: string | null
  medio: MedioPago
  monto: number
  propina: number
  recibido: number | null
  cambio: number | null
  ajuste_redondeo: number
  redondeo: { multiplo: number; modo: ReglasCobro['redondeoEfectivoModo'] } | null
  datafono: {
    datafono_id: string
    franquicia: null
    ultimos4: null
    aprobacion: null
    recibo: null
    tipo_tarjeta: 'credito' | 'debito' | null
  } | null
  referencia_cobro: null
  medio_propio_id: string | null
}

/** Cómo se eligió la propina: la sugerida, otro porcentaje o un valor fijo. */
type Eleccion =
  | { tipo: 'sugerida' }
  | { tipo: 'porcentaje'; puntos: number }
  | { tipo: 'valor'; pesos: number }

const porcentaje = (puntos: number) => `${`${puntos / 100}`.replace('.', ',')} %`

export function PanelCobro({
  cobrando,
  pedido,
  reglas,
  datafonos,
  ocupado,
  alCerrar,
  alCobrar,
}: {
  cobrando: Cobrando | null
  pedido: EstadoPedido
  reglas: ReglasCobro
  datafonos: NonNullable<Catalogo['datafonos']>
  ocupado: boolean
  alCerrar: () => void
  alCobrar: (pago: PagoNuevo) => void
}) {
  if (!cobrando)
    return (
      <PanelLateral abierto={false} titulo="Cobrar" alCerrar={alCerrar}>
        {null}
      </PanelLateral>
    )
  return (
    <FormularioCobro
      key={`${cobrando.cuentaId}-${cobrando.disponible}`}
      cobrando={cobrando}
      pedido={pedido}
      reglas={reglas}
      datafonos={datafonos}
      ocupado={ocupado}
      alCerrar={alCerrar}
      alCobrar={alCobrar}
    />
  )
}

function FormularioCobro({
  cobrando,
  pedido,
  reglas,
  datafonos,
  ocupado,
  alCerrar,
  alCobrar,
}: {
  cobrando: Cobrando
  pedido: EstadoPedido
  reglas: ReglasCobro
  datafonos: NonNullable<Catalogo['datafonos']>
  ocupado: boolean
  alCerrar: () => void
  alCobrar: (pago: PagoNuevo) => void
}) {
  // El mismo id en cada intento: si el hub tarda y se reintenta, no queda un pago doble.
  const [pagoId] = useState(nuevoId)
  const opciones = opcionesDeCobro(reglas)
  const { disponible } = cobrando
  const [clave, setClave] = useState(opciones[0]?.clave ?? 'efectivo')
  const opcion: OpcionCobro =
    opciones.find((o) => o.clave === clave) ??
    ({
      clave: 'efectivo',
      nombre: 'Efectivo',
      medio: 'efectivo',
      tipoTarjeta: null,
      medioPropioId: null,
    } as const)
  const esEfectivo = opcion.medio === 'efectivo'
  const [monto, setMonto] = useState(disponible)
  const [eleccion, setEleccion] = useState<Eleccion>(() =>
    cobrando.propinaInicial !== null
      ? { tipo: 'valor', pesos: cobrando.propinaInicial }
      : { tipo: 'sugerida' },
  )
  // Escribir otro valor: en pesos o en porcentaje.
  const [enPorcentaje, setEnPorcentaje] = useState(false)
  const [recibido, setRecibido] = useState<number | null>(null)
  const [datafono, setDatafono] = useState(
    () => datafonos.find((d) => d.id === recordado())?.id ?? datafonos[0]?.id ?? null,
  )
  const [confirmando, setConfirmando] = useState(false)
  const confirmar = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (confirmando) confirmar.current?.focus()
  }, [confirmando])

  const montoValido = monto > 0 && monto <= disponible
  const valor = montoValido ? monto : 0
  /** La propina con un porcentaje; en efectivo, redondeada para pagarla con billetes. */
  const conPorcentaje = (puntos: number) => {
    const exacta =
      puntos === reglas.propinaSugerida
        ? propinaDePago(pedido, cobrando.cuenta, disponible, valor, reglas)
        : propinaConPorcentaje(pedido, disponible, valor, puntos, reglas)
    return esEfectivo ? propinaParaEfectivo(exacta, reglas) : exacta
  }
  const propina =
    eleccion.tipo === 'valor'
      ? eleccion.pesos
      : conPorcentaje(eleccion.tipo === 'sugerida' ? reglas.propinaSugerida : eleccion.puntos)
  const elegir = (e: Eleccion) => {
    setEleccion(e)
    setConfirmando(false)
  }
  const rapidos = [...new Set([0, 500, reglas.propinaSugerida])].sort((a, b) => a - b)

  const elegirOpcion = (o: OpcionCobro) => {
    setClave(o.clave)
    setRecibido(null)
    setConfirmando(false)
  }

  const efectivo = montoValido
    ? pagoEnEfectivo({ saldo: disponible, monto, propina, recibido: 0 }, reglas)
    : null
  // Por defecto, el cliente entrega justo lo que hay que cobrar (un toque menos).
  const entregado = recibido ?? efectivo?.aEntregar ?? 0
  const calculo = montoValido
    ? pagoEnEfectivo({ saldo: disponible, monto, propina, recibido: entregado }, reglas)
    : null
  const aCobrar = esEfectivo ? (calculo?.aEntregar ?? 0) : monto + propina
  const sinDatafono = opcion.medio === 'tarjeta' && datafono === null
  const puede = montoValido && !ocupado && !sinDatafono && (!esEfectivo || calculo?.falta === 0)

  const registrar = () => {
    if (!puede || !calculo) return
    if (opcion.medio === 'tarjeta' && datafono) recordar(datafono)
    alCobrar({
      pago_id: pagoId,
      cuenta_id: cobrando.cuentaId,
      medio: opcion.medio,
      monto,
      propina,
      recibido: esEfectivo ? entregado : null,
      cambio: esEfectivo ? calculo.cambio : null,
      ajuste_redondeo: esEfectivo ? calculo.ajuste : 0,
      redondeo: esEfectivo ? calculo.redondeo : null,
      datafono:
        opcion.medio === 'tarjeta' && datafono
          ? {
              datafono_id: datafono,
              franquicia: null,
              ultimos4: null,
              aprobacion: null,
              recibo: null,
              tipo_tarjeta: opcion.tipoTarjeta,
            }
          : null,
      referencia_cobro: null,
      medio_propio_id: opcion.medioPropioId,
    })
  }

  const nombreDatafono = datafonos.find((d) => d.id === datafono)?.nombre
  const donde =
    opcion.medio === 'tarjeta' && nombreDatafono
      ? `${opcion.nombre.toLowerCase()} (${nombreDatafono})`
      : opcion.nombre.toLowerCase()

  // Atajos de la caja (tarea 0.9): F2 efectivo, F3 crédito, F4 débito, Enter cobra y Esc vuelve.
  // El atajo nunca le gana al botón que tiene el foco.
  const atajo: Record<string, string> = { F2: 'efectivo', F3: 'credito', F4: 'debito' }
  // Los atajos solo se anuncian donde hay mouse y teclado (la caja); en el celular estorban.
  const [conTeclado] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches,
  )
  const teclas = useRef<(e: KeyboardEvent) => void>(() => {})
  teclas.current = (e: KeyboardEvent) => {
    if (e.repeat) return
    const enBoton = (e.target as HTMLElement | null)?.closest('button, a')
    const deAtajo = opciones.find((o) => o.clave === atajo[e.key])
    if (deAtajo) {
      e.preventDefault()
      elegirOpcion(deAtajo)
    } else if (e.key === 'Escape' && confirmando) {
      e.preventDefault()
      e.stopPropagation()
      setConfirmando(false)
    } else if (e.key === 'Enter' && !enBoton && puede) {
      e.preventDefault()
      if (confirmando) registrar()
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
      aria-labelledby="confirmar-pago"
    >
      <p id="confirmar-pago" className="mb-3 text-lg font-semibold">
        {`¿Registrar ${pesos(aCobrar)} en ${donde}?`}
      </p>
      <div className="flex gap-2">
        <Boton onClick={() => setConfirmando(false)}>Volver</Boton>
        <button
          ref={confirmar}
          type="button"
          disabled={ocupado}
          className="inline-flex min-h-12 flex-1 items-center justify-center rounded-xl bg-accion-fuerte px-4 font-semibold text-white focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-foco disabled:opacity-60"
          onClick={registrar}
        >
          {ocupado ? 'Registrando…' : `Sí, registrar ${pesos(aCobrar)}`}
        </button>
      </div>
    </div>
  ) : (
    <Boton
      variante="principal"
      grande
      className="w-full"
      disabled={!puede}
      onClick={() => setConfirmando(true)}
    >
      {`Cobrar ${pesos(aCobrar)}`}
    </Boton>
  )

  return (
    <PanelLateral abierto titulo={`Cobrar · ${cobrando.nombre}`} alCerrar={alCerrar} pie={pie}>
      <div className="flex flex-col gap-4">
        <section
          className="rounded-2xl border border-linea bg-superficie-2/60 p-4"
          aria-label="Saldo"
        >
          <p className="text-texto-suave">Por cobrar</p>
          <p className="cifras font-titulo text-4xl font-bold">{pesos(disponible)}</p>
          <label className="mt-3 block">
            <span className="font-semibold">Valor de este pago</span>
            <input
              inputMode="numeric"
              className={`${claseCampo} cifras mt-1 text-xl`}
              value={conPuntos(monto)}
              onChange={(e) => {
                setMonto(Math.min(soloDigitos(e.target.value), disponible))
                setRecibido(null)
                setConfirmando(false)
              }}
            />
          </label>
          {monto < disponible && monto > 0 && (
            <p className="mt-2 text-sm text-texto-suave">
              {`Pago parcial: quedan ${pesos(disponible - monto)} por cobrar.`}
            </p>
          )}
        </section>

        <Grupo etiqueta="Medio de pago" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {opciones.map((o) => (
            <Opcion
              key={o.clave}
              forma="tarjeta"
              elegida={clave === o.clave}
              alElegir={() => elegirOpcion(o)}
              detalle={(() => {
                const tecla = Object.keys(atajo).find((k) => atajo[k] === o.clave)
                return conTeclado && tecla ? `Tecla ${tecla}` : undefined
              })()}
            >
              {o.nombre}
            </Opcion>
          ))}
        </Grupo>

        <section className="rounded-2xl border border-linea bg-superficie p-4" aria-label="Propina">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-semibold">Propina (voluntaria)</span>
            <span className="cifras font-titulo text-2xl font-bold">{pesos(propina)}</span>
          </div>
          <Grupo etiqueta="Propina" className="mt-3 flex flex-wrap gap-2">
            {rapidos.map((p) => {
              const elegida =
                p === 0
                  ? eleccion.tipo === 'valor' && eleccion.pesos === 0
                  : p === reglas.propinaSugerida
                    ? eleccion.tipo === 'sugerida'
                    : eleccion.tipo === 'porcentaje' && eleccion.puntos === p
              return (
                <Opcion
                  key={p}
                  elegida={elegida}
                  alElegir={() =>
                    elegir(
                      p === 0
                        ? { tipo: 'valor', pesos: 0 }
                        : p === reglas.propinaSugerida
                          ? { tipo: 'sugerida' }
                          : { tipo: 'porcentaje', puntos: p },
                    )
                  }
                >
                  {p === 0
                    ? 'Sin propina'
                    : p === reglas.propinaSugerida
                      ? `${porcentaje(p)} (sugerida)`
                      : porcentaje(p)}
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
                    ? eleccion.tipo === 'porcentaje' && !rapidos.includes(eleccion.puntos)
                      ? String(eleccion.puntos / 100)
                      : ''
                    : eleccion.tipo === 'valor' && eleccion.pesos > 0
                      ? conPuntos(eleccion.pesos)
                      : ''
                }
                onChange={(e) => {
                  const n = soloDigitos(e.target.value)
                  if (enPorcentaje) elegir({ tipo: 'porcentaje', puntos: Math.min(n, 100) * 100 })
                  else elegir({ tipo: 'valor', pesos: n })
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
              {calculo.ajuste !== 0
                ? `A cobrar (venta redondeada a ${pesos(reglas.redondeoEfectivo)} + propina)`
                : 'A cobrar (venta + propina)'}
            </p>
            <p className="cifras font-titulo text-3xl font-bold">{pesos(calculo.aEntregar)}</p>
            <label className="mt-3 block">
              <span className="font-semibold">El cliente entrega</span>
              <input
                inputMode="numeric"
                className={`${claseCampo} cifras mt-1 min-h-14 text-2xl`}
                value={conPuntos(entregado)}
                onChange={(e) => {
                  setRecibido(soloDigitos(e.target.value))
                  setConfirmando(false)
                }}
              />
            </label>
            <div className="cifras mt-3 flex flex-wrap items-center gap-2 text-lg">
              {calculo.falta > 0 ? (
                <Etiqueta tono="alerta" icono="alerta">{`Faltan ${pesos(calculo.falta)}`}</Etiqueta>
              ) : (
                <Etiqueta tono="libre" icono="check">{`Cambio ${pesos(calculo.cambio)}`}</Etiqueta>
              )}
              {calculo.cambio > 0 && (
                <Boton onClick={() => elegir({ tipo: 'valor', pesos: propina + calculo.cambio })}>
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
              {opcion.medio === 'tarjeta'
                ? 'Total en el datáfono (venta + propina)'
                : `A cobrar por ${opcion.nombre} (venta + propina)`}
            </p>
            <p className="cifras font-titulo text-3xl font-bold">{pesos(aCobrar)}</p>
            {opcion.medio === 'tarjeta' &&
              (datafonos.length === 0 ? (
                <p className="mt-2 rounded-xl bg-proceso-suave p-3 text-proceso-texto">
                  No hay datáfonos: agrégalos en «Caja y pagos» para cobrar con tarjeta.
                </p>
              ) : (
                datafonos.length > 1 && (
                  <Grupo etiqueta="Datáfono" className="mt-3 flex flex-wrap gap-2">
                    {datafonos.map((d) => (
                      <Opcion
                        key={d.id}
                        elegida={datafono === d.id}
                        alElegir={() => setDatafono(d.id)}
                      >
                        {d.nombre}
                      </Opcion>
                    ))}
                  </Grupo>
                )
              ))}
            {opcion.medio !== 'tarjeta' && (
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
