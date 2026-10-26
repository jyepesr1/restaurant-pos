import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SqliteDatabase } from '@pos/db'
import { abrirDatos, dirDatosDe, prepararAcceso } from '../arranque'
import { leerCarta } from './carta'
import { seed } from './sembrar'

// Solo para pruebas: corre el seed como `pnpm seed` pero el proceso muere (SIGKILL, sin cerrar
// nada) justo antes del INSERT número N de una tabla (MORIR_EN="producto:50") o antes de crear a
// la persona número N (MORIR_EN="usuario:3").

const [tableName, n] = (process.env.MORIR_EN ?? '').split(':') as [string, string]
const limit = Number(n)
const morir = () => process.kill(process.pid, 'SIGKILL')

const dirDatos = dirDatosDe()
const { db } = abrirDatos(dirDatos)
const { access, restaurantId, roles } = prepararAcceso(db, dirDatos)

let check = 0
const trampa: SqliteDatabase = {
  exec: (sql) => db.exec(sql),
  prepare: (sql) => {
    if (sql.startsWith(`INSERT INTO ${tableName} `) && ++check === limit) morir()
    return db.prepare(sql)
  },
  close: () => db.close(),
}
const insertUser = access.insertUser.bind(access)
let people = 0
access.insertUser = (...args) => {
  if (tableName === 'users' && ++people === limit) morir()
  return insertUser(...args)
}

const menu = leerCarta(
  readFileSync(
    fileURLToPath(new URL('../../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
    'utf8',
  ),
)
seed(trampa, access, { restaurantId, roles, menu }, new Date().toISOString())
db.close()
