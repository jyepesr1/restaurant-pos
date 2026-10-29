import { describe, expect, it, vi } from 'vitest'
import {
  OFFLINE,
  PanelError,
  panelApi,
  rulesOf,
  SESSION_CLOSED,
  WRONG_CREDENTIALS,
  WRONG_ORIGIN,
  waitInWords,
  waitOf,
} from './api'
import { me } from './testing'

// The panel's client (task 1.11c-1): the cookie goes on every call, and every answer of the cloud
// becomes a clear message in Spanish. A 401 outside sign-in takes the panel back to «Entrar».

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

function withAnswer(answer: Response | Error) {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    if (answer instanceof Error) throw answer
    return answer
  })
  const onUnauthorized = vi.fn()
  return {
    fetch,
    onUnauthorized,
    api: panelApi({ fetch: fetch as typeof globalThis.fetch, onUnauthorized }),
  }
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    if (e instanceof PanelError) return e
    throw e
  }
  throw new Error('it did not fail')
}

describe('the panel client', () => {
  it('signs in with POST, JSON and the same-origin cookie', async () => {
    const { api, fetch } = withAnswer(json(200, me()))
    const answer = await api.signIn({
      restaurant: 'la-spritzzeria',
      username: 'ana',
      password: 'x',
    })
    expect(answer.restaurant.slug).toBe('la-spritzzeria')
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url).toBe('/v1/panel/sign-in')
    expect(init?.method).toBe('POST')
    expect(init?.credentials).toBe('same-origin')
    expect(JSON.parse(String(init?.body))).toEqual({
      restaurant: 'la-spritzzeria',
      username: 'ana',
      password: 'x',
    })
  })

  it('a 401 at sign-in is «Usuario o contraseña incorrectos» and does not close any session', async () => {
    const { api, onUnauthorized } = withAnswer(json(401, { error: 'invalid_credentials' }))
    const e = await failure(api.signIn({ restaurant: 'x', username: 'a', password: 'b' }))
    expect(e.kind).toBe('unauthorized')
    expect(e.message).toBe(WRONG_CREDENTIALS)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it.each(['summary', 'reports'] as const)('a 401 in %s means the session died', async (route) => {
    const { api, onUnauthorized } = withAnswer(json(401, { error: 'unauthorized' }))
    const e = await failure(route === 'summary' ? api.summary() : api.reports(null))
    expect(e.message).toBe(SESSION_CLOSED)
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('a failed sign-in says the same for everything and carries the wait the cloud asks', async () => {
    expect(WRONG_CREDENTIALS).toBe('Revisa el restaurante, el usuario y la contraseña')
    const { api } = withAnswer(json(401, { error: 'invalid_credentials', wait_ms: 2000 }))
    const e = await failure(api.signIn({ restaurant: 'x', username: 'a', password: 'b' }))
    expect(e.message).toBe(WRONG_CREDENTIALS)
    expect(e.waitMs).toBe(2000)
  })

  it('a 403 for the address (invalid_origin) is not about permissions', async () => {
    const { api } = withAnswer(json(403, { error: 'invalid_origin' }))
    const e = await failure(api.signIn({ restaurant: 'x', username: 'a', password: 'b' }))
    expect(e.message).toBe(WRONG_ORIGIN)
    expect(e.message).not.toMatch(/permiso/)
  })

  it('a 401 when asking who is signed in only means there is no session yet', async () => {
    const { api, onUnauthorized } = withAnswer(json(401, {}))
    expect((await failure(api.me())).kind).toBe('unauthorized')
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('a 429 says how long to wait, from the body or from Retry-After', async () => {
    const body = withAnswer(json(429, { error: 'too_many_attempts', wait_ms: 8000 }))
    const e = await failure(body.api.signIn({ restaurant: 'x', username: 'a', password: 'b' }))
    expect(e.kind).toBe('rate_limited')
    expect(e.waitMs).toBe(8000)
    expect(e.message).toBe('Demasiados intentos. Espera 8 s y vuelve a intentar.')

    const header = withAnswer(json(429, null, { 'retry-after': '3' }))
    expect((await failure(header.api.summary())).waitMs).toBe(3000)

    const neither = withAnswer(json(429, {}))
    const n = await failure(neither.api.summary())
    expect(n.waitMs).toBe(0)
    expect(n.message).toMatch(/Espera un momento/)
  })

  it('without internet it says so, without a status', async () => {
    const { api } = withAnswer(new TypeError('Failed to fetch'))
    const e = await failure(api.summary())
    expect(e.kind).toBe('offline')
    expect(e.message).toBe(OFFLINE)
  })

  it('403, 400 and 500 each have their message', async () => {
    expect((await failure(withAnswer(json(403, {})).api.summary())).message).toMatch(/permiso/)
    expect(
      (
        await failure(
          withAnswer(json(400, { message: 'Elige un período de 31 días o menos' })).api.reports(
            null,
          ),
        )
      ).message,
    ).toBe('Elige un período de 31 días o menos')
    const server = await failure(withAnswer(new Response('oops', { status: 502 })).api.summary())
    expect(server.kind).toBe('server')
    expect(server.message).toContain('(502)')
  })

  it('reports go with the dates in the address, or without them for today', async () => {
    const dated = withAnswer(json(200, {}))
    await dated.api.reports({ from: '2026-10-01', until: '2026-10-29' })
    expect(dated.fetch.mock.calls[0]?.[0]).toBe(
      '/v1/panel/reports?from=2026-10-01&until=2026-10-29',
    )
    const today = withAnswer(json(200, {}))
    await today.api.reports(null)
    expect(today.fetch.mock.calls[0]?.[0]).toBe('/v1/panel/reports')
  })

  it('signing out takes a 204 with no body', async () => {
    const { api, fetch } = withAnswer(new Response(null, { status: 204 }))
    await expect(api.signOut()).resolves.toBeUndefined()
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('POST')
  })
})

describe('the rules of the reports', () => {
  it('are the menu payment methods with the cloud time zone, or none', () => {
    const who = me(undefined, { time_zone: 'America/Lima' })
    expect(rulesOf(who)?.timeZone).toBe('America/Lima')
    expect(rulesOf(who)?.customMethods).toEqual([{ id: 'qr', name: 'QR Bancolombia' }])
    expect(rulesOf(me(undefined, { payment_methods: null }))).toBeNull()
  })
})

describe('answers that are not the cloud', () => {
  it('a 204 where data is expected is not an empty answer: it is like having no internet', async () => {
    const { api } = withAnswer(new Response(null, { status: 204 }))
    const e = await failure(api.summary())
    expect(e.kind).toBe('offline')
    expect(e.message).toBe(OFFLINE)
  })

  it('a 200 with JSON that is not an object (null) is not trusted either', async () => {
    expect((await failure(withAnswer(json(200, null)).api.me())).kind).toBe('offline')
  })
})

describe('the wait', () => {
  it('reads the body first, then the header, and ignores nonsense', () => {
    expect(waitOf({ wait_ms: 1500 }, '9')).toBe(1500)
    expect(waitOf(null, '2')).toBe(2000)
    expect(waitOf({ wait_ms: 'x' }, 'soon')).toBe(0)
    expect(waitOf({ wait_ms: -5 }, null)).toBe(0)
  })

  it('rounds up and never says 0 s', () => {
    expect(waitInWords(1500)).toBe('Espera 2 s')
    expect(waitInWords(10_000)).toBe('Espera 10 s')
    expect(waitInWords(0)).toBe('Espera 1 s')
  })
})
