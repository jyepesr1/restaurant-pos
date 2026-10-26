import { useEffect, useState } from 'react'

/** La hora, al día cada tanto: para los tiempos que cuentan (mesas, cocina). */
export function useAhora(cadaMs = 30_000) {
  const [now, setAhora] = useState(Date.now)
  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), cadaMs)
    return () => clearInterval(t)
  }, [cadaMs])
  return now
}
