import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AlertsAnswer, RegisterAnswer } from './api'
import { EMPTY } from './poller'
import { NO_NEWS_MS, type Polled } from './summary'
import { alertsAnswerOf, registerAnswerOf, rules, summaryOf } from './testing'

// «Caja», «Alertas» and «Alertas de hoy» in the owner's panel (task 1.11c-2), rendered on the
// server (no browser).

vi.mock('../ui/theme', () => ({
  useTheme: () => ({ theme: 'system', dark: false, select: () => {} }),
}))

const { RegisterView } = await import('./PanelRegister')
const { AlertsView, dayName, ALERT_DAYS, DAY_OUT_OF_RANGE, outOfRange } = await import(
  './PanelAlerts'
)
const { DashboardView } = await import('./Dashboard')

/** Without tags and with plain spaces, to read it as text. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const place = { timeZone: 'America/Bogota', rules }

const answered = <T extends { server_now: string }>(data: T): Polled<T> => ({
  data,
  receivedAt: data.server_now,
  failed: false,
  error: null,
  errorKind: null,
})

const register = (polled: Polled<RegisterAnswer>) =>
  text(renderToStaticMarkup(<RegisterView polled={polled} place={place} />))

describe('«Caja»', () => {
  it('while the first answer has not arrived it says it is reading; a failure says so', () => {
    expect(register(EMPTY)).toContain('Leyendo la caja…')
    expect(register({ ...EMPTY, failed: true, error: 'Sin conexión a internet.' })).toContain(
      'Sin conexión a internet. Lo intentamos de nuevo solos cada 15 s.',
    )
  })

  it('each open register: who opened it and when, the expected cash with its breakdown and by method', () => {
    const t = register(answered(registerAnswerOf()))
    expect(t).toContain('Actualizado 9:41 p. m.')
    expect(t).toContain('Cajas abiertas (2)')
    // Opened yesterday: it says the day.
    expect(t).toContain('Abrió Luis · 28 de oct, 6:00 p. m.')
    expect(t).toContain('Abrió Carla · 12:00 p. m.')
    expect(t).toContain('Fondo inicial $100.000')
    expect(t).toContain('Efectivo cobrado (con propinas) +$480.000')
    expect(t).toContain('Salidas -$20.000')
    expect(t).not.toContain('Devoluciones')
    expect(t).toContain('Debería haber en efectivo $560.000')
    expect(t).toMatch(/Efectivo 5 pagos \$450\.000 \+ propina \$30\.000/)
    expect(t).toMatch(/Tarjeta 9 pagos \$800\.000 \+ propina \$82\.000/)
    // The restaurant's own method by its name.
    expect(t).toMatch(/QR Bancolombia 1 pago \$40\.000/)
    // The register opened yesterday has charged nothing yet.
    expect(t).toContain('Sin cobros todavía.')
  })

  it('the registers closed today: counted, the variance and the justification', () => {
    const html = renderToStaticMarkup(
      <RegisterView polled={answered(registerAnswerOf())} place={place} />,
    )
    const t = text(html)
    expect(t).toContain('Cerradas hoy (1)')
    // Two lines: who opened it and who closed it.
    expect(html.replace(/\s/g, ' ')).toMatch(
      /<span>Abrió Carla · 7:00 a\. m\.<\/span><span>Cerró Luis · 5:00 p\. m\.<\/span>/,
    )
    expect(t).toContain('Descuadre de $1.000 o más')
    expect(t).toMatch(/Efectivo esperado \$300\.000 Contado \$295\.000/)
    expect(t).toMatch(/Efectivo Faltan \$5\.000/)
    expect(t).toMatch(
      /Nequi Según el sistema \$80\.000 · según su cierre \$78\.000 Faltan \$2\.000/,
    )
    expect(t).toContain('Justificación: Se dio mal un cambio')
  })

  it('a variance under the threshold is not «grande»; nothing open or closed is said plainly', () => {
    const answer = registerAnswerOf({ threshold: 10_000 })
    expect(register(answered(answer))).not.toContain('o más')
    // Exactly the threshold is large: it counts from it, never «mayor a».
    expect(register(answered(registerAnswerOf({ threshold: 5_000 })))).toContain(
      'Descuadre de $5.000 o más',
    )
    const empty = register(answered(registerAnswerOf({ open: [], closed: [] })))
    expect(empty).toContain('No hay cajas abiertas ahora.')
    expect(empty).toContain('Ninguna caja se ha cerrado hoy.')
  })

  it('without news from the restaurant it says since when', () => {
    const answer = registerAnswerOf()
    const late = new Date(Date.parse(answer.server_now) + NO_NEWS_MS + 60_000).toISOString()
    expect(register(answered({ ...answer, server_now: late }))).toContain(
      'Sin noticias del restaurante desde las 9:41 p. m.',
    )
  })
})

const alertsOf = (
  polled: Polled<AlertsAnswer>,
  day: string | null = null,
  initialKind: Parameters<typeof AlertsView>[0]['initialKind'] = null,
) =>
  renderToStaticMarkup(
    <AlertsView
      polled={polled}
      place={place}
      day={day}
      onDay={() => {}}
      initialKind={initialKind}
    />,
  )

describe('«Alertas»', () => {
  it('while the first answer has not arrived it says it is reading; a failure says so', () => {
    expect(text(alertsOf(EMPTY))).toContain('Leyendo las alertas…')
    expect(text(alertsOf({ ...EMPTY, failed: true, error: 'Sin conexión a internet.' }))).toContain(
      'Sin conexión a internet. Lo intentamos de nuevo solos cada 15 s.',
    )
  })

  it('one sentence per alert, from the newest, with its time and details', () => {
    const t = text(alertsOf(answered(alertsAnswerOf())))
    const sentences = [
      'En la caja de Carla faltaron $5.000 en efectivo',
      'Luis reabrió la cuenta de la Mesa 3, que había cerrado en $61.800',
      'Carla devolvió $12.000 en QR Bancolombia de la Mesa 3',
      'Carla anuló un pago en efectivo ($44.900) en la Mesa 3',
      'Ana dio de cortesía 1 Pinsa ($20.900) en la Mesa 3',
      'Ana canceló el pedido Para llevar #13 ($12.000)',
      'Ana anuló 1 Pinsa ($20.900) en la Mesa 3',
    ]
    const positions = sentences.map((s) => t.indexOf(s))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(t).toContain(
      'Ana anuló 1 Pinsa ($20.900) en la Mesa 3 8:30 p. m. Anulación autorizó Luis · ya estaba preparado · Motivo: Se quemó',
    )
  })

  it('a legend says what the colors mean, and each row says its kind in words', () => {
    const html = alertsOf(answered(alertsAnswerOf()))
    const t = text(html)
    expect(t).toContain('Rojo: salió dinero o la caja no cuadró')
    expect(t).toContain('Ámbar: para revisar')
    for (const label of [
      'Descuadre',
      'Cuenta reabierta',
      'Devolución',
      'Pago anulado',
      'Cortesía',
      'Cancelación',
      'Anulación',
    ])
      expect(t).toContain(`${label} `)
    // The courtesy and the reopening in amber; the void in red.
    expect(html).toMatch(/bg-progress-soft[^>]*>Cortesía</)
    expect(html).toMatch(/bg-progress-soft[^>]*>Cuenta reabierta</)
    expect(html).toMatch(/bg-alert-soft[^>]*>Anulación</)
  })

  it('the filters by kind, with how many of each; only the kinds there are', () => {
    const html = alertsOf(answered(alertsAnswerOf()))
    const t = text(html)
    expect(t).toContain('Todas (7)')
    expect(t).toContain('Productos anulados (1)')
    expect(t).toContain('Descuadres de caja (1)')
    const few = text(
      alertsOf(answered(alertsAnswerOf({ alerts: alertsAnswerOf().alerts.slice(-1) }))),
    )
    expect(few).toContain('Todas (1)')
    expect(few).not.toContain('Descuadres de caja')
  })

  it('a kind chosen shows only those', () => {
    const t = text(alertsOf(answered(alertsAnswerOf()), null, 'register_variance'))
    expect(t).toContain('faltaron $5.000')
    expect(t).not.toContain('anuló 1 Pinsa')
    expect(alertsOf(answered(alertsAnswerOf()), null, 'register_variance')).toMatch(
      /aria-pressed="true"(?:(?!<\/button>).)*Descuadres de caja \(1\)/,
    )
  })

  it('the day: today, yesterday and back to 14 days, as a list', () => {
    const html = alertsOf(answered(alertsAnswerOf()))
    expect((html.match(/<option /g) ?? []).length).toBe(ALERT_DAYS + 1)
    expect(text(html)).toMatch(/Hoy Ayer martes 27 de oct/)
    expect(html).toContain('<option value="2026-10-15">')
    expect(dayName('2026-10-29', '2026-10-29')).toBe('Hoy')
    expect(dayName('2026-10-28', '2026-10-29')).toBe('Ayer')
    expect(dayName('2026-10-22', '2026-10-29')).toBe('jueves 22 de oct')
  })

  it('a kind with none says «hoy» for today and «ese día» for another day', () => {
    const one = alertsAnswerOf({ alerts: alertsAnswerOf().alerts.slice(-1) })
    expect(text(alertsOf(answered(one), null, 'refund'))).toContain('Sin devoluciones hoy.')
    const yesterday = { ...one, day: '2026-10-28' }
    expect(text(alertsOf(answered(yesterday), '2026-10-28', 'refund'))).toContain(
      'Sin devoluciones ese día.',
    )
  })

  it('a day the cloud no longer answers (400) goes back to today, saying why', () => {
    const invalid = { ...EMPTY, failed: true, error: 'x', errorKind: 'invalid' }
    expect(outOfRange(invalid, '2026-10-01')).toBe(true)
    // Today, or another failure, is not a matter of the day: it keeps trying.
    expect(outOfRange(invalid, null)).toBe(false)
    expect(outOfRange({ ...invalid, errorKind: 'offline' }, '2026-10-01')).toBe(false)
    expect(outOfRange({ ...EMPTY }, '2026-10-01')).toBe(false)
    const t = text(
      renderToStaticMarkup(
        <AlertsView
          polled={answered(alertsAnswerOf())}
          place={place}
          day={null}
          onDay={() => {}}
          notice={DAY_OUT_OF_RANGE}
        />,
      ),
    )
    expect(t).toContain(
      `Ese día ya no está entre los últimos ${ALERT_DAYS}: te mostramos las de hoy.`,
    )
    expect(t).toContain('Ana anuló 1 Pinsa')
  })

  it('without alerts it says so, for today and for another day', () => {
    expect(text(alertsOf(answered(alertsAnswerOf({ alerts: [] }))))).toContain(
      'Sin alertas hoy por ahora.',
    )
    const yesterday = alertsAnswerOf({ alerts: [], day: '2026-10-28' })
    expect(text(alertsOf(answered(yesterday), '2026-10-28'))).toContain('Sin alertas ese día.')
  })

  it('while the chosen day’s answer arrives it does not show another day’s alerts', () => {
    const t = text(alertsOf(answered(alertsAnswerOf()), '2026-10-27'))
    expect(t).toContain('Leyendo las alertas…')
    expect(t).not.toContain('anuló 1 Pinsa')
  })
})

describe('«Alertas de hoy» on the dashboard', () => {
  const dashboard = (alerts: number | undefined) =>
    text(
      renderToStaticMarkup(
        <DashboardView polled={answered(summaryOf({ alerts }))} place={place} />,
      ),
    )

  it('how many there are, and a tap goes to «Alertas»', () => {
    expect(dashboard(3)).toContain('Alertas de hoy: 3')
    expect(dashboard(3)).toContain('Anulaciones, descuentos, devoluciones y descuadres')
    expect(dashboard(3)).toContain('Ver las alertas')
    expect(dashboard(0)).toContain('Sin alertas hoy')
    // A cloud that does not send it yet: no card.
    expect(dashboard(undefined)).not.toContain('alertas')
  })
})
