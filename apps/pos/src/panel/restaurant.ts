// Which restaurant the panel signs in to (docs/PANEL.md): the slug is remembered on this phone and
// the address `/r/<slug>` leaves it written in. Storage may be missing (private mode): then it is
// only asked again.

const KEY = 'faro-panel:restaurant'

/** The slug of `/r/<slug>`, in lowercase; null for any other address. */
export function slugFromPath(path: string): string | null {
  const match = /^\/r\/([^/]+)\/?$/.exec(path)
  if (!match?.[1]) return null
  let slug: string
  try {
    slug = decodeURIComponent(match[1])
  } catch {
    return null
  }
  const clean = cleanSlug(slug)
  return clean || null
}

/** What was typed, as a slug: «La Spritzzería » → «la-spritzzeria». */
export function cleanSlug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

export function rememberedRestaurant(): string {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

export function rememberRestaurant(slug: string) {
  try {
    localStorage.setItem(KEY, slug)
  } catch {
    // Without storage it is asked again next time.
  }
}
