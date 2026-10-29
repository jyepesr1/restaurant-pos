import type { CloudState, CloudStatus } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import { cloudLabel, pendingOnClose, SEES_CLOUD } from './cloud'

// How the upload to the cloud reads on the register screens (task 1.11): the same words in the
// top bar, on the «Nube» screen and when closing the register.

const status = (state: CloudState, pending = 0): CloudStatus => ({
  state,
  pending,
  last_upload_at: null,
})

describe('cloudLabel', () => {
  it.each([
    ['up_to_date', 0, 'free', 'Nube al día'],
    ['uploading', 1, 'progress', 'Subiendo 1 cambio'],
    ['uploading', 2, 'progress', 'Subiendo 2 cambios'],
    ['uploading', 1500, 'progress', 'Subiendo 1500 cambios'],
    // Without internet the dining room goes on: neutral, not an alarm.
    ['offline', 1, 'neutral', '1 cambio por subir · sin internet'],
    ['offline', 7, 'neutral', '7 cambios por subir · sin internet'],
    ['offline', 0, 'neutral', 'Sin internet'],
    // These need someone, and they say who.
    ['revoked', 0, 'warning', 'La nube no acepta esta caja · avisa al administrador'],
    ['revoked', 40, 'warning', 'La nube no acepta esta caja · avisa al administrador'],
    ['stuck', 1, 'warning', '1 cambio sin subir · avisa a Faro'],
    ['stuck', 12, 'warning', '12 cambios sin subir · avisa a Faro'],
    ['not_connected', 0, 'neutral', 'Sin conectar a la nube'],
    ['not_connected', 5, 'neutral', 'Sin conectar a la nube'],
  ] as const)('%s with %i pending reads «%s»', (state, pending, tone, text) => {
    expect(cloudLabel(status(state, pending))).toMatchObject({ tone, text })
  })

  it('has a label for every state and every one has an icon', () => {
    const states: CloudState[] = [
      'not_connected',
      'up_to_date',
      'uploading',
      'offline',
      'revoked',
      'stuck',
    ]
    for (const state of states) {
      const l = cloudLabel(status(state, 3))
      expect(l.text.length).toBeGreaterThan(0)
      expect(l.icon).toBeTruthy()
    }
  })

  it('a problem is never shown in the «free» (all good) tone', () => {
    for (const state of ['offline', 'revoked', 'stuck'] as const)
      expect(cloudLabel(status(state, 1)).tone).not.toBe('free')
  })

  it('«stuck» is never reported as up to date, even with nothing pending', () => {
    expect(cloudLabel(status('stuck', 0)).text).not.toMatch(/al día/)
  })

  it('the singular is used only for exactly one', () => {
    expect(cloudLabel(status('uploading', 1)).text).toContain('1 cambio')
    expect(cloudLabel(status('uploading', 1)).text).not.toContain('cambios')
    expect(cloudLabel(status('uploading', 0)).text).toContain('0 cambios')
  })
})

describe('pendingOnClose', () => {
  it('says nothing when it is unknown, connected and up to date, or never connected', () => {
    expect(pendingOnClose(null)).toBeNull()
    expect(pendingOnClose(status('up_to_date', 0))).toBeNull()
    expect(pendingOnClose(status('not_connected', 9))).toBeNull()
    expect(pendingOnClose(status('offline', 0))).toBeNull()
  })

  it('says how many are left, in singular and plural', () => {
    expect(pendingOnClose(status('offline', 1))).toMatch(/^Quedan 1 cambio por subir a la nube\./)
    expect(pendingOnClose(status('offline', 4))).toMatch(/^Quedan 4 cambios por subir a la nube\./)
  })

  it('tells the register closes anyway and that it uploads by itself', () => {
    const text = pendingOnClose(status('offline', 3)) as string
    expect(text).toContain('La caja se cierra igual')
    expect(text).toContain('se suben solos')
  })

  it.each(['uploading', 'offline', 'revoked', 'stuck', 'up_to_date'] as const)(
    'with %s and pending changes it warns',
    (state) => {
      expect(pendingOnClose(status(state, 2))).not.toBeNull()
    },
  )

  it.each(['revoked', 'stuck'] as const)(
    'with %s it does not promise the changes will upload by themselves (they need someone)',
    (state) => {
      expect(pendingOnClose(status(state, 5))).not.toMatch(/se suben solos/)
    },
  )
})

describe('who sees the cloud status in the top bar', () => {
  it('the register and the admin do, the waiters do not', () => {
    expect([...SEES_CLOUD].sort()).toEqual([
      'manage_devices',
      'open_register_shift',
      'record_payment',
    ])
    expect(SEES_CLOUD).not.toContain('take_order')
  })
})
