import { convertMenu, type MenuCategory } from '@pos/core'
import { parse } from 'yaml'

// The menu conversion lives in `@pos/core` (the app mockups use it too); here we only read the
// YAML text.

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

/** Reads the exported menu (YAML text) and converts it into categories and products. */
export const readMenu = (text: string): MenuCategory[] => convertMenu(parse(text))
