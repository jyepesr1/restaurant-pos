import { describe, expect, it } from 'vitest'
import { setupApi } from './api-setup'
import {
  ALERT_WINDOW_MS,
  DEVICE_FAILURES_FOR_ALERT,
  FAILURES_FOR_ALERT,
  MAX_WAIT_MS,
} from './attempts'

// Brute force against `POST /api/sign-in` without a token (ADR-013): PIN and password, rotating
// IPs, and the alert to the admin. Manual clock: nothing really waits.

const ip = (n: number) => `10.1.${Math.floor(n / 250)}.${(n % 250) + 1}`

/** A PIN with a valid format that belongs to no one in the setup. */
function otherPins(m: { people: Record<string, { pin: string }> }, howMany: number) {
  const ownOnes = new Set(Object.values(m.people).map((p) => p.pin))
  const r: string[] = []
  for (let n = 0; r.length < howMany; n++) {
    const pin = String(n).padStart(4, '0')
    if (!ownOnes.has(pin)) r.push(pin)
  }
  return r
}

describe('PIN without a token, rotating IPs', () => {
  it('each new IP gets its two free attempts: the per-IP brake is not enough, and that is known (accepted risk ADR-013)', async () => {
    const api = setupApi()
    const pins = otherPins(api, 200)
    const statuses = new Set<number>()
    for (const [i, pin] of pins.entries())
      statuses.add((await api.post('/api/sign-in', { pin }, { ip: ip(i) })).statusCode)
    expect([...statuses]).toEqual([401])
    // And not a single registered device: no success, no browser recorded.
    expect(Number(api.db.prepare('SELECT count(*) AS n FROM devices').get()?.n)).toBe(0)
  })

  it('the alert to the admin goes out at failure number 20 across the whole hub, even if each IP fails once', async () => {
    const api = setupApi()
    const pins = otherPins(api, FAILURES_FOR_ALERT + 5)
    for (const [i, pin] of pins.slice(0, FAILURES_FOR_ALERT - 1).entries())
      await api.post('/api/sign-in', { pin }, { ip: ip(i) })
    expect(api.alerts).toEqual([])
    await api.post('/api/sign-in', { pin: pins[FAILURES_FOR_ALERT - 1] }, { ip: ip(99) })
    expect(api.alerts).toHaveLength(1)
    expect(api.alerts[0]).toMatch(/20 PIN/)
    // Continuing to guess does not flood the admin with one alert per attempt.
    for (const [i, pin] of pins.slice(FAILURES_FOR_ALERT).entries())
      await api.post('/api/sign-in', { pin }, { ip: ip(100 + i) })
    expect(api.alerts).toHaveLength(1)
  })

  it('someone guessing slowly from the same registered browser triggers the device alert', async () => {
    const api = setupApi()
    const phone = (await api.post('/api/sign-in', { pin: api.people.waiter.pin })).json()
    const token = phone.device.token as string
    const [pin] = otherPins(api, 1) as [string]
    let failures = 0
    while (failures < DEVICE_FAILURES_FOR_ALERT) {
      const r = await api.post('/api/sign-in', { pin }, { token, ip: ip(failures) })
      // Respects the wait: each attempt arrives once it is allowed.
      if (r.statusCode === 429) api.advance(Number(r.json().wait_ms) + 1)
      else failures++
    }
    expect(api.alerts.some((a) => /seguidos desde device:/.test(a))).toBe(true)
  })

  it('with the same token, changing IP does not reset the wait: it is counted per device', async () => {
    const api = setupApi()
    const phone = (await api.post('/api/sign-in', { pin: api.people.waiter.pin })).json()
    const token = phone.device.token as string
    for (const [i, pin] of otherPins(api, 3).entries())
      await api.post('/api/sign-in', { pin }, { token, ip: ip(i) })
    const later = await api.post(
      '/api/sign-in',
      { pin: api.people.waiter2.pin },
      { token, ip: ip(500) },
    )
    expect(later.statusCode).toBe(429)
    expect(later.json()).toMatchObject({ error: 'wait' })
  })

  it('X-Forwarded-For does not change identity: the hub looks at the connection', async () => {
    const api = setupApi()
    for (const [i, pin] of otherPins(api, 3).entries())
      await api.post(
        '/api/sign-in',
        { pin },
        {
          ip: '10.9.9.9',
          headers: { 'x-forwarded-for': `1.2.3.${i}`, 'x-real-ip': `8.8.8.${i}` },
        },
      )
    const r = await api.post(
      '/api/sign-in',
      { pin: api.people.waiter.pin },
      { ip: '10.9.9.9', headers: { 'x-forwarded-for': '1.2.3.200' } },
    )
    expect(r.statusCode).toBe(429)
  })

  it('a made-up or empty token cannot be used to guess PINs: 401 without spending attempts of anyone', async () => {
    const api = setupApi()
    for (const token of ['inventado', 'x'.repeat(500), ' ']) {
      const r = await api.post('/api/sign-in', { pin: '0001' }, { token, ip: '10.8.8.8' })
      expect([401, 400]).toContain(r.statusCode)
    }
    // The IP stays clean: its success gets in right away.
    const ok = await api.post('/api/sign-in', { pin: api.people.waiter.pin }, { ip: '10.8.8.8' })
    expect(ok.statusCode).toBe(201)
  })

  it('the attacker does not lock the waiters out: another browser, with its PIN, signs in during the attack', async () => {
    const api = setupApi()
    for (const [i, pin] of otherPins(api, 150).entries())
      await api.post('/api/sign-in', { pin }, { ip: ip(i % 3) })
    const ok = await api.post('/api/sign-in', { pin: api.people.waiter2.pin }, { ip: '10.77.0.1' })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().user.name).toBe('Luis')
  })

  it('an IP wait rises up to 60 s and the response carries a consistent retry-after', async () => {
    const api = setupApi()
    let latest = 0
    for (let n = 0; n < 40; n++) {
      const r = await api.post('/api/sign-in', { pin: '0002' }, { ip: '10.5.5.5' })
      if (r.statusCode === 429) {
        const ms = Number(r.json().wait_ms)
        expect(ms).toBeGreaterThan(0)
        expect(ms).toBeLessThanOrEqual(MAX_WAIT_MS)
        expect(Number(r.headers['retry-after'])).toBe(Math.ceil(ms / 1000))
        latest = ms
        api.advance(ms)
      }
    }
    expect(latest).toBeGreaterThan(0)
  })
})

describe('password without a token', () => {
  const badCredentials = (user: string, i: number) => ({
    user,
    password: `mala-${i}-xxxxxxxx`,
  })

  it('rotating the IP does not escape the account wait: from the 3rd on, every IP waits', async () => {
    const api = setupApi()
    const user = api.people.admin.user as string
    for (let i = 0; i < 3; i++)
      await api.post('/api/sign-in', badCredentials(user, i), { ip: ip(i) })
    for (let i = 10; i < 20; i++) {
      const r = await api.post('/api/sign-in', badCredentials(user, i), { ip: ip(i) })
      expect(r.statusCode, `IP ${ip(i)}`).toBe(429)
    }
    // Not even the right password gets in during the wait.
    expect((await api.post('/api/sign-in', api.admin(), { ip: ip(77) })).statusCode).toBe(429)
  })

  it('in an hour of consecutive attempts from always-new IPs, only a few dozen attempts fit', async () => {
    const api = setupApi()
    const user = api.people.admin.user as string
    let allowed = 0
    for (let s = 0; s < 3600; s++) {
      const r = await api.post('/api/sign-in', badCredentials(user, s), { ip: ip(s) })
      if (r.statusCode === 401) allowed++
      expect([401, 429]).toContain(r.statusCode)
      api.advance(1000)
    }
    // The per-account wait is capped at 10 s: 2 free + the 2, 4, 8 s ramp + one every 10 s.
    expect(allowed).toBeLessThan(420)
  })

  it('the admin alert also fires with passwords: each failure counts only once (not per IP and again per account)', async () => {
    const api = setupApi()
    // Different accounts from different IPs: so none waits and the 20 failures fit in 10 minutes.
    for (let i = 0; i < 19; i++)
      await api.post('/api/sign-in', badCredentials(`persona${i}`, i), { ip: ip(i) })
    expect(api.alerts).toEqual([])
    await api.post('/api/sign-in', badCredentials('persona19', 19), { ip: ip(19) })
    expect(api.alerts).toHaveLength(1)
    expect(api.alerts[0]).toMatch(/^20 PIN o códigos errados/)
  })

  it('guessing many different accounts from one IP: the IP waits even if no account repeats', async () => {
    const api = setupApi()
    for (let i = 0; i < 3; i++)
      await api.post('/api/sign-in', badCredentials(`persona${i}`, i), { ip: '10.4.4.4' })
    const r = await api.post('/api/sign-in', badCredentials('persona9', 9), { ip: '10.4.4.4' })
    expect(r.statusCode).toBe(429)
  })

  it('locking the admin account from outside lasts 10 s at most and does not affect the waiters', async () => {
    const api = setupApi()
    const user = api.people.admin.user as string
    // An attacker keeps the account wait going for 10 minutes.
    let maxSeen = 0
    for (let s = 0; s < 600; s++) {
      const r = await api.post('/api/sign-in', badCredentials(user, s), { ip: ip(s) })
      if (r.statusCode === 429) maxSeen = Math.max(maxSeen, Number(r.json().wait_ms))
      api.advance(1000)
    }
    expect(maxSeen).toBeGreaterThan(0)
    expect(maxSeen).toBeLessThanOrEqual(10_000)
    // The waiters (PIN, another wait key) keep signing in.
    const waiter = await api.post(
      '/api/sign-in',
      { pin: api.people.waiter.pin },
      { ip: '10.3.3.3' },
    )
    expect(waiter.statusCode).toBe(201)
    // And once the attacker stops, the account comes back as soon as the wait is over.
    api.advance(10_001)
    expect((await api.post('/api/sign-in', api.admin(), { ip: '10.3.3.4' })).statusCode).toBe(201)
  })

  // Found by qa-pruebas in 1.3b and already fixed: `withPassword` (service.ts) applied the cap as
  // `min(10 s, remaining wait)`. With the real wait at 64 s, what remains stays above 10 s until
  // the end: the hub says "wait 10 s" but replies 429 for almost 60 s, and whoever retries after
  // 10 s hears "10 s" again. Expected: 10 s after the last failure the account accepts another
  // attempt.
  it('the per-account wait really does not go past 10 s', async () => {
    const api = setupApi()
    const user = api.people.admin.user as string
    for (let s = 0; s < 12; s++) {
      const r = await api.post('/api/sign-in', badCredentials(user, s), { ip: ip(s) })
      if (r.statusCode === 429) api.advance(Number(r.json().wait_ms) + 1)
    }
    api.advance(10_001)
    const r = await api.post('/api/sign-in', badCredentials(user, 77), { ip: ip(900) })
    expect(r.statusCode).toBe(401)
  })

  it('failures are forgotten after 10 quiet minutes and the account starts from zero', async () => {
    const api = setupApi()
    const user = api.people.admin.user as string
    for (let i = 0; i < 3; i++)
      await api.post('/api/sign-in', badCredentials(user, i), { ip: ip(i) })
    api.advance(ALERT_WINDOW_MS + 1)
    for (let i = 0; i < 2; i++) {
      const r = await api.post('/api/sign-in', badCredentials(user, i), { ip: ip(50 + i) })
      expect(r.statusCode).toBe(401)
    }
  })

  it('a success does not clear the failures: alternating the right password with wrong ones does not avoid the wait', async () => {
    const api = setupApi()
    const user = api.people.admin.user as string
    // Same IP; between failures it signs in fine. The third failure must still wait.
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) {
      statuses.push(
        (await api.post('/api/sign-in', badCredentials(user, i), { ip: '10.6.6.6' })).statusCode,
      )
      statuses.push((await api.post('/api/sign-in', api.admin(), { ip: '10.6.6.6' })).statusCode)
    }
    expect(statuses).toContain(429)
  })

  it('the admin PIN does not work as a password nor as a sign-in PIN, and it spends attempts', async () => {
    const api = setupApi()
    const pin = api.people.admin.pin
    const user = api.people.admin.user as string
    expect(
      (await api.post('/api/sign-in', { user, password: pin.repeat(2) }, { ip: ip(1) })).statusCode,
    ).toBe(401)
    expect((await api.post('/api/sign-in', { pin }, { ip: ip(2) })).statusCode).toBe(401)
    // The password above was the account 1st failure (the PIN only counts per IP): with two
    // more, the next attempt, from any IP, waits.
    await api.post('/api/sign-in', badCredentials(user, 1), { ip: ip(3) })
    await api.post('/api/sign-in', badCredentials(user, 2), { ip: ip(4) })
    expect(
      (await api.post('/api/sign-in', badCredentials(user, 3), { ip: ip(5) })).statusCode,
    ).toBe(429)
  })
})
