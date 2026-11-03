import type { Alert, OrderState, Report, ShiftReconciliation } from '@pos/core'
import type { Catalog } from '@pos/sync'
import type { CheckoutRules } from '../floor/checks'
import type { PeriodReport, ReportClose } from '../floor/engine'
import type { Period } from '../floor/periods'

// Calls from the owner's panel to the cloud (docs/PANEL.md, task 1.11c). The session travels in an
// HttpOnly cookie that this code never sees: every call goes with `credentials: 'same-origin'`.

/** Who signed in and to which restaurant (`Me` in docs/PANEL.md). */
export interface Me {
  user: { id: string; name: string; permissions: string[] }
  restaurant: {
    id: string
    name: string
    slug: string
    /** The restaurant's time zone (the cloud says America/Bogota while it does not know it). */
    time_zone: string
    /** The restaurant's brand (`catalog.restaurant.brand`); null is Faro's. */
    brand: string | null
    /** The checkout rules of the menu: they name the restaurant's own payment methods. */
    payment_methods: CheckoutRules | null
  }
}

/**
 * The rules the reports use: the payment methods, with the time zone the cloud says. Without the
 * menu's rules there are none, and the screens use their defaults.
 */
export const rulesOf = (me: Me): CheckoutRules | null =>
  me.restaurant.payment_methods
    ? { ...me.restaurant.payment_methods, timeZone: me.restaurant.time_zone }
    : null

/** The day's dashboard (`GET /v1/panel/summary`). */
export interface Summary {
  server_now: string
  /** Today's business day (YYYY-MM-DD). */
  today: string
  /** Today up to now. */
  report: Report
  last_week: {
    /** The same weekday a week ago. */
    day: string
    /** That day up to the same time as now. */
    report_until_now: Report
    /** That whole day. */
    report_full: Report
  }
  /** Names by id. */
  users: Record<string, string>
  local: {
    /** When the hub last asked the cloud (every 30 s while it is up to date). */
    last_seen_at: string | null
    /** The time of the latest event the cloud received. */
    last_event_at: string | null
    /** Changes the hub has that the cloud has not received yet; null if it is not known. */
    pending: number | null
  }
  /** «Mesas abiertas»: what is open right now (task 1.11c-2). */
  open?: {
    /** Open orders that count (not one emptied by moving everything to another table). */
    orders: number
    /** Tables they occupy, merged ones too. */
    tables: number
    guests: number
    /** Net of those orders, without tips. */
    total: number
  }
  /** How many alerts today has (task 1.11c-2). */
  alerts?: number
}

/** The floor plan the cloud sends (from the hub's catalog). */
export type FloorPlan = Pick<Catalog, 'zones' | 'tables' | 'elements' | 'stations'>

/** A kitchen card as the cloud sends it: its order travels in `orders`. */
export interface LiveTicket {
  key: string
  ticket_id: string
  order_id: string
  station_id: string
  number: number | null
  sent_at: string
  item_ids: string[]
  /** Everything still pending is ready to take to the table. */
  ready: boolean
}

/** The floor and the kitchen right now (`GET /v1/panel/floor`, task 1.11c-2). */
export interface LiveFloor {
  server_now: string
  today: string
  /** The latest receipt time among the events behind the answer. */
  as_of: string | null
  local: Summary['local']
  /** The version of the plan; it travels again only when it changes. */
  plan_version: string | null
  /** Null when the panel already has `plan_version` (or there is no catalog yet). */
  plan: FloorPlan | null
  /** Minutes since sending after which a ticket is late and very late. */
  timers: { yellow: number; red: number }
  /** The open orders. */
  orders: OrderState[]
  tickets: LiveTicket[]
  /** Names by id: waiters and whoever added each item. */
  users: Record<string, string>
}

/** A register open right now: who opened it, when, and how it goes (task 1.11c-2). */
export interface OpenRegister {
  shift_id: string
  /** The register device (the cloud does not know its name). */
  register_id: string
  opened_at: string
  opened_by: string
  /** As the hub computes it: base, charged by method, movements and the cash there should be. */
  reconciliation: ShiftReconciliation
}

/** The registers (`GET /v1/panel/register`, task 1.11c-2). */
export interface RegisterAnswer {
  server_now: string
  today: string
  as_of: string | null
  local: Summary['local']
  /** From how many pesos a variance needs a justification. */
  threshold: number
  open: OpenRegister[]
  /** Today's closes, as the reports list them. */
  closed: ReportClose[]
  users: Record<string, string>
}

/** The alerts of a day (`GET /v1/panel/alerts`, task 1.11c-2). */
export interface AlertsAnswer {
  server_now: string
  today: string
  /** The business day of the alerts. */
  day: string
  as_of: string | null
  local: Summary['local']
  threshold: number
  /** From the newest to the oldest. */
  alerts: Alert[]
  users: Record<string, string>
  /** Table names by id. */
  tables: Record<string, string>
}

export type PanelErrorKind =
  | 'unauthorized'
  | 'rate_limited'
  | 'forbidden'
  | 'invalid'
  | 'offline'
  | 'server'

export class PanelError extends Error {
  readonly kind: PanelErrorKind
  readonly status: number
  /** How long to wait before trying again (429, or a failed sign-in that the cloud slows down). */
  readonly waitMs: number

  constructor(kind: PanelErrorKind, message: string, status = 0, waitMs = 0) {
    super(message)
    this.kind = kind
    this.status = status
    this.waitMs = waitMs
  }
}

export const OFFLINE = 'Sin conexión a internet. Revisa el internet de tu celular o computador.'
/** The same for any failure at sign-in: it does not tell which of the three was wrong. */
export const WRONG_CREDENTIALS = 'Revisa el restaurante, el usuario y la contraseña'
export const WRONG_ORIGIN = 'No se pudo entrar desde esta dirección. Avisa a Faro.'
export const SESSION_CLOSED = 'Tu sesión se cerró. Entra de nuevo.'

const WAIT_MS = 10_000

/** The wait of a 429: `wait_ms` in the body (as the hub says it) or `Retry-After` in seconds. */
export function waitOf(body: unknown, retryAfter: string | null): number {
  const fromBody = Number((body as { wait_ms?: unknown } | null)?.wait_ms)
  if (Number.isFinite(fromBody) && fromBody > 0) return fromBody
  const seconds = Number(retryAfter)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
}

/** «Espera 8 s» (rounded up: it never says 0 while there is still waiting). */
export const waitInWords = (ms: number) => `Espera ${Math.max(1, Math.ceil(ms / 1000))} s`

function errorOf(status: number, body: unknown, retryAfter: string | null, signingIn: boolean) {
  const said = (body as { message?: unknown } | null)?.message
  const text = typeof said === 'string' && said ? said : null
  if (status === 401)
    // A failed sign-in may come with the wait before the next one (it grows with each failure).
    return signingIn
      ? new PanelError('unauthorized', WRONG_CREDENTIALS, status, waitOf(body, retryAfter))
      : new PanelError('unauthorized', SESSION_CLOSED, status)
  if (status === 429) {
    const wait = waitOf(body, retryAfter)
    return new PanelError(
      'rate_limited',
      wait > 0
        ? `Demasiados intentos. ${waitInWords(wait)} y vuelve a intentar.`
        : 'Demasiados intentos. Espera un momento y vuelve a intentar.',
      status,
      wait,
    )
  }
  if (status === 403)
    // A POST from an address that is not the panel's (docs/PANEL.md): not a matter of permissions.
    return (body as { error?: unknown } | null)?.error === 'invalid_origin'
      ? new PanelError('forbidden', WRONG_ORIGIN, status)
      : new PanelError('forbidden', 'Tu rol no tiene permiso para ver esto.', status)
  if (status === 400) return new PanelError('invalid', text ?? 'Revisa los datos.', status)
  return new PanelError(
    'server',
    `El servidor de Faro respondió con un error (${status}). Intenta de nuevo en un momento.`,
    status,
  )
}

export interface PanelApi {
  signIn(data: { restaurant: string; username: string; password: string }): Promise<Me>
  signOut(): Promise<void>
  me(): Promise<Me>
  summary(): Promise<Summary>
  /** Without dates, today's business day. */
  reports(period: Period | null): Promise<PeriodReport>
  /** With the version of the plan already in hand, it does not come again. */
  floor(planVersion: string | null): Promise<LiveFloor>
  register(): Promise<RegisterAnswer>
  /** Without a day, today's. */
  alerts(day: string | null): Promise<AlertsAnswer>
}

/**
 * The panel's client. A 401 outside sign-in means the session died (it expired, it was closed or the
 * person lost the permission): `onUnauthorized` takes the panel back to «Entrar».
 */
export function panelApi({
  fetch: doFetch = (...a) => fetch(...a),
  onUnauthorized = () => {},
}: {
  fetch?: typeof fetch
  onUnauthorized?: () => void
} = {}): PanelApi {
  /** `kind` says what a 401 means: wrong credentials, no session yet, or a session that died. */
  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    {
      body,
      kind = 'session',
      empty = false,
    }: {
      body?: object
      kind?: 'sign-in' | 'check' | 'session'
      /** The answer is a 204 with no body (signing out). */
      empty?: boolean
    } = {},
  ): Promise<T> {
    let r: Response
    try {
      r = await doFetch(path, {
        method,
        credentials: 'same-origin',
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(WAIT_MS),
      })
    } catch {
      throw new PanelError('offline', OFFLINE)
    }
    if (r.status === 204 && empty) return undefined as T
    const data: unknown = await r.json().catch(() => null)
    if (!r.ok) {
      const error = errorOf(r.status, data, r.headers.get('retry-after'), kind === 'sign-in')
      if (error.kind === 'unauthorized' && kind === 'session') onUnauthorized()
      throw error
    }
    // A «good» answer that is not our JSON did not come from the cloud: a Wi-Fi captive portal
    // or a proxy answered instead. For the person, that is having no internet.
    if (data === null || typeof data !== 'object') throw new PanelError('offline', OFFLINE)
    return data as T
  }

  return {
    signIn: (data) => call<Me>('POST', '/v1/panel/sign-in', { body: data, kind: 'sign-in' }),
    signOut: () => call<void>('POST', '/v1/panel/sign-out', { kind: 'check', empty: true }),
    me: () => call<Me>('GET', '/v1/panel/me', { kind: 'check' }),
    summary: () => call<Summary>('GET', '/v1/panel/summary'),
    floor: (version) =>
      call<LiveFloor>(
        'GET',
        version ? `/v1/panel/floor?${new URLSearchParams({ plan: version })}` : '/v1/panel/floor',
      ),
    register: () => call<RegisterAnswer>('GET', '/v1/panel/register'),
    alerts: (day) =>
      call<AlertsAnswer>(
        'GET',
        day ? `/v1/panel/alerts?${new URLSearchParams({ day })}` : '/v1/panel/alerts',
      ),
    reports: (p) =>
      call<PeriodReport>(
        'GET',
        p
          ? `/v1/panel/reports?${new URLSearchParams({ from: p.from, until: p.until })}`
          : '/v1/panel/reports',
      ),
  }
}
