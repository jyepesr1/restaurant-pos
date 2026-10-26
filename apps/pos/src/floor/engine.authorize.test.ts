import 'fake-indexeddb/auto'
import { authorizableFingerprint, newId, signEvent } from '@pos/core'
import type { Channel } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { type Device, Floor, type Session } from './engine'
import { DeviceDatabase } from './store'
import { testCatalog } from './testing'

// The engine with a supervisor's PIN (task 1.5, ADR-008): `record(..., { reason, authorizes })`
// requests `/api/authorizations` with the event's fingerprint, and the event goes out with the
// approval and its signature. Offline, or with a PIN the hub does not accept, nothing is saved.

const floors: Floor[] = []
const databases: DeviceDatabase[] = []
afterEach(async () => {
  for (const s of floors.splice(0)) s.simulateOffline(true)
  vi.unstubAllGlobals()
  await new Promise((r) => setTimeout(r, 20))
  for (const b of databases.splice(0)) await b.delete()
})

const noNetwork = (): Channel => ({ send: () => {}, close: () => {} })
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface Call {
  url: string
  body: Record<string, unknown> | null
  token: string | null
}

function fakeHub(respond: (l: Call) => Response) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const call: Call = {
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        token: headers.authorization?.replace('Bearer ', '') ?? null,
      }
      calls.push(call)
      if (url === '/api/catalog') return json(testCatalog())
      return respond(call)
    }),
  )
  return calls
}
const authorizations = (l: Call[]) => l.filter((x) => x.url === '/api/authorizations')

const device: Device = {
  deviceId: newId(),
  token: 'token-ana',
  name: 'Ana',
  type: 'waiter',
}
const waiterSession = (): Session => ({
  sessionId: newId(),
  secret: 'secreto-ana',
  user: { id: newId(), name: 'Ana', role: 'Mesero' },
  permissions: ['take_order'],
  lastUsed: Date.now(),
})

async function open(session: Session | null = waiterSession()) {
  const db = new DeviceDatabase(`prueba-${newId()}`)
  databases.push(db)
  await db.saveSetting('device', device)
  if (session) await db.saveSetting('session', session)
  await db.saveSetting('catalog', testCatalog())
  const floor = new Floor({ db, open: noNetwork })
  floors.push(floor)
  await floor.load()
  return { floor, session }
}

const VOID_ITEM = { item_id: newId(), quantity: 1, already_prepared: false, ticket_id: null }
const APPROVAL = newId()
const grants = () =>
  json({ authorization_id: APPROVAL, supervisor: { id: newId(), name: 'Gloria' } }, 201)
const savedList = async (floor: Floor) => (await floor.sync?.locals()) ?? []

describe('Floor.record with authorizes', () => {
  it('requests the approval with the event fingerprint, for that order, that event and that action', async () => {
    const calls = fakeHub(grants)
    const { floor, session } = await open()
    const order = newId()
    const event = await floor.record('ItemVoided', order, VOID_ITEM, {
      reason: 'Error del mesero',
      authorizes: { pin: '4321', permission: 'void_sent_item' },
    })
    const [call, ...others] = authorizations(calls)
    expect(others).toEqual([])
    expect(call).toMatchObject({
      token: 'token-ana',
      body: {
        session_id: session?.sessionId,
        secret: 'secreto-ana',
        pin: '4321',
        action: 'void_sent_item',
        aggregate_id: order,
        event_id: event.id,
      },
    })
    // The fingerprint is the event's as it went out (without approval or signature).
    expect(call?.body?.fingerprint).toBe(authorizableFingerprint(event))
    expect(call?.body?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('the event goes out with the hub authorization_id and a valid signature that covers that approval', async () => {
    fakeHub(grants)
    const { floor } = await open()
    const event = await floor.record('ItemVoided', newId(), VOID_ITEM, {
      reason: 'Demora',
      authorizes: { pin: '4321', permission: 'void_sent_item' },
    })
    expect(event.authorization_id).toBe(APPROVAL)
    const { signature, ...unsigned } = event
    expect(signature).toBe(signEvent(unsigned as never, 'secreto-ana'))
    // The signature changes if the approval changes: it is signed with it set.
    expect(signEvent({ ...unsigned, authorization_id: null } as never, 'secreto-ana')).not.toBe(
      signature,
    )
    // And the fingerprint (without approval) does not change by setting it.
    expect(authorizableFingerprint({ ...unsigned, authorization_id: null } as never)).toBe(
      authorizableFingerprint(event),
    )
  })

  it('the event is saved on the device, pending, with the approval and the reason', async () => {
    fakeHub(grants)
    const { floor } = await open()
    const event = await floor.record(
      'OrderCanceled',
      newId(),
      {},
      {
        reason: 'El cliente cambió',
        authorizes: { pin: '1111', permission: 'cancel_order' },
      },
    )
    const saved = (await savedList(floor)).find((l) => l.event.id === event.id)
    expect(saved).toMatchObject({
      status: 'pending',
      event: {
        authorization_id: APPROVAL,
        reason: 'El cliente cambió',
        type: 'OrderCanceled',
      },
    })
  })

  it('the requested action is the permission, as is (cancel_order)', async () => {
    const calls = fakeHub(grants)
    const { floor } = await open()
    await floor.record(
      'OrderCanceled',
      newId(),
      {},
      {
        reason: 'x',
        authorizes: { pin: '1111', permission: 'cancel_order' },
      },
    )
    expect(authorizations(calls)[0]?.body?.action).toBe('cancel_order')
  })

  it('each event requests its own approval (different event_id)', async () => {
    const calls = fakeHub(grants)
    const { floor } = await open()
    const a = await floor.record('ItemVoided', newId(), VOID_ITEM, {
      reason: 'x',
      authorizes: { pin: '4321', permission: 'void_sent_item' },
    })
    const b = await floor.record('ItemVoided', newId(), VOID_ITEM, {
      reason: 'x',
      authorizes: { pin: '4321', permission: 'void_sent_item' },
    })
    const ids = authorizations(calls).map((l) => l.body?.event_id)
    expect(ids).toEqual([a.id, b.id])
    expect(a.id).not.toBe(b.id)
  })

  it('reason and related reach the event, with or without approval', async () => {
    const calls = fakeHub(grants)
    const { floor } = await open()
    const target = newId()
    const move = await floor.record(
      'OrderMovedTable',
      newId(),
      { target_table_id: newId() },
      { related: [target], reason: 'por si acaso' },
    )
    expect(move).toMatchObject({
      related: [target],
      reason: 'por si acaso',
      authorization_id: null,
    })
    expect(authorizations(calls)).toHaveLength(0)
    const voidItem = await floor.record('ItemVoided', newId(), VOID_ITEM, {
      reason: 'Demora',
      related: [target],
      authorizes: { pin: '4321', permission: 'void_sent_item' },
    })
    expect(voidItem).toMatchObject({ related: [target], reason: 'Demora' })
    // The fingerprint covers the reason and the related ones: they are part of the content
    // being authorized.
    expect(authorizations(calls)[0]?.body?.fingerprint).toBe(authorizableFingerprint(voidItem))
  })

  it('without options: reason null, no related and no approval (as before)', async () => {
    const calls = fakeHub(grants)
    const { floor } = await open()
    const e = await floor.record('GuestsChanged', newId(), { guests: 3 })
    expect(e).toMatchObject({ reason: null, related: [], authorization_id: null })
    expect(authorizations(calls)).toEqual([])
  })

  it('offline from the register it fails cleanly: ApiError offline and nothing is saved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const { floor } = await open()
    await expect(
      floor.record('ItemVoided', newId(), VOID_ITEM, {
        reason: 'x',
        authorizes: { pin: '4321', permission: 'void_sent_item' },
      }),
    ).rejects.toMatchObject({ code: 'offline' })
    expect(await savedList(floor)).toEqual([])
  })

  it('with the simulated outage the call does not go out either and the event is not saved', async () => {
    const calls = fakeHub(grants)
    const { floor } = await open()
    floor.simulateOffline(true)
    const r = floor.record('ItemVoided', newId(), VOID_ITEM, {
      reason: 'x',
      authorizes: { pin: '4321', permission: 'void_sent_item' },
    })
    await expect(r).rejects.toBeInstanceOf(ApiError)
    await expect(r).rejects.toMatchObject({ code: 'offline' })
    expect(authorizations(calls)).toEqual([])
    expect(await savedList(floor)).toEqual([])
  })

  it.each([
    ['wrong PIN', 401, 'wrong_pin'],
    ['the same user', 403, 'self_authorization'],
    ['too many attempts', 429, 'too_many_attempts'],
  ])(
    'if the hub says %s, it fails with that code and nothing is saved or signed',
    async (_n, status, code) => {
      fakeHub(() => json({ error: code, message: 'No se pudo autorizar' }, status))
      const { floor } = await open()
      await expect(
        floor.record('ItemVoided', newId(), VOID_ITEM, {
          reason: 'x',
          authorizes: { pin: '0000', permission: 'void_sent_item' },
        }),
      ).rejects.toMatchObject({ code, message: 'No se pudo autorizar' })
      expect(await savedList(floor)).toEqual([])
      expect(floor.snapshot().session).not.toBeNull()
    },
  )

  it('if the hub says the session is no longer valid, the device session is closed', async () => {
    fakeHub(() => json({ error: 'invalid_session', message: 'Entra otra vez' }, 401))
    const { floor } = await open()
    await expect(
      floor.record('ItemVoided', newId(), VOID_ITEM, {
        reason: 'x',
        authorizes: { pin: '4321', permission: 'void_sent_item' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_session' })
    expect(floor.snapshot().session).toBeNull()
    expect(await savedList(floor)).toEqual([])
  })

  it('without a session it does not call the hub and says one must sign in', async () => {
    const calls = fakeHub(grants)
    const { floor } = await open(null)
    await expect(
      floor.record('ItemVoided', newId(), VOID_ITEM, {
        reason: 'x',
        authorizes: { pin: '4321', permission: 'void_sent_item' },
      }),
    ).rejects.toThrow('Sin sesión')
    expect(authorizations(calls)).toEqual([])
  })

  it('an approval failure leaves the session open and the next attempt does work', async () => {
    let n = 0
    const calls = fakeHub(() =>
      n++ === 0 ? json({ error: 'wrong_pin', message: 'PIN incorrecto' }, 401) : grants(),
    )
    const { floor } = await open()
    const data = {
      reason: 'x',
      authorizes: { pin: '4321', permission: 'void_sent_item' },
    }
    await expect(floor.record('ItemVoided', newId(), VOID_ITEM, data)).rejects.toMatchObject({
      code: 'wrong_pin',
    })
    const e = await floor.record('ItemVoided', newId(), VOID_ITEM, data)
    expect(e.authorization_id).toBe(APPROVAL)
    expect(authorizations(calls)).toHaveLength(2)
    expect((await savedList(floor)).map((l) => l.event.id)).toEqual([e.id])
  })
})
