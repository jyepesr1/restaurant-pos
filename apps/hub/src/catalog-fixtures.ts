import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setupAccess } from './access/setup'
import { readCatalog } from './catalog'
import { readMenu } from './seed/menu'
import { seed } from './seed/seed'
import { createAppServer } from './server'

// Setup for the catalog tests: a hub seeded with the pilot's real menu, the HTTP server with
// editing and a paired register. Tests only.

export const MENU = readMenu(
  readFileSync(
    fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
    'utf8',
  ),
)

export function setupMenu() {
  const m = setupAccess()
  seed(
    m.db,
    m.access,
    { restaurantId: m.restaurantId, roles: m.roles, menu: MENU, withoutStaff: true },
    m.clock(),
  )
  const catalog = () => readCatalog(m.db, m.restaurantId)
  const products = () => catalog().categories.flatMap((c) => c.products)
  const product = (name: string) => {
    const p = products().find((x) => x.name === name)
    if (!p) throw new Error(`Missing ${name}`)
    return p
  }
  return { ...m, catalog, products, product }
}

export async function setupServer() {
  const m = setupMenu()
  const alerts: number[] = []
  const app = createAppServer({
    access: m.access,
    catalog: {
      db: m.db,
      restaurantId: m.restaurantId,
      access: m.access,
      onChange: (v) => alerts.push(v),
      clock: m.clock,
    },
  })
  await app.ready()
  const register = m.pair('register')
  type Session = { session_id: string; secret: string }
  const sessionOf = (who: keyof typeof m.people, connection = register.connection): Session => {
    const s = m.signIn(connection, who)
    return { session_id: s.sessionId, secret: s.secret }
  }
  const send = async (session: Session, changes: unknown, token = register.token, extra = {}) => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/catalog/changes',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...session, changes, ...extra },
    })
    return { code: r.statusCode, body: r.json() }
  }
  const edit = (session: Session, changes: unknown[]) => send(session, changes)
  const editView = async (token = register.token) =>
    app.inject({
      method: 'GET',
      url: '/api/catalog/editing',
      headers: { authorization: `Bearer ${token}` },
    })
  const taxId = String(m.db.prepare('SELECT id FROM taxes LIMIT 1').get()?.id)
  const categoryId = m.catalog().categories[0]?.id as string
  const history = () => m.db.prepare('SELECT * FROM catalog_changes ORDER BY version').all()
  return {
    ...m,
    app,
    alerts,
    register,
    sessionOf,
    edit,
    send,
    editView,
    taxId,
    categoryId,
    history,
  }
}

export type ServerSetup = Awaited<ReturnType<typeof setupServer>>
