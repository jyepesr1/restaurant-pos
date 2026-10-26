import type { SqliteDatabase } from '@pos/db'
import { DatabaseBusyError } from '@pos/db/node'
import { USUARIO_ADMIN } from './acceso/inicial'
import { administradores } from './acceso/personal'
import { generarContrasena } from './acceso/secretos'
import {
  abrirDatos,
  dirDatosDe,
  lineasAdministrador,
  mostrarPines,
  prepararAcceso,
} from './arranque'

// `pnpm restablecer-admin`: para quien olvidó la contraseña del administrador (ADR-013). Le da una
// contraseña nueva al primer administrador activo y la muestra una vez; sus sesiones se cierran.
// Hace falta estar en el PC del hub y con el hub cerrado: usa la base en exclusiva.

const dirDatos = dirDatosDe()
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function correr(): number {
  let db: SqliteDatabase
  try {
    db = abrirDatos(dirDatos).db
  } catch (error) {
    console.error(
      error instanceof DatabaseBusyError
        ? 'No se cambió nada: el hub está abierto. Ciérralo y vuelve a correr esto.'
        : `No se cambió nada: ${message(error)}`,
    )
    return 1
  }
  try {
    const { access, restaurantId, admin, alerts } = prepararAcceso(db, dirDatos)
    for (const alert of alerts) console.warn(`⚠ ${alert}`)
    // Lo que el arranque acaba de crear o regenerar (un PIN nuevo si se perdió la clave) también
    // se muestra: si no, se perdería.
    let lines = lineasAdministrador(admin)
    if (!admin.password) {
      // El arranque deja al administrador con usuario: es el primero de la lista.
      const id = administradores(db, restaurantId)[0]
      if (!id) throw new Error('No hay ningún administrador activo')
      const user = access.usuarioDe(id) ?? USUARIO_ADMIN
      const password = generarContrasena()
      access.ponerContrasena(id, user, password)
      lines = [
        `  Usuario:          ${user}`,
        `  Contraseña:       ${password}`,
        ...lines.filter((l) => l.includes('PIN')),
      ]
    }
    mostrarPines(dirDatos, {
      consoleLines: [
        '\nContraseña nueva del administrador:',
        ...lines,
        'Anótala en un lugar seguro: no se vuelve a mostrar. La anterior ya no sirve.',
      ],
      archivo: `restablecer-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
      content: `${lines.join('\n')}\n`,
      alert: (route) =>
        `\nLa contraseña nueva quedó en ${route} (solo la puede leer el hub): anótala y borra ese archivo.`,
    })
    return 0
  } catch (error) {
    console.error(`No se cambió nada: ${message(error)}`)
    return 1
  } finally {
    db.close()
  }
}

process.exitCode = correr()
