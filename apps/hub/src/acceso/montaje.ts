import { type NewEvent, newId, PERMISSIONS, signEvent } from '@pos/core'
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

export type Sesion = { sesionId: string; secret: string; user: { id: string } }

/** El evento con la firma de esa sesión (lo que hace la app tras cada cambio del evento). */
export const firmado = <E extends NewEvent>(session: Sesion, event: E): E => {
  const { signature: _vieja, ...sinFirma } = event
  return { ...sinFirma, signature: signEvent(sinFirma as NewEvent, session.secret) } as E
}

export function montarAcceso() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db)
  let ms = INICIO
  const clock = () => new Date(ms).toISOString()
  const avisos: string[] = []
  const revocados: string[] = []
  const attempts = new Intentos(
    () => ms,
    (n) => avisos.push(n),
  )
  const restauranteId = asegurarRestaurante(db, clock())
  const roles = asegurarRoles(db, restauranteId, clock())
  const access = new ServicioAcceso({
    db,
    restauranteId,
    key: Buffer.alloc(32, 7),
    clock,
    attempts,
    onRevoke: (id) => revocados.push(id),
    // Rápido: aquí no se prueba cuánto cuesta adivinar una contraseña.
    costoContrasena: 1,
  })
  const admin = asegurarAdministrador(db, access, roles.admin, false)
  const ownOnes = {
    manager: guardarRol(
      db,
      restauranteId,
      access,
      {
        name: 'Gerente',
        permissions: PERMISSIONS.filter(
          (p) => !['manage_users', 'manage_devices', 'view_own_reports'].includes(p),
        ),
      },
      SISTEMA,
      clock(),
    ),
    kitchen: guardarRol(
      db,
      restauranteId,
      access,
      { name: 'Cocina', permissions: ['mark_preparation', 'mark_product_sold_out'] },
      SISTEMA,
      clock(),
    ),
  }
  const todosLosRoles = { ...roles, ...ownOnes }
  const people: Record<
    'admin' | 'manager' | 'cashier' | 'waiter' | 'waiter2',
    { userId: string; pin: string; user?: string; password?: string }
  > = {
    admin: {
      userId: '',
      pin: admin.pin as string,
      user: admin.user as string,
      password: admin.password as string,
    },
    // Con permisos de caja o de administración se entra con contraseña (ADR-013).
    manager: {
      ...access.crearUsuario({
        name: 'Gloria',
        rolId: ownOnes.manager,
        user: 'gloria',
        password: 'clave-de-gloria',
      }),
      user: 'gloria',
      password: 'clave-de-gloria',
    },
    cashier: {
      ...access.crearUsuario({
        name: 'Carlos',
        rolId: roles.cashier,
        user: 'carlos',
        password: 'clave-de-carlos',
      }),
      user: 'carlos',
      password: 'clave-de-carlos',
    },
    waiter: access.crearUsuario({ name: 'Ana', rolId: roles.waiter }),
    waiter2: access.crearUsuario({ name: 'Luis', rolId: roles.waiter }),
  }
  people.admin.userId = String(
    db.prepare("SELECT id FROM users WHERE name = 'Administrador'").get()?.id,
  )

  let aprobador: Conexion | null = null

  /** Empareja un dispositivo de ese tipo (aprobado por el admin) y devuelve su conexión. */
  function emparejar(type: 'waiter' | 'register' | 'kds' = 'waiter', name = `Equipo ${type}`) {
    // El primero se aprueba sin equipo (la caja recién instalada); los demás, desde ese.
    const code = access.crearEmparejamiento({ pin: people.admin.pin, name, type }, aprobador)
    if (!code.ok) throw new Error(code.message)
    const r = access.emparejar(code.code, '10.0.0.9')
    if (!r.ok) throw new Error(r.message)
    const connection = access.authenticate(r.token) as Conexion
    aprobador ??= connection
    return { token: r.token, connection }
  }

  /**
   * Abre sesión en ese dispositivo: con su PIN, o con usuario y contraseña si los tiene (el
   * administrador). Entrar con contraseña vuelve de caja el equipo (ADR-013).
   */
  function entrar(connection: Conexion, quien: keyof typeof people) {
    const p = people[quien]
    const r =
      p.user && p.password
        ? access.entrar({ user: p.user, password: p.password }, connection, '10.0.0.9')
        : access.startSession(connection, p.pin)
    if (!r.ok) throw new Error(r.message)
    return r
  }

  /** Un evento como lo crearía la app en ese dispositivo, con esa sesión, ya firmado. */
  function event(
    connection: Conexion,
    session: Sesion,
    type: string,
    data: unknown,
    extras: Partial<NewEvent> = {},
  ) {
    return firmado(session, {
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: newId(),
      related: [],
      data,
      session_id: session.sesionId,
      user_id: session.user.id,
      device_id: connection.dispositivoId,
      authorization_id: null,
      reason: null,
      device_time: clock(),
      hub_estimated_time: clock(),
      base_sequence: 0,
      ...extras,
    } as NewEvent)
  }

  return {
    firmado,
    db,
    access,
    roles: todosLosRoles,
    restauranteId,
    people,
    avisos,
    revocados,
    clock,
    avanzar: (n: number) => {
      ms += n
    },
    emparejar,
    entrar,
    event,
  }
}

export type MontajeAcceso = ReturnType<typeof montarAcceso>
