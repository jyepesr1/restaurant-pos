import type { BaseSqlite } from '@pos/db'
import { BaseOcupadaError } from '@pos/db/node'
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
const mensaje = (error: unknown) => (error instanceof Error ? error.message : String(error))

function correr(): number {
  let db: BaseSqlite
  try {
    db = abrirDatos(dirDatos).db
  } catch (error) {
    console.error(
      error instanceof BaseOcupadaError
        ? 'No se cambió nada: el hub está abierto. Ciérralo y vuelve a correr esto.'
        : `No se cambió nada: ${mensaje(error)}`,
    )
    return 1
  }
  try {
    const { acceso, restauranteId, admin, avisos } = prepararAcceso(db, dirDatos)
    for (const aviso of avisos) console.warn(`⚠ ${aviso}`)
    // Lo que el arranque acaba de crear o regenerar (un PIN nuevo si se perdió la clave) también
    // se muestra: si no, se perdería.
    let lineas = lineasAdministrador(admin)
    if (!admin.contrasena) {
      // El arranque deja al administrador con usuario: es el primero de la lista.
      const id = administradores(db, restauranteId)[0]
      if (!id) throw new Error('No hay ningún administrador activo')
      const usuario = acceso.usuarioDe(id) ?? USUARIO_ADMIN
      const contrasena = generarContrasena()
      acceso.ponerContrasena(id, usuario, contrasena)
      lineas = [
        `  Usuario:          ${usuario}`,
        `  Contraseña:       ${contrasena}`,
        ...lineas.filter((l) => l.includes('PIN')),
      ]
    }
    mostrarPines(dirDatos, {
      ventana: [
        '\nContraseña nueva del administrador:',
        ...lineas,
        'Anótala en un lugar seguro: no se vuelve a mostrar. La anterior ya no sirve.',
      ],
      archivo: `restablecer-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
      contenido: `${lineas.join('\n')}\n`,
      aviso: (ruta) =>
        `\nLa contraseña nueva quedó en ${ruta} (solo la puede leer el hub): anótala y borra ese archivo.`,
    })
    return 0
  } catch (error) {
    console.error(`No se cambió nada: ${mensaje(error)}`)
    return 1
  } finally {
    db.close()
  }
}

process.exitCode = correr()
