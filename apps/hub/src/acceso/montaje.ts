import { type EventoNuevo, firmarEvento, nuevoId } from '@pos/core'
import { aplicarMigraciones } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import type { Conexion } from '@pos/sync'
import { asegurarAdministrador, asegurarRestaurante, asegurarRoles } from './inicial'
import { Intentos } from './intentos'
import { ServicioAcceso } from './servicio'

// Montaje de las pruebas de acceso: un hub con su base en memoria, reloj manual y un usuario
// por rol. Solo para pruebas.

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
  })
  const admin = asegurarAdministrador(db, acceso, roles.admin, false)
  const personas = {
    admin: { usuarioId: '', pin: admin.pin as string },
    gerente: acceso.crearUsuario({ nombre: 'Gloria', rolId: roles.gerente }),
    cajero: acceso.crearUsuario({ nombre: 'Carlos', rolId: roles.cajero }),
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

  /** Abre sesión con el PIN de esa persona en ese dispositivo. */
  function entrar(conexion: Conexion, quien: keyof typeof personas) {
    const r = acceso.iniciarSesion(conexion, personas[quien].pin)
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
    roles,
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
