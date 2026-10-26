import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Attempts, delayAfter, FAILURES_FOR_ALERT, MAX_WAIT_MS } from './attempts'
import {
  generatePin,
  isTrivialPin,
  isWellFormedPin,
  KEY_FILE,
  loadKey,
  newPairingCode,
  pinHash,
} from './secrets'

describe('PIN', () => {
  it('rejects trivial ones: all the same or consecutive', () => {
    for (const pin of ['0000', '7777', '1234', '6789', '9876', '3210'])
      expect(isTrivialPin(pin)).toBe(true)
    for (const pin of ['1235', '2468', '0911', '1212']) expect(isTrivialPin(pin)).toBe(false)
  })

  it('generates 4 digits, with leading zeros, and never a trivial one', () => {
    const random = [1234, 7, 5555, 42]
    expect(generatePin(() => random.shift() as number)).toBe('0007')
    expect(generatePin(() => random.shift() as number)).toBe('0042')
    for (let i = 0; i < 2000; i++) {
      const pin = generatePin()
      expect(isWellFormedPin(pin)).toBe(true)
      expect(isTrivialPin(pin)).toBe(false)
    }
  })

  it('the hash depends on the key and the restaurant', () => {
    const a = Buffer.alloc(32, 1)
    const b = Buffer.alloc(32, 2)
    expect(pinHash(a, 'r1', '4821')).toBe(pinHash(a, 'r1', '4821'))
    expect(pinHash(a, 'r1', '4821')).not.toBe(pinHash(b, 'r1', '4821'))
    expect(pinHash(a, 'r1', '4821')).not.toBe(pinHash(a, 'r2', '4821'))
    expect(pinHash(a, 'r1', '4821')).not.toContain('4821')
  })

  it('the pairing code has no letters that can be confused', () => {
    for (let i = 0; i < 200; i++) expect(newPairingCode()).toMatch(/^[A-HJKMNP-Z2-9]{8}$/)
  })
})

describe('hub key', () => {
  let folder = ''
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  it('is created once, readable only by the hub, and then read back the same', () => {
    folder = mkdtempSync(join(tmpdir(), 'pos-clave-'))
    const first = loadKey(folder)
    const second = loadKey(folder)

    expect(first.newOne).toBe(true)
    expect(second.newOne).toBe(false)
    expect(second.key.equals(first.key)).toBe(true)
    if (process.platform !== 'win32')
      expect(statSync(join(folder, KEY_FILE)).mode & 0o777).toBe(0o600)
  })

  it('a damaged key stops startup with a clear message', () => {
    folder = mkdtempSync(join(tmpdir(), 'pos-clave-'))
    writeFileSync(join(folder, KEY_FILE), 'corta')
    expect(() => loadKey(folder)).toThrow(/dañada/)
  })
})

describe('wait after failed attempts', () => {
  it('two errors without waiting; then 2, 4, 8… s up to 60 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map(delayAfter)).toEqual([
      0,
      0,
      2000,
      4000,
      8000,
      16_000,
      32_000,
      MAX_WAIT_MS,
      MAX_WAIT_MS,
    ])
  })

  it('is per attempter and is forgotten after 10 min without failures', () => {
    let now = 0
    const attempts = new Attempts(() => now)
    for (let i = 0; i < 3; i++) attempts.failure('a')
    expect(attempts.waitMs('a')).toBe(2000)
    expect(attempts.waitMs('b')).toBe(0)

    now += 2000
    expect(attempts.waitMs('a')).toBe(0)
    expect(attempts.failure('a')).toBe(4000)

    now += 10 * 60_000
    expect(attempts.failure('a')).toBe(0)
  })

  it('alerts the admin when there are many failures within 10 minutes, once', () => {
    const alerts: string[] = []
    const attempts = new Attempts(
      () => 0,
      (n) => alerts.push(n),
    )
    for (let i = 0; i < FAILURES_FOR_ALERT + 5; i++) attempts.failure(`device-${i % 3}`)
    expect(alerts).toEqual([
      `${FAILURES_FOR_ALERT} PIN o códigos errados en 10 minutos en el restaurante`,
    ])
  })
})
