import { existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentVersion, type SqliteDatabase } from '@pos/db'
import type { FloorSync } from '@pos/sync'
import { CloudConnection } from './cloud/connection'
import { readSnapshots } from './cloud/snapshots'
import { PrintQueue } from './printing/queue'
import { jobsForEvent } from './printing/tickets'
import { createAppServer } from './server'
import {
  adminLines,
  dataDirOf,
  hubInstance,
  openData,
  prepareAccess,
  prepareSync,
  showPins,
  timeZoneOf,
} from './startup'

const DEFAULT_PORT = 4000
const ADMIN_PIN_FILE = 'admin-pin.txt'
// They can be changed with environment variables; the e2e tests use their own folders so as not
// to overwrite the app or the data of a hub that is serving real phones.
const appDir = process.env.APP_DIR || fileURLToPath(new URL('../../pos/dist', import.meta.url))
const dataDir = dataDirOf()

function readPort(): number {
  const value = process.env.PORT
  if (value === undefined) return DEFAULT_PORT
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid PORT: "${value}". Use a number between 1 and 65535.`)
    process.exit(1)
  }
  return port
}

const isPrivateIp = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)

/** Private IPv4 addresses of this machine: the ones the phones should open on the local network. */
function localIps(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter(
      (network) => network?.family === 'IPv4' && !network.internal && isPrivateIp(network.address),
    )
    .map((network) => network?.address as string)
}

/** Opens the database exclusively (one hub per data folder) and brings it to the latest version. */
function prepareDatabase(): SqliteDatabase {
  try {
    const { db: base, appliedMigrations } = openData(dataDir)
    console.log(
      appliedMigrations.length > 0
        ? `Database updated to version ${currentVersion(base)}.`
        : `Database at version ${currentVersion(base)}.`,
    )
    return base
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`Could not open the hub database: ${detail}`)
    process.exit(1)
  }
}

/** Restaurant, roles, admin and the PIN key (task 0.7). */
function prepareAll(db: SqliteDatabase) {
  try {
    // The floor is created after access, but a device revocation must reach it.
    let floor: FloorSync | null = null
    // For now the alert to the admin goes to the hub window; with the register (Phase 1), to its
    // screen.
    const access = prepareAccess(
      db,
      dataDir,
      (alert) => console.warn(`⚠ Security: ${alert}`),
      (deviceId, revokedAt) => floor?.revoke(deviceId, revokedAt),
    )
    const timeZone = timeZoneOf(db, access.restaurantId)
    // Tickets left in the queue before the hub was closed are printed on startup.
    const queue = new PrintQueue({
      db,
      restaurantId: access.restaurantId,
      onChange: (statuses) => floor?.notifyPrinters(statuses),
      onFailure: (error) => console.error('The print queue failed:', error),
    })
    const tickets = { db, restaurantId: access.restaurantId, timeZone }
    // Each event the hub saves goes up to the cloud right away; without internet it waits in the
    // hub and goes up when it comes back (ADR-016).
    const cloud = new CloudConnection({
      db,
      restaurantId: access.restaurantId,
      dataDir,
      instance: hubInstance(dataDir),
      url: process.env.CLOUD_URL || undefined,
      onStatus: (status) => floor?.notifyCloud(status),
      onFailure: (error) => console.error('Uploading to the cloud failed:', error),
      // The menu, the configuration and the staff for the owner's panel (docs/PANEL.md).
      snapshots: () => readSnapshots(db, access.restaurantId),
    })
    floor = prepareSync(
      db,
      dataDir,
      access.restaurantId,
      access.access,
      (error, id) => console.error(`An event made the hub fail and was rejected (${id}):`, error),
      {
        // Inside the event's transaction; the queue starts once it has been saved.
        onSave: (event, changes) => {
          if (jobsForEvent(tickets, event, changes) > 0) setImmediate(() => queue.wake())
          setImmediate(() => cloud.uploader.wake())
        },
        onSaveFailure: (error, id) => {
          console.error(`Could not build the ticket for event ${id}:`, error)
          queue.unbuiltTicket()
        },
      },
    )
    queue.wake()
    floor.notifyCloud(cloud.status())
    cloud.uploader.wake()
    return { ...access, floor, queue, timeZone, cloud }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`Could not prepare the hub's access: ${detail}`)
    process.exit(1)
  }
}

const port = readPort()
const db = prepareDatabase()
const { access, restaurantId, floor, queue, timeZone, cloud, admin, alerts } = prepareAll(db)
const app = createAppServer({
  appDir,
  diagnostics: { dataDir },
  access,
  sync: { floor, onFailure: (error) => console.error('Sync failed:', error) },
  catalog: {
    db,
    restaurantId,
    access,
    // Menu, floor plan, staff and roles: the devices fetch them again and the cloud gets its copy.
    onChange: (version) => {
      floor.notifyCatalog(version)
      cloud.checkSnapshots()
    },
    occupiedTable: (tableId) => floor.hasOpenOrder(tableId),
    photosDir: join(dataDir, 'photos'),
  },
  printOptions: {
    db,
    restaurantId,
    access,
    queue,
    timeZone,
    // Kitchen, printers and register configuration.
    onChange: (version) => {
      floor.notifyCatalog(version)
      cloud.checkSnapshots()
    },
    allowLocal: process.env.TEST_PRINTER === '1',
    isHubDevice: (ip) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1',
  },
  cloud: { access, cloud },
  dbVersion: currentVersion(db),
  logger: true,
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    queue.stop()
    cloud.stop()
    await app.close()
    await queue.ready()
    await cloud.idle()
    db.close()
    process.exit(0)
  })
}

try {
  await app.listen({ host: '0.0.0.0', port: port })
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Is the hub already open in another window?`)
  } else {
    console.error('Could not start the hub:', error)
  }
  process.exit(1)
}

if (!existsSync(appDir)) {
  console.warn('\n⚠ The app is not built: run `pnpm --filter @pos/app build` and restart the hub.')
}

for (const alert of alerts) console.warn(`⚠ ${alert}`)
const adminData = adminLines(admin)
if (adminData.length > 0)
  showPins(dataDir, {
    consoleLines: [
      '\nAdmin (to sign in at the register):',
      ...adminData,
      'Write it down somewhere safe: it is not shown again.',
    ],
    file: ADMIN_PIN_FILE,
    content: `${adminData.join('\n')}\n`,
    alert: (route) =>
      `\nThe admin's sign-in details were saved to ${route}: write them down and delete that file.`,
  })

console.log('\nHub running. Open it on the devices on the same network:')
for (const ip of localIps()) {
  console.log(`  http://${ip}:${port}`)
}
