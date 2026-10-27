import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from '@playwright/test'
import { DATA_DIR_E2E } from './routes'

// The test hub opens and migrates its database in DATA_DIR on startup, and locks it exclusively.
// Runs in a single project because both share the same hub and the same folder.
test('the test hub leaves its database migrated and locks it exclusively', async ({
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'register', 'A single run is enough')

  const health = await request.get('/api/health')
  expect(health.ok()).toBe(true)
  // Latest migration: 0002 (supervisor approval bound to the event, task 0.7).
  expect(await health.json()).toMatchObject({ db_version: 1 })

  const route = join(DATA_DIR_E2E, 'pos.sqlite')
  expect(existsSync(route), `missing ${route}`).toBe(true)

  // Another process cannot read it while the hub has it open.
  const db = new DatabaseSync(route, { readOnly: true })
  try {
    expect(() => db.prepare('SELECT max(version) AS version FROM migrations').get()).toThrow(
      /locked/,
    )
  } finally {
    db.close()
  }
})
