import { readFileSync } from 'node:fs'
import { MARCAS as MARCAS_DEL_HUB } from '@pos/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aplicarMarca, esMarca, MARCA_POR_DEFECTO, MARCAS } from './marca'

// La marca del restaurante en el navegador (tarea 1.3c): qué valores vale, cómo se aplica a la
// página y cómo se recuerda en el equipo. Sin navegador real: `document` y `localStorage` son
// simulados (el entorno de pruebas es Node).

const CLAVE = 'pos-marca'

function simularNavegador(opciones: { guardado?: string | null; sinAlmacen?: boolean } = {}) {
  const dataset: Record<string, string | undefined> = {}
  const almacen = new Map<string, string>()
  if (opciones.guardado != null) almacen.set(CLAVE, opciones.guardado)
  const localStorage = opciones.sinAlmacen
    ? {
        getItem: () => {
          throw new DOMException('Acceso denegado', 'SecurityError')
        },
        setItem: () => {
          throw new DOMException('Cuota excedida', 'QuotaExceededError')
        },
      }
    : {
        getItem: (k: string) => almacen.get(k) ?? null,
        setItem: (k: string, v: string) => void almacen.set(k, String(v)),
      }
  vi.stubGlobal('document', { documentElement: { dataset } })
  vi.stubGlobal('localStorage', localStorage)
  return { dataset, almacen }
}

afterEach(() => vi.unstubAllGlobals())

describe('esMarca', () => {
  it('solo reconoce las marcas que la app sabe dibujar', () => {
    expect(esMarca('faro')).toBe(true)
    expect(esMarca('la-spritzzeria')).toBe(true)
  })

  it('rechaza cualquier otra cosa, incluidas las marcas de pruebas anteriores', () => {
    for (const valor of [
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
      { marca: 'faro' },
      'toString',
      '__proto__',
      'constructor',
    ])
      expect(esMarca(valor), JSON.stringify(valor)).toBe(false)
  })

  it('la marca por defecto es una marca válida y es Faro', () => {
    expect(MARCA_POR_DEFECTO).toBe('faro')
    expect(esMarca(MARCA_POR_DEFECTO)).toBe(true)
  })
})

describe('las marcas de la app y las del hub dicen lo mismo', () => {
  it('la lista de la app y la del núcleo (la que valida el hub) son iguales', () => {
    expect(MARCAS.map((m) => m.marca).sort()).toEqual([...MARCAS_DEL_HUB].sort())
  })

  it('cada marca tiene nombre y descripción para mostrarla, sin repetirse', () => {
    for (const m of MARCAS) {
      expect(m.nombre.trim().length).toBeGreaterThan(0)
      expect(m.descripcion.trim().length).toBeGreaterThan(0)
    }
    expect(new Set(MARCAS.map((m) => m.marca)).size).toBe(MARCAS.length)
    expect(new Set(MARCAS.map((m) => m.nombre)).size).toBe(MARCAS.length)
  })

  it('cada marca que no es Faro tiene su bloque de colores en estilos.css, en claro y en oscuro', () => {
    const css = readFileSync(new URL('../estilos.css', import.meta.url), 'utf8')
    for (const { marca } of MARCAS) {
      if (marca === MARCA_POR_DEFECTO) continue
      expect(css, marca).toContain(`:root[data-marca="${marca}"] {`)
      expect(css, marca).toContain(`:root[data-marca="${marca}"].oscuro {`)
    }
    // Y no hay bloques de marcas que la app ya no ofrezca.
    const enLaHoja = [...css.matchAll(/data-marca="([^"]+)"/g)].map((m) => m[1])
    for (const nombre of enLaHoja) expect(esMarca(nombre), nombre).toBe(true)
  })
})

describe('aplicarMarca', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('con una marca de restaurante la pone en <html> y la recuerda', () => {
    const { dataset, almacen } = simularNavegador()
    aplicarMarca('la-spritzzeria')
    expect(dataset.marca).toBe('la-spritzzeria')
    expect(almacen.get(CLAVE)).toBe('la-spritzzeria')
  })

  it('con Faro quita el atributo (Faro es el diseño sin marca) y lo recuerda', () => {
    const { dataset, almacen } = simularNavegador()
    dataset.marca = 'la-spritzzeria'
    aplicarMarca('faro')
    expect('marca' in dataset).toBe(false)
    expect(almacen.get(CLAVE)).toBe('faro')
  })

  it('cambiar de marca varias veces deja siempre la última', () => {
    const { dataset, almacen } = simularNavegador()
    for (const m of ['la-spritzzeria', 'faro', 'faro', 'la-spritzzeria', 'faro'] as const) {
      aplicarMarca(m)
      expect(almacen.get(CLAVE)).toBe(m)
      expect(dataset.marca).toBe(m === 'faro' ? undefined : m)
    }
  })

  it('sin argumento aplica la guardada en el equipo', () => {
    const { dataset } = simularNavegador({ guardado: 'la-spritzzeria' })
    aplicarMarca()
    expect(dataset.marca).toBe('la-spritzzeria')
  })

  it('sin argumento y sin nada guardado se ve como Faro', () => {
    const { dataset, almacen } = simularNavegador()
    aplicarMarca()
    expect('marca' in dataset).toBe(false)
    expect(almacen.get(CLAVE)).toBe('faro')
  })

  it('si lo guardado es una marca vieja o inventada (de una versión anterior), vuelve a Faro y lo corrige', () => {
    for (const viejo of [
      'bagno',
      'taller',
      'noche',
      'neutra',
      'inventada',
      '',
      'null',
      '{"x":1}',
    ]) {
      const { dataset, almacen } = simularNavegador({ guardado: viejo })
      aplicarMarca()
      expect('marca' in dataset, viejo).toBe(false)
      expect(almacen.get(CLAVE), viejo).toBe('faro')
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
    const primera = simularNavegador()
    aplicarMarca('la-spritzzeria')
    const guardado = primera.almacen.get(CLAVE)
    const segunda = simularNavegador({ guardado })
    aplicarMarca()
    expect(segunda.dataset.marca).toBe('la-spritzzeria')
  })
})

describe('el script de index.html que pinta antes de cargar', () => {
  // Es el mismo valor que lee `aplicarMarca`: si cambia la clave, o lo que acepta, esto avisa.
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''

  function correrScript(guardado: string | null | 'falla') {
    const navegador = simularNavegador({ sinAlmacen: guardado === 'falla' })
    if (guardado !== null && guardado !== 'falla') navegador.almacen.set(CLAVE, guardado)
    const clases = new Set<string>()
    const documentElement = {
      dataset: navegador.dataset,
      classList: { add: (c: string) => clases.add(c) },
    }
    const entorno = {
      localStorage: (globalThis as unknown as { localStorage: object }).localStorage,
      document: { documentElement },
      matchMedia: () => ({ matches: false }),
    }
    new Function('localStorage', 'document', 'matchMedia', script)(
      entorno.localStorage,
      entorno.document,
      entorno.matchMedia,
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
    expect(() => correrScript('falla')).not.toThrow()
  })

  it('una marca guardada que ya no existe se corrige en cuanto arranca la app', () => {
    const navegador = correrScript('bagno')
    // El script la pone tal cual (no conoce la lista)…
    expect(navegador.dataset.marca).toBe('bagno')
    // …y `aplicarMarca()` de main.tsx la devuelve a Faro y limpia lo guardado.
    aplicarMarca()
    expect('marca' in navegador.dataset).toBe(false)
    expect(navegador.almacen.get(CLAVE)).toBe('faro')
  })
})
