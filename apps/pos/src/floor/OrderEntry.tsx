import { itemTotals, newId, type OrderItem, type OrderState } from '@pos/core'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { pesos } from '../ui/format'
import { Icon, type IconName } from '../ui/icons'
import { Group, Option } from '../ui/Options'
import { navigate, useRoute } from '../ui/route'
import { SidePanel } from '../ui/SidePanel'
import { search } from '../ui/search'
import { useNotify } from '../ui/toasts'
import { floor, useFloor, useLocalView } from './context'
import { FloorFrame } from './FloorFrame'
import {
  CancelPanel,
  ChangeTablePanel,
  MergeTablesPanel,
  MovePanel,
  OrderActionsPanel,
  VoidPanel,
} from './OrderActions'
import {
  asksForOptions,
  type CatalogProduct,
  CHANNELS,
  COURSES,
  type Course,
  copyOf,
  courseName,
  courseTickets,
  itemData,
  matchingLine,
  missingSelection,
  movedFrom,
  selectedPrice,
  ticketsByStation,
  unitsToSend,
} from './order'
import { currentItems, occupiesTable, soldOutKey, type VisibleOrder } from './projection'

// Order entry (brief §4.2 and §5, rule 2): tap products and "Enviar". Every tap is an event
// saved here before it is shown; it is sent to the hub when there is a connection.
// - Who it is for (the table or person 1, 2…) and which course what gets added goes in: chosen
//   at the top and it applies to what comes next. The same product again adds to its line.
// - A course can be held and fired later (the starter goes now; the main, when asked for).
// - Sold-out items (86) show on every device instantly; whoever has permission marks them here.
// The table becomes occupied when the first product is added, not when it is opened.

/** Units (not lines) of some items: 2 Aperol on one line are 2. */
const unitsOf = (items: readonly OrderItem[]) =>
  items.reduce((n, i) => n + i.quantity - i.voidedQuantity, 0)

/** What is in the kitchen and the waiter can mark as delivered (ADR-015). */
const IN_KITCHEN = new Set(['sent', 'in_preparation', 'ready'])

const STATUS_TEXT: Record<string, string> = {
  pending: 'sin enviar',
  held: 'held',
  sent: 'en cocina',
  in_preparation: 'en preparación',
  ready: 'listo para llevar',
  served: 'entregado',
}

type Channel = 'dine_in' | keyof typeof CHANNELS
/** The most a line can hold from the screen (the schema allows up to 999). */
const MAX_PER_LINE = 99

const FAVORITES = '__favorites'
const MORE_ORDERS = '__more'
const MAX_RESULTS = 40

export function OrderEntry() {
  const { params } = useRoute()
  const { catalog, session, connection } = useFloor()
  const online = connection === 'connected'
  const view = useLocalView()
  const orders = view?.orders ?? null
  const soldOutIds = view?.soldOutIds ?? new Set<string>()
  const notify = useNotify()
  const tableId = params.get('table')
  const newChannel = (params.get('channel') as Channel | null) ?? (tableId ? 'dine_in' : null)
  const table = tableId ? catalog?.tables.find((m) => m.id === tableId) : undefined
  const [searchQuery, setSearchQuery] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [selectedProduct, setSelectedProduct] = useState<CatalogProduct | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [viewOrder, setViewOrder] = useState(false)
  const [guest, setGuest] = useState<number | null>(null)
  const [course, setCourse] = useState<Course | null>(null)
  const [initialGuests, setInitialGuests] = useState(0)
  const [markingSoldOut, setMarkingSoldOut] = useState(false)
  const [soldOutTarget, setSoldOutTarget] = useState<CatalogProduct | null>(null)
  const searchField = useRef<HTMLInputElement>(null)
  // The order opened here: consecutive taps go to the same one even if it has not been reread yet.
  const opened = useRef<string | null>(null)
  // Taps are saved one after another, in the order they were made.
  const queue = useRef<Promise<void>>(Promise.resolve())
  const canMarkSoldOut = session?.permissions.includes('mark_product_sold_out') ?? false
  const canServe = session?.permissions.includes('mark_preparation') ?? false
  // Courses are rarely used in Colombia: they only show if the restaurant turns them on.
  const coursesEnabled = catalog?.restaurant.coursesEnabled ?? false
  const [editingNote, setEditingNote] = useState(false)
  // Table and order (task 1.5): which panel is open, and which item is being voided.
  const [action, setAction] = useState<'menu' | 'move' | 'table' | 'merge' | 'cancel' | null>(null)
  const [voiding, setVoiding] = useState<string | null>(null)
  const permissions = session?.permissions ?? []

  // "/" goes to the search (register shortcut, brief §5, rule 8).
  useEffect(() => {
    const onKeystroke = (e: KeyboardEvent) => {
      if (e.key !== '/' || (e.target as HTMLElement).closest('input, textarea')) return
      e.preventDefault()
      searchField.current?.focus()
    }
    window.addEventListener('keydown', onKeystroke)
    return () => window.removeEventListener('keydown', onKeystroke)
  }, [])

  if (!catalog || (tableId && !table) || (!tableId && !newChannel && !params.get('order'))) {
    return (
      <FloorFrame title="Pedido" back="/">
        <p className="p-6 text-texto-suave">Esta mesa o este pedido no existe.</p>
      </FloorFrame>
    )
  }

  // The order: the chosen one, the one opened here or the table's first one.
  const candidates = (orders ?? []).filter((p) =>
    tableId
      ? p.status.tableId === tableId || p.status.mergedTables.includes(tableId)
      : p.status.id === params.get('order'),
  )
  const selectedId =
    params.get('order') ?? opened.current ?? (tableId ? candidates[0]?.status.id : null) ?? null
  const order = (orders ?? []).find((p) => p.status.id === selectedId) ?? null
  const channel: Channel = order?.status.channel ?? newChannel ?? 'dine_in'
  const guests = order?.status.guests ?? initialGuests
  const merged = (order?.status.mergedTables ?? [])
    .map((id) => catalog?.tables.find((m) => m.id === id)?.name)
    .filter(Boolean)
  const title = table
    ? `Mesa ${[table.name, ...merged].join(' + ')}`
    : `${channel === 'dine_in' ? 'Pedido' : CHANNELS[channel]}${order?.status.dayNumber ? ` #${order.status.dayNumber}` : ''}`
  const products = catalog.categories.flatMap((c) => c.products)
  // Where each product goes out (kitchen or bar): gives its icon when it has no photo.
  const stationOf = new Map(
    catalog.categories.flatMap((c) =>
      c.products.map((p) => [p.id, catalog.stations.find((e) => e.id === c.stationId)?.name ?? '']),
    ),
  )
  const soldOut = (p: CatalogProduct) => soldOutIds.has(soldOutKey(p.id))

  const inOrder = (job: () => Promise<void>) => {
    queue.current = queue.current.then(job).catch((e) => {
      console.error(e)
      notify(e instanceof Error ? e.message : 'No se pudo guardar')
    })
  }
  /**
   * Like `inOrder`, but the failure goes back to whoever asked for it (a panel that shows it next
   * to the button: a wrong PIN, no connection) instead of a notice.
   */
  const inOrderWithError = (job: () => Promise<void>): Promise<void> => {
    const done = queue.current.then(job)
    queue.current = done.catch(() => {})
    return done
  }
  /**
   * For what waits on the hub (the supervisor's PIN, up to 8 s): it goes after what is already in
   * the queue, but without holding back products added in the meantime.
   */
  const withoutBlockingQueue = async (job: () => Promise<void>): Promise<void> => {
    await queue.current
    await job()
  }
  /** The saved order (not the one from the last screen): an earlier tap may have changed it. */
  const savedOrder = async () => {
    const id = selectedId ?? opened.current
    return id ? ((await floor.sync?.order(id)) ?? null) : null
  }
  /** The order that what gets added goes to; if it does not exist yet, it is opened. */
  const ensureOrder = async () => {
    const id = selectedId ?? opened.current
    if (id) return id
    const fresh = newId()
    await floor.record('OrderOpened', fresh, {
      channel,
      table_id: tableId ?? null,
      guests: initialGuests,
    })
    // Only after saving it: if it failed, the next tap tries again.
    opened.current = fresh
    // An order without a table is tracked by its id (the table does not identify it).
    if (!tableId) navigate(`/order?order=${fresh}`)
    return fresh
  }
  /** The line as saved, if it has not been sent yet. */
  const savedLine = async (itemId: string) => {
    const status = await savedOrder()
    const item = status?.items[itemId]
    return status && item && (item.status === 'pending' || item.status === 'held')
      ? { status, item }
      : null
  }
  /**
   * The data to re-add an item as it is now (another `item_id`), with the catalog version it
   * was added with: the price was that menu's price.
   */
  const currentCopy = async (item: OrderItem) => {
    const original = (await floor.sync?.locals())?.find(
      (l) => l.event.type === 'ItemAdded' && l.event.data.item_id === item.id,
    )?.event
    return original?.type === 'ItemAdded'
      ? {
          ...original.data,
          item_id: newId(),
          quantity: item.quantity - item.voidedQuantity,
          guest: item.guest,
          course: item.course,
          notes: item.notes,
        }
      : copyOf(item, catalog.version)
  }

  /**
   * Adds or subtracts units on an unsent line, starting from what is saved (two taps in a row
   * count as two). No notice: the number changes in view and «−» corrects it (owner's
   * decision: the notice got in the way of taking orders). At 0, it is removed with Deshacer.
   */
  const increment = (itemId: string, delta: number) =>
    inOrder(async () => {
      const line = await savedLine(itemId)
      if (!line) {
        notify('Esa línea ya se envió o ya no está')
        return
      }
      const quantity = line.item.quantity + delta
      if (quantity <= 0) {
        await removeNow(line.status, line.item)
        return
      }
      if (quantity > MAX_PER_LINE) {
        notify(`Una línea lleva hasta ${MAX_PER_LINE}`)
        return
      }
      await floor.record('ItemChanged', line.status.id, { item_id: itemId, quantity })
    })

  const add = (
    p: CatalogProduct,
    variantId: string | null,
    selectedIds: Record<string, string[]>,
    extras: { quantity?: number; notes?: string } = {},
  ) =>
    inOrder(async () => {
      // Before opening the order: if something is still to be chosen, no empty order is left
      // on the table.
      const data = itemData(catalog, p, variantId, selectedIds, {
        ...extras,
        guest,
        course: coursesEnabled ? course : null,
      })
      const id = await ensureOrder()
      const equal = matchingLine(await savedOrder(), data)
      if (equal) {
        const quantity = Math.min(MAX_PER_LINE, equal.quantity + data.quantity)
        const summed = quantity - equal.quantity
        if (summed === 0) {
          notify(`Una línea lleva hasta ${MAX_PER_LINE}`)
          return
        }
        await floor.record('ItemChanged', id, { item_id: equal.id, quantity })
        return
      }
      await floor.record('ItemAdded', id, data)
    })

  /** Removes the line (already in the queue) and leaves Deshacer, which re-adds it as it was. */
  const removeNow = async (status: OrderState, item: OrderItem) => {
    const copy = await currentCopy(item)
    await floor.record('ItemRemoved', status.id, { item_id: item.id })
    notify(`Quitaste ${item.name}`, () =>
      inOrder(() => floor.record('ItemAdded', status.id, copy).then(() => {})),
    )
  }
  const remove = (itemId: string) =>
    inOrder(async () => {
      const line = await savedLine(itemId)
      if (line) await removeNow(line.status, line.item)
    })

  /** Changes who it is for, the course or the note of an unsent line. */
  const changeItem = (
    itemId: string,
    change: { guest?: number | null; course?: Course | null; notes?: string | null },
  ) =>
    inOrder(async () => {
      const line = await savedLine(itemId)
      if (!line) {
        notify('Esa línea ya se envió o ya no está')
        return
      }
      await floor.record('ItemChanged', line.status.id, { item_id: itemId, ...change })
    })

  /** The whole order's note («alérgico al maní»): it goes on every ticket and to the kitchen. */
  const changeOrderNote = (notes: string | null) =>
    inOrder(async () => {
      const before = await savedOrder()
      // Without a change nothing is written, and no empty order is opened on a free table.
      if ((before?.notes ?? null) === notes) return
      if (before && before.status !== 'open') {
        notify('Este pedido ya se cerró: la nota no se guardó')
        return
      }
      const id = await ensureOrder()
      await floor.record('OrderNoteChanged', id, { notes })
    })

  // ── Table and order (task 1.5) ────────────────────────────────────────

  /**
   * Tables taken by the other open orders (their table and the merged ones), to pick where to move.
   * One left empty after moving everything elsewhere no longer takes its own table (as in the hub).
   */
  const occupiedIds = new Map<string, string>()
  for (const p of orders ?? []) {
    if (!p.status.tableId || p.status.id === order?.status.id || !occupiesTable(p.status)) continue
    const waiter = catalog?.staff.find((u) => u.id === p.status.assignedWaiterId)?.name
    for (const m of [p.status.tableId, ...p.status.mergedTables])
      occupiedIds.set(m, waiter ?? 'ocupada')
  }

  /** Void what was sent, with a reason; without the permission the cashier authorizes it by PIN. */
  const voidItem = (
    itemId: string,
    d: { quantity: number; reason: string; alreadyPrepared: boolean; pin: string | null },
  ) =>
    withoutBlockingQueue(async () => {
      const status = await savedOrder()
      const item = status?.items[itemId]
      if (!status || !item) throw new Error('El pedido cambió: ciérralo y ábrelo de nuevo')
      await floor.record(
        'ItemVoided',
        status.id,
        {
          item_id: item.id,
          quantity: d.quantity,
          already_prepared: d.alreadyPrepared,
          ticket_id: newId(),
        },
        {
          reason: d.reason,
          ...(d.pin ? { authorizes: { pin: d.pin, permission: 'void_sent_item' } } : {}),
        },
      )
      setVoiding(null)
      setEditing(null)
      notify(
        online
          ? `Anulaste ${d.quantity} ${item.name}`
          : `Anulado aquí: llega a cocina cuando vuelva la conexión`,
      )
    })

  /** Cancel the whole order; the table becomes free and the kitchen gets the void. */
  const cancelOrder = (d: { reason: string; pin: string | null }) =>
    withoutBlockingQueue(async () => {
      const status = await savedOrder()
      if (!status) throw new Error('El pedido cambió: ciérralo y ábrelo de nuevo')
      if (Object.values(status.payments).some((p) => !p.voided))
        throw new Error('Este pedido ya tiene pagos: primero hay que anularlos en caja')
      await floor.record(
        'OrderCanceled',
        status.id,
        {},
        {
          reason: d.reason,
          ...(d.pin ? { authorizes: { pin: d.pin, permission: 'cancel_order' } } : {}),
        },
      )
      setAction(null)
      notify('Cancelaste el pedido')
      navigate('/')
    })

  /** The note of a dish already sent: the kitchen gets a «CAMBIO» ticket. */
  const changeSentNote = (itemId: string, notes: string | null) =>
    inOrder(async () => {
      const status = await savedOrder()
      const item = status?.items[itemId]
      if (!status || !item || item.notes === notes) return
      await floor.record('ItemModifiedAfterSend', status.id, {
        item_id: item.id,
        ticket_id: newId(),
        notes,
      })
      notify(
        online
          ? `La cocina recibe el cambio de ${item.name}`
          : 'Guardado: el cambio llega a cocina cuando vuelva la conexión',
      )
    })

  /** Move products to another table: to the order it has, or to a new one if it is free. */
  const moveTo = (itemIds: string[], targetTable: string) =>
    inOrderWithError(async () => {
      const status = await savedOrder()
      if (!status) return
      const items = itemIds.map((id) => status.items[id]).filter((i): i is OrderItem => !!i)
      if (items.length === 0) throw new Error('El pedido cambió: ciérralo y ábrelo de nuevo')
      // What the hub would reject is warned about before opening anything on the other table.
      if (status.checks) throw new Error('La cuenta está dividida: primero deshaz la división')
      if (
        items.some((i) =>
          Object.values(status.discounts).some((d) => d.amounts[i.id] !== undefined),
        )
      )
        throw new Error('Algo tiene descuento: primero quítalo en caja')
      let target = (orders ?? []).find(
        (p) =>
          p.status.id !== status.id &&
          (p.status.tableId === targetTable || p.status.mergedTables.includes(targetTable)),
      )?.status.id
      if (!target) {
        target = newId()
        await floor.record('OrderOpened', target, {
          channel: 'dine_in',
          table_id: targetTable,
          guests: 0,
        })
      }
      await floor.record(
        'ItemsMoved',
        status.id,
        { target_order_id: target, items: items.map(movedFrom) },
        { related: [target] },
      )
      setAction(null)
      const name = catalog?.tables.find((m) => m.id === targetTable)?.name
      notify(`Pasaste ${unitsOf(items)} a la mesa ${name ?? ''}`)
    })

  /** The whole order is moved to another free table. */
  const moveToTable = (targetTable: string) =>
    inOrderWithError(async () => {
      const status = await savedOrder()
      if (!status) throw new Error('El pedido cambió: ciérralo y ábrelo de nuevo')
      await floor.record('OrderMovedTable', status.id, { target_table_id: targetTable })
      setAction(null)
      navigate(`/order?table=${targetTable}&order=${status.id}`)
    })

  /** Merge free tables into this order's table, or release them. */
  const mergeTables = (add: string[], remove: string[]) =>
    inOrderWithError(async () => {
      const id = await ensureOrder()
      if (add.length > 0) await floor.record('TablesMerged', id, { table_ids: add })
      if (remove.length > 0) await floor.record('TablesSeparated', id, { table_ids: remove })
      setAction(null)
    })

  const duplicateSelected = (itemId: string) =>
    inOrder(async () => {
      const status = await savedOrder()
      const item = status?.items[itemId]
      if (!status || !item) return
      await floor.record('ItemAdded', status.id, await currentCopy(item))
    })

  /** One person more or fewer, over what is saved; never below the highest person with items. */
  const changeGuests = (delta: number) => {
    if (!order) {
      setInitialGuests((n) => Math.max(0, Math.min(200, n + delta)))
      return
    }
    inOrder(async () => {
      const status = await savedOrder()
      if (!status) return
      const inUse = Math.max(0, ...currentItems(status).map((i) => i.guest ?? 0))
      const n = status.guests + delta
      if (n < inUse) {
        notify(`La persona ${inUse} tiene cosas: pásalas a otra antes de quitarla`)
        return
      }
      if (n < 0 || n > 200) return
      if (guest !== null && guest > n) setGuest(null)
      await floor.record('GuestsChanged', status.id, { guests: n })
    })
  }

  // Without a connection it stays saved here, but the kitchen does not have it yet: don't say
  // "Enviado".
  const notifySent = (howMany: number, what = 'a cocina y barra') =>
    notify(
      floor.snapshot().connection === 'connected'
        ? `Enviado ${what} (${howMany})`
        : `Guardado (${howMany}): llega a cocina cuando vuelva la conexión`,
    )

  /** Send what is pending (held items wait until their course is fired). */
  const send = () =>
    inOrder(async () => {
      const status = await savedOrder()
      if (!status) return
      const howMany = unitsToSend(status)
      if (howMany === 0) return
      const data = ticketsByStation(catalog, status)
      if (!data) {
        notify('No hay a dónde enviar: la carta no tiene cocina ni barra')
        return
      }
      await floor.record('ItemsSent', status.id, data)
      navigator.vibrate?.(60)
      notifySent(howMany)
      setViewOrder(false)
      navigate('/')
    })

  const hold = (c: Course) =>
    inOrder(async () => {
      const status = await savedOrder()
      if (!status) return
      await floor.record('CourseHeld', status.id, { course: c })
      const text = courseName(c)
      notify(`${text[0]?.toUpperCase()}${text.slice(1)} espera: márchalo cuando lo pidan`)
    })
  /** Fire: the course stops waiting and goes to the kitchen at once. */
  const fire = (c: Course) =>
    inOrder(async () => {
      const status = await savedOrder()
      if (!status) return
      await floor.record('CourseFired', status.id, { course: c })
      const now = await savedOrder()
      const data = now ? courseTickets(catalog, now, c) : null
      if (now && data) {
        await floor.record('ItemsSent', now.id, data)
        notifySent(
          data.tickets.reduce((s, x) => s + x.item_ids.length, 0),
          courseName(c),
        )
      }
    })

  /**
   * The waiter takes the dish to the table (ADR-015): it leaves «Pedidos en cocina». It can be
   * undone for a few seconds, in case they tapped the wrong one.
   */
  const serve = (ids: string[], what: string) =>
    inOrder(async () => {
      const status = await savedOrder()
      if (!status || ids.length === 0) return
      await floor.record('ItemServed', status.id, { item_ids: ids })
      notify(`Entregado: ${what}`, () =>
        inOrder(async () => {
          await floor.record('ItemReturnedToQueue', status.id, { item_ids: ids })
        }),
      )
    })

  /** Marks the whole product or a variant as sold out or available (the bottle, not the glass). */
  const toggleSoldOut = (
    p: CatalogProduct,
    variantId: string | null,
    markSoldOut: boolean,
    undoable = true,
  ): void =>
    inOrder(async () => {
      await floor.record(markSoldOut ? 'ProductSoldOut' : 'ProductAvailable', p.id, {
        product_id: p.id,
        variant_id: variantId,
      })
      const variant = p.variants.find((v) => v.id === variantId)
      const name = variant ? `${p.name} (${variant.name})` : p.name
      const text = markSoldOut ? `${name}: agotado` : `${name} vuelve a estar disponible`
      if (undoable) notify(text, () => toggleSoldOut(p, variantId, !markSoldOut, false))
      else notify(text)
    })

  const tapProduct = (p: CatalogProduct) => {
    if (markingSoldOut) {
      if (p.variants.length > 0) setSoldOutTarget(p)
      else toggleSoldOut(p, null, !soldOut(p))
    } else if (soldOut(p)) notify(`${p.name} está agotado`)
    else if (asksForOptions(p)) setSelectedProduct(p)
    else add(p, null, {})
  }

  const favorites = products.filter((p) => p.favorite)
  const moreOrders = (view?.moreOrders ?? [])
    .map((id) => products.find((p) => p.id === id))
    .filter((p): p is CatalogProduct => p !== undefined)
  const currentCategory =
    category ??
    (favorites.length > 0
      ? FAVORITES
      : moreOrders.length > 0
        ? MORE_ORDERS
        : catalog.categories[0]?.id)
  const list = searchQuery.trim()
    ? search(products, searchQuery, (p) => `${p.name} ${p.description ?? ''}`)
    : currentCategory === FAVORITES
      ? favorites
      : currentCategory === MORE_ORDERS
        ? moreOrders
        : (catalog.categories.find((c) => c.id === currentCategory)?.products ?? [])
  // Units to send now (held items wait until their course is fired).
  const quantityInOrder = (productId: string) =>
    order
      ? currentItems(order.status)
          .filter(
            (i) => i.productId === productId && (i.status === 'pending' || i.status === 'held'),
          )
          .reduce((s, i) => s + i.quantity, 0)
      : 0
  const missingOnes = order ? unitsToSend(order.status) : 0
  const editedItem = order && editing ? (order.status.items[editing] ?? null) : null

  const inKitchen = order ? currentItems(order.status).filter((i) => IN_KITCHEN.has(i.status)) : []
  const sendButton = (
    <Button
      variant="main"
      large
      icon="send"
      className="w-full"
      disabled={missingOnes === 0}
      onClick={send}
    >
      {missingOnes === 0 ? 'Enviar' : `Enviar ${missingOnes}`}
    </Button>
  )
  // The pre-bill, split and checkout (task 1.6), on their own screen.
  const withProducts = order !== null && currentItems(order.status).length > 0
  const goToCheck = () => order && navigate(`/check?order=${order.status.id}`)
  const checkButton = (
    <Button variant="secondary" large icon="receipt" className="w-full" onClick={goToCheck}>
      Cuenta
    </Button>
  )
  const ticketFooter = withProducts ? (
    <div className="grid grid-cols-[2fr_3fr] gap-2">
      {checkButton}
      {sendButton}
    </div>
  ) : (
    sendButton
  )
  const ticket = (
    <Ticket
      order={order}
      guests={guests}
      dineIn={channel === 'dine_in'}
      onGuestsChange={changeGuests}
      onItemTap={(i) => setEditing(i.id)}
      onIncrement={(i, delta) => increment(i.id, delta)}
      onHold={hold}
      onFire={fire}
      onServe={canServe ? serve : null}
      onEditNote={() => setEditingNote(true)}
      onActions={order || tableId ? () => setAction('menu') : null}
    />
  )

  return (
    <FloorFrame title={title} back="/">
      <div className="mx-auto flex max-w-[96rem] gap-5 p-3 pb-28 md:p-5 md:pb-5">
        <section className="min-w-0 flex-1" aria-label="Carta">
          {tableId && candidates.length > 1 && (
            <Group label="Pedidos de la mesa" className="mb-3 flex flex-wrap gap-2">
              {candidates.map((p, i) => (
                <Option
                  key={p.status.id}
                  selected={p.status.id === selectedId}
                  onChoose={() => navigate(`/order?table=${tableId}&order=${p.status.id}`)}
                >
                  {`Pedido ${i + 1}`}
                </Option>
              ))}
            </Group>
          )}

          <div className="flex gap-2">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Buscar en la carta</span>
              <Icon
                name="search"
                className="absolute top-1/2 left-3 -translate-y-1/2 text-texto-suave"
              />
              <input
                ref={searchField}
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setSearchQuery('')
                  // With a single match, Enter adds it (register shortcut).
                  if (e.key === 'Enter' && list.length === 1 && list[0]) {
                    tapProduct(list[0])
                    setSearchQuery('')
                  }
                }}
                placeholder="Buscar: «hamburgesa», «aperol»…"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className="min-h-12 w-full rounded-xl border border-linea bg-superficie pr-3 pl-11 text-lg shadow-flota placeholder:text-texto-suave focus-visible:outline-3 focus-visible:outline-foco"
              />
            </label>
            {canMarkSoldOut && (
              <Button
                variant={markingSoldOut ? 'main' : 'secondary'}
                aria-pressed={markingSoldOut}
                onClick={() => setMarkingSoldOut(!markingSoldOut)}
              >
                {markingSoldOut ? 'Listo' : 'Marcar agotados'}
              </Button>
            )}
          </div>
          {markingSoldOut && (
            <p className="mt-2 rounded-xl bg-alerta-suave p-3 text-alerta-texto" role="status">
              Toca un producto para marcarlo agotado o disponible. Se ve al instante en todos los
              equipos. Toca «Listo» al terminar.
            </p>
          )}

          {!searchQuery.trim() && (
            <Group label="Categorías" className="-mx-3 mt-3 flex gap-2 overflow-x-auto px-3 pb-1">
              {favorites.length > 0 && (
                <Option
                  selected={currentCategory === FAVORITES}
                  onChoose={() => setCategory(FAVORITES)}
                >
                  Favoritos
                </Option>
              )}
              {moreOrders.length > 0 && (
                <Option
                  selected={currentCategory === MORE_ORDERS}
                  onChoose={() => setCategory(MORE_ORDERS)}
                >
                  Lo más pedido
                </Option>
              )}
              {catalog.categories.map((c) => (
                <Option
                  key={c.id}
                  selected={c.id === currentCategory}
                  onChoose={() => setCategory(c.id)}
                >
                  {c.name}
                </Option>
              ))}
            </Group>
          )}

          <SelectFor
            guests={channel === 'dine_in' ? guests : 0}
            askGuestCount={channel === 'dine_in' && guests === 0}
            guest={guest}
            course={course}
            coursesEnabled={coursesEnabled}
            onChooseGuest={setGuest}
            onChooseCourse={setCourse}
            onGuestCount={(n) => changeGuests(n - guests)}
          />

          {orders === null && (
            <p className="mt-3 text-texto-suave" role="status">
              Leyendo los pedidos de este equipo…
            </p>
          )}
          {/* The columns come from the menu's width, not the screen's: on a tablet the order
              panel takes space from it. */}
          <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]">
            {list.slice(0, MAX_RESULTS).map((p) => {
              const quantity = quantityInOrder(p.id)
              const outOfStock = soldOut(p)
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    // Until the orders are read it is unknown whether the table already has one.
                    disabled={orders === null}
                    aria-label={[
                      p.name,
                      outOfStock
                        ? 'agotado'
                        : p.variants.length > 0
                          ? `desde ${pesos(Math.min(...p.variants.map((v) => v.price)))}`
                          : pesos(p.price),
                      ...(quantity > 0 ? [`${quantity} en el pedido`] : []),
                    ].join(', ')}
                    onClick={() => tapProduct(p)}
                    className={`group flex h-full w-full flex-col overflow-hidden rounded-2xl border text-left transition active:scale-[0.98] focus-visible:outline-3 focus-visible:outline-foco ${
                      outOfStock
                        ? 'border-dashed border-alerta-fuerte bg-alerta-suave text-alerta-texto'
                        : quantity > 0
                          ? 'border-accion-fuerte bg-superficie shadow-flota'
                          : 'border-linea bg-superficie hover:border-borde hover:shadow-flota'
                    }`}
                  >
                    <span
                      className={`relative flex w-full items-center justify-center ${
                        p.photo
                          ? 'aspect-video bg-superficie-2 sm:aspect-[4/3]'
                          : 'h-14 bg-superficie-2/70 sm:h-20'
                      }`}
                    >
                      <PhotoOrIcon
                        photo={p.photo ?? null}
                        icon={iconOf(stationOf.get(p.id) ?? '')}
                        off={outOfStock}
                      />
                      {quantity > 0 && (
                        <span className="cifras absolute top-2 right-2 flex h-7 min-w-7 items-center justify-center rounded-full bg-accion-fuerte px-2 text-sm font-bold text-white shadow-flota">
                          {`×${quantity}`}
                        </span>
                      )}
                      {outOfStock && (
                        <span className="absolute top-2 left-2 rounded-full bg-alerta-fuerte px-2.5 py-0.5 text-sm font-semibold text-white">
                          Agotado
                        </span>
                      )}
                    </span>
                    <span className="flex flex-1 flex-col gap-2 p-3">
                      <span
                        className={`line-clamp-2 font-semibold leading-snug ${outOfStock ? 'line-through' : ''}`}
                      >
                        {p.name}
                      </span>
                      <span className="mt-auto flex items-center justify-between gap-2">
                        <span className="cifras text-lg font-bold">
                          {p.variants.length > 0
                            ? `desde ${pesos(Math.min(...p.variants.map((v) => v.price)))}`
                            : pesos(p.price)}
                        </span>
                        {!outOfStock &&
                          (asksForOptions(p) ? (
                            <span className="text-sm whitespace-nowrap text-texto-suave">
                              opciones ›
                            </span>
                          ) : (
                            <span
                              aria-hidden="true"
                              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accion-fuerte text-white transition group-hover:brightness-110"
                            >
                              <Icon name="more" className="size-5" />
                            </span>
                          ))}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
            {list.length === 0 && (
              <li className="col-span-full p-6 text-center text-texto-suave">
                {searchQuery.trim()
                  ? `No hay nada con «${searchQuery}».`
                  : 'No hay productos aquí.'}
              </li>
            )}
            {list.length > MAX_RESULTS && (
              <li className="col-span-full p-3 text-center text-texto-suave">
                {`Hay ${list.length - MAX_RESULTS} más: escribe un poco más.`}
              </li>
            )}
          </ul>
        </section>

        {/* Tablet and register: the order always in view. */}
        <aside className="sticky top-21 hidden h-[calc(100dvh-6.5rem)] w-80 shrink-0 lg:w-96 flex-col overflow-hidden rounded-2xl border border-linea bg-superficie shadow-flota md:flex">
          <div className="flex items-center justify-between gap-2 border-b border-linea px-4 py-3">
            <h2 className="text-lg font-bold">{title}</h2>
            {order?.status.dayNumber && (
              <span className="cifras text-sm text-texto-suave">{`Pedido #${order.status.dayNumber}`}</span>
            )}
          </div>
          {ticket}
          <div className="border-t border-linea p-4">{ticketFooter}</div>
        </aside>
      </div>

      {/* Phone: fixed bar at the bottom, within thumb reach. */}
      <div className="fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-linea bg-lateral p-3 shadow-flota md:hidden">
        <Button
          variant="secondary"
          large
          onClick={() => setViewOrder(true)}
          className="flex-1 flex-col gap-0! text-base! leading-tight"
        >
          <span>{`Pedido (${order ? currentItems(order.status).reduce((n, i) => n + i.quantity - i.voidedQuantity, 0) : 0})`}</span>
          <span className="cifras font-titulo text-lg">{pesos(order?.total ?? 0)}</span>
        </Button>
        {/* With everything sent, the thumb delivers what is in the kitchen at once (ADR-015). */}
        <div className="flex-1">
          {missingOnes === 0 && canServe && inKitchen.length > 0 ? (
            <Button
              variant="success"
              large
              icon="serve"
              className="w-full"
              onClick={() =>
                serve(
                  inKitchen.map((i) => i.id),
                  `${unitsOf(inKitchen)} ${unitsOf(inKitchen) === 1 ? 'producto' : 'productos'}`,
                )
              }
            >
              {`Entregar ${unitsOf(inKitchen)}`}
            </Button>
          ) : missingOnes === 0 && withProducts ? (
            checkButton
          ) : (
            sendButton
          )}
        </div>
      </div>

      <SidePanel
        opened={viewOrder}
        title={`Pedido · ${title}`}
        onClose={() => setViewOrder(false)}
        footer={ticketFooter}
      >
        {ticket}
      </SidePanel>

      <ProductPanel
        product={selectedProduct}
        soldOutIds={soldOutIds}
        onClose={() => setSelectedProduct(null)}
        onAdd={(variantId, selectedIds, extras) => {
          if (selectedProduct) add(selectedProduct, variantId, selectedIds, extras)
          setSelectedProduct(null)
        }}
      />

      <SoldOutPanel
        product={soldOutTarget}
        soldOutIds={soldOutIds}
        onClose={() => setSoldOutTarget(null)}
        onChange={(variantId, markSoldOut) =>
          soldOutTarget && toggleSoldOut(soldOutTarget, variantId, markSoldOut)
        }
      />

      {editingNote && (
        <OrderNotePanel
          note={order?.status.notes ?? null}
          onClose={() => setEditingNote(false)}
          onSave={(note) => {
            changeOrderNote(note)
            setEditingNote(false)
          }}
        />
      )}

      {action === 'menu' && (
        <OrderActionsPanel
          withTable={order ? order.status.tableId !== null : !!tableId}
          withOrder={!!order}
          onClose={() => setAction(null)}
          onChoose={setAction}
        />
      )}
      {order && action === 'move' && (
        <MovePanel
          order={order}
          catalog={catalog}
          occupiedIds={occupiedIds}
          online={online}
          onClose={() => setAction(null)}
          onMove={moveTo}
        />
      )}
      {order?.status.tableId && action === 'table' && (
        <ChangeTablePanel
          online={online}
          catalog={catalog}
          occupiedIds={occupiedIds}
          current={[order.status.tableId, ...order.status.mergedTables]}
          onClose={() => setAction(null)}
          onChange={moveToTable}
        />
      )}
      {(order?.status.tableId ?? tableId) && action === 'merge' && (
        <MergeTablesPanel
          online={online}
          catalog={catalog}
          occupiedIds={occupiedIds}
          tableId={(order?.status.tableId ?? tableId) as string}
          merged={order?.status.mergedTables ?? []}
          onClose={() => setAction(null)}
          onSave={mergeTables}
        />
      )}
      {order && action === 'cancel' && (
        <CancelPanel
          table={title}
          withPayments={Object.values(order.status.payments).some((p) => !p.voided)}
          withPermission={permissions.includes('cancel_order')}
          online={online}
          inKitchen={currentItems(order.status).filter((i) => IN_KITCHEN.has(i.status)).length}
          onClose={() => setAction(null)}
          onCancel={cancelOrder}
        />
      )}
      {order && voiding && order.status.items[voiding] && (
        <VoidPanel
          item={order.status.items[voiding] as OrderItem}
          withPermission={permissions.includes('void_sent_item')}
          online={online}
          onClose={() => setVoiding(null)}
          onVoid={(d) => voidItem(voiding, d)}
        />
      )}

      {order && editedItem && !voiding && (
        <PanelItem
          key={editedItem.id}
          item={editedItem}
          guests={guests}
          onClose={() => setEditing(null)}
          dineIn={channel === 'dine_in'}
          onChange={(change) => changeItem(editedItem.id, change)}
          onIncrement={(delta) => increment(editedItem.id, delta)}
          coursesEnabled={coursesEnabled}
          onVoid={() => setVoiding(editedItem.id)}
          onSentNoteChange={(notes) => changeSentNote(editedItem.id, notes)}
          onDuplicate={() => {
            duplicateSelected(editedItem.id)
            setEditing(null)
          }}
          onRemove={() => {
            remove(editedItem.id)
            setEditing(null)
          }}
        />
      )}
    </FloorFrame>
  )
}

/** The product photo; if it has none, or it does not load (the hub does not respond), its icon. */
function PhotoOrIcon({ photo, icon, off }: { photo: string | null; icon: IconName; off: boolean }) {
  const [broken, setBroken] = useState(false)
  if (photo && !broken)
    return (
      <img
        src={photo}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
        className={`size-full object-cover ${off ? 'opacity-40 grayscale' : ''}`}
      />
    )
  return <Icon name={icon} className={`size-9 ${off ? 'text-alerta-texto' : 'text-texto-suave'}`} />
}

/** Without a photo, the product shows an icon: a glass if it goes out at the bar, a dish if not. */
const iconOf = (station: string): IconName => (/barra|bar|bebida/i.test(station) ? 'glass' : 'dish')

const guestName = (c: number | null) => (c === null ? 'Mesa' : `P${c}`)
const guestLabel = (c: number | null) => (c === null ? 'Mesa, para todos' : `P${c}, persona ${c}`)
const peopleFor = (guests: number) => [null, ...Array.from({ length: guests }, (_, i) => i + 1)]
/** What gets tapped most when seating a table; more than 6 is raised with + in the order. */
const QUICK_GUEST_COUNTS = [1, 2, 3, 4, 5, 6]

/** Who it is for and which course what gets added goes in: it applies to what comes next. */
function SelectFor({
  guests,
  askGuestCount,
  guest,
  course,
  coursesEnabled,
  onChooseGuest,
  onChooseCourse,
  onGuestCount,
}: {
  guests: number
  askGuestCount: boolean
  guest: number | null
  course: Course | null
  coursesEnabled: boolean
  onChooseGuest: (c: number | null) => void
  onChooseCourse: (c: Course | null) => void
  onGuestCount: (n: number) => void
}) {
  // On the phone each row is a single line that scrolls; on wide screens everything fits.
  const row = '-mx-3 flex items-center gap-2 overflow-x-auto px-3 pb-1 md:flex-wrap'
  return (
    <div className="mt-3 flex flex-col gap-2">
      {askGuestCount && (
        <Group label="Cuántas personas hay en la mesa" className={row}>
          <span className="shrink-0 font-semibold text-texto-suave">¿Cuántas personas?</span>
          {QUICK_GUEST_COUNTS.map((n) => (
            <Option key={n} selected={false} onChoose={() => onGuestCount(n)}>
              {String(n)}
            </Option>
          ))}
        </Group>
      )}
      {guests > 0 && (
        <Group label="Para quién es lo que agregues" className={row}>
          <span className="shrink-0 font-semibold text-texto-suave">Para</span>
          {peopleFor(guests).map((c) => (
            <Option
              key={c ?? 'table'}
              selected={guest === c}
              onChoose={() => onChooseGuest(c)}
              label={guestLabel(c)}
            >
              {guestName(c)}
            </Option>
          ))}
        </Group>
      )}
      {coursesEnabled && (
        <Group label="En qué curso va lo que agregues" className={row}>
          <span className="shrink-0 font-semibold text-texto-suave">Curso</span>
          {COURSES.map((c) => (
            <Option
              key={c.course ?? 'ninguno'}
              selected={course === c.course}
              onChoose={() => onChooseCourse(c.course)}
            >
              {c.name}
            </Option>
          ))}
        </Group>
      )}
    </div>
  )
}

function Ticket({
  order,
  guests,
  dineIn,
  onGuestsChange,
  onItemTap,
  onIncrement,
  onHold,
  onFire,
  onServe,
  onEditNote,
  onActions,
}: {
  order: VisibleOrder | null
  guests: number
  dineIn: boolean
  /** One more person (1) or one fewer (-1). */
  onGuestsChange: (delta: number) => void
  onItemTap: (item: OrderItem) => void
  onIncrement: (item: OrderItem, delta: number) => void
  onHold: (course: Course) => void
  onFire: (course: Course) => void
  /** Without the mark permission, the deliver buttons are not shown. */
  onServe: ((ids: string[], what: string) => void) | null
  onEditNote: () => void
  /** Change table, merge, move and cancel; with no order yet, nothing. */
  onActions: (() => void) | null
}) {
  const items = order ? currentItems(order.status) : []
  const toServe = items.filter((i) => IN_KITCHEN.has(i.status))
  const byCourse = COURSES.map((c) => ({
    ...c,
    items: items.filter((i) => i.course === c.course),
  })).filter((c) => c.items.length > 0)
  const waitingCount = items.filter((i) => i.status === 'held').length
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Outside dine-in, people are not counted. */}
      {dineIn && (
        <div className="flex items-center gap-2 border-b border-linea p-3">
          <Icon name="people" />
          <span className="font-semibold">
            {guests === 0
              ? 'Sin contar personas'
              : `${guests} ${guests === 1 ? 'persona' : 'personas'}`}
          </span>
          <Button
            variant="ghost"
            icon="minus"
            aria-label="Una persona menos"
            disabled={guests <= 0}
            onClick={() => onGuestsChange(-1)}
          />
          <Button
            variant="ghost"
            icon="more"
            aria-label="Una persona más"
            disabled={guests >= 200}
            onClick={() => onGuestsChange(1)}
          />
        </div>
      )}
      {onActions && (
        <button
          type="button"
          onClick={onActions}
          className="flex min-h-12 w-full items-center gap-2 border-b border-linea px-4 py-2 text-left font-semibold hover:bg-superficie-2 focus-visible:outline-3 focus-visible:outline-foco"
        >
          <Icon name="table" className="size-5 shrink-0" />
          Mesa y pedido
          <span className="ml-auto text-sm font-normal text-texto-suave">
            Cambiar, unir, mover, cancelar
          </span>
        </button>
      )}
      <button
        type="button"
        onClick={onEditNote}
        className="flex min-h-12 w-full items-start gap-2 border-b border-linea px-4 py-2 text-left hover:bg-superficie-2 focus-visible:outline-3 focus-visible:outline-foco"
      >
        <Icon name="pencil" className="mt-0.5 size-5 shrink-0" />
        {order?.status.notes ? (
          <span>
            <span className="block text-sm text-texto-suave">Nota del pedido</span>
            <span className="font-semibold">{order.status.notes}</span>
          </span>
        ) : (
          <span className="font-semibold text-accion-texto">Nota del pedido</span>
        )}
      </button>
      <div className="flex-1 overflow-y-auto">
        {items.length === 0 && (
          <p className="p-6 text-center text-texto-suave">Toca un producto para agregarlo.</p>
        )}
        {order &&
          byCourse.map((c) => {
            const heldCourses = c.items.filter((i) => i.status === 'held').length
            const pendingList = c.items.filter((i) => i.status === 'pending').length
            return (
              <section key={c.course ?? 'ninguno'} aria-label={c.name}>
                {(byCourse.length > 1 || c.course !== null) && (
                  <div className="flex min-h-12 items-center justify-between gap-2 bg-superficie-2/60 px-4">
                    <span className="font-semibold">
                      {c.name}
                      {heldCourses > 0 && (
                        <span className="font-normal text-proceso-texto"> · espera</span>
                      )}
                    </span>
                    {c.course !== null && heldCourses > 0 && (
                      <Button variant="main" onClick={() => onFire(c.course as Course)}>
                        {`Marchar ${heldCourses}`}
                      </Button>
                    )}
                    {c.course !== null && heldCourses === 0 && pendingList > 0 && (
                      <Button onClick={() => onHold(c.course as Course)}>Retener</Button>
                    )}
                  </div>
                )}
                <ul>
                  {c.items.map((i) => (
                    <TicketLine
                      key={i.id}
                      order={order}
                      item={i}
                      onTap={() => onItemTap(i)}
                      onIncrement={(delta) => onIncrement(i, delta)}
                      onServe={
                        onServe && IN_KITCHEN.has(i.status) ? () => onServe([i.id], i.name) : null
                      }
                    />
                  ))}
                </ul>
              </section>
            )
          })}
      </div>
      {onServe && toServe.length > 1 && (
        <div className="border-t border-linea px-3 pt-3">
          <Button
            icon="serve"
            className="w-full"
            onClick={() =>
              onServe(
                toServe.map((i) => i.id),
                `${unitsOf(toServe)} productos`,
              )
            }
          >
            {`Todo entregado (${unitsOf(toServe)})`}
          </Button>
        </div>
      )}
      {waitingCount > 0 && (
        <p className="border-t border-linea px-3 pt-2 text-sm text-proceso-texto">
          {`${waitingCount} ${waitingCount === 1 ? 'espera' : 'esperan'} su curso: «Enviar» no ${waitingCount === 1 ? 'lo manda' : 'los manda'}; sale${waitingCount === 1 ? '' : 'n'} al tocar «Marchar».`}
        </p>
      )}
      <div className="flex flex-col gap-1 border-t border-linea px-4 py-3">
        <div className="flex justify-between text-sm text-texto-suave">
          <span>Productos</span>
          <span className="cifras">
            {items.reduce((total, i) => total + i.quantity - i.voidedQuantity, 0)}
          </span>
        </div>
        <div className="cifras flex items-baseline justify-between">
          <span className="text-lg font-semibold">Total</span>
          <span className="text-2xl font-bold">{pesos(order?.total ?? 0)}</span>
        </div>
      </div>
    </div>
  )
}

function TicketLine({
  order,
  item: i,
  onTap,
  onIncrement,
  onServe,
}: {
  order: VisibleOrder
  item: OrderItem
  onTap: () => void
  onIncrement: (delta: number) => void
  onServe: (() => void) | null
}) {
  const unsent = i.status === 'pending' || i.status === 'held'
  const pendingConfirmation = order.itemsToConfirm.has(i.id)
  return (
    <li className="flex min-h-14 items-center gap-1 border-b border-linea pr-2">
      <button
        type="button"
        onClick={onTap}
        className="flex min-h-14 flex-1 items-start gap-3 px-3 py-2 text-left hover:bg-superficie-2 focus-visible:outline-3 focus-visible:outline-foco"
      >
        <span className="cifras w-6 font-semibold">{i.quantity - i.voidedQuantity}</span>
        <span className="flex-1">
          <span className="font-semibold">{i.name}</span>
          {i.modifiers.length > 0 && (
            <span className="block text-sm font-semibold text-proceso-texto">
              {i.modifiers.map((m) => m.name).join(' · ')}
            </span>
          )}
          {i.notes && <span className="block text-sm font-semibold">«{i.notes}»</span>}
          {unsent && !i.notes && (
            <span className="flex items-center gap-1 whitespace-nowrap text-sm text-accion-texto">
              <Icon name="pencil" className="size-4" />
              Toca para nota
            </span>
          )}
          <span className="flex flex-wrap items-center gap-1 text-sm text-texto-suave">
            {[
              ...(i.guest === null ? [] : [guestName(i.guest)]),
              STATUS_TEXT[i.status] ?? i.status,
            ].join(' · ')}
            {pendingConfirmation && (
              <>
                {' · '}
                <Icon name="clock" className="size-4" />
                sin confirmar
              </>
            )}
          </span>
        </span>
        <span className="cifras">{pesos(itemTotals(order.status, i).net)}</span>
      </button>
      {unsent && (
        <>
          <Button
            variant="ghost"
            icon="minus"
            aria-label={i.quantity === 1 ? `Quitar ${i.name}` : `Uno menos de ${i.name}`}
            onClick={() => onIncrement(-1)}
          />
          <Button
            variant="ghost"
            icon="more"
            aria-label={`Uno más de ${i.name}`}
            disabled={i.quantity >= MAX_PER_LINE}
            onClick={() => onIncrement(1)}
          />
        </>
      )}
      {onServe && (
        <Button
          variant={i.status === 'ready' ? 'success' : 'secondary'}
          icon="serve"
          aria-label={`Entregar: ${i.name}`}
          className="px-3"
          onClick={onServe}
        >
          Entregar
        </Button>
      )}
    </li>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4 flex flex-col gap-2">
      <p className="font-semibold">{title}</p>
      {children}
    </div>
  )
}

function Quantity({
  value,
  onChange,
  minimum = 1,
}: {
  value: number
  onChange: (n: number) => void
  minimum?: number
}) {
  return (
    <div className="flex items-center gap-2">
      <Button
        icon="minus"
        aria-label="Uno menos"
        disabled={value <= minimum}
        onClick={() => onChange(value - 1)}
      />
      <output className="cifras w-10 text-center text-xl font-semibold">{value}</output>
      <Button
        icon="more"
        aria-label="Uno más"
        disabled={value >= MAX_PER_LINE}
        onClick={() => onChange(value + 1)}
      />
    </div>
  )
}

const noteClass =
  'rounded-xl border border-borde bg-superficie px-3 py-2 text-lg focus-visible:outline-3 focus-visible:outline-foco'

/**
 * Size, options, quantity and note of a product. If there is only one thing to choose, tapping it
 * adds it right away.
 */
function ProductPanel({
  product,
  soldOutIds,
  onClose,
  onAdd,
}: {
  product: CatalogProduct | null
  soldOutIds: Set<string>
  onClose: () => void
  onAdd: (
    variantId: string | null,
    selectedIds: Record<string, string[]>,
    extras: { quantity: number; notes: string },
  ) => void
}) {
  const [variantId, setVariantId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Record<string, string[]>>({})
  const [quantity, setQuantity] = useState(1)
  const [notes, setNotes] = useState('')
  const [openFor, setOpenFor] = useState<string | null>(null)

  // When opening with another product, everything starts from scratch.
  if (product && openFor !== product.id) {
    setOpenFor(product.id)
    setVariantId(null)
    setSelectedIds({})
    setQuantity(1)
    setNotes('')
  }
  if (!product) return null

  const [single, ...others] = product.groups
  const onlyOne =
    (product.variants.length > 0 && !single) ||
    (product.variants.length === 0 &&
      others.length === 0 &&
      single?.minimum === 1 &&
      single.maximum === 1)
  const missingOnes = missingSelection(product, variantId, selectedIds)
  const price = selectedPrice(product, variantId, selectedIds)
  const soldOutVariant = (id: string) => soldOutIds.has(soldOutKey(product.id, id))

  const close = () => {
    setOpenFor(null)
    onClose()
  }
  const addWith = (v: string | null, e: Record<string, string[]>) => {
    setOpenFor(null)
    onAdd(v, e, { quantity, notes })
  }
  const tapOption = (groupId: string, maximum: number, optionId: string) => {
    const currentChecks = selectedIds[groupId] ?? []
    const newOnes = currentChecks.includes(optionId)
      ? currentChecks.filter((o) => o !== optionId)
      : maximum === 1
        ? [optionId]
        : currentChecks.length < maximum
          ? [...currentChecks, optionId]
          : currentChecks
    const allRows = { ...selectedIds, [groupId]: newOnes }
    if (onlyOne) addWith(null, allRows)
    else setSelectedIds(allRows)
  }

  return (
    <SidePanel
      opened
      title={product.name}
      onClose={close}
      footer={
        <Button
          variant="main"
          large
          className="w-full"
          disabled={missingOnes.length > 0}
          onClick={() => addWith(variantId, selectedIds)}
        >
          {missingOnes.length > 0
            ? `Elige ${missingOnes[0]}`
            : `Agregar ${quantity > 1 ? `${quantity} · ` : '· '}${pesos(price * quantity)}`}
        </Button>
      }
    >
      {product.description && <p className="mb-4 text-texto-suave">{product.description}</p>}
      {onlyOne && (
        <p className="mb-3 text-texto-suave">
          Toca una opción y queda agregada. Si quieres cantidad o nota, cámbialas antes.
        </p>
      )}
      {product.variants.length > 0 && (
        <Group label="Tamaño" className="mb-4 flex flex-col gap-2">
          <p className="font-semibold">Tamaño</p>
          {product.variants.map((v) =>
            soldOutVariant(v.id) ? (
              <p
                key={v.id}
                className="flex min-h-14 items-center rounded-xl border-2 border-dashed border-alerta-fuerte px-3 text-alerta-texto"
              >
                {`${v.name} · agotado`}
              </p>
            ) : (
              <Option
                key={v.id}
                shape="card"
                selected={v.id === variantId}
                detail={pesos(v.price)}
                onChoose={() => (onlyOne ? addWith(v.id, selectedIds) : setVariantId(v.id))}
              >
                {v.name}
              </Option>
            ),
          )}
        </Group>
      )}
      {product.groups.map((g) => (
        <Group key={g.id} label={g.name} className="mb-4 flex flex-col gap-2">
          <p className="font-semibold">
            {g.name}
            {g.minimum > 0 && <span className="font-normal text-texto-suave"> (obligatorio)</span>}
            {g.maximum > 1 && (
              <span className="font-normal text-texto-suave">{` · hasta ${g.maximum}`}</span>
            )}
          </p>
          {g.options.map((o) => (
            <Option
              key={o.id}
              shape="card"
              selected={selectedIds[g.id]?.includes(o.id) ?? false}
              detail={o.extraPrice > 0 ? `+ ${pesos(o.extraPrice)}` : undefined}
              onChoose={() => tapOption(g.id, g.maximum, o.id)}
            >
              {o.name}
            </Option>
          ))}
        </Group>
      ))}
      <Section title="Cantidad">
        <Quantity value={quantity} onChange={setQuantity} />
      </Section>
      <label className="flex flex-col gap-1">
        <span className="font-semibold">Nota para cocina (opcional)</span>
        <textarea
          rows={2}
          maxLength={200}
          value={notes}
          placeholder="Sin cebolla, salsa aparte…"
          onChange={(e) => setNotes(e.target.value)}
          className={noteClass}
        />
      </label>
    </SidePanel>
  )
}

/** An order line: quantity, who it is for, course and note if not sent yet; duplicate or remove. */
function PanelItem({
  item,
  guests,
  dineIn,
  onClose,
  onChange,
  onIncrement,
  coursesEnabled,
  onVoid,
  onSentNoteChange,
  onDuplicate,
  onRemove,
}: {
  item: OrderItem
  guests: number
  dineIn: boolean
  coursesEnabled: boolean
  onClose: () => void
  onChange: (change: {
    guest?: number | null
    course?: Course | null
    notes?: string | null
  }) => void
  onIncrement: (delta: number) => void
  /** Already sent: void with a reason (and PIN if needed). */
  onVoid: () => void
  /** Already sent: change its note; the kitchen gets «CAMBIO». */
  onSentNoteChange: (notes: string | null) => void
  onDuplicate: () => void
  onRemove: () => void
}) {
  const unsent = item.status === 'pending' || item.status === 'held'
  const [notes, setNotes] = useState(item.notes ?? '')
  /**
   * The note is applied when the panel closes (or when picking a person or course). If it is for
   * a single unit, it is written that way in the note («1 sin hielo»): the owner prefers it to
   * splitting the line.
   */
  const saveNote = () => {
    const newOne = notes.trim() || null
    if (newOne === item.notes) return
    if (unsent) onChange({ notes: newOne })
    // Already sent and not delivered: what was written is not lost on close, it goes to the
    // kitchen as «CAMBIO».
    else if (item.status !== 'served' && item.status !== 'voided') onSentNoteChange(newOne)
  }
  const close = () => {
    saveNote()
    onClose()
  }
  // Who it is for and course are a single choice: tapping it closes the panel.
  const select = (change: { guest?: number | null; course?: Course | null }) => {
    saveNote()
    onChange(change)
    onClose()
  }
  return (
    <SidePanel
      opened
      title={item.name}
      onClose={close}
      footer={
        <div className="flex gap-2">
          <Button
            large
            className="flex-1"
            onClick={() => {
              saveNote()
              onDuplicate()
            }}
          >
            Duplicar
          </Button>
          {unsent && (
            <Button large className="flex-1" onClick={onRemove}>
              Quitar
            </Button>
          )}
          {!unsent && item.status !== 'voided' && (
            <Button variant="danger" large className="flex-1" onClick={onVoid}>
              Anular
            </Button>
          )}
        </div>
      }
    >
      {!unsent && item.status === 'served' && (
        <p className="rounded-xl bg-neutro-suave p-3 text-neutro-texto">
          Ya se entregó en la mesa. Si hay que anularlo, toca «Anular».
        </p>
      )}
      {!unsent && item.status !== 'served' && (
        <div className="flex flex-col gap-4">
          <p className="rounded-xl bg-neutro-suave p-3 text-neutro-texto">
            Ya salió a cocina. Si cambias la nota, la cocina recibe una comanda «CAMBIO».
          </p>
          <label className="flex flex-col gap-1">
            <span className="font-semibold">Nota para cocina</span>
            <textarea
              rows={2}
              maxLength={200}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className={noteClass}
            />
          </label>
          <Button disabled={(notes.trim() || null) === item.notes} onClick={close}>
            Enviar el cambio a cocina
          </Button>
        </div>
      )}
      {unsent && (
        <>
          <Section title="Cantidad">
            <Quantity value={item.quantity} onChange={(n) => onIncrement(n - item.quantity)} />
          </Section>
          {dineIn && guests > 0 && (
            <Group label="Para quién" className="mb-4 flex flex-wrap items-center gap-2">
              <p className="w-full font-semibold">Para quién</p>
              {peopleFor(guests).map((c) => (
                <Option
                  key={c ?? 'table'}
                  selected={item.guest === c}
                  onChoose={() => select({ guest: c })}
                  label={guestLabel(c)}
                >
                  {guestName(c)}
                </Option>
              ))}
            </Group>
          )}
          {coursesEnabled && (
            <Group label="Curso" className="mb-4 flex flex-wrap items-center gap-2">
              <p className="w-full font-semibold">Curso</p>
              {COURSES.map((c) => (
                <Option
                  key={c.course ?? 'ninguno'}
                  selected={item.course === c.course}
                  onChoose={() => select({ course: c.course })}
                >
                  {c.name}
                </Option>
              ))}
            </Group>
          )}
          <label className="flex flex-col gap-1">
            <span className="font-semibold">Nota para cocina</span>
            <textarea
              rows={2}
              maxLength={200}
              value={notes}
              placeholder={
                item.quantity - item.voidedQuantity > 1
                  ? '1 sin hielo, salsa aparte…'
                  : 'Sin hielo, salsa aparte…'
              }
              onChange={(e) => setNotes(e.target.value)}
              className={noteClass}
            />
          </label>
        </>
      )}
    </SidePanel>
  )
}

/** The note for the whole order: allergies, celebrations, «todo junto». It goes on every ticket. */
function OrderNotePanel({
  note,
  onClose,
  onSave,
}: {
  note: string | null
  onClose: () => void
  onSave: (note: string | null) => void
}) {
  const [text, setText] = useState(note ?? '')
  const newOne = text.trim() || null
  return (
    <SidePanel
      opened
      title="Nota del pedido"
      onClose={onClose}
      footer={
        <Button variant="main" large className="w-full" onClick={() => onSave(newOne)}>
          {newOne === null && note !== null ? 'Quitar la nota' : 'Guardar'}
        </Button>
      }
    >
      <label className="flex flex-col gap-1">
        <span className="font-semibold">Para cocina y barra, en cada comanda</span>
        <textarea
          rows={3}
          maxLength={300}
          value={text}
          placeholder="Alérgico al maní, cumpleaños, todo junto…"
          // biome-ignore lint/a11y/noAutofocus: the panel opens only to write the note
          autoFocus
          onChange={(e) => setText(e.target.value)}
          className={noteClass}
        />
      </label>
      <p className="mt-2 text-sm text-texto-suave">
        Sale en cada comanda que envíes. Si ya hay platos en cocina, la nota nueva sale además en
        papel a cada estación que tenga algo pendiente.
      </p>
    </SidePanel>
  )
}

/** Sold out for a product with sizes: the whole product or just one (the bottle, not the glass). */
function SoldOutPanel({
  product,
  soldOutIds,
  onClose,
  onChange,
}: {
  product: CatalogProduct | null
  soldOutIds: Set<string>
  onClose: () => void
  onChange: (variantId: string | null, markSoldOut: boolean) => void
}) {
  if (!product) return null
  const everything = soldOutIds.has(soldOutKey(product.id))
  // With the whole product sold out, the sizes are not touched separately.
  const options = [
    { id: null, name: 'Todo el producto' },
    ...(everything ? [] : product.variants.map((v) => ({ id: v.id, name: v.name }))),
  ]
  return (
    <SidePanel opened title={`Agotar ${product.name}`} onClose={onClose}>
      <p className="mb-4 text-texto-suave">
        Toca lo que se acabó; tócalo otra vez cuando vuelva a haber.
      </p>
      <Group label="Qué se acabó" className="flex flex-col gap-2">
        {options.map((o) => {
          const alreadySoldOut = soldOutIds.has(soldOutKey(product.id, o.id))
          return (
            <Option
              key={o.id ?? 'everything'}
              shape="card"
              selected={alreadySoldOut}
              detail={alreadySoldOut ? 'agotado' : 'disponible'}
              onChoose={() => onChange(o.id, !alreadySoldOut)}
            >
              {o.name}
            </Option>
          )
        })}
      </Group>
    </SidePanel>
  )
}
