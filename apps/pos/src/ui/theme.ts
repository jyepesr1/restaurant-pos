import { useEffect, useState } from 'react'

// Light or dark mode (brief §5: dark mode for the bar and at night). By default it follows the
// system; if the person picks one, it is remembered on this device. index.html applies the same
// before painting.

export type Theme = 'system' | 'light' | 'dark'

const KEY = 'pos-theme'
const query = () => window.matchMedia('(prefers-color-scheme: dark)')

function read(): Theme {
  try {
    const saved = localStorage.getItem(KEY)
    return saved === 'light' || saved === 'dark' ? saved : 'system'
  } catch {
    return 'system'
  }
}

const resolve = (theme: Theme, systemDark: boolean) =>
  theme === 'dark' || (theme === 'system' && systemDark)

/** Adds or removes the `dark` class on <html>. */
export function applyTheme(theme: Theme = read()) {
  document.documentElement.classList.toggle('dark', resolve(theme, query().matches))
}

/** The chosen theme, whether the screen is dark right now, and how to change it. */
export function useTheme(): { theme: Theme; dark: boolean; select: (theme: Theme) => void } {
  const [theme, setTheme] = useState<Theme>(read)
  const [systemDark, setSystemDark] = useState(() => query().matches)

  useEffect(() => {
    const media = query()
    const change = () => setSystemDark(media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])

  const dark = resolve(theme, systemDark)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  const select = (fresh: Theme) => {
    try {
      if (fresh === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, fresh)
    } catch {
      // No storage (private mode): it only lasts while the page is open.
    }
    setTheme(fresh)
  }
  return { theme, dark, select }
}
