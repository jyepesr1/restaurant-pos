import type { OrderItem } from '@pos/core'
import type { Catalog } from '@pos/sync'
import { useState } from 'react'
import { Button } from '../ui/Button'
import { Icon, type IconName } from '../ui/icons'
import { Group, Option } from '../ui/Options'
import { PinPad } from '../ui/PinPad'
import { SidePanel } from '../ui/SidePanel'
import { ApiError } from './api'
import { VOID_REASONS } from './order'
import type { VisibleOrder } from './projection'
import { fieldClass } from './SignIn'

// What is done with an order already taken (task 1.5): void what was sent, cancel the order,
// move products to another table, change tables and merge tables for a large group. Whatever
// needs a permission the waiter lacks is authorized by the cashier with their PIN on the same
// phone (ADR-008).

const NO_CONNECTION =
  'Hace falta conexión con la caja: el PIN se comprueba allá. Revisa el Wi-Fi e intenta de nuevo.'

const NO_NETWORK_TABLES =
  'Sin conexión con la caja: para cambiar o unir mesas hay que ver qué mesas están libres de verdad. Revisa el Wi-Fi.'

const message = (e: unknown) => (e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.')

/** What a PIN request holds: the last attempt's error and the wait the hub imposes (ADR-008). */
interface PinState {
  error: string | null
  attempt: number
  waitMs: number
}

const noError: PinState = { error: null, attempt: 0, waitMs: 0 }

/** The error of an attempt, with the wait the hub may impose after several wrong PINs. */
const failure = (e: unknown, previous: PinState): PinState => ({
  error: message(e),
  attempt: previous.attempt + 1,
  waitMs: e instanceof ApiError ? e.waitMs : 0,
})

/**
 * The PIN of whoever authorizes, on the same sign-in keypad: on the fourth digit it is sent by
 * itself. The waiter hands the phone to the cashier; the PIN is not shown or remembered.
 */
function AuthorizeWithPin({
  ready,
  missing,
  online,
  status,
  taken,
  onPin,
}: {
  ready: boolean
  /** What is left to choose before the PIN. */
  missing: string
  online: boolean
  status: PinState
  taken: boolean
  onPin: (pin: string) => void
}) {
  if (!online)
    return <p className="rounded-xl bg-alert-soft p-3 text-alert-text">{NO_CONNECTION}</p>
  if (!ready) return <p className="text-muted">{missing}</p>
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-divider bg-surface-2/60 p-3">
      <p className="font-semibold">Pásale el celular al cajero o al administrador</p>
      <PinPad
        title={taken ? 'Comprobando el PIN…' : 'Que escriba su PIN para autorizar'}
        error={status.error}
        attempt={status.attempt}
        waitMs={status.waitMs}
        taken={taken}
        onComplete={onPin}
      />
    </div>
  )
}

/** The reason for a void: one from the list or a typed one. */
function SelectReason({
  reason,
  other,
  onChoose,
  onType,
}: {
  reason: string | null
  other: string
  onChoose: (m: string) => void
  onType: (t: string) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="font-semibold">Motivo</span>
      <Group label="Motivo" className="flex flex-wrap gap-2">
        {VOID_REASONS.map((m) => (
          <Option key={m} selected={reason === m} onChoose={() => onChoose(m)}>
            {m}
          </Option>
        ))}
        <Option selected={reason === 'other'} onChoose={() => onChoose('other')}>
          Otro
        </Option>
      </Group>
      {reason === 'other' && (
        <input
          className={fieldClass}
          maxLength={200}
          value={other}
          placeholder="Escribe el motivo"
          // biome-ignore lint/a11y/noAutofocus: «Otro» was chosen precisely to type it
          autoFocus
          onChange={(e) => onType(e.target.value)}
        />
      )}
    </div>
  )
}

/** The chosen reason as text, or null if missing. */
const finalReason = (reason: string | null, other: string) =>
  reason === 'other' ? other.trim() || null : reason

/**
 * Void what already went out to the kitchen: how many units (one by default), why and whether the
 * kitchen already made it (counts as waste). Without the permission, the cashier authorizes with
 * their PIN.
 */
export function VoidPanel({
  item,
  withPermission,
  online,
  onClose,
  onVoid,
}: {
  item: OrderItem
  withPermission: boolean
  online: boolean
  onClose: () => void
  onVoid: (d: {
    quantity: number
    reason: string
    alreadyPrepared: boolean
    pin: string | null
  }) => Promise<void>
}) {
  const netQuantity = item.quantity - item.voidedQuantity
  const [quantity, setQuantity] = useState(1)
  const [reason, setReason] = useState<string | null>(null)
  const [other, setOther] = useState('')
  const [alreadyPrepared, setAlreadyPrepared] = useState(
    item.status === 'ready' || item.status === 'served',
  )
  const [pin, setPin] = useState(noError)
  const [taken, setTaken] = useState(false)
  const m = finalReason(reason, other)

  const voidItem = async (key: string | null) => {
    if (!m) return
    setTaken(true)
    try {
      await onVoid({ quantity, reason: m, alreadyPrepared, pin: key })
    } catch (e) {
      setPin((p) => failure(e, p))
      setTaken(false)
    }
  }

  return (
    <SidePanel
      opened
      title={`Anular ${item.name}`}
      onClose={onClose}
      footer={
        withPermission ? (
          <div className="flex flex-col gap-2">
            {pin.error && (
              <p role="alert" className="text-alert-text">
                {pin.error}
              </p>
            )}
            <Button
              variant="danger"
              large
              className="w-full"
              disabled={taken || !m}
              onClick={() => voidItem(null)}
            >
              {m ? `Anular ${quantity} ${item.name}` : 'Elige el motivo'}
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-5">
        {netQuantity > 1 && (
          <div className="flex flex-col gap-2">
            <span className="font-semibold">Cuántas</span>
            <div className="flex items-center gap-3">
              <Button
                icon="minus"
                aria-label="Una menos"
                disabled={quantity <= 1}
                onClick={() => setQuantity((c) => Math.max(1, c - 1))}
              />
              <span className="figures w-10 text-center text-xl font-bold">{quantity}</span>
              <Button
                icon="more"
                aria-label="Una más"
                disabled={quantity >= netQuantity}
                onClick={() => setQuantity((c) => Math.min(netQuantity, c + 1))}
              />
              <span className="text-muted">{`de ${netQuantity}`}</span>
            </div>
          </div>
        )}
        <SelectReason reason={reason} other={other} onChoose={setReason} onType={setOther} />
        <div className="flex flex-col gap-2">
          <span className="font-semibold">¿Ya lo hizo la cocina?</span>
          <Group label="Ya lo hizo la cocina" className="flex flex-wrap gap-2">
            <Option selected={!alreadyPrepared} onChoose={() => setAlreadyPrepared(false)}>
              No, todavía no
            </Option>
            <Option selected={alreadyPrepared} onChoose={() => setAlreadyPrepared(true)}>
              Sí, ya se hizo
            </Option>
          </Group>
          <span className="text-sm text-muted">Lo que ya se hizo cuenta como pérdida.</span>
        </div>
        {!withPermission && (
          <AuthorizeWithPin
            ready={!!m}
            missing="Elige el motivo y después pásale el celular al cajero para su PIN."
            online={online}
            status={pin}
            taken={taken}
            onPin={(key) => voidItem(key)}
          />
        )}
        <p className="text-sm text-muted">
          Si la cocina todavía no lo había entregado, recibe una comanda «ANULAR».
        </p>
      </div>
    </SidePanel>
  )
}

/** The tables to choose from, by zone. `occupiedIds`: table → text of who has it. */
function SelectTable({
  catalog,
  occupiedIds,
  exclude,
  selectedIds,
  onlyFree,
  onChoose,
}: {
  catalog: Catalog
  occupiedIds: Map<string, string>
  exclude: string[]
  selectedIds: string[]
  onlyFree: boolean
  onChoose: (tableId: string) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      {catalog.zones.map((z) => {
        const tables = catalog.tables.filter((m) => m.zoneId === z.id && !exclude.includes(m.id))
        if (tables.length === 0) return null
        return (
          <Group key={z.id} label={z.name} className="flex flex-col gap-2">
            <span className="text-sm font-semibold text-muted">{z.name}</span>
            <div className="flex flex-wrap gap-2">
              {tables.map((m) => {
                const takenPath = occupiedIds.get(m.id)
                const locked = onlyFree && takenPath !== undefined && !selectedIds.includes(m.id)
                return locked ? (
                  <span
                    key={m.id}
                    className="inline-flex min-h-12 items-center rounded-full border-2 border-dashed border-border px-4 text-muted"
                  >
                    {`${m.name} · ${takenPath}`}
                  </span>
                ) : (
                  <Option
                    key={m.id}
                    selected={selectedIds.includes(m.id)}
                    onChoose={() => onChoose(m.id)}
                    label={`Mesa ${m.name}${takenPath ? `, ${takenPath}` : ', libre'}`}
                  >
                    {takenPath ? `${m.name} · ${takenPath}` : m.name}
                  </Option>
                )
              })}
            </div>
          </Group>
        )
      })}
    </div>
  )
}

/** Move the whole check to another free table (the group changed places). */
export function ChangeTablePanel({
  online,
  catalog,
  occupiedIds,
  current,
  onClose,
  onChange,
}: {
  online: boolean
  catalog: Catalog
  occupiedIds: Map<string, string>
  current: string[]
  onClose: () => void
  onChange: (tableId: string) => Promise<void>
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const name = catalog.tables.find((m) => m.id === selected)?.name
  return (
    <SidePanel
      opened
      title="Cambiar de mesa"
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-2">
          {error && (
            <p role="alert" className="text-alert-text">
              {error}
            </p>
          )}
          <Button
            variant="main"
            large
            className="w-full"
            disabled={!selected || !online}
            onClick={() => selected && onChange(selected).catch((e) => setError(message(e)))}
          >
            {!online ? 'Sin conexión' : name ? `Pasar a la mesa ${name}` : 'Elige la mesa nueva'}
          </Button>
        </div>
      }
    >
      {!online && (
        <p className="mb-4 rounded-xl bg-alert-soft p-3 text-alert-text">{NO_NETWORK_TABLES}</p>
      )}
      <p className="mb-4 text-muted">
        Todo el pedido pasa a la mesa nueva. Si la cocina ya tiene algo, le llega «CAMBIO DE MESA».
      </p>
      <SelectTable
        catalog={catalog}
        occupiedIds={occupiedIds}
        exclude={current}
        selectedIds={selected ? [selected] : []}
        onlyFree
        onChoose={setSelected}
      />
    </SidePanel>
  )
}

/** Join free tables to this order's table for a large group, or release them. */
export function MergeTablesPanel({
  online,
  catalog,
  occupiedIds,
  tableId,
  merged,
  onClose,
  onSave,
}: {
  online: boolean
  catalog: Catalog
  occupiedIds: Map<string, string>
  tableId: string
  merged: string[]
  onClose: () => void
  onSave: (add: string[], remove: string[]) => Promise<void>
}) {
  const [selectedIds, setSelectedIds] = useState(merged)
  const [error, setError] = useState<string | null>(null)
  const add = selectedIds.filter((m) => !merged.includes(m))
  const remove = merged.filter((m) => !selectedIds.includes(m))
  const main = catalog.tables.find((m) => m.id === tableId)?.name
  return (
    <SidePanel
      opened
      title={`Unir mesas con la mesa ${main ?? ''}`}
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-2">
          {error && (
            <p role="alert" className="text-alert-text">
              {error}
            </p>
          )}
          <Button
            variant="main"
            large
            className="w-full"
            disabled={(add.length === 0 && remove.length === 0) || !online}
            onClick={() => onSave(add, remove).catch((e) => setError(message(e)))}
          >
            Guardar
          </Button>
        </div>
      }
    >
      {!online && (
        <p className="mb-4 rounded-xl bg-alert-soft p-3 text-alert-text">{NO_NETWORK_TABLES}</p>
      )}
      <p className="mb-4 text-muted">
        Para un grupo grande: las mesas que elijas quedan ocupadas con este mismo pedido y en el
        plano se ven unidas. Toca una unida para soltarla.
      </p>
      <SelectTable
        catalog={catalog}
        occupiedIds={occupiedIds}
        exclude={[tableId]}
        selectedIds={selectedIds}
        onlyFree
        onChoose={(m) =>
          setSelectedIds((e) => (e.includes(m) ? e.filter((x) => x !== m) : [...e, m]))
        }
      />
    </SidePanel>
  )
}

/** Move products from this order to another table (someone changed tables with their things). */
export function MovePanel({
  order,
  catalog,
  occupiedIds,
  online,
  onClose,
  onMove,
}: {
  order: VisibleOrder
  catalog: Catalog
  occupiedIds: Map<string, string>
  online: boolean
  onClose: () => void
  onMove: (itemIds: string[], tableId: string) => Promise<void>
}) {
  const items = Object.values(order.status.items)
    .filter((i) => i.status !== 'voided' && i.quantity > i.voidedQuantity)
    .sort((a, b) => a.position - b.position)
  const [ids, setIds] = useState<string[]>([])
  const [table, setTable] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const people = [...new Set(items.map((i) => i.guest).filter((c) => c !== null))].sort(
    (a, b) => (a ?? 0) - (b ?? 0),
  )
  const name = catalog.tables.find((m) => m.id === table)?.name
  const move = () => {
    if (!online) return setError('Mover productos pide conexión con la caja. Revisa el Wi-Fi.')
    if (ids.length === 0 || !table) return
    onMove(ids, table).catch((e) => setError(message(e)))
  }
  return (
    <SidePanel
      opened
      title="Mover productos"
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-2">
          {error && (
            <p role="alert" className="text-alert-text">
              {error}
            </p>
          )}
          <Button
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
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <span className="font-semibold">Qué se mueve</span>
          {people.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {people.map((c) => (
                <Button
                  key={c}
                  onClick={() => setIds(items.filter((i) => i.guest === c).map((i) => i.id))}
                >
                  {`Todo de P${c}`}
                </Button>
              ))}
            </div>
          )}
          <Group label="Productos" className="flex flex-col gap-2">
            {items.map((i) => (
              <Option
                key={i.id}
                shape="card"
                selected={ids.includes(i.id)}
                onChoose={() =>
                  setIds((x) => (x.includes(i.id) ? x.filter((y) => y !== i.id) : [...x, i.id]))
                }
                detail={
                  [i.guest ? `P${i.guest}` : null, i.notes].filter(Boolean).join(' · ') || undefined
                }
              >
                {`${i.quantity - i.voidedQuantity} × ${i.name}`}
              </Option>
            ))}
          </Group>
        </div>
        <div className="flex flex-col gap-2">
          <span className="font-semibold">A qué mesa</span>
          <span className="text-sm text-muted">
            Si la mesa ya tiene pedido, se suman a ese; si está libre, se abre uno.
          </span>
          <SelectTable
            catalog={catalog}
            occupiedIds={occupiedIds}
            exclude={
              order.status.tableId ? [order.status.tableId, ...order.status.mergedTables] : []
            }
            selectedIds={table ? [table] : []}
            onlyFree={false}
            onChoose={setTable}
          />
        </div>
      </div>
    </SidePanel>
  )
}

/** Cancel the whole order: reason and, without the permission, the PIN of whoever authorizes. */
export function CancelPanel({
  table,
  withPermission,
  online,
  inKitchen,
  withPayments,
  onClose,
  onCancel,
}: {
  /** «Mesa 5», so the button says which order. */
  table: string
  withPermission: boolean
  online: boolean
  inKitchen: number
  withPayments: boolean
  onClose: () => void
  onCancel: (d: { reason: string; pin: string | null }) => Promise<void>
}) {
  const [reason, setReason] = useState<string | null>(null)
  const [other, setOther] = useState('')
  const [pin, setPin] = useState(noError)
  const [taken, setTaken] = useState(false)
  const m = finalReason(reason, other)
  const cancel = async (key: string | null) => {
    if (!m) return
    setTaken(true)
    try {
      await onCancel({ reason: m, pin: key })
    } catch (e) {
      setPin((p) => failure(e, p))
      setTaken(false)
    }
  }
  return (
    <SidePanel
      opened
      title={`Cancelar el pedido de la ${table.toLowerCase()}`}
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-2">
          {withPermission && pin.error && (
            <p role="alert" className="text-alert-text">
              {pin.error}
            </p>
          )}
          <div className="flex gap-2">
            <Button large className="flex-1" onClick={onClose}>
              Volver
            </Button>
            {withPermission && (
              <Button
                variant="danger"
                large
                className="flex-1"
                disabled={taken || !m || withPayments}
                onClick={() => cancel(null)}
              >
                {m ? 'Sí, cancelarlo' : 'Elige el motivo'}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {withPayments ? (
          <p className="rounded-xl bg-alert-soft p-3 text-alert-text">
            Este pedido ya tiene pagos: primero hay que anularlos en caja.
          </p>
        ) : (
          <p className="rounded-xl bg-alert-soft p-3 text-alert-text">
            {inKitchen > 0
              ? `Se quita todo el pedido y la cocina recibe «ANULAR» de lo que tenía (${inKitchen}). La mesa queda libre.`
              : 'Se quita todo el pedido y la mesa queda libre.'}
          </p>
        )}
        {!withPayments && (
          <SelectReason reason={reason} other={other} onChoose={setReason} onType={setOther} />
        )}
        {!withPermission && !withPayments && (
          <AuthorizeWithPin
            ready={!!m}
            missing="Elige el motivo y después pásale el celular al cajero para su PIN."
            online={online}
            status={pin}
            taken={taken}
            onPin={(key) => cancel(key)}
          />
        )}
      </div>
    </SidePanel>
  )
}

/** What can be done with the whole order (with no order yet, only merging tables). */
export function OrderActionsPanel({
  withTable,
  withOrder,
  onClose,
  onChoose,
}: {
  withTable: boolean
  withOrder: boolean
  onClose: () => void
  onChoose: (a: 'move' | 'table' | 'merge' | 'cancel') => void
}) {
  const options: {
    action: 'move' | 'table' | 'merge'
    icon: IconName
    text: string
    detail: string
  }[] = [
    ...(withTable && withOrder
      ? ([
          {
            action: 'table',
            icon: 'table',
            text: 'Cambiar de mesa',
            detail: 'Todo el pedido pasa a otra mesa libre',
          },
        ] as const)
      : []),
    ...(withTable
      ? ([
          {
            action: 'merge',
            icon: 'people',
            text: 'Unir mesas',
            detail: 'Un grupo grande ocupa varias mesas',
          },
        ] as const)
      : []),
    ...(withOrder
      ? ([
          {
            action: 'move',
            icon: 'seat',
            text: 'Mover productos',
            detail: 'Pasar algunos a otra mesa',
          },
        ] as const)
      : []),
  ]
  const cssClass =
    'flex min-h-16 w-full items-center gap-3 rounded-xl border border-border bg-surface px-4 text-left focus-visible:outline-3 focus-visible:outline-focus'
  return (
    <SidePanel opened title="Mesa y pedido" onClose={onClose}>
      <ul className="flex flex-col gap-2">
        {options.map((o) => (
          <li key={o.action}>
            <button type="button" onClick={() => onChoose(o.action)} className={cssClass}>
              <Icon name={o.icon} className="size-6 shrink-0" />
              <span className="flex flex-col">
                <span className="font-semibold">{o.text}</span>
                <span className="text-sm text-muted">{o.detail}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {withOrder && (
        // Away from everything else: it is the only thing that cannot be undone.
        <div className="mt-8 border-t border-divider pt-4">
          <button
            type="button"
            onClick={() => onChoose('cancel')}
            className={`${cssClass} border-alert-strong/50 text-alert-text`}
          >
            <Icon name="erase" className="size-6 shrink-0" />
            <span className="flex flex-col">
              <span className="font-semibold">Cancelar el pedido</span>
              <span className="text-sm">Quita todo el pedido de la mesa, con motivo</span>
            </span>
          </button>
        </div>
      )}
    </SidePanel>
  )
}
