import { newId } from '@pos/core'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cookieFrom, panelRequest, putSnapshot, remoteUser, slugOf } from './testing/panel'
import { createWorld, type TestHub, type World } from './testing/world'

// Revoking a register PC and the panel (task 1.11c-1): when a location is left without any active
// PC, nobody can sign in to the panel with that location's users, and their sessions end; a revoked
// PC cannot bring them back; a second active PC keeps the location open.

let m: World
let hub: TestHub
let slug: string
const PASSWORD = 'clave-de-ana-2026'
const ana = remoteUser('ana', PASSWORD)

beforeAll(async () => {
  m = await createWorld()
})

beforeEach(async () => {
  hub = await m.newHub()
  slug = await slugOf(m, hub.restaurantId)
  expect(await putSnapshot(m, hub, 'remote_users', [ana])).toBe(204)
})

const signIn = (password = PASSWORD, ip?: string) =>
  panelRequest(m, 'POST', '/v1/panel/sign-in', {
    body: { restaurant: slug, username: 'ana', password },
    ip,
  })
const me = (cookie: string | null) => panelRequest(m, 'GET', '/v1/panel/me', { cookie })
const rows = async (table: string, restaurantId = hub.restaurantId) =>
  (
    await m.db.query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE restaurant_id = $1`, [
      restaurantId,
    ])
  ).rows

/** Registers another PC in the same location of the same restaurant. */
async function secondPc(): Promise<TestHub> {
  const code = await m.cloud.createCode(hub.restaurantId)
  if (!code) throw new Error('no code')
  const r = await m.cloud.registerHub({
    code: code.code,
    restaurant_id: hub.restaurantId,
    hub_id: newId(),
    location_id: hub.hub.locationId,
    name: 'Caja 2',
    instance: 'i2',
  })
  if (!r.ok) throw new Error(r.reason)
  const authenticated = await m.cloud.authenticate(r.credential)
  if (!authenticated) throw new Error('no hub')
  return { hub: authenticated, credential: r.credential, restaurantId: hub.restaurantId }
}

describe('revoking the only PC of the location', () => {
  it('removes who can sign in, ends their sessions and refuses new ones', async () => {
    const session = cookieFrom(await signIn())
    expect((await me(session)).status).toBe(200)
    expect(await m.cloud.revokeHub(hub.hub.id)).toBe(true)
    expect(await rows('remote_users')).toEqual([])
    expect((await me(session)).status).toBe(401)
    expect((await signIn(PASSWORD, '10.0.0.1')).status).toBe(401)
    // The session is revoked in the table, not only hidden.
    const [row] = await rows('panel_sessions')
    expect(row?.revoked_at).not.toBeNull()
  })

  it('the revoked PC cannot put them back, and its credential is refused', async () => {
    await m.cloud.revokeHub(hub.hub.id)
    expect(await putSnapshot(m, hub, 'remote_users', [ana])).toBe(401)
    expect(await rows('remote_users')).toEqual([])
    expect((await signIn(PASSWORD, '10.0.0.2')).status).toBe(401)
  })

  it('a new PC uploading the same list brings them back, even if the list is the same as before', async () => {
    const old = cookieFrom(await signIn())
    await m.cloud.revokeHub(hub.hub.id)
    const fresh = await secondPc()
    // The very same content the revoked PC had uploaded.
    expect(await putSnapshot(m, fresh, 'remote_users', [ana])).toBe(204)
    expect((await rows('remote_users')).map((r) => r.username)).toEqual(['ana'])
    const again = await signIn()
    expect(again.status).toBe(200)
    // The session closed by the revocation stays closed.
    expect((await me(old)).status).toBe(401)
    expect((await me(cookieFrom(again))).status).toBe(200)
  })

  it('revoking twice, or an unknown PC, changes nothing', async () => {
    expect(await m.cloud.revokeHub(hub.hub.id)).toBe(true)
    const before = await rows('panel_sessions')
    expect(await m.cloud.revokeHub(hub.hub.id)).toBe(false)
    expect(await m.cloud.revokeHub(newId())).toBe(false)
    expect(await rows('panel_sessions')).toEqual(before)
  })
})

describe('with two active PCs in the location', () => {
  it('revoking one keeps the users and the sessions', async () => {
    const other = await secondPc()
    const session = cookieFrom(await signIn())
    expect(await m.cloud.revokeHub(hub.hub.id)).toBe(true)
    expect((await rows('remote_users')).map((r) => r.username)).toEqual(['ana'])
    expect((await me(session)).status).toBe(200)
    expect((await signIn(PASSWORD, '10.0.1.1')).status).toBe(200)
    // The one left can still change the list.
    expect(await putSnapshot(m, other, 'remote_users', [])).toBe(204)
    expect((await me(session)).status).toBe(401)
  })

  it('revoking both is the same as revoking the only one', async () => {
    const other = await secondPc()
    const session = cookieFrom(await signIn())
    await m.cloud.revokeHub(hub.hub.id)
    expect((await me(session)).status).toBe(200)
    await m.cloud.revokeHub(other.hub.id)
    expect((await me(session)).status).toBe(401)
    expect(await rows('remote_users')).toEqual([])
  })
})

describe('other places are not touched', () => {
  it('revoking a PC of another restaurant leaves this one’s users and sessions alone', async () => {
    const other = await m.newHub()
    const session = cookieFrom(await signIn())
    await m.cloud.revokeHub(other.hub.id)
    expect((await me(session)).status).toBe(200)
    expect(await rows('remote_users')).toHaveLength(1)
  })

  it('another location of the same restaurant keeps its own users', async () => {
    // The second location has its own PC and its own list.
    const code = await m.cloud.createCode(hub.restaurantId)
    if (!code) throw new Error('no code')
    const r = await m.cloud.registerHub({
      code: code.code,
      restaurant_id: hub.restaurantId,
      hub_id: newId(),
      location_id: newId(),
      name: 'Sede 2',
      instance: 'i3',
    })
    if (!r.ok) throw new Error(r.reason)
    const sede2 = await m.cloud.authenticate(r.credential)
    if (!sede2) throw new Error('no hub')
    const other = { hub: sede2, credential: r.credential, restaurantId: hub.restaurantId }
    const luis = remoteUser('luis', 'clave-de-luis-1')
    expect(await putSnapshot(m, other, 'remote_users', [luis])).toBe(204)
    expect((await rows('remote_users')).map((u) => u.username).sort()).toEqual(['ana', 'luis'])
    await m.cloud.revokeHub(sede2.id)
    expect((await rows('remote_users')).map((u) => u.username)).toEqual(['ana'])
  })
})
