import type { ItemPedido } from '@pos/core'
import type { Catalogo } from '@pos/sync'
import { useState } from 'react'
import { Boton } from '../ui/Boton'
import { Icono, type NombreIcono } from '../ui/iconos'
import { Grupo, Opcion } from '../ui/Opciones'
import { PanelLateral } from '../ui/PanelLateral'
import { TecladoPin } from '../ui/TecladoPin'
import { ErrorApi } from './api'
import { claseCampo } from './Entrar'
import { MOTIVOS_ANULACION } from './pedido'
import type { PedidoVisible } from './proyeccion'

// Lo que se hace con un pedido ya tomado (tarea 1.5): anular lo enviado, cancelar el pedido,
// pasar productos a otra mesa, cambiar de mesa y unir mesas para un grupo grande. Lo que pide
// permiso que el mesero no tiene lo autoriza el cajero con su PIN en el mismo celular (ADR-008).

const SIN_CONEXION =
  'Hace falta conexión con la caja: el PIN se comprueba allá. Revisa el Wi-Fi e intenta de nuevo.'

const SIN_RED_MESAS =
  'Sin conexión con la caja: para cambiar o unir mesas hay que ver qué mesas están libres de verdad. Revisa el Wi-Fi.'

const mensaje = (e: unknown) => (e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.')

/** Lo que pide un PIN: el error del último intento y la espera que manda el hub (ADR-008). */
interface EstadoPin {
  error: string | null
  intento: number
  esperaMs: number
}

const sinError: EstadoPin = { error: null, intento: 0, esperaMs: 0 }

/** El error de un intento, con la espera que pida el hub tras varios PIN errados. */
const fallo = (e: unknown, previo: EstadoPin): EstadoPin => ({
  error: mensaje(e),
  intento: previo.intento + 1,
  esperaMs: e instanceof ErrorApi ? e.esperaMs : 0,
})

/**
 * El PIN de quien autoriza, en el mismo teclado de entrar: al cuarto dígito se envía solo. El
 * mesero le pasa el celular al cajero; el PIN no se ve ni se recuerda.
 */
function AutorizarConPin({
  listo,
  falta,
  enLinea,
  estado,
  ocupado,
  alPin,
}: {
  listo: boolean
  /** Qué falta elegir antes del PIN. */
  falta: string
  enLinea: boolean
  estado: EstadoPin
  ocupado: boolean
  alPin: (pin: string) => void
}) {
  if (!enLinea)
    return <p className="rounded-xl bg-alerta-suave p-3 text-alerta-texto">{SIN_CONEXION}</p>
  if (!listo) return <p className="text-texto-suave">{falta}</p>
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-linea bg-superficie-2/60 p-3">
      <p className="font-semibold">Pásale el celular al cajero o al administrador</p>
      <TecladoPin
        titulo={ocupado ? 'Comprobando el PIN…' : 'Que escriba su PIN para autorizar'}
        error={estado.error}
        intento={estado.intento}
        esperaMs={estado.esperaMs}
        ocupado={ocupado}
        alCompletar={alPin}
      />
    </div>
  )
}

/** El motivo de una anulación: uno de la lista o uno escrito. */
function ElegirMotivo({
  motivo,
  otro,
  alElegir,
  alEscribir,
}: {
  motivo: string | null
  otro: string
  alElegir: (m: string) => void
  alEscribir: (t: string) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="font-semibold">Motivo</span>
      <Grupo etiqueta="Motivo" className="flex flex-wrap gap-2">
        {MOTIVOS_ANULACION.map((m) => (
          <Opcion key={m} elegida={motivo === m} alElegir={() => alElegir(m)}>
            {m}
          </Opcion>
        ))}
        <Opcion elegida={motivo === 'otro'} alElegir={() => alElegir('otro')}>
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
          onChange={(e) => alEscribir(e.target.value)}
        />
      )}
    </div>
  )
}

/** El motivo elegido en texto, o null si falta. */
const motivoFinal = (motivo: string | null, otro: string) =>
  motivo === 'otro' ? otro.trim() || null : motivo

/**
 * Anular lo que ya salió a cocina: cuántas unidades (una por defecto), por qué y si la cocina ya
 * lo hizo (cuenta como pérdida). Sin el permiso, autoriza el cajero con su PIN.
 */
export function PanelAnular({
  item,
  conPermiso,
  enLinea,
  alCerrar,
  alAnular,
}: {
  item: ItemPedido
  conPermiso: boolean
  enLinea: boolean
  alCerrar: () => void
  alAnular: (d: {
    cantidad: number
    motivo: string
    yaPreparado: boolean
    pin: string | null
  }) => Promise<void>
}) {
  const netas = item.cantidad - item.cantidadAnulada
  const [cantidad, setCantidad] = useState(1)
  const [motivo, setMotivo] = useState<string | null>(null)
  const [otro, setOtro] = useState('')
  const [yaPreparado, setYaPreparado] = useState(
    item.estado === 'listo' || item.estado === 'entregado',
  )
  const [pin, setPin] = useState(sinError)
  const [ocupado, setOcupado] = useState(false)
  const m = motivoFinal(motivo, otro)

  const anular = async (clave: string | null) => {
    if (!m) return
    setOcupado(true)
    try {
      await alAnular({ cantidad, motivo: m, yaPreparado, pin: clave })
    } catch (e) {
      setPin((p) => fallo(e, p))
      setOcupado(false)
    }
  }

  return (
    <PanelLateral
      abierto
      titulo={`Anular ${item.nombre}`}
      alCerrar={alCerrar}
      pie={
        conPermiso ? (
          <div className="flex flex-col gap-2">
            {pin.error && (
              <p role="alert" className="text-alerta-texto">
                {pin.error}
              </p>
            )}
            <Boton
              variante="peligro"
              grande
              className="w-full"
              disabled={ocupado || !m}
              onClick={() => anular(null)}
            >
              {m ? `Anular ${cantidad} ${item.nombre}` : 'Elige el motivo'}
            </Boton>
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-5">
        {netas > 1 && (
          <div className="flex flex-col gap-2">
            <span className="font-semibold">Cuántas</span>
            <div className="flex items-center gap-3">
              <Boton
                icono="menos"
                aria-label="Una menos"
                disabled={cantidad <= 1}
                onClick={() => setCantidad((c) => Math.max(1, c - 1))}
              />
              <span className="cifras w-10 text-center text-xl font-bold">{cantidad}</span>
              <Boton
                icono="mas"
                aria-label="Una más"
                disabled={cantidad >= netas}
                onClick={() => setCantidad((c) => Math.min(netas, c + 1))}
              />
              <span className="text-texto-suave">{`de ${netas}`}</span>
            </div>
          </div>
        )}
        <ElegirMotivo motivo={motivo} otro={otro} alElegir={setMotivo} alEscribir={setOtro} />
        <div className="flex flex-col gap-2">
          <span className="font-semibold">¿Ya lo hizo la cocina?</span>
          <Grupo etiqueta="Ya lo hizo la cocina" className="flex flex-wrap gap-2">
            <Opcion elegida={!yaPreparado} alElegir={() => setYaPreparado(false)}>
              No, todavía no
            </Opcion>
            <Opcion elegida={yaPreparado} alElegir={() => setYaPreparado(true)}>
              Sí, ya se hizo
            </Opcion>
          </Grupo>
          <span className="text-sm text-texto-suave">Lo que ya se hizo cuenta como pérdida.</span>
        </div>
        {!conPermiso && (
          <AutorizarConPin
            listo={!!m}
            falta="Elige el motivo y después pásale el celular al cajero para su PIN."
            enLinea={enLinea}
            estado={pin}
            ocupado={ocupado}
            alPin={(clave) => anular(clave)}
          />
        )}
        <p className="text-sm text-texto-suave">
          Si la cocina todavía no lo había entregado, recibe una comanda «ANULAR».
        </p>
      </div>
    </PanelLateral>
  )
}

/** Las mesas para elegir, por zona. `ocupadas`: mesa → texto de quién la tiene. */
function ElegirMesa({
  catalogo,
  ocupadas,
  excluir,
  elegidas,
  soloLibres,
  alElegir,
}: {
  catalogo: Catalogo
  ocupadas: Map<string, string>
  excluir: string[]
  elegidas: string[]
  soloLibres: boolean
  alElegir: (mesaId: string) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      {catalogo.zonas.map((z) => {
        const mesas = catalogo.mesas.filter((m) => m.zonaId === z.id && !excluir.includes(m.id))
        if (mesas.length === 0) return null
        return (
          <Grupo key={z.id} etiqueta={z.nombre} className="flex flex-col gap-2">
            <span className="text-sm font-semibold text-texto-suave">{z.nombre}</span>
            <div className="flex flex-wrap gap-2">
              {mesas.map((m) => {
                const ocupada = ocupadas.get(m.id)
                const bloqueada = soloLibres && ocupada !== undefined && !elegidas.includes(m.id)
                return bloqueada ? (
                  <span
                    key={m.id}
                    className="inline-flex min-h-12 items-center rounded-full border-2 border-dashed border-borde px-4 text-texto-suave"
                  >
                    {`${m.nombre} · ${ocupada}`}
                  </span>
                ) : (
                  <Opcion
                    key={m.id}
                    elegida={elegidas.includes(m.id)}
                    alElegir={() => alElegir(m.id)}
                    etiqueta={`Mesa ${m.nombre}${ocupada ? `, ${ocupada}` : ', libre'}`}
                  >
                    {ocupada ? `${m.nombre} · ${ocupada}` : m.nombre}
                  </Opcion>
                )
              })}
            </div>
          </Grupo>
        )
      })}
    </div>
  )
}

/** Pasar la cuenta entera a otra mesa libre (el grupo se cambió de lugar). */
export function PanelCambiarMesa({
  enLinea,
  catalogo,
  ocupadas,
  actual,
  alCerrar,
  alCambiar,
}: {
  enLinea: boolean
  catalogo: Catalogo
  ocupadas: Map<string, string>
  actual: string[]
  alCerrar: () => void
  alCambiar: (mesaId: string) => Promise<void>
}) {
  const [elegida, setElegida] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const nombre = catalogo.mesas.find((m) => m.id === elegida)?.nombre
  return (
    <PanelLateral
      abierto
      titulo="Cambiar de mesa"
      alCerrar={alCerrar}
      pie={
        <div className="flex flex-col gap-2">
          {error && (
            <p role="alert" className="text-alerta-texto">
              {error}
            </p>
          )}
          <Boton
            variante="principal"
            grande
            className="w-full"
            disabled={!elegida || !enLinea}
            onClick={() => elegida && alCambiar(elegida).catch((e) => setError(mensaje(e)))}
          >
            {!enLinea
              ? 'Sin conexión'
              : nombre
                ? `Pasar a la mesa ${nombre}`
                : 'Elige la mesa nueva'}
          </Boton>
        </div>
      }
    >
      {!enLinea && (
        <p className="mb-4 rounded-xl bg-alerta-suave p-3 text-alerta-texto">{SIN_RED_MESAS}</p>
      )}
      <p className="mb-4 text-texto-suave">
        Todo el pedido pasa a la mesa nueva. Si la cocina ya tiene algo, le llega «CAMBIO DE MESA».
      </p>
      <ElegirMesa
        catalogo={catalogo}
        ocupadas={ocupadas}
        excluir={actual}
        elegidas={elegida ? [elegida] : []}
        soloLibres
        alElegir={setElegida}
      />
    </PanelLateral>
  )
}

/** Juntar mesas libres a la de este pedido para un grupo grande, o soltarlas. */
export function PanelUnirMesas({
  enLinea,
  catalogo,
  ocupadas,
  mesaId,
  unidas,
  alCerrar,
  alGuardar,
}: {
  enLinea: boolean
  catalogo: Catalogo
  ocupadas: Map<string, string>
  mesaId: string
  unidas: string[]
  alCerrar: () => void
  alGuardar: (agregar: string[], quitar: string[]) => Promise<void>
}) {
  const [elegidas, setElegidas] = useState(unidas)
  const [error, setError] = useState<string | null>(null)
  const agregar = elegidas.filter((m) => !unidas.includes(m))
  const quitar = unidas.filter((m) => !elegidas.includes(m))
  const principal = catalogo.mesas.find((m) => m.id === mesaId)?.nombre
  return (
    <PanelLateral
      abierto
      titulo={`Unir mesas con la mesa ${principal ?? ''}`}
      alCerrar={alCerrar}
      pie={
        <div className="flex flex-col gap-2">
          {error && (
            <p role="alert" className="text-alerta-texto">
              {error}
            </p>
          )}
          <Boton
            variante="principal"
            grande
            className="w-full"
            disabled={(agregar.length === 0 && quitar.length === 0) || !enLinea}
            onClick={() => alGuardar(agregar, quitar).catch((e) => setError(mensaje(e)))}
          >
            Guardar
          </Boton>
        </div>
      }
    >
      {!enLinea && (
        <p className="mb-4 rounded-xl bg-alerta-suave p-3 text-alerta-texto">{SIN_RED_MESAS}</p>
      )}
      <p className="mb-4 text-texto-suave">
        Para un grupo grande: las mesas que elijas quedan ocupadas con este mismo pedido y en el
        plano se ven unidas. Toca una unida para soltarla.
      </p>
      <ElegirMesa
        catalogo={catalogo}
        ocupadas={ocupadas}
        excluir={[mesaId]}
        elegidas={elegidas}
        soloLibres
        alElegir={(m) => setElegidas((e) => (e.includes(m) ? e.filter((x) => x !== m) : [...e, m]))}
      />
    </PanelLateral>
  )
}

/** Pasar productos de este pedido a otra mesa (alguien se cambió de mesa con lo suyo). */
export function PanelMover({
  pedido,
  catalogo,
  ocupadas,
  enLinea,
  alCerrar,
  alMover,
}: {
  pedido: PedidoVisible
  catalogo: Catalogo
  ocupadas: Map<string, string>
  enLinea: boolean
  alCerrar: () => void
  alMover: (itemIds: string[], mesaId: string) => Promise<void>
}) {
  const items = Object.values(pedido.estado.items)
    .filter((i) => i.estado !== 'anulado' && i.cantidad > i.cantidadAnulada)
    .sort((a, b) => a.orden - b.orden)
  const [ids, setIds] = useState<string[]>([])
  const [mesa, setMesa] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const personas = [...new Set(items.map((i) => i.comensal).filter((c) => c !== null))].sort(
    (a, b) => (a ?? 0) - (b ?? 0),
  )
  const nombre = catalogo.mesas.find((m) => m.id === mesa)?.nombre
  const mover = () => {
    if (!enLinea) return setError('Mover productos pide conexión con la caja. Revisa el Wi-Fi.')
    if (ids.length === 0 || !mesa) return
    alMover(ids, mesa).catch((e) => setError(mensaje(e)))
  }
  return (
    <PanelLateral
      abierto
      titulo="Mover productos"
      alCerrar={alCerrar}
      pie={
        <div className="flex flex-col gap-2">
          {error && (
            <p role="alert" className="text-alerta-texto">
              {error}
            </p>
          )}
          <Boton
            variante="principal"
            grande
            className="w-full"
            disabled={ids.length === 0 || !mesa}
            onClick={mover}
          >
            {ids.length === 0
              ? 'Elige qué mover'
              : !nombre
                ? 'Elige la mesa'
                : `Mover ${ids.length} a la mesa ${nombre}`}
          </Boton>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <span className="font-semibold">Qué se mueve</span>
          {personas.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {personas.map((c) => (
                <Boton
                  key={c}
                  onClick={() => setIds(items.filter((i) => i.comensal === c).map((i) => i.id))}
                >
                  {`Todo de P${c}`}
                </Boton>
              ))}
            </div>
          )}
          <Grupo etiqueta="Productos" className="flex flex-col gap-2">
            {items.map((i) => (
              <Opcion
                key={i.id}
                forma="tarjeta"
                elegida={ids.includes(i.id)}
                alElegir={() =>
                  setIds((x) => (x.includes(i.id) ? x.filter((y) => y !== i.id) : [...x, i.id]))
                }
                detalle={
                  [i.comensal ? `P${i.comensal}` : null, i.notas].filter(Boolean).join(' · ') ||
                  undefined
                }
              >
                {`${i.cantidad - i.cantidadAnulada} × ${i.nombre}`}
              </Opcion>
            ))}
          </Grupo>
        </div>
        <div className="flex flex-col gap-2">
          <span className="font-semibold">A qué mesa</span>
          <span className="text-sm text-texto-suave">
            Si la mesa ya tiene pedido, se suman a ese; si está libre, se abre uno.
          </span>
          <ElegirMesa
            catalogo={catalogo}
            ocupadas={ocupadas}
            excluir={
              pedido.estado.mesaId ? [pedido.estado.mesaId, ...pedido.estado.mesasUnidas] : []
            }
            elegidas={mesa ? [mesa] : []}
            soloLibres={false}
            alElegir={setMesa}
          />
        </div>
      </div>
    </PanelLateral>
  )
}

/** Cancelar el pedido entero: motivo y, sin el permiso, el PIN de quien autoriza. */
export function PanelCancelar({
  mesa,
  conPermiso,
  enLinea,
  enCocina,
  conPagos,
  alCerrar,
  alCancelar,
}: {
  /** «Mesa 5», para que el botón diga a qué pedido. */
  mesa: string
  conPermiso: boolean
  enLinea: boolean
  enCocina: number
  conPagos: boolean
  alCerrar: () => void
  alCancelar: (d: { motivo: string; pin: string | null }) => Promise<void>
}) {
  const [motivo, setMotivo] = useState<string | null>(null)
  const [otro, setOtro] = useState('')
  const [pin, setPin] = useState(sinError)
  const [ocupado, setOcupado] = useState(false)
  const m = motivoFinal(motivo, otro)
  const cancelar = async (clave: string | null) => {
    if (!m) return
    setOcupado(true)
    try {
      await alCancelar({ motivo: m, pin: clave })
    } catch (e) {
      setPin((p) => fallo(e, p))
      setOcupado(false)
    }
  }
  return (
    <PanelLateral
      abierto
      titulo={`Cancelar el pedido de la ${mesa.toLowerCase()}`}
      alCerrar={alCerrar}
      pie={
        <div className="flex flex-col gap-2">
          {conPermiso && pin.error && (
            <p role="alert" className="text-alerta-texto">
              {pin.error}
            </p>
          )}
          <div className="flex gap-2">
            <Boton grande className="flex-1" onClick={alCerrar}>
              Volver
            </Boton>
            {conPermiso && (
              <Boton
                variante="peligro"
                grande
                className="flex-1"
                disabled={ocupado || !m || conPagos}
                onClick={() => cancelar(null)}
              >
                {m ? 'Sí, cancelarlo' : 'Elige el motivo'}
              </Boton>
            )}
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {conPagos ? (
          <p className="rounded-xl bg-alerta-suave p-3 text-alerta-texto">
            Este pedido ya tiene pagos: primero hay que anularlos en caja.
          </p>
        ) : (
          <p className="rounded-xl bg-alerta-suave p-3 text-alerta-texto">
            {enCocina > 0
              ? `Se quita todo el pedido y la cocina recibe «ANULAR» de lo que tenía (${enCocina}). La mesa queda libre.`
              : 'Se quita todo el pedido y la mesa queda libre.'}
          </p>
        )}
        {!conPagos && (
          <ElegirMotivo motivo={motivo} otro={otro} alElegir={setMotivo} alEscribir={setOtro} />
        )}
        {!conPermiso && !conPagos && (
          <AutorizarConPin
            listo={!!m}
            falta="Elige el motivo y después pásale el celular al cajero para su PIN."
            enLinea={enLinea}
            estado={pin}
            ocupado={ocupado}
            alPin={(clave) => cancelar(clave)}
          />
        )}
      </div>
    </PanelLateral>
  )
}

/** Lo que se puede hacer con el pedido entero (sin pedido todavía, solo unir mesas). */
export function PanelAccionesPedido({
  conMesa,
  conPedido,
  alCerrar,
  alElegir,
}: {
  conMesa: boolean
  conPedido: boolean
  alCerrar: () => void
  alElegir: (a: 'mover' | 'mesa' | 'unir' | 'cancelar') => void
}) {
  const opciones: {
    accion: 'mover' | 'mesa' | 'unir'
    icono: NombreIcono
    texto: string
    detalle: string
  }[] = [
    ...(conMesa && conPedido
      ? ([
          {
            accion: 'mesa',
            icono: 'mesa',
            texto: 'Cambiar de mesa',
            detalle: 'Todo el pedido pasa a otra mesa libre',
          },
        ] as const)
      : []),
    ...(conMesa
      ? ([
          {
            accion: 'unir',
            icono: 'personas',
            texto: 'Unir mesas',
            detalle: 'Un grupo grande ocupa varias mesas',
          },
        ] as const)
      : []),
    ...(conPedido
      ? ([
          {
            accion: 'mover',
            icono: 'silla',
            texto: 'Mover productos',
            detalle: 'Pasar algunos a otra mesa',
          },
        ] as const)
      : []),
  ]
  const clase =
    'flex min-h-16 w-full items-center gap-3 rounded-xl border border-borde bg-superficie px-4 text-left focus-visible:outline-3 focus-visible:outline-foco'
  return (
    <PanelLateral abierto titulo="Mesa y pedido" alCerrar={alCerrar}>
      <ul className="flex flex-col gap-2">
        {opciones.map((o) => (
          <li key={o.accion}>
            <button type="button" onClick={() => alElegir(o.accion)} className={clase}>
              <Icono nombre={o.icono} className="size-6 shrink-0" />
              <span className="flex flex-col">
                <span className="font-semibold">{o.texto}</span>
                <span className="text-sm text-texto-suave">{o.detalle}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {conPedido && (
        // Lejos de lo demás: es lo único que no tiene vuelta atrás.
        <div className="mt-8 border-t border-linea pt-4">
          <button
            type="button"
            onClick={() => alElegir('cancelar')}
            className={`${clase} border-alerta-fuerte/50 text-alerta-texto`}
          >
            <Icono nombre="borrar" className="size-6 shrink-0" />
            <span className="flex flex-col">
              <span className="font-semibold">Cancelar el pedido</span>
              <span className="text-sm">Quita todo el pedido de la mesa, con motivo</span>
            </span>
          </button>
        </div>
      )}
    </PanelLateral>
  )
}
