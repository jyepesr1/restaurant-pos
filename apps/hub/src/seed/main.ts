import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { BaseSqlite } from '@pos/db'
import { BaseOcupadaError } from '@pos/db/node'
import {
  abrirDatos,
  dirDatosDe,
  lineasAdministrador,
  mostrarPines,
  prepararAcceso,
} from '../arranque'
import { leerCarta, reglasSinPlato } from './carta'
import { sembrar } from './sembrar'

// `pnpm seed`: carga en la base del hub los datos de La Spritzzería. Es para instalar el piloto:
// se puede correr las veces que se quiera (lo que ya está igual no se toca, lo que editó una
// persona se respeta), pero no reemplaza al editor del catálogo. El hub debe estar cerrado: usa
// la base en exclusiva. Con `--sin-personal` no crea las cuentas de ejemplo.

const dirDatos = dirDatosDe()
const rutaCarta =
  process.env.RUTA_CARTA ||
  fileURLToPath(new URL('../../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url))
const sinPersonal = process.argv.includes('--sin-personal')

const mensaje = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Un PIN o una contraseña se muestra en cuanto existe: si algo falla después, no se pierde. */
function anunciar(quienes: string, lineas: readonly string[]) {
  if (lineas.length === 0) return
  // Un archivo por corrida: así una corrida nueva no pisa PIN que nadie ha leído.
  const archivo = `pines-${new Date().toISOString().replace(/[:.]/g, '-')}-${quienes}.txt`
  mostrarPines(dirDatos, {
    ventana: [
      '\nPIN y contraseñas nuevos:',
      ...lineas,
      'Anótalos en un lugar seguro: no se vuelven a mostrar.',
    ],
    archivo,
    contenido: `${lineas.join('\n')}\n`,
    aviso: (ruta) =>
      `\nLos PIN y contraseñas nuevos quedaron en ${ruta}: anótalos y borra ese archivo.`,
  })
}

/** Una persona por línea: nombre, PIN y, si entra a la caja, usuario y contraseña. */
const lineaDe = (p: {
  nombre: string
  pin: string | null
  usuario?: string
  contrasena?: string
}) =>
  [
    `  ${p.nombre.padEnd(14)}`,
    p.usuario ? `usuario ${p.usuario}  contraseña ${p.contrasena}` : '',
    p.pin ? (p.usuario ? `PIN para autorizar ${p.pin}` : `PIN ${p.pin}`) : '',
  ]
    .filter(Boolean)
    .join('  ')

function correr(): number {
  let carta: ReturnType<typeof leerCarta>
  try {
    carta = leerCarta(readFileSync(rutaCarta, 'utf8'))
  } catch (error) {
    console.error(`No se cargaron los datos: la carta (${rutaCarta}) no sirve: ${mensaje(error)}`)
    return 1
  }
  for (const nombre of reglasSinPlato(carta))
    console.warn(
      `⚠ La carta ya no tiene «${nombre}»: revisa las reglas del seed (término o sabor).`,
    )

  let db: BaseSqlite
  try {
    db = abrirDatos(dirDatos).db
  } catch (error) {
    console.error(
      error instanceof BaseOcupadaError
        ? 'No se cargaron los datos: el hub está abierto. Ciérralo y vuelve a correr esto.'
        : `No se cargaron los datos: ${mensaje(error)}`,
    )
    return 1
  }

  try {
    const { acceso, restauranteId, roles, admin, avisos } = prepararAcceso(db, dirDatos)
    for (const aviso of avisos) console.warn(`⚠ ${aviso}`)
    anunciar('administrador', lineasAdministrador(admin))

    const { tablas, pines } = sembrar(
      db,
      acceso,
      { restauranteId, roles, carta, sinPersonal },
      new Date().toISOString(),
    )
    console.log(`Datos de La Spritzzería cargados en ${dirDatos}`)
    for (const [tabla, c] of Object.entries(tablas)) {
      const partes = [
        `${c.creado} nuevos`,
        `${c.actualizado} cambiados`,
        `${c.igual} iguales`,
        ...(c.respetado ? [`${c.respetado} respetados`] : []),
        ...(c.archivado ? [`${c.archivado} archivados`] : []),
      ]
      console.log(`  ${tabla.padEnd(28)} ${partes.join(', ')}`)
    }
    if (pines.length > 0) anunciar('personal', pines.map(lineaDe))
    else if (sinPersonal) console.log('\nSin personal de ejemplo (--sin-personal).')
    else console.log('\nNo se creó personal nuevo: cada quien conserva su PIN.')
    return 0
  } catch (error) {
    console.error(`No se cargaron los datos: ${mensaje(error)}`)
    return 1
  } finally {
    db.close()
  }
}

process.exitCode = correr()
