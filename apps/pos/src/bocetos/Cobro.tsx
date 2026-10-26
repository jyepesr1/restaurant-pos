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
  const numero = useMesaDeLaRuta(12)
  const { parametros } = useRuta()
  const mesa = useMesas().find((m) => m.numero === numero)
  const avisar = useAvisar()

  const saldo = mesa ? saldoMesa(mesa) : 0
  const pedido = soloDigitos(parametros.get('monto') ?? '')
  const monto = pedido > 0 && pedido <= saldo ? pedido : saldo
  const sugerida = parametros.has('propina')
    ? soloDigitos(parametros.get('propina') ?? '')
    : propinaSobre(monto)

  const [medio, setMedio] = useState<Medio>('efectivo')
  const [propina, setPropina] = useState(() => propinaParaEfectivo(sugerida))
  const [recibido, setRecibido] = useState<number | null>(null)
  const [aprobacion, setAprobacion] = useState('')
  const [confirmando, setConfirmando] = useState(false)
  const [ultimoCambio, setUltimoCambio] = useState<number | null>(null)
  const confirmar = useRef<HTMLButtonElement>(null)

  const elegirMedio = (m: Medio) => {
    setMedio(m)
    setPropina(m === 'efectivo' ? propinaParaEfectivo(sugerida) : sugerida)
    setRecibido(null)
    setConfirmando(false)
  }

  const efectivo = monto > 0 ? pagoEnEfectivo({ saldo, monto, propina, recibido: 0 }) : null
  // Por defecto, el cliente entrega justo lo que hay que cobrar (un toque menos).
  const entregado = recibido ?? efectivo?.aEntregar ?? 0
  const calculo = monto > 0 ? pagoEnEfectivo({ saldo, monto, propina, recibido: entregado }) : null
  const tarjeta = monto > 0 ? pagoConTarjeta({ saldo, monto, propina }) : null
  const aCobrar = medio === 'efectivo' ? (calculo?.aEntregar ?? 0) : (tarjeta?.aprobado ?? 0)
  const puede =
    monto > 0 && (medio === 'efectivo' ? calculo?.falta === 0 : /^\d{4,8}$/.test(aprobacion))

  const registrar = () => {
    if (!mesa || !calculo || !puede) return
    const pago =
      medio === 'efectivo'
        ? {
            medio,
            monto,
            ajuste: calculo.ajuste,
            propina,
            recibido: entregado,
            cambio: calculo.cambio,
          }
        : { medio, monto, ajuste: 0, propina, recibido: null, cambio: null }
    const cierra = monto === saldo
    cambiarMesa(numero, (m) => ({
      ...m,
      pagos: [...m.pagos, pago],
      estado: cierra ? 'sucia' : m.estado,
    }))
    setConfirmando(false)
    setUltimoCambio(medio === 'efectivo' ? calculo.cambio : null)
    if (cierra) {
      // La mesa se cierra sola al quedar en 0: un toque menos. Se puede deshacer el cierre.
      avisar(`Mesa ${numero} pagada y cerrada`, () =>
        cambiarMesa(numero, (m) => ({ ...m, estado: 'precuenta' })),
      )
    } else {
      avisar(`Pago registrado. Queda ${pesos(saldo - monto)}`)
      navegar(`/bocetos/precuenta?mesa=${numero}`)
    }
  }

  // Al pedir confirmación, el foco va a "Confirmar": Enter confirma; Tab y Enter en "Cancelar",
  // cancela (el atajo nunca le gana al botón que tiene el foco).
  useEffect(() => {
    if (confirmando) confirmar.current?.focus()
  }, [confirmando])

  const teclas = useRef<(e: KeyboardEvent) => void>(() => {})
  teclas.current = (e: KeyboardEvent) => {
    if (e.repeat) return
    const enBoton = (e.target as HTMLElement | null)?.closest('button, a')
    if (e.key === 'F2' || e.key === 'F3') {
      e.preventDefault()
      elegirMedio(e.key === 'F2' ? 'efectivo' : 'tarjeta')
    } else if (e.key === 'Escape') setConfirmando(false)
    else if (e.key === 'Enter' && !enBoton && puede) {
      e.preventDefault()
      if (confirmando) registrar()
      else setConfirmando(true)
    }
  }
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => teclas.current(e)
    window.addEventListener('keydown', alTeclear)
    return () => window.removeEventListener('keydown', alTeclear)
  }, [])

  if (!mesa) return null
  const total = totalMesa(mesa)

  return (
    <Marco
      titulo={`Cobro · Mesa ${numero}`}
      usuario="Caja"
      volver={`/bocetos/precuenta?mesa=${numero}`}
    >
      <div className="mx-auto grid max-w-4xl gap-4 p-3 md:grid-cols-2">
        <section className="rounded-2xl border border-borde bg-superficie p-4" aria-label="Saldo">
          <p className="text-texto-suave">Saldo pendiente</p>
          <p
            className={`cifras font-titulo text-5xl font-bold ${saldo === 0 ? 'text-libre-texto' : ''}`}
          >
            {pesos(saldo)}
          </p>
          <p className="cifras mt-1 text-texto-suave">{`de ${pesos(total)}`}</p>
          {monto > 0 && monto < saldo && (
            <p className="mt-2">
              <Etiqueta tono="accion" icono="personas">{`Esta cuenta: ${pesos(monto)}`}</Etiqueta>
            </p>
          )}
          {ultimoCambio !== null && (
            <p className="mt-4 rounded-xl bg-libre-suave p-3 text-libre-texto">
              <span className="block">Cambio a entregar</span>
              <span className="cifras text-3xl font-bold">{pesos(ultimoCambio)}</span>
            </p>
          )}
          {mesa.pagos.length > 0 && (
            <ul className="cifras mt-4 flex flex-col gap-1 border-t border-borde pt-3">
              {mesa.pagos.map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: los pagos no se reordenan
                <li key={i} className="flex justify-between gap-2">
                  <span className="capitalize">{p.medio}</span>
                  <span className="text-right">
                    {pesos(p.monto)}
                    {p.propina > 0 && ` + propina ${pesos(p.propina)}`}
                    {p.ajuste !== 0 && ` (redondeo ${p.ajuste > 0 ? '+' : ''}${pesos(p.ajuste)})`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {saldo === 0 && (
            <Boton
              variante="secundario"
              grande
              className="mt-6 w-full"
              onClick={() => navegar('/bocetos/plano')}
            >
              Volver al salón
            </Boton>
          )}
        </section>

        {monto > 0 && (
          <section className="flex flex-col gap-3" aria-label="Pago">
            <Grupo etiqueta="Medio de pago" className="grid grid-cols-2 gap-2">
              {(
                [
                  ['efectivo', 'Efectivo', 'F2'],
                  ['tarjeta', 'Tarjeta', 'F3'],
                ] as const
              ).map(([m, texto, tecla]) => (
                <Opcion
                  key={m}
                  forma="tarjeta"
                  elegida={medio === m}
                  alElegir={() => elegirMedio(m)}
                  detalle={tecla}
                >
                  {texto}
                </Opcion>
              ))}
            </Grupo>

            <div className="rounded-2xl border border-borde bg-superficie p-4">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">Propina (voluntaria)</span>
                <span className="cifras text-sm text-texto-suave">{`sugerida ${pesos(sugerida)}`}</span>
              </div>
              <input
                inputMode="numeric"
                aria-label="Propina"
                value={conPuntos(propina)}
                onChange={(e) => setPropina(soloDigitos(e.target.value))}
                placeholder="0"
                className="cifras mt-2 min-h-12 w-full rounded-xl border border-borde bg-superficie px-3 text-xl focus-visible:outline-3 focus-visible:outline-foco"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <Boton
                  onClick={() =>
                    setPropina(medio === 'efectivo' ? propinaParaEfectivo(sugerida) : sugerida)
                  }
                >
                  Sugerida
                </Boton>
                <Boton onClick={() => setPropina(0)}>Sin propina</Boton>
              </div>
            </div>

            {medio === 'efectivo' && calculo ? (
              <div className="rounded-2xl border border-borde bg-superficie p-4">
                <p className="text-texto-suave">
                  {monto === saldo
                    ? 'A cobrar (venta redondeada a $100 + propina)'
                    : 'A cobrar (venta + propina)'}
                </p>
                <p className="cifras font-titulo text-3xl font-bold">{pesos(calculo.aEntregar)}</p>
                <label className="mt-3 block">
                  <span className="font-semibold">El cliente entrega</span>
                  <input
                    inputMode="numeric"
                    value={conPuntos(entregado)}
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
                  {calculo.falta > 0 ? (
                    <Etiqueta
                      tono="alerta"
                      icono="alerta"
                    >{`Faltan ${pesos(calculo.falta)}`}</Etiqueta>
                  ) : (
                    <Etiqueta
                      tono="libre"
                      icono="check"
                    >{`Cambio ${pesos(calculo.cambio)}`}</Etiqueta>
                  )}
                  {calculo.cambio > 0 && (
                    <Boton onClick={() => setPropina(propina + calculo.cambio)}>
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
                    value={aprobacion}
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
                aria-labelledby="confirmar-pago"
              >
                <p id="confirmar-pago" className="mb-3 text-lg font-semibold">
                  {`¿Registrar ${pesos(aCobrar)} en ${medio}?`}
                </p>
                <div className="flex gap-2">
                  <Boton onClick={() => setConfirmando(false)}>Cancelar</Boton>
                  <button
                    ref={confirmar}
                    type="button"
                    className="inline-flex min-h-12 flex-1 items-center justify-center rounded-xl bg-accion-fuerte px-4 font-semibold text-white focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-foco"
                    onClick={registrar}
                  >
                    Confirmar
                  </button>
                </div>
              </div>
            ) : (
              <Boton
                variante="principal"
                grande
                disabled={!puede}
                onClick={() => setConfirmando(true)}
              >
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
