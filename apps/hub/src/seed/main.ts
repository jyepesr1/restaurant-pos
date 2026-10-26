import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SqliteDatabase } from '@pos/db'
import { DatabaseBusyError } from '@pos/db/node'
import {
  abrirDatos,
  dirDatosDe,
  lineasAdministrador,
  mostrarPines,
  prepararAcceso,
} from '../arranque'
import { leerCarta, rulesWithoutDish } from './carta'
import { seed } from './sembrar'

// `pnpm seed`: carga en la base del hub los datos de La Spritzzería. Es para instalar el piloto:
// se puede correr las veces que se quiera (lo que ya está igual no se toca, lo que editó una
// persona se respeta), pero no reemplaza al editor del catálogo. El hub debe estar cerrado: usa
// la base en exclusiva. Con `--sin-personal` no crea las cuentas de ejemplo.

const dirDatos = dirDatosDe()
const rutaCarta =
  process.env.RUTA_CARTA ||
  fileURLToPath(new URL('../../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url))
const sinPersonal = process.argv.includes('--no-staff')

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Un PIN o una contraseña se muestra en cuanto existe: si algo falla después, no se pierde. */
function anunciar(quienes: string, lines: readonly string[]) {
  if (lines.length === 0) return
  // Un archivo por corrida: así una corrida nueva no pisa PIN que nadie ha leído.
  const archivo = `pines-${new Date().toISOString().replace(/[:.]/g, '-')}-${quienes}.txt`
  mostrarPines(dirDatos, {
    consoleLines: [
      '\nPIN y contraseñas nuevos:',
      ...lines,
      'Anótalos en un lugar seguro: no se vuelven a mostrar.',
    ],
    archivo,
    content: `${lines.join('\n')}\n`,
    alert: (route) =>
      `\nLos PIN y contraseñas nuevos quedaron en ${route}: anótalos y borra ese archivo.`,
  })
}

/** Una persona por línea: nombre, PIN y, si entra a la caja, usuario y contraseña. */
const lineaDe = (p: { name: string; pin: string | null; user?: string; password?: string }) =>
  [
    `  ${p.name.padEnd(14)}`,
    p.user ? `usuario ${p.user}  contraseña ${p.password}` : '',
    p.pin ? (p.user ? `PIN para autorizar ${p.pin}` : `PIN ${p.pin}`) : '',
  ]
    .filter(Boolean)
    .join('  ')

function correr(): number {
  let menu: ReturnType<typeof leerCarta>
  try {
    menu = leerCarta(readFileSync(rutaCarta, 'utf8'))
  } catch (error) {
    console.error(`No se cargaron los datos: la carta (${rutaCarta}) no sirve: ${message(error)}`)
    return 1
  }
  for (const name of rulesWithoutDish(menu))
    console.warn(`⚠ La carta ya no tiene «${name}»: revisa las reglas del seed (término o sabor).`)

  let db: SqliteDatabase
  try {
    db = abrirDatos(dirDatos).db
  } catch (error) {
    console.error(
      error instanceof DatabaseBusyError
        ? 'No se cargaron los datos: el hub está abierto. Ciérralo y vuelve a correr esto.'
        : `No se cargaron los datos: ${message(error)}`,
    )
    return 1
  }

  try {
    const { access, restaurantId, roles, admin, alerts } = prepararAcceso(db, dirDatos)
    for (const alert of alerts) console.warn(`⚠ ${alert}`)
    anunciar('administrador', lineasAdministrador(admin))

    const { sqlTables, pins } = seed(
      db,
      access,
      { restaurantId, roles, menu, sinPersonal },
      new Date().toISOString(),
    )
    console.log(`Datos de La Spritzzería cargados en ${dirDatos}`)
    for (const [tableName, c] of Object.entries(sqlTables)) {
      const parts = [
        `${c.created} nuevos`,
        `${c.updated} cambiados`,
        `${c.equal} iguales`,
        ...(c.respected ? [`${c.respected} respetados`] : []),
        ...(c.archived ? [`${c.archived} archivados`] : []),
      ]
      console.log(`  ${tableName.padEnd(28)} ${parts.join(', ')}`)
    }
    if (pins.length > 0) anunciar('personal', pins.map(lineaDe))
    else if (sinPersonal) console.log('\nSin personal de ejemplo (--sin-personal).')
    else console.log('\nNo se creó personal nuevo: cada quien conserva su PIN.')
    return 0
  } catch (error) {
    console.error(`No se cargaron los datos: ${message(error)}`)
    return 1
  } finally {
    db.close()
  }
}

process.exitCode = correr()
