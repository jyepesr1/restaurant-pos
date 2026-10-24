import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { aplicarMigraciones, type BaseSqlite } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import { asegurarAdministrador, asegurarRestaurante, asegurarRoles } from './acceso/inicial'
import { Intentos } from './acceso/intentos'
import { cargarClave } from './acceso/secretos'
import { ServicioAcceso } from './acceso/servicio'

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
) {
  const { clave, nueva, creadaEn } = cargarClave(dirDatos)
  const ahora = new Date().toISOString()
  const restauranteId = asegurarRestaurante(db, ahora)
  const roles = asegurarRoles(db, restauranteId, ahora)
  const intentos = new Intentos(Date.now, alAvisar)
  const acceso = new ServicioAcceso({ db, restauranteId, clave, intentos, claveDesde: creadaEn })
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
