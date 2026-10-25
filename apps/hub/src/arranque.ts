import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configCompleta, nuevoId } from '@pos/core'
import { aplicarMigraciones, type BaseSqlite } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import { HubSync, SalaSync } from '@pos/sync'
import { AlmacenSqlite } from '@pos/sync/sqlite'
import { asegurarAdministrador, asegurarRestaurante, asegurarRoles } from './acceso/inicial'
import { Intentos } from './acceso/intentos'
import { cargarClave } from './acceso/secretos'
import { ServicioAcceso } from './acceso/servicio'
import { revisorPrecios } from './precios'

// Lo que hacen al arrancar el hub y el seed: abrir la base de la carpeta de datos y preparar el
// acceso. Una sola carpeta, un solo proceso: la base se abre en exclusiva.

/** Carpeta de datos: `DIR_DATOS` o `apps/hub/datos`. */
export const dirDatosDe = (entorno: NodeJS.ProcessEnv = process.env) =>
  entorno.DIR_DATOS || fileURLToPath(new URL('../datos', import.meta.url))

/** Abre la base en exclusiva y la lleva a la última versión. Devuelve las migraciones aplicadas. */
export function abrirDatos(dirDatos: string): { db: BaseSqlite; aplicadas: number[] } {
  mkdirSync(dirDatos, { recursive: true })
  const db = abrirBase(join(dirDatos, 'pos.sqlite'), { exclusiva: true })
  return { db, aplicadas: aplicarMigraciones(db) }
}

/** Restaurante, roles, administrador y la clave de los PIN (tarea 0.7). */
export function prepararAcceso(
  db: BaseSqlite,
  dirDatos: string,
  alAvisar: (aviso: string) => void = () => {},
  alRevocar?: (dispositivoId: string, revocadoEn: string) => void,
) {
  const { clave, nueva, creadaEn } = cargarClave(dirDatos)
  const ahora = new Date().toISOString()
  const restauranteId = asegurarRestaurante(db, ahora)
  const roles = asegurarRoles(db, restauranteId, ahora)
  const intentos = new Intentos(Date.now, alAvisar)
  const acceso = new ServicioAcceso({
    db,
    restauranteId,
    clave,
    intentos,
    claveDesde: creadaEn,
    alRevocar,
  })
  const admin = asegurarAdministrador(db, acceso, roles.admin, nueva)
  return { acceso, restauranteId, roles, pin: admin.pin, avisos: admin.avisos }
}

/**
 * Muestra PIN recién creados una sola vez: el hub guarda solo su huella. Si la salida no es una
 * ventana (el servicio de Windows la manda a un archivo de log), van a un archivo aparte, solo
 * legible por el hub, para leerlo y borrarlo.
 */
export function mostrarPines(
  dirDatos: string,
  pines: {
    /** Lo que se escribe en la ventana. */
    ventana: readonly string[]
    archivo: string
    contenido: string
    /** Qué decir en el log si van al archivo. */
    aviso: (ruta: string) => string
  },
  enVentana = process.stdout.isTTY === true,
) {
  if (enVentana) {
    for (const linea of pines.ventana) console.log(linea)
    return
  }
  const ruta = join(dirDatos, pines.archivo)
  writeFileSync(ruta, pines.contenido, { mode: 0o600 })
  // `mode` solo vale al crear el archivo: si ya existía con otros permisos, se ajustan.
  chmodSync(ruta, 0o600)
  console.log(pines.aviso(ruta))
}

export const ARCHIVO_INSTANCIA = 'hub-instancia'

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
  const nueva = nuevoId()
  writeFileSync(ruta, `${nueva}\n`)
  return nueva
}

/**
 * El hub de sincronización sobre la base del restaurante (tarea 0.10): eventos con el control de
 * acceso de la tarea 0.7, zona horaria de la sede y día operativo de la configuración.
 */
export function prepararSincronizacion(
  db: BaseSqlite,
  dirDatos: string,
  restauranteId: string,
  acceso: ServicioAcceso,
  alErrorInterno?: (error: unknown, eventoId: string) => void,
): SalaSync {
  const sede = db
    .prepare(
      'SELECT zona_horaria FROM sede WHERE restaurante_id = ? AND activo = 1 ORDER BY creado_en LIMIT 1',
    )
    .get(restauranteId)
  const restaurante = db.prepare('SELECT config FROM restaurante WHERE id = ?').get(restauranteId)
  const config = configCompleta(JSON.parse(String(restaurante?.config ?? '{}')))
  const hub = new HubSync(new AlmacenSqlite(db, restauranteId), {
    restauranteId,
    zonaHoraria: String(sede?.zona_horaria ?? 'America/Bogota'),
    inicioDiaOperativo: config.inicio_dia_operativo,
    instancia: instanciaDelHub(dirDatos),
    reloj: () => new Date().toISOString(),
    acceso,
    alErrorInterno,
    precios: revisorPrecios(db, restauranteId),
  })
  return new SalaSync(hub, acceso.autenticar)
}
