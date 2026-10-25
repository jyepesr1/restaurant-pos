import {
  type EstadoPedido,
  type EventoNuevo,
  esPermiso,
  firmarEvento,
  huellaAutorizable,
  igualesSinFiltrarTiempo,
  nuevoId,
  PERMISOS_CON_CONTRASENA,
  PERMISOS_DE_COBRO,
  PERMISOS_PANTALLA,
  type Permiso,
  permisoPara,
  SOLO_DESDE_CAJA,
} from '@pos/core'
import { type BaseSqlite, enTransaccion, type Fila, type ValorSql } from '@pos/db'
import type { Conexion, ControlAcceso, TipoDispositivo, VeredictoAcceso } from '@pos/sync'
import { Intentos } from './intentos'
import { type Autor, actualizarVersionado, insertarVersionado, SISTEMA } from './registros'
import {
  COSTO_CONTRASENA,
  contrasenaCoincide,
  esContrasenaValida,
  esPinConFormato,
  generarPin,
  huellaContrasena,
  huellaPin,
  huellaSecreto,
  LARGO_MAXIMO_CONTRASENA,
  mismaHuella,
  normalizarUsuario,
  nuevoCodigoEmparejamiento,
  nuevoSecreto,
  secretoDeSesion,
} from './secretos'

// Entrar (con PIN o con usuario y contraseña), sesiones, comprobantes de supervisor, revocación y
// el emparejamiento por código que queda para la pantalla de cocina (ADR-008 y ADR-013,
// docs/SYNC.md#seguridad). Todo esto vive solo en el hub.

/** El código del QR para emparejar vence a los 5 minutos y sirve una vez. */
export const VIGENCIA_CODIGO_MS = 5 * 60_000
/** El evento autorizado debe crearse en los 2 minutos siguientes al comprobante. */
export const VIGENCIA_AUTORIZACION_MS = 2 * 60_000
/** Y llegar al hub, a más tardar, en este plazo (puede haber quedado en la cola sin conexión). */
export const ENTREGA_AUTORIZADO_MS = 12 * 60 * 60_000
/** Margen por el reloj del dispositivo, ya corregido con el desfase que aprendió. */
const TOLERANCIA_RELOJ_MS = 60_000

export type CodigoAcceso =
  | 'pin_incorrecto'
  | 'credenciales_incorrectas'
  | 'espera'
  | 'codigo_invalido'
  | 'sesion_invalida'
  | 'equipo_no_emparejado'
  | 'sin_permiso'
  | 'autoautorizacion'
  | 'ya_autorizado'
  | 'dispositivo_revocado'
  | 'datos_invalidos'

export interface ErrorAcceso {
  ok: false
  codigo: CodigoAcceso
  mensaje: string
  /** Con `espera` y `pin_incorrecto`: cuánto esperar antes de volver a intentar. */
  esperaMs?: number
}

export interface UsuarioSesion {
  id: string
  nombre: string
  rol: string
}

export interface OpcionesAcceso {
  db: BaseSqlite
  restauranteId: string
  /** Clave HMAC de los PIN y de los secretos de sesión (`cargarClave`). */
  clave: Buffer
  reloj?: () => string
  intentos?: Intentos
  /** Se revocó un dispositivo: la sala corta lo que recibe (`SalaSync.revocar`). */
  alRevocar?: (dispositivoId: string, revocadoEn: string) => void
  /**
   * Desde cuándo existe la clave (`cargarClave`). Si se perdió y se creó otra, lo pendiente de
   * sesiones anteriores no se puede comprobar: va a cuarentena en vez de perderse.
   */
  claveDesde?: string
  /** Costo de la huella de las contraseñas (`COSTO_CONTRASENA`); las pruebas usan menos. */
  costoContrasena?: number
}

/** El equipo que el hub registró al entrar desde un navegador sin token. */
export interface EquipoNuevo {
  dispositivoId: string
  token: string
  nombre: string
  tipo: TipoDispositivo
}

export type DatosEntrada = { pin: string } | { usuario: string; contrasena: string }

export type Entrada = {
  ok: true
  /** Solo si el hub registró este navegador ahora: el token se ve esta única vez. */
  equipo: EquipoNuevo | null
  /** El tipo del equipo tras entrar: con contraseña pasa a ser de caja. */
  tipo: TipoDispositivo
  sesionId: string
  secreto: string
  usuario: UsuarioSesion
  permisos: Permiso[]
}

const error = (codigo: CodigoAcceso, mensaje: string, esperaMs?: number): ErrorAcceso => ({
  ok: false,
  codigo,
  mensaje,
  ...(esperaMs === undefined ? {} : { esperaMs }),
})

const PIN_INCORRECTO = 'PIN incorrecto'
const CREDENCIALES_INCORRECTAS = 'Usuario o contraseña incorrectos'
/** Tope de la espera por usuario: probar contraseñas ajenas no deja afuera a nadie más de esto. */
const ESPERA_MAXIMA_CUENTA_MS = 10_000
const PIN_SIN_PERMISO = 'PIN incorrecto o sin permiso para esto'

const esperar = (ms: number) =>
  error('espera', `Demasiados intentos. Espera ${Math.ceil(ms / 1000)} s.`, ms)

const TIPOS_DISPOSITIVO: readonly TipoDispositivo[] = ['mesero', 'caja', 'kds']

/** Mientras el hub no tiene ningún equipo, cualquiera de la red puede intentar emparejar la caja. */
const PRIMER_EMPAREJAMIENTO = 'global:primer_emparejamiento'

interface Emparejamiento {
  nombre: string
  tipo: TipoDispositivo
  venceEn: number
  aprobadoPor: string
}

/** Un dato que no sirve (nombre, usuario, contraseña): su mensaje se puede mostrar en pantalla. */
export class ErrorDatos extends Error {}

export interface DatosUsuario {
  nombre: string
  rolId: string
  id?: string
  /** Con usuario y contraseña entra a la caja; sin ellos, con su PIN (ADR-013). */
  usuario?: string
  contrasena?: string
}

export class ServicioAcceso implements ControlAcceso {
  private readonly db: BaseSqlite
  private readonly restauranteId: string
  /** El restaurante de este hub. */
  get restaurante(): string {
    return this.restauranteId
  }
  private readonly clave: Buffer
  private readonly reloj: () => string
  private readonly intentos: Intentos
  private readonly alRevocar: OpcionesAcceso['alRevocar']
  private readonly claveDesde: number
  private readonly costoContrasena: number
  /**
   * Para comparar algo cuando el usuario no existe o está archivado, con el mismo costo que una
   * contraseña de verdad: así tarda lo mismo y no delata qué usuarios hay.
   */
  private huellaDeRelleno: string | null = null
  /** Códigos de emparejamiento vigentes. En memoria: viven 5 minutos. */
  private readonly emparejamientos = new Map<string, Emparejamiento>()

  constructor(o: OpcionesAcceso) {
    this.db = o.db
    this.restauranteId = o.restauranteId
    this.clave = o.clave
    this.reloj = o.reloj ?? (() => new Date().toISOString())
    this.intentos = o.intentos ?? new Intentos(() => Date.parse(this.reloj()))
    this.alRevocar = o.alRevocar
    this.claveDesde = o.claveDesde ? Date.parse(o.claveDesde) : 0
    this.costoContrasena = o.costoContrasena ?? COSTO_CONTRASENA
  }

  // ── Dispositivos ─────────────────────────────────────────────────────

  /** Token → dispositivo (el `Autenticador` de la sala). `null` si no existe o se archivó. */
  autenticar = (token: string): Conexion | null => {
    const fila = this.db
      .prepare(
        `SELECT d.id, d.tipo, d.revocado_en FROM dispositivo_credencial c
         JOIN dispositivo d ON d.id = c.dispositivo_id
         WHERE c.restaurante_id = ? AND c.token_hash = ? AND d.activo = 1`,
      )
      .get(this.restauranteId, huellaSecreto(token))
    if (!fila) return null
    return {
      dispositivoId: String(fila.id),
      tipo: String(fila.tipo) as TipoDispositivo,
      revocadoEn: fila.revocado_en === null ? null : String(fila.revocado_en),
    }
  }

  /**
   * Un administrador aprueba con su PIN emparejar un dispositivo nuevo: devuelve el código de un
   * solo uso que va en el QR. Se pide desde un equipo ya emparejado (la caja), así que solo un
   * equipo emparejado puede probar PIN. La única excepción es el primero, cuando el hub no tiene
   * ninguno: entonces la espera es una sola para todo el hub, porque una IP se cambia fácil.
   */
  crearEmparejamiento(
    datos: { pin: string; nombre: string; tipo: string },
    conexion: Conexion | null,
  ): { ok: true; codigo: string; venceEn: string } | ErrorAcceso {
    const nombre = datos.nombre.trim()
    if (nombre.length === 0 || nombre.length > 60)
      return error('datos_invalidos', 'El nombre del equipo debe tener entre 1 y 60 letras')
    if (!TIPOS_DISPOSITIVO.includes(datos.tipo as TipoDispositivo))
      return error('datos_invalidos', 'Tipo de equipo desconocido')
    if (conexion?.revocadoEn) return error('dispositivo_revocado', 'Este equipo fue retirado')
    if (!conexion && this.hayDispositivos())
      return error('equipo_no_emparejado', 'Aprueba el emparejamiento desde la caja')

    const admin = this.conPin(
      conexion ? `dispositivo:${conexion.dispositivoId}` : PRIMER_EMPAREJAMIENTO,
      datos.pin,
      (u) => this.tienePermiso(u.id, 'administrar_dispositivos'),
      PIN_SIN_PERMISO,
    )
    if (!admin.ok) return admin

    const ahora = Date.parse(this.reloj())
    for (const [codigo, e] of this.emparejamientos)
      if (e.venceEn <= ahora) this.emparejamientos.delete(codigo)
    const codigo = nuevoCodigoEmparejamiento()
    const venceEn = ahora + VIGENCIA_CODIGO_MS
    this.emparejamientos.set(codigo, {
      nombre,
      tipo: datos.tipo as TipoDispositivo,
      venceEn,
      aprobadoPor: admin.usuario.id,
    })
    return { ok: true, codigo, venceEn: new Date(venceEn).toISOString() }
  }

  /**
   * El dispositivo cambia el código del QR por su token propio. El token solo se ve esta vez.
   * `origen` (la IP) da la espera: con 8 letras de 31 posibles, adivinar un código vigente en
   * 5 minutos es imposible, pero no hay por qué dejar probar sin freno.
   */
  emparejar(
    codigo: string,
    origen: string,
  ):
    | { ok: true; dispositivoId: string; token: string; nombre: string; tipo: TipoDispositivo }
    | ErrorAcceso {
    const quien = `ip:${origen}`
    const espera = this.intentos.esperaMs(quien)
    if (espera > 0) return esperar(espera)
    const normalizado = codigo.trim().toUpperCase()
    const e = this.emparejamientos.get(normalizado)
    const ahora = this.reloj()
    if (!e || e.venceEn <= Date.parse(ahora)) {
      if (e) this.emparejamientos.delete(normalizado)
      return error(
        'codigo_invalido',
        'Código vencido o inválido: pide uno nuevo en la caja',
        this.intentos.fallo(quien),
      )
    }
    this.emparejamientos.delete(normalizado)

    const { dispositivoId, token } = enTransaccion(this.db, () =>
      this.registrarDispositivo(e.nombre, e.tipo, e.aprobadoPor, ahora),
    )
    return { ok: true, dispositivoId, token, nombre: e.nombre, tipo: e.tipo }
  }

  /**
   * Retira un dispositivo (robado, dañado, de alguien que se fue). Desde ya no recibe nada del
   * salón; lo que tenía pendiente de antes va a cuarentena.
   */
  revocarDispositivo(
    conexion: Conexion,
    datos: { sesionId: string; secreto: string; dispositivoId: string },
  ): { ok: true; revocadoEn: string } | ErrorAcceso {
    const sesion = this.sesionAbierta(conexion, datos.sesionId, datos.secreto)
    if (!sesion.ok) return sesion
    if (!this.tienePermiso(sesion.usuarioId, 'administrar_dispositivos'))
      return error('sin_permiso', 'Solo un administrador puede retirar equipos')
    if (datos.dispositivoId === conexion.dispositivoId)
      return error('datos_invalidos', 'No puedes retirar el equipo desde el que estás')

    const fila = this.db
      .prepare('SELECT revocado_en FROM dispositivo WHERE restaurante_id = ? AND id = ?')
      .get(this.restauranteId, datos.dispositivoId)
    if (!fila) return error('datos_invalidos', 'Ese equipo no existe')
    if (fila.revocado_en !== null) return { ok: true, revocadoEn: String(fila.revocado_en) }

    const ahora = this.reloj()
    enTransaccion(this.db, () => {
      const max = this.db
        .prepare('SELECT coalesce(max(secuencia), 0) AS m FROM evento WHERE restaurante_id = ?')
        .get(this.restauranteId)
      actualizarVersionado(
        this.db,
        'dispositivo',
        this.restauranteId,
        datos.dispositivoId,
        { revocado_en: ahora, secuencia_revocacion: Number(max?.m ?? 0) },
        { usuarioId: sesion.usuarioId, dispositivoId: conexion.dispositivoId },
        ahora,
      )
      this.cerrarSesiones('dispositivo_id = ?', datos.dispositivoId, ahora)
      // Una pantalla retirada se lleva su usuario técnico: ya no marca nada.
      const pantalla = this.usuarioDePantalla(datos.dispositivoId)
      if (pantalla)
        actualizarVersionado(
          this.db,
          'usuario',
          this.restauranteId,
          pantalla,
          { activo: 0 },
          { usuarioId: sesion.usuarioId, dispositivoId: conexion.dispositivoId },
          ahora,
        )
    })
    this.alRevocar?.(datos.dispositivoId, ahora)
    return { ok: true, revocadoEn: ahora }
  }

  /**
   * Para acciones que no son eventos (editar el catálogo): la sesión debe ser de este equipo,
   * estar abierta y su usuario tener el permiso. Devuelve quién actúa.
   */
  usuarioConPermiso(
    conexion: Conexion,
    datos: { sesionId: string; secreto: string },
    permiso: Permiso,
  ): { ok: true; usuarioId: string } | ErrorAcceso {
    const sesion = this.sesionAbierta(conexion, datos.sesionId, datos.secreto)
    if (!sesion.ok) return sesion
    if (!this.tienePermiso(sesion.usuarioId, permiso))
      return error('sin_permiso', 'Tu rol no tiene permiso para esto')
    return { ok: true, usuarioId: sesion.usuarioId }
  }

  // ── Pantalla de cocina (ADR-015) ─────────────────────────────────────

  /**
   * El administrador convierte el equipo desde el que está en pantalla de cocina de esas
   * estaciones. Su sesión se cierra y el equipo queda con la de un usuario técnico propio de la
   * pantalla, que solo marca listo y agotados y nunca entra con PIN ni contraseña. Repetirlo
   * cambia el nombre y las estaciones de la misma pantalla.
   */
  convertirEnPantalla(
    conexion: Conexion,
    datos: { sesionId: string; secreto: string; nombre: string; estacionIds: string[] },
  ):
    | { ok: true; sesionId: string; secreto: string; usuario: UsuarioSesion; permisos: Permiso[] }
    | ErrorAcceso {
    const sesion = this.sesionAbierta(conexion, datos.sesionId, datos.secreto)
    if (!sesion.ok) return sesion
    if (!this.tienePermiso(sesion.usuarioId, 'administrar_dispositivos'))
      return error('sin_permiso', 'Solo un administrador puede convertir un equipo en pantalla')
    const nombre = datos.nombre.trim().slice(0, 60)
    if (!nombre) return error('datos_invalidos', 'Ponle un nombre a la pantalla')
    const estaciones = [...new Set(datos.estacionIds)]
    if (estaciones.length === 0) return error('datos_invalidos', 'Elige al menos una estación')
    for (const id of estaciones) {
      const existe = this.db
        .prepare('SELECT 1 FROM estacion WHERE restaurante_id = ? AND id = ? AND activo = 1')
        .get(this.restauranteId, id)
      if (!existe) return error('datos_invalidos', 'Esa estación no existe')
    }

    const ahora = this.reloj()
    const autor = { usuarioId: sesion.usuarioId, dispositivoId: conexion.dispositivoId }
    return enTransaccion(this.db, () => {
      actualizarVersionado(
        this.db,
        'dispositivo',
        this.restauranteId,
        conexion.dispositivoId,
        { tipo: 'kds', nombre, estacion_ids: JSON.stringify(estaciones) },
        autor,
        ahora,
      )
      const rolId = this.rolPantalla(autor, ahora)
      let usuarioId = this.usuarioDePantalla(conexion.dispositivoId)
      if (usuarioId)
        actualizarVersionado(
          this.db,
          'usuario',
          this.restauranteId,
          usuarioId,
          { nombre, activo: 1 },
          autor,
          ahora,
        )
      else
        usuarioId = insertarVersionado(
          this.db,
          'usuario',
          this.restauranteId,
          { nombre, rol_id: rolId, pantalla: 1 },
          autor,
          ahora,
        )
      const abierta = this.abrirSesion(conexion.dispositivoId, usuarioId, ahora)
      return {
        ok: true as const,
        ...abierta,
        usuario: { id: usuarioId, nombre, rol: 'Pantalla de cocina' },
        permisos: this.permisosDe(usuarioId),
      }
    })
  }

  /** El usuario técnico de una pantalla: el de alguna sesión suya. */
  usuarioDePantalla(dispositivoId: string): string | null {
    const f = this.db
      .prepare(
        `SELECT u.id FROM sesion s JOIN usuario u ON u.id = s.usuario_id
         WHERE s.restaurante_id = ? AND s.dispositivo_id = ? AND u.pantalla = 1
         ORDER BY s.inicio DESC LIMIT 1`,
      )
      .get(this.restauranteId, dispositivoId)
    return f ? String(f.id) : null
  }

  /** El rol oculto de las pantallas (se crea la primera vez), con `PERMISOS_PANTALLA`. */
  private rolPantalla(autor: Autor, ahora: string): string {
    const f = this.db
      .prepare(
        'SELECT id FROM rol WHERE restaurante_id = ? AND oculto = 1 ORDER BY creado_en LIMIT 1',
      )
      .get(this.restauranteId)
    if (f) return String(f.id)
    const rolId = insertarVersionado(
      this.db,
      'rol',
      this.restauranteId,
      { nombre: 'Pantalla de cocina', sistema: 1, oculto: 1 },
      autor,
      ahora,
    )
    for (const permiso of PERMISOS_PANTALLA)
      insertarVersionado(
        this.db,
        'rol_permiso',
        this.restauranteId,
        { rol_id: rolId, permiso },
        autor,
        ahora,
      )
    return rolId
  }

  // ── Entrar (ADR-013) ─────────────────────────────────────────────────

  /**
   * Entrar desde cualquier navegador de la red, sin emparejarlo antes. Con PIN entra quien no
   * tiene usuario (los meseros); con usuario y contraseña, el resto, y su PIN solo autoriza.
   * Sin token (`conexion` nula), con el acierto el hub registra el navegador como equipo y le da
   * su token; la espera por intentos va entonces por la IP (`origen`). Con contraseña el equipo
   * pasa a ser de caja: desde él se puede cobrar si el rol lo permite.
   */
  entrar(datos: DatosEntrada, conexion: Conexion | null, origen: string): Entrada | ErrorAcceso {
    if (conexion?.revocadoEn) return error('dispositivo_revocado', 'Este equipo fue retirado')
    const quien = conexion ? `dispositivo:${conexion.dispositivoId}` : `ip:${origen}`
    const r =
      'pin' in datos
        ? this.conPin(quien, datos.pin, (u) => this.entraConPin(u.id), PIN_INCORRECTO)
        : this.conContrasena(quien, datos.usuario, datos.contrasena)
    if (!r.ok) return r

    // Solo quien puede cobrar vuelve de caja el equipo: pagos y cierres salen de ahí.
    const permisos = this.permisosDe(r.usuario.id)
    const cobra = !('pin' in datos) && permisos.some((p) => PERMISOS_DE_COBRO.has(p))
    const ahora = this.reloj()
    return enTransaccion(this.db, () => {
      let equipo: EquipoNuevo | null = null
      let dispositivoId: string
      let tipo: TipoDispositivo
      if (conexion) {
        dispositivoId = conexion.dispositivoId
        tipo = conexion.tipo
        if (cobra && tipo === 'mesero') {
          tipo = 'caja'
          actualizarVersionado(
            this.db,
            'dispositivo',
            this.restauranteId,
            dispositivoId,
            { tipo },
            { usuarioId: r.usuario.id, dispositivoId },
            ahora,
          )
        }
      } else {
        tipo = cobra ? 'caja' : 'mesero'
        const nombre = `Equipo de ${r.usuario.nombre}`.slice(0, 60)
        const nuevo = this.registrarDispositivo(nombre, tipo, r.usuario.id, ahora)
        dispositivoId = nuevo.dispositivoId
        equipo = { ...nuevo, nombre, tipo }
      }
      const sesion = this.abrirSesion(dispositivoId, r.usuario.id, ahora)
      return {
        ok: true,
        equipo,
        tipo,
        ...sesion,
        usuario: r.usuario,
        permisos,
      }
    })
  }

  /**
   * Si esa persona puede entrar solo con su PIN: no tiene usuario y su rol no tiene ningún permiso
   * que pida contraseña (`PERMISOS_CON_CONTRASENA`).
   */
  entraConPin(usuarioId: string): boolean {
    return (
      !this.tieneContrasena(usuarioId) &&
      !this.permisosDe(usuarioId).some((p) => PERMISOS_CON_CONTRASENA.has(p))
    )
  }

  // ── Sesiones ─────────────────────────────────────────────────────────

  /**
   * Abre una sesión con el PIN. Cierra la que hubiera en ese dispositivo: escribir otro PIN
   * cambia de usuario al instante. El secreto solo se entrega esta vez; con él el dispositivo
   * firma los eventos de la sesión, y lo olvida al cerrarla.
   */
  iniciarSesion(
    conexion: Conexion,
    pin: string,
  ):
    | { ok: true; sesionId: string; secreto: string; usuario: UsuarioSesion; permisos: Permiso[] }
    | ErrorAcceso {
    if (conexion.revocadoEn) return error('dispositivo_revocado', 'Este equipo fue retirado')
    // Quien tiene usuario entra con su contraseña: su PIN solo autoriza (ADR-013).
    const r = this.conPin(
      `dispositivo:${conexion.dispositivoId}`,
      pin,
      (u) => this.entraConPin(u.id),
      PIN_INCORRECTO,
    )
    if (!r.ok) return r
    const sesion = enTransaccion(this.db, () =>
      this.abrirSesion(conexion.dispositivoId, r.usuario.id, this.reloj()),
    )
    return { ok: true, ...sesion, usuario: r.usuario, permisos: this.permisosDe(r.usuario.id) }
  }

  /** Cierra la sesión que hubiera en el equipo y abre otra (dentro de una transacción). */
  private abrirSesion(dispositivoId: string, usuarioId: string, ahora: string) {
    const sesionId = nuevoId()
    const secreto = this.secretoDe(sesionId)
    this.cerrarSesiones('dispositivo_id = ?', dispositivoId, ahora)
    this.db
      .prepare(
        `INSERT INTO sesion (id, restaurante_id, usuario_id, dispositivo_id, secreto_hash, inicio, ultimo_uso)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sesionId,
        this.restauranteId,
        usuarioId,
        dispositivoId,
        huellaSecreto(secreto),
        ahora,
        ahora,
      )
    return { sesionId, secreto }
  }

  cerrarSesion(
    conexion: Conexion,
    datos: { sesionId: string; secreto: string },
  ): { ok: true } | ErrorAcceso {
    const sesion = this.sesionAbierta(conexion, datos.sesionId, datos.secreto)
    if (!sesion.ok) return sesion
    this.cerrarSesiones('id = ?', datos.sesionId, this.reloj())
    return { ok: true }
  }

  // ── Autorización de supervisor ───────────────────────────────────────

  /**
   * El supervisor escribe su PIN en el dispositivo del mesero, sin cerrarle la sesión. El hub
   * emite un comprobante de un solo uso para el evento exacto que se autoriza: el dispositivo
   * manda su `huella` (`huellaAutorizable`) y el comprobante solo vale para ese contenido, desde
   * esa sesión.
   */
  autorizar(
    conexion: Conexion,
    datos: {
      sesionId: string
      secreto: string
      pin: string
      accion: string
      agregadoId: string
      eventoId: string
      huella: string
    },
  ):
    | { ok: true; autorizacionId: string; supervisor: { id: string; nombre: string } }
    | ErrorAcceso {
    const sesion = this.sesionAbierta(conexion, datos.sesionId, datos.secreto)
    if (!sesion.ok) return sesion
    const accion = datos.accion
    if (!esPermiso(accion)) return error('datos_invalidos', 'Acción desconocida')
    if (!/^[0-9a-f]{64}$/.test(datos.huella))
      return error('datos_invalidos', 'Falta la huella del evento')

    // Escribir el propio PIN no autoriza, y cuenta como un intento más: si no, alternar el PIN
    // propio con PIN ajenos evitaría la espera.
    const r = this.conPin(
      `dispositivo:${conexion.dispositivoId}`,
      datos.pin,
      (u) => u.id !== sesion.usuarioId && this.tienePermiso(u.id, accion),
      PIN_SIN_PERMISO,
    )
    if (!r.ok) {
      const propio =
        esPinConFormato(datos.pin) && this.usuarioPorPin(datos.pin)?.id === sesion.usuarioId
      return propio
        ? error('autoautorizacion', 'Otra persona con el permiso debe escribir su PIN')
        : r
    }

    const ya = this.db
      .prepare('SELECT 1 FROM autorizacion WHERE restaurante_id = ? AND evento_id = ?')
      .get(this.restauranteId, datos.eventoId)
    if (ya) return error('ya_autorizado', 'Esa acción ya tiene una autorización')

    const autorizacionId = nuevoId()
    this.db
      .prepare(
        `INSERT INTO autorizacion (id, restaurante_id, supervisor_id, accion, agregado_id, evento_id,
           emitida_en, contenido_hash, sesion_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        autorizacionId,
        this.restauranteId,
        r.usuario.id,
        accion,
        datos.agregadoId,
        datos.eventoId,
        this.reloj(),
        datos.huella,
        datos.sesionId,
      )
    return { ok: true, autorizacionId, supervisor: { id: r.usuario.id, nombre: r.usuario.nombre } }
  }

  // ── Control de acceso de los eventos (ControlAcceso) ─────────────────

  verificar(conexion: Conexion, evento: EventoNuevo, pedido: EstadoPedido | null): VeredictoAcceso {
    const no = (motivo: string): VeredictoAcceso => ({ ok: false, motivo })
    // Algo que el evento hizo antes de un cambio del administrador (archivar al usuario, quitarle
    // un permiso) no se pierde: lo revisa el gerente.
    const revisar = (motivo: string): VeredictoAcceso => ({ ok: false, motivo, cuarentena: true })

    if (!evento.sesion_id) return no('sin_sesion')
    const sesion = this.db
      .prepare('SELECT * FROM sesion WHERE restaurante_id = ? AND id = ?')
      .get(this.restauranteId, evento.sesion_id)
    if (!sesion) return revisar('sesion_desconocida')
    if (sesion.dispositivo_id !== conexion.dispositivoId) return no('sesion_ajena')
    if (sesion.usuario_id !== evento.usuario_id) return no('usuario_distinto')
    // La firma prueba que lo creó quien tenía la sesión abierta, no otro que usa su `sesion_id`.
    const firma = firmarEvento(evento, this.secretoDe(evento.sesion_id))
    if (!evento.firma || !igualesSinFiltrarTiempo(evento.firma, firma))
      return Date.parse(String(sesion.inicio)) < this.claveDesde
        ? revisar('clave_cambiada')
        : no('firma_invalida')

    // La sesión se juzga a la hora del evento: lo hecho sin conexión mientras estaba abierta vale.
    const hora = Date.parse(evento.hora_estimada_hub)
    if (hora < Date.parse(String(sesion.inicio)) - TOLERANCIA_RELOJ_MS) return no('sesion_cerrada')
    if (
      sesion.cerrada_en !== null &&
      hora > Date.parse(String(sesion.cerrada_en)) + TOLERANCIA_RELOJ_MS
    )
      return no('sesion_cerrada')
    const cambio = this.ultimoCambioDe(evento.usuario_id)
    if (!this.usuarioActivo(evento.usuario_id))
      return hora < cambio ? revisar('usuario_archivado') : no('usuario_inactivo')

    const permiso = permisoPara(evento, pedido)
    if (!permiso) return no('solo_hub')
    // El tipo guardado, no el de la conexión: entrar con contraseña vuelve de caja un celular
    // que ya estaba conectado (ADR-013).
    if (SOLO_DESDE_CAJA.has(evento.tipo) && this.tipoDe(conexion) !== 'caja') return no('solo_caja')
    if (this.tienePermiso(evento.usuario_id, permiso))
      return { ok: true, autorizadoPorId: null, autorizacionId: null }

    if (!evento.autorizacion_id)
      return hora < cambio ? revisar('permisos_cambiados') : no('sin_permiso')
    const a = this.db
      .prepare('SELECT * FROM autorizacion WHERE restaurante_id = ? AND id = ?')
      .get(this.restauranteId, evento.autorizacion_id)
    if (!a || !this.comprobanteVale(a, evento, permiso, hora)) return no('autorizacion_invalida')
    return { ok: true, autorizadoPorId: String(a.supervisor_id), autorizacionId: String(a.id) }
  }

  registrarUso(evento: EventoNuevo, veredicto: Extract<VeredictoAcceso, { ok: true }>) {
    const ahora = this.reloj()
    // Lo recibido también cuenta como uso de la sesión (sin pasar de la hora del hub).
    const hora = new Date(
      Math.min(Date.parse(evento.hora_estimada_hub), Date.parse(ahora)),
    ).toISOString()
    this.db
      .prepare(
        'UPDATE sesion SET ultimo_uso = max(ultimo_uso, ?) WHERE restaurante_id = ? AND id = ?',
      )
      .run(hora, this.restauranteId, evento.sesion_id)
    if (veredicto.autorizacionId)
      this.db
        .prepare(
          'UPDATE autorizacion SET usada_en = ? WHERE restaurante_id = ? AND id = ? AND usada_en IS NULL',
        )
        .run(ahora, this.restauranteId, veredicto.autorizacionId)
  }

  // ── Usuarios ─────────────────────────────────────────────────────────

  /** Crea un usuario con un PIN nuevo. El PIN se devuelve solo esta vez: no se guarda en claro. */
  crearUsuario(datos: DatosUsuario, autor: Autor = SISTEMA): { usuarioId: string; pin: string } {
    return enTransaccion(this.db, () => this.insertarUsuario(datos, autor))
  }

  /** Como `crearUsuario`, dentro de una transacción que ya abrió quien llama. */
  insertarUsuario(datos: DatosUsuario, autor: Autor = SISTEMA): { usuarioId: string; pin: string } {
    const nombre = datos.nombre.trim()
    if (nombre.length === 0 || nombre.length > 60)
      throw new ErrorDatos('El nombre debe tener entre 1 y 60 letras')
    const rol = this.db
      .prepare('SELECT 1 FROM rol WHERE restaurante_id = ? AND id = ? AND activo = 1')
      .get(this.restauranteId, datos.rolId)
    if (!rol) throw new ErrorDatos('Ese rol no existe o está archivado')

    const ahora = this.reloj()
    const usuarioId = insertarVersionado(
      this.db,
      'usuario',
      this.restauranteId,
      { nombre, rol_id: datos.rolId },
      autor,
      ahora,
      datos.id,
    )
    const pin = this.pinLibre()
    this.db
      .prepare(
        `INSERT INTO usuario_credencial (usuario_id, restaurante_id, pin_huella, pin_generado_en)
         VALUES (?, ?, ?, ?)`,
      )
      .run(usuarioId, this.restauranteId, huellaPin(this.clave, this.restauranteId, pin), ahora)
    if (datos.usuario !== undefined && datos.contrasena !== undefined)
      this.fijarContrasena(usuarioId, datos.usuario, datos.contrasena)
    return { usuarioId, pin }
  }

  /**
   * Da o cambia el usuario y la contraseña (desde entonces entra con ellos y su PIN solo autoriza).
   * Cierra sus sesiones: quien conocía la contraseña vieja no debe seguir adentro. Lanza un error
   * con un mensaje para la pantalla si el usuario no sirve, está tomado o la contraseña es corta.
   */
  ponerContrasena(usuarioId: string, usuario: string, contrasena: string) {
    enTransaccion(this.db, () => this.fijarContrasena(usuarioId, usuario, contrasena))
  }

  /** Como `ponerContrasena`, dentro de una transacción que ya abrió quien llama. */
  fijarContrasena(usuarioId: string, usuario: string, contrasena: string) {
    const nombre = normalizarUsuario(usuario)
    if (!nombre)
      throw new ErrorDatos(
        'El usuario lleva de 3 a 40 letras (sin tildes ni espacios), números, punto o guion',
      )
    if (!esContrasenaValida(contrasena))
      throw new ErrorDatos('La contraseña debe tener al menos 8 caracteres')
    const tomado = this.db
      .prepare(
        `SELECT 1 FROM usuario_credencial WHERE restaurante_id = ? AND nombre_usuario = ?
           AND vigente = 1 AND usuario_id <> ?`,
      )
      .get(this.restauranteId, nombre, usuarioId)
    if (tomado) throw new ErrorDatos(`Ya hay alguien con el usuario «${nombre}»`)
    const ahora = this.reloj()
    const cambio = this.db
      .prepare(
        `UPDATE usuario_credencial SET nombre_usuario = ?, contrasena_huella = ?,
           contrasena_cambiada_en = ? WHERE restaurante_id = ? AND usuario_id = ?`,
      )
      .run(
        nombre,
        huellaContrasena(contrasena, this.costoContrasena),
        ahora,
        this.restauranteId,
        usuarioId,
      )
    if (Number(cambio.changes) === 0) throw new Error('Ese usuario no tiene credencial')
    this.cerrarSesiones('usuario_id = ?', usuarioId, ahora)
  }

  /** Le quita usuario y contraseña: desde entonces entra con su PIN. Cierra sus sesiones. */
  quitarContrasena(usuarioId: string) {
    const ahora = this.reloj()
    enTransaccion(this.db, () => {
      this.db
        .prepare(
          `UPDATE usuario_credencial SET nombre_usuario = NULL, contrasena_huella = NULL,
             contrasena_cambiada_en = ? WHERE restaurante_id = ? AND usuario_id = ?`,
        )
        .run(ahora, this.restauranteId, usuarioId)
      this.cerrarSesiones('usuario_id = ?', usuarioId, ahora)
    })
  }

  /** El usuario con que entra esa persona, o `null` si entra con su PIN. */
  usuarioDe(usuarioId: string): string | null {
    const f = this.db
      .prepare(
        'SELECT nombre_usuario FROM usuario_credencial WHERE restaurante_id = ? AND usuario_id = ?',
      )
      .get(this.restauranteId, usuarioId)
    return f?.nombre_usuario == null ? null : String(f.nombre_usuario)
  }

  tieneContrasena(usuarioId: string): boolean {
    return this.usuarioDe(usuarioId) !== null
  }

  /**
   * Para quien olvidó su PIN, si se filtró, o tras perder la clave del hub. Cierra sus sesiones:
   * quien conocía el PIN viejo no debe seguir adentro.
   */
  regenerarPin(usuarioId: string): string {
    const ahora = this.reloj()
    return enTransaccion(this.db, () => {
      const pin = this.pinLibre()
      const cambio = this.db
        .prepare(
          `UPDATE usuario_credencial SET pin_huella = ?, pin_generado_en = ?
           WHERE restaurante_id = ? AND usuario_id = ?`,
        )
        .run(huellaPin(this.clave, this.restauranteId, pin), ahora, this.restauranteId, usuarioId)
      if (Number(cambio.changes) === 0) throw new Error('Ese usuario no tiene credencial')
      this.cerrarSesiones('usuario_id = ?', usuarioId, ahora)
      return pin
    })
  }

  /** Archiva al usuario: su PIN queda libre y sus sesiones se cierran. */
  archivarUsuario(usuarioId: string, autor: Autor = SISTEMA) {
    const ahora = this.reloj()
    enTransaccion(this.db, () => {
      actualizarVersionado(
        this.db,
        'usuario',
        this.restauranteId,
        usuarioId,
        { activo: 0 },
        autor,
        ahora,
      )
      this.cerrarSesiones('usuario_id = ?', usuarioId, ahora)
    })
  }

  permisosDe(usuarioId: string): Permiso[] {
    return this.db
      .prepare(
        `SELECT rp.permiso FROM usuario u
         JOIN rol r ON r.id = u.rol_id AND r.activo = 1
         JOIN rol_permiso rp ON rp.rol_id = r.id AND rp.activo = 1
         WHERE u.restaurante_id = ? AND u.id = ? AND u.activo = 1
         ORDER BY rp.permiso`,
      )
      .all(this.restauranteId, usuarioId)
      .map((f) => String(f.permiso))
      .filter(esPermiso)
  }

  // ── Internos ─────────────────────────────────────────────────────────

  /**
   * Busca al dueño del PIN con la espera por intentos de `quien`. Un PIN que no existe y uno sin
   * permiso dan el mismo `mensaje`: así no se sabe que el PIN es de alguien del restaurante.
   * Un acierto no borra los fallos: si no, alternar el PIN propio con PIN ajenos evitaría la
   * espera. Los fallos se olvidan solos tras un rato sin errores.
   */
  private conPin(
    quien: string,
    pin: string,
    vale: (usuario: UsuarioSesion) => boolean,
    mensaje: string,
  ): { ok: true; usuario: UsuarioSesion } | ErrorAcceso {
    const espera = this.intentos.esperaMs(quien)
    if (espera > 0) return esperar(espera)
    const usuario = esPinConFormato(pin) ? this.usuarioPorPin(pin) : undefined
    if (!usuario || !vale(usuario))
      return error('pin_incorrecto', mensaje, this.intentos.fallo(quien))
    return { ok: true, usuario }
  }

  /**
   * Busca a quien entra con usuario y contraseña. La espera va por quien intenta y también por el
   * usuario: probar contraseñas de una cuenta desde muchas IP no evita el freno. Un usuario que
   * no existe y una contraseña errada dan la misma respuesta y tardan lo mismo.
   */
  private conContrasena(
    quien: string,
    usuario: string,
    contrasena: string,
  ): { ok: true; usuario: UsuarioSesion } | ErrorAcceso {
    const nombre = normalizarUsuario(usuario)
    // Lo escrito no se guarda en la cuenta de intentos: pudo ser la contraseña en el campo errado.
    const cuenta = `usuario:${nombre ?? 'invalido'}`
    const espera = Math.max(this.intentos.esperaMs(quien), this.intentos.esperaMs(cuenta))
    if (espera > 0) return esperar(espera)
    const f = nombre
      ? this.db
          .prepare(
            `SELECT u.id, u.nombre, u.activo, r.nombre AS rol, c.contrasena_huella
             FROM usuario_credencial c
             JOIN usuario u ON u.id = c.usuario_id
             JOIN rol r ON r.id = u.rol_id
             WHERE c.restaurante_id = ? AND c.nombre_usuario = ? AND c.vigente = 1`,
          )
          .get(this.restauranteId, nombre)
      : undefined
    // Siempre se compara, con el mismo costo: no delata si el usuario existe ni si está activo.
    const guardada = f ? String(f.contrasena_huella) : this.relleno()
    // Una contraseña más larga que lo permitido nunca es la buena (no se corta para compararla).
    const coincide =
      contrasenaCoincide(contrasena.slice(0, LARGO_MAXIMO_CONTRASENA), guardada) &&
      contrasena.length <= LARGO_MAXIMO_CONTRASENA
    if (f?.activo !== 1 || !coincide) {
      const ms = Math.max(
        this.intentos.fallo(quien),
        this.intentos.fallo(cuenta, { contar: false, tope: ESPERA_MAXIMA_CUENTA_MS }),
      )
      return error('credenciales_incorrectas', CREDENCIALES_INCORRECTAS, ms)
    }
    return { ok: true, usuario: { id: String(f.id), nombre: String(f.nombre), rol: String(f.rol) } }
  }

  private relleno(): string {
    this.huellaDeRelleno ??= huellaContrasena('relleno', this.costoContrasena)
    return this.huellaDeRelleno
  }

  private usuarioPorPin(pin: string): UsuarioSesion | undefined {
    const f = this.db
      .prepare(
        `SELECT u.id, u.nombre, r.nombre AS rol FROM usuario_credencial c
         JOIN usuario u ON u.id = c.usuario_id AND u.activo = 1
         JOIN rol r ON r.id = u.rol_id
         WHERE c.restaurante_id = ? AND c.pin_huella = ? AND c.vigente = 1`,
      )
      .get(this.restauranteId, huellaPin(this.clave, this.restauranteId, pin))
    return f ? { id: String(f.id), nombre: String(f.nombre), rol: String(f.rol) } : undefined
  }

  /** El secreto de una sesión sale de la clave del hub: así puede comprobar firmas sin guardarlo. */
  private secretoDe(sesionId: string): string {
    return secretoDeSesion(this.clave, this.restauranteId, sesionId)
  }

  private sesionAbierta(
    conexion: Conexion,
    sesionId: string,
    secreto: string,
  ): { ok: true; usuarioId: string } | ErrorAcceso {
    if (conexion.revocadoEn) return error('dispositivo_revocado', 'Este equipo fue retirado')
    const s = this.db
      .prepare('SELECT * FROM sesion WHERE restaurante_id = ? AND id = ?')
      .get(this.restauranteId, sesionId)
    const vale =
      s !== undefined &&
      s.dispositivo_id === conexion.dispositivoId &&
      s.cerrada_en === null &&
      mismaHuella(String(s.secreto_hash), huellaSecreto(secreto)) &&
      this.usuarioActivo(String(s.usuario_id))
    if (!vale) return error('sesion_invalida', 'La sesión se cerró: vuelve a entrar')
    return { ok: true, usuarioId: String(s.usuario_id) }
  }

  private cerrarSesiones(filtro: string, valor: ValorSql, ahora: string) {
    this.db
      .prepare(
        `UPDATE sesion SET cerrada_en = ? WHERE restaurante_id = ? AND ${filtro} AND cerrada_en IS NULL`,
      )
      .run(ahora, this.restauranteId, valor)
  }

  private comprobanteVale(a: Fila, evento: EventoNuevo, permiso: Permiso, hora: number): boolean {
    const emitida = Date.parse(String(a.emitida_en))
    return (
      a.evento_id === evento.id &&
      a.agregado_id === evento.agregado_id &&
      a.accion === permiso &&
      a.sesion_id === evento.sesion_id &&
      a.contenido_hash === huellaAutorizable(evento) &&
      a.usada_en === null &&
      a.supervisor_id !== evento.usuario_id &&
      // La hora va dentro de la huella: la fijó el dispositivo al pedir el comprobante.
      hora >= emitida - TOLERANCIA_RELOJ_MS &&
      hora <= emitida + VIGENCIA_AUTORIZACION_MS &&
      Date.parse(this.reloj()) <= emitida + ENTREGA_AUTORIZADO_MS &&
      this.tienePermiso(String(a.supervisor_id), permiso)
    )
  }

  private tienePermiso(usuarioId: string, permiso: Permiso): boolean {
    return this.permisosDe(usuarioId).includes(permiso)
  }

  private usuarioActivo(usuarioId: string): boolean {
    const f = this.db
      .prepare('SELECT activo FROM usuario WHERE restaurante_id = ? AND id = ?')
      .get(this.restauranteId, usuarioId)
    return f?.activo === 1
  }

  /** Último cambio del usuario, su rol o los permisos del rol (ms); 0 si no existe. */
  private ultimoCambioDe(usuarioId: string): number {
    const f = this.db
      .prepare(
        `SELECT max(u.actualizado_en, r.actualizado_en,
           coalesce((SELECT max(actualizado_en) FROM rol_permiso WHERE rol_id = r.id), '')) AS m
         FROM usuario u JOIN rol r ON r.id = u.rol_id
         WHERE u.restaurante_id = ? AND u.id = ?`,
      )
      .get(this.restauranteId, usuarioId)
    return f?.m ? Date.parse(String(f.m)) : 0
  }

  /** Crea el equipo y su token (dentro de una transacción). El token se ve solo esta vez. */
  private registrarDispositivo(
    nombre: string,
    tipo: TipoDispositivo,
    aprobadoPor: string,
    ahora: string,
  ): { dispositivoId: string; token: string } {
    const token = nuevoSecreto()
    const dispositivoId = insertarVersionado(
      this.db,
      'dispositivo',
      this.restauranteId,
      {
        sede_id: this.sedePrincipal(),
        nombre,
        tipo,
        emparejado_en: ahora,
        revocado_en: null,
        secuencia_revocacion: null,
      },
      { usuarioId: aprobadoPor, dispositivoId: null },
      ahora,
    )
    this.db
      .prepare(
        `INSERT INTO dispositivo_credencial (dispositivo_id, restaurante_id, token_hash, creado_en)
         VALUES (?, ?, ?, ?)`,
      )
      .run(dispositivoId, this.restauranteId, huellaSecreto(token), ahora)
    return { dispositivoId, token }
  }

  private tipoDe(conexion: Conexion): TipoDispositivo {
    const f = this.db
      .prepare('SELECT tipo FROM dispositivo WHERE restaurante_id = ? AND id = ?')
      .get(this.restauranteId, conexion.dispositivoId)
    return f ? (String(f.tipo) as TipoDispositivo) : conexion.tipo
  }

  private hayDispositivos(): boolean {
    return (
      this.db
        .prepare(
          'SELECT 1 FROM dispositivo WHERE restaurante_id = ? AND activo = 1 AND revocado_en IS NULL LIMIT 1',
        )
        .get(this.restauranteId) !== undefined
    )
  }

  private sedePrincipal(): string {
    const f = this.db
      .prepare(
        'SELECT id FROM sede WHERE restaurante_id = ? AND activo = 1 ORDER BY creado_en, id LIMIT 1',
      )
      .get(this.restauranteId)
    if (!f) throw new Error('El restaurante no tiene sede')
    return String(f.id)
  }

  /** Un PIN que no tenga ningún usuario activo. */
  private pinLibre(): string {
    for (let i = 0; i < 500; i++) {
      const pin = generarPin()
      const ocupado = this.db
        .prepare(
          'SELECT 1 FROM usuario_credencial WHERE restaurante_id = ? AND pin_huella = ? AND vigente = 1',
        )
        .get(this.restauranteId, huellaPin(this.clave, this.restauranteId, pin))
      if (!ocupado) return pin
    }
    throw new ErrorDatos('No quedan PIN libres: archiva usuarios que ya no trabajen')
  }
}
