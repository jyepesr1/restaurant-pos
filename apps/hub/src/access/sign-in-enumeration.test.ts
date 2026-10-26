import { describe, expect, it } from 'vitest'
import { setupApi } from './api-setup'

// A nonexistent user and a wrong password cannot be told apart from outside (ADR-013): same
// status, same body, same wait, across the whole sequence of attempts.

const bodyOf = (r: {
  statusCode: number
  headers: Record<string, unknown>
  // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON response
  json: () => any
}) => ({
  status: r.statusCode,
  body: r.json(),
  retry: r.headers['retry-after'] ?? null,
})

describe('no hints about which users exist', () => {
  it('a whole sequence of attempts on a real account and a made-up one gives identical responses', async () => {
    const api = setupApi()
    const real = api.people.admin.user as string
    const sequence: unknown[][] = [[], []]
    for (const [i, user] of [real, 'fantasma'].entries()) {
      for (let n = 0; n < 8; n++) {
        const r = await api.post(
          '/api/sign-in',
          { user, password: 'no-es-la-clave' },
          { ip: '10.0.0.40' },
        )
        sequence[i]?.push(bodyOf(r))
        api.advance(r.statusCode === 429 ? Number(r.json().wait_ms) : 100)
      }
      // The other account starts from zero in time and IP.
      api.advance(11 * 60_000)
    }
    expect(sequence[0]).toEqual(sequence[1])
    expect(sequence[0]?.[0]).toEqual({
      status: 401,
      body: { error: 'invalid_credentials', message: 'Usuario o contraseña incorrectos' },
      retry: null,
    })
  })

  it('every form of «does not exist» responds the same as a wrong password', async () => {
    const api = setupApi()
    // An archived person, one who signs in with a PIN (no username) and names that are not users.
    const archivedUser = api.access.createUser({
      name: 'Archivada',
      roleId: api.roles.cashier,
      user: 'archivada',
      password: 'clave-correcta-1',
    })
    api.access.archiveUser(archivedUser.userId)
    const cases: { user: string; password: string }[] = [
      { user: api.people.admin.user as string, password: 'clave-equivocada' },
      { user: 'nadie', password: 'clave-equivocada' },
      { user: 'archivada', password: 'clave-correcta-1' },
      { user: 'Ana', password: 'clave-equivocada' },
      { user: '', password: '' },
      { user: ' ', password: 'clave-equivocada' },
      { user: 'a', password: 'clave-equivocada' },
      { user: 'con espacio', password: 'clave-equivocada' },
      { user: 'ñandú', password: 'clave-equivocada' },
      { user: 'x'.repeat(100), password: 'clave-equivocada' },
      { user: "' OR 1=1 --", password: 'clave-equivocada' },
    ]
    const responses = []
    for (const [i, c] of cases.entries()) {
      // A different IP for each case and the clock moved forward: each one is its first attempt.
      responses.push(bodyOf(await api.post('/api/sign-in', c, { ip: `10.2.0.${i + 1}` })))
      api.advance(11 * 60_000)
    }
    for (const r of responses) expect(r).toEqual(responses[0])
  })

  it('a person who signs in with a PIN is not exposed: their name as username fails like any other', async () => {
    const api = setupApi()
    const toName = await api.post('/api/sign-in', {
      user: 'ana',
      password: api.people.waiter.pin.repeat(2),
    })
    const toNobody = await api.post(
      '/api/sign-in',
      { user: 'nadie', password: api.people.waiter.pin.repeat(2) },
      { ip: '10.0.0.41' },
    )
    expect(bodyOf(toName)).toEqual(bodyOf(toNobody))
  })

  it('errors do not echo the typed username or password', async () => {
    const api = setupApi()
    const r = await api.post('/api/sign-in', {
      user: 'quien-sea',
      password: 'la-clave-que-escribi-1',
    })
    expect(r.body).not.toContain('quien-sea')
    expect(r.body).not.toContain('la-clave-que-escribi-1')
  })

  it('the PIN of someone with a password and a nonexistent PIN fail the same', async () => {
    const api = setupApi()
    const withUser = await api.post(
      '/api/sign-in',
      { pin: api.people.admin.pin },
      { ip: '10.0.0.50' },
    )
    const nonexistent = await api.post('/api/sign-in', { pin: '0007' }, { ip: '10.0.0.51' })
    expect(bodyOf(withUser)).toEqual(bodyOf(nonexistent))
  })

  it('the wait for a nonexistent account is recorded the same as for a real one: both lock on the 3rd', async () => {
    const api = setupApi()
    for (const user of [api.people.admin.user as string, 'inventado']) {
      const statuses: number[] = []
      for (let i = 0; i < 4; i++)
        statuses.push(
          (
            await api.post(
              '/api/sign-in',
              { user, password: 'incorrecta-xx' },
              { ip: `10.0.${user.length}.${i}` },
            )
          ).statusCode,
        )
      expect(statuses).toEqual([401, 401, 401, 429])
      api.advance(11 * 60_000)
    }
  })
})
