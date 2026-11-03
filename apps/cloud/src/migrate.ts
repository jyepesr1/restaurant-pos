import { Client } from 'pg'
import { secret } from './console'
import { CLOUD_MIGRATIONS, migrate } from './migrations'
import { sqlFromPg } from './pg'

// `pnpm --filter @pos/cloud migrate`: creates or updates the tables in the Neon database. Run
// from the owner's machine with the connection string of the role that creates tables (not the
// API's). Asks for the string without showing it; also takes it from DATABASE_URL.

const connectionString = await secret(
  'DATABASE_URL',
  'Paste the Neon connection string (owner role, no pooler) and press Enter: ',
)
const client = new Client({ connectionString: connectionString })
try {
  await client.connect()
  const doneVersions = await migrate(sqlFromPg(client))
  const last = CLOUD_MIGRATIONS.at(-1)?.version ?? 0
  console.log(
    doneVersions.length > 0
      ? `Done: applied migrations ${doneVersions.join(', ')}. The database is at version ${last}.`
      : `The database was already up to date (version ${last}). Nothing was changed.`,
  )
} catch (e) {
  console.error('Could not migrate the database:', e instanceof Error ? e.message : e)
  process.exitCode = 1
} finally {
  await client.end().catch(() => {})
}
