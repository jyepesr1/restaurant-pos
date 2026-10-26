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
import { AlmacenIndexedDb, BaseDispositivo } from './almacen'
import { ErrorApi, makeCall, SIN_HUB } from './api'

// El motor de la app en el dispositivo: las credenciales del equipo, la sesión (PIN o contraseña), el
// catálogo guardado y la sincronización (SyncClient sobre IndexedDB y un WebSocket que mantiene
// ConnectionManager). La pantalla lo lee con `useSala` y crea eventos con `registrar`.

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
  /** Último uso en este dispositivo (ms): tras `sessionIdleMin` sin uso se pide el PIN. */
  lastUsed: number
}

/** Lo que devuelve `POST /api/personal/leer`. */
export interface Personal {
  roles: {
    id: string
    name: string
    /** De fábrica: no se renombra ni se archiva. */
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
    /** El usuario con que entra a la caja; `null` si entra con su PIN. */
    user: string | null
  }[]
  /** Los equipos que el hub registró, del usado más hace poco al que menos. */
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

/** Un cambio del editor de la carta: crea el registro si no existe, o cambia esos campos. */
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

/** Lo que devuelve `GET /api/catalogo/edicion`: las filas del catálogo, también las archivadas. */
export type FormaMesa = 'round' | 'square' | 'rectangular' | 'bar'
export type TipoElemento = 'wall' | 'door' | 'plant' | 'bar' | 'text'

/** Geometría en el plano, en centímetros: esquina superior izquierda, medidas y giro en grados. */
export interface Geometria {
  x: number
  y: number
  width: number
  height: number
  rotation: number
}

export interface CatalogoEdicion {
  version: number
  zones: (Registration & { name: string; position: number; level: number })[]
  tables: (Registration &
    Geometria & { zone_id: string; name: string; shape: FormaMesa; capacity: number })[]
  elements: (Registration &
    Geometria & { zone_id: string; type: TipoElemento; text: string | null })[]
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
    /** Nombre del archivo de su foto en el hub (`/fotos/<nombre>`), o nada. */
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

/** Una impresora de comandas como la edita «Cocina e impresoras» (ADR-015). */
export interface ImpresoraCocina {
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

/** Lo que devuelve `POST /api/cocina/configuracion`. */
export interface ConfiguracionCocina {
  stations: { id: string; name: string }[]
  printers: (ImpresoraCocina & { id: string })[]
  statuses: PrinterStatus[]
  screens: {
    device_id: string
    name: string
    station_ids: string[]
    last_used: string | null
  }[]
  timers: { yellow: number; red: number }
  courses_enabled?: boolean
  /** Dónde sale la precuenta (tarea 1.6); un hub de antes no lo manda. */
  pre_bill_printer_id?: string | null
}

export interface MedioPropio {
  id?: string
  name: string
  active: boolean
}

export type ProveedorDatafono = 'bold' | 'redeban' | 'credibanco' | 'other'

export interface Datafono {
  id?: string
  name: string
  provider: ProveedorDatafono
  active: boolean
}

/** Lo de la pantalla «Caja y pagos» (`POST /api/caja/configuracion`, tarea 1.6). */
export interface ConfiguracionCaja {
  payment_methods: PaymentMethod[]
  /** Puntos básicos: 1000 = 10 %. */
  suggested_tip: number
  /** Los medios que creó el restaurante (Sodexo, QR del banco). */
  custom_methods: MedioPropio[]
  /** Desde qué diferencia el cierre de caja pide justificación. */
  register_variance_threshold?: number
  cardTerminals: (Datafono & { id: string })[]
}

/** Un cierre de caja del período, con su cuadre (`POST /api/reportes`, tarea 1.9). */
export interface CierreReporte {
  shiftId: string
  businessDay: string
  openedAt: string
  openedBy: string
  closedBy: string
  base: number
  byMethod: ChargedByMethod[]
  closed: NonNullable<ShiftReconciliation['closed']>
}

/** El reporte de un período de días operativos (docs/KPIS.md). */
export interface PeriodReport {
  /** El día operativo de hoy según el hub. */
  today: string
  report: Report
  closings: CierreReporte[]
  /** Nombres de las personas que aparecen, por id. */
  users: Record<string, string>
  /** Si hay impresora de precuentas para reimprimir el cierre Z. */
  printer: boolean
}

/** Una comanda que no ha salido de su impresora (`POST /api/impresion/pendientes`). */
export interface TrabajoPendiente {
  id: string
  printer: string
  what: string
  attempts: number
  error: string | null
  created_at: string
}

/** Lo que algunos eventos llevan además de sus datos. */
export interface OpcionesEvento {
  /** Obligatorio en anulaciones y cancelaciones (docs/MODELO_DATOS.md). */
  reason?: string
  /** El otro pedido que toca (el destino al mover productos). */
  related?: string[]
  /** El PIN de quien autoriza, si quien está en el equipo no tiene el permiso. */
  authorizes?: { pin: string; permission: string }
}

export interface Instantanea {
  cargado: boolean
  device: Device | null
  session: Session | null
  catalog: Catalog | null
  connection: ConnectionState
  /** El usuario apagó la conexión para la demo (docs/ROADMAP.md, 0.10). */
  simulandoSinConexion: boolean
  pendingList: number
  /** Sube cada vez que algo cambia en lo guardado: la pantalla relee. */
  changes: number
  /** Por qué se cerró la última sesión, para explicarlo en la pantalla del PIN. */
  sessionClosedBy: 'inactivity' | null
  /** El hub rechazó al equipo (token inválido o revocado, app vieja). */
  errorHub: { code: ErrorCode; message: string } | null
  /** Cómo están las impresoras de comandas, según el último aviso del hub (ADR-015). */
  printers: PrinterStatus[]
}

const MINUTOS_POR_DEFECTO = 30

/** Lo que falte en el catálogo de edición (un hub de otra versión) se toma como vacío. */
export function completarEdicion(
  c: Partial<CatalogoEdicion> & { version: number },
): CatalogoEdicion {
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
 * Una carta guardada por una versión anterior de la app puede no traer lo que se agregó después
 * (el plano de la 1.2): se completa con lo vacío hasta que llegue la del hub. Así una
 * actualización no deja la pantalla en blanco.
 */
export function completarCatalogo(c: Catalog): Catalog {
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

/** Un trabajo de fondo falló (IndexedDB lleno o cerrado): queda en la consola. */
const avisarFallo = (error: unknown) => console.error('Equipo:', error)
const CLAVES = { device: 'device', session: 'session', catalog: 'catalog' }

function abrirWebSocket(m: Handlers): Channel {
  const schema = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${schema}://${location.host}/api/sync/ws`)
  ws.onopen = () => m.onOpen()
  ws.onclose = () => m.onClose()
  ws.onmessage = (e) => {
    // El hub es propio y está en la red local: basta descartar lo que no es un mensaje. Validar
    // cada tipo con su esquema queda pendiente (docs/ROADMAP.md, 0.10).
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

export class Sala {
  private readonly db: BaseDispositivo
  private readonly store: AlmacenIndexedDb
  private readonly open: (m: Handlers) => Channel
  private client: SyncClient | null = null
  private connectionManager: ConnectionManager | null = null
  private channel: Channel | null = null
  private status: Instantanea = {
    cargado: false,
    device: null,
    session: null,
    catalog: null,
    connection: 'disconnected',
    simulandoSinConexion: false,
    pendingList: 0,
    changes: 0,
    sessionClosedBy: null,
    errorHub: null,
    printers: [],
  }
  private readonly oyentes = new Set<() => void>()
  private cargando: Promise<void> | null = null

  constructor(options: { db?: BaseDispositivo; open?: (m: Handlers) => Channel } = {}) {
    this.db = options.db ?? new BaseDispositivo()
    this.store = new AlmacenIndexedDb(this.db)
    this.open = options.open ?? abrirWebSocket
  }

  // ── Para React (useSyncExternalStore) ────────────────────────────────

  suscribir = (oyente: () => void) => {
    this.oyentes.add(oyente)
    return () => this.oyentes.delete(oyente)
  }

  instantanea = () => this.status

  private patch(partial: Partial<Instantanea>) {
    this.status = { ...this.status, ...partial }
    for (const o of this.oyentes) o()
  }

  // ── Arranque ─────────────────────────────────────────────────────────

  /** Abre lo guardado y empieza a sincronizar. Llamarla varias veces da la misma carga. */
  load(): Promise<void> {
    this.cargando ??= this.hacerCarga()
    return this.cargando
  }

  private async hacerCarga() {
    const [device, session, catalog] = await Promise.all([
      this.db.leerAjuste<Device>(CLAVES.device),
      this.db.leerAjuste<Session>(CLAVES.session),
      this.db.leerAjuste<Catalog>(CLAVES.catalog),
    ])
    this.patch({
      cargado: true,
      device: device ?? null,
      session: session ?? null,
      catalog: catalog ? completarCatalogo(catalog) : null,
    })
    this.vencerSesionSiToca()
    if (device) await this.connect(device)
  }

  /** Cambia el código de emparejamiento por el token propio y empieza a sincronizar. */
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
    await this.db.saveSetting(CLAVES.device, device)
    this.patch({ device, errorHub: null })
    await this.connect(device)
  }

  /**
   * El primer equipo de un hub recién instalado se aprueba a sí mismo con el PIN del
   * administrador (los demás, desde la caja con `codigoParaOtroEquipo`).
   */
  async emparejarPrimero(pin: string, name: string, type: DeviceType) {
    const { code } = await this.api<{ code: string }>('POST', '/api/pairings', {
      body: { pin, name, type },
    })
    await this.pair(code)
  }

  /** Desde un equipo emparejado (la caja), un administrador aprueba otro equipo con su PIN. */
  async codigoParaOtroEquipo(pin: string, name: string, type: DeviceType) {
    return this.api<{ code: string; expires_at: string }>('POST', '/api/pairings', {
      body: { pin, name, type },
      token: this.equipoActual().token,
    })
  }

  /**
   * Entra con el PIN (meseros) o con usuario y contraseña (requiere el hub) y trae el catálogo.
   * Un navegador sin equipo no se empareja antes: con el acierto, el hub lo registra y le da su
   * token (ADR-013).
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
    // Primero el equipo: sin él, la sesión no sirve de nada.
    if (fresh) await this.db.saveSetting(CLAVES.device, fresh)
    const session: Session = {
      sessionId: r.session_id,
      secret: r.secret,
      user: r.user,
      permissions: r.permissions,
      lastUsed: Date.now(),
    }
    await this.db.saveSetting(CLAVES.session, session)
    this.patch({
      ...(fresh ? { device: fresh, errorHub: null } : {}),
      session,
      sessionClosedBy: null,
    })
    if (r.device && fresh) await this.connect(fresh)
    // Un equipo recién registrado puede venir de otro hub (reinstalado, o uno nuevo): su carta
    // manda aunque su versión sea menor que la guardada aquí.
    await this.actualizarCatalogo(r.device !== null).catch(() => {})
  }

  /**
   * El hub ya no reconoce el token (se reinstaló o retiró el equipo): se olvidan las credenciales
   * para emparejar de nuevo. Lo pendiente queda guardado, pero lleva el `device_id` viejo:
   * el hub lo rechazará (`dispositivo_distinto`). La pantalla lo advierte antes.
   */
  async olvidarEquipo() {
    this.connectionManager?.stop()
    this.connectionManager = null
    this.client = null
    await Promise.all([this.db.borrarAjuste(CLAVES.device), this.db.borrarAjuste(CLAVES.session)])
    this.patch({ device: null, session: null, errorHub: null, connection: 'disconnected' })
  }

  /** Cierra la sesión aquí (olvida el secreto) y avisa al hub si se puede. */
  async exit(lookup: Instantanea['sessionClosedBy'] = null) {
    const session = this.status.session
    // Primero en pantalla: una sesión vencida no debe dejar crear nada mientras se borra.
    this.patch({ session: null, sessionClosedBy: lookup })
    await this.db.borrarAjuste(CLAVES.session)
    if (session && this.status.device)
      await this.api('POST', '/api/sessions/close', {
        body: { session_id: session.sessionId, secret: session.secret },
        token: this.status.device.token,
      }).catch(() => {})
  }

  /** Trae la carta del hub. Con `reemplazar`, aunque su versión sea menor que la guardada. */
  async actualizarCatalogo(replace = false) {
    const catalog = await this.api<Catalog | undefined>('GET', '/api/catalog', {
      token: this.equipoActual().token,
    })
    // Una respuesta rara no reemplaza la carta buena que ya está guardada.
    if (typeof catalog?.version !== 'number' || !Array.isArray(catalog.tables))
      throw new ErrorApi(
        'invalid_response',
        'La caja respondió algo que no es la carta: intenta de nuevo',
      )
    // Dos pedidos de la carta a la vez: la respuesta que llega tarde no pisa una más nueva.
    if (!replace && catalog.version < (this.status.catalog?.version ?? -1)) return
    const completed = completarCatalogo(catalog)
    await this.db.saveSetting(CLAVES.catalog, completed)
    this.patch({ catalog: completed })
  }

  /** Todo el catálogo, también lo archivado, para el editor de la carta. */
  async catalogForEditing(): Promise<CatalogoEdicion> {
    const c = await this.api<Partial<CatalogoEdicion> & { version: number }>(
      'GET',
      '/api/catalog/editing',
      { token: this.equipoActual().token },
    )
    return completarEdicion(c)
  }

  /**
   * Guarda cambios del catálogo (todos o ninguno) con la sesión abierta; el hub avisa a los
   * equipos y este también trae la carta nueva.
   */
  async editarCatalogo(changes: CatalogChange[]): Promise<number> {
    this.enabled()
    const session = this.status.session
    if (!session) throw new Error('Sin sesión: escribe tu PIN')
    const { version } = await this.api<{ version: number }>('POST', '/api/catalog/changes', {
      body: { session_id: session.sessionId, secret: session.secret, changes },
      token: this.equipoActual().token,
    })
    await this.actualizarCatalogo().catch(avisarFallo)
    return version
  }

  // ── Fotos y marca (tarea 1.3c) ───────────────────────────────────────

  /** Sube (o quita, con `null`) la foto de un producto; devuelve su ruta en el hub. */
  async subirFoto(productId: string, image: string | null): Promise<string | null> {
    const r = await this.withSession<{ photo: string | null }>('/api/catalog/photos', {
      product_id: productId,
      image,
    })
    await this.actualizarCatalogo().catch(avisarFallo)
    return r.photo
  }

  /** La marca con que se ve el POS en todos los equipos del restaurante. */
  async cambiarMarca(brand: string): Promise<void> {
    await this.withSession('/api/restaurant/brand', { brand })
    // Aquí se ve de una vez, aunque la carta nueva tarde en llegar; los demás equipos, con ella.
    const { catalog } = this.status
    if (catalog)
      this.patch({ catalog: { ...catalog, restaurant: { ...catalog.restaurant, brand } } })
    await this.actualizarCatalogo().catch(avisarFallo)
  }

  // ── Personal y roles (tarea 1.3b) ────────────────────────────────────

  /** Roles y personas, también los archivados (pide `manage_users`). */
  async staff(): Promise<Personal> {
    return this.withSession('/api/staff/read', {})
  }

  /** Crea un rol o cambia su nombre, sus permisos o si está activo. */
  async saveRole(role: {
    id?: string
    name: string
    permissions: string[]
    active?: boolean
  }): Promise<string> {
    return (await this.withSession<{ id: string }>('/api/staff/roles', { role })).id
  }

  /**
   * Crea o cambia a una persona. Devuelve su PIN si es nueva o se regeneró: solo se ve esta vez.
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
    // El nombre de cada persona viene en la carta: traerla para verlo en el salón.
    await this.actualizarCatalogo().catch(avisarFallo)
    return r
  }

  // ── Cocina e impresoras (ADR-015) ────────────────────────────────────

  kitchenConfig(): Promise<ConfiguracionCocina> {
    return this.withSession('/api/kitchen/config', {})
  }

  async savePrinter(printer: ImpresoraCocina): Promise<string> {
    const { id } = await this.withSession<{ id: string }>('/api/printers', { printer })
    return id
  }

  async testPrinter(printerId: string): Promise<void> {
    await this.withSession('/api/printers/test', { printer_id: printerId })
  }

  pendingPrints(): Promise<TrabajoPendiente[]> {
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

  // ── Reportes (tarea 1.9) ─────────────────────────────────────────────

  /** El reporte de un período; sin fechas, el día operativo de hoy. */
  report(period: { from: string; until: string } | null = null): Promise<PeriodReport> {
    return this.withSession('/api/reports', period ?? {})
  }

  async reimprimirCierre(shiftId: string): Promise<void> {
    await this.withSession('/api/reports/z-report', { shift_id: shiftId })
  }

  // ── Caja y pagos (tarea 1.6) ─────────────────────────────────────────

  registerConfig(): Promise<ConfiguracionCaja> {
    return this.withSession('/api/register/config', {})
  }

  async savePaymentMethods(methods: PaymentMethod[]): Promise<void> {
    await this.withSession('/api/register/payment-methods', { methods })
  }

  async guardarDatafono(cardTerminal: Datafono): Promise<ConfiguracionCaja['cardTerminals']> {
    const r = await this.withSession<{ cardTerminals: ConfiguracionCaja['cardTerminals'] }>(
      '/api/card-terminals',
      { cardTerminal },
    )
    return r.cardTerminals
  }

  async guardarMedioPropio(method: MedioPropio): Promise<MedioPropio[]> {
    const r = await this.withSession<{ custom_methods: MedioPropio[] }>(
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
   * Abre la caja de este equipo con la base en efectivo (`ShiftOpened`). La pantalla lo deja
   * solo con conexión, como cobrar: el hub rechaza un segundo turno de la misma caja.
   */
  async openShift(base: number): Promise<string> {
    const device = this.equipoActual()
    const shiftId = newId()
    await this.record('ShiftOpened', shiftId, { register_id: device.deviceId, base })
    return shiftId
  }

  /**
   * Este equipo pasa a ser pantalla de cocina de esas estaciones: la sesión del administrador se
   * cierra y queda la de la pantalla, que no vence por inactividad.
   */
  async convertToScreen(name: string, stationIds: string[]): Promise<void> {
    const r = await this.withSession<{
      session_id: string
      secret: string
      user: Session['user']
      permissions: string[]
    }>('/api/screens', { name, station_ids: stationIds })
    const device: Device = { ...this.equipoActual(), type: 'kds', name }
    await this.db.saveSetting(CLAVES.device, device)
    const session: Session = {
      sessionId: r.session_id,
      secret: r.secret,
      user: r.user,
      permissions: r.permissions,
      lastUsed: Date.now(),
    }
    await this.db.saveSetting(CLAVES.session, session)
    this.patch({ device, session, sessionClosedBy: null })
    await this.actualizarCatalogo().catch(() => {})
  }

  /** Retira un equipo (perdido, robado): deja de sincronizar y nadie puede entrar en él. */
  async retirarEquipo(deviceId: string): Promise<void> {
    await this.withSession(`/api/devices/${encodeURIComponent(deviceId)}/revoke`, {})
  }

  /** Una llamada con la sesión abierta. Si el hub dice que ya no vale, se pide entrar de nuevo. */
  private async withSession<T>(route: string, body: object): Promise<T> {
    this.enabled()
    const session = this.status.session
    if (!session) throw new Error('Sin sesión: vuelve a entrar')
    try {
      return await this.api<T>('POST', route, {
        body: { session_id: session.sessionId, secret: session.secret, ...body },
        token: this.equipoActual().token,
      })
    } catch (e) {
      if (e instanceof ErrorApi && e.code === 'invalid_session') await this.exit()
      throw e
    }
  }

  /** Trae la carta de nuevo; si falla, se queda la guardada (se reintenta al reconectar). */
  private traerCatalogoSiHaySesion() {
    if (this.status.session) this.actualizarCatalogo().catch(avisarFallo)
  }

  /** Si pasó el tiempo sin uso, se cierra la sesión: el siguiente toque pide el PIN. */
  vencerSesionSiToca(now = Date.now()) {
    const { session, catalog, device } = this.status
    // Una pantalla de cocina queda abierta siempre: nadie la usa con las manos sucias para entrar.
    if (!session || device?.type === 'kds') return
    const minutos = catalog?.restaurant.sessionIdleMin ?? MINUTOS_POR_DEFECTO
    if (now - session.lastUsed >= minutos * 60_000) this.exit('inactivity').catch(avisarFallo)
  }

  /** Marca uso (cada toque que hace algo): aplaza el cierre por inactividad. */
  enabled(now = Date.now()) {
    const { session } = this.status
    if (!session) return
    this.vencerSesionSiToca(now)
    // Cada toque cuenta, pero no hace falta escribir en IndexedDB con cada uno.
    if (!this.status.session || now - session.lastUsed < 15_000) return
    const newOne = { ...session, lastUsed: now }
    this.status = { ...this.status, session: newOne }
    this.db.saveSetting(CLAVES.session, newOne).catch(avisarFallo)
  }

  // ── Sincronización ───────────────────────────────────────────────────

  private async connect(device: Device) {
    this.connectionManager?.stop()
    // Cliente y gestor quedan asignados antes del primer `await`: otra llamada que llegue mientras
    // tanto detiene este gestor en vez de dejar un segundo WebSocket huérfano.
    const client = new SyncClient({
      store: this.store,
      token: device.token,
      versionApp: VERSION_APP,
      send: (m) => this.channel?.send(m),
      onChange: () => void this.alCambiarDatos().catch(avisarFallo),
      onHubError: (code, message) => {
        if (code === 'invalid_token' || code === 'outdated_app') connectionManager.stop()
        this.patch({ errorHub: { code, message } })
      },
      onFailure: (error) => console.error('Sincronización:', error),
    })
    const connectionManager = new ConnectionManager({
      open: this.open,
      onConnect: (channel) => {
        this.channel = channel
        void client.onConnect()
        // Pudo cambiar mientras no había conexión.
        this.traerCatalogoSiHaySesion()
      },
      onDisconnect: () => {
        this.channel = null
        client.onDisconnect()
      },
      onMessage: (m) => {
        if (m.type === 'catalog' && m.version !== this.status.catalog?.version)
          this.traerCatalogoSiHaySesion()
        if (m.type === 'printers') this.patch({ printers: m.printers })
        void client.receive(m)
      },
      onStateChange: (connection) => this.patch({ connection }),
    })
    this.client = client
    this.connectionManager = connectionManager
    await client.begin()
    if (this.connectionManager !== connectionManager) return
    if (!this.status.simulandoSinConexion) connectionManager.begin()
    await this.alCambiarDatos()
  }

  private async alCambiarDatos() {
    const pendingList = (await this.client?.pendingList()) ?? 0
    this.patch({ pendingList, changes: this.status.changes + 1 })
  }

  /** Para la demo: corta la conexión con el hub como si se cayera el Wi-Fi, y la devuelve. */
  simularSinConexion(without: boolean) {
    this.patch({ simulandoSinConexion: without })
    if (without) this.connectionManager?.stop()
    else this.connectionManager?.begin()
  }

  changeVisibility(visible: boolean) {
    this.connectionManager?.changeVisibility(visible)
    if (visible) this.vencerSesionSiToca()
  }

  /**
   * La hora del hub según este equipo (ms): los tiempos de cocina se miden contra la hora en que
   * el hub recibió la comanda, y una tablet con el reloj adelantado no debe verlo todo en ámbar.
   */
  ahoraHub(now = Date.now()): number {
    return this.client ? Date.parse(this.client.hubEstimatedTime(now)) : now
  }

  /** El cliente de sincronización (para leer pedidos y eventos locales). */
  get sync(): SyncClient | null {
    return this.client
  }

  /**
   * Crea un evento del pedido con su sobre completo, lo firma con el secreto de la sesión y lo
   * guarda (persistir antes de mostrar). Se envía solo cuando haya conexión.
   */
  async record<T extends OrderEventType>(
    type: T,
    orderId: string,
    data: Extract<NewEvent, { type: T }>['data'],
    options: OpcionesEvento = {},
  ): Promise<NewEvent> {
    const now = Date.now()
    // Primero el uso: si la sesión acaba de vencer, no se firma nada con ella.
    this.enabled(now)
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
    // Con el PIN de un supervisor (ADR-008): el hub da un comprobante de un solo uso para este
    // evento exacto (su huella), y el evento lo lleva. Pide conexión: sin ella, falla aquí.
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
    // Que el contador de pendientes ya lo cuente al volver.
    await this.alCambiarDatos()
    return signed
  }

  /**
   * Como `registrar`, pero espera a que el hub lo acepte: para el dinero (cobrar, cerrar la mesa)
   * no basta con guardarlo aquí, porque un pago que el hub rechaza desaparece de la cuenta. Si el
   * hub lo rechaza, falla con el motivo en palabras; si no responde a tiempo, falla diciendo que
   * quedó pendiente (no hay que cobrar otra vez).
   */
  async registrarConfirmado<T extends OrderEventType>(
    type: T,
    aggregateId: string,
    data: Extract<NewEvent, { type: T }>['data'],
    options: OpcionesEvento = {},
    waitMs = 10_000,
  ): Promise<NewEvent> {
    const event = await this.record(type, aggregateId, data as never, options)
    const limit = Date.now() + waitMs
    for (;;) {
      const local = (await this.client?.locals())?.find((l) => l.event.id === event.id)
      if (local?.status === 'confirmed') return event
      if (local?.status === 'rejected') throw new Error(motivoEnPalabras(local.reason))
      if (Date.now() > limit)
        throw new Error(
          'La caja no confirmó a tiempo. Quedó pendiente: revisa la cuenta en un momento antes de cobrar otra vez.',
        )
      await new Promise((r) => setTimeout(r, 150))
    }
  }

  /** Lo que va por HTTP al hub; con el corte simulado tampoco sale, como si no hubiera red. */
  private api<T>(...args: Parameters<typeof makeCall>): Promise<T> {
    if (this.status.simulandoSinConexion) return Promise.reject(new ErrorApi('offline', SIN_HUB))
    return makeCall<T>(...args)
  }

  private equipoActual(): Device {
    if (!this.status.device)
      throw new Error('Este equipo todavía no ha entrado: escribe tu PIN o tu contraseña')
    return this.status.device
  }
}

/** Por qué el hub rechazó un evento de dinero, dicho para la caja. */
function motivoEnPalabras(reason: string | undefined): string {
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
