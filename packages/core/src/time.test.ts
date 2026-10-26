import { describe, expect, it } from 'vitest'
import { businessDay } from './time'

describe('business day', () => {
  it.each([
    ['2026-10-24T06:00:00.000Z', '2026-10-23'], // 1:00 a.m. in Bogotá
    ['2026-10-24T10:59:00.000Z', '2026-10-23'], // 5:59 a.m.
    ['2026-10-24T11:00:00.000Z', '2026-10-24'], // 6:00 a.m.
    ['2026-10-25T04:30:00.000Z', '2026-10-24'], // 11:30 p.m. on the 24th
    ['2027-01-01T05:30:00.000Z', '2026-12-31'], // 0:30 on January 1: year change
  ])('%s → %s', (instant, day) => {
    expect(businessDay(instant, 'America/Bogota')).toBe(day)
  })

  it('honors another start time and rejects invalid instants', () => {
    // 3:00 a.m. in Bogotá: before 4:00 it belongs to the previous day; at 5:00, to the same day.
    expect(businessDay('2026-10-24T08:00:00.000Z', 'America/Bogota', '04:00')).toBe('2026-10-23')
    expect(businessDay('2026-10-24T10:00:00.000Z', 'America/Bogota', '04:00')).toBe('2026-10-24')
    expect(businessDay('2026-10-24T08:00:00.000Z', 'America/Bogota', '00:00')).toBe('2026-10-24')
    expect(() => businessDay('yesterday', 'America/Bogota')).toThrow(RangeError)
  })
})
