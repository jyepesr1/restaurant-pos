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
  type Catalogo,
  type Channel,
  ClienteSync,
  type CodigoError,
  type EstadoConexion,
  type EstadoImpresora,
  GestorConexion,
  type Manejadores,
  type MensajeHub,
  type TipoDispositivo,
} from '@pos/sync'
import { AlmacenIndexedDb, BaseDispositivo } from './almacen'
import { ErrorApi, llamar, SIN_HUB } from './api'

// El motor de la app en el dispositivo: las credenciales del equipo, la sesión (PIN o contraseña), el
// catálogo guardado y la sincronización (ClienteSync sobre IndexedDB y un WebSocket que mantiene
// GestorConexion). La pantalla lo lee con `useSala` y crea eventos con `registrar`.

export const VERSION_APP = '0.10'

export interface Equipo {
  dispositivoId: string
  token: string
  name: string
  type: TipoDispositivo
}

export interface Sesion {
  sesionId: string
  secret: string
  user: { id: string; name: string; role: string }
  permissions: string[]
  /** Último uso en este dispositivo (ms): tras `sesionInactividadMin` sin uso se pide el PIN. */
  ultimoUso: number
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
    rolId: string
    active: boolean
    /** El usuario con que entra a la caja; `null` si entra con su PIN. */
    user: string | null
  }[]
  /** Los equipos que el hub registró, del usado más hace poco al que menos. */
  devices: {
    id: string
    name: string
    type: TipoDispositivo
    registradoEn: string | null
    revocadoEn: string | null
    ultimoUso: string | null
    ultimaPersona: string | null
  }[]
}

/** Un cambio del editor de la carta: crea el registro si no existe, o cambia esos campos. */
export interface CambioCatalogo {
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

interface Registro {
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
  zones: (Registro & { name: string; position: number; level: number })[]
  tables: (Registro &
    Geometria & { zone_id: string; name: string; shape: FormaMesa; capacity: number })[]
  elements: (Registro & Geometria & { zone_id: string; type: TipoElemento; text: string | null })[]
  taxes: (Registro & { name: string; type: 'inc' | 'iva' | 'exempt'; rate: number })[]
  stations: (Registro & { name: string; position: number })[]
  categories: (Registro & { name: string; position: number; station_id: string | null })[]
  products: (Registro & {
    category_id: string
    name: string
    description: string | null
    price: number
    tax_id: string
    favorite: boolean
    /** Nombre del archivo de su foto en el hub (`/fotos/<nombre>`), o nada. */
    photo?: string | null
  })[]
  variants: (Registro & { product_id: string; name: string; price: number; position: number })[]
  groups: (Registro & { name: string; minimum: number; maximum: number })[]
  links: (Registro & { product_id: string; group_id: string; position: number })[]
  modifiers: (Registro & {
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
  statuses: EstadoImpresora[]
  pantallas: {
    device_id: string
    name: string
    station_ids: string[]
    last_used: string | null
  }[]
  tiempos: { amarillo: number; rojo: number }
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
  abiertoPor: string
  cerradoPor: string
  base: number
  byMethod: ChargedByMethod[]
  closed: NonNullable<ShiftReconciliation['closed']>
}

/** El reporte de un período de días operativos (docs/KPIS.md). */
export interface Reporte {
  /** El día operativo de hoy según el hub. */
  today: string
  report: Report
  closings: CierreReporte[]
  /** Nombres de las personas que aparecen, por id. */
  usuarios: Record<string, string>
  /** Si hay impresora de precuentas para reimprimir el cierre Z. */
  printer: boolean
}

/** Una comanda que no ha salido de su impresora (`POST /api/impresion/pendientes`). */
export interface TrabajoPendiente {
  id: string
  printer: string
  que: string
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
  device: Equipo | null
  session: Sesion | null
  catalog: Catalogo | null
  connection: EstadoConexion
  /** El usuario apagó la conexión para la demo (docs/ROADMAP.md, 0.10). */
  simulandoSinConexion: boolean
  pendingList: number
  /** Sube cada vez que algo cambia en lo guardado: la pantalla relee. */
  changes: number
  /** Por qué se cerró la última sesión, para explicarlo en la pantalla del PIN. */
  sessionClosedBy: 'inactivity' | null
  /** El hub rechazó al equipo (token inválido o revocado, app vieja). */
  errorHub: { code: CodigoError; message: string } | null
  /** Cómo están las impresoras de comandas, según el último aviso del hub (ADR-015). */
  printers: EstadoImpresora[]
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
export function completarCatalogo(c: Catalogo): Catalogo {
  const oldOne = c as Partial<Catalogo> &
    Pick<Catalogo, 'version' | 'restaurant' | 'stations' | 'categories'>
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

function abrirWebSocket(m: Manejadores): Channel {
  const esquema = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${esquema}://${location.host}/api/sync/ws`)
  ws.onopen = () => m.alAbrir()
  ws.onclose = () => m.alCerrar()
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
      m.alMensaje(message as MensajeHub)
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
  private readonly almacen: AlmacenIndexedDb
  private readonly open: (m: Manejadores) => Channel
  private cliente: ClienteSync | null = null
  private gestor: GestorConexion | null = null
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

  constructor(options: { db?: BaseDispositivo; open?: (m: Manejadores) => Channel } = {}) {
    this.db = options.db ?? new BaseDispositivo()
    this.almacen = new AlmacenIndexedDb(this.db)
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
  cargar(): Promise<void> {
    this.cargando ??= this.hacerCarga()
    return this.cargando
  }

  private async hacerCarga() {
    const [device, session, catalog] = await Promise.all([
      this.db.leerAjuste<Equipo>(CLAVES.device),
      this.db.leerAjuste<Sesion>(CLAVES.session),
      this.db.leerAjuste<Catalogo>(CLAVES.catalog),
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
  async emparejar(code: string) {
    const r = await this.api<{
      device_id: string
      token: string
      name: string
      type: TipoDispositivo
    }>('POST', '/api/pair', { cuerpo: { code: code.trim().toUpperCase() } })
    const device: Equipo = {
      dispositivoId: r.device_id,
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
  async emparejarPrimero(pin: string, name: string, type: TipoDispositivo) {
    const { code } = await this.api<{ code: string }>('POST', '/api/pairings', {
      cuerpo: { pin, name, type },
    })
    await this.emparejar(code)
  }

  /** Desde un equipo emparejado (la caja), un administrador aprueba otro equipo con su PIN. */
  async codigoParaOtroEquipo(pin: string, name: string, type: TipoDispositivo) {
    return this.api<{ code: string; expires_at: string }>('POST', '/api/pairings', {
      cuerpo: { pin, name, type },
      token: this.equipoActual().token,
    })
  }

  /**
   * Entra con el PIN (meseros) o con usuario y contraseña (requiere el hub) y trae el catálogo.
   * Un navegador sin equipo no se empareja antes: con el acierto, el hub lo registra y le da su
   * token (ADR-013).
   */
  async entrar(data: string | { user: string; password: string }) {
    const device = this.status.device
    const r = await this.api<{
      device: {
        device_id: string
        token: string
        name: string
        type: TipoDispositivo
      } | null
      type: TipoDispositivo
      session_id: string
      secret: string
      user: Sesion['user']
      permissions: string[]
    }>('POST', '/api/sign-in', {
      cuerpo: typeof data === 'string' ? { pin: data } : data,
      token: device?.token,
    })
    const fresh: Equipo | null = r.device
      ? {
          dispositivoId: r.device.device_id,
          token: r.device.token,
          name: r.device.name,
          type: r.device.type,
        }
      : device && device.type !== r.type
        ? { ...device, type: r.type }
        : null
    // Primero el equipo: sin él, la sesión no sirve de nada.
    if (fresh) await this.db.saveSetting(CLAVES.device, fresh)
    const session: Sesion = {
      sesionId: r.session_id,
      secret: r.secret,
      user: r.user,
      permissions: r.permissions,
      ultimoUso: Date.now(),
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
    this.gestor?.detener()
    this.gestor = null
    this.cliente = null
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
        cuerpo: { session_id: session.sesionId, secret: session.secret },
        token: this.status.device.token,
      }).catch(() => {})
  }

  /** Trae la carta del hub. Con `reemplazar`, aunque su versión sea menor que la guardada. */
  async actualizarCatalogo(reemplazar = false) {
    const catalog = await this.api<Catalogo | undefined>('GET', '/api/catalog', {
      token: this.equipoActual().token,
    })
    // Una respuesta rara no reemplaza la carta buena que ya está guardada.
    if (typeof catalog?.version !== 'number' || !Array.isArray(catalog.tables))
      throw new ErrorApi(
        'invalid_response',
        'La caja respondió algo que no es la carta: intenta de nuevo',
      )
    // Dos pedidos de la carta a la vez: la respuesta que llega tarde no pisa una más nueva.
    if (!reemplazar && catalog.version < (this.status.catalog?.version ?? -1)) return
    const completo = completarCatalogo(catalog)
    await this.db.saveSetting(CLAVES.catalog, completo)
    this.patch({ catalog: completo })
  }

  /** Todo el catálogo, también lo archivado, para el editor de la carta. */
  async catalogoParaEditar(): Promise<CatalogoEdicion> {
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
  async editarCatalogo(changes: CambioCatalogo[]): Promise<number> {
    this.usar()
    const session = this.status.session
    if (!session) throw new Error('Sin sesión: escribe tu PIN')
    const { version } = await this.api<{ version: number }>('POST', '/api/catalog/changes', {
      cuerpo: { session_id: session.sesionId, secret: session.secret, changes },
      token: this.equipoActual().token,
    })
    await this.actualizarCatalogo().catch(avisarFallo)
    return version
  }

  // ── Fotos y marca (tarea 1.3c) ───────────────────────────────────────

  /** Sube (o quita, con `null`) la foto de un producto; devuelve su ruta en el hub. */
  async subirFoto(productId: string, imagen: string | null): Promise<string | null> {
    const r = await this.conSesion<{ photo: string | null }>('/api/catalog/photos', {
      product_id: productId,
      imagen,
    })
    await this.actualizarCatalogo().catch(avisarFallo)
    return r.photo
  }

  /** La marca con que se ve el POS en todos los equipos del restaurante. */
  async cambiarMarca(brand: string): Promise<void> {
    await this.conSesion('/api/restaurant/brand', { brand })
    // Aquí se ve de una vez, aunque la carta nueva tarde en llegar; los demás equipos, con ella.
    const { catalog } = this.status
    if (catalog)
      this.patch({ catalog: { ...catalog, restaurant: { ...catalog.restaurant, brand } } })
    await this.actualizarCatalogo().catch(avisarFallo)
  }

  // ── Personal y roles (tarea 1.3b) ────────────────────────────────────

  /** Roles y personas, también los archivados (pide `manage_users`). */
  async staff(): Promise<Personal> {
    return this.conSesion('/api/staff/read', {})
  }

  /** Crea un rol o cambia su nombre, sus permisos o si está activo. */
  async guardarRol(role: {
    id?: string
    name: string
    permissions: string[]
    active?: boolean
  }): Promise<string> {
    return (await this.conSesion<{ id: string }>('/api/staff/roles', { role })).id
  }

  /**
   * Crea o cambia a una persona. Devuelve su PIN si es nueva o se regeneró: solo se ve esta vez.
   */
  async guardarPersona(person: {
    id?: string
    name: string
    role_id: string
    active?: boolean
    access?: { type: 'pin' } | { type: 'password'; user: string; password?: string }
    regenerar_pin?: boolean
  }): Promise<{ id: string; pin: string | null }> {
    const r = await this.conSesion<{ id: string; pin: string | null }>('/api/staff/people', {
      person,
    })
    // El nombre de cada persona viene en la carta: traerla para verlo en el salón.
    await this.actualizarCatalogo().catch(avisarFallo)
    return r
  }

  // ── Cocina e impresoras (ADR-015) ────────────────────────────────────

  kitchenConfig(): Promise<ConfiguracionCocina> {
    return this.conSesion('/api/kitchen/config', {})
  }

  async savePrinter(printer: ImpresoraCocina): Promise<string> {
    const { id } = await this.conSesion<{ id: string }>('/api/printers', { printer })
    return id
  }

  async testPrinter(impresoraId: string): Promise<void> {
    await this.conSesion('/api/printers/test', { printer_id: impresoraId })
  }

  pendingPrints(): Promise<TrabajoPendiente[]> {
    return this.conSesion('/api/printing/pending', {})
  }

  async discardJob(trabajoId: string): Promise<void> {
    await this.conSesion('/api/printing/discard', { trabajo_id: trabajoId })
  }

  async screenStations(dispositivoId: string, estacionIds: string[]): Promise<void> {
    await this.conSesion('/api/screens/stations', {
      device_id: dispositivoId,
      station_ids: estacionIds,
    })
  }

  async usarCursos(usar: boolean): Promise<void> {
    await this.conSesion('/api/kitchen/courses', { usar })
  }

  async kitchenTimers(amarillo: number, rojo: number): Promise<void> {
    await this.conSesion('/api/kitchen/timers', { amarillo, rojo })
  }

  // ── Reportes (tarea 1.9) ─────────────────────────────────────────────

  /** El reporte de un período; sin fechas, el día operativo de hoy. */
  report(period: { from: string; until: string } | null = null): Promise<Reporte> {
    return this.conSesion('/api/reports', period ?? {})
  }

  async reimprimirCierre(shiftId: string): Promise<void> {
    await this.conSesion('/api/reports/z-report', { turno_id: shiftId })
  }

  // ── Caja y pagos (tarea 1.6) ─────────────────────────────────────────

  registerConfig(): Promise<ConfiguracionCaja> {
    return this.conSesion('/api/register/config', {})
  }

  async savePaymentMethods(medios: PaymentMethod[]): Promise<void> {
    await this.conSesion('/api/register/payment-methods', { medios })
  }

  async guardarDatafono(cardTerminal: Datafono): Promise<ConfiguracionCaja['cardTerminals']> {
    const r = await this.conSesion<{ cardTerminals: ConfiguracionCaja['cardTerminals'] }>(
      '/api/card-terminals',
      { cardTerminal },
    )
    return r.cardTerminals
  }

  async guardarMedioPropio(method: MedioPropio): Promise<MedioPropio[]> {
    const r = await this.conSesion<{ custom_methods: MedioPropio[] }>(
      '/api/register/custom-methods',
      {
        method,
      },
    )
    return r.custom_methods
  }

  async umbralDiferencia(pesos: number): Promise<void> {
    await this.conSesion('/api/register/threshold', { pesos })
  }

  async suggestedTip(puntos: number): Promise<void> {
    await this.conSesion('/api/register/tip', { puntos })
  }

  async preBillPrinter(impresoraId: string | null): Promise<void> {
    await this.conSesion('/api/register/pre-bill', { printer_id: impresoraId })
  }

  /**
   * Abre la caja de este equipo con la base en efectivo (`ShiftOpened`). La pantalla lo deja
   * solo con conexión, como cobrar: el hub rechaza un segundo turno de la misma caja.
   */
  async abrirTurno(base: number): Promise<string> {
    const device = this.equipoActual()
    const shiftId = newId()
    await this.record('ShiftOpened', shiftId, { register_id: device.dispositivoId, base })
    return shiftId
  }

  /**
   * Este equipo pasa a ser pantalla de cocina de esas estaciones: la sesión del administrador se
   * cierra y queda la de la pantalla, que no vence por inactividad.
   */
  async convertirEnPantalla(name: string, estacionIds: string[]): Promise<void> {
    const r = await this.conSesion<{
      session_id: string
      secret: string
      user: Sesion['user']
      permissions: string[]
    }>('/api/screens', { name, station_ids: estacionIds })
    const device: Equipo = { ...this.equipoActual(), type: 'kds', name }
    await this.db.saveSetting(CLAVES.device, device)
    const session: Sesion = {
      sesionId: r.session_id,
      secret: r.secret,
      user: r.user,
      permissions: r.permissions,
      ultimoUso: Date.now(),
    }
    await this.db.saveSetting(CLAVES.session, session)
    this.patch({ device, session, sessionClosedBy: null })
    await this.actualizarCatalogo().catch(() => {})
  }

  /** Retira un equipo (perdido, robado): deja de sincronizar y nadie puede entrar en él. */
  async retirarEquipo(dispositivoId: string): Promise<void> {
    await this.conSesion(`/api/devices/${encodeURIComponent(dispositivoId)}/revoke`, {})
  }

  /** Una llamada con la sesión abierta. Si el hub dice que ya no vale, se pide entrar de nuevo. */
  private async conSesion<T>(ruta: string, cuerpo: object): Promise<T> {
    this.usar()
    const session = this.status.session
    if (!session) throw new Error('Sin sesión: vuelve a entrar')
    try {
      return await this.api<T>('POST', ruta, {
        cuerpo: { session_id: session.sesionId, secret: session.secret, ...cuerpo },
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
  vencerSesionSiToca(ahora = Date.now()) {
    const { session, catalog, device } = this.status
    // Una pantalla de cocina queda abierta siempre: nadie la usa con las manos sucias para entrar.
    if (!session || device?.type === 'kds') return
    const minutos = catalog?.restaurant.sesionInactividadMin ?? MINUTOS_POR_DEFECTO
    if (ahora - session.ultimoUso >= minutos * 60_000) this.exit('inactivity').catch(avisarFallo)
  }

  /** Marca uso (cada toque que hace algo): aplaza el cierre por inactividad. */
  usar(ahora = Date.now()) {
    const { session } = this.status
    if (!session) return
    this.vencerSesionSiToca(ahora)
    // Cada toque cuenta, pero no hace falta escribir en IndexedDB con cada uno.
    if (!this.status.session || ahora - session.ultimoUso < 15_000) return
    const newOne = { ...session, ultimoUso: ahora }
    this.status = { ...this.status, session: newOne }
    this.db.saveSetting(CLAVES.session, newOne).catch(avisarFallo)
  }

  // ── Sincronización ───────────────────────────────────────────────────

  private async connect(device: Equipo) {
    this.gestor?.detener()
    // Cliente y gestor quedan asignados antes del primer `await`: otra llamada que llegue mientras
    // tanto detiene este gestor en vez de dejar un segundo WebSocket huérfano.
    const cliente = new ClienteSync({
      almacen: this.almacen,
      token: device.token,
      versionApp: VERSION_APP,
      send: (m) => this.channel?.send(m),
      onChange: () => void this.alCambiarDatos().catch(avisarFallo),
      onHubError: (code, message) => {
        if (code === 'invalid_token' || code === 'outdated_app') gestor.detener()
        this.patch({ errorHub: { code, message } })
      },
      onFailure: (error) => console.error('Sincronización:', error),
    })
    const gestor = new GestorConexion({
      open: this.open,
      alConectar: (channel) => {
        this.channel = channel
        void cliente.alConectar()
        // Pudo cambiar mientras no había conexión.
        this.traerCatalogoSiHaySesion()
      },
      alDesconectar: () => {
        this.channel = null
        cliente.alDesconectar()
      },
      alMensaje: (m) => {
        if (m.type === 'catalog' && m.version !== this.status.catalog?.version)
          this.traerCatalogoSiHaySesion()
        if (m.type === 'printers') this.patch({ printers: m.printers })
        void cliente.recibir(m)
      },
      alCambiarEstado: (connection) => this.patch({ connection }),
    })
    this.cliente = cliente
    this.gestor = gestor
    await cliente.begin()
    if (this.gestor !== gestor) return
    if (!this.status.simulandoSinConexion) gestor.begin()
    await this.alCambiarDatos()
  }

  private async alCambiarDatos() {
    const pendingList = (await this.cliente?.pendingList()) ?? 0
    this.patch({ pendingList, changes: this.status.changes + 1 })
  }

  /** Para la demo: corta la conexión con el hub como si se cayera el Wi-Fi, y la devuelve. */
  simularSinConexion(without: boolean) {
    this.patch({ simulandoSinConexion: without })
    if (without) this.gestor?.detener()
    else this.gestor?.begin()
  }

  cambiarVisibilidad(visible: boolean) {
    this.gestor?.cambiarVisibilidad(visible)
    if (visible) this.vencerSesionSiToca()
  }

  /**
   * La hora del hub según este equipo (ms): los tiempos de cocina se miden contra la hora en que
   * el hub recibió la comanda, y una tablet con el reloj adelantado no debe verlo todo en ámbar.
   */
  ahoraHub(ahora = Date.now()): number {
    return this.cliente ? Date.parse(this.cliente.horaEstimadaHub(ahora)) : ahora
  }

  /** El cliente de sincronización (para leer pedidos y eventos locales). */
  get sync(): ClienteSync | null {
    return this.cliente
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
    const ahora = Date.now()
    // Primero el uso: si la sesión acaba de vencer, no se firma nada con ella.
    this.usar(ahora)
    const cliente = this.cliente
    const { session, device } = this.status
    if (!cliente || !session || !device) throw new Error('Sin sesión: escribe tu PIN')
    const event = {
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: aggregateOf(type),
      aggregate_id: orderId,
      related: options.related ?? [],
      data,
      session_id: session.sesionId,
      user_id: session.user.id,
      device_id: device.dispositivoId,
      authorization_id: null,
      reason: options.reason ?? null,
      device_time: new Date(ahora).toISOString(),
      hub_estimated_time: cliente.horaEstimadaHub(ahora),
      base_sequence: await cliente.conocido(),
    } as NewEvent
    // Con el PIN de un supervisor (ADR-008): el hub da un comprobante de un solo uso para este
    // evento exacto (su huella), y el evento lo lleva. Pide conexión: sin ella, falla aquí.
    if (options.authorizes) {
      const { authorization_id } = await this.conSesion<{ authorization_id: string }>(
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
    const firmado = { ...event, signature: signEvent(event, session.secret) } as NewEvent
    const r = await cliente.record(firmado)
    if (!r.ok) throw new Error(`Evento inválido: ${r.errors.join('; ')}`)
    // Que el contador de pendientes ya lo cuente al volver.
    await this.alCambiarDatos()
    return firmado
  }

  /**
   * Como `registrar`, pero espera a que el hub lo acepte: para el dinero (cobrar, cerrar la mesa)
   * no basta con guardarlo aquí, porque un pago que el hub rechaza desaparece de la cuenta. Si el
   * hub lo rechaza, falla con el motivo en palabras; si no responde a tiempo, falla diciendo que
   * quedó pendiente (no hay que cobrar otra vez).
   */
  async registrarConfirmado<T extends OrderEventType>(
    type: T,
    agregadoId: string,
    data: Extract<NewEvent, { type: T }>['data'],
    options: OpcionesEvento = {},
    esperaMs = 10_000,
  ): Promise<NewEvent> {
    const event = await this.record(type, agregadoId, data as never, options)
    const limite = Date.now() + esperaMs
    for (;;) {
      const local = (await this.cliente?.locales())?.find((l) => l.event.id === event.id)
      if (local?.status === 'confirmed') return event
      if (local?.status === 'rejected') throw new Error(motivoEnPalabras(local.reason))
      if (Date.now() > limite)
        throw new Error(
          'La caja no confirmó a tiempo. Quedó pendiente: revisa la cuenta en un momento antes de cobrar otra vez.',
        )
      await new Promise((r) => setTimeout(r, 150))
    }
  }

  /** Lo que va por HTTP al hub; con el corte simulado tampoco sale, como si no hubiera red. */
  private api<T>(...args: Parameters<typeof llamar>): Promise<T> {
    if (this.status.simulandoSinConexion) return Promise.reject(new ErrorApi('offline', SIN_HUB))
    return llamar<T>(...args)
  }

  private equipoActual(): Equipo {
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
