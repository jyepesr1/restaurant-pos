import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fullConfig, newId } from '@pos/core'
import { applyMigrations, type SqliteDatabase } from '@pos/db'
import { openDatabase } from '@pos/db/node'
import { type ConfigHub, FloorSync, HubSync } from '@pos/sync'
import { SqliteStore } from '@pos/sync/sqlite'
import { Attempts } from './access/attempts'
import { type Admin, ensureAdmin, ensureRestaurant, ensureRoles } from './access/initial'
import { loadKey } from './access/secrets'
import { AccessService } from './access/service'
import { priceChecker } from './prices'

// What the hub and the seed do at startup: open the database in the data folder and prepare
// access. One folder, one process: the database is opened exclusively.

/** Data folder: `DATA_DIR` or `apps/hub/data`. */
export const dataDirOf = (environment: NodeJS.ProcessEnv = process.env) =>
  environment.DATA_DIR || fileURLToPath(new URL('../data', import.meta.url))

/** Opens the database exclusively and migrates it to the latest version; returns those applied. */
export function openData(dataDir: string): { db: SqliteDatabase; appliedMigrations: number[] } {
  mkdirSync(dataDir, { recursive: true })
  const db = openDatabase(join(dataDir, 'pos.sqlite'), { exclusive: true })
  return { db, appliedMigrations: applyMigrations(db) }
}

/** Restaurant, roles, admin and the PIN key (tasks 0.7 and 1.3b). */
export function prepareAccess(
  db: SqliteDatabase,
  dataDir: string,
  onNotify: (alert: string) => void = () => {},
  onRevoke?: (deviceId: string, revokedAt: string) => void,
) {
  const { key, newOne, createdAt } = loadKey(dataDir)
  const now = new Date().toISOString()
  const restaurantId = ensureRestaurant(db, now)
  const roles = ensureRoles(db, restaurantId, now)
  const attempts = new Attempts(Date.now, onNotify)
  const access = new AccessService({
    db,
    restaurantId,
    key,
    attempts,
    keyFrom: createdAt,
    onRevoke,
  })
  const admin = ensureAdmin(db, access, roles.admin, newOne)
  return { access, restaurantId, roles, admin, alerts: admin.alerts }
}

/** What is new for the admin, to show once; empty if there is nothing new. */
export function adminLines(admin: Admin): string[] {
  return [
    ...(admin.user ? [`  Usuario:          ${admin.user}`] : []),
    ...(admin.password ? [`  Contraseña:       ${admin.password}`] : []),
    ...(admin.pin ? [`  PIN para autorizar: ${admin.pin}`] : []),
  ]
}

/**
 * Shows newly created PINs and passwords only once: the hub stores only their fingerprint. If the
 * output is not a window (the Windows service sends it to a log file), they go to a separate
 * file, readable only by the hub, to be read and deleted.
 */
export function showPins(
  dataDir: string,
  pins: {
    /** What is written to the window. */
    consoleLines: readonly string[]
    file: string
    content: string
    /** What to say in the log if they go to the file. */
    alert: (route: string) => string
  },
  inWindow = process.stdout.isTTY === true,
) {
  if (inWindow) {
    for (const line of pins.consoleLines) console.log(line)
    return
  }
  const route = join(dataDir, pins.file)
  writeFileSync(route, pins.content, { mode: 0o600 })
  // `mode` only applies when creating the file: if it already existed with other permissions, they
  // are adjusted.
  chmodSync(route, 0o600)
  console.log(pins.alert(route))
}

export const INSTANCE_FILE = 'hub-instance'

/**
 * The identity of this hub installation (docs/SYNC.md#fallas-y-qué-pasa). It changes on reinstall
 * or restore: a device that sees a different one resends everything it has. It lives in its own
 * file, outside the database, so restoring a database backup does not bring back the old one.
 */
export function hubInstance(dataDir: string): string {
  const route = join(dataDir, INSTANCE_FILE)
  if (existsSync(route)) {
    const saved = readFileSync(route, 'utf8').trim()
    if (saved) return saved
  }
  const newOne = newId()
  writeFileSync(route, `${newOne}\n`)
  return newOne
}

/** The time zone of the main location: the one for ticket times and the business day. */
export function timeZoneOf(db: SqliteDatabase, restaurantId: string): string {
  const location = db
    .prepare(
      'SELECT time_zone FROM locations WHERE restaurant_id = ? AND active = 1 ORDER BY created_at LIMIT 1',
    )
    .get(restaurantId)
  return String(location?.time_zone ?? 'America/Bogota')
}

/**
 * The sync hub on the restaurant database (task 0.10): events with the access control from task
 * 0.7, the location's time zone and the business day from the config.
 */
export function prepareSync(
  db: SqliteDatabase,
  dataDir: string,
  restaurantId: string,
  access: AccessService,
  onInternalError?: (error: unknown, eventId: string) => void,
  extra: Pick<ConfigHub, 'onSave' | 'onSaveFailure'> = {},
): FloorSync {
  const restaurant = db.prepare('SELECT config FROM restaurants WHERE id = ?').get(restaurantId)
  const config = fullConfig(JSON.parse(String(restaurant?.config ?? '{}')))
  const hub = new HubSync(new SqliteStore(db, restaurantId), {
    restaurantId,
    timeZone: timeZoneOf(db, restaurantId),
    businessDayStart: config.business_day_start,
    instance: hubInstance(dataDir),
    clock: () => new Date().toISOString(),
    access,
    onInternalError,
    prices: priceChecker(db, restaurantId),
    // Read on every payment: the admin can change them while the hub is running.
    checkoutRules: () => {
      const row = db.prepare('SELECT config FROM restaurants WHERE id = ?').get(restaurantId)
      const current = fullConfig(JSON.parse(String(row?.config ?? '{}')))
      return {
        multiple: current.cash_rounding,
        mode: current.cash_rounding_mode,
        methods: current.payment_methods,
        customMethods: current.custom_methods.filter((m) => m.active).map((m) => m.id),
        varianceThreshold: current.register_variance_threshold,
        cardTerminals: db
          .prepare('SELECT id FROM card_terminals WHERE restaurant_id = ? AND active = 1')
          .all(restaurantId)
          .map((f) => String(f.id)),
      }
    },
    ...extra,
  })
  return new FloorSync(hub, access.authenticate)
}
