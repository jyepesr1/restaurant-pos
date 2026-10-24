import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { BaseSqlite } from '@pos/db'
import { abrirDatos, dirDatosDe, prepararAcceso } from '../arranque'
import { leerCarta } from './carta'
import { sembrar } from './sembrar'

// Solo para pruebas: corre el seed como `pnpm seed` pero el proceso muere (SIGKILL, sin cerrar
// nada) justo antes del INSERT número N de una tabla (MORIR_EN="producto:50") o antes de crear a
// la persona número N (MORIR_EN="usuario:3").

const [tabla, n] = (process.env.MORIR_EN ?? '').split(':') as [string, string]
const limite = Number(n)
const morir = () => process.kill(process.pid, 'SIGKILL')

const dirDatos = dirDatosDe()
const { db } = abrirDatos(dirDatos)
const { acceso, restauranteId, roles } = prepararAcceso(db, dirDatos)

let cuenta = 0
const trampa: BaseSqlite = {
  exec: (sql) => db.exec(sql),
  prepare: (sql) => {
    if (sql.startsWith(`INSERT INTO ${tabla} `) && ++cuenta === limite) morir()
    return db.prepare(sql)
  },
  close: () => db.close(),
}
const insertarUsuario = acceso.insertarUsuario.bind(acceso)
let personas = 0
acceso.insertarUsuario = (...args) => {
  if (tabla === 'usuario' && ++personas === limite) morir()
  return insertarUsuario(...args)
}

const carta = leerCarta(
  readFileSync(
    fileURLToPath(new URL('../../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
    'utf8',
  ),
)
sembrar(trampa, acceso, { restauranteId, roles, carta }, new Date().toISOString())
db.close()
