import { Buffer } from 'node:buffer'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DECOY_VERIFIER, passwordMatches } from './password'
import { panelRequest, putSnapshot, remoteUser, slugOf } from './testing/panel'
import { createWorld, type World } from './testing/world'

// The panel computes a password hash in the same cases whether the user exists or not, so the time
// of the answer does not tell them apart (we cannot measure time deterministically: we count which
// hashes are computed and against which verifier).

vi.mock('./password', async (original) => {
  const actual = await original<typeof import('./password')>()
  return { ...actual, passwordMatches: vi.fn(actual.passwordMatches) }
})

const hashes = vi.mocked(passwordMatches)

let m: World
let slug: string
let verifier: string
const PASSWORD = 'clave-de-ana-2026'

beforeAll(async () => {
  m = await createWorld()
})

beforeEach(async () => {
  const hub = await m.newHub()
  slug = await slugOf(m, hub.restaurantId)
  const ana = remoteUser('ana', PASSWORD)
  const luis = remoteUser('luis', 'clave-de-luis-1', ['view_reports'])
  verifier = ana.verifier
  expect(await putSnapshot(m, hub, 'remote_users', [ana, luis])).toBe(204)
  hashes.mockClear()
})

const signIn = (body: Record<string, unknown>, ip: string) =>
  panelRequest(m, 'POST', '/v1/panel/sign-in', {
    body: { restaurant: slug, username: 'ana', password: PASSWORD, ...body },
    ip,
  })
const verifiersUsed = () => hashes.mock.calls.map((c) => c[1])

describe('which hashes the sign-in computes', () => {
  it('a wrong password for a real user: one hash against their verifier', async () => {
    expect((await signIn({ password: 'mala-clave-1234' }, '10.0.0.1')).status).toBe(401)
    expect(verifiersUsed()).toEqual([verifier])
  })

  it('a user that does not exist: one hash against the decoy', async () => {
    expect((await signIn({ username: 'nadie' }, '10.0.0.2')).status).toBe(401)
    expect(verifiersUsed()).toEqual([DECOY_VERIFIER])
  })

  it('the right password of someone without remote_access: one hash, and the same plain 401', async () => {
    const r = await signIn({ username: 'luis', password: 'clave-de-luis-1' }, '10.0.0.3')
    expect(r.status).toBe(401)
    expect(hashes).toHaveBeenCalledTimes(1)
  })

  it('the right password: one hash', async () => {
    expect((await signIn({}, '10.0.0.4')).status).toBe(200)
    expect(verifiersUsed()).toEqual([verifier])
  })

  it('while a wait is running, nothing is hashed (no work is given to someone being refused)', async () => {
    for (let i = 0; i < 3; i++) await signIn({ password: 'mala-clave-1234' }, `10.0.1.${i}`)
    hashes.mockClear()
    for (let i = 0; i < 5; i++)
      expect((await signIn({ password: 'mala-clave-1234' }, `10.0.2.${i}`)).status).toBe(429)
    expect(hashes).not.toHaveBeenCalled()
  })

  it('a restaurant or a username that cannot exist is refused without hashing', async () => {
    await signIn({ restaurant: 'no-existe' }, '10.0.3.1')
    await signIn({ username: 'x' }, '10.0.3.2')
    await signIn({ restaurant: '¡mal!' }, '10.0.3.3')
    expect(hashes).not.toHaveBeenCalled()
  })

  it('only one hash per attempt, however many keys are charged', async () => {
    await signIn({ password: 'mala-clave-1234' }, '10.0.4.1')
    await signIn({ password: 'mala-clave-1234' }, '10.0.4.2')
    expect(hashes).toHaveBeenCalledTimes(2)
  })
})

describe('the decoy verifier', () => {
  it('has the production cost and size, so computing it takes the same as a real one', () => {
    const [schema, cost, r, p, salt, hash] = DECOY_VERIFIER.split('$')
    expect([schema, cost, r, p]).toEqual(['scrypt', '15', '8', '1'])
    expect(Buffer.from(salt as string, 'base64url').length).toBeGreaterThanOrEqual(16)
    expect(Buffer.from(hash as string, 'base64url').length).toBe(32)
  })

  it('no password matches it', async () => {
    const actual = await vi.importActual<typeof import('./password')>('./password')
    for (const password of [
      '',
      'a',
      PASSWORD,
      'faro-panel-rellenos',
      DECOY_VERIFIER,
      'x'.repeat(200),
    ])
      expect(await actual.passwordMatches(password, DECOY_VERIFIER)).toBe(false)
  })
})

describe('verifiers that are not valid', () => {
  it('never match and never throw: wrong schema, cost, shape, missing parts', async () => {
    const actual = await vi.importActual<typeof import('./password')>('./password')
    const salt = 'AAAAAAAAAAAAAAAAAAAAAA'
    const hash = 'A'.repeat(43)
    for (const bad of [
      '',
      'scrypt',
      `scrypt$4$8$1$${salt}`,
      `argon2$4$8$1$${salt}$${hash}`,
      `scrypt$0$8$1$${salt}$${hash}`,
      `scrypt$18$8$1$${salt}$${hash}`,
      `scrypt$4$9$1$${salt}$${hash}`,
      `scrypt$4$8$2$${salt}$${hash}`,
      `scrypt$x$8$1$${salt}$${hash}`,
      `scrypt$4.5$8$1$${salt}$${hash}`,
      `scrypt$4$8$1$$${hash}`,
      `scrypt$4$8$1$${salt}$`,
    ])
      expect(await actual.passwordMatches('cualquiera', bad), bad).toBe(false)
  })
})
