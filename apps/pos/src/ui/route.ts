import { useEffect, useState } from 'react'

// Minimal navigation without reloading the page (a full router is not needed yet).

const NAV_EVENT = 'pos-navigate'

const currentRoute = () => location.pathname.replace(/\/+$/, '') || '/'

export function navigate(target: string) {
  if (target === location.pathname + location.search) return
  history.pushState(null, '', target)
  window.dispatchEvent(new Event(NAV_EVENT))
}

/** The path (no trailing `/`) and its parameters; it also changes if only the parameters change. */
export function useRoute(): { route: string; params: URLSearchParams } {
  const [current, setCurrent] = useState(() => ({
    route: currentRoute(),
    searchQuery: location.search,
  }))
  useEffect(() => {
    const update = () => setCurrent({ route: currentRoute(), searchQuery: location.search })
    window.addEventListener('popstate', update)
    window.addEventListener(NAV_EVENT, update)
    return () => {
      window.removeEventListener('popstate', update)
      window.removeEventListener(NAV_EVENT, update)
    }
  }, [])
  return { route: current.route, params: new URLSearchParams(current.searchQuery) }
}
