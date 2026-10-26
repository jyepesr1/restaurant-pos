import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { montarAcceso } from './acceso/montaje'
import { leerCatalogo } from './catalogo'
import { leerCarta } from './seed/carta'
import { sembrar } from './seed/sembrar'
import { crearServidor } from './servidor'

// Montaje de las pruebas del catálogo: un hub con la carta real del piloto sembrada, el servidor
// HTTP con la edición y una caja emparejada. Solo para pruebas.

export const CARTA = leerCarta(
  readFileSync(
    fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
    'utf8',
  ),
)

export function montarCarta() {
  const m = montarAcceso()
  sembrar(
    m.db,
    m.access,
    { restauranteId: m.restauranteId, roles: m.roles, menu: CARTA, sinPersonal: true },
    m.clock(),
  )
  const catalog = () => leerCatalogo(m.db, m.restauranteId)
  const products = () => catalog().categories.flatMap((c) => c.products)
  const product = (name: string) => {
    const p = products().find((x) => x.name === name)
    if (!p) throw new Error(`No está ${name}`)
    return p
  }
  return { ...m, catalog, products, product }
}

export async function montarServidor() {
  const m = montarCarta()
  const avisos: number[] = []
  const app = crearServidor({
    access: m.access,
    catalog: {
      db: m.db,
      restauranteId: m.restauranteId,
      access: m.access,
      onChange: (v) => avisos.push(v),
      clock: m.clock,
    },
  })
  await app.ready()
  const register = m.emparejar('register')
  type Sesion = { session_id: string; secret: string }
  const sesionDe = (quien: keyof typeof m.people, connection = register.connection): Sesion => {
    const s = m.entrar(connection, quien)
    return { session_id: s.sesionId, secret: s.secret }
  }
  const send = async (session: Sesion, changes: unknown, token = register.token, extra = {}) => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/catalog/changes',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...session, changes, ...extra },
    })
    return { code: r.statusCode, cuerpo: r.json() }
  }
  const editar = (session: Sesion, changes: unknown[]) => send(session, changes)
  const edicion = async (token = register.token) =>
    app.inject({
      method: 'GET',
      url: '/api/catalog/editing',
      headers: { authorization: `Bearer ${token}` },
    })
  const impuestoId = String(m.db.prepare('SELECT id FROM taxes LIMIT 1').get()?.id)
  const categoriaId = m.catalog().categories[0]?.id as string
  const historial = () => m.db.prepare('SELECT * FROM catalog_changes ORDER BY version').all()
  return {
    ...m,
    app,
    avisos,
    register,
    sesionDe,
    editar,
    send,
    edicion,
    impuestoId,
    categoriaId,
    historial,
  }
}

export type MontajeServidor = Awaited<ReturnType<typeof montarServidor>>
