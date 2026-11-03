import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../ui/toasts'
import { EMPTY } from './poller'
import type { Polled } from './summary'
import { me, periodReportOf, rules, summaryOf } from './testing'

// The owner's panel screens (task 1.11c-1), rendered on the server (no browser): what the
// dashboard says in each state, «Entrar», the frame and the reports without the Z reprint.

vi.mock('../ui/theme', () => ({
  useTheme: () => ({ theme: 'system', dark: false, select: () => {} }),
}))

const { DashboardView } = await import('./Dashboard')
const { NoPermission, Offline, canViewReports } = await import('./PanelApp')
const { PanelSignIn, PERMISSION_HINT } = await import('./PanelSignIn')
const { PanelFrame } = await import('./PanelFrame')
const { ReportContent, shortcutsFor, tooLongMessage } = await import('../floor/ReportsView')
const { daysIn } = await import('../floor/periods')
const { PANEL_MAX_DAYS, PanelReports } = await import('./PanelReports')
const { rulesOf } = await import('./api')

/** Without tags and with plain spaces, to read it as text. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

const place: { timeZone: string; rules: typeof rules | null } = {
  timeZone: 'America/Bogota',
  rules,
}
const dashboard = (polled: Polled<ReturnType<typeof summaryOf>>, where = place) =>
  text(renderToStaticMarkup(<DashboardView polled={polled} place={where} />))
const answered = (summary = summaryOf()) => ({
  data: summary,
  receivedAt: summary.server_now,
  failed: false,
  error: null,
})

afterEach(() => vi.unstubAllGlobals())

describe('the dashboard', () => {
  it('while the first answer has not arrived it says it is reading', () => {
    expect(dashboard(EMPTY)).toContain('Leyendo las ventas…')
  })

  it('today in whole pesos, against last week with an arrow and the percentage', () => {
    const page = renderToStaticMarkup(<DashboardView polled={answered()} place={place} />)
    const t = text(page)
    expect(t).toContain('$1.250.000')
    expect(t).toContain('Ventas hasta ahora')
    expect(t).toContain('+25 % frente al jueves pasado a esta hora')
    expect(t).toContain('El jueves pasado, a esta hora: $1.000.000 · ese día cerró en $1.800.000')
    expect(t).toContain('Ticket promedio')
    expect(t).toContain('$89.286')
    // The secondary figures with their own difference: 31 against 25 guests.
    expect(t).toContain('El jueves pasado, a esta hora: 25 +24 %')
    expect(t).toContain('Actualizado 9:41 p. m.')
    expect(t).toContain('Comensales 31')
    expect(t).toContain('Propinas $112.000')
    expect(t).toContain('Cuentas cerradas 14')
    expect(t).toMatch(/jueves,? 29 de octubre de 2026/)
    // The arrow goes with the percentage: never color alone.
    expect(page).toContain('M12 19V5')
  })

  it('by payment method, with its payments and tips', () => {
    const t = dashboard(answered())
    expect(t).toContain('Efectivo 5 pagos $450.000 + propina $30.000')
    expect(t).toMatch(/Tarjeta[^$]*9 pagos \$800\.000/)
  })

  it('names the restaurant own payment methods; without its rules, the generic name', () => {
    const s = summaryOf()
    s.report.byMethod = [
      { method: 'other', customMethodId: 'qr', sale: 30_000, tip: 0, payments: 1 },
    ]
    expect(dashboard(answered(s))).toContain('QR Bancolombia')
    expect(dashboard(answered(s), { ...place, rules: null })).not.toContain('QR Bancolombia')
  })

  it('the times go in the restaurant time zone', () => {
    expect(dashboard(answered(), { ...place, timeZone: 'America/Mexico_City' })).toMatch(
      /Actualizado 8:41 p\. m\./,
    )
  })

  it('without sales last week it gives no percentage (no division by zero)', () => {
    const s = summaryOf()
    s.last_week.report_until_now.sales.net = 0
    const t = dashboard(answered(s))
    expect(t).toContain('Ese jueves a esta hora no había ventas')
    expect(t).not.toContain('Infinity')
    expect(t).not.toContain('NaN')
  })

  it('says when it was updated and what the local still has to send', () => {
    const t = dashboard(answered(summaryOf({ local: { ...summaryOf().local, pending: 3 } })))
    expect(t).toMatch(/Actualizado 9:41 p\. m\./)
    expect(t).toContain('Faltan 3 datos del local por llegar')
  })

  it('a fall goes with its arrow, not in red', () => {
    const s = summaryOf()
    s.report.sales.net = 800_000
    const page = renderToStaticMarkup(<DashboardView polled={answered(s)} place={place} />)
    expect(text(page)).toContain('-20 % frente al jueves pasado a esta hora')
    expect(page).toContain('M12 5v14')
    expect(page).toMatch(/bg-neutral-soft[^>]*><svg(?:(?!<\/span>).)*<\/svg>-20 %/)
  })

  it('without news from the restaurant for over 2 minutes it says so and dates the figures', () => {
    const s = summaryOf({
      server_now: '2026-10-30T02:45:00.000Z',
      local: { last_seen_at: '2026-10-30T02:38:00.000Z', last_event_at: null, pending: 5 },
    })
    const page = renderToStaticMarkup(<DashboardView polled={answered(s)} place={place} />)
    const t = text(page)
    expect(t).toMatch(/Sin noticias del restaurante desde las 9:38 p\. m\./)
    expect(t).toMatch(
      /Puede que la caja esté apagada o sin internet\. Las cifras son de las 9:38 p\. m\./,
    )
    expect(t).toMatch(/Ventas hasta las 9:38 p\. m\./)
    expect(t).not.toContain('por llegar')
    expect(page).toContain('bg-alert-soft')
  })

  it('when the cloud stops answering it keeps the numbers and says from when they are', () => {
    const t = dashboard({ ...answered(), failed: true, error: 'Sin conexión a internet.' })
    expect(t).toMatch(
      /Sin conexión a internet: no llegan datos del restaurante Las cifras son de las 9:41 p\. m\./,
    )
    expect(t).toMatch(/Ventas hasta las 9:41 p\. m\./)
    expect(t).toContain('$1.250.000')
  })

  it('a closed session or a server error is not «sin conexión a internet»', () => {
    for (const errorKind of ['unauthorized', 'server']) {
      const t = dashboard({ ...answered(), failed: true, error: 'x', errorKind })
      expect(t).not.toContain('Sin conexión a internet')
      expect(t).toMatch(/No se pudo actualizar Las cifras son de las 9:41 p\. m\./)
    }
    const offline = dashboard({ ...answered(), failed: true, error: 'x', errorKind: 'offline' })
    expect(offline).toContain('Sin conexión a internet')
  })

  it('failing before any answer it explains and says it keeps trying, only once', () => {
    const t = dashboard({ ...EMPTY, failed: true, error: 'Sin conexión a internet.' })
    expect(t).toContain('Sin conexión a internet. Lo intentamos de nuevo solos cada 15 s.')
    // The status line is not shown too: the notice is said once.
    expect(t.match(/Sin conexión a internet/g)).toHaveLength(1)
    // Without a way to ask again (a test's answer) there is no button.
    expect(t).not.toContain('Intentar ahora')
  })

  it('«Intentar ahora» asks again at once, before the first answer and after a failure', () => {
    const retry = vi.fn()
    const first = renderToStaticMarkup(
      <DashboardView
        polled={{ ...EMPTY, failed: true, error: 'Sin conexión a internet.', retry }}
        place={place}
      />,
    )
    expect(text(first)).toContain('Intentar ahora')
    // A button of the design system: 48 px at least.
    expect(first).toMatch(/<button[^>]*min-h-12[^>]*>(?:(?!<\/button>).)*Intentar ahora/)
    const later = dashboard({ ...answered(), failed: true, error: 'x', retry })
    expect(later).toContain('Intentar ahora')
    // Up to date, there is nothing to try.
    expect(dashboard({ ...answered(), retry })).not.toContain('Intentar ahora')
  })

  it('reading for more than 5 s says it is taking longer than usual', async () => {
    const { FirstAnswer, SLOW_READ_MS } = await import('./DataStatus')
    expect(SLOW_READ_MS).toBe(5000)
    const slow = text(
      renderToStaticMarkup(
        <FirstAnswer polled={EMPTY} reading="Leyendo las ventas…" failure="x" slow />,
      ),
    )
    expect(slow).toContain('Leyendo las ventas… Tarda más de lo normal')
    expect(dashboard(EMPTY)).not.toContain('Tarda más de lo normal')
  })

  it('announces only the state (a hidden live region), not the visible time', () => {
    const page = renderToStaticMarkup(<DashboardView polled={answered()} place={place} />)
    expect(page).toMatch(/<p aria-live="polite" class="sr-only">Cifras al día<\/p>/)
    expect(page.match(/aria-live/g)).toHaveLength(1)
  })

  it('a day with no closed checks says so', () => {
    const s = summaryOf()
    s.report = { ...s.report, byMethod: [], sales: { ...s.report.sales, net: 0, checks: 0 } }
    expect(dashboard(answered(s))).toContain('Todavía no hay cuentas cerradas hoy.')
  })
})

describe('permissions', () => {
  it('the dashboard and the reports ask for «Ver todos los reportes»', () => {
    expect(canViewReports(me())).toBe(true)
    expect(canViewReports(me(['remote_access']))).toBe(false)
    const t = text(renderToStaticMarkup(<NoPermission />))
    expect(t).toContain('Tu rol no puede ver esta sección')
    expect(t).toContain('«Ver todos los reportes»')
  })
})

describe('opening without internet', () => {
  it('says it and offers «Reintentar»', () => {
    const t = text(
      renderToStaticMarkup(<Offline message="Sin conexión a internet." onRetry={() => {}} />),
    )
    expect(t).toContain('Sin conexión a internet.')
    expect(t).toContain('Reintentar')
  })
})

describe('«Entrar»', () => {
  const signIn = (notice: string | null = null) =>
    renderToStaticMarkup(
      <PanelSignIn api={{ signIn: async () => me() }} notice={notice} onSignedIn={() => {}} />,
    )

  it('asks for restaurant, user and password, with what the browser needs to fill them in', () => {
    const page = signIn()
    expect(text(page)).toContain('Restaurante')
    expect(page).toContain('autoComplete="username"')
    expect(page).toContain('autoComplete="current-password"')
    expect(page).toContain('type="password"')
    expect(page).not.toContain('Tu sesión se cerró')
  })

  it('the restaurant goes by its name, with its help outside the label', () => {
    const page = signIn()
    expect(page).toContain('placeholder="Ej.: La Spritzzería"')
    expect(page).toMatch(
      /<\/label><p id="panel-restaurant-help"[^>]*>El nombre de tu restaurante, como lo ves en la caja\.<\/p>/,
    )
  })

  it('the password can be shown, and the permission hint waits for a failed attempt', () => {
    const page = signIn()
    expect(page).toMatch(/aria-pressed="false"[^>]*>Mostrar<\/button>/)
    expect(text(page)).not.toContain(PERMISSION_HINT)
    expect(PERMISSION_HINT).toBe(
      'Si la contraseña es la de la caja, pide al administrador el permiso «Entrar desde fuera del local».',
    )
  })

  it('the notice of a closed session is a status, and the title can take the focus', () => {
    const page = signIn('Tu sesión se cerró. Entra de nuevo.')
    expect(page).toMatch(/role="status"[^>]*>.*Tu sesión se cerró/)
    expect(page).toMatch(/<h1 id="panel-sign-in-title" tabindex="-1"/)
  })

  it('the remembered restaurant comes written in', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'la-spritzzeria', setItem: () => {} })
    expect(signIn()).toContain('value="la-spritzzeria"')
  })

  it('shows why it is back at «Entrar»', () => {
    expect(text(signIn('Tu sesión se cerró. Entra de nuevo.'))).toContain(
      'Tu sesión se cerró. Entra de nuevo.',
    )
  })
})

describe('the frame', () => {
  it('names the restaurant and the person, the sections and «Salir»', () => {
    const page = renderToStaticMarkup(
      <PanelFrame me={me()} route="/reports" title="Reportes" onSignOut={() => {}}>
        contenido
      </PanelFrame>,
    )
    const t = text(page)
    expect(t).toContain('La Spritzzería')
    expect(t).toContain('Ana Gómez')
    expect(t).toContain('Hoy')
    expect(t).toContain('Salir')
    // «Salir» is visible text also on the phone, not only for screen readers.
    expect(page).not.toMatch(/sr-only[^>]*>Salir/)
    expect(page).toMatch(/aria-current="page"[^>]*>.*?Reportes/)
  })
})

describe('the restaurant brand', () => {
  const frame = (brand: string | null) =>
    renderToStaticMarkup(
      <PanelFrame me={me(undefined, { brand })} route="/" title="Tablero" onSignOut={() => {}}>
        x
      </PanelFrame>,
    )
  it('shows the restaurant logo with its brand, Faro with none', () => {
    expect(frame('la-spritzzeria')).toContain('/brand/la-spritzzeria.svg')
    expect(frame(null)).not.toContain('/brand/la-spritzzeria.svg')
  })
})

describe('the reports in the panel', () => {
  const closing = {
    shiftId: 's1',
    businessDay: '2026-10-29',
    openedAt: '2026-10-29T16:00:00.000Z',
    openedBy: 'ana',
    closedBy: 'ana',
    base: 200_000,
    byMethod: [],
    closed: {
      time: '2026-10-30T04:00:00.000Z',
      expected: 650_000,
      counted: 650_000,
      variance: 0,
      otherMethods: [],
      justification: null,
    },
  } as unknown as ReturnType<typeof periodReportOf>['closings'][number]
  const content = (reprint?: { onReprint: () => Promise<void>; canSelectPrinter: boolean }) =>
    text(
      renderToStaticMarkup(
        <ToastProvider>
          <ReportContent
            report={periodReportOf({ closings: [closing], printer: true })}
            period={{ from: '2026-10-29', until: '2026-10-29' }}
            loading={false}
            rules={null}
            reprint={reprint}
          />
        </ToastProvider>,
      ),
    )

  it('show the register closes without reprinting the Z report', () => {
    const t = content()
    expect(t).toContain('Cierres de caja')
    expect(t).toContain('Cuadra')
    expect(t).not.toContain('Reimprimir')
    expect(t).not.toContain('impresora')
  })

  it('the register keeps its reprint', () => {
    expect(content({ onReprint: async () => {}, canSelectPrinter: true })).toContain(
      'Reimprimir cierre',
    )
  })

  it('14 days at most, counted with both ends', () => {
    expect(PANEL_MAX_DAYS).toBe(14)
    expect(daysIn({ from: '2026-10-16', until: '2026-10-29' })).toBe(14)
    expect(daysIn({ from: '2026-10-15', until: '2026-10-29' })).toBe(15)
    expect(daysIn({ from: '2026-10-29', until: '2026-10-29' })).toBe(1)
    expect(tooLongMessage(PANEL_MAX_DAYS)).toBe('Elige un período de 14 días o menos.')
  })

  it('show the months disabled in the panel, saying why; the register has them all', () => {
    const off = (max: number) =>
      shortcutsFor(max)
        .filter((x) => x.disabled)
        .map((x) => x.name)
    expect(off(PANEL_MAX_DAYS)).toEqual(['Este mes', 'Mes pasado'])
    expect(off(62)).toEqual([])
    const state = {
      shortcut: 'today' as const,
      select: () => {},
      requested: null,
      shown: null,
      loading: true,
      error: null,
      load: () => {},
    }
    const html = renderToStaticMarkup(<PanelReports state={state} rules={null} />)
    expect(text(html)).toContain('Los períodos de más de 14 días llegan pronto.')
    const button = (name: string) =>
      html.split('<button').find((b) => b.includes(`>${name}<`)) ?? ''
    for (const name of ['Este mes', 'Mes pasado']) {
      expect(button(name)).toContain('disabled=""')
      expect(button(name)).toContain('aria-describedby="reports-long-periods"')
    }
    expect(button('Últimos 7 días')).not.toContain('disabled=""')
  })

  it('name the restaurant own payment methods, also the archived ones', () => {
    const report = periodReportOf()
    report.report.byMethod = [
      { method: 'other', customMethodId: 'qr', sale: 30_000, tip: 0, payments: 1 },
      { method: 'other', customMethodId: 'sodexo', sale: 20_000, tip: 0, payments: 1 },
    ]
    const t = text(
      renderToStaticMarkup(
        <ToastProvider>
          <ReportContent
            report={report}
            period={{ from: '2026-10-29', until: '2026-10-29' }}
            loading={false}
            rules={rulesOf(me())}
          />
        </ToastProvider>,
      ),
    )
    expect(t).toContain('QR Bancolombia')
    expect(t).toContain('Sodexo')
  })
})
