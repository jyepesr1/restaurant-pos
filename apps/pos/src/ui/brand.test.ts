import { readFileSync } from 'node:fs'
import { BRANDS as HUB_BRANDS } from '@pos/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyBrand, BRANDS, DEFAULT_BRAND, isBrand } from './brand'

// The restaurant brand in the browser (task 1.3c): which values are valid, how it is applied to the
// page and how it is remembered on the device. No real browser: `document` and `localStorage` are
// simulated (the test environment is Node).

const KEY = 'pos-brand'

function simulateBrowser(options: { saved?: string | null; noStore?: boolean } = {}) {
  const dataset: Record<string, string | undefined> = {}
  const store = new Map<string, string>()
  if (options.saved != null) store.set(KEY, options.saved)
  const localStorage = options.noStore
    ? {
        getItem: () => {
          throw new DOMException('Acceso denegado', 'SecurityError')
        },
        setItem: () => {
          throw new DOMException('Cuota excedida', 'QuotaExceededError')
        },
      }
    : {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
      }
  vi.stubGlobal('document', { documentElement: { dataset } })
  vi.stubGlobal('localStorage', localStorage)
  return { dataset, store }
}

afterEach(() => vi.unstubAllGlobals())

describe('isBrand', () => {
  it('only recognizes the brands the app knows how to draw', () => {
    expect(isBrand('faro')).toBe(true)
    expect(isBrand('la-spritzzeria')).toBe(true)
  })

  it('rejects anything else, including brands from earlier tests', () => {
    for (const value of [
      'bagno',
      'taller',
      'noche',
      'neutra',
      'Faro',
      'FARO',
      ' faro',
      'faro ',
      'la_spritzzeria',
      '',
      null,
      undefined,
      0,
      1,
      true,
      {},
      [],
      ['faro'],
      { brand: 'faro' },
      'toString',
      '__proto__',
      'constructor',
    ])
      expect(isBrand(value), JSON.stringify(value)).toBe(false)
  })

  it('the default brand is a valid brand and is Faro', () => {
    expect(DEFAULT_BRAND).toBe('faro')
    expect(isBrand(DEFAULT_BRAND)).toBe(true)
  })
})

describe('the app brands and the hub brands say the same', () => {
  it('the app list and the core list (the one the hub validates) are equal', () => {
    expect(BRANDS.map((m) => m.brand).sort()).toEqual([...HUB_BRANDS].sort())
  })

  it('each brand has a name and description to show it, without repeats', () => {
    for (const m of BRANDS) {
      expect(m.name.trim().length).toBeGreaterThan(0)
      expect(m.description.trim().length).toBeGreaterThan(0)
    }
    expect(new Set(BRANDS.map((m) => m.brand)).size).toBe(BRANDS.length)
    expect(new Set(BRANDS.map((m) => m.name)).size).toBe(BRANDS.length)
  })

  it('each brand that is not Faro has its color block in styles.css, in light and dark', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
    for (const { brand } of BRANDS) {
      if (brand === DEFAULT_BRAND) continue
      expect(css, brand).toContain(`:root[data-brand="${brand}"] {`)
      expect(css, brand).toContain(`:root[data-brand="${brand}"].dark {`)
    }
    // And there are no brand blocks the app no longer offers.
    const inTheSheet = [...css.matchAll(/data-brand="([^"]+)"/g)].map((m) => m[1])
    for (const name of inTheSheet) expect(isBrand(name), name).toBe(true)
  })
})

describe('applyBrand', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('with a restaurant brand it sets it on <html> and remembers it', () => {
    const { dataset, store } = simulateBrowser()
    applyBrand('la-spritzzeria')
    expect(dataset.brand).toBe('la-spritzzeria')
    expect(store.get(KEY)).toBe('la-spritzzeria')
  })

  it('with Faro it removes the attribute (Faro is the unbranded design) and remembers it', () => {
    const { dataset, store } = simulateBrowser()
    dataset.brand = 'la-spritzzeria'
    applyBrand('faro')
    expect('brand' in dataset).toBe(false)
    expect(store.get(KEY)).toBe('faro')
  })

  it('changing brands several times always leaves the last one', () => {
    const { dataset, store } = simulateBrowser()
    for (const m of ['la-spritzzeria', 'faro', 'faro', 'la-spritzzeria', 'faro'] as const) {
      applyBrand(m)
      expect(store.get(KEY)).toBe(m)
      expect(dataset.brand).toBe(m === 'faro' ? undefined : m)
    }
  })

  it('with no argument it applies the one saved on the device', () => {
    const { dataset } = simulateBrowser({ saved: 'la-spritzzeria' })
    applyBrand()
    expect(dataset.brand).toBe('la-spritzzeria')
  })

  it('with no argument and nothing saved it looks like Faro', () => {
    const { dataset, store } = simulateBrowser()
    applyBrand()
    expect('brand' in dataset).toBe(false)
    expect(store.get(KEY)).toBe('faro')
  })

  it('if what is saved is an old or made-up brand (from an earlier version), it goes back to Faro and fixes it', () => {
    for (const savedValue of [
      'bagno',
      'taller',
      'noche',
      'neutra',
      'inventada',
      '',
      'null',
      '{"x":1}',
    ]) {
      const { dataset, store } = simulateBrowser({ saved: savedValue })
      applyBrand()
      expect('brand' in dataset, savedValue).toBe(false)
      expect(store.get(KEY), savedValue).toBe('faro')
    }
  })

  it('without storage (private browsing, quota full) it still applies on the page and does not fail', () => {
    const { dataset } = simulateBrowser({ noStore: true })
    expect(() => applyBrand('la-spritzzeria')).not.toThrow()
    expect(dataset.brand).toBe('la-spritzzeria')
    expect(() => applyBrand()).not.toThrow()
    expect('brand' in dataset).toBe(false)
  })

  it('after reloading (another "page" with the same store) the brand stays', () => {
    const first = simulateBrowser()
    applyBrand('la-spritzzeria')
    const saved = first.store.get(KEY)
    const second = simulateBrowser({ saved })
    applyBrand()
    expect(second.dataset.brand).toBe('la-spritzzeria')
  })
})

describe('the index.html script that paints before loading', () => {
  // It is the same value `applyBrand` reads: if the key changes, or what it accepts, this warns.
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''

  function runScript(saved: string | null | 'failed') {
    const browser = simulateBrowser({ noStore: saved === 'failed' })
    if (saved !== null && saved !== 'failed') browser.store.set(KEY, saved)
    const classes = new Set<string>()
    const documentElement = {
      dataset: browser.dataset,
      classList: { add: (c: string) => classes.add(c) },
    }
    const environment = {
      localStorage: (globalThis as unknown as { localStorage: object }).localStorage,
      document: { documentElement },
      matchMedia: () => ({ matches: false }),
    }
    new Function('localStorage', 'document', 'matchMedia', script)(
      environment.localStorage,
      environment.document,
      environment.matchMedia,
    )
    return browser
  }

  it('the script exists and uses the same storage key', () => {
    expect(script).toContain(`'${KEY}'`)
  })

  it('with the restaurant brand saved, it sets it before painting', () => {
    expect(runScript('la-spritzzeria').dataset.brand).toBe('la-spritzzeria')
  })

  it('with no saved brand or with Faro, it sets nothing', () => {
    expect('brand' in runScript(null).dataset).toBe(false)
    expect('brand' in runScript('faro').dataset).toBe(false)
  })

  it('if storage fails, it does not break the page', () => {
    expect(() => runScript('failed')).not.toThrow()
  })

  it('a saved brand that no longer exists is fixed as soon as the app starts', () => {
    const browser = runScript('bagno')
    // The script sets it as is (it does not know the list)…
    expect(browser.dataset.brand).toBe('bagno')
    // …and `applyBrand()` in main.tsx sets it back to Faro and clears what was saved.
    applyBrand()
    expect('brand' in browser.dataset).toBe(false)
    expect(browser.store.get(KEY)).toBe('faro')
  })
})
