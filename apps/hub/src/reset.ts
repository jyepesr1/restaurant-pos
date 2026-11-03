import type { SqliteDatabase } from '@pos/db'
import { DatabaseBusyError } from '@pos/db/node'
import { ADMIN_USERNAME } from './access/initial'
import { generatePassword } from './access/secrets'
import { admins } from './access/staff'
import { adminLines, dataDirOf, openData, prepareAccess, showPins } from './startup'

// `pnpm reset-admin`: for whoever forgot the admin password (ADR-013). Gives a new password to
// the first active admin and shows it once; their sessions are closed. It must run on the hub PC
// with the hub closed: it uses the database exclusively.

const dataDir = dataDirOf()
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function run(): number {
  let db: SqliteDatabase
  try {
    db = openData(dataDir).db
  } catch (error) {
    console.error(
      error instanceof DatabaseBusyError
        ? 'Nothing was changed: the hub is open. Close it and run this again.'
        : `Nothing was changed: ${message(error)}`,
    )
    return 1
  }
  try {
    const { access, restaurantId, admin, alerts } = prepareAccess(db, dataDir)
    for (const alert of alerts) console.warn(`⚠ ${alert}`)
    // Whatever startup just created or regenerated (a new PIN if the key was lost) is shown too:
    // otherwise it would be lost.
    let lines = adminLines(admin)
    if (!admin.password) {
      // Startup leaves the admin with a username: it is the first in the list.
      const id = admins(db, restaurantId)[0]
      if (!id) throw new Error('There is no active admin')
      const user = access.userOf(id) ?? ADMIN_USERNAME
      const password = generatePassword()
      access.assignPassword(id, user, password)
      lines = [
        `  Username:         ${user}`,
        `  Password:         ${password}`,
        ...lines.filter((l) => l.includes('PIN')),
      ]
    }
    showPins(dataDir, {
      consoleLines: [
        "\nThe admin's new password:",
        ...lines,
        'Write it down somewhere safe: it is not shown again. The old one no longer works.',
      ],
      file: `reset-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
      content: `${lines.join('\n')}\n`,
      alert: (route) =>
        `\nThe new password was saved to ${route} (only the hub can read it): write it down and delete that file.`,
    })
    return 0
  } catch (error) {
    console.error(`Nothing was changed: ${message(error)}`)
    return 1
  } finally {
    db.close()
  }
}

process.exitCode = run()
