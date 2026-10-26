import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { authorizableFingerprint, type NewEvent, newId } from '@pos/core'
import { applyMigrations } from '@pos/db'
import { openDatabase } from '@pos/db/node'
import { type AccessControl, type Connection, HubSync } from '@pos/sync'
import { SqliteStore } from '@pos/sync/sqlite'
import { expect } from 'vitest'
import { asegurarAdministrador, asegurarRestaurante, asegurarRoles } from './inicial'
import { Intentos } from './intentos'
import { firmado, INICIO, type MontajeAcceso, montarAcceso } from './montaje'
import { cargarClave } from './secretos'
import { ServicioAcceso } from './servicio'

// Utilidades de prueba: el hub de sincronización completo sobre el montaje de acceso, y un hub
// sobre una carpeta de datos real que se puede "apagar" y volver a levantar.

export const item = (
  modifiers: { modifier_id: string; name: string; extra_price: number }[] = [],
) => ({
  item_id: newId(),
  product_id: newId(),
  variant_id: null,
  name: 'Aperol Spritz',
  unit_price: 32_000,
  tax_type: 'inc' as const,
  rate: 800,
  quantity: 1,
  guest: null,
  course: null,
  modifiers,
  notes: null,
  catalog_version: 1,
  price_channel_id: null,
})

export const ABRIR = { channel: 'dine_in', table_id: null, guests: 2 }

/** El montaje de acceso con un `HubSync` sobre la misma base. */
export function montarHub(envolver: (a: AccessControl) => AccessControl = (a) => a) {
  const m = montarAcceso()
  const hub = new HubSync(new SqliteStore(m.db, m.restaurantId), {
    restaurantId: m.restaurantId,
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    instance: 'hub-1',
    clock: m.clock,
    access: envolver(m.access),
  })
  return { ...m, hub }
}
export type MontajeHub = ReturnType<typeof montarHub>

/** Un pedido abierto por el mesero con un ítem ya enviado a cocina. */
export function pedidoConItemEnviado(
  m: MontajeAcceso & { hub: HubSync },
  modifiers: { modifier_id: string; name: string; extra_price: number }[] = [],
) {
  const { connection, token } = m.emparejar('waiter')
  const session = m.entrar(connection, 'waiter')
  const order = newId()
  const it = item(modifiers)
  const comandaId = newId()
  const en = { aggregate_id: order }
  const r = m.hub.receiveBatch(connection, [
    m.event(connection, session, 'OrderOpened', ABRIR, en),
    m.event(connection, session, 'ItemAdded', it, { ...en, base_sequence: 1 }),
    m.event(
      connection,
      session,
      'ItemsSent',
      { tickets: [{ ticket_id: comandaId, station_id: newId(), item_ids: [it.item_id] }] },
      { ...en, base_sequence: 2 },
    ),
  ])
  expect(r.results.map((x) => x.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
  return { connection, token, session, order, itemId: it.item_id, comandaId }
}

export const datosAnular = (itemId: string) => ({
  item_id: itemId,
  quantity: 1,
  already_prepared: false,
  ticket_id: null,
})

type Sesion = Parameters<typeof firmado>[0]

/** El evento con la firma de esa sesión (como lo deja la app tras crearlo). */
export const firmar = firmado

/**
 * El supervisor autoriza ese evento exacto: devuelve el comprobante y el evento con su
 * `authorization_id`, ya firmado de nuevo.
 */
export function autorizarEvento(
  m: Pick<MontajeAcceso, 'access'>,
  connection: Connection,
  session: Sesion & { secret: string; sesionId: string },
  pin: string,
  event: NewEvent,
  action = 'void_sent_item',
) {
  const a = m.access.autorizar(connection, {
    sesionId: session.sesionId,
    secret: session.secret,
    pin,
    action,
    aggregateId: event.aggregate_id,
    eventId: event.id,
    fingerprint: authorizableFingerprint(event),
  })
  if (!a.ok) throw new Error(a.message)
  return {
    comprobante: a,
    event: firmar(session, { ...event, authorization_id: a.authorizationId }),
  }
}

export const add = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString()

/**
 * Un hub sobre una carpeta de datos real, como lo arma `main.ts`: base en archivo y clave de los
 * PIN en la misma carpeta. `levantar()` es "encender el proceso"; `apagar()`, una caída: la
 * memoria (códigos de emparejamiento, esperas por intentos) se pierde y la carpeta queda.
 */
export function hubEnCarpeta(dirDatos: string) {
  let ms = INICIO
  const clock = () => new Date(ms).toISOString()
  let openHandles: { close(): void }[] = []
  // El reloj de la prueba es manual: la clave cuenta desde la hora (manual) en que se creó.
  let claveDesde = ''

  function spinUp() {
    mkdirSync(dirDatos, { recursive: true })
    const db = openDatabase(join(dirDatos, 'pos.sqlite'))
    openHandles.push(db as unknown as { close(): void })
    applyMigrations(db)
    const { key, newOne } = cargarClave(dirDatos)
    if (newOne) claveDesde = clock()
    const restaurantId = asegurarRestaurante(db, clock())
    const roles = asegurarRoles(db, restaurantId, clock())
    const access = new ServicioAcceso({
      db,
      restaurantId,
      key,
      clock,
      attempts: new Intentos(() => ms),
      claveDesde,
      costoContrasena: 1,
    })
    const admin = asegurarAdministrador(db, access, roles.admin, newOne)
    const hub = new HubSync(new SqliteStore(db, restaurantId), {
      restaurantId,
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      instance: 'hub-1',
      clock,
      access,
    })
    return { db, access, hub, roles, restaurantId, admin, claveNueva: newOne }
  }

  return {
    spinUp,
    apagar() {
      for (const b of openHandles) b.close()
      openHandles = []
    },
    clock,
    advance: (n: number) => {
      ms += n
    },
  }
}
