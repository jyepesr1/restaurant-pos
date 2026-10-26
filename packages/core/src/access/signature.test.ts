import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { canonicalJson, MAX_DEPTH } from '../canonical'
import { event } from '../testing/factory'
import { authorizableFingerprint, constantTimeEqual, signEvent } from './signature'

const opened = () =>
  event('01JB0000000000000000000000', 'OrderOpened', {
    channel: 'dine_in',
    table_id: null,
    guests: 2,
  })

describe('canonical JSON', () => {
  it('sorts keys and omits undefined values', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}')
    expect(canonicalJson(undefined)).toBe('null')
  })

  it('rejects values nested too deeply', () => {
    let value: unknown = 1
    for (let i = 0; i <= MAX_DEPTH; i++) value = [value]
    expect(() => canonicalJson(value)).toThrow(RangeError)
  })
})

describe('event signature', () => {
  it('is HMAC-SHA256 of the canonical content, without the signature or `base_sequence`', () => {
    const e = opened()
    const { base_sequence: _b, ...rest } = e
    const expected = bytesToHex(
      hmac(sha256, utf8ToBytes('secret'), utf8ToBytes(canonicalJson(rest))),
    )

    expect(signEvent(e, 'secret')).toBe(expected)
    expect(signEvent({ ...e, base_sequence: 9, signature: 'f'.repeat(64) }, 'secret')).toBe(
      expected,
    )
  })

  it('changes with the secret or with any event field', () => {
    const e = opened()
    const base = signEvent(e, 'secret')
    expect(signEvent(e, 'other')).not.toBe(base)
    expect(signEvent({ ...e, user_id: '01JB0000000000000000000001' }, 'secret')).not.toBe(base)
    expect(signEvent({ ...e, hub_estimated_time: '2026-10-24T21:00:00.000Z' }, 'secret')).not.toBe(
      base,
    )
  })
})

describe('fingerprint for the supervisor approval', () => {
  it('does not depend on the approval added later, only on the content', () => {
    const e = opened()
    const h = authorizableFingerprint(e)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(authorizableFingerprint({ ...e, authorization_id: '01JB0000000000000000000002' })).toBe(
      h,
    )
    expect(authorizableFingerprint({ ...e, reason: 'other' })).not.toBe(h)
  })
})

describe('string comparison', () => {
  it('compares the whole string', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'ab')).toBe(false)
  })
})
