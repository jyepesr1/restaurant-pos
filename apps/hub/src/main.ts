import { existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentVersion, type SqliteDatabase } from '@pos/db'
import type { FloorSync } from '@pos/sync'
import {
  abrirDatos,
  dirDatosDe,
  lineasAdministrador,
  mostrarPines,
  prepararAcceso,
  prepararSincronizacion,
  zonaHorariaDe,
} from './arranque'
import { ColaImpresion } from './impresion/cola'
import { trabajosDeEvento } from './impresion/comandas'
import { crearServidor } from './servidor'

const PUERTO_POR_DEFECTO = 4000
const ARCHIVO_PIN_ADMIN = 'pin-administrador.txt'
// Se pueden cambiar con variables de entorno; las pruebas e2e usan carpetas propias para no
// pisar la app ni los datos de un hub que esté sirviendo a celulares reales.
const dirApp = process.env.DIR_APP || fileURLToPath(new URL('../../pos/dist', import.meta.url))
const dirDatos = dirDatosDe()

function leerPuerto(): number {
  const value = process.env.PORT
  if (value === undefined) return PUERTO_POR_DEFECTO
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`PUERTO inválido: "${value}". Usa un número entre 1 y 65535.`)
    process.exit(1)
  }
  return port
}

const esIpPrivada = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)

/** IPs privadas IPv4 de este equipo: las que deben abrir los celulares en la red local. */
function ipsLocales(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter(
      (network) => network?.family === 'IPv4' && !network.internal && esIpPrivada(network.address),
    )
    .map((network) => network?.address as string)
}

/** Abre la base en exclusiva (un solo hub por carpeta de datos) y la lleva a la última versión. */
function prepararBase(): SqliteDatabase {
  try {
    const { db: base, appliedMigrations } = abrirDatos(dirDatos)
    console.log(
      appliedMigrations.length > 0
        ? `Base de datos actualizada a la versión ${currentVersion(base)}.`
        : `Base de datos en la versión ${currentVersion(base)}.`,
    )
    return base
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error)
    console.error(`No se pudo abrir la base de datos del hub: ${detalle}`)
    process.exit(1)
  }
}

/** Restaurante, roles, administrador y la clave de los PIN (tarea 0.7). */
function prepararTodo(db: SqliteDatabase) {
  try {
    // La sala se crea después del acceso, pero la revocación de un equipo debe llegarle.
    let floor: FloorSync | null = null
    // Por ahora el aviso al administrador va a la ventana del hub; con la caja (Fase 1), a su pantalla.
    const access = prepararAcceso(
      db,
      dirDatos,
      (alert) => console.warn(`⚠ Seguridad: ${alert}`),
      (deviceId, revokedAt) => floor?.revoke(deviceId, revokedAt),
    )
    const timeZone = zonaHorariaDe(db, access.restaurantId)
    // Las comandas que quedaron en la cola antes de cerrar el hub salen al arrancar.
    const queue = new ColaImpresion({
      db,
      restaurantId: access.restaurantId,
      onChange: (statuses) => floor?.notifyPrinters(statuses),
      onFailure: (error) => console.error('Falló la cola de impresión:', error),
    })
    const tickets = { db, restaurantId: access.restaurantId, timeZone }
    floor = prepararSincronizacion(
      db,
      dirDatos,
      access.restaurantId,
      access.access,
      (error, id) => console.error(`Un evento hizo fallar al hub y se rechazó (${id}):`, error),
      {
        // Dentro de la transacción del evento; la cola arranca cuando ya quedó guardado.
        onSave: (event, changes) => {
          if (trabajosDeEvento(tickets, event, changes) > 0) setImmediate(() => queue.despertar())
        },
        onSaveFailure: (error, id) => {
          console.error(`No se pudo armar la comanda del evento ${id}:`, error)
          queue.comandaSinArmar()
        },
      },
    )
    queue.despertar()
    return { ...access, floor, queue, timeZone }
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error)
    console.error(`No se pudo preparar el acceso del hub: ${detalle}`)
    process.exit(1)
  }
}

const port = leerPuerto()
const db = prepararBase()
const { access, restaurantId, floor, queue, timeZone, admin, alerts } = prepararTodo(db)
const app = crearServidor({
  dirApp,
  diagnostico: { dirDatos },
  access,
  sincronizacion: { floor, onFailure: (error) => console.error('Falló la sincronización:', error) },
  catalog: {
    db,
    restaurantId,
    access,
    onChange: (version) => floor.notifyCatalog(version),
    occupiedTable: (tableId) => floor.hasOpenOrder(tableId),
    dirFotos: join(dirDatos, 'photos'),
  },
  impresion: {
    db,
    restaurantId,
    access,
    queue,
    timeZone,
    onChange: (version) => floor.notifyCatalog(version),
    permitirLocales: process.env.IMPRESORA_PRUEBA === '1',
    esEquipoDelHub: (ip) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1',
  },
  versionBase: currentVersion(db),
  logger: true,
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    queue.stop()
    await app.close()
    await queue.ready()
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

if (!existsSync(dirApp)) {
  console.warn(
    '\n⚠ Falta compilar la app: ejecuta `pnpm --filter @pos/app build` y reinicia el hub.',
  )
}

for (const alert of alerts) console.warn(`⚠ ${alert}`)
const datosAdmin = lineasAdministrador(admin)
if (datosAdmin.length > 0)
  mostrarPines(dirDatos, {
    consoleLines: [
      '\nAdministrador (para entrar a la caja):',
      ...datosAdmin,
      'Anótalo en un lugar seguro: no se vuelve a mostrar.',
    ],
    archivo: ARCHIVO_PIN_ADMIN,
    content: `${datosAdmin.join('\n')}\n`,
    alert: (route) =>
      `\nLos datos del administrador quedaron en ${route}: anótalos y borra ese archivo.`,
  })

console.log('\nHub en marcha. Abre en los dispositivos de la misma red:')
for (const ip of ipsLocales()) {
  console.log(`  http://${ip}:${port}`)
}
