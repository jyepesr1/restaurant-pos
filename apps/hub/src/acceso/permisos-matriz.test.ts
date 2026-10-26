import { isPermission, ORDER_EVENT_TYPES, PERMISSIONS, type Permission } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { montarAcceso } from './montaje'
import { autorizarEvento } from './montaje-hub'

// La matriz de docs/MODELO_DATOS.md#permisos, escrita aquí a mano (no leída del código) y
// comprobada de punta a punta: roles sembrados en la base × cada tipo de evento, por `verificar`.
// Los de fábrica son admin, cajero, reportes y mesero (ADR-013); gerente y cocina son roles
// propios que crea el montaje, como los que haría un restaurante.

type Rol = 'admin' | 'manager' | 'cashier' | 'waiter' | 'kitchen' | 'reports'
const ROLES: Rol[] = ['admin', 'manager', 'cashier', 'waiter', 'kitchen', 'reports']

const DOC: Record<Permission, Rol[]> = {
  take_order: ['admin', 'manager', 'cashier', 'waiter'],
  remove_unsent_item: ['admin', 'manager', 'cashier', 'waiter'],
  void_sent_item: ['admin', 'manager', 'cashier'],
  cancel_order: ['admin', 'manager'],
  apply_discount: ['admin', 'manager', 'cashier'],
  comp: ['admin', 'manager'],
  reassign_table: ['admin', 'manager', 'cashier'],
  split_check: ['admin', 'manager', 'cashier'],
  record_payment: ['admin', 'manager', 'cashier'],
  void_payment: ['admin', 'manager'],
  close_table: ['admin', 'manager', 'cashier'],
  reopen_check: ['admin', 'manager'],
  open_register_shift: ['admin', 'manager', 'cashier'],
  close_register_shift: ['admin', 'manager', 'cashier'],
  cash_movement: ['admin', 'manager', 'cashier'],
  open_drawer_no_sale: ['admin', 'manager'],
  mark_preparation: ['admin', 'manager', 'waiter', 'kitchen'],
  mark_product_sold_out: ['admin', 'manager', 'cashier', 'kitchen'],
  edit_catalog: ['admin', 'manager'],
  edit_prices: ['admin', 'manager'],
  manage_users: ['admin'],
  manage_devices: ['admin'],
  view_reports: ['admin', 'manager', 'reports'],
  view_own_reports: ['cashier', 'waiter'],
}

/** Qué permiso pide cada evento según la columna «Permiso» de la tabla del documento. */
const EVENTO_DOC: Record<string, Permission | null> = {
  OrderOpened: 'take_order',
  GuestsChanged: 'take_order',
  OrderNoteChanged: 'take_order',
  TablesMerged: 'take_order',
  TablesSeparated: 'take_order',
  ItemAdded: 'take_order',
  ItemChanged: 'take_order',
  ItemsSent: 'take_order',
  ItemModifiedAfterSend: 'take_order',
  TicketReprinted: 'take_order',
  CourseHeld: 'take_order',
  CourseFired: 'take_order',
  ItemsMoved: 'take_order',
  OrderMovedTable: 'take_order',
  OrdersMerged: 'take_order',
  PreBillPrinted: 'take_order',
  ItemRemoved: 'remove_unsent_item',
  ItemVoided: 'void_sent_item',
  OrderCanceled: 'cancel_order',
  DiscountApplied: 'apply_discount',
  DiscountRemoved: 'apply_discount',
  WaiterAssigned: 'reassign_table',
  CheckSplit: 'split_check',
  SplitUndone: 'split_check',
  PaymentRecorded: 'record_payment',
  PaymentVoided: 'void_payment',
  RefundRecorded: 'void_payment',
  OrderClosed: 'close_table',
  OrderReopened: 'reopen_check',
  ItemInPreparation: 'mark_preparation',
  ItemReady: 'mark_preparation',
  ItemServed: 'mark_preparation',
  ItemReturnedToQueue: 'mark_preparation',
  RescueOrderCreated: null,
  // Agotado (86): eventos del producto, no del pedido (tarea 1.3).
  ProductSoldOut: 'mark_product_sold_out',
  ProductAvailable: 'mark_product_sold_out',
  // Abrir la caja con la base (tarea 1.6): evento del turno, no del pedido.
  ShiftOpened: 'open_register_shift',
  // Movimientos, arqueo y cierre de caja (tarea 1.7).
  CashMovementRecorded: 'cash_movement',
  CashCountRecorded: 'close_register_shift',
  ShiftClosed: 'close_register_shift',
}

const SOLO_CAJA_DOC = [
  'ShiftOpened',
  'CashMovementRecorded',
  'CashCountRecorded',
  'ShiftClosed',
  'PaymentRecorded',
  'PaymentVoided',
  'RefundRecorded',
  'OrderClosed',
]

function montar() {
  const m = montarAcceso()
  const kitchen = m.access.crearUsuario({ name: 'Coco', rolId: m.roles.kitchen })
  // Ver reportes pide contraseña (ADR-013).
  const reports = m.access.crearUsuario({
    name: 'Repo',
    rolId: m.roles.reports,
    user: 'repo',
    password: 'clave-de-repo',
  })
  const pin: Record<Rol, string> = {
    admin: m.people.admin.pin,
    manager: m.people.manager.pin,
    cashier: m.people.cashier.pin,
    waiter: m.people.waiter.pin,
    kitchen: kitchen.pin,
    reports: reports.pin,
  }
  const usuarios: Record<Rol, string> = {
    admin: m.people.admin.userId,
    manager: m.people.manager.userId,
    cashier: m.people.cashier.userId,
    waiter: m.people.waiter.userId,
    kitchen: kitchen.userId,
    reports: reports.userId,
  }

  /** Un dispositivo del tipo dado, con sesión abierta de ese rol (uno por rol: no se pisan). */
  function sesionDe(role: Rol, type: 'register' | 'waiter' | 'kds') {
    const { connection } = m.emparejar(type, `${type}-${role}`)
    // Quien tiene permisos de caja o de administración entra con usuario y contraseña; el resto,
    // con su PIN.
    const r =
      role === 'admin' || role === 'manager' || role === 'cashier'
        ? m.entrar(connection, role)
        : role === 'reports'
          ? m.access.entrar({ user: 'repo', password: 'clave-de-repo' }, connection, '10.0.0.9')
          : m.access.startSession(connection, pin[role])
    if (!r.ok) throw new Error(r.message)
    return { connection, session: r }
  }
  return { ...m, pin, usuarios, sesionDe }
}

describe('la matriz de permisos del documento, por rol', () => {
  it('la tabla del documento cubre todas las claves de permiso y todos los tipos de evento', () => {
    expect(Object.keys(DOC).sort()).toEqual([...PERMISSIONS].sort())
    expect(Object.keys(EVENTO_DOC).sort()).toEqual([...ORDER_EVENT_TYPES].sort())
  })

  it('cada rol sembrado en la base tiene exactamente los permisos de su columna', () => {
    const m = montar()
    for (const role of ROLES) {
      const esperados = PERMISSIONS.filter((p) => DOC[p].includes(role)).sort()
      expect(m.access.permisosDe(m.usuarios[role]), role).toEqual(esperados)
    }
  })

  it('la sesión entrega al dispositivo los permisos de su rol', () => {
    const m = montar()
    for (const role of ROLES) {
      const { session } = m.sesionDe(role, 'register')
      expect([...session.permissions].sort(), role).toEqual(
        PERMISSIONS.filter((p) => DOC[p].includes(role)).sort(),
      )
    }
  })

  for (const role of ROLES) {
    it(`${role}: cada evento se acepta o se niega según la matriz (desde una caja)`, () => {
      const m = montar()
      const { connection, session } = m.sesionDe(role, 'register')
      const fallos: string[] = []
      for (const type of ORDER_EVENT_TYPES) {
        const permission = EVENTO_DOC[type] as Permission | null
        const v = m.access.verify(connection, m.event(connection, session, type, {}), null)
        const expected =
          permission === null
            ? { ok: false, reason: 'hub_only' }
            : DOC[permission].includes(role)
              ? { ok: true, authorizedById: null, autorizacionId: null }
              : { ok: false, reason: 'no_permission' }
        if (JSON.stringify(v) !== JSON.stringify(expected))
          fallos.push(`${type}: ${JSON.stringify(v)} (esperaba ${JSON.stringify(expected)})`)
      }
      expect(fallos).toEqual([])
    })
  }

  it('la cortesía pide su propio permiso, no el de descontar', () => {
    const m = montar()
    for (const role of ROLES) {
      const { connection, session } = m.sesionDe(role, 'register')
      const comp = m.event(connection, session, 'DiscountApplied', { rule: 'comp' })
      const percent = m.event(connection, session, 'DiscountApplied', { rule: 'percent' })
      expect(m.access.verify(connection, comp, null).ok, `${role} cortesía`).toBe(
        DOC.comp.includes(role),
      )
      expect(m.access.verify(connection, percent, null).ok, `${role} descuento`).toBe(
        DOC.apply_discount.includes(role),
      )
    }
  })

  it('si a un rol se le quita solo «cortesia», sigue pudiendo descontar (y al revés)', () => {
    const m = montar()
    const { connection, session } = m.sesionDe('manager', 'register')
    const comp = m.event(connection, session, 'DiscountApplied', { rule: 'comp' })
    const percent = m.event(connection, session, 'DiscountApplied', { rule: 'percent' })

    m.db
      .prepare("UPDATE role_permissions SET active = 0 WHERE permission = 'comp' AND role_id = ?")
      .run(m.roles.manager)
    expect(m.access.verify(connection, comp, null)).toEqual({
      ok: false,
      reason: 'no_permission',
    })
    expect(m.access.verify(connection, percent, null).ok).toBe(true)
  })

  it('pagos, reembolsos y cierres solo salen de una caja: ni el administrador desde un KDS', () => {
    const m = montar()
    for (const tipoDispositivo of ['waiter', 'kds'] as const)
      for (const role of ROLES) {
        // Entrar con contraseña quien puede cobrar vuelve de caja un celular (ADR-013): se prueba
        // aparte.
        if (['admin', 'manager', 'cashier'].includes(role) && tipoDispositivo === 'waiter') continue
        const { connection, session } = m.sesionDe(role, tipoDispositivo)
        for (const type of SOLO_CAJA_DOC)
          expect(
            m.access.verify(connection, m.event(connection, session, type, {}), null),
            `${role}/${tipoDispositivo}/${type}`,
          ).toEqual({ ok: false, reason: 'register_only' })
      }
  })

  it('quien entra con contraseña en un celular lo vuelve de caja y desde ahí puede cobrar', () => {
    const m = montar()
    const { connection, session } = m.sesionDe('admin', 'waiter')
    expect(
      m.db.prepare('SELECT type FROM devices WHERE id = ?').get(connection.dispositivoId)?.type,
    ).toBe('register')
    // La conexión abierta antes de entrar todavía dice «mesero»: el hub mira el equipo guardado.
    expect(connection.type).toBe('waiter')
    for (const type of SOLO_CAJA_DOC)
      expect(
        m.access.verify(connection, m.event(connection, session, type, {}), null).ok,
        type,
      ).toBe(true)
  })

  it('el resto de eventos no distingue el tipo de dispositivo', () => {
    const m = montar()
    const types = ORDER_EVENT_TYPES.filter(
      (t) => !SOLO_CAJA_DOC.includes(t) && EVENTO_DOC[t] !== null,
    )
    for (const tipoDispositivo of ['waiter', 'register', 'kds'] as const) {
      const { connection, session } = m.sesionDe('manager', tipoDispositivo)
      for (const t of types)
        expect(m.access.verify(connection, m.event(connection, session, t, {}), null).ok, t).toBe(
          true,
        )
    }
  })

  it('PedidoRescateCreado lo emite solo el hub: ni el administrador lo crea', () => {
    const m = montar()
    const { connection, session } = m.sesionDe('admin', 'register')
    expect(
      m.access.verify(connection, m.event(connection, session, 'RescueOrderCreated', {}), null),
    ).toEqual({ ok: false, reason: 'hub_only' })
  })
})

describe('comprobante de supervisor para cada evento sin permiso', () => {
  it('quien no tiene el permiso lo consigue con un supervisor que sí lo tiene, para todo evento posible', () => {
    const m = montar()
    // El mesero escribe en una caja: así se prueban también pagos y cierres.
    const { connection, session } = m.sesionDe('waiter', 'register')
    const sinPermiso = ORDER_EVENT_TYPES.filter((t) => {
      const p = EVENTO_DOC[t] as Permission | null
      return p !== null && !DOC[p].includes('waiter')
    })
    expect(sinPermiso.length).toBeGreaterThan(10)

    for (const type of sinPermiso) {
      const ev = m.event(connection, session, type, { rule: 'comp' })
      const action = EVENTO_DOC[type] as Permission
      // «cortesia» solo aplica a DiscountApplied con esa regla.
      const necesaria = type === 'DiscountApplied' ? 'comp' : action
      const { comprobante, event } = autorizarEvento(
        m,
        connection,
        session,
        m.pin.admin,
        ev,
        necesaria,
      )
      expect(m.access.verify(connection, event, null), type).toEqual({
        ok: true,
        authorizedById: m.usuarios.admin,
        autorizacionId: comprobante.autorizacionId,
      })
    }
  })

  it('un supervisor sin ese permiso no puede emitir el comprobante, rol por rol y permiso por permiso', () => {
    const m = montar()
    // El administrador (con todos los permisos) está en el celular; los demás intentan autorizar.
    const { connection, session } = m.sesionDe('waiter', 'waiter')
    // Un intento tras otro sería esperar: cada PIN válido (de alguien sin el permiso) cuenta como fallo.
    // Se avanza el reloj lo suficiente para que la espera nunca estorbe.
    for (const permission of PERMISSIONS)
      for (const role of ROLES) {
        m.avanzar(61_000)
        const r = m.access.autorizar(connection, {
          ...session,
          pin: m.pin[role],
          action: permission,
          agregadoId: m.restauranteId,
          eventId: `${permission}-${role}`.padEnd(26, 'X').slice(0, 26),
          fingerprint: '0'.repeat(64),
        })
        if (role === 'waiter') {
          expect(r, `mesero/${permission}`).toMatchObject({ ok: false, code: 'self_authorization' })
        } else if (DOC[permission].includes(role)) {
          expect(r.ok, `${role}/${permission}`).toBe(true)
        } else {
          expect(r, `${role}/${permission}`).toMatchObject({ ok: false, code: 'wrong_pin' })
        }
      }
  })

  it('el comprobante de «descontar» no sirve para una cortesía, ni al revés', () => {
    const m = montar()
    const { connection, session } = m.sesionDe('waiter', 'register')
    const tryAction = (emitidoPara: Permission, rule: string) => {
      const ev = m.event(connection, session, 'DiscountApplied', { rule })
      const r = autorizarEvento(m, connection, session, m.pin.manager, ev, emitidoPara)
      return m.access.verify(connection, r.event, null)
    }

    expect(tryAction('apply_discount', 'comp')).toEqual({
      ok: false,
      reason: 'invalid_authorization',
    })
    expect(tryAction('comp', 'percent')).toEqual({
      ok: false,
      reason: 'invalid_authorization',
    })
    expect(tryAction('comp', 'comp').ok).toBe(true)
    expect(tryAction('apply_discount', 'percent').ok).toBe(true)
  })

  it('el comprobante no salta la regla «solo desde la caja»', () => {
    const m = montar()
    const { connection, session } = m.sesionDe('waiter', 'waiter')
    const ev = m.event(connection, session, 'PaymentRecorded', {})
    const r = autorizarEvento(m, connection, session, m.pin.admin, ev, 'record_payment')

    expect(m.access.verify(connection, r.event, null)).toEqual({
      ok: false,
      reason: 'register_only',
    })
  })

  it('una acción que no es permiso (ni inventada) no se autoriza', () => {
    const m = montar()
    const { connection, session } = m.sesionDe('waiter', 'waiter')
    for (const action of ['delete_all', '', 'constructor', '__proto__', 'TAKE_ORDER'])
      expect(
        m.access.autorizar(connection, {
          ...session,
          pin: m.pin.admin,
          action,
          agregadoId: m.restauranteId,
          eventId: `E-${action}`.padEnd(26, 'X').slice(0, 26),
          fingerprint: '0'.repeat(64),
        }),
        action,
      ).toMatchObject({ ok: false, code: 'invalid_data' })
    for (const p of PERMISSIONS) expect(isPermission(p)).toBe(true)
  })
})
