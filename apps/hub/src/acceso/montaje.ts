import { type EventoNuevo, firmarEvento, nuevoId, PERMISOS } from '@pos/core'
import { aplicarMigraciones } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import type { Conexion } from '@pos/sync'
import { asegurarAdministrador, asegurarRestaurante, asegurarRoles } from './inicial'
import { Intentos } from './intentos'
import { guardarRol } from './personal'
import { SISTEMA } from './registros'
import { ServicioAcceso } from './servicio'

// Montaje de las pruebas de acceso: un hub con su base en memoria, reloj manual y un usuario
// por rol. Además de los de fábrica, un rol propio «Gerente» (lo que era de fábrica antes de
// ADR-013) y «Cocina». Solo para pruebas.

export const INICIO = Date.parse('2026-10-24T20:00:00.000Z')

export type Sesion = { sesionId: string; secreto: string; usuario: { id: string } }

/** El evento con la firma de esa sesión (lo que hace la app tras cada cambio del evento). */
export const firmado = <E extends EventoNuevo>(sesion: Sesion, evento: E): E => {
  const { firma: _vieja, ...sinFirma } = evento
  return { ...sinFirma, firma: firmarEvento(sinFirma as EventoNuevo, sesion.secreto) } as E
}

export function montarAcceso() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db)
  let ms = INICIO
  const reloj = () => new Date(ms).toISOString()
  const avisos: string[] = []
  const revocados: string[] = []
  const intentos = new Intentos(
    () => ms,
    (n) => avisos.push(n),
  )
  const restauranteId = asegurarRestaurante(db, reloj())
  const roles = asegurarRoles(db, restauranteId, reloj())
  const acceso = new ServicioAcceso({
    db,
    restauranteId,
    clave: Buffer.alloc(32, 7),
    reloj,
    intentos,
    alRevocar: (id) => revocados.push(id),
    // Rápido: aquí no se prueba cuánto cuesta adivinar una contraseña.
    costoContrasena: 1,
  })
  const admin = asegurarAdministrador(db, acceso, roles.admin, false)
  const propios = {
    gerente: guardarRol(
      db,
      restauranteId,
      acceso,
      {
        nombre: 'Gerente',
        permisos: PERMISOS.filter(
          (p) =>
            !['administrar_usuarios', 'administrar_dispositivos', 'ver_reportes_propios'].includes(
              p,
            ),
        ),
      },
      SISTEMA,
      reloj(),
    ),
    cocina: guardarRol(
      db,
      restauranteId,
      acceso,
      { nombre: 'Cocina', permisos: ['marcar_preparacion', 'agotar_producto'] },
      SISTEMA,
      reloj(),
    ),
  }
  const todosLosRoles = { ...roles, ...propios }
  const personas: Record<
    'admin' | 'gerente' | 'cajero' | 'mesero' | 'mesero2',
    { usuarioId: string; pin: string; usuario?: string; contrasena?: string }
  > = {
    admin: {
      usuarioId: '',
      pin: admin.pin as string,
      usuario: admin.usuario as string,
      contrasena: admin.contrasena as string,
    },
    // Con permisos de caja o de administración se entra con contraseña (ADR-013).
    gerente: {
      ...acceso.crearUsuario({
        nombre: 'Gloria',
        rolId: propios.gerente,
        usuario: 'gloria',
        contrasena: 'clave-de-gloria',
      }),
      usuario: 'gloria',
      contrasena: 'clave-de-gloria',
    },
    cajero: {
      ...acceso.crearUsuario({
        nombre: 'Carlos',
        rolId: roles.cajero,
        usuario: 'carlos',
        contrasena: 'clave-de-carlos',
      }),
      usuario: 'carlos',
      contrasena: 'clave-de-carlos',
    },
    mesero: acceso.crearUsuario({ nombre: 'Ana', rolId: roles.mesero }),
    mesero2: acceso.crearUsuario({ nombre: 'Luis', rolId: roles.mesero }),
  }
  personas.admin.usuarioId = String(
    db.prepare("SELECT id FROM usuario WHERE nombre = 'Administrador'").get()?.id,
  )

  let aprobador: Conexion | null = null

  /** Empareja un dispositivo de ese tipo (aprobado por el admin) y devuelve su conexión. */
  function emparejar(tipo: 'mesero' | 'caja' | 'kds' = 'mesero', nombre = `Equipo ${tipo}`) {
    // El primero se aprueba sin equipo (la caja recién instalada); los demás, desde ese.
    const codigo = acceso.crearEmparejamiento({ pin: personas.admin.pin, nombre, tipo }, aprobador)
    if (!codigo.ok) throw new Error(codigo.mensaje)
    const r = acceso.emparejar(codigo.codigo, '10.0.0.9')
    if (!r.ok) throw new Error(r.mensaje)
    const conexion = acceso.autenticar(r.token) as Conexion
    aprobador ??= conexion
    return { token: r.token, conexion }
  }

  /**
   * Abre sesión en ese dispositivo: con su PIN, o con usuario y contraseña si los tiene (el
   * administrador). Entrar con contraseña vuelve de caja el equipo (ADR-013).
   */
  function entrar(conexion: Conexion, quien: keyof typeof personas) {
    const p = personas[quien]
    const r =
      p.usuario && p.contrasena
        ? acceso.entrar({ usuario: p.usuario, contrasena: p.contrasena }, conexion, '10.0.0.9')
        : acceso.iniciarSesion(conexion, p.pin)
    if (!r.ok) throw new Error(r.mensaje)
    return r
  }

  /** Un evento como lo crearía la app en ese dispositivo, con esa sesión, ya firmado. */
  function evento(
    conexion: Conexion,
    sesion: Sesion,
    tipo: string,
    datos: unknown,
    extras: Partial<EventoNuevo> = {},
  ) {
    return firmado(sesion, {
      id: nuevoId(),
      tipo,
      version_esquema: 1,
      agregado_tipo: 'pedido',
      agregado_id: nuevoId(),
      relacionados: [],
      datos,
      sesion_id: sesion.sesionId,
      usuario_id: sesion.usuario.id,
      dispositivo_id: conexion.dispositivoId,
      autorizacion_id: null,
      motivo: null,
      hora_dispositivo: reloj(),
      hora_estimada_hub: reloj(),
      secuencia_base: 0,
      ...extras,
    } as EventoNuevo)
  }

  return {
    firmado,
    db,
    acceso,
    roles: todosLosRoles,
    restauranteId,
    personas,
    avisos,
    revocados,
    reloj,
    avanzar: (n: number) => {
      ms += n
    },
    emparejar,
    entrar,
    evento,
  }
}

export type MontajeAcceso = ReturnType<typeof montarAcceso>
