// Whether the tab is in view (the Page Visibility API): hidden, the panel neither polls nor keeps
// its live socket open.

export interface Visibility {
  hidden(): boolean
  /** Calls `change` when the tab is shown or hidden; returns how to stop listening. */
  subscribe(change: () => void): () => void
}

export const documentVisibility: Visibility = {
  hidden: () => document.visibilityState === 'hidden',
  subscribe: (change) => {
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  },
}
