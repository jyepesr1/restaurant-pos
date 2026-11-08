import { describe, expect, it } from 'vitest'
import { drawerPulse } from './escpos'
import { readEscpos } from './reader'

// The cash drawer pulse (task 1.13): the exact bytes that open it, and that it prints nothing.

describe('drawerPulse', () => {
  it('is ESC p 0 25 250 and nothing else', () => {
    expect([...drawerPulse()]).toEqual([0x1b, 0x70, 0x00, 0x19, 0xfa])
  })

  it('prints nothing and does not cut: the reader shows it as the drawer', () => {
    expect(readEscpos(drawerPulse())).toEqual({ text: '[cajón]', cuts: 0 })
  })

  it('each call returns its own bytes (changing one does not change the next)', () => {
    const first = drawerPulse()
    first[0] = 0
    expect(drawerPulse()[0]).toBe(0x1b)
  })
})
