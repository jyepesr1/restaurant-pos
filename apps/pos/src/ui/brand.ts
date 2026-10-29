import { useState } from 'react'

// The restaurant's brand over the Faro design system (`data-brand` on <html>, see
// styles.css). It is optional: with no brand, the POS looks like Faro. The admin picks it for the
// whole restaurant and it arrives with the menu (task 1.3c); it is saved here to paint it before
// loading (index.html reads it) and for the mockups, which pick it on the device to compare.

export type Brand = 'faro' | 'la-spritzzeria'

export const BRANDS: readonly { brand: Brand; name: string; description: string }[] = [
  {
    brand: 'faro',
    name: 'Faro',
    description: 'El estilo del sistema: claro, verde azulado, para cualquier restaurante.',
  },
  {
    brand: 'la-spritzzeria',
    name: 'La Spritzzería',
    description: 'Arena y marino de día, la terraza de noche; títulos en League Gothic.',
  },
]
export const DEFAULT_BRAND: Brand = 'faro'
const KEY = 'pos-brand'

export const isBrand = (value: unknown): value is Brand => BRANDS.some((m) => m.brand === value)

function read(): Brand {
  try {
    const saved = localStorage.getItem(KEY)
    return isBrand(saved) ? saved : DEFAULT_BRAND
  } catch {
    return DEFAULT_BRAND
  }
}

/** Sets the brand on the page and remembers it on the device (to paint it before loading). */
export function applyBrand(brand: Brand = read()) {
  if (brand === 'faro') delete document.documentElement.dataset.brand
  else document.documentElement.dataset.brand = brand
  try {
    localStorage.setItem(KEY, brand)
  } catch {
    // No storage: it applies while the page stays open.
  }
}

export function useBrand(): [Brand, (brand: Brand) => void] {
  const [brand, setBrand] = useState<Brand>(read)
  const select = (chosen: Brand) => {
    applyBrand(chosen)
    setBrand(chosen)
  }
  return [brand, select]
}
