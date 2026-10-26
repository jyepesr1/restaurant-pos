import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fullConfig, newId } from '@pos/core'
import { applyMigrations, type SqliteDatabase } from '@pos/db'
import { openDatabase } from '@pos/db/node'
import { type ConfigHub, FloorSync, HubSync } from '@pos/sync'
import { SqliteStore } from '@pos/sync/sqlite'
import {
  type Administrador,
  asegurarAdministrador,
  asegurarRestaurante,
  asegurarRoles,
} from './acceso/inicial'
import { Intentos } from './acceso/intentos'
import { cargarClave } from './acceso/secretos'
import { ServicioAcceso } from './acceso/servicio'
import { revisorPrecios } from './precios'

// Lo que hacen al arrancar el hub y el seed: abrir la base de la carpeta de datos y preparar el
// acceso. Una sola carpeta, un solo proceso: la base se abre en exclusiva.

/** Carpeta de datos: `DATA_DIR` o `apps/hub/datos`. */
export const dirDatosDe = (environment: NodeJS.ProcessEnv = process.env) =>
  environment.DATA_DIR || fileURLToPath(new URL('../datos', import.meta.url))

/** Abre la base en exclusiva y la lleva a la última versión. Devuelve las migraciones aplicadas. */
export function abrirDatos(dirDatos: string): { db: SqliteDatabase; appliedMigrations: number[] } {
  mkdirSync(dirDatos, { recursive: true })
  const db = openDatabase(join(dirDatos, 'pos.sqlite'), { exclusive: true })
  return { db, appliedMigrations: applyMigrations(db) }
}

/** Restaurante, roles, administrador y la clave de los PIN (tareas 0.7 y 1.3b). */
export function prepararAcceso(
  db: SqliteDatabase,
  dirDatos: string,
  alAvisar: (alert: string) => void = () => {},
  onRevoke?: (deviceId: string, revokedAt: string) => void,
) {
  const { key, newOne, creadaEn } = cargarClave(dirDatos)
  const now = new Date().toISOString()
  const restaurantId = asegurarRestaurante(db, now)
  const roles = asegurarRoles(db, restaurantId, now)
  const attempts = new Intentos(Date.now, alAvisar)
  const access = new ServicioAcceso({
    db,
    restaurantId,
    key,
    attempts,
    claveDesde: creadaEn,
    onRevoke,
  })
  const admin = asegurarAdministrador(db, access, roles.admin, newOne)
  return { access, restaurantId, roles, admin, alerts: admin.alerts }
}

/** Lo nuevo del administrador para mostrarlo una vez; vacío si no hay nada nuevo. */
export function lineasAdministrador(admin: Administrador): string[] {
  return [
    ...(admin.user ? [`  Usuario:          ${admin.user}`] : []),
    ...(admin.password ? [`  Contraseña:       ${admin.password}`] : []),
    ...(admin.pin ? [`  PIN para autorizar: ${admin.pin}`] : []),
  ]
}

/**
 * Muestra PIN y contraseñas recién creados una sola vez: el hub guarda solo su huella. Si la salida no es una
 * ventana (el servicio de Windows la manda a un archivo de log), van a un archivo aparte, solo
 * legible por el hub, para leerlo y borrarlo.
 */
export function mostrarPines(
  dirDatos: string,
  pins: {
    /** Lo que se escribe en la ventana. */
    consoleLines: readonly string[]
    archivo: string
    content: string
    /** Qué decir en el log si van al archivo. */
    alert: (route: string) => string
  },
  enVentana = process.stdout.isTTY === true,
) {
  if (enVentana) {
    for (const line of pins.consoleLines) console.log(line)
    return
  }
  const route = join(dirDatos, pins.archivo)
  writeFileSync(route, pins.content, { mode: 0o600 })
  // `mode` solo vale al crear el archivo: si ya existía con otros permisos, se ajustan.
  chmodSync(route, 0o600)
  console.log(pins.alert(route))
}

export const ARCHIVO_INSTANCIA = 'hub-instance'

/**
 * La identidad de esta instalación del hub (docs/SYNC.md#fallas-y-qué-pasa). Cambia al reinstalar
 * o restaurar: un dispositivo que la ve distinta reenvía todo lo suyo. Vive en su propio archivo,
 * fuera de la base, para que restaurar un respaldo de la base no traiga la vieja.
 */
export function instanciaDelHub(dirDatos: string): string {
  const route = join(dirDatos, ARCHIVO_INSTANCIA)
  if (existsSync(route)) {
    const guardada = readFileSync(route, 'utf8').trim()
    if (guardada) return guardada
  }
  const newOne = newId()
  writeFileSync(route, `${newOne}\n`)
  return newOne
}

/** La zona horaria de la sede principal: la de las horas de las comandas y del día operativo. */
export function zonaHorariaDe(db: SqliteDatabase, restaurantId: string): string {
  const location = db
    .prepare(
      'SELECT time_zone FROM locations WHERE restaurant_id = ? AND active = 1 ORDER BY created_at LIMIT 1',
    )
    .get(restaurantId)
  return String(location?.time_zone ?? 'America/Bogota')
}

/**
 * El hub de sincronización sobre la base del restaurante (tarea 0.10): eventos con el control de
 * acceso de la tarea 0.7, zona horaria de la sede y día operativo de la configuración.
 */
export function prepararSincronizacion(
  db: SqliteDatabase,
  dirDatos: string,
  restaurantId: string,
  access: ServicioAcceso,
  onInternalError?: (error: unknown, eventId: string) => void,
  extra: Pick<ConfigHub, 'onSave' | 'onSaveFailure'> = {},
): FloorSync {
  const restaurant = db.prepare('SELECT config FROM restaurants WHERE id = ?').get(restaurantId)
  const config = fullConfig(JSON.parse(String(restaurant?.config ?? '{}')))
  const hub = new HubSync(new SqliteStore(db, restaurantId), {
    restaurantId,
    timeZone: zonaHorariaDe(db, restaurantId),
    businessDayStart: config.business_day_start,
    instance: instanciaDelHub(dirDatos),
    clock: () => new Date().toISOString(),
    access,
    onInternalError,
    prices: revisorPrecios(db, restaurantId),
    // Se leen en cada pago: el administrador puede cambiarlas con el hub andando.
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
