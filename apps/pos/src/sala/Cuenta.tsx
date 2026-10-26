import { type EstadoPedido, impuestosDelPedido, nuevoId, totalesPedido } from '@pos/core'
import type { Catalogo } from '@pos/sync'
import { useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { Etiqueta } from '../ui/Etiqueta'
import { conPuntos, pesos, soloDigitos } from '../ui/formato'
import { Grupo, Opcion } from '../ui/Opciones'
import { PanelLateral } from '../ui/PanelLateral'
import { navegar, useRuta } from '../ui/ruta'
import { type Cobrando, type PagoNuevo, PanelCobro } from './Cobro'
import { sala, useSala, useVistaLocal } from './contexto'
import {
  enPartesIguales,
  lineasDe,
  nombreDeMedio,
  nombreImpuesto,
  porCobrar,
  porProductos,
  propinaSugeridaDe,
  recortarAsignaciones,
  reglasDe,
} from './cuentas'
import { claseCampo } from './Entrar'
import { MarcoSala } from './MarcoSala'
import { CANALES, unidadesPorEnviar } from './pedido'

// La cuenta de un pedido (tarea 1.6, brief §4.5): la precuenta en pantalla y en papel, dividirla
// (en partes iguales o por productos) y cobrar cada parte. Se divide el SALDO: lo ya pagado queda
// aparte. Cobrar solo se puede en un equipo de caja con la caja abierta y conexión con el hub; al
// quedar el saldo en 0, el pedido se cierra solo y la mesa queda libre.

type Modo = 'una' | 'iguales' | 'productos'

const MOTIVOS_ANULAR_PAGO = ['Se registró por error', 'Pagó con otro medio'] as const

const mensaje = (e: unknown) => (e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.')

/** «Mesa 5 + 6», «Para llevar #12». */
function tituloDe(catalogo: Catalogo, pedido: EstadoPedido): string {
  if (pedido.mesaId) {
    const nombres = [pedido.mesaId, ...pedido.mesasUnidas].map(
      (id) => catalogo.mesas.find((m) => m.id === id)?.nombre ?? '?',
    )
    return `Mesa ${nombres.join(' + ')}`
  }
  const canal = CANALES[pedido.canal as keyof typeof CANALES] ?? 'Pedido'
  return pedido.numeroDia ? `${canal} #${pedido.numeroDia}` : canal
}

export function Cuenta() {
  const { parametros } = useRuta()
  const pedidoId = parametros.get('pedido')
  const vista = useVistaLocal()
  const { catalogo, sesion, equipo, conexion } = useSala()
  const avisar = useAvisar()
  // Lo cobrado que cerró el pedido: se sigue viendo (el cambio que hay que entregar).
  const [cerrado, setCerrado] = useState<{ titulo: string; cambio: number | null } | null>(null)
  const [ultimoCambio, setUltimoCambio] = useState<number | null>(null)
  const [modo, setModo] = useState<Modo>('una')
  const [personas, setPersonas] = useState(2)
  const [cuentas, setCuentas] = useState(2)
  const [asignadas, setAsignadas] = useState<Map<string, number[]>>(new Map())
  const [cobrando, setCobrando] = useState<Cobrando | null>(null)
  const [anulando, setAnulando] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const [propinaElegida, setPropinaElegida] = useState<number | null>(null)
  const [editandoPropina, setEditandoPropina] = useState(false)

  if (cerrado)
    return (
      <MarcoSala titulo={cerrado.titulo} volver="/">
        <div className="mx-auto flex max-w-md flex-col gap-4 p-4">
          <p className="rounded-2xl bg-libre-suave p-4 text-libre-texto">
            <span className="block text-lg font-semibold">Pagado y cerrado</span>
            {cerrado.cambio !== null && cerrado.cambio > 0 && (
              <>
                <span className="mt-2 block">Cambio a entregar</span>
                <span className="cifras font-titulo text-4xl font-bold">
                  {pesos(cerrado.cambio)}
                </span>
              </>
            )}
          </p>
          <Boton variante="principal" grande icono="mesa" onClick={() => navegar('/')}>
            Volver al salón
          </Boton>
        </div>
      </MarcoSala>
    )

  if (!catalogo || !vista) return null
  const pedidoVisible = vista.pedidos.find((p) => p.estado.id === pedidoId)
  if (!pedidoVisible)
    return (
      <MarcoSala titulo="Cuenta" volver="/">
        <p className="p-6 text-texto-suave">Este pedido ya no está abierto.</p>
      </MarcoSala>
    )
  const pedido = pedidoVisible.estado
  const titulo = tituloDe(catalogo, pedido)
  const volverAlPedido = `/pedido?pedido=${pedido.id}${pedido.mesaId ? `&mesa=${pedido.mesaId}` : ''}`
  const reglas = reglasDe(catalogo)
  if (!reglas)
    return (
      <MarcoSala titulo={`Cuenta · ${titulo}`} volver="/">
        <p className="p-6 text-texto-suave">
          La caja tiene una versión anterior que no sabe cobrar: hay que actualizarla.
        </p>
      </MarcoSala>
    )

  const permisos = sesion?.permisos ?? []
  const enLinea = conexion === 'conectado'
  const esCaja = equipo?.tipo === 'caja'
  const puedeDividir = permisos.includes('dividir_cuenta')
  const puedeCobrar = esCaja && permisos.includes('registrar_pago')
  const puedeAnularPago = esCaja && permisos.includes('anular_pago')
  const puedeCerrar = esCaja && permisos.includes('cerrar_mesa')
  const turno = vista.turno
  const totales = totalesPedido(pedido)
  const lineas = lineasDe(pedido)
  const { saldo, cuentas: divididas, sinAsignar } = porCobrar(pedido)
  const propinaSaldo = propinaSugeridaDe(pedido, saldo, reglas)
  const propinaCinco = propinaSugeridaDe(pedido, saldo, { ...reglas, propinaSugerida: 500 })
  // La que pide el cliente al ver la precuenta (sin propina, otro valor); va al papel y al cobro.
  const propinaVista = propinaElegida ?? propinaSaldo
  const impuestos = impuestosDelPedido(pedido, reglas.redondeoModo)
  const pagos = Object.values(pedido.pagos).filter((p) => !p.anulado)
  const sinEnviar = unidadesPorEnviar(pedido)

  /** Un trabajo que registra eventos: uno a la vez, y el error se avisa. */
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

  const imprimir = (cuentaId: string | null, subtotal: number, propina: number) =>
    hacer(async () => {
      await sala.registrar('PrecuentaImpresa', pedido.id, {
        cuenta_id: cuentaId,
        subtotal,
        propina_sugerida: propina,
      })
      avisar(
        reglas.imprimePrecuenta ? 'Precuenta enviada a la impresora' : `${titulo}: pidió la cuenta`,
      )
    })

  const dividir = (nuevas: ReturnType<typeof enPartesIguales>) =>
    hacer(async () => {
      await sala.registrar('CuentaDividida', pedido.id, { cuentas: nuevas })
      setModo('una')
      setAsignadas(new Map())
    })

  const deshacer = () =>
    hacer(async () => {
      await sala.registrar('DivisionDeshecha', pedido.id, {})
    })

  /** Cierra el pedido con saldo 0; el hub confirma antes de mostrarlo cerrado. */
  const cerrar = async (cambio: number | null) => {
    await sala.registrarConfirmado('PedidoCerrado', pedido.id, {})
    setCerrado({ titulo, cambio })
    avisar(`${titulo}: pagada y cerrada`)
  }

  // El dinero se muestra como cobrado solo cuando el hub lo acepta: un pago que el hub rechaza
  // desaparecería de la cuenta después de que el cliente ya pagó.
  const cobrar = (pago: PagoNuevo) =>
    hacer(async () => {
      if (!turno) throw new Error('Abre la caja para cobrar')
      await sala.registrarConfirmado('PagoRegistrado', pedido.id, {
        ...pago,
        turno_caja_id: turno.id,
      })
      setCobrando(null)
      setUltimoCambio(pago.cambio)
      // Lo que queda según lo guardado ya con el pago (otro equipo pudo cobrar al mismo tiempo).
      const despues = await sala.sync?.pedido(pedido.id)
      const queda = despues ? totalesPedido(despues).saldo : saldo - pago.monto
      // La mesa se cierra sola al quedar en 0 (decisión del dueño, 26-oct-2026). Si el cierre
      // falla, el pago ya quedó y «Cerrar la mesa» lo vuelve a intentar.
      if (queda === 0 && puedeCerrar) await cerrar(pago.cambio)
      else avisar(queda === 0 ? 'Pago registrado' : `Pago registrado. Queda ${pesos(queda)}`)
    })

  const anularPago = (pagoId: string, motivo: string) =>
    hacer(async () => {
      if (!turno) throw new Error('Abre la caja para anular un pago')
      await sala.registrarConfirmado(
        'PagoAnulado',
        pedido.id,
        { pago_id: pagoId, turno_caja_id: turno.id },
        { motivo },
      )
      setAnulando(null)
      avisar('Pago anulado')
    })

  // Por qué no se puede cobrar aquí, si no se puede.
  const sinCobro = !puedeCobrar
    ? null
    : !enLinea
      ? 'Sin conexión con el hub: para cobrar hace falta la red. Revisa el cable o el Wi-Fi.'
      : !turno
        ? 'La caja está cerrada: ábrela con la base para empezar a cobrar.'
        : turno.porConfirmar
          ? 'La caja se está abriendo: espera a que el hub lo confirme.'
          : null
  const abrirCobro = (c: Cobrando) => {
    if (!sinCobro) setCobrando(c)
  }

  const montosVista =
    modo === 'iguales'
      ? enPartesIguales(pedido, personas, reglas, nuevoId)
      : modo === 'productos'
        ? porProductos(pedido, asignadas, cuentas, reglas, nuevoId).cuentas
        : []
  const sinAsignarVista =
    modo === 'productos' ? porProductos(pedido, asignadas, cuentas, reglas, nuevoId).sinAsignar : 0
  // Por productos solo antes del primer pago: después se divide lo que queda en partes iguales.
  const porProductosPosible = totales.pagado === 0

  const tocarItem = (id: string, cuenta: number) =>
    setAsignadas((a) => {
      const b = new Map(a)
      const actuales = b.get(id) ?? []
      const nuevas = actuales.includes(cuenta)
        ? actuales.filter((c) => c !== cuenta)
        : [...actuales, cuenta].sort((x, y) => x - y)
      if (nuevas.length === 0) b.delete(id)
      else b.set(id, nuevas)
      return b
    })

  return (
    <MarcoSala titulo={`Cuenta · ${titulo}`} volver={volverAlPedido}>
      <div className="mx-auto grid max-w-5xl gap-4 p-3 pb-28 md:grid-cols-[1fr_24rem] md:p-5">
        <section
          className="rounded-2xl border border-linea bg-superficie shadow-flota"
          aria-label="Precuenta"
        >
          <ul>
            {lineas.map((l) => (
              <li key={l.id} className="border-b border-linea px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className="cifras w-6 font-semibold">{l.cantidad}</span>
                  <span className="flex-1">
                    <span className="font-semibold">{l.nombre}</span>
                    {l.opciones.length > 0 && (
                      <span className="block text-sm text-texto-suave">
                        {l.opciones.join(' · ')}
                      </span>
                    )}
                  </span>
                  <span className="cifras">{pesos(l.neto)}</span>
                </div>
                {modo === 'productos' && porProductosPosible && !pedido.cuentas && (
                  <Grupo
                    etiqueta={`Quién paga ${l.nombre}`}
                    className="mt-2 flex flex-wrap gap-2 pl-9"
                  >
                    {Array.from({ length: cuentas }, (_, c) => (
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
            {lineas.length === 0 && (
              <li className="p-4 text-texto-suave">El pedido no tiene productos.</li>
            )}
          </ul>
          <dl className="cifras grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 p-4">
            {impuestos.length > 0 && (
              <>
                <dt className="text-texto-suave">Base sin impuestos</dt>
                <dd className="text-right text-texto-suave">
                  {pesos(impuestos.reduce((a, i) => a + i.base, 0))}
                </dd>
                {impuestos
                  .filter((i) => i.impuesto > 0)
                  .map((i) => (
                    <div key={`${i.tipo}${i.tarifa}`} className="contents">
                      <dt className="text-texto-suave">{nombreImpuesto(i.tipo, i.tarifa)}</dt>
                      <dd className="text-right text-texto-suave">{pesos(i.impuesto)}</dd>
                    </div>
                  ))}
              </>
            )}
            <dt className="font-semibold">Total</dt>
            <dd className="text-right font-semibold">{pesos(totales.neto)}</dd>
            {totales.pagado > 0 && (
              <>
                <dt className="text-libre-texto">Ya pagado</dt>
                <dd className="text-right text-libre-texto">{`-${pesos(totales.pagado)}`}</dd>
                <dt className="font-semibold">Saldo</dt>
                <dd className="text-right font-semibold">{pesos(saldo)}</dd>
              </>
            )}
            {saldo > 0 && (
              <>
                <dt className="flex items-center gap-2 text-texto-suave">
                  {propinaElegida === null
                    ? `Propina sugerida (${reglas.propinaSugerida / 100} %, voluntaria)`
                    : 'Propina (voluntaria)'}
                  <Boton
                    variante="fantasma"
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
                  {pesos(saldo + propinaVista)}
                </dd>
              </>
            )}
          </dl>
          {editandoPropina && saldo > 0 && (
            <div className="mx-4 mb-4 flex flex-col gap-2 rounded-xl bg-superficie-2/60 p-3">
              <Grupo etiqueta="Propina" className="flex flex-wrap gap-2">
                <Opcion
                  elegida={propinaElegida === null}
                  alElegir={() => {
                    setPropinaElegida(null)
                    setEditandoPropina(false)
                  }}
                >
                  {`${reglas.propinaSugerida / 100} % (sugerida) · ${pesos(propinaSaldo)}`}
                </Opcion>
                {reglas.propinaSugerida !== 500 && (
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
          {pagos.length > 0 && (
            <div className="border-t border-linea p-4">
              <h2 className="mb-2 font-semibold">Pagos</h2>
              <ul className="cifras flex flex-col gap-2">
                {pagos.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {nombreDeMedio(p.medio, p.medioPropioId, reglas)}
                      {p.cuentaId &&
                        ` · ${divididas.find((c) => c.id === p.cuentaId)?.nombre ?? 'Cuenta'}`}
                    </span>
                    <span className="flex items-center gap-2 text-right">
                      {pesos(p.monto)}
                      {p.propina > 0 && ` + propina ${pesos(p.propina)}`}
                      {p.ajusteRedondeo !== 0 &&
                        ` (redondeo ${p.ajusteRedondeo > 0 ? '+' : ''}${pesos(p.ajusteRedondeo)})`}
                      {puedeAnularPago && turno && enLinea && (
                        <Boton variante="fantasma" onClick={() => setAnulando(p.id)}>
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
            variante="secundario"
            grande
            icono="recibo"
            disabled={ocupado || saldo === 0}
            onClick={() => imprimir(null, saldo, propinaVista)}
          >
            {reglas.imprimePrecuenta ? 'Imprimir precuenta' : 'Pidió la cuenta'}
          </Boton>
          {!reglas.imprimePrecuenta && (
            <p className="text-sm text-texto-suave">
              Sin impresora de precuentas: muéstrale esta pantalla al cliente.
            </p>
          )}

          {saldo === 0 && puedeCerrar && (
            <Boton
              variante="principal"
              grande
              icono="check"
              disabled={ocupado || !enLinea}
              onClick={() => hacer(() => cerrar(ultimoCambio))}
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

          {!puedeCobrar && saldo > 0 && (
            <p className="text-sm text-texto-suave">El cobro lo hace la caja.</p>
          )}

          {sinCobro && (
            <div className="rounded-xl bg-proceso-suave p-3 text-proceso-texto">
              <p>{sinCobro}</p>
              {!turno && enLinea && (
                <Boton
                  className="mt-2"
                  onClick={() =>
                    navegar(`/caja?volver=${encodeURIComponent(`/cuenta?pedido=${pedido.id}`)}`)
                  }
                >
                  Abrir la caja
                </Boton>
              )}
            </div>
          )}

          {pedido.cuentas ? (
            <Divididas
              cuentas={divididas}
              sinAsignar={sinAsignar}
              puedeCobrar={puedeCobrar && !sinCobro}
              puedeDeshacer={puedeDividir && !pagos.some((p) => p.cuentaId !== null)}
              ocupado={ocupado}
              alCobrar={abrirCobro}
              alImprimir={(c) => imprimir(c.id, c.saldo, c.propinaPendiente)}
              alDeshacer={deshacer}
            />
          ) : (
            <>
              {puedeDividir && saldo > 0 && (
                <Grupo etiqueta="Cómo se paga" className="grid grid-cols-3 gap-2">
                  {(
                    [
                      ['una', 'Una cuenta'],
                      ['iguales', 'Partes iguales'],
                      ['productos', 'Por productos'],
                    ] as const
                  ).map(([m, texto]) => (
                    <Opcion
                      key={m}
                      forma="tarjeta"
                      elegida={modo === m}
                      alElegir={() => setModo(m)}
                    >
                      {texto}
                    </Opcion>
                  ))}
                </Grupo>
              )}
              {modo === 'una' && puedeCobrar && saldo > 0 && (
                <Boton
                  variante="principal"
                  grande
                  icono="billete"
                  disabled={!!sinCobro || ocupado}
                  onClick={() =>
                    abrirCobro({
                      cuentaId: null,
                      nombre: titulo,
                      disponible: saldo,
                      cuenta: null,
                      propinaInicial: propinaElegida,
                    })
                  }
                >
                  {`Cobrar ${pesos(saldo)}`}
                </Boton>
              )}
              {modo === 'iguales' && (
                <Contador
                  nombre="Personas"
                  valor={personas}
                  minimo={2}
                  maximo={20}
                  alCambiar={setPersonas}
                />
              )}
              {modo === 'productos' &&
                (porProductosPosible ? (
                  <>
                    <Contador
                      nombre="Cuentas"
                      valor={cuentas}
                      minimo={2}
                      maximo={10}
                      alCambiar={(n) => {
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
              {modo !== 'una' && (modo === 'iguales' || porProductosPosible) && (
                <>
                  <ul className="flex flex-col gap-2">
                    {montosVista.map((c) => (
                      <li
                        key={c.cuenta_id}
                        className="cifras flex justify-between rounded-xl border border-linea bg-superficie p-3"
                      >
                        <span className="font-semibold">{c.nombre}</span>
                        <span>{`${pesos(c.monto)} + propina ${pesos(c.propina_sugerida)}`}</span>
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
                    variante="principal"
                    grande
                    disabled={ocupado || montosVista.every((c) => c.monto === 0)}
                    onClick={() => dividir(montosVista)}
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
        pedido={pedido}
        reglas={reglas}
        datafonos={catalogo.datafonos ?? []}
        ocupado={ocupado}
        alCerrar={() => setCobrando(null)}
        alCobrar={cobrar}
      />
      <PanelAnularPago
        key={anulando ?? 'ninguno'}
        pagoId={anulando}
        ocupado={ocupado}
        alCerrar={() => setAnulando(null)}
        alAnular={anularPago}
      />
    </MarcoSala>
  )
}

function Divididas({
  cuentas,
  sinAsignar,
  puedeCobrar,
  puedeDeshacer,
  ocupado,
  alCobrar,
  alImprimir,
  alDeshacer,
}: {
  cuentas: ReturnType<typeof porCobrar>['cuentas']
  sinAsignar: number
  puedeCobrar: boolean
  puedeDeshacer: boolean
  ocupado: boolean
  alCobrar: (c: Cobrando) => void
  alImprimir: (c: ReturnType<typeof porCobrar>['cuentas'][number]) => void
  alDeshacer: () => void
}) {
  return (
    <>
      <ul className="flex flex-col gap-2">
        {cuentas.map((c) => (
          <li
            key={c.id}
            className="flex flex-col gap-2 rounded-xl border border-linea bg-superficie p-3"
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className="font-semibold">{c.nombre}</span>
              {c.saldo === 0 ? (
                <Etiqueta tono="libre" icono="check">
                  Pagada
                </Etiqueta>
              ) : (
                <span className="cifras text-sm text-texto-suave">{`${pesos(c.saldo)} + propina ${pesos(c.propinaPendiente)}`}</span>
              )}
            </span>
            {c.saldo > 0 && (
              <span className="flex gap-2">
                <Boton
                  icono="recibo"
                  aria-label={`Precuenta de ${c.nombre}`}
                  disabled={ocupado}
                  onClick={() => alImprimir(c)}
                >
                  Precuenta
                </Boton>
                {puedeCobrar && (
                  <Boton
                    variante="principal"
                    className="flex-1"
                    disabled={ocupado}
                    onClick={() =>
                      alCobrar({
                        cuentaId: c.id,
                        nombre: c.nombre,
                        disponible: c.saldo,
                        cuenta: c,
                        propinaInicial: null,
                      })
                    }
                  >
                    {`Cobrar ${pesos(c.saldo)}`}
                  </Boton>
                )}
              </span>
            )}
          </li>
        ))}
        {sinAsignar > 0 && (
          <li className="flex flex-col gap-2 rounded-xl bg-proceso-suave p-3 text-proceso-texto">
            <span className="cifras flex justify-between">
              <span className="font-semibold">Sin asignar</span>
              <span>{pesos(sinAsignar)}</span>
            </span>
            {puedeCobrar && (
              <Boton
                variante="principal"
                disabled={ocupado}
                onClick={() =>
                  alCobrar({
                    cuentaId: null,
                    nombre: 'Sin asignar',
                    disponible: sinAsignar,
                    cuenta: null,
                    propinaInicial: null,
                  })
                }
              >
                {`Cobrar ${pesos(sinAsignar)}`}
              </Boton>
            )}
          </li>
        )}
      </ul>
      {puedeDeshacer && (
        <Boton variante="fantasma" disabled={ocupado} onClick={alDeshacer}>
          Deshacer la división
        </Boton>
      )}
    </>
  )
}

function Contador({
  nombre,
  valor,
  minimo,
  maximo,
  alCambiar,
}: {
  nombre: string
  valor: number
  minimo: number
  maximo: number
  alCambiar: (n: number) => void
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-linea bg-superficie p-3">
      <span className="flex-1 font-semibold">{nombre}</span>
      <Boton
        icono="menos"
        aria-label={`Quitar: quedan ${valor - 1}`}
        disabled={valor <= minimo}
        onClick={() => alCambiar(valor - 1)}
      />
      <span className="cifras w-8 text-center text-xl font-semibold">{valor}</span>
      <Boton
        icono="mas"
        aria-label={`Agregar: quedan ${valor + 1}`}
        disabled={valor >= maximo}
        onClick={() => alCambiar(valor + 1)}
      />
    </div>
  )
}

/** Anular un pago mal registrado: con motivo. La reversa cae en el turno abierto de esta caja. */
function PanelAnularPago({
  pagoId,
  ocupado,
  alCerrar,
  alAnular,
}: {
  pagoId: string | null
  ocupado: boolean
  alCerrar: () => void
  alAnular: (pagoId: string, motivo: string) => void
}) {
  const [motivo, setMotivo] = useState<string | null>(null)
  const [otro, setOtro] = useState('')
  const final = motivo === 'otro' ? otro.trim() || null : motivo
  return (
    <PanelLateral
      abierto={pagoId !== null}
      titulo="Anular el pago"
      alCerrar={alCerrar}
      pie={
        <Boton
          variante="peligro"
          grande
          className="w-full"
          disabled={!final || ocupado}
          onClick={() => pagoId && final && alAnular(pagoId, final)}
        >
          Anular el pago
        </Boton>
      }
    >
      <div className="flex flex-col gap-3">
        <p>El saldo vuelve a quedar por cobrar. Si fue en efectivo, devuelve el dinero.</p>
        <Grupo etiqueta="Motivo" className="flex flex-wrap gap-2">
          {MOTIVOS_ANULAR_PAGO.map((m) => (
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
            // biome-ignore lint/a11y/noAutofocus: se eligió «Otro» justo para escribirlo
            autoFocus
            onChange={(e) => setOtro(e.target.value)}
          />
        )}
      </div>
    </PanelLateral>
  )
}
