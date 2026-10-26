import { readFileSync } from 'node:fs'
import { BRANDS as MARCAS_DEL_HUB } from '@pos/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aplicarMarca, BRANDS, esMarca, MARCA_POR_DEFECTO } from './marca'

// La marca del restaurante en el navegador (tarea 1.3c): qué valores vale, cómo se aplica a la
// página y cómo se recuerda en el equipo. Sin navegador real: `document` y `localStorage` son
// simulados (el entorno de pruebas es Node).

const CLAVE = 'pos-brand'

function simularNavegador(options: { saved?: string | null; sinAlmacen?: boolean } = {}) {
  const dataset: Record<string, string | undefined> = {}
  const store = new Map<string, string>()
  if (options.saved != null) store.set(CLAVE, options.saved)
  const localStorage = options.sinAlmacen
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

describe('esMarca', () => {
  it('solo reconoce las marcas que la app sabe dibujar', () => {
    expect(esMarca('faro')).toBe(true)
    expect(esMarca('la-spritzzeria')).toBe(true)
  })

  it('rechaza cualquier otra cosa, incluidas las marcas de pruebas anteriores', () => {
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
      expect(esMarca(value), JSON.stringify(value)).toBe(false)
  })

  it('la marca por defecto es una marca válida y es Faro', () => {
    expect(MARCA_POR_DEFECTO).toBe('faro')
    expect(esMarca(MARCA_POR_DEFECTO)).toBe(true)
  })
})

describe('las marcas de la app y las del hub dicen lo mismo', () => {
  it('la lista de la app y la del núcleo (la que valida el hub) son iguales', () => {
    expect(BRANDS.map((m) => m.brand).sort()).toEqual([...MARCAS_DEL_HUB].sort())
  })

  it('cada marca tiene nombre y descripción para mostrarla, sin repetirse', () => {
    for (const m of BRANDS) {
      expect(m.name.trim().length).toBeGreaterThan(0)
      expect(m.description.trim().length).toBeGreaterThan(0)
    }
    expect(new Set(BRANDS.map((m) => m.brand)).size).toBe(BRANDS.length)
    expect(new Set(BRANDS.map((m) => m.name)).size).toBe(BRANDS.length)
  })

  it('cada marca que no es Faro tiene su bloque de colores en estilos.css, en claro y en oscuro', () => {
    const css = readFileSync(new URL('../estilos.css', import.meta.url), 'utf8')
    for (const { brand } of BRANDS) {
      if (brand === MARCA_POR_DEFECTO) continue
      expect(css, brand).toContain(`:root[data-marca="${brand}"] {`)
      expect(css, brand).toContain(`:root[data-marca="${brand}"].oscuro {`)
    }
    // Y no hay bloques de marcas que la app ya no ofrezca.
    const enLaHoja = [...css.matchAll(/data-marca="([^"]+)"/g)].map((m) => m[1])
    for (const name of enLaHoja) expect(esMarca(name), name).toBe(true)
  })
})

describe('aplicarMarca', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('con una marca de restaurante la pone en <html> y la recuerda', () => {
    const { dataset, store } = simularNavegador()
    aplicarMarca('la-spritzzeria')
    expect(dataset.marca).toBe('la-spritzzeria')
    expect(store.get(CLAVE)).toBe('la-spritzzeria')
  })

  it('con Faro quita el atributo (Faro es el diseño sin marca) y lo recuerda', () => {
    const { dataset, store } = simularNavegador()
    dataset.marca = 'la-spritzzeria'
    aplicarMarca('faro')
    expect('marca' in dataset).toBe(false)
    expect(store.get(CLAVE)).toBe('faro')
  })

  it('cambiar de marca varias veces deja siempre la última', () => {
    const { dataset, store } = simularNavegador()
    for (const m of ['la-spritzzeria', 'faro', 'faro', 'la-spritzzeria', 'faro'] as const) {
      aplicarMarca(m)
      expect(store.get(CLAVE)).toBe(m)
      expect(dataset.marca).toBe(m === 'faro' ? undefined : m)
    }
  })

  it('sin argumento aplica la guardada en el equipo', () => {
    const { dataset } = simularNavegador({ saved: 'la-spritzzeria' })
    aplicarMarca()
    expect(dataset.marca).toBe('la-spritzzeria')
  })

  it('sin argumento y sin nada guardado se ve como Faro', () => {
    const { dataset, store } = simularNavegador()
    aplicarMarca()
    expect('marca' in dataset).toBe(false)
    expect(store.get(CLAVE)).toBe('faro')
  })

  it('si lo guardado es una marca vieja o inventada (de una versión anterior), vuelve a Faro y lo corrige', () => {
    for (const oldOne of [
      'bagno',
      'taller',
      'noche',
      'neutra',
      'inventada',
      '',
      'null',
      '{"x":1}',
    ]) {
      const { dataset, store } = simularNavegador({ saved: oldOne })
      aplicarMarca()
      expect('marca' in dataset, oldOne).toBe(false)
      expect(store.get(CLAVE), oldOne).toBe('faro')
    }
  })

  it('sin almacenamiento (navegación privada, cuota llena) igual se aplica en la página y no falla', () => {
    const { dataset } = simularNavegador({ sinAlmacen: true })
    expect(() => aplicarMarca('la-spritzzeria')).not.toThrow()
    expect(dataset.marca).toBe('la-spritzzeria')
    expect(() => aplicarMarca()).not.toThrow()
    expect('marca' in dataset).toBe(false)
  })

  it('después de recargar (otra "página" con el mismo almacén) la marca sigue', () => {
    const first = simularNavegador()
    aplicarMarca('la-spritzzeria')
    const saved = first.store.get(CLAVE)
    const second = simularNavegador({ saved })
    aplicarMarca()
    expect(second.dataset.marca).toBe('la-spritzzeria')
  })
})

describe('el script de index.html que pinta antes de cargar', () => {
  // Es el mismo valor que lee `aplicarMarca`: si cambia la clave, o lo que acepta, esto avisa.
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''

  function correrScript(saved: string | null | 'failed') {
    const navegador = simularNavegador({ sinAlmacen: saved === 'failed' })
    if (saved !== null && saved !== 'failed') navegador.store.set(CLAVE, saved)
    const clases = new Set<string>()
    const documentElement = {
      dataset: navegador.dataset,
      classList: { add: (c: string) => clases.add(c) },
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
    return navegador
  }

  it('existe el script y usa la misma clave de almacenamiento', () => {
    expect(script).toContain(`'${CLAVE}'`)
  })

  it('con la marca del restaurante guardada, la pone antes de pintar', () => {
    expect(correrScript('la-spritzzeria').dataset.marca).toBe('la-spritzzeria')
  })

  it('sin marca guardada o con Faro, no pone nada', () => {
    expect('marca' in correrScript(null).dataset).toBe(false)
    expect('marca' in correrScript('faro').dataset).toBe(false)
  })

  it('si el almacenamiento falla, no rompe la página', () => {
    expect(() => correrScript('failed')).not.toThrow()
  })

  it('una marca guardada que ya no existe se corrige en cuanto arranca la app', () => {
    const navegador = correrScript('bagno')
    // El script la pone tal cual (no conoce la lista)…
    expect(navegador.dataset.marca).toBe('bagno')
    // …y `aplicarMarca()` de main.tsx la devuelve a Faro y limpia lo guardado.
    aplicarMarca()
    expect('marca' in navegador.dataset).toBe(false)
    expect(navegador.store.get(CLAVE)).toBe('faro')
  })
})
