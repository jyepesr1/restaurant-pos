import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanSlug, rememberedRestaurant, rememberRestaurant, slugFromPath } from './restaurant'

// Which restaurant the panel signs in to: `/r/<slug>` and what is remembered on the phone.

afterEach(() => vi.unstubAllGlobals())

describe('the restaurant of the panel', () => {
  it('reads the slug of /r/<slug>, and nothing from other addresses', () => {
    expect(slugFromPath('/r/la-spritzzeria')).toBe('la-spritzzeria')
    expect(slugFromPath('/r/La-Spritzzeria/')).toBe('la-spritzzeria')
    expect(slugFromPath('/r/La%20Spritzzer%C3%ADa')).toBe('la-spritzzeria')
    expect(slugFromPath('/')).toBeNull()
    expect(slugFromPath('/reports')).toBeNull()
    expect(slugFromPath('/r/')).toBeNull()
    expect(slugFromPath('/r/a/b')).toBeNull()
    expect(slugFromPath('/r/%E0%A4%A')).toBeNull()
  })

  it('what was typed becomes a slug: no accents, capitals or spaces', () => {
    expect(cleanSlug(' La Spritzzería ')).toBe('la-spritzzeria')
    expect(cleanSlug('café  del  parque!')).toBe('cafe-del-parque')
    expect(cleanSlug('---')).toBe('')
    expect(cleanSlug('x'.repeat(80))).toHaveLength(60)
  })

  it('remembers it on the device', () => {
    const saved = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => saved.set(k, v),
    })
    expect(rememberedRestaurant()).toBe('')
    rememberRestaurant('la-spritzzeria')
    expect(rememberedRestaurant()).toBe('la-spritzzeria')
  })

  it('without storage (private mode) it neither fails nor remembers', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
    })
    expect(() => rememberRestaurant('x')).not.toThrow()
    expect(rememberedRestaurant()).toBe('')
  })
})
