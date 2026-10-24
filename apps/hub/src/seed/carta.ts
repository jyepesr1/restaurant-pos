import { type CategoriaCarta, convertirCarta } from '@pos/core'
import { parse } from 'yaml'

// La conversión de la carta vive en `@pos/core` (la usan también los bocetos de la app); aquí
// solo se lee el texto YAML.

export {
  type CategoriaCarta,
  CON_SABOR,
  CON_TERMINO,
  type Estacion,
  type GrupoCarta,
  type ProductoCarta,
  reglasSinPlato,
  TERMINO,
} from '@pos/core'

/** Lee la carta exportada (texto YAML) y la convierte en categorías y productos. */
export const leerCarta = (texto: string): CategoriaCarta[] => convertirCarta(parse(texto))
