import { describe, expect, it } from 'vitest'
import { isValidId, newId } from './id'

describe('newId', () => {
  it('generates valid 26-character ULIDs', () => {
    const id = newId()
    expect(id).toHaveLength(26)
    expect(isValidId(id)).toBe(true)
  })

  it('never repeats and keeps the order even when created in the same millisecond', () => {
    const ids = Array.from({ length: 10_000 }, () => newId())
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(ids)
  })

  it('rejects values that are not ULIDs', () => {
    expect(isValidId('mesa-5')).toBe(false)
    expect(isValidId('')).toBe(false)
  })

  it('rejects lowercase or out-of-range ULIDs', () => {
    const id = newId()
    expect(isValidId(id.toLowerCase())).toBe(false)
    expect(isValidId(`8${id.slice(1)}`)).toBe(false)
  })
})
