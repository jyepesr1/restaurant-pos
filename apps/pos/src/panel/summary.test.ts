import { describe, expect, it } from 'vitest'
import { compare, dataState, timeOf, weekdayOf } from './summary'

// What the dashboard says (task 1.11c-1): the comparison with last week and from when the data is.

/** Intl writes «p. m.» with non-breaking spaces; the tests read them as plain ones. */
const plain = (s: string) => s.replace(/\s/g, ' ')

const BOGOTA = 'America/Bogota'

describe('comparison with the same weekday last week', () => {
  it('up and down with sign, one decimal and a comma', () => {
    expect(compare(1_250_000, 1_000_000)).toEqual({
      direction: 'up',
      percent: '+25 %',
      tone: 'free',
    })
    // A fall is said plainly, with its arrow, not in red.
    expect(compare(900_000, 1_200_000)).toEqual({
      direction: 'down',
      percent: '-25 %',
      tone: 'neutral',
    })
    expect(compare(1_000, 3_000).percent).toBe('-66,7 %')
    expect(compare(4_000, 3_000).percent).toBe('+33,3 %')
  })

  it('without sales back then there is no percentage: it does not divide by zero', () => {
    expect(compare(50_000, 0)).toEqual({ direction: 'new', percent: null, tone: 'neutral' })
  })

  it('equal (also both at zero) is 0 %', () => {
    expect(compare(0, 0).direction).toBe('same')
    expect(compare(70_000, 70_000)).toEqual({ direction: 'same', percent: '0 %', tone: 'neutral' })
  })

  it('a tiny change still says which way it went', () => {
    expect(compare(1_000_001, 1_000_000)).toMatchObject({ direction: 'up', percent: '+0 %' })
  })

  it('a negative day back then (refunds) compares against its size', () => {
    expect(compare(10_000, -10_000)).toMatchObject({ direction: 'up', percent: '+200 %' })
    expect(compare(-2_251, -2_000)).toMatchObject({ direction: 'down', percent: '-12,6 %' })
    expect(compare(-1_749, -2_000)).toMatchObject({ direction: 'up', percent: '+12,6 %' })
  })

  it('a rise and a fall of the same size round the same (the sign goes apart)', () => {
    // 251 / 2.000 = 12,55 %: both ways it is 12,6 %, not 12,6 up and 12,5 down.
    expect(compare(2_251, 2_000).percent).toBe('+12,6 %')
    expect(compare(1_749, 2_000).percent).toBe('-12,6 %')
  })
})

describe('times and days', () => {
  it('the time in the restaurant time zone, as in Colombia', () => {
    expect(plain(timeOf('2026-10-30T02:41:00.000Z', BOGOTA))).toBe('9:41 p. m.')
    expect(plain(timeOf('2026-10-29T13:05:00.000Z', BOGOTA))).toBe('8:05 a. m.')
  })

  it('the time follows the restaurant time zone the cloud says', () => {
    expect(plain(timeOf('2026-10-30T02:41:00.000Z', 'America/Mexico_City'))).toBe('8:41 p. m.')
  })

  it('the weekday of a business day', () => {
    expect(weekdayOf('2026-10-22')).toBe('jueves')
    expect(weekdayOf('2026-10-25')).toBe('domingo')
  })
})

describe('the state of the data', () => {
  const local = {
    last_seen_at: '2026-10-30T02:41:00.000Z',
    last_event_at: '2026-10-30T02:39:00.000Z',
    pending: 0,
  }
  const ok = {
    failed: false,
    receivedAt: '2026-10-30T02:41:30.000Z',
    now: '2026-10-30T02:41:30.000Z',
  }

  it('up to date: when it was updated, nothing pending', () => {
    const s = dataState(local, ok, BOGOTA)
    expect(plain(s.text)).toBe('Actualizado 9:41 p. m.')
    expect(s.kind).toBe('up_to_date')
    expect(s.pending).toBeNull()
    expect(s.figuresAt).toBeNull()
    expect(s.icon).toBe('cloud')
  })

  it('says how many changes the local still has to send, in singular and plural', () => {
    expect(dataState({ ...local, pending: 1 }, ok, BOGOTA).pending).toBe(
      'Falta 1 dato del local por llegar',
    )
    const s = dataState({ ...local, pending: 7 }, ok, BOGOTA)
    expect(s.pending).toBe('Faltan 7 datos del local por llegar')
    expect(s.tone).toBe('neutral')
  })

  it('pending unknown (null) or zero is not shown', () => {
    expect(dataState({ ...local, pending: null }, ok, BOGOTA).pending).toBeNull()
    expect(dataState({ ...local, pending: 0 }, ok, BOGOTA).pending).toBeNull()
  })

  it('without the heartbeat it uses the last event; without either, it says nothing has arrived', () => {
    expect(plain(dataState({ ...local, last_seen_at: null }, ok, BOGOTA).text)).toBe(
      'Actualizado 9:39 p. m.',
    )
    expect(
      dataState({ last_seen_at: null, last_event_at: null, pending: 0 }, ok, BOGOTA).text,
    ).toBe('El restaurante todavía no ha enviado datos')
  })

  it('more than 2 minutes without news from the restaurant: alert, figures of that time, no pending', () => {
    const late = { ...ok, now: '2026-10-30T02:43:01.000Z' }
    const s = dataState({ ...local, pending: 4 }, late, BOGOTA)
    expect(s.kind).toBe('no_news')
    expect(plain(s.text)).toBe('Sin noticias del restaurante desde las 9:41 p. m.')
    expect(plain(s.detail ?? '')).toBe(
      'Puede que la caja esté apagada o sin internet. Las cifras son de las 9:41 p. m.',
    )
    expect(s.tone).toBe('warning')
    expect(s.icon).toBe('cloudOff')
    expect(s.pending).toBeNull()
    expect(plain(s.figuresAt ?? '')).toBe('9:41 p. m.')
    // Exactly 2 minutes is still up to date.
    expect(dataState(local, { ...ok, now: '2026-10-30T02:43:00.000Z' }, BOGOTA).kind).toBe(
      'up_to_date',
    )
  })

  it('when the last request failed it says from when its figures are', () => {
    const s = dataState(
      local,
      { failed: true, receivedAt: '2026-10-30T02:40:00.000Z', now: null },
      BOGOTA,
    )
    expect(plain(s.text)).toBe('Sin conexión a internet: no llegan datos del restaurante')
    expect(plain(s.detail ?? '')).toBe('Las cifras son de las 9:40 p. m.')
    expect(s.icon).toBe('cloudOff')
    const other = dataState(
      local,
      { failed: true, cause: 'other', receivedAt: '2026-10-30T02:40:00.000Z', now: null },
      BOGOTA,
    )
    expect(plain(`${other.text}. ${other.detail}`)).toBe(
      'No se pudo actualizar. Las cifras son de las 9:40 p. m.',
    )
    expect(s.tone).toBe('warning')
  })

  it('failed before any answer: only that there is no connection', () => {
    const s = dataState(null, { failed: true, receivedAt: null, now: null }, BOGOTA)
    expect(s.text).toBe('Sin conexión a internet: no llegan datos del restaurante')
    expect(s.detail).toBeNull()
  })

  it('the announcement changes only with the state, not with the time', () => {
    const a = dataState(local, ok, BOGOTA).announcement
    const later = { ...local, last_seen_at: '2026-10-30T02:41:20.000Z' }
    expect(dataState(later, ok, BOGOTA).announcement).toBe(a)
    expect(
      dataState(local, { ...ok, now: '2026-10-30T02:50:00.000Z' }, BOGOTA).announcement,
    ).not.toBe(a)
  })
})
