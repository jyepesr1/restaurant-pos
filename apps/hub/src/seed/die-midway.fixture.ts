import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SqliteDatabase } from '@pos/db'
import { dataDirOf, openData, prepareAccess } from '../startup'
import { readMenu } from './menu'
import { seed } from './seed'

// Tests only: runs the seed like `pnpm seed` but the process dies (SIGKILL, closing nothing)
// right before the Nth INSERT into a table (DIE_AT="products:50") or before creating the Nth
// person (DIE_AT="users:3").

const [tableName, n] = (process.env.DIE_AT ?? '').split(':') as [string, string]
const limit = Number(n)
const die = () => process.kill(process.pid, 'SIGKILL')

const dataDir = dataDirOf()
const { db } = openData(dataDir)
const { access, restaurantId, roles } = prepareAccess(db, dataDir)

let check = 0
const trap: SqliteDatabase = {
  exec: (sql) => db.exec(sql),
  prepare: (sql) => {
    if (sql.startsWith(`INSERT INTO ${tableName} `) && ++check === limit) die()
    return db.prepare(sql)
  },
  close: () => db.close(),
}
const insertUser = access.insertUser.bind(access)
let people = 0
access.insertUser = (...args) => {
  if (tableName === 'users' && ++people === limit) die()
  return insertUser(...args)
}

const menu = readMenu(
  readFileSync(
    fileURLToPath(new URL('../../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
    'utf8',
  ),
)
seed(trap, access, { restaurantId, roles, menu }, new Date().toISOString())
db.close()
