import {
  aggregateOf,
  authorizableFingerprint,
  type ChargedByMethod,
  type NewEvent,
  newId,
  type OrderEventType,
  type PaymentMethod,
  type Report,
  type ShiftReconciliation,
  signEvent,
} from '@pos/core'
import {
  type Catalog,
  type Channel,
  ConnectionManager,
  type ConnectionState,
  type DeviceType,
  type ErrorCode,
  type Handlers,
  type HubMessage,
  type PrinterStatus,
  SyncClient,
} from '@pos/sync'
import { ApiError, makeCall, NO_HUB } from './api'
import { DeviceDatabase, IndexedDbStore } from './store'

// The app engine on the device: the device credentials, the session (PIN or password), the
// saved catalog and sync (SyncClient over IndexedDB and a WebSocket kept by
// ConnectionManager). The screen reads it with `useFloor` and creates events with `record`.

export const VERSION_APP = '0.10'

export interface Device {
  deviceId: string
  token: string
  name: string
  type: DeviceType
}

export interface Session {
  sessionId: string
  secret: string
  user: { id: string; name: string; role: string }
  permissions: string[]
  /** Last use on this device (ms): after `sessionIdleMin` without use the PIN is requested. */
  lastUsed: number
}

/** What `POST /api/staff/read` returns. */
export interface Staff {
  roles: {
    id: string
    name: string
    /** Built in: it is not renamed or archived. */
    system: boolean
    active: boolean
    permissions: string[]
    people: number
  }[]
  people: {
    id: string
    name: string
    roleId: string
    active: boolean
    /** The user it signs in to the register with; `null` if it signs in with its PIN. */
    user: string | null
  }[]
  /** The devices the hub registered, from the most recently used to the least. */
  devices: {
    id: string
    name: string
    type: DeviceType
    registeredAt: string | null
    revokedAt: string | null
    lastUsed: string | null
    lastPerson: string | null
  }[]
}

/** A menu editor change: creates the record if it does not exist, or changes those fields. */
export interface CatalogChange {
  entity:
    | 'zones'
    | 'dining_tables'
    | 'floor_plan_elements'
    | 'taxes'
    | 'stations'
    | 'categories'
    | 'products'
    | 'variants'
    | 'modifier_groups'
    | 'product_modifier_groups'
    | 'modifiers'
  id: string
  data: Record<string, string | number | boolean | null>
}

interface Registration {
  id: string
  version: number
  active: boolean
}

/** What `GET /api/catalog/editing` returns: the catalog rows, archived ones too. */
export type TableShape = 'round' | 'square' | 'rectangular' | 'bar'
export type ElementType = 'wall' | 'door' | 'plant' | 'bar' | 'text'

/** Geometry on the floor plan, in centimeters: top-left corner, sizes and rotation in degrees. */
export interface Geometry {
  x: number
  y: number
  width: number
  height: number
  rotation: number
}

export interface EditableCatalog {
  version: number
  zones: (Registration & { name: string; position: number; level: number })[]
  tables: (Registration &
    Geometry & { zone_id: string; name: string; shape: TableShape; capacity: number })[]
  elements: (Registration &
    Geometry & { zone_id: string; type: ElementType; text: string | null })[]
  taxes: (Registration & { name: string; type: 'inc' | 'iva' | 'exempt'; rate: number })[]
  stations: (Registration & { name: string; position: number })[]
  categories: (Registration & { name: string; position: number; station_id: string | null })[]
  products: (Registration & {
    category_id: string
    name: string
    description: string | null
    price: number
    tax_id: string
    favorite: boolean
    /** File name of its photo on the hub (`/photos/<name>`), or nothing. */
    photo?: string | null
  })[]
  variants: (Registration & { product_id: string; name: string; price: number; position: number })[]
  groups: (Registration & { name: string; minimum: number; maximum: number })[]
  links: (Registration & { product_id: string; group_id: string; position: number })[]
  modifiers: (Registration & {
    group_id: string
    name: string
    extra_price: number
    position: number
  })[]
}

/** A ticket printer as «Cocina e impresoras» edits it (ADR-015). */
export interface KitchenPrinter {
  id?: string
  name: string
  connection: 'network' | 'usb'
  address: string
  port: number | null
  width: 58 | 80
  code_page: 'pc850' | 'wpc1252' | 'no_accents'
  fallback_id: string | null
  station_ids: string[]
  active: boolean
}

/** What `POST /api/kitchen/config` returns. */
export interface KitchenConfig {
  stations: { id: string; name: string }[]
  printers: (KitchenPrinter & { id: string })[]
  statuses: PrinterStatus[]
  screens: {
    device_id: string
    name: string
    station_ids: string[]
    last_used: string | null
  }[]
  timers: { yellow: number; red: number }
  courses_enabled?: boolean
  /** Where the pre-bill prints (task 1.6); an older hub does not send it. */
  pre_bill_printer_id?: string | null
}

export interface CustomMethod {
  id?: string
  name: string
  active: boolean
}

export type CardTerminalProvider = 'bold' | 'redeban' | 'credibanco' | 'other'

export interface CardTerminal {
  id?: string
  name: string
  provider: CardTerminalProvider
  active: boolean
}

/** What the «Caja y pagos» screen shows (`POST /api/register/config`, task 1.6). */
export interface RegisterConfig {
  payment_methods: PaymentMethod[]
  /** Basis points: 1000 = 10 %. */
  suggested_tip: number
  /** The methods the restaurant created (Sodexo, the bank's QR). */
  custom_methods: CustomMethod[]
  /** From what variance the register close asks for a justification. */
  register_variance_threshold?: number
  cardTerminals: (CardTerminal & { id: string })[]
}

/** A register close of the period, with its reconciliation (`POST /api/reports`, task 1.9). */
export interface ReportClose {
  shiftId: string
  businessDay: string
  openedAt: string
  openedBy: string
  closedBy: string
  base: number
  byMethod: ChargedByMethod[]
  closed: NonNullable<ShiftReconciliation['closed']>
}

/** The report of a period of business days (docs/KPIS.md). */
export interface PeriodReport {
  /** Today's business day according to the hub. */
  today: string
  report: Report
  closings: ReportClose[]
  /** Names of the people that appear, by id. */
  users: Record<string, string>
  /** Whether there is a pre-bill printer to reprint the Z report. */
  printer: boolean
}

/** A ticket that has not come out of its printer (`POST /api/printing/pending`). */
export interface PendingJob {
  id: string
  printer: string
  what: string
  attempts: number
  error: string | null
  created_at: string
}

/** What some events carry besides their data. */
export interface EventOptions {
  /** Required in voids and cancellations (docs/MODELO_DATOS.md). */
  reason?: string
  /** The other order it touches (the target when moving products). */
  related?: string[]
  /** The PIN of whoever authorizes, if whoever is on the device lacks the permission. */
  authorizes?: { pin: string; permission: string }
}

export interface Snapshot {
  loaded: boolean
  device: Device | null
  session: Session | null
  catalog: Catalog | null
  connection: ConnectionState
  /** The user turned off the connection for the demo (docs/ROADMAP.md, 0.10). */
  simulatingOffline: boolean
  pendingList: number
  /** Goes up every time something saved changes: the screen rereads. */
  changes: number
  /** Why the last session was closed, to explain it on the PIN screen. */
  sessionClosedBy: 'inactivity' | null
  /** The hub rejected the device (invalid or revoked token, old app). */
  hubError: { code: ErrorCode; message: string } | null
  /** How the ticket printers are, according to the hub's last notice (ADR-015). */
  printers: PrinterStatus[]
}

const DEFAULT_MINUTES = 30

/** Whatever is missing from the editing catalog (a hub of another version) is taken as empty. */
export function completeEdit(c: Partial<EditableCatalog> & { version: number }): EditableCatalog {
  return {
    version: c.version,
    zones: c.zones ?? [],
    tables: c.tables ?? [],
    elements: c.elements ?? [],
    taxes: c.taxes ?? [],
    stations: c.stations ?? [],
    categories: c.categories ?? [],
    products: c.products ?? [],
    variants: c.variants ?? [],
    groups: c.groups ?? [],
    links: c.links ?? [],
    modifiers: c.modifiers ?? [],
  }
}

/**
 * A menu saved by an earlier version of the app may not bring what was added later
 * (the floor plan of 1.2): it is completed with empty values until the hub's arrives. That way an
 * update does not leave the screen blank.
 */
export function completeCatalog(c: Catalog): Catalog {
  const oldOne = c as Partial<Catalog> &
    Pick<Catalog, 'version' | 'restaurant' | 'stations' | 'categories'>
  return {
    ...c,
    zones: (oldOne.zones ?? []).map((z) => ({ ...z, level: z.level ?? 1 })),
    tables: (oldOne.tables ?? []).map((m) => ({
      ...m,
      width: m.width ?? 80,
      height: m.height ?? 80,
      rotation: m.rotation ?? 0,
    })),
    elements: oldOne.elements ?? [],
    staff: oldOne.staff ?? [],
  }
}

/** A background job failed (IndexedDB full or closed): it stays in the console. */
const notifyFailure = (error: unknown) => console.error('Equipo:', error)
const KEYS = { device: 'device', session: 'session', catalog: 'catalog' }

function openWebSocket(m: Handlers): Channel {
  const schema = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${schema}://${location.host}/api/sync/ws`)
  ws.onopen = () => m.onOpen()
  ws.onclose = () => m.onClose()
  ws.onmessage = (e) => {
    // The hub is our own and is on the local network: discarding what is not a message is enough.
    // Validating each type with its schema is pending (docs/ROADMAP.md, 0.10).
    let message: unknown
    try {
      message = JSON.parse(String(e.data))
    } catch {
      return
    }
    if (typeof message === 'object' && message !== null && 'type' in message)
      m.onMessage(message as HubMessage)
  }
  return {
    send: (message) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
    },
    close: () => ws.close(),
  }
}

export class Floor {
  private readonly db: DeviceDatabase
  private readonly store: IndexedDbStore
  private readonly open: (m: Handlers) => Channel
  private client: SyncClient | null = null
  private connectionManager: ConnectionManager | null = null
  private channel: Channel | null = null
  private status: Snapshot = {
    loaded: false,
    device: null,
    session: null,
    catalog: null,
    connection: 'disconnected',
    simulatingOffline: false,
    pendingList: 0,
    changes: 0,
    sessionClosedBy: null,
    hubError: null,
    printers: [],
  }
  private readonly listeners = new Set<() => void>()
  private loading: Promise<void> | null = null

  constructor(options: { db?: DeviceDatabase; open?: (m: Handlers) => Channel } = {}) {
    this.db = options.db ?? new DeviceDatabase()
    this.store = new IndexedDbStore(this.db)
    this.open = options.open ?? openWebSocket
  }

  // ── For React (useSyncExternalStore) ─────────────────────────────────

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = () => this.status

  private patch(partial: Partial<Snapshot>) {
    this.status = { ...this.status, ...partial }
    for (const o of this.listeners) o()
  }

  // ── Startup ──────────────────────────────────────────────────────────

  /** Opens what is saved and starts syncing. Calling it several times gives the same load. */
  load(): Promise<void> {
    this.loading ??= this.doLoad()
    return this.loading
  }

  private async doLoad() {
    const [device, session, catalog] = await Promise.all([
      this.db.readSetting<Device>(KEYS.device),
      this.db.readSetting<Session>(KEYS.session),
      this.db.readSetting<Catalog>(KEYS.catalog),
    ])
    this.patch({
      loaded: true,
      device: device ?? null,
      session: session ?? null,
      catalog: catalog ? completeCatalog(catalog) : null,
    })
    this.expireSessionIfDue()
    if (device) await this.connect(device)
  }

  /** Exchanges the pairing code for its own token and starts syncing. */
  async pair(code: string) {
    const r = await this.api<{
      device_id: string
      token: string
      name: string
      type: DeviceType
    }>('POST', '/api/pair', { body: { code: code.trim().toUpperCase() } })
    const device: Device = {
      deviceId: r.device_id,
      token: r.token,
      name: r.name,
      type: r.type,
    }
    await this.db.saveSetting(KEYS.device, device)
    this.patch({ device, hubError: null })
    await this.connect(device)
  }

  /**
   * The first device of a freshly installed hub approves itself with the
   * admin's PIN (the others, from the register with `codeForOtherDevice`).
   */
  async pairFirst(pin: string, name: string, type: DeviceType) {
    const { code } = await this.api<{ code: string }>('POST', '/api/pairings', {
      body: { pin, name, type },
    })
    await this.pair(code)
  }

  /** From a paired device (the register), an admin approves another device with their PIN. */
  async codeForOtherDevice(pin: string, name: string, type: DeviceType) {
    return this.api<{ code: string; expires_at: string }>('POST', '/api/pairings', {
      body: { pin, name, type },
      token: this.currentDevice().token,
    })
  }

  /**
   * Signs in with the PIN (waiters) or with user and password (requires the hub) and fetches the
   * catalog. A browser without a device is not paired beforehand: on success, the hub registers it
   * and gives it its token (ADR-013).
   */
  async signIn(data: string | { user: string; password: string }) {
    const device = this.status.device
    const r = await this.api<{
      device: {
        device_id: string
        token: string
        name: string
        type: DeviceType
      } | null
      type: DeviceType
      session_id: string
      secret: string
      user: Session['user']
      permissions: string[]
    }>('POST', '/api/sign-in', {
      body: typeof data === 'string' ? { pin: data } : data,
      token: device?.token,
    })
    const fresh: Device | null = r.device
      ? {
          deviceId: r.device.device_id,
          token: r.device.token,
          name: r.device.name,
          type: r.device.type,
        }
      : device && device.type !== r.type
        ? { ...device, type: r.type }
        : null
    // The device first: without it, the session is useless.
    if (fresh) await this.db.saveSetting(KEYS.device, fresh)
    const session: Session = {
      sessionId: r.session_id,
      secret: r.secret,
      user: r.user,
      permissions: r.permissions,
      lastUsed: Date.now(),
    }
    await this.db.saveSetting(KEYS.session, session)
    this.patch({
      ...(fresh ? { device: fresh, hubError: null } : {}),
      session,
      sessionClosedBy: null,
    })
    if (r.device && fresh) await this.connect(fresh)
    // A freshly registered device may come from another hub (reinstalled, or a new one): its menu
    // wins even if its version is lower than the one saved here.
    await this.updateCatalog(r.device !== null).catch(() => {})
  }

  /**
   * The hub no longer recognizes the token (the device was reinstalled or removed): the
   * credentials are forgotten to pair again. What is pending stays saved, but carries the old
   * `device_id`: the hub will reject it (`device_mismatch`). The screen warns about it first.
   */
  async forgetDevice() {
    this.connectionManager?.stop()
    this.connectionManager = null
    this.client = null
    await Promise.all([this.db.deleteSetting(KEYS.device), this.db.deleteSetting(KEYS.session)])
    this.patch({ device: null, session: null, hubError: null, connection: 'disconnected' })
  }

  /** Closes the session here (forgets the secret) and tells the hub if possible. */
  async exit(lookup: Snapshot['sessionClosedBy'] = null) {
    const session = this.status.session
    // On screen first: an expired session must not allow creating anything while it is cleared.
    this.patch({ session: null, sessionClosedBy: lookup })
    await this.db.deleteSetting(KEYS.session)
    if (session && this.status.device)
      await this.api('POST', '/api/sessions/close', {
        body: { session_id: session.sessionId, secret: session.secret },
        token: this.status.device.token,
      }).catch(() => {})
  }

  /** Fetches the menu from the hub. With `replace`, even if its version is lower than the saved. */
  async updateCatalog(replace = false) {
    const catalog = await this.api<Catalog | undefined>('GET', '/api/catalog', {
      token: this.currentDevice().token,
    })
    // An odd response does not replace the good menu that is already saved.
    if (typeof catalog?.version !== 'number' || !Array.isArray(catalog.tables))
      throw new ApiError(
        'invalid_response',
        'La caja respondió algo que no es la carta: intenta de nuevo',
      )
    // Two menu requests at once: the response that arrives late does not overwrite a newer one.
    if (!replace && catalog.version < (this.status.catalog?.version ?? -1)) return
    const completed = completeCatalog(catalog)
    await this.db.saveSetting(KEYS.catalog, completed)
    this.patch({ catalog: completed })
  }

  /** The whole catalog, archived items too, for the menu editor. */
  async catalogForEditing(): Promise<EditableCatalog> {
    const c = await this.api<Partial<EditableCatalog> & { version: number }>(
      'GET',
      '/api/catalog/editing',
      { token: this.currentDevice().token },
    )
    return completeEdit(c)
  }

  /**
   * Saves catalog changes (all or none) with the open session; the hub notifies the
   * devices and this one also fetches the new menu.
   */
  async editCatalog(changes: CatalogChange[]): Promise<number> {
    this.markUsed()
    const session = this.status.session
    if (!session) throw new Error('Sin sesión: escribe tu PIN')
    const { version } = await this.api<{ version: number }>('POST', '/api/catalog/changes', {
      body: { session_id: session.sessionId, secret: session.secret, changes },
      token: this.currentDevice().token,
    })
    await this.updateCatalog().catch(notifyFailure)
    return version
  }

  // ── Photos and brand (task 1.3c) ─────────────────────────────────────

  /** Uploads (or removes, with `null`) a product's photo; returns its path on the hub. */
  async uploadPhoto(productId: string, image: string | null): Promise<string | null> {
    const r = await this.withSession<{ photo: string | null }>('/api/catalog/photos', {
      product_id: productId,
      image,
    })
    await this.updateCatalog().catch(notifyFailure)
    return r.photo
  }

  /** The brand the POS shows on every device of the restaurant. */
  async changeBrand(brand: string): Promise<void> {
    await this.withSession('/api/restaurant/brand', { brand })
    // Here it shows at once, even if the new menu takes a while; the other devices, with it.
    const { catalog } = this.status
    if (catalog)
      this.patch({ catalog: { ...catalog, restaurant: { ...catalog.restaurant, brand } } })
    await this.updateCatalog().catch(notifyFailure)
  }

  // ── Staff and roles (task 1.3b) ──────────────────────────────────────

  /** Roles and people, archived ones too (requires `manage_users`). */
  async staff(): Promise<Staff> {
    return this.withSession('/api/staff/read', {})
  }

  /** Creates a role or changes its name, its permissions or whether it is active. */
  async saveRole(role: {
    id?: string
    name: string
    permissions: string[]
    active?: boolean
  }): Promise<string> {
    return (await this.withSession<{ id: string }>('/api/staff/roles', { role })).id
  }

  /**
   * Creates or changes a person. Returns their PIN if new or regenerated: it is shown only once.
   */
  async saveStaffMember(person: {
    id?: string
    name: string
    role_id: string
    active?: boolean
    access?: { type: 'pin' } | { type: 'password'; user: string; password?: string }
    regenerate_pin?: boolean
  }): Promise<{ id: string; pin: string | null }> {
    const r = await this.withSession<{ id: string; pin: string | null }>('/api/staff/people', {
      person,
    })
    // Each person's name comes in the menu: fetch it to see it on the floor.
    await this.updateCatalog().catch(notifyFailure)
    return r
  }

  // ── Kitchen and printers (ADR-015) ───────────────────────────────────

  kitchenConfig(): Promise<KitchenConfig> {
    return this.withSession('/api/kitchen/config', {})
  }

  async savePrinter(printer: KitchenPrinter): Promise<string> {
    const { id } = await this.withSession<{ id: string }>('/api/printers', { printer })
    return id
  }

  async testPrinter(printerId: string): Promise<void> {
    await this.withSession('/api/printers/test', { printer_id: printerId })
  }

  pendingPrints(): Promise<PendingJob[]> {
    return this.withSession('/api/printing/pending', {})
  }

  async discardJob(jobId: string): Promise<void> {
    await this.withSession('/api/printing/discard', { job_id: jobId })
  }

  async screenStations(deviceId: string, stationIds: string[]): Promise<void> {
    await this.withSession('/api/screens/stations', {
      device_id: deviceId,
      station_ids: stationIds,
    })
  }

  async coursesEnabled(enabled: boolean): Promise<void> {
    await this.withSession('/api/kitchen/courses', { enabled })
  }

  async kitchenTimers(yellow: number, red: number): Promise<void> {
    await this.withSession('/api/kitchen/timers', { yellow, red })
  }

  // ── Reports (task 1.9) ───────────────────────────────────────────────

  /** The report of a period; without dates, today's business day. */
  report(period: { from: string; until: string } | null = null): Promise<PeriodReport> {
    return this.withSession('/api/reports', period ?? {})
  }

  async reprintClose(shiftId: string): Promise<void> {
    await this.withSession('/api/reports/z-report', { shift_id: shiftId })
  }

  // ── Register and payments (task 1.6) ─────────────────────────────────

  registerConfig(): Promise<RegisterConfig> {
    return this.withSession('/api/register/config', {})
  }

  async savePaymentMethods(methods: PaymentMethod[]): Promise<void> {
    await this.withSession('/api/register/payment-methods', { methods })
  }

  async saveCardTerminal(cardTerminal: CardTerminal): Promise<RegisterConfig['cardTerminals']> {
    const r = await this.withSession<{ cardTerminals: RegisterConfig['cardTerminals'] }>(
      '/api/card-terminals',
      { cardTerminal },
    )
    return r.cardTerminals
  }

  async saveCustomMethod(method: CustomMethod): Promise<CustomMethod[]> {
    const r = await this.withSession<{ custom_methods: CustomMethod[] }>(
      '/api/register/custom-methods',
      {
        method,
      },
    )
    return r.custom_methods
  }

  async varianceThreshold(pesos: number): Promise<void> {
    await this.withSession('/api/register/threshold', { pesos })
  }

  async suggestedTip(points: number): Promise<void> {
    await this.withSession('/api/register/tip', { points })
  }

  async preBillPrinter(printerId: string | null): Promise<void> {
    await this.withSession('/api/register/pre-bill', { printer_id: printerId })
  }

  /**
   * Opens this device's register with the cash base (`ShiftOpened`). The screen only allows it
   * online, like checkout: the hub rejects a second shift of the same register.
   */
  async openShift(base: number): Promise<string> {
    const device = this.currentDevice()
    const shiftId = newId()
    await this.record('ShiftOpened', shiftId, { register_id: device.deviceId, base })
    return shiftId
  }

  /**
   * This device becomes the kitchen screen of those stations: the admin's session is
   * closed and the screen's remains, which does not expire from inactivity.
   */
  async convertToScreen(name: string, stationIds: string[]): Promise<void> {
    const r = await this.withSession<{
      session_id: string
      secret: string
      user: Session['user']
      permissions: string[]
    }>('/api/screens', { name, station_ids: stationIds })
    const device: Device = { ...this.currentDevice(), type: 'kds', name }
    await this.db.saveSetting(KEYS.device, device)
    const session: Session = {
      sessionId: r.session_id,
      secret: r.secret,
      user: r.user,
      permissions: r.permissions,
      lastUsed: Date.now(),
    }
    await this.db.saveSetting(KEYS.session, session)
    this.patch({ device, session, sessionClosedBy: null })
    await this.updateCatalog().catch(() => {})
  }

  /** Removes a device (lost, stolen): it stops syncing and nobody can sign in on it. */
  async removeDevice(deviceId: string): Promise<void> {
    await this.withSession(`/api/devices/${encodeURIComponent(deviceId)}/revoke`, {})
  }

  /** A call with the open session. If the hub says it is no longer valid, asks to sign in again. */
  private async withSession<T>(route: string, body: object): Promise<T> {
    this.markUsed()
    const session = this.status.session
    if (!session) throw new Error('Sin sesión: vuelve a entrar')
    try {
      return await this.api<T>('POST', route, {
        body: { session_id: session.sessionId, secret: session.secret, ...body },
        token: this.currentDevice().token,
      })
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_session') await this.exit()
      throw e
    }
  }

  /** Fetches the menu again; if it fails, the saved one stays (it is retried on reconnect). */
  private fetchCatalogIfSession() {
    if (this.status.session) this.updateCatalog().catch(notifyFailure)
  }

  /** If the idle time passed, the session is closed: the next tap asks for the PIN. */
  expireSessionIfDue(now = Date.now()) {
    const { session, catalog, device } = this.status
    // A kitchen screen always stays open: nobody signs in to it with dirty hands.
    if (!session || device?.type === 'kds') return
    const minutes = catalog?.restaurant.sessionIdleMin ?? DEFAULT_MINUTES
    if (now - session.lastUsed >= minutes * 60_000) this.exit('inactivity').catch(notifyFailure)
  }

  /** Marks use (every tap that does something): postpones the inactivity close. */
  markUsed(now = Date.now()) {
    const { session } = this.status
    if (!session) return
    this.expireSessionIfDue(now)
    // Every tap counts, but there is no need to write to IndexedDB with each one.
    if (!this.status.session || now - session.lastUsed < 15_000) return
    const newOne = { ...session, lastUsed: now }
    this.status = { ...this.status, session: newOne }
    this.db.saveSetting(KEYS.session, newOne).catch(notifyFailure)
  }

  // ── Sync ─────────────────────────────────────────────────────────────

  private async connect(device: Device) {
    this.connectionManager?.stop()
    // Client and manager are assigned before the first `await`: another call arriving meanwhile
    // stops this manager instead of leaving a second orphan WebSocket.
    const client = new SyncClient({
      store: this.store,
      token: device.token,
      versionApp: VERSION_APP,
      send: (m) => this.channel?.send(m),
      onChange: () => void this.onDataChange().catch(notifyFailure),
      onHubError: (code, message) => {
        if (code === 'invalid_token' || code === 'outdated_app') connectionManager.stop()
        this.patch({ hubError: { code, message } })
      },
      onFailure: (error) => console.error('Sincronización:', error),
    })
    const connectionManager = new ConnectionManager({
      open: this.open,
      onConnect: (channel) => {
        this.channel = channel
        void client.onConnect()
        // It may have changed while there was no connection.
        this.fetchCatalogIfSession()
      },
      onDisconnect: () => {
        this.channel = null
        client.onDisconnect()
      },
      onMessage: (m) => {
        if (m.type === 'catalog' && m.version !== this.status.catalog?.version)
          this.fetchCatalogIfSession()
        if (m.type === 'printers') this.patch({ printers: m.printers })
        void client.receive(m)
      },
      onStateChange: (connection) => this.patch({ connection }),
    })
    this.client = client
    this.connectionManager = connectionManager
    await client.begin()
    if (this.connectionManager !== connectionManager) return
    if (!this.status.simulatingOffline) connectionManager.begin()
    await this.onDataChange()
  }

  private async onDataChange() {
    const pendingList = (await this.client?.pendingList()) ?? 0
    this.patch({ pendingList, changes: this.status.changes + 1 })
  }

  /** For the demo: cuts the connection to the hub as if the Wi-Fi dropped, and restores it. */
  simulateOffline(without: boolean) {
    this.patch({ simulatingOffline: without })
    if (without) this.connectionManager?.stop()
    else this.connectionManager?.begin()
  }

  changeVisibility(visible: boolean) {
    this.connectionManager?.changeVisibility(visible)
    if (visible) this.expireSessionIfDue()
  }

  /**
   * The hub time according to this device (ms): kitchen times are measured against the time the
   * hub received the ticket, and a tablet with its clock ahead must not see everything in amber.
   */
  hubNow(now = Date.now()): number {
    return this.client ? Date.parse(this.client.hubEstimatedTime(now)) : now
  }

  /** The sync client (to read local orders and events). */
  get sync(): SyncClient | null {
    return this.client
  }

  /**
   * Creates an order event with its full envelope, signs it with the session secret and
   * saves it (persist before showing). It is sent only when there is a connection.
   */
  async record<T extends OrderEventType>(
    type: T,
    orderId: string,
    data: Extract<NewEvent, { type: T }>['data'],
    options: EventOptions = {},
  ): Promise<NewEvent> {
    const now = Date.now()
    // Use first: if the session just expired, nothing is signed with it.
    this.markUsed(now)
    const client = this.client
    const { session, device } = this.status
    if (!client || !session || !device) throw new Error('Sin sesión: escribe tu PIN')
    const event = {
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: aggregateOf(type),
      aggregate_id: orderId,
      related: options.related ?? [],
      data,
      session_id: session.sessionId,
      user_id: session.user.id,
      device_id: device.deviceId,
      authorization_id: null,
      reason: options.reason ?? null,
      device_time: new Date(now).toISOString(),
      hub_estimated_time: client.hubEstimatedTime(now),
      base_sequence: await client.known(),
    } as NewEvent
    // With a supervisor's PIN (ADR-008): the hub gives a single-use approval for this
    // exact event (its fingerprint), and the event carries it. It needs a connection: without one,
    // it fails here.
    if (options.authorizes) {
      const { authorization_id } = await this.withSession<{ authorization_id: string }>(
        '/api/authorizations',
        {
          pin: options.authorizes.pin,
          action: options.authorizes.permission,
          aggregate_id: orderId,
          event_id: event.id,
          fingerprint: authorizableFingerprint(event),
        },
      )
      event.authorization_id = authorization_id
    }
    const signed = { ...event, signature: signEvent(event, session.secret) } as NewEvent
    const r = await client.record(signed)
    if (!r.ok) throw new Error(`Evento inválido: ${r.errors.join('; ')}`)
    // So the pending counter already counts it on return.
    await this.onDataChange()
    return signed
  }

  /**
   * Like `record`, but waits for the hub to accept it: for money (charging, closing the table)
   * saving it here is not enough, because a payment the hub rejects disappears from the check. If
   * the hub rejects it, it fails with the reason in words; if it does not answer in time, it fails
   * saying it stayed pending (do not charge again).
   */
  async recordConfirmed<T extends OrderEventType>(
    type: T,
    aggregateId: string,
    data: Extract<NewEvent, { type: T }>['data'],
    options: EventOptions = {},
    waitMs = 10_000,
  ): Promise<NewEvent> {
    const event = await this.record(type, aggregateId, data as never, options)
    const limit = Date.now() + waitMs
    for (;;) {
      const local = (await this.client?.locals())?.find((l) => l.event.id === event.id)
      if (local?.status === 'confirmed') return event
      if (local?.status === 'rejected') throw new Error(reasonInWords(local.reason))
      if (Date.now() > limit)
        throw new Error(
          'La caja no confirmó a tiempo. Quedó pendiente: revisa la cuenta en un momento antes de cobrar otra vez.',
        )
      await new Promise((r) => setTimeout(r, 150))
    }
  }

  /** What goes over HTTP to the hub; with the simulated outage nothing goes out, as if offline. */
  private api<T>(...args: Parameters<typeof makeCall>): Promise<T> {
    if (this.status.simulatingOffline) return Promise.reject(new ApiError('offline', NO_HUB))
    return makeCall<T>(...args)
  }

  private currentDevice(): Device {
    if (!this.status.device)
      throw new Error('Este equipo todavía no ha entrado: escribe tu PIN o tu contraseña')
    return this.status.device
  }
}

/** Why the hub rejected a money event, phrased for the register. */
function reasonInWords(reason: string | undefined): string {
  const texts: Record<string, string> = {
    no_shift: 'La caja no tiene turno abierto: ábrela en «Caja».',
    other_register_shift: 'Ese turno es de otra caja: cobra desde la caja donde se abrió.',
    shift_already_open: 'Esta caja ya tiene un turno abierto.',
    rounding_mismatch: 'Cambió la regla del redondeo del efectivo: vuelve a abrir el cobro.',
    method_not_enabled: 'Ese medio de pago no está habilitado en «Caja y pagos».',
    unknown_card_terminal: 'Ese datáfono ya no está: elige otro.',
    payment_exceeds_balance: 'El pago supera lo que falta: alguien más ya cobró una parte.',
    pending_balance: 'Todavía queda saldo: alguien agregó algo mientras cobrabas.',
    no_permission: 'No tienes permiso para hacerlo.',
    register_only: 'Esto solo se hace desde un equipo de caja.',
    order_closed: 'El pedido ya estaba cerrado.',
    cash_count_not_found: 'La caja no tiene ese conteo: vuelve a contar.',
    counted_mismatch: 'Lo contado no coincide con el conteo guardado: vuelve a contar.',
    expected_mismatch:
      'La caja registró algo que este equipo aún no tenía: espera un momento y vuelve a contar.',
    missing_justification: 'Escribe por qué no cuadra la caja.',
    cash_count_not_latest: 'La caja se cierra con el último conteo: vuelve a contar.',
    stale_cash_count: 'Hubo pagos o movimientos después del conteo: vuelve a contar.',
    other_methods_mismatch:
      'Los demás medios no coinciden con lo que registró la caja: recarga la app (puede estar desactualizada) y vuelve a contar.',
  }
  return (reason && texts[reason]) ?? `La caja no lo aceptó (${reason ?? 'sin motivo'}).`
}
