import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { createAppServer } from '../server'
import { setupAccess } from './setup'

function setupApi() {
  const m = setupAccess()
  const app = createAppServer({ access: m.access })
  const post = (url: string, body: unknown, token?: string) =>
    app.inject({
      method: 'POST',
      url,
      payload: body as object,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  return { ...m, app, post }
}

/**
 * A device as in the restaurant (ADR-013): it signs in without pairing and the hub registers it.
 * The register signs in with the admin password; the phone, with Luis's PIN (Ana stays free for
 * each test). A kitchen screen does get paired, from an already registered device.
 */
async function pairViaApi(api: ReturnType<typeof setupApi>, type = 'waiter', from?: string) {
  if (type === 'kds') {
    const code = await api.post(
      '/api/pairings',
      { pin: api.people.admin.pin, name: 'Cocina', type },
      from,
    )
    expect(code.statusCode).toBe(201)
    const r = await api.post('/api/pair', { code: code.json().code })
    expect(r.statusCode).toBe(201)
    return r.json() as { token: string; device_id: string }
  }
  const r = await api.post(
    '/api/sign-in',
    type === 'register'
      ? { user: api.people.admin.user, password: api.people.admin.password }
      : { pin: api.people.waiter2.pin },
  )
  expect(r.statusCode).toBe(201)
  return r.json().device as { token: string; device_id: string }
}

describe('access API', () => {
  it('pair, sign in with PIN and close the session', async () => {
    const api = setupApi()
    const { token } = await pairViaApi(api)

    const session = await api.post('/api/sessions', { pin: api.people.waiter.pin }, token)
    expect(session.statusCode).toBe(201)
    expect(session.json()).toMatchObject({ user: { name: 'Ana', role: 'Mesero' } })
    expect(session.json().permissions).toContain('take_order')

    const { session_id, secret } = session.json()
    const close = await api.post('/api/sessions/close', { session_id, secret }, token)
    expect(close.statusCode).toBe(204)
  })

  it('without a token, or with a fake one, answers 401', async () => {
    const api = setupApi()
    expect((await api.post('/api/sessions', { pin: '4821' })).statusCode).toBe(401)
    const fake = await api.post('/api/sessions', { pin: '4821' }, 'inventado')
    expect(fake.statusCode).toBe(401)
    expect(fake.json()).toMatchObject({ error: 'invalid_token' })
  })

  it('wrong PIN: 401; after three, 429 with Retry-After', async () => {
    const api = setupApi()
    const { token } = await pairViaApi(api)
    const r1 = await api.post('/api/sessions', { pin: '0001' }, token)
    await api.post('/api/sessions', { pin: '0002' }, token)
    const r3 = await api.post('/api/sessions', { pin: '0003' }, token)
    const r4 = await api.post('/api/sessions', { pin: api.people.waiter.pin }, token)

    expect(r1.statusCode).toBe(401)
    expect(r3.json()).toMatchObject({ error: 'wrong_pin', wait_ms: 2000 })
    expect(r4.statusCode).toBe(429)
    expect(r4.headers['retry-after']).toBe('2')
  })

  it('supervisor authorization and revocation via the API', async () => {
    const api = setupApi()
    const register = await pairViaApi(api, 'register')
    const phone = await pairViaApi(api, 'waiter', register.token)
    const waiter = (
      await api.post('/api/sessions', { pin: api.people.waiter.pin }, phone.token)
    ).json()

    const authorization = await api.post(
      '/api/authorizations',
      {
        session_id: waiter.session_id,
        secret: waiter.secret,
        pin: api.people.manager.pin,
        action: 'void_sent_item',
        aggregate_id: newId(),
        event_id: newId(),
        fingerprint: 'b'.repeat(64),
      },
      phone.token,
    )
    expect(authorization.statusCode).toBe(201)
    expect(authorization.json().supervisor.name).toBe('Gloria')

    const admin = (
      await api.post(
        '/api/sign-in',
        { user: api.people.admin.user, password: api.people.admin.password },
        register.token,
      )
    ).json()
    const revoke = await api.post(
      `/api/devices/${phone.device_id}/revoke`,
      { session_id: admin.session_id, secret: admin.secret },
      register.token,
    )
    expect(revoke.statusCode).toBe(200)
    const after = await api.post('/api/sessions', { pin: api.people.waiter.pin }, phone.token)
    expect(after.statusCode).toBe(403)
    expect(after.json()).toMatchObject({ error: 'revoked_device' })
  })

  it('a body with an unexpected format answers 400 without touching anything', async () => {
    const api = setupApi()
    const r = await api.post('/api/pairings', { pin: 1234, name: 'X', type: 'register' })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ error: 'invalid_data' })
    const extra = await api.post('/api/pair', { code: 'X', other: 1 })
    expect(extra.statusCode).toBe(400)
  })
})
