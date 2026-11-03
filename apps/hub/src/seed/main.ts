import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SqliteDatabase } from '@pos/db'
import { DatabaseBusyError } from '@pos/db/node'
import { adminLines, dataDirOf, openData, prepareAccess, showPins } from '../startup'
import { readMenu, rulesWithoutDish } from './menu'
import { seed } from './seed'

// `pnpm seed`: loads La Spritzzería's data into the hub database. It is for installing the pilot:
// it can be run as many times as needed (what is already the same is not touched, what a person
// edited is respected), but it does not replace the catalog editor. The hub must be closed: it
// uses the database exclusively. With `--no-staff` it does not create the sample accounts.

const dataDir = dataDirOf()
const menuPath =
  process.env.MENU_PATH ||
  fileURLToPath(new URL('../../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url))
const withoutStaff = process.argv.includes('--no-staff')

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A PIN or a password is shown as soon as it exists: if something fails later, it is not lost. */
function announce(whoCan: string, lines: readonly string[]) {
  if (lines.length === 0) return
  // One file per run: that way a new run does not overwrite PINs nobody has read.
  const file = `pins-${new Date().toISOString().replace(/[:.]/g, '-')}-${whoCan}.txt`
  showPins(dataDir, {
    consoleLines: [
      '\nNew PINs and passwords:',
      ...lines,
      'Write them down somewhere safe: they are not shown again.',
    ],
    file,
    content: `${lines.join('\n')}\n`,
    alert: (route) =>
      `\nThe new PINs and passwords were saved to ${route}: write them down and delete that file.`,
  })
}

/** One person per line: name, PIN and, if they sign in at the register, username and password. */
const lineOf = (p: { name: string; pin: string | null; user?: string; password?: string }) =>
  [
    `  ${p.name.padEnd(14)}`,
    p.user ? `username ${p.user}  password ${p.password}` : '',
    p.pin ? (p.user ? `PIN to authorize ${p.pin}` : `PIN ${p.pin}`) : '',
  ]
    .filter(Boolean)
    .join('  ')

function run(): number {
  let menu: ReturnType<typeof readMenu>
  try {
    menu = readMenu(readFileSync(menuPath, 'utf8'))
  } catch (error) {
    console.error(`No data was loaded: the menu (${menuPath}) is not valid: ${message(error)}`)
    return 1
  }
  for (const name of rulesWithoutDish(menu))
    console.warn(`⚠ The menu no longer has "${name}": check the seed rules (doneness or flavor).`)

  let db: SqliteDatabase
  try {
    db = openData(dataDir).db
  } catch (error) {
    console.error(
      error instanceof DatabaseBusyError
        ? 'No data was loaded: the hub is open. Close it and run this again.'
        : `No data was loaded: ${message(error)}`,
    )
    return 1
  }

  try {
    const { access, restaurantId, roles, admin, alerts } = prepareAccess(db, dataDir)
    for (const alert of alerts) console.warn(`⚠ ${alert}`)
    announce('admin', adminLines(admin))

    const { sqlTables, pins } = seed(
      db,
      access,
      { restaurantId, roles, menu, withoutStaff },
      new Date().toISOString(),
    )
    console.log(`Loaded La Spritzzería's data into ${dataDir}`)
    for (const [tableName, c] of Object.entries(sqlTables)) {
      const parts = [
        `${c.created} new`,
        `${c.updated} changed`,
        `${c.equal} unchanged`,
        ...(c.respected ? [`${c.respected} kept`] : []),
        ...(c.archived ? [`${c.archived} archived`] : []),
      ]
      console.log(`  ${tableName.padEnd(28)} ${parts.join(', ')}`)
    }
    if (pins.length > 0) announce('staff', pins.map(lineOf))
    else if (withoutStaff) console.log('\nNo sample staff (--no-staff).')
    else console.log('\nNo new staff was created: everyone keeps their PIN.')
    return 0
  } catch (error) {
    console.error(`No data was loaded: ${message(error)}`)
    return 1
  } finally {
    db.close()
  }
}

process.exitCode = run()
