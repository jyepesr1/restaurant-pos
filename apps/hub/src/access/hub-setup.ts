import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { authorizableFingerprint, type NewEvent, newId } from '@pos/core'
import { applyMigrations } from '@pos/db'
import { openDatabase } from '@pos/db/node'
import { type AccessControl, type Connection, HubSync } from '@pos/sync'
import { SqliteStore } from '@pos/sync/sqlite'
import { expect } from 'vitest'
import { Attempts } from './attempts'
import { ensureAdmin, ensureRestaurant, ensureRoles } from './initial'
import { loadKey } from './secrets'
import { AccessService } from './service'
import { type AccessSetup, START, setupAccess, signed } from './setup'

// Test utilities: the full sync hub on top of the access setup, and a hub on a real data folder
// that can be "shut down" and spun up again.

export const item = (
  modifiers: { modifier_id: string; name: string; extra_price: number }[] = [],
) => ({
  item_id: newId(),
  product_id: newId(),
  variant_id: null,
  name: 'Aperol Spritz',
  unit_price: 32_000,
  tax_type: 'inc' as const,
  rate: 800,
  quantity: 1,
  guest: null,
  course: null,
  modifiers,
  notes: null,
  catalog_version: 1,
  price_channel_id: null,
})

export const OPEN_ORDER = { channel: 'dine_in', table_id: null, guests: 2 }

/** The access setup with a `HubSync` on the same database. */
export function setupHub(wrap: (a: AccessControl) => AccessControl = (a) => a) {
  const m = setupAccess()
  const hub = new HubSync(new SqliteStore(m.db, m.restaurantId), {
    restaurantId: m.restaurantId,
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    instance: 'hub-1',
    clock: m.clock,
    access: wrap(m.access),
  })
  return { ...m, hub }
}
export type HubSetup = ReturnType<typeof setupHub>

/** An order opened by the waiter with one item already sent to the kitchen. */
export function orderWithSentItem(
  m: AccessSetup & { hub: HubSync },
  modifiers: { modifier_id: string; name: string; extra_price: number }[] = [],
) {
  const { connection, token } = m.pair('waiter')
  const session = m.signIn(connection, 'waiter')
  const order = newId()
  const it = item(modifiers)
  const ticketId = newId()
  const en = { aggregate_id: order }
  const r = m.hub.receiveBatch(connection, [
    m.event(connection, session, 'OrderOpened', OPEN_ORDER, en),
    m.event(connection, session, 'ItemAdded', it, { ...en, base_sequence: 1 }),
    m.event(
      connection,
      session,
      'ItemsSent',
      { tickets: [{ ticket_id: ticketId, station_id: newId(), item_ids: [it.item_id] }] },
      { ...en, base_sequence: 2 },
    ),
  ])
  expect(r.results.map((x) => x.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
  return { connection, token, session, order, itemId: it.item_id, ticketId }
}

export const voidData = (itemId: string) => ({
  item_id: itemId,
  quantity: 1,
  already_prepared: false,
  ticket_id: null,
})

type Session = Parameters<typeof signed>[0]

/** The event with that session's signature (as the app leaves it after creating it). */
export const sign = signed

/**
 * The supervisor authorizes that exact event: returns the approval and the event with its
 * `authorization_id`, already signed again.
 */
export function authorizeEvent(
  m: Pick<AccessSetup, 'access'>,
  connection: Connection,
  session: Session & { secret: string; sessionId: string },
  pin: string,
  event: NewEvent,
  action = 'void_sent_item',
) {
  const a = m.access.authorize(connection, {
    sessionId: session.sessionId,
    secret: session.secret,
    pin,
    action,
    aggregateId: event.aggregate_id,
    eventId: event.id,
    fingerprint: authorizableFingerprint(event),
  })
  if (!a.ok) throw new Error(a.message)
  return {
    approval: a,
    event: sign(session, { ...event, authorization_id: a.authorizationId }),
  }
}

export const add = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString()

/**
 * A hub on a real data folder, as `main.ts` builds it: file database and PIN key in the same
 * folder. `spinUp()` is "start the process"; `shutDown()`, a crash: memory (pairing codes,
 * attempt waits) is lost and the folder stays.
 */
export function hubInDir(dataDir: string) {
  let ms = START
  const clock = () => new Date(ms).toISOString()
  let openHandles: { close(): void }[] = []
  // The test clock is manual: the key counts from the (manual) time it was created.
  let keyFrom = ''

  function spinUp() {
    mkdirSync(dataDir, { recursive: true })
    const db = openDatabase(join(dataDir, 'pos.sqlite'))
    openHandles.push(db as unknown as { close(): void })
    applyMigrations(db)
    const { key, newOne } = loadKey(dataDir)
    if (newOne) keyFrom = clock()
    const restaurantId = ensureRestaurant(db, clock())
    const roles = ensureRoles(db, restaurantId, clock())
    const access = new AccessService({
      db,
      restaurantId,
      key,
      clock,
      attempts: new Attempts(() => ms),
      keyFrom,
      passwordCost: 1,
    })
    const admin = ensureAdmin(db, access, roles.admin, newOne)
    const hub = new HubSync(new SqliteStore(db, restaurantId), {
      restaurantId,
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      instance: 'hub-1',
      clock,
      access,
    })
    return { db, access, hub, roles, restaurantId, admin, newKey: newOne }
  }

  return {
    spinUp,
    shutDown() {
      for (const b of openHandles) b.close()
      openHandles = []
    },
    clock,
    advance: (n: number) => {
      ms += n
    },
  }
}
