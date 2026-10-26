import { convertMenu, type MenuCategory } from '@pos/core'
import { parse } from 'yaml'

// La conversión de la carta vive en `@pos/core` (la usan también los bocetos de la app); aquí
// solo se lee el texto YAML.

export {
  DONENESS,
  type MenuCategory,
  type MenuGroup,
  type MenuProduct,
  rulesWithoutDish,
  type Station,
  WITH_DONENESS,
  WITH_FLAVOR,
} from '@pos/core'

/** Lee la carta exportada (texto YAML) y la convierte en categorías y productos. */
export const leerCarta = (text: string): MenuCategory[] => convertMenu(parse(text))
