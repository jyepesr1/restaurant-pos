import { useEffect, useState } from 'react'

/** The time, refreshed every so often: for running timers (tables, kitchen). */
export function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}
