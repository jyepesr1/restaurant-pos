/**
 * Día operativo de un instante (docs/MODELO_DATOS.md#configuración-del-restaurante): antes de la
 * hora de inicio cuenta para el día anterior. Con inicio "06:00" en Bogotá, la 1 a. m. del 24 es
 * del día 23.
 */
export function diaOperativo(instanteIso: string, zonaHoraria: string, inicio = '06:00'): string {
  const fecha = new Date(instanteIso)
  if (Number.isNaN(fecha.getTime())) throw new RangeError(`Instante inválido: ${instanteIso}`)
  const [horaInicio = 0, minutoInicio = 0] = inicio.split(':').map(Number)

  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zonaHoraria,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(fecha)
      .map((p) => [p.type, p.value]),
  )
  const antesDelInicio =
    Number(partes.hour) * 60 + Number(partes.minute) < horaInicio * 60 + minutoInicio
  const dia = new Date(Date.UTC(Number(partes.year), Number(partes.month) - 1, Number(partes.day)))
  if (antesDelInicio) dia.setUTCDate(dia.getUTCDate() - 1)
  return dia.toISOString().slice(0, 10)
}
