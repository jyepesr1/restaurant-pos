import type { OrderItem } from '@pos/core'
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

const message = (e: unknown) => (e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.')

/** Lo que pide un PIN: el error del último intento y la espera que manda el hub (ADR-008). */
interface EstadoPin {
  error: string | null
  intento: number
  esperaMs: number
}

const sinError: EstadoPin = { error: null, intento: 0, esperaMs: 0 }

/** El error de un intento, con la espera que pida el hub tras varios PIN errados. */
const fallo = (e: unknown, previous: EstadoPin): EstadoPin => ({
  error: message(e),
  intento: previous.intento + 1,
  esperaMs: e instanceof ErrorApi ? e.esperaMs : 0,
})

/**
 * El PIN de quien autoriza, en el mismo teclado de entrar: al cuarto dígito se envía solo. El
 * mesero le pasa el celular al cajero; el PIN no se ve ni se recuerda.
 */
function AutorizarConPin({
  ready,
  missing,
  enLinea,
  status,
  ocupado,
  alPin,
}: {
  ready: boolean
  /** Qué falta elegir antes del PIN. */
  missing: string
  enLinea: boolean
  status: EstadoPin
  ocupado: boolean
  alPin: (pin: string) => void
}) {
  if (!enLinea)
    return <p className="rounded-xl bg-alerta-suave p-3 text-alerta-texto">{SIN_CONEXION}</p>
  if (!ready) return <p className="text-texto-suave">{missing}</p>
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-linea bg-superficie-2/60 p-3">
      <p className="font-semibold">Pásale el celular al cajero o al administrador</p>
      <TecladoPin
        titulo={ocupado ? 'Comprobando el PIN…' : 'Que escriba su PIN para autorizar'}
        error={status.error}
        intento={status.intento}
        esperaMs={status.esperaMs}
        ocupado={ocupado}
        alCompletar={alPin}
      />
    </div>
  )
}

/** El motivo de una anulación: uno de la lista o uno escrito. */
function ElegirMotivo({
  reason,
  other,
  alElegir,
  alEscribir,
}: {
  reason: string | null
  other: string
  alElegir: (m: string) => void
  alEscribir: (t: string) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="font-semibold">Motivo</span>
      <Grupo etiqueta="Motivo" className="flex flex-wrap gap-2">
        {MOTIVOS_ANULACION.map((m) => (
          <Opcion key={m} elegida={reason === m} alElegir={() => alElegir(m)}>
            {m}
          </Opcion>
        ))}
        <Opcion elegida={reason === 'other'} alElegir={() => alElegir('other')}>
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
          onChange={(e) => alEscribir(e.target.value)}
        />
      )}
    </div>
  )
}

/** El motivo elegido en texto, o null si falta. */
const motivoFinal = (reason: string | null, other: string) =>
  reason === 'other' ? other.trim() || null : reason

/**
 * Anular lo que ya salió a cocina: cuántas unidades (una por defecto), por qué y si la cocina ya
 * lo hizo (cuenta como pérdida). Sin el permiso, autoriza el cajero con su PIN.
 */
export function PanelAnular({
  item,
  conPermiso,
  enLinea,
  alCerrar,
  onVoid,
}: {
  item: OrderItem
  conPermiso: boolean
  enLinea: boolean
  alCerrar: () => void
  onVoid: (d: {
    quantity: number
    reason: string
    alreadyPrepared: boolean
    pin: string | null
  }) => Promise<void>
}) {
  const netas = item.quantity - item.voidedQuantity
  const [quantity, setCantidad] = useState(1)
  const [reason, setMotivo] = useState<string | null>(null)
  const [other, setOtro] = useState('')
  const [alreadyPrepared, setYaPreparado] = useState(
    item.status === 'ready' || item.status === 'served',
  )
  const [pin, setPin] = useState(sinError)
  const [ocupado, setOcupado] = useState(false)
  const m = motivoFinal(reason, other)

  const voidItem = async (key: string | null) => {
    if (!m) return
    setOcupado(true)
    try {
      await onVoid({ quantity, reason: m, alreadyPrepared, pin: key })
    } catch (e) {
      setPin((p) => fallo(e, p))
      setOcupado(false)
    }
  }

  return (
    <PanelLateral
      opened
      titulo={`Anular ${item.name}`}
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
              variant="danger"
              large
              className="w-full"
              disabled={ocupado || !m}
              onClick={() => voidItem(null)}
            >
              {m ? `Anular ${quantity} ${item.name}` : 'Elige el motivo'}
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
                icono="minus"
                aria-label="Una menos"
                disabled={quantity <= 1}
                onClick={() => setCantidad((c) => Math.max(1, c - 1))}
              />
              <span className="cifras w-10 text-center text-xl font-bold">{quantity}</span>
              <Boton
                icono="more"
                aria-label="Una más"
                disabled={quantity >= netas}
                onClick={() => setCantidad((c) => Math.min(netas, c + 1))}
              />
              <span className="text-texto-suave">{`de ${netas}`}</span>
            </div>
          </div>
        )}
        <ElegirMotivo reason={reason} other={other} alElegir={setMotivo} alEscribir={setOtro} />
        <div className="flex flex-col gap-2">
          <span className="font-semibold">¿Ya lo hizo la cocina?</span>
          <Grupo etiqueta="Ya lo hizo la cocina" className="flex flex-wrap gap-2">
            <Opcion elegida={!alreadyPrepared} alElegir={() => setYaPreparado(false)}>
              No, todavía no
            </Opcion>
            <Opcion elegida={alreadyPrepared} alElegir={() => setYaPreparado(true)}>
              Sí, ya se hizo
            </Opcion>
          </Grupo>
          <span className="text-sm text-texto-suave">Lo que ya se hizo cuenta como pérdida.</span>
        </div>
        {!conPermiso && (
          <AutorizarConPin
            ready={!!m}
            missing="Elige el motivo y después pásale el celular al cajero para su PIN."
            enLinea={enLinea}
            status={pin}
            ocupado={ocupado}
            alPin={(key) => voidItem(key)}
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
  catalog,
  occupiedIds,
  excluir,
  elegidas,
  soloLibres,
  alElegir,
}: {
  catalog: Catalogo
  occupiedIds: Map<string, string>
  excluir: string[]
  elegidas: string[]
  soloLibres: boolean
  alElegir: (tableId: string) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      {catalog.zones.map((z) => {
        const tables = catalog.tables.filter((m) => m.zonaId === z.id && !excluir.includes(m.id))
        if (tables.length === 0) return null
        return (
          <Grupo key={z.id} etiqueta={z.name} className="flex flex-col gap-2">
            <span className="text-sm font-semibold text-texto-suave">{z.name}</span>
            <div className="flex flex-wrap gap-2">
              {tables.map((m) => {
                const ocupada = occupiedIds.get(m.id)
                const bloqueada = soloLibres && ocupada !== undefined && !elegidas.includes(m.id)
                return bloqueada ? (
                  <span
                    key={m.id}
                    className="inline-flex min-h-12 items-center rounded-full border-2 border-dashed border-borde px-4 text-texto-suave"
                  >
                    {`${m.name} · ${ocupada}`}
                  </span>
                ) : (
                  <Opcion
                    key={m.id}
                    elegida={elegidas.includes(m.id)}
                    alElegir={() => alElegir(m.id)}
                    etiqueta={`Mesa ${m.name}${ocupada ? `, ${ocupada}` : ', libre'}`}
                  >
                    {ocupada ? `${m.name} · ${ocupada}` : m.name}
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
  catalog,
  occupiedIds,
  current,
  alCerrar,
  onChange,
}: {
  enLinea: boolean
  catalog: Catalogo
  occupiedIds: Map<string, string>
  current: string[]
  alCerrar: () => void
  onChange: (tableId: string) => Promise<void>
}) {
  const [elegida, setElegida] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const name = catalog.tables.find((m) => m.id === elegida)?.name
  return (
    <PanelLateral
      opened
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
            variant="main"
            large
            className="w-full"
            disabled={!elegida || !enLinea}
            onClick={() => elegida && onChange(elegida).catch((e) => setError(message(e)))}
          >
            {!enLinea ? 'Sin conexión' : name ? `Pasar a la mesa ${name}` : 'Elige la mesa nueva'}
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
        catalog={catalog}
        occupiedIds={occupiedIds}
        excluir={current}
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
  catalog,
  occupiedIds,
  tableId,
  merged,
  alCerrar,
  onSave,
}: {
  enLinea: boolean
  catalog: Catalogo
  occupiedIds: Map<string, string>
  tableId: string
  merged: string[]
  alCerrar: () => void
  onSave: (add: string[], remove: string[]) => Promise<void>
}) {
  const [elegidas, setElegidas] = useState(merged)
  const [error, setError] = useState<string | null>(null)
  const add = elegidas.filter((m) => !merged.includes(m))
  const remove = merged.filter((m) => !elegidas.includes(m))
  const main = catalog.tables.find((m) => m.id === tableId)?.name
  return (
    <PanelLateral
      opened
      titulo={`Unir mesas con la mesa ${main ?? ''}`}
      alCerrar={alCerrar}
      pie={
        <div className="flex flex-col gap-2">
          {error && (
            <p role="alert" className="text-alerta-texto">
              {error}
            </p>
          )}
          <Boton
            variant="main"
            large
            className="w-full"
            disabled={(add.length === 0 && remove.length === 0) || !enLinea}
            onClick={() => onSave(add, remove).catch((e) => setError(message(e)))}
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
        catalog={catalog}
        occupiedIds={occupiedIds}
        excluir={[tableId]}
        elegidas={elegidas}
        soloLibres
        alElegir={(m) => setElegidas((e) => (e.includes(m) ? e.filter((x) => x !== m) : [...e, m]))}
      />
    </PanelLateral>
  )
}

/** Pasar productos de este pedido a otra mesa (alguien se cambió de mesa con lo suyo). */
export function PanelMover({
  order,
  catalog,
  occupiedIds,
  enLinea,
  alCerrar,
  alMover,
}: {
  order: PedidoVisible
  catalog: Catalogo
  occupiedIds: Map<string, string>
  enLinea: boolean
  alCerrar: () => void
  alMover: (itemIds: string[], tableId: string) => Promise<void>
}) {
  const items = Object.values(order.status.items)
    .filter((i) => i.status !== 'voided' && i.quantity > i.voidedQuantity)
    .sort((a, b) => a.position - b.position)
  const [ids, setIds] = useState<string[]>([])
  const [table, setMesa] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const people = [...new Set(items.map((i) => i.guest).filter((c) => c !== null))].sort(
    (a, b) => (a ?? 0) - (b ?? 0),
  )
  const name = catalog.tables.find((m) => m.id === table)?.name
  const move = () => {
    if (!enLinea) return setError('Mover productos pide conexión con la caja. Revisa el Wi-Fi.')
    if (ids.length === 0 || !table) return
    alMover(ids, table).catch((e) => setError(message(e)))
  }
  return (
    <PanelLateral
      opened
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
            variant="main"
            large
            className="w-full"
            disabled={ids.length === 0 || !table}
            onClick={move}
          >
            {ids.length === 0
              ? 'Elige qué mover'
              : !name
                ? 'Elige la mesa'
                : `Mover ${ids.length} a la mesa ${name}`}
          </Boton>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <span className="font-semibold">Qué se mueve</span>
          {people.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {people.map((c) => (
                <Boton
                  key={c}
                  onClick={() => setIds(items.filter((i) => i.guest === c).map((i) => i.id))}
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
                shape="card"
                elegida={ids.includes(i.id)}
                alElegir={() =>
                  setIds((x) => (x.includes(i.id) ? x.filter((y) => y !== i.id) : [...x, i.id]))
                }
                detalle={
                  [i.guest ? `P${i.guest}` : null, i.notes].filter(Boolean).join(' · ') || undefined
                }
              >
                {`${i.quantity - i.voidedQuantity} × ${i.name}`}
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
            catalog={catalog}
            occupiedIds={occupiedIds}
            excluir={
              order.status.tableId ? [order.status.tableId, ...order.status.mergedTables] : []
            }
            elegidas={table ? [table] : []}
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
  table,
  conPermiso,
  enLinea,
  enCocina,
  withPayments,
  alCerrar,
  alCancelar,
}: {
  /** «Mesa 5», para que el botón diga a qué pedido. */
  table: string
  conPermiso: boolean
  enLinea: boolean
  enCocina: number
  withPayments: boolean
  alCerrar: () => void
  alCancelar: (d: { reason: string; pin: string | null }) => Promise<void>
}) {
  const [reason, setMotivo] = useState<string | null>(null)
  const [other, setOtro] = useState('')
  const [pin, setPin] = useState(sinError)
  const [ocupado, setOcupado] = useState(false)
  const m = motivoFinal(reason, other)
  const cancel = async (key: string | null) => {
    if (!m) return
    setOcupado(true)
    try {
      await alCancelar({ reason: m, pin: key })
    } catch (e) {
      setPin((p) => fallo(e, p))
      setOcupado(false)
    }
  }
  return (
    <PanelLateral
      opened
      titulo={`Cancelar el pedido de la ${table.toLowerCase()}`}
      alCerrar={alCerrar}
      pie={
        <div className="flex flex-col gap-2">
          {conPermiso && pin.error && (
            <p role="alert" className="text-alerta-texto">
              {pin.error}
            </p>
          )}
          <div className="flex gap-2">
            <Boton large className="flex-1" onClick={alCerrar}>
              Volver
            </Boton>
            {conPermiso && (
              <Boton
                variant="danger"
                large
                className="flex-1"
                disabled={ocupado || !m || withPayments}
                onClick={() => cancel(null)}
              >
                {m ? 'Sí, cancelarlo' : 'Elige el motivo'}
              </Boton>
            )}
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {withPayments ? (
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
        {!withPayments && (
          <ElegirMotivo reason={reason} other={other} alElegir={setMotivo} alEscribir={setOtro} />
        )}
        {!conPermiso && !withPayments && (
          <AutorizarConPin
            ready={!!m}
            missing="Elige el motivo y después pásale el celular al cajero para su PIN."
            enLinea={enLinea}
            status={pin}
            ocupado={ocupado}
            alPin={(key) => cancel(key)}
          />
        )}
      </div>
    </PanelLateral>
  )
}

/** Lo que se puede hacer con el pedido entero (sin pedido todavía, solo unir mesas). */
export function PanelAccionesPedido({
  withTable,
  withOrder,
  alCerrar,
  alElegir,
}: {
  withTable: boolean
  withOrder: boolean
  alCerrar: () => void
  alElegir: (a: 'move' | 'table' | 'merge' | 'cancel') => void
}) {
  const options: {
    action: 'move' | 'table' | 'merge'
    icono: NombreIcono
    text: string
    detalle: string
  }[] = [
    ...(withTable && withOrder
      ? ([
          {
            action: 'table',
            icono: 'table',
            text: 'Cambiar de mesa',
            detalle: 'Todo el pedido pasa a otra mesa libre',
          },
        ] as const)
      : []),
    ...(withTable
      ? ([
          {
            action: 'merge',
            icono: 'people',
            text: 'Unir mesas',
            detalle: 'Un grupo grande ocupa varias mesas',
          },
        ] as const)
      : []),
    ...(withOrder
      ? ([
          {
            action: 'move',
            icono: 'seat',
            text: 'Mover productos',
            detalle: 'Pasar algunos a otra mesa',
          },
        ] as const)
      : []),
  ]
  const cssClass =
    'flex min-h-16 w-full items-center gap-3 rounded-xl border border-borde bg-superficie px-4 text-left focus-visible:outline-3 focus-visible:outline-foco'
  return (
    <PanelLateral opened titulo="Mesa y pedido" alCerrar={alCerrar}>
      <ul className="flex flex-col gap-2">
        {options.map((o) => (
          <li key={o.action}>
            <button type="button" onClick={() => alElegir(o.action)} className={cssClass}>
              <Icono name={o.icono} className="size-6 shrink-0" />
              <span className="flex flex-col">
                <span className="font-semibold">{o.text}</span>
                <span className="text-sm text-texto-suave">{o.detalle}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {withOrder && (
        // Lejos de lo demás: es lo único que no tiene vuelta atrás.
        <div className="mt-8 border-t border-linea pt-4">
          <button
            type="button"
            onClick={() => alElegir('cancel')}
            className={`${cssClass} border-alerta-fuerte/50 text-alerta-texto`}
          >
            <Icono name="erase" className="size-6 shrink-0" />
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
