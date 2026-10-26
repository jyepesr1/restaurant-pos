import { newId } from '@pos/core'
import type { SqlValue } from '@pos/db'
import { readEscpos } from '@pos/printing'
import { HubSync } from '@pos/sync'
import { SqliteStore } from '@pos/sync/sqlite'
import { item, OPEN_ORDER } from '../access/hub-setup'
import { insertVersioned, SYSTEM } from '../access/records'
import { setupAccess } from '../access/setup'
import { createAppServer } from '../server'
import { PrintQueue, type QueueOptions } from './queue'
import { jobsForEvent } from './tickets'
import { PrinterError, type Send, type Target } from './transport'

// Test setup for task 1.4 (ADR-015): the hub with access, a network of fake printers (no
// sockets, at will: on, off, slow), the print queue with a manual clock, the `HubSync` with the
// ticket hook and the HTTP server with the printing routes.
// Tests only.

/** A printer on the fake network: keeps what it receives and can be turned off. */
export interface Paper {
  address: string
  off: boolean
  /** What was received, one job per entry. */
  received: Uint8Array[]
  /** How many times it was attempted (including failed ones). */
  attempts: number
  /** What was received, already read as text (one ticket per entry). */
  texts(): string[]
}

export type Device = ReturnType<ReturnType<typeof setupPrinting>['device']>

export interface SetupOptions {
  /** Changes how the bytes are sent (for example, to make it slow). */
  send?: (base: Send) => Send
  /** The hub's `onSave` hook: by default, the hub's real one (`jobsForEvent`). */
  timeZone?: string
  allowLocal?: boolean
  isHubDevice?: (ip: string) => boolean
}

export function setupPrinting(options: SetupOptions = {}) {
  const m = setupAccess()
  const timeZone = options.timeZone ?? 'America/Bogota'
  const now = m.clock()
  const station = (name: string, position: number) =>
    insertVersioned(m.db, 'stations', m.restaurantId, { name, position }, SYSTEM, now)
  const kitchen = station('Cocina', 1)
  const bar = station('Barra', 2)
  const desserts = station('Postres', 3)

  const location = String(
    m.db.prepare('SELECT id FROM locations WHERE restaurant_id = ?').get(m.restaurantId)?.id,
  )
  const zone = insertVersioned(
    m.db,
    'zones',
    m.restaurantId,
    { location_id: location, name: 'Salón', position: 1, level: 1 },
    SYSTEM,
    now,
  )
  const table = (name: string) =>
    insertVersioned(
      m.db,
      'dining_tables',
      m.restaurantId,
      { zone_id: zone, name, shape: 'square', x: 0, y: 0, width: 1, height: 1, capacity: 4 },
      SYSTEM,
      now,
    )

  // ── The fake printer network ───────────────────────────────────────
  const network = new Map<string, Paper>()
  let counter = 0
  const paper = (address: string): Paper => {
    const p: Paper = {
      address,
      off: false,
      received: [],
      attempts: 0,
      texts: () => p.received.map((b) => readEscpos(b).text),
    }
    network.set(address, p)
    return p
  }
  const base: Send = async (target: Target, bytes: Uint8Array) => {
    const p = network.get(target.address)
    if (p) p.attempts += 1
    if (!p || p.off)
      throw new PrinterError(
        'La impresora rechazó la conexión: revisa el puerto (casi siempre 9100).',
      )
    p.received.push(bytes)
  }
  const sendBytes = options.send ? options.send(base) : base

  const newPrinter = (name: string, stations: string[], fields: Record<string, SqlValue> = {}) => {
    counter += 1
    const address = `10.0.0.${counter}`
    const p = paper(address)
    const id = insertVersioned(
      m.db,
      'printers',
      m.restaurantId,
      {
        name,
        connection: 'network',
        address,
        port: 9100,
        width: 80,
        code_page: 'pc850',
        station_ids: JSON.stringify(stations),
        ...fields,
      },
      SYSTEM,
      m.clock(),
    )
    return { id, paper: p, address }
  }

  // ── Queue and hub ──────────────────────────────────────────────────
  const notifiedStatuses: unknown[][] = []
  const queueFailures: unknown[] = []
  const clock = () => Date.parse(m.clock())
  const createQueue = (extra: Partial<QueueOptions> = {}) =>
    new PrintQueue({
      db: m.db,
      restaurantId: m.restaurantId,
      send: sendBytes,
      clock,
      onChange: (e) => notifiedStatuses.push(e),
      onFailure: (e) => queueFailures.push(e),
      ...extra,
    })
  const queue = createQueue()

  const ticketOptions = { db: m.db, restaurantId: m.restaurantId, timeZone }
  const saveFailures: { error: unknown; id: string }[] = []
  const createHub = () =>
    new HubSync(new SqliteStore(m.db, m.restaurantId), {
      restaurantId: m.restaurantId,
      timeZone,
      businessDayStart: '06:00',
      instance: 'hub-1',
      clock: m.clock,
      access: m.access,
      onSave: (event, changes) => {
        jobsForEvent(ticketOptions, event, changes)
      },
      onSaveFailure: (error, id) => saveFailures.push({ error, id }),
    })
  const hub = createHub()

  // ── HTTP server ────────────────────────────────────────────────────
  const catalogChanges: number[] = []
  const app = createAppServer({
    access: m.access,
    catalog: {
      db: m.db,
      restaurantId: m.restaurantId,
      access: m.access,
      clock: m.clock,
      onChange: (v) => catalogChanges.push(v),
    },
    printOptions: {
      db: m.db,
      restaurantId: m.restaurantId,
      access: m.access,
      queue,
      timeZone,
      onChange: (v) => catalogChanges.push(v),
      clock: m.clock,
      allowLocal: options.allowLocal,
      isHubDevice: options.isHubDevice,
    },
  })
  const post = (url: string, body: unknown, token?: string) =>
    app.inject({
      method: 'POST',
      url,
      payload: body as object,
      remoteAddress: '10.0.0.20',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })

  // ── Devices ────────────────────────────────────────────────────────
  /** A paired device with someone signed in; it can send events to the hub. */
  function device(
    who: keyof typeof m.people = 'waiter',
    type: 'waiter' | 'register' | 'kds' = 'waiter',
  ) {
    const { token, connection } = m.pair(type)
    const session = m.signIn(connection, who)
    const sessionBody = { session_id: session.sessionId, secret: session.secret }
    const maxSequence = () =>
      Number(
        m.db
          .prepare('SELECT coalesce(max(sequence), 0) AS s FROM events WHERE restaurant_id = ?')
          .get(m.restaurantId)?.s,
      )
    /** Sends an event and returns how it went. */
    const submit = (
      order: string,
      type: string,
      data: unknown,
      extras: Record<string, unknown> = {},
      target: HubSync = hub,
    ) => {
      const r = target.receiveBatch(connection, [
        m.event(connection, session, type, data, {
          aggregate_id: order,
          base_sequence: maxSequence(),
          ...(type === 'ItemVoided' ? { reason: 'El cliente se arrepintió' } : {}),
          ...extras,
        } as never),
      ])
      return {
        status: r.results[0]?.status,
        result: r.results[0],
        accepted: r.acceptedEvents[0],
      }
    }
    return { token, connection, session, sessionBody, submit }
  }

  type Product = {
    name: string
    station: string
    options?: string[]
    course?: 'entry' | 'main' | 'dessert' | null
    notes?: string | null
    guest?: number | null
    quantity?: number
  }

  /** Opens an empty order. */
  function open(e: Device, tableId: string | null = null, channel = 'dine_in') {
    const order = newId()
    const opened = e.submit(order, 'OrderOpened', { ...OPEN_ORDER, channel, table_id: tableId })
    if (opened.status !== 'confirmed')
      throw new Error(`Did not open: ${JSON.stringify(opened.result)}`)
    return order
  }

  /** Adds a product to an order. */
  function add(e: Device, order: string, p: Product) {
    const it = {
      ...item((p.options ?? []).map((n) => ({ modifier_id: newId(), name: n, extra_price: 0 }))),
      name: p.name,
      course: p.course ?? null,
      notes: p.notes ?? null,
      guest: p.guest ?? null,
      quantity: p.quantity ?? 1,
    }
    const r = e.submit(order, 'ItemAdded', it)
    if (r.status !== 'confirmed') throw new Error(`Did not add: ${JSON.stringify(r.result)}`)
    return { id: it.item_id, station: p.station, name: p.name }
  }

  /** An order with products already added (not sent). */
  function orderWith(
    e: Device,
    products: Product[],
    tableId: string | null = null,
    channel = 'dine_in',
  ) {
    const order = open(e, tableId, channel)
    return { order, items: products.map((p) => add(e, order, p)) }
  }

  /** Sends the given items; `byStation` builds one ticket per station. */
  function send(e: Device, order: string, items: { id: string; station: string }[]) {
    const byStation = new Map<string, string[]>()
    for (const i of items) byStation.set(i.station, [...(byStation.get(i.station) ?? []), i.id])
    const tickets = [...byStation].map(([station_id, item_ids]) => ({
      ticket_id: newId(),
      station_id,
      item_ids,
    }))
    const r = e.submit(order, 'ItemsSent', { tickets })
    return { ...r, tickets }
  }

  const jobs = (filter = '') =>
    m.db.prepare(`SELECT * FROM print_jobs ${filter} ORDER BY created_at, id`).all() as Record<
      string,
      SqlValue
    >[]
  const pendingList = () => jobs("WHERE status = 'pending'").length
  const content = (row: Record<string, SqlValue> | undefined) =>
    JSON.parse(String(row?.content ?? 'null'))

  return {
    ...m,
    timeZone,
    kitchen,
    bar,
    desserts,
    zone,
    table,
    location,
    network,
    paper,
    newPrinter,
    queue,
    createQueue,
    notifiedStatuses,
    queueFailures,
    hub,
    createHub,
    saveFailures,
    ticketOptions,
    app,
    post,
    catalogChanges,
    device,
    open,
    add,
    orderWith,
    send,
    jobs,
    pendingList,
    content,
    clock,
  }
}

export type PrintingSetup = ReturnType<typeof setupPrinting>
