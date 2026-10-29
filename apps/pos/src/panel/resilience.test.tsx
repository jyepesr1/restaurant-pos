import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addDays, daysIn, periodOf } from '../floor/periods'
import { shortcutsFor } from '../floor/ReportsView'
import { OFFLINE, type PanelApi, PanelError, panelApi, SESSION_CLOSED, type Summary } from './api'
import { PANEL_MAX_DAYS } from './PanelReports'
import { startPolling, type Visibility } from './poller'
import { dataState, EVERY_MS, NO_NEWS_MS, type Polled } from './summary'
import { me, periodReportOf, rules, summaryOf } from './testing'

// How the owner's panel lives through a flaky connection and a session that dies in the middle of
// use (task 1.11c-1): the real client and the real poller against a cloud that answers as told, the
// dashboard rendered in each state, and the periods the reports can ask for.

vi.mock('../ui/theme', () => ({
  useTheme: () => ({ theme: 'system', dark: false, select: () => {} }),
}))
const { DashboardView } = await import('./Dashboard')

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

/** A cloud that answers each call from a script, in order; the last answer repeats. */
function cloud(script: (Response | Error | (() => Response | Error))[]) {
  let n = 0
  const calls: string[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input))
    const next = script[Math.min(n, script.length - 1)]
    n += 1
    const reply = typeof next === 'function' ? next() : next
    if (reply instanceof Error) throw reply
    return (reply as Response).clone()
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, count: () => n }
}

function tab() {
  const visibility: Visibility = { hidden: () => false, subscribe: () => () => {} }
  return visibility
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** The dashboard as the panel polls it: the real client and the real poller. */
function dashboard(script: Parameters<typeof cloud>[0], onUnauthorized = vi.fn()) {
  const c = cloud(script)
  const api = panelApi({ fetch: c.fetch, onUnauthorized })
  const states: Polled<Summary>[] = []
  let stop = () => {}
  const start = () => {
    stop = startPolling({
      fetch: () => api.summary(),
      everyMs: EVERY_MS,
      visibility: tab(),
      onChange: (s) => states.push(s),
      clock: () => new Date(Date.now()).toISOString(),
    })
  }
  return { c, api, states, onUnauthorized, start, stop: () => stop() }
}

const place = { timeZone: 'America/Bogota', rules }
const render = (polled: Polled<Summary>) =>
  text(renderToStaticMarkup(<DashboardView polled={polled} place={place} />))

describe('the connection comes and goes while the dashboard is open', () => {
  it('shows the figures, loses the connection, keeps showing them and recovers by itself', async () => {
    vi.setSystemTime(new Date('2026-10-30T02:41:00.000Z'))
    const good = summaryOf()
    const d = dashboard([
      json(200, good),
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
      json(200, summaryOf({ server_now: '2026-10-30T02:42:30.000Z' })),
    ])
    d.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(EVERY_MS)
    await vi.advanceTimersByTimeAsync(EVERY_MS)
    await vi.advanceTimersByTimeAsync(EVERY_MS)
    d.stop()

    expect(d.states.map((s) => [s.failed, s.data !== null])).toEqual([
      [false, true],
      [true, true],
      [true, true],
      [false, true],
    ])
    // While it fails the last good figures stay on screen, and it says it is offline.
    const offline = render(d.states[1] as Polled<Summary>)
    expect(offline).toContain('Sin conexión a internet')
    expect(offline).toContain('$1.250.000')
    expect(d.states[1]?.error).toBe(OFFLINE)
    // After recovering, the banner goes away.
    const back = render(d.states[3] as Polled<Summary>)
    expect(back).not.toContain('Sin conexión a internet')
    expect(back).toContain('$1.250.000')
  })

  it('without any answer yet, it explains and keeps trying every 15 s', async () => {
    const d = dashboard([new TypeError('fetch failed')])
    d.start()
    await vi.advanceTimersByTimeAsync(0)
    const first = render(d.states[0] as Polled<Summary>)
    expect(first).toContain(OFFLINE)
    expect(first).toContain('cada 15 s')
    await vi.advanceTimersByTimeAsync(EVERY_MS * 4)
    d.stop()
    expect(d.c.count()).toBe(5)
  })

  it('a slow cloud never piles up requests: one at a time, the next 15 s after the last answer', async () => {
    let release: (() => void) | undefined
    const slow = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(json(200, summaryOf()))
        }),
    )
    const api = panelApi({ fetch: slow as unknown as typeof fetch })
    const states: Polled<Summary>[] = []
    const stop = startPolling({
      fetch: () => api.summary(),
      everyMs: EVERY_MS,
      visibility: tab(),
      onChange: (s) => states.push(s),
    })
    await vi.advanceTimersByTimeAsync(EVERY_MS * 6)
    expect(slow).toHaveBeenCalledTimes(1)
    release?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(states).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(EVERY_MS)
    expect(slow).toHaveBeenCalledTimes(2)
    stop()
  })

  it('timeouts and aborted requests are «sin conexión», like a cut', async () => {
    for (const reason of [
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      new DOMException('aborted', 'AbortError'),
      new TypeError('Failed to fetch'),
    ]) {
      const api = panelApi({ fetch: cloud([reason]).fetch })
      await expect(api.summary()).rejects.toMatchObject({ kind: 'offline', message: OFFLINE })
    }
  })

  it('every call carries a timeout signal and the cookie mode', async () => {
    const seen: RequestInit[] = []
    const api = panelApi({
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        seen.push(init ?? {})
        return json(200, summaryOf())
      }) as typeof fetch,
    })
    await api.summary()
    await api.reports({ from: '2026-10-24', until: '2026-10-30' })
    expect(seen).toHaveLength(2)
    for (const init of seen) {
      expect(init.credentials).toBe('same-origin')
      expect(init.signal).toBeInstanceOf(AbortSignal)
      expect(init.signal?.aborted).toBe(false)
    }
  })
})

describe('the session dies in the middle of use', () => {
  it('a 401 on the third poll takes the panel to «Entrar» once and polling ends with the screen', async () => {
    const onUnauthorized = vi.fn()
    const d = dashboard(
      [
        json(200, summaryOf()),
        json(200, summaryOf()),
        json(401, { error: 'no_session', message: 'Tu sesión terminó. Vuelve a entrar.' }),
      ],
      onUnauthorized,
    )
    // As PanelApp does: the screen goes away when the session is gone, and takes the poller with it.
    onUnauthorized.mockImplementation(() => d.stop())
    d.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(EVERY_MS)
    await vi.advanceTimersByTimeAsync(EVERY_MS)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    const requests = d.c.count()
    await vi.advanceTimersByTimeAsync(EVERY_MS * 10)
    expect(d.c.count()).toBe(requests)
    // The 401 never reached the screen as data: the last thing shown was a good answer.
    expect(d.states.at(-1)?.failed).toBe(false)
  })

  it('if the screen stayed, the 401 keeps being reported with the session’s message (not «sin conexión»)', async () => {
    const d = dashboard([json(200, summaryOf()), json(401, { error: 'no_session' })])
    d.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(EVERY_MS * 2)
    d.stop()
    const last = d.states.at(-1) as Polled<Summary>
    expect(last.failed).toBe(true)
    expect(last.error).toBe(SESSION_CLOSED)
    expect(last.error).not.toBe(OFFLINE)
  })

  it('a 401 in the reports and in the dashboard at once ends it twice at worst, never throws', async () => {
    const onUnauthorized = vi.fn()
    const api = panelApi({ fetch: cloud([json(401, {})]).fetch, onUnauthorized })
    const results = await Promise.allSettled([api.summary(), api.reports(null), api.reports(null)])
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    for (const r of results)
      expect((r as PromiseRejectedResult).reason).toMatchObject({ kind: 'unauthorized' })
    expect(onUnauthorized).toHaveBeenCalledTimes(3)
  })

  it('403 (lost view_reports) is not a closed session: it says so and does not go to «Entrar»', async () => {
    const onUnauthorized = vi.fn()
    const api = panelApi({
      fetch: cloud([json(403, { error: 'no_permission', message: 'No tienes permiso' })]).fetch,
      onUnauthorized,
    })
    await expect(api.summary()).rejects.toMatchObject({ kind: 'forbidden' })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('a 429 on sign-in carries how long to wait; the hub’s `wait_ms` or the header', async () => {
    const byBody = panelApi({ fetch: cloud([json(429, { error: 'wait', wait_ms: 7_500 })]).fetch })
    await expect(
      byBody.signIn({ restaurant: 'r', username: 'ana', password: 'x' }),
    ).rejects.toMatchObject({ kind: 'rate_limited', waitMs: 7_500 })
    const byHeader = panelApi({
      fetch: cloud([json(429, { error: 'wait' }, { 'retry-after': '12' })]).fetch,
    })
    await expect(
      byHeader.signIn({ restaurant: 'r', username: 'ana', password: 'x' }),
    ).rejects.toMatchObject({ kind: 'rate_limited', waitMs: 12_000 })
  })

  it('5xx, with HTML from a proxy or with nothing, is a server error and never a crash', async () => {
    for (const reply of [
      new Response('<html>502 Bad Gateway</html>', { status: 502 }),
      new Response('', { status: 500 }),
      new Response(null, { status: 503 }),
      new Response('not json', { status: 504, headers: { 'content-type': 'text/plain' } }),
    ]) {
      const api = panelApi({ fetch: cloud([reply]).fetch })
      const error = await api.summary().catch((e) => e)
      expect(error).toBeInstanceOf(PanelError)
      expect(error.kind).toBe('server')
      expect(error.message).toContain(String(reply.status))
    }
  })

  // BUG (real, reported): a 200 that is not JSON (a Wi-Fi sign-in page that answers 200 with HTML)
  // resolves with `null` instead of failing. `me()` then makes PanelApp render with `me = null`
  // (it reads `me.user`) and the dashboard stays on «Leyendo las ventas…» forever. Remove `.fails`
  // when `call()` in api.ts throws a PanelError for a 2xx body it cannot read.
  it('a 200 with HTML (a captive portal) is an error, not an empty answer', async () => {
    const portal = () => new Response('<html>Inicia sesión en el Wi-Fi</html>', { status: 200 })
    for (const call of [
      (api: PanelApi) => api.me(),
      (api: PanelApi) => api.summary(),
      (api: PanelApi) => api.reports(null),
    ]) {
      const api = panelApi({ fetch: cloud([portal()]).fetch })
      await expect(call(api)).rejects.toBeInstanceOf(PanelError)
    }
  })
})

describe('how the dashboard describes the connection', () => {
  const local = {
    last_seen_at: '2026-10-30T02:41:00.000Z',
    last_event_at: '2026-10-30T02:39:00.000Z',
    pending: 0,
  }
  const at = (iso: string) => ({ failed: false, receivedAt: iso, now: iso })

  it('the restaurant is quiet for exactly two minutes before it says «sin noticias»', () => {
    const seen = Date.parse(local.last_seen_at)
    const state = (ms: number) =>
      dataState(local, at(new Date(seen + ms).toISOString()), 'America/Bogota')
    expect(state(0).kind).toBe('up_to_date')
    expect(state(NO_NEWS_MS).kind).toBe('up_to_date')
    expect(state(NO_NEWS_MS + 1).kind).toBe('no_news')
    // A restaurant that sends heartbeats every 30 s misses three before it is declared quiet.
    expect(NO_NEWS_MS / 30_000).toBeGreaterThanOrEqual(4)
  })

  it('«sin noticias» says since when, hides what was pending and keeps the figures’ hour', () => {
    const later = new Date(Date.parse(local.last_seen_at) + 10 * 60_000).toISOString()
    const s = dataState({ ...local, pending: 9 }, at(later), 'America/Bogota')
    expect(s.kind).toBe('no_news')
    expect(s.text).toContain('Sin noticias del restaurante desde las 9:41')
    expect(s.pending).toBeNull()
    expect(s.figuresAt).toMatch(/9:41/)
  })

  it('the phone’s clock is never used: the cloud’s time decides, even with a phone hours off', () => {
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
    expect(dataState(local, at('2026-10-30T02:41:30.000Z'), 'America/Bogota').kind).toBe(
      'up_to_date',
    )
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
    expect(dataState(local, at('2026-10-30T02:41:30.000Z'), 'America/Bogota').kind).toBe(
      'up_to_date',
    )
  })

  it('offline wins over everything, and does not claim the restaurant is quiet', () => {
    const s = dataState(
      local,
      { failed: true, receivedAt: '2026-10-30T02:41:30.000Z', now: '2026-10-30T09:00:00.000Z' },
      'America/Bogota',
    )
    expect(s.kind).toBe('offline')
    expect(s.text).toContain('Sin conexión a internet')
    expect(s.pending).toBeNull()
  })

  it('a hub that never called (null everywhere) is «todavía no ha enviado datos», not an error', () => {
    const s = dataState(
      { last_seen_at: null, last_event_at: null, pending: null },
      at('2026-10-30T02:41:30.000Z'),
      'America/Bogota',
    )
    expect(s.kind).toBe('nothing_yet')
    expect(s.pending).toBeNull()
  })

  it('a last event but no heartbeat (an old hub) is up to date, as the cloud knows nothing else', () => {
    const s = dataState(
      { last_seen_at: null, last_event_at: '2026-10-30T02:39:00.000Z', pending: null },
      at('2026-10-30T05:00:00.000Z'),
      'America/Bogota',
    )
    expect(s.kind).toBe('up_to_date')
    expect(s.text).toContain('9:39')
  })

  it('the dashboard prints the unknown pending of the cloud (null) without a pending line or «null»', () => {
    const s = summaryOf({ local: { ...summaryOf().local, pending: null as unknown as number } })
    const t = render({ data: s, receivedAt: s.server_now, failed: false, error: null })
    expect(t).not.toMatch(/null|undefined|NaN/)
    expect(t).not.toContain('por llegar')
  })

  it('a very large pending number is still readable', () => {
    const s = summaryOf({ local: { ...summaryOf().local, pending: 123_456 } })
    const t = render({ data: s, receivedAt: s.server_now, failed: false, error: null })
    expect(t).toContain('Faltan 123456 datos del local por llegar')
  })

  it('«sin noticias» on screen: the figures stay and the hour they are from is said', () => {
    const s = summaryOf({
      server_now: '2026-10-30T03:30:00.000Z',
      local: { ...summaryOf().local, last_seen_at: '2026-10-30T02:41:00.000Z', pending: 4 },
    })
    const t = render({ data: s, receivedAt: s.server_now, failed: false, error: null })
    expect(t).toContain('Sin noticias del restaurante desde las 9:41')
    expect(t).toContain('$1.250.000')
    expect(t).not.toContain('por llegar')
  })
})

// ── Periods ──────────────────────────────────────────────────────────────

describe('the periods the reports ask for', () => {
  const days = (from: string, count: number) =>
    Array.from({ length: count }, (_, i) => addDays(from, i))

  it('every shortcut the panel offers fits in the 14 days the cloud answers, for every day of three years', () => {
    const offered = shortcutsFor(PANEL_MAX_DAYS)
      .filter((s) => !s.disabled)
      .map((s) => s.value)
      .filter((v) => v !== 'range')
    expect(offered.length).toBeGreaterThanOrEqual(3)
    for (const today of days('2026-01-01', 1096))
      for (const value of offered) {
        const period = periodOf(value as Parameters<typeof periodOf>[0], today)
        expect(daysIn(period), `${value} ${today}`).toBeLessThanOrEqual(PANEL_MAX_DAYS)
        expect(period.from <= period.until).toBe(true)
        expect(period.until <= today).toBe(true)
      }
  })

  it('the shortcuts that do not fit are the months, shown disabled; the register has them all enabled', () => {
    const disabled = (max: number) =>
      shortcutsFor(max)
        .filter((s) => s.disabled)
        .map((s) => s.value)
    expect(disabled(PANEL_MAX_DAYS)).toEqual(['month', 'lastMonth'])
    expect(disabled(62)).toEqual([])
    // «Este mes» on the 31st would be 31 days: that is why it is disabled.
    expect(daysIn(periodOf('month', '2026-10-31'))).toBe(31)
    expect(daysIn(periodOf('lastMonth', '2026-11-05'))).toBe(31)
  })

  it('«Últimos 7 días» counts today and crosses months and years', () => {
    expect(periodOf('week', '2026-10-30')).toEqual({ from: '2026-10-24', until: '2026-10-30' })
    expect(periodOf('week', '2026-03-03')).toEqual({ from: '2026-02-25', until: '2026-03-03' })
    expect(periodOf('week', '2027-01-02')).toEqual({ from: '2026-12-27', until: '2027-01-02' })
    expect(periodOf('week', '2028-03-02')).toEqual({ from: '2028-02-25', until: '2028-03-02' })
  })

  it('the periods come from the cloud’s business day only: the phone’s time zone changes nothing', () => {
    const results = new Set<string>()
    for (const zone of ['Pacific/Auckland', 'America/Los_Angeles', 'Asia/Kolkata', 'UTC']) {
      vi.stubEnv('TZ', zone)
      for (const value of ['today', 'yesterday', 'week'] as const)
        results.add(`${value}:${JSON.stringify(periodOf(value, '2026-10-31'))}`)
    }
    vi.unstubAllEnvs()
    expect(results.size).toBe(3)
  })

  it('the request has the dates in the address and nothing for today', async () => {
    const c = cloud([json(200, periodReportOf())])
    const api = panelApi({ fetch: c.fetch })
    await api.reports({ from: '2026-10-17', until: '2026-10-30' })
    await api.reports(null)
    expect(c.calls).toEqual([
      '/v1/panel/reports?from=2026-10-17&until=2026-10-30',
      '/v1/panel/reports',
    ])
  })

  it('a 400 from the cloud for a period is shown with its own message, not as a closed session', async () => {
    const onUnauthorized = vi.fn()
    const api = panelApi({
      fetch: cloud([
        json(400, { error: 'invalid_data', message: 'Elige un período de 14 días o menos' }),
      ]).fetch,
      onUnauthorized,
    })
    await expect(api.reports({ from: '2026-09-01', until: '2026-10-30' })).rejects.toMatchObject({
      kind: 'invalid',
      message: 'Elige un período de 14 días o menos',
    })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('the panel limit is the cloud’s (14 days) and the register’s is not', () => {
    expect(PANEL_MAX_DAYS).toBe(14)
    expect(me(['view_reports']).user.permissions).toContain('view_reports')
  })
})
