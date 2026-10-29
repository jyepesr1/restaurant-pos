import { existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentVersion, type SqliteDatabase } from '@pos/db'
import type { FloorSync } from '@pos/sync'
import { CloudConnection } from './cloud/connection'
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
const ADMIN_PIN_FILE = 'pin-administrador.txt'
// They can be changed with environment variables; the e2e tests use their own folders so as not
// to overwrite the app or the data of a hub that is serving real phones.
const appDir = process.env.APP_DIR || fileURLToPath(new URL('../../pos/dist', import.meta.url))
const dataDir = dataDirOf()

function readPort(): number {
  const value = process.env.PORT
  if (value === undefined) return DEFAULT_PORT
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`PUERTO inválido: "${value}". Usa un número entre 1 y 65535.`)
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
        ? `Base de datos actualizada a la versión ${currentVersion(base)}.`
        : `Base de datos en la versión ${currentVersion(base)}.`,
    )
    return base
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`No se pudo abrir la base de datos del hub: ${detail}`)
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
      (alert) => console.warn(`⚠ Seguridad: ${alert}`),
      (deviceId, revokedAt) => floor?.revoke(deviceId, revokedAt),
    )
    const timeZone = timeZoneOf(db, access.restaurantId)
    // Tickets left in the queue before the hub was closed are printed on startup.
    const queue = new PrintQueue({
      db,
      restaurantId: access.restaurantId,
      onChange: (statuses) => floor?.notifyPrinters(statuses),
      onFailure: (error) => console.error('Falló la cola de impresión:', error),
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
      onFailure: (error) => console.error('Falló la subida a la nube:', error),
    })
    floor = prepareSync(
      db,
      dataDir,
      access.restaurantId,
      access.access,
      (error, id) => console.error(`Un evento hizo fallar al hub y se rechazó (${id}):`, error),
      {
        // Inside the event's transaction; the queue starts once it has been saved.
        onSave: (event, changes) => {
          if (jobsForEvent(tickets, event, changes) > 0) setImmediate(() => queue.wake())
          setImmediate(() => cloud.uploader.wake())
        },
        onSaveFailure: (error, id) => {
          console.error(`No se pudo armar la comanda del evento ${id}:`, error)
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
    console.error(`No se pudo preparar el acceso del hub: ${detail}`)
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
  sync: { floor, onFailure: (error) => console.error('Falló la sincronización:', error) },
  catalog: {
    db,
    restaurantId,
    access,
    onChange: (version) => floor.notifyCatalog(version),
    occupiedTable: (tableId) => floor.hasOpenOrder(tableId),
    photosDir: join(dataDir, 'photos'),
  },
  printOptions: {
    db,
    restaurantId,
    access,
    queue,
    timeZone,
    onChange: (version) => floor.notifyCatalog(version),
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
    cloud.uploader.stop()
    await app.close()
    await queue.ready()
    await cloud.uploader.idle()
    db.close()
    process.exit(0)
  })
}

try {
  await app.listen({ host: '0.0.0.0', port: port })
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`El puerto ${port} ya está en uso. ¿El hub ya está abierto en otra ventana?`)
  } else {
    console.error('No se pudo iniciar el hub:', error)
  }
  process.exit(1)
}

if (!existsSync(appDir)) {
  console.warn(
    '\n⚠ Falta compilar la app: ejecuta `pnpm --filter @pos/app build` y reinicia el hub.',
  )
}

for (const alert of alerts) console.warn(`⚠ ${alert}`)
const adminData = adminLines(admin)
if (adminData.length > 0)
  showPins(dataDir, {
    consoleLines: [
      '\nAdministrador (para entrar a la caja):',
      ...adminData,
      'Anótalo en un lugar seguro: no se vuelve a mostrar.',
    ],
    file: ADMIN_PIN_FILE,
    content: `${adminData.join('\n')}\n`,
    alert: (route) =>
      `\nLos datos del administrador quedaron en ${route}: anótalos y borra ese archivo.`,
  })

console.log('\nHub en marcha. Abre en los dispositivos de la misma red:')
for (const ip of localIps()) {
  console.log(`  http://${ip}:${port}`)
}
