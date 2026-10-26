/**
 * Business day of an instant (docs/MODELO_DATOS.md#configuración-del-restaurante): before the
 * start time it counts toward the previous day. With start "06:00" in Bogotá, 1 a.m. on the 24th
 * belongs to the 23rd.
 */
export function businessDay(isoInstant: string, timeZone: string, start = '06:00'): string {
  const date = new Date(isoInstant)
  if (Number.isNaN(date.getTime())) throw new RangeError(`Instante inválido: ${isoInstant}`)
  const [startHour = 0, startMinute = 0] = start.split(':').map(Number)

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  )
  const beforeStart = Number(parts.hour) * 60 + Number(parts.minute) < startHour * 60 + startMinute
  const day = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)))
  if (beforeStart) day.setUTCDate(day.getUTCDate() - 1)
  return day.toISOString().slice(0, 10)
}
