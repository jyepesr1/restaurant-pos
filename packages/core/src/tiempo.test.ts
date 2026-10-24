import { describe, expect, it } from 'vitest'
import { diaOperativo } from './tiempo'

describe('día operativo', () => {
  it.each([
    ['2026-10-24T06:00:00.000Z', '2026-10-23'], // 1:00 a. m. en Bogotá
    ['2026-10-24T10:59:00.000Z', '2026-10-23'], // 5:59 a. m.
    ['2026-10-24T11:00:00.000Z', '2026-10-24'], // 6:00 a. m.
    ['2026-10-25T04:30:00.000Z', '2026-10-24'], // 11:30 p. m. del 24
    ['2027-01-01T05:30:00.000Z', '2026-12-31'], // 0:30 del 1 de enero: cambio de año
  ])('%s → %s', (instante, dia) => {
    expect(diaOperativo(instante, 'America/Bogota')).toBe(dia)
  })

  it('respeta otra hora de inicio y rechaza instantes inválidos', () => {
    // 3:00 a. m. en Bogotá: antes de las 4:00 es del día anterior; a las 5:00, ya del mismo día.
    expect(diaOperativo('2026-10-24T08:00:00.000Z', 'America/Bogota', '04:00')).toBe('2026-10-23')
    expect(diaOperativo('2026-10-24T10:00:00.000Z', 'America/Bogota', '04:00')).toBe('2026-10-24')
    expect(diaOperativo('2026-10-24T08:00:00.000Z', 'America/Bogota', '00:00')).toBe('2026-10-24')
    expect(() => diaOperativo('ayer', 'America/Bogota')).toThrow(RangeError)
  })
})
