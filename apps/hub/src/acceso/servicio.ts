import {
  type EstadoPedido,
  type EventoNuevo,
  esPermiso,
  firmarEvento,
  huellaAutorizable,
  igualesSinFiltrarTiempo,
  nuevoId,
  type Permiso,
  permisoPara,
  SOLO_DESDE_CAJA,
} from '@pos/core'
import { type BaseSqlite, enTransaccion, type Fila, type ValorSql } from '@pos/db'
import type { Conexion, ControlAcceso, TipoDispositivo, VeredictoAcceso } from '@pos/sync'
import { Intentos } from './intentos'
import { type Autor, actualizarVersionado, insertarVersionado, SISTEMA } from './registros'
import {
  esPinConFormato,
  generarPin,
  huellaPin,
  huellaSecreto,
  mismaHuella,
  nuevoCodigoEmparejamiento,
  nuevoSecreto,
  secretoDeSesion,
} from './secretos'

// Emparejamiento, PIN, sesiones, comprobantes de supervisor y revocación (ADR-008,
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
}

const error = (codigo: CodigoAcceso, mensaje: string, esperaMs?: number): ErrorAcceso => ({
  ok: false,
  codigo,
  mensaje,
  ...(esperaMs === undefined ? {} : { esperaMs }),
})

const PIN_INCORRECTO = 'PIN incorrecto'
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

export class ServicioAcceso implements ControlAcceso {
  private readonly db: BaseSqlite
  private readonly restauranteId: string
  private readonly clave: Buffer
  private readonly reloj: () => string
  private readonly intentos: Intentos
  private readonly alRevocar: OpcionesAcceso['alRevocar']
  private readonly claveDesde: number
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

    const token = nuevoSecreto()
    const dispositivoId = enTransaccion(this.db, () => {
      const id = insertarVersionado(
        this.db,
        'dispositivo',
        this.restauranteId,
        {
          sede_id: this.sedePrincipal(),
          nombre: e.nombre,
          tipo: e.tipo,
          emparejado_en: ahora,
          revocado_en: null,
          secuencia_revocacion: null,
        },
        { usuarioId: e.aprobadoPor, dispositivoId: null },
        ahora,
      )
      this.db
        .prepare(
          `INSERT INTO dispositivo_credencial (dispositivo_id, restaurante_id, token_hash, creado_en)
           VALUES (?, ?, ?, ?)`,
        )
        .run(id, this.restauranteId, huellaSecreto(token), ahora)
      return id
    })
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
    })
    this.alRevocar?.(datos.dispositivoId, ahora)
    return { ok: true, revocadoEn: ahora }
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
    const r = this.conPin(`dispositivo:${conexion.dispositivoId}`, pin, () => true, PIN_INCORRECTO)
    if (!r.ok) return r

    const ahora = this.reloj()
    const sesionId = nuevoId()
    const secreto = this.secretoDe(sesionId)
    enTransaccion(this.db, () => {
      this.cerrarSesiones('dispositivo_id = ?', conexion.dispositivoId, ahora)
      this.db
        .prepare(
          `INSERT INTO sesion (id, restaurante_id, usuario_id, dispositivo_id, secreto_hash, inicio, ultimo_uso)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sesionId,
          this.restauranteId,
          r.usuario.id,
          conexion.dispositivoId,
          huellaSecreto(secreto),
          ahora,
          ahora,
        )
    })
    return {
      ok: true,
      sesionId,
      secreto,
      usuario: r.usuario,
      permisos: this.permisosDe(r.usuario.id),
    }
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
    if (SOLO_DESDE_CAJA.has(evento.tipo) && conexion.tipo !== 'caja') return no('solo_caja')
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
  crearUsuario(
    datos: { nombre: string; rolId: string },
    autor: Autor = SISTEMA,
  ): { usuarioId: string; pin: string } {
    const nombre = datos.nombre.trim()
    if (nombre.length === 0 || nombre.length > 60)
      throw new Error('El nombre debe tener entre 1 y 60 letras')
    const rol = this.db
      .prepare('SELECT 1 FROM rol WHERE restaurante_id = ? AND id = ? AND activo = 1')
      .get(this.restauranteId, datos.rolId)
    if (!rol) throw new Error('Ese rol no existe o está archivado')

    const ahora = this.reloj()
    return enTransaccion(this.db, () => {
      const usuarioId = insertarVersionado(
        this.db,
        'usuario',
        this.restauranteId,
        { nombre, rol_id: datos.rolId },
        autor,
        ahora,
      )
      const pin = this.pinLibre()
      this.db
        .prepare(
          `INSERT INTO usuario_credencial (usuario_id, restaurante_id, pin_huella, pin_generado_en)
           VALUES (?, ?, ?, ?)`,
        )
        .run(usuarioId, this.restauranteId, huellaPin(this.clave, this.restauranteId, pin), ahora)
      return { usuarioId, pin }
    })
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
    if (!vale) return error('sesion_invalida', 'La sesión se cerró: vuelve a escribir tu PIN')
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
    throw new Error('No quedan PIN libres: archiva usuarios que ya no trabajen')
  }
}
