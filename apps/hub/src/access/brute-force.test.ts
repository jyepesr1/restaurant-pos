import { newId } from '@pos/core'
import type { Connection } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import { DEVICE_FAILURES_FOR_ALERT, FAILURES_FOR_ALERT, MAX_WAIT_MS } from './attempts'
import { setupAccess } from './setup'

// Brute force against the PIN and the pairing code (ADR-008, docs/SYNC.md#seguridad).

const BAD_VALUES = ['0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008']

describe('pairing: approve with the admin PIN', () => {
  const request = (m: ReturnType<typeof setupAccess>, connection: Connection | null, pin: string) =>
    m.access.createPairing({ pin, name: 'Equipo', type: 'waiter' }, connection)

  it('the first device (hub with none) has a single wait for the whole hub, wherever it comes from', () => {
    const m = setupAccess()
    for (const pin of BAD_VALUES.slice(0, 3)) request(m, null, pin)

    // Neither by changing IP nor with the right PIN: the freshly installed register waits.
    expect(request(m, null, m.people.admin.pin)).toMatchObject({ ok: false, code: 'wait' })
    m.advance(2000)
    expect(request(m, null, m.people.admin.pin)).toMatchObject({ ok: true })
  })

  it('with a device already paired, requesting without a device is invalid and does not count as an attempt', () => {
    const m = setupAccess()
    const register = m.pair('register').connection
    for (let i = 0; i < 50; i++)
      expect(request(m, null, BAD_VALUES[i % 8] as string)).toMatchObject({
        ok: false,
        code: 'unpaired_device',
      })

    // Nobody was left waiting because of those attempts.
    expect(request(m, register, m.people.admin.pin)).toMatchObject({ ok: true })
  })

  it('from a device, guessing the admin PIN makes that device wait and no other', () => {
    const m = setupAccess()
    const a = m.pair('register', 'A').connection
    const b = m.pair('waiter', 'B').connection
    for (const pin of BAD_VALUES.slice(0, 3)) request(m, a, pin)

    expect(request(m, a, m.people.admin.pin)).toMatchObject({ ok: false, code: 'wait' })
    expect(request(m, b, m.people.admin.pin)).toMatchObject({ ok: true })
    m.advance(2000)
    expect(request(m, a, m.people.admin.pin)).toMatchObject({ ok: true })
  })

  it('revoking devices does not reopen the «first pairing» while any remains unrevoked', () => {
    const m = setupAccess()
    const register = m.pair('register').connection
    const phone = m.pair('waiter')
    const third = m.pair('register', 'Tercera').connection
    const admin = m.signIn(third, 'admin')
    for (const d of [register, phone.connection])
      m.access.revokeDevice(third, { ...admin, deviceId: d.deviceId })

    expect(request(m, null, m.people.admin.pin)).toMatchObject({ code: 'unpaired_device' })
    expect(request(m, third, m.people.admin.pin)).toMatchObject({ ok: true })
  })

  it('a waiter PIN does not approve, and uses up device attempts like any failure', () => {
    const m = setupAccess()
    const register = m.pair('register').connection
    const r = [
      request(m, register, m.people.waiter.pin),
      request(m, register, m.people.cashier.pin),
      request(m, register, m.people.manager.pin),
    ]

    expect(r.map((x) => (x.ok ? 'ok' : x.code))).toEqual(['wrong_pin', 'wrong_pin', 'wrong_pin'])
    expect(request(m, register, m.people.admin.pin)).toMatchObject({ code: 'wait' })
  })
})

describe('pairing: redeem the code from an IP', () => {
  const newCode = (m: ReturnType<typeof setupAccess>, name = 'X') => {
    const register = m.pair('register', `Caja ${name}`).connection
    const c = m.access.createPairing({ pin: m.people.admin.pin, name, type: 'kds' }, register)
    if (!c.ok) throw new Error(c.message)
    return c
  }

  it('a success from another IP does not reset the wait of whoever keeps failing', () => {
    const m = setupAccess()
    const valid = newCode(m)
    for (let i = 0; i < 3; i++) m.access.pair('AAAAAAAA', '10.0.0.66')
    const delay = () => m.access.pair('AAAAAAAA', '10.0.0.66')
    expect(delay()).toMatchObject({ code: 'wait' })

    expect(m.access.pair(valid.code, '10.0.0.5')).toMatchObject({ ok: true })

    expect(delay()).toMatchObject({ code: 'wait' })
  })

  it('a success does not clear the failures of the same IP either: alternating to keep guessing does not work', () => {
    const m = setupAccess()
    const register = m.pair('register').connection
    let delays = 0
    for (let round = 0; round < 30; round++) {
      const c = m.access.createPairing(
        { pin: m.people.admin.pin, name: 'X', type: 'kds' },
        register,
      )
      if (!c.ok) {
        m.advance(60_000)
        continue
      }
      for (const code of ['AAAAAAAA', 'BBBBBBBB', c.code]) {
        const r = m.access.pair(code, '10.0.0.66')
        if (!r.ok && r.code === 'wait') delays++
      }
    }
    expect(delays).toBeGreaterThan(0)
  })

  it('X-Forwarded-For cannot be used to change identity: the hub looks at the connection', async () => {
    const { createAppServer } = await import('../server')
    const m = setupAccess()
    const app = createAppServer({ access: m.access })
    const attempt = (ip: string) =>
      app.inject({
        method: 'POST',
        url: '/api/pair',
        payload: { code: 'AAAAAAAA' },
        headers: { 'x-forwarded-for': ip, 'x-real-ip': ip },
      })

    const responses = []
    for (let i = 0; i < 4; i++) responses.push(await attempt(`203.0.113.${i}`))
    expect(responses.map((r) => r.statusCode)).toEqual([400, 400, 400, 429])
  })

  it('an attempt during the wait does not extend it', () => {
    const m = setupAccess()
    for (let i = 0; i < 3; i++) m.access.pair('AAAAAAAA', '10.0.0.66')
    for (let i = 0; i < 200; i++)
      expect(m.access.pair('AAAAAAAA', '10.0.0.66')).toMatchObject({ code: 'wait' })

    m.advance(2000)
    expect(m.access.pair('AAAAAAAA', '10.0.0.66')).toMatchObject({
      code: 'invalid_code',
    })
  })

  it('an already used code counts as a failure', () => {
    const m = setupAccess()
    const c = newCode(m)
    expect(m.access.pair(c.code, '10.0.0.9')).toMatchObject({ ok: true })
    for (let i = 0; i < 2; i++)
      expect(m.access.pair(c.code, '10.0.0.66')).toMatchObject({
        code: 'invalid_code',
      })
    expect(m.access.pair(c.code, '10.0.0.66')).toMatchObject({
      code: 'invalid_code',
      waitMs: 2000,
    })
    expect(m.access.pair(c.code, '10.0.0.66')).toMatchObject({ code: 'wait' })
  })

  it('the code is redeemed once even if two redemptions arrive back to back', () => {
    const m = setupAccess()
    const c = newCode(m)
    const before = Number(m.db.prepare('SELECT count(*) AS n FROM devices').get()?.n)
    const r = [m.access.pair(c.code, '10.0.0.8'), m.access.pair(c.code, '10.0.0.9')]

    expect(r.map((x) => x.ok)).toEqual([true, false])
    expect(Number(m.db.prepare('SELECT count(*) AS n FROM devices').get()?.n)).toBe(before + 1)
  })

  it('the code works with spaces and lowercase, but nothing that merely resembles it', () => {
    const m = setupAccess()
    const c = newCode(m)
    for (const almost of [c.code.slice(0, 7), `${c.code}A`, c.code.replace(/./, '0'), ''])
      expect(m.access.pair(almost, `ip-${almost}`)).toMatchObject({ code: 'invalid_code' })
    expect(m.access.pair(`  ${c.code.toLowerCase()} `, '10.0.0.7')).toMatchObject({
      ok: true,
    })
  })

  it('the admin alert fires at 20 failures across the whole hub, wherever they come from', () => {
    const m = setupAccess()
    for (let i = 0; i < FAILURES_FOR_ALERT - 1; i++) m.access.pair('AAAAAAAA', `10.0.1.${i}`)
    expect(m.alerts).toEqual([])
    m.access.pair('AAAAAAAA', '10.0.2.1')
    expect(m.alerts).toHaveLength(1)
    expect(m.alerts[0]).toContain(String(FAILURES_FOR_ALERT))
  })

  it('and another alert when a single device piles up failures slowly, respecting the wait', () => {
    const m = setupAccess()
    const { connection } = m.pair()
    for (let i = 0; i < DEVICE_FAILURES_FOR_ALERT; i++) {
      m.advance(61_000) // never hits the wait nor goes 10 minutes without errors
      m.access.startSession(connection, BAD_VALUES[i % 8] as string)
    }
    expect(m.alerts.filter((a) => a.includes(`${DEVICE_FAILURES_FOR_ALERT} PIN`))).toHaveLength(1)
  })
})

describe('PIN on a device', () => {
  it('the wait grows 2, 4, 8… s and is respected right at the edge', () => {
    const m = setupAccess()
    const { connection } = m.pair()
    const delays: (number | undefined)[] = []
    for (let i = 0; i < 6; i++) {
      const r = m.access.startSession(connection, BAD_VALUES[i] as string)
      delays.push(r.ok ? undefined : r.waitMs)
      if (!r.ok && r.waitMs) {
        // One millisecond before it is up it still waits; once up, it allows trying.
        m.advance(r.waitMs - 1)
        expect(m.access.startSession(connection, m.people.waiter.pin)).toMatchObject({
          code: 'wait',
        })
        m.advance(1)
      }
    }
    expect(delays).toEqual([0, 0, 2000, 4000, 8000, 16_000])
  })

  it('the wait never exceeds 60 s, not even after hundreds of failures', () => {
    const m = setupAccess()
    const { connection } = m.pair()
    let last = 0
    for (let i = 0; i < 300; i++) {
      const r = m.access.startSession(connection, BAD_VALUES[i % BAD_VALUES.length] as string)
      if (!r.ok && r.waitMs !== undefined) {
        last = r.waitMs
        expect(r.waitMs).toBeLessThanOrEqual(MAX_WAIT_MS)
        m.advance(r.waitMs)
      }
    }
    expect(last).toBe(MAX_WAIT_MS)
    expect(m.access.startSession(connection, m.people.waiter.pin)).toMatchObject({ ok: true })
  })

  it('the correct PIN during the wait does not sign in, and neither counts nor extends it', () => {
    const m = setupAccess()
    const { connection } = m.pair()
    for (const pin of BAD_VALUES.slice(0, 3)) m.access.startSession(connection, pin)
    for (let i = 0; i < 50; i++)
      expect(m.access.startSession(connection, m.people.waiter.pin)).toMatchObject({
        code: 'wait',
      })
    m.advance(2000)
    expect(m.access.startSession(connection, m.people.waiter.pin)).toMatchObject({ ok: true })
  })

  it('a success on another device does not reset the wait of this one', () => {
    const m = setupAccess()
    const a = m.pair('waiter', 'A').connection
    const b = m.pair('waiter', 'B').connection
    for (const pin of BAD_VALUES.slice(0, 3)) m.access.startSession(a, pin)

    expect(m.access.startSession(b, m.people.waiter.pin)).toMatchObject({ ok: true })
    expect(m.access.startSession(a, m.people.waiter.pin)).toMatchObject({ code: 'wait' })
  })

  it('failures on one device do not make another wait, not even one on the same IP', () => {
    const m = setupAccess()
    const a = m.pair('waiter', 'A').connection
    const b = m.pair('waiter', 'B').connection
    for (const pin of BAD_VALUES.slice(0, 6)) m.access.startSession(a, pin)
    for (const pin of BAD_VALUES.slice(0, 2)) m.access.startSession(b, pin)

    expect(m.access.startSession(b, m.people.waiter.pin)).toMatchObject({ ok: true })
  })

  it('supervisor PIN failures and sign-in failures share the same wait', () => {
    const m = setupAccess()
    const { connection } = m.pair()
    const session = m.signIn(connection, 'waiter')
    const guess = (pin: string) =>
      m.access.authorize(connection, {
        ...session,
        pin,
        action: 'void_sent_item',
        aggregateId: newId(),
        eventId: newId(),
        fingerprint: '0'.repeat(64),
      })
    guess(BAD_VALUES[0] as string)
    guess(BAD_VALUES[1] as string)
    // The third failure comes through another door and triggers the wait for both.
    expect(m.access.startSession(connection, BAD_VALUES[2] as string)).toMatchObject({
      waitMs: 2000,
    })
    expect(guess(m.people.manager.pin)).toMatchObject({ code: 'wait' })
  })

  it('a supervisor PIN of someone without the permission counts as a failure, same as a nonexistent one', () => {
    const m = setupAccess()
    const { connection } = m.pair()
    const session = m.signIn(connection, 'waiter')
    const data = () => ({
      ...session,
      // The cashier can authorize voids (ADR-013), not comps.
      action: 'comp',
      aggregateId: newId(),
      eventId: newId(),
      fingerprint: '0'.repeat(64),
    })
    const r = [
      m.access.authorize(connection, { ...data(), pin: m.people.cashier.pin }),
      m.access.authorize(connection, { ...data(), pin: '0001' }),
      m.access.authorize(connection, { ...data(), pin: m.people.waiter2.pin }),
    ]

    expect(r.map((x) => (x.ok ? 'ok' : x.code))).toEqual(['wrong_pin', 'wrong_pin', 'wrong_pin'])
    expect((r[2] as { waitMs: number }).waitMs).toBe(2000)
    expect(m.access.authorize(connection, { ...data(), pin: m.people.manager.pin })).toMatchObject({
      code: 'wait',
    })
  })

  it('typing your own PIN between attempts is not a free pass to keep guessing', () => {
    const m = setupAccess()
    const { connection } = m.pair()
    const session = m.signIn(connection, 'waiter')
    const data = () => ({
      ...session,
      action: 'void_sent_item',
      aggregateId: newId(),
      eventId: newId(),
      fingerprint: '0'.repeat(64),
    })
    // Ana guesses the manager's PIN: two attempts, her own PIN, two attempts, her own PIN…
    // If her own PIN resets the count, she never hits the wait and can try all 10 000 PINs.
    let delays = 0
    for (let round = 0; round < 100; round++) {
      for (const pin of [
        BAD_VALUES[round % 8] as string,
        BAD_VALUES[(round + 1) % 8] as string,
        m.people.waiter.pin,
      ]) {
        const r = m.access.authorize(connection, { ...data(), pin })
        if (!r.ok && r.code === 'wait') delays++
      }
    }
    expect(delays).toBeGreaterThan(0)
  })

  it('signing in with your own valid PIN between wrong attempts does not clear the count either', () => {
    const m = setupAccess()
    const { connection } = m.pair()
    let delays = 0
    for (let round = 0; round < 100; round++) {
      for (const pin of [
        BAD_VALUES[round % 8] as string,
        BAD_VALUES[(round + 1) % 8] as string,
        m.people.waiter.pin,
      ]) {
        const r = m.access.startSession(connection, pin)
        if (!r.ok && r.code === 'wait') delays++
      }
    }
    expect(delays).toBeGreaterThan(0)
  })

  it('after the 10-minute window without failures it starts from zero', () => {
    const m = setupAccess()
    const { connection } = m.pair()
    m.access.startSession(connection, BAD_VALUES[0] as string)
    m.access.startSession(connection, BAD_VALUES[1] as string)
    m.advance(10 * 60_000)

    expect(m.access.startSession(connection, BAD_VALUES[2] as string)).toMatchObject({
      waitMs: 0,
    })
  })

  it('formats that are not a PIN fail the same as a wrong PIN and count as a failure', () => {
    const m = setupAccess()
    const { connection } = m.pair()
    const pin = m.people.waiter.pin
    const malformed = [
      `${pin}\n`,
      ` ${pin}`,
      `${pin} `,
      `${pin}0`,
      pin.slice(1),
      '',
      '０１２３',
      '١٢٣٤',
      '1e3',
      '-123',
    ]

    const responses = malformed.slice(0, 2).map((p) => m.access.startSession(connection, p))
    expect(responses).toEqual([
      { ok: false, code: 'wrong_pin', message: 'PIN incorrecto', waitMs: 0 },
      { ok: false, code: 'wrong_pin', message: 'PIN incorrecto', waitMs: 0 },
    ])
    m.access.startSession(connection, malformed[2] as string)
    for (const p of malformed.slice(3)) {
      m.advance(60_000)
      expect(m.access.startSession(connection, p), JSON.stringify(p)).toMatchObject({
        code: 'wrong_pin',
      })
    }
  })

  it('the wrong-PIN message does not reveal whether the PIN exists, nor whose it is', () => {
    const m = setupAccess()
    const a = m.pair('waiter', 'A').connection
    const b = m.pair('waiter', 'B').connection
    const nonexistent = m.access.startSession(a, '0001')
    // An archived user also looks like «does not exist».
    m.access.archiveUser(m.people.waiter2.userId)
    const archived = m.access.startSession(b, m.people.waiter2.pin)

    expect(archived).toEqual(nonexistent)
  })

  it('the error response never includes the typed PIN', () => {
    const m = setupAccess()
    const { connection } = m.pair()
    for (const pin of ['0001', '0002', '0003', '0004'])
      expect(JSON.stringify(m.access.startSession(connection, pin))).not.toContain(pin)
  })
})
