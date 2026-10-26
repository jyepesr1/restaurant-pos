import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fullConfig, newId } from '@pos/core'
import { aplicarMigraciones, type BaseSqlite } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import { type ConfigHub, HubSync, SalaSync } from '@pos/sync'
import { AlmacenSqlite } from '@pos/sync/sqlite'
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
export const dirDatosDe = (entorno: NodeJS.ProcessEnv = process.env) =>
  entorno.DATA_DIR || fileURLToPath(new URL('../datos', import.meta.url))

/** Abre la base en exclusiva y la lleva a la última versión. Devuelve las migraciones aplicadas. */
export function abrirDatos(dirDatos: string): { db: BaseSqlite; aplicadas: number[] } {
  mkdirSync(dirDatos, { recursive: true })
  const db = abrirBase(join(dirDatos, 'pos.sqlite'), { exclusiva: true })
  return { db, aplicadas: aplicarMigraciones(db) }
}

/** Restaurante, roles, administrador y la clave de los PIN (tareas 0.7 y 1.3b). */
export function prepararAcceso(
  db: BaseSqlite,
  dirDatos: string,
  alAvisar: (alert: string) => void = () => {},
  onRevoke?: (dispositivoId: string, revocadoEn: string) => void,
) {
  const { key, newOne, creadaEn } = cargarClave(dirDatos)
  const ahora = new Date().toISOString()
  const restauranteId = asegurarRestaurante(db, ahora)
  const roles = asegurarRoles(db, restauranteId, ahora)
  const attempts = new Intentos(Date.now, alAvisar)
  const access = new ServicioAcceso({
    db,
    restauranteId,
    key,
    attempts,
    claveDesde: creadaEn,
    onRevoke,
  })
  const admin = asegurarAdministrador(db, access, roles.admin, newOne)
  return { access, restauranteId, roles, admin, avisos: admin.avisos }
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
    ventana: readonly string[]
    archivo: string
    content: string
    /** Qué decir en el log si van al archivo. */
    alert: (ruta: string) => string
  },
  enVentana = process.stdout.isTTY === true,
) {
  if (enVentana) {
    for (const line of pins.ventana) console.log(line)
    return
  }
  const ruta = join(dirDatos, pins.archivo)
  writeFileSync(ruta, pins.content, { mode: 0o600 })
  // `mode` solo vale al crear el archivo: si ya existía con otros permisos, se ajustan.
  chmodSync(ruta, 0o600)
  console.log(pins.alert(ruta))
}

export const ARCHIVO_INSTANCIA = 'hub-instance'

/**
 * La identidad de esta instalación del hub (docs/SYNC.md#fallas-y-qué-pasa). Cambia al reinstalar
 * o restaurar: un dispositivo que la ve distinta reenvía todo lo suyo. Vive en su propio archivo,
 * fuera de la base, para que restaurar un respaldo de la base no traiga la vieja.
 */
export function instanciaDelHub(dirDatos: string): string {
  const ruta = join(dirDatos, ARCHIVO_INSTANCIA)
  if (existsSync(ruta)) {
    const guardada = readFileSync(ruta, 'utf8').trim()
    if (guardada) return guardada
  }
  const newOne = newId()
  writeFileSync(ruta, `${newOne}\n`)
  return newOne
}

/** La zona horaria de la sede principal: la de las horas de las comandas y del día operativo. */
export function zonaHorariaDe(db: BaseSqlite, restauranteId: string): string {
  const location = db
    .prepare(
      'SELECT time_zone FROM locations WHERE restaurant_id = ? AND active = 1 ORDER BY created_at LIMIT 1',
    )
    .get(restauranteId)
  return String(location?.time_zone ?? 'America/Bogota')
}

/**
 * El hub de sincronización sobre la base del restaurante (tarea 0.10): eventos con el control de
 * acceso de la tarea 0.7, zona horaria de la sede y día operativo de la configuración.
 */
export function prepararSincronizacion(
  db: BaseSqlite,
  dirDatos: string,
  restauranteId: string,
  access: ServicioAcceso,
  alErrorInterno?: (error: unknown, eventId: string) => void,
  extra: Pick<ConfigHub, 'onSave' | 'onSaveFailure'> = {},
): SalaSync {
  const restaurant = db.prepare('SELECT config FROM restaurants WHERE id = ?').get(restauranteId)
  const config = fullConfig(JSON.parse(String(restaurant?.config ?? '{}')))
  const hub = new HubSync(new AlmacenSqlite(db, restauranteId), {
    restauranteId,
    timeZone: zonaHorariaDe(db, restauranteId),
    inicioDiaOperativo: config.business_day_start,
    instancia: instanciaDelHub(dirDatos),
    clock: () => new Date().toISOString(),
    access,
    alErrorInterno,
    prices: revisorPrecios(db, restauranteId),
    // Se leen en cada pago: el administrador puede cambiarlas con el hub andando.
    reglasCobro: () => {
      const fila = db.prepare('SELECT config FROM restaurants WHERE id = ?').get(restauranteId)
      const current = fullConfig(JSON.parse(String(fila?.config ?? '{}')))
      return {
        multiple: current.cash_rounding,
        mode: current.cash_rounding_mode,
        medios: current.payment_methods,
        mediosPropios: current.custom_methods.filter((m) => m.active).map((m) => m.id),
        umbralDiferencia: current.register_variance_threshold,
        cardTerminals: db
          .prepare('SELECT id FROM card_terminals WHERE restaurant_id = ? AND active = 1')
          .all(restauranteId)
          .map((f) => String(f.id)),
      }
    },
    ...extra,
  })
  return new SalaSync(hub, access.authenticate)
}
