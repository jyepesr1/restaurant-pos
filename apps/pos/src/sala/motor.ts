import {
  agregadoDe,
  type EventoNuevo,
  firmarEvento,
  nuevoId,
  type TipoEventoPedido,
} from '@pos/core'
import {
  type Canal,
  type Catalogo,
  ClienteSync,
  type CodigoError,
  type EstadoConexion,
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
  nombre: string
  tipo: TipoDispositivo
}

export interface Sesion {
  sesionId: string
  secreto: string
  usuario: { id: string; nombre: string; rol: string }
  permisos: string[]
  /** Último uso en este dispositivo (ms): tras `sesionInactividadMin` sin uso se pide el PIN. */
  ultimoUso: number
}

/** Lo que devuelve `POST /api/personal/leer`. */
export interface Personal {
  roles: {
    id: string
    nombre: string
    /** De fábrica: no se renombra ni se archiva. */
    sistema: boolean
    activo: boolean
    permisos: string[]
    personas: number
  }[]
  personas: {
    id: string
    nombre: string
    rolId: string
    activo: boolean
    /** El usuario con que entra a la caja; `null` si entra con su PIN. */
    usuario: string | null
  }[]
  /** Los equipos que el hub registró, del usado más hace poco al que menos. */
  equipos: {
    id: string
    nombre: string
    tipo: TipoDispositivo
    registradoEn: string | null
    revocadoEn: string | null
    ultimoUso: string | null
    ultimaPersona: string | null
  }[]
}

/** Un cambio del editor de la carta: crea el registro si no existe, o cambia esos campos. */
export interface CambioCatalogo {
  entidad:
    | 'zona'
    | 'mesa'
    | 'elemento_plano'
    | 'impuesto'
    | 'estacion'
    | 'categoria'
    | 'producto'
    | 'variante'
    | 'grupo_modificador'
    | 'producto_grupo_modificador'
    | 'modificador'
  id: string
  datos: Record<string, string | number | boolean | null>
}

interface Registro {
  id: string
  version: number
  activo: boolean
}

/** Lo que devuelve `GET /api/catalogo/edicion`: las filas del catálogo, también las archivadas. */
export type FormaMesa = 'redonda' | 'cuadrada' | 'rectangular' | 'barra'
export type TipoElemento = 'pared' | 'puerta' | 'planta' | 'barra' | 'texto'

/** Geometría en el plano, en centímetros: esquina superior izquierda, medidas y giro en grados. */
export interface Geometria {
  x: number
  y: number
  ancho: number
  alto: number
  rotacion: number
}

export interface CatalogoEdicion {
  version: number
  zonas: (Registro & { nombre: string; orden: number; piso: number })[]
  mesas: (Registro &
    Geometria & { zona_id: string; nombre: string; forma: FormaMesa; capacidad: number })[]
  elementos: (Registro &
    Geometria & { zona_id: string; tipo: TipoElemento; texto: string | null })[]
  impuestos: (Registro & { nombre: string; tipo: 'inc' | 'iva' | 'exento'; tarifa: number })[]
  estaciones: (Registro & { nombre: string; orden: number })[]
  categorias: (Registro & { nombre: string; orden: number; estacion_id: string | null })[]
  productos: (Registro & {
    categoria_id: string
    nombre: string
    descripcion: string | null
    precio: number
    impuesto_id: string
    favorito: boolean
  })[]
  variantes: (Registro & { producto_id: string; nombre: string; precio: number; orden: number })[]
  grupos: (Registro & { nombre: string; minimo: number; maximo: number })[]
  enlaces: (Registro & { producto_id: string; grupo_id: string; orden: number })[]
  modificadores: (Registro & {
    grupo_id: string
    nombre: string
    precio_extra: number
    orden: number
  })[]
}

export interface Instantanea {
  cargado: boolean
  equipo: Equipo | null
  sesion: Sesion | null
  catalogo: Catalogo | null
  conexion: EstadoConexion
  /** El usuario apagó la conexión para la demo (docs/ROADMAP.md, 0.10). */
  simulandoSinConexion: boolean
  pendientes: number
  /** Sube cada vez que algo cambia en lo guardado: la pantalla relee. */
  cambios: number
  /** Por qué se cerró la última sesión, para explicarlo en la pantalla del PIN. */
  sesionCerradaPor: 'inactividad' | null
  /** El hub rechazó al equipo (token inválido o revocado, app vieja). */
  errorHub: { codigo: CodigoError; mensaje: string } | null
}

const MINUTOS_POR_DEFECTO = 30

/** Lo que falte en el catálogo de edición (un hub de otra versión) se toma como vacío. */
export function completarEdicion(
  c: Partial<CatalogoEdicion> & { version: number },
): CatalogoEdicion {
  return {
    version: c.version,
    zonas: c.zonas ?? [],
    mesas: c.mesas ?? [],
    elementos: c.elementos ?? [],
    impuestos: c.impuestos ?? [],
    estaciones: c.estaciones ?? [],
    categorias: c.categorias ?? [],
    productos: c.productos ?? [],
    variantes: c.variantes ?? [],
    grupos: c.grupos ?? [],
    enlaces: c.enlaces ?? [],
    modificadores: c.modificadores ?? [],
  }
}

/**
 * Una carta guardada por una versión anterior de la app puede no traer lo que se agregó después
 * (el plano de la 1.2): se completa con lo vacío hasta que llegue la del hub. Así una
 * actualización no deja la pantalla en blanco.
 */
export function completarCatalogo(c: Catalogo): Catalogo {
  const viejo = c as Partial<Catalogo> &
    Pick<Catalogo, 'version' | 'restaurante' | 'estaciones' | 'categorias'>
  return {
    ...c,
    zonas: (viejo.zonas ?? []).map((z) => ({ ...z, piso: z.piso ?? 1 })),
    mesas: (viejo.mesas ?? []).map((m) => ({
      ...m,
      ancho: m.ancho ?? 80,
      alto: m.alto ?? 80,
      rotacion: m.rotacion ?? 0,
    })),
    elementos: viejo.elementos ?? [],
    personal: viejo.personal ?? [],
  }
}

/** Un trabajo de fondo falló (IndexedDB lleno o cerrado): queda en la consola. */
const avisarFallo = (error: unknown) => console.error('Equipo:', error)
const CLAVES = { equipo: 'equipo', sesion: 'sesion', catalogo: 'catalogo' }

function abrirWebSocket(m: Manejadores): Canal {
  const esquema = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${esquema}://${location.host}/api/sync/ws`)
  ws.onopen = () => m.alAbrir()
  ws.onclose = () => m.alCerrar()
  ws.onmessage = (e) => {
    // El hub es propio y está en la red local: basta descartar lo que no es un mensaje. Validar
    // cada tipo con su esquema queda pendiente (docs/ROADMAP.md, 0.10).
    let mensaje: unknown
    try {
      mensaje = JSON.parse(String(e.data))
    } catch {
      return
    }
    if (typeof mensaje === 'object' && mensaje !== null && 'tipo' in mensaje)
      m.alMensaje(mensaje as MensajeHub)
  }
  return {
    enviar: (mensaje) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(mensaje))
    },
    cerrar: () => ws.close(),
  }
}

export class Sala {
  private readonly db: BaseDispositivo
  private readonly almacen: AlmacenIndexedDb
  private readonly abrir: (m: Manejadores) => Canal
  private cliente: ClienteSync | null = null
  private gestor: GestorConexion | null = null
  private canal: Canal | null = null
  private estado: Instantanea = {
    cargado: false,
    equipo: null,
    sesion: null,
    catalogo: null,
    conexion: 'desconectado',
    simulandoSinConexion: false,
    pendientes: 0,
    cambios: 0,
    sesionCerradaPor: null,
    errorHub: null,
  }
  private readonly oyentes = new Set<() => void>()
  private cargando: Promise<void> | null = null

  constructor(opciones: { db?: BaseDispositivo; abrir?: (m: Manejadores) => Canal } = {}) {
    this.db = opciones.db ?? new BaseDispositivo()
    this.almacen = new AlmacenIndexedDb(this.db)
    this.abrir = opciones.abrir ?? abrirWebSocket
  }

  // ── Para React (useSyncExternalStore) ────────────────────────────────

  suscribir = (oyente: () => void) => {
    this.oyentes.add(oyente)
    return () => this.oyentes.delete(oyente)
  }

  instantanea = () => this.estado

  private cambiar(parcial: Partial<Instantanea>) {
    this.estado = { ...this.estado, ...parcial }
    for (const o of this.oyentes) o()
  }

  // ── Arranque ─────────────────────────────────────────────────────────

  /** Abre lo guardado y empieza a sincronizar. Llamarla varias veces da la misma carga. */
  cargar(): Promise<void> {
    this.cargando ??= this.hacerCarga()
    return this.cargando
  }

  private async hacerCarga() {
    const [equipo, sesion, catalogo] = await Promise.all([
      this.db.leerAjuste<Equipo>(CLAVES.equipo),
      this.db.leerAjuste<Sesion>(CLAVES.sesion),
      this.db.leerAjuste<Catalogo>(CLAVES.catalogo),
    ])
    this.cambiar({
      cargado: true,
      equipo: equipo ?? null,
      sesion: sesion ?? null,
      catalogo: catalogo ? completarCatalogo(catalogo) : null,
    })
    this.vencerSesionSiToca()
    if (equipo) await this.conectar(equipo)
  }

  /** Cambia el código de emparejamiento por el token propio y empieza a sincronizar. */
  async emparejar(codigo: string) {
    const r = await this.api<{
      dispositivo_id: string
      token: string
      nombre: string
      tipo: TipoDispositivo
    }>('POST', '/api/emparejar', { cuerpo: { codigo: codigo.trim().toUpperCase() } })
    const equipo: Equipo = {
      dispositivoId: r.dispositivo_id,
      token: r.token,
      nombre: r.nombre,
      tipo: r.tipo,
    }
    await this.db.guardarAjuste(CLAVES.equipo, equipo)
    this.cambiar({ equipo, errorHub: null })
    await this.conectar(equipo)
  }

  /**
   * El primer equipo de un hub recién instalado se aprueba a sí mismo con el PIN del
   * administrador (los demás, desde la caja con `codigoParaOtroEquipo`).
   */
  async emparejarPrimero(pin: string, nombre: string, tipo: TipoDispositivo) {
    const { codigo } = await this.api<{ codigo: string }>('POST', '/api/emparejamientos', {
      cuerpo: { pin, nombre, tipo },
    })
    await this.emparejar(codigo)
  }

  /** Desde un equipo emparejado (la caja), un administrador aprueba otro equipo con su PIN. */
  async codigoParaOtroEquipo(pin: string, nombre: string, tipo: TipoDispositivo) {
    return this.api<{ codigo: string; vence_en: string }>('POST', '/api/emparejamientos', {
      cuerpo: { pin, nombre, tipo },
      token: this.equipoActual().token,
    })
  }

  /**
   * Entra con el PIN (meseros) o con usuario y contraseña (requiere el hub) y trae el catálogo.
   * Un navegador sin equipo no se empareja antes: con el acierto, el hub lo registra y le da su
   * token (ADR-013).
   */
  async entrar(datos: string | { usuario: string; contrasena: string }) {
    const equipo = this.estado.equipo
    const r = await this.api<{
      equipo: {
        dispositivo_id: string
        token: string
        nombre: string
        tipo: TipoDispositivo
      } | null
      tipo: TipoDispositivo
      sesion_id: string
      secreto: string
      usuario: Sesion['usuario']
      permisos: string[]
    }>('POST', '/api/entrar', {
      cuerpo: typeof datos === 'string' ? { pin: datos } : datos,
      token: equipo?.token,
    })
    const nuevo: Equipo | null = r.equipo
      ? {
          dispositivoId: r.equipo.dispositivo_id,
          token: r.equipo.token,
          nombre: r.equipo.nombre,
          tipo: r.equipo.tipo,
        }
      : equipo && equipo.tipo !== r.tipo
        ? { ...equipo, tipo: r.tipo }
        : null
    // Primero el equipo: sin él, la sesión no sirve de nada.
    if (nuevo) await this.db.guardarAjuste(CLAVES.equipo, nuevo)
    const sesion: Sesion = {
      sesionId: r.sesion_id,
      secreto: r.secreto,
      usuario: r.usuario,
      permisos: r.permisos,
      ultimoUso: Date.now(),
    }
    await this.db.guardarAjuste(CLAVES.sesion, sesion)
    this.cambiar({
      ...(nuevo ? { equipo: nuevo, errorHub: null } : {}),
      sesion,
      sesionCerradaPor: null,
    })
    if (r.equipo && nuevo) await this.conectar(nuevo)
    await this.actualizarCatalogo().catch(() => {})
  }

  /**
   * El hub ya no reconoce el token (se reinstaló o retiró el equipo): se olvidan las credenciales
   * para emparejar de nuevo. Lo pendiente queda guardado, pero lleva el `dispositivo_id` viejo:
   * el hub lo rechazará (`dispositivo_distinto`). La pantalla lo advierte antes.
   */
  async olvidarEquipo() {
    this.gestor?.detener()
    this.gestor = null
    this.cliente = null
    await Promise.all([this.db.borrarAjuste(CLAVES.equipo), this.db.borrarAjuste(CLAVES.sesion)])
    this.cambiar({ equipo: null, sesion: null, errorHub: null, conexion: 'desconectado' })
  }

  /** Cierra la sesión aquí (olvida el secreto) y avisa al hub si se puede. */
  async salir(por: Instantanea['sesionCerradaPor'] = null) {
    const sesion = this.estado.sesion
    // Primero en pantalla: una sesión vencida no debe dejar crear nada mientras se borra.
    this.cambiar({ sesion: null, sesionCerradaPor: por })
    await this.db.borrarAjuste(CLAVES.sesion)
    if (sesion && this.estado.equipo)
      await this.api('POST', '/api/sesiones/cerrar', {
        cuerpo: { sesion_id: sesion.sesionId, secreto: sesion.secreto },
        token: this.estado.equipo.token,
      }).catch(() => {})
  }

  async actualizarCatalogo() {
    const catalogo = await this.api<Catalogo | undefined>('GET', '/api/catalogo', {
      token: this.equipoActual().token,
    })
    // Una respuesta rara no reemplaza la carta buena que ya está guardada.
    if (typeof catalogo?.version !== 'number' || !Array.isArray(catalogo.mesas))
      throw new ErrorApi(
        'respuesta_invalida',
        'La caja respondió algo que no es la carta: intenta de nuevo',
      )
    // Dos pedidos de la carta a la vez: la respuesta que llega tarde no pisa una más nueva.
    if (catalogo.version < (this.estado.catalogo?.version ?? -1)) return
    const completo = completarCatalogo(catalogo)
    await this.db.guardarAjuste(CLAVES.catalogo, completo)
    this.cambiar({ catalogo: completo })
  }

  /** Todo el catálogo, también lo archivado, para el editor de la carta. */
  async catalogoParaEditar(): Promise<CatalogoEdicion> {
    const c = await this.api<Partial<CatalogoEdicion> & { version: number }>(
      'GET',
      '/api/catalogo/edicion',
      { token: this.equipoActual().token },
    )
    return completarEdicion(c)
  }

  /**
   * Guarda cambios del catálogo (todos o ninguno) con la sesión abierta; el hub avisa a los
   * equipos y este también trae la carta nueva.
   */
  async editarCatalogo(cambios: CambioCatalogo[]): Promise<number> {
    this.usar()
    const sesion = this.estado.sesion
    if (!sesion) throw new Error('Sin sesión: escribe tu PIN')
    const { version } = await this.api<{ version: number }>('POST', '/api/catalogo/cambios', {
      cuerpo: { sesion_id: sesion.sesionId, secreto: sesion.secreto, cambios },
      token: this.equipoActual().token,
    })
    await this.actualizarCatalogo().catch(avisarFallo)
    return version
  }

  // ── Personal y roles (tarea 1.3b) ────────────────────────────────────

  /** Roles y personas, también los archivados (pide `administrar_usuarios`). */
  async personal(): Promise<Personal> {
    return this.conSesion('/api/personal/leer', {})
  }

  /** Crea un rol o cambia su nombre, sus permisos o si está activo. */
  async guardarRol(rol: {
    id?: string
    nombre: string
    permisos: string[]
    activo?: boolean
  }): Promise<string> {
    return (await this.conSesion<{ id: string }>('/api/personal/roles', { rol })).id
  }

  /**
   * Crea o cambia a una persona. Devuelve su PIN si es nueva o se regeneró: solo se ve esta vez.
   */
  async guardarPersona(persona: {
    id?: string
    nombre: string
    rol_id: string
    activo?: boolean
    acceso?: { tipo: 'pin' } | { tipo: 'contrasena'; usuario: string; contrasena?: string }
    regenerar_pin?: boolean
  }): Promise<{ id: string; pin: string | null }> {
    const r = await this.conSesion<{ id: string; pin: string | null }>('/api/personal/personas', {
      persona,
    })
    // El nombre de cada persona viene en la carta: traerla para verlo en el salón.
    await this.actualizarCatalogo().catch(avisarFallo)
    return r
  }

  /** Retira un equipo (perdido, robado): deja de sincronizar y nadie puede entrar en él. */
  async retirarEquipo(dispositivoId: string): Promise<void> {
    await this.conSesion(`/api/dispositivos/${encodeURIComponent(dispositivoId)}/revocar`, {})
  }

  /** Una llamada con la sesión abierta. Si el hub dice que ya no vale, se pide entrar de nuevo. */
  private async conSesion<T>(ruta: string, cuerpo: object): Promise<T> {
    this.usar()
    const sesion = this.estado.sesion
    if (!sesion) throw new Error('Sin sesión: vuelve a entrar')
    try {
      return await this.api<T>('POST', ruta, {
        cuerpo: { sesion_id: sesion.sesionId, secreto: sesion.secreto, ...cuerpo },
        token: this.equipoActual().token,
      })
    } catch (e) {
      if (e instanceof ErrorApi && e.codigo === 'sesion_invalida') await this.salir()
      throw e
    }
  }

  /** Trae la carta de nuevo; si falla, se queda la guardada (se reintenta al reconectar). */
  private traerCatalogoSiHaySesion() {
    if (this.estado.sesion) this.actualizarCatalogo().catch(avisarFallo)
  }

  /** Si pasó el tiempo sin uso, se cierra la sesión: el siguiente toque pide el PIN. */
  vencerSesionSiToca(ahora = Date.now()) {
    const { sesion, catalogo } = this.estado
    if (!sesion) return
    const minutos = catalogo?.restaurante.sesionInactividadMin ?? MINUTOS_POR_DEFECTO
    if (ahora - sesion.ultimoUso >= minutos * 60_000) this.salir('inactividad').catch(avisarFallo)
  }

  /** Marca uso (cada toque que hace algo): aplaza el cierre por inactividad. */
  usar(ahora = Date.now()) {
    const { sesion } = this.estado
    if (!sesion) return
    this.vencerSesionSiToca(ahora)
    // Cada toque cuenta, pero no hace falta escribir en IndexedDB con cada uno.
    if (!this.estado.sesion || ahora - sesion.ultimoUso < 15_000) return
    const nueva = { ...sesion, ultimoUso: ahora }
    this.estado = { ...this.estado, sesion: nueva }
    this.db.guardarAjuste(CLAVES.sesion, nueva).catch(avisarFallo)
  }

  // ── Sincronización ───────────────────────────────────────────────────

  private async conectar(equipo: Equipo) {
    this.gestor?.detener()
    // Cliente y gestor quedan asignados antes del primer `await`: otra llamada que llegue mientras
    // tanto detiene este gestor en vez de dejar un segundo WebSocket huérfano.
    const cliente = new ClienteSync({
      almacen: this.almacen,
      token: equipo.token,
      versionApp: VERSION_APP,
      enviar: (m) => this.canal?.enviar(m),
      alCambiar: () => void this.alCambiarDatos().catch(avisarFallo),
      alErrorHub: (codigo, mensaje) => {
        if (codigo === 'token_invalido' || codigo === 'app_vieja') gestor.detener()
        this.cambiar({ errorHub: { codigo, mensaje } })
      },
      alFallo: (error) => console.error('Sincronización:', error),
    })
    const gestor = new GestorConexion({
      abrir: this.abrir,
      alConectar: (canal) => {
        this.canal = canal
        void cliente.alConectar()
        // Pudo cambiar mientras no había conexión.
        this.traerCatalogoSiHaySesion()
      },
      alDesconectar: () => {
        this.canal = null
        cliente.alDesconectar()
      },
      alMensaje: (m) => {
        if (m.tipo === 'catalogo' && m.version !== this.estado.catalogo?.version)
          this.traerCatalogoSiHaySesion()
        void cliente.recibir(m)
      },
      alCambiarEstado: (conexion) => this.cambiar({ conexion }),
    })
    this.cliente = cliente
    this.gestor = gestor
    await cliente.iniciar()
    if (this.gestor !== gestor) return
    if (!this.estado.simulandoSinConexion) gestor.iniciar()
    await this.alCambiarDatos()
  }

  private async alCambiarDatos() {
    const pendientes = (await this.cliente?.pendientes()) ?? 0
    this.cambiar({ pendientes, cambios: this.estado.cambios + 1 })
  }

  /** Para la demo: corta la conexión con el hub como si se cayera el Wi-Fi, y la devuelve. */
  simularSinConexion(sin: boolean) {
    this.cambiar({ simulandoSinConexion: sin })
    if (sin) this.gestor?.detener()
    else this.gestor?.iniciar()
  }

  cambiarVisibilidad(visible: boolean) {
    this.gestor?.cambiarVisibilidad(visible)
    if (visible) this.vencerSesionSiToca()
  }

  /** El cliente de sincronización (para leer pedidos y eventos locales). */
  get sync(): ClienteSync | null {
    return this.cliente
  }

  /**
   * Crea un evento del pedido con su sobre completo, lo firma con el secreto de la sesión y lo
   * guarda (persistir antes de mostrar). Se envía solo cuando haya conexión.
   */
  async registrar<T extends TipoEventoPedido>(
    tipo: T,
    pedidoId: string,
    datos: Extract<EventoNuevo, { tipo: T }>['datos'],
  ): Promise<EventoNuevo> {
    const ahora = Date.now()
    // Primero el uso: si la sesión acaba de vencer, no se firma nada con ella.
    this.usar(ahora)
    const cliente = this.cliente
    const { sesion, equipo } = this.estado
    if (!cliente || !sesion || !equipo) throw new Error('Sin sesión: escribe tu PIN')
    const evento = {
      id: nuevoId(),
      tipo,
      version_esquema: 1,
      agregado_tipo: agregadoDe(tipo),
      agregado_id: pedidoId,
      relacionados: [],
      datos,
      sesion_id: sesion.sesionId,
      usuario_id: sesion.usuario.id,
      dispositivo_id: equipo.dispositivoId,
      autorizacion_id: null,
      motivo: null,
      hora_dispositivo: new Date(ahora).toISOString(),
      hora_estimada_hub: cliente.horaEstimadaHub(ahora),
      secuencia_base: await cliente.conocido(),
    } as EventoNuevo
    const firmado = { ...evento, firma: firmarEvento(evento, sesion.secreto) } as EventoNuevo
    const r = await cliente.registrar(firmado)
    if (!r.ok) throw new Error(`Evento inválido: ${r.errores.join('; ')}`)
    // Que el contador de pendientes ya lo cuente al volver.
    await this.alCambiarDatos()
    return firmado
  }

  /** Lo que va por HTTP al hub; con el corte simulado tampoco sale, como si no hubiera red. */
  private api<T>(...args: Parameters<typeof llamar>): Promise<T> {
    if (this.estado.simulandoSinConexion)
      return Promise.reject(new ErrorApi('sin_conexion', SIN_HUB))
    return llamar<T>(...args)
  }

  private equipoActual(): Equipo {
    if (!this.estado.equipo)
      throw new Error('Este equipo todavía no ha entrado: escribe tu PIN o tu contraseña')
    return this.estado.equipo
  }
}
