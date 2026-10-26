import { newId, type OrderEvent } from '@pos/core'
import { aplicarMigraciones } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import { expect } from 'vitest'
import { AlmacenMemoria } from '../hub/almacen'
import { AlmacenSqlite } from '../hub/almacen-sqlite'
import { HubSync } from '../hub/hub'
import { SalaSync } from '../hub/sala'
import { accesoLibre } from './acceso'
import { type Nodo, RedSimulada } from './red'

// Montaje común de las pruebas de sincronización: un hub sobre SQLite real y una red simulada.

export const AHORA = '2026-10-24T15:00:00.000Z'

export function baseSqlite() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db)
  const restauranteId = newId()
  db.prepare(
    `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
     VALUES (?, ?, ?, ?, 1, 'La Spritzzería', '{}')`,
  ).run(restauranteId, restauranteId, AHORA, AHORA)
  return { db, restauranteId }
}

/**
 * Almacén SQLite que puede lanzar al guardar un evento: simula que el proceso del hub se cae. Una
 * vez caído, nada más se guarda hasta que el hub se levanta otra vez (`caido = false`).
 */
export class AlmacenQueSeCae extends AlmacenSqlite {
  /** Cuántos guardados faltan para la caída (1 = el próximo); 0 = ninguna programada. */
  caerEn = 0
  caido = false

  override transaccion<T>(trabajo: () => T): T {
    if (this.caido) throw new Error('el hub está apagado')
    return super.transaccion(trabajo)
  }

  override saveEvent(...args: Parameters<AlmacenSqlite['saveEvent']>) {
    if (this.caerEn > 0) {
      this.caerEn -= 1
      if (this.caerEn === 0) {
        this.caido = true
        throw new Error('el hub se apagó')
      }
    }
    super.saveEvent(...args)
  }
}

/** Hub + red simulada. El hub siempre se levanta con el mismo almacén (la base sobrevive). */
export function montar(options: { almacen?: 'sqlite' | 'memory' } = {}) {
  const { db, restauranteId } = baseSqlite()
  const almacen =
    options.almacen === 'memory' ? new AlmacenMemoria() : new AlmacenQueSeCae(db, restauranteId)
  const status: { hub: HubSync | null; instancia: string } = { hub: null, instancia: 'hub-1' }
  const network: RedSimulada = new RedSimulada(null as unknown as SalaSync)
  const crearSala = (almacenHub = almacen) => {
    status.hub = new HubSync(almacenHub, {
      restauranteId,
      timeZone: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      access: accesoLibre,
      instancia: status.instancia,
      clock: network.horaIso,
    })
    return new SalaSync(status.hub, network.authenticate)
  }
  network.sala = crearSala()
  network.alCaerHub = () => {
    if (almacen instanceof AlmacenQueSeCae) almacen.caido = false
    return crearSala()
  }
  return {
    network,
    db,
    almacen,
    hub: () => status.hub as HubSync,
    crearSala,
    status,
    restauranteId,
  }
}

export type Montaje = ReturnType<typeof montar>

export const abrirPedido = (node: Nodo, order = newId(), table: string | null = newId()) =>
  node
    .crear(order, 'OrderOpened', { channel: 'dine_in', table_id: table, guests: 2 })
    .then(() => order)

export const item = (price = 40_900, fields = {}) => ({
  item_id: newId(),
  product_id: newId(),
  variant_id: null,
  name: 'Garden Margarita',
  unit_price: price,
  tax_type: 'inc' as const,
  rate: 800,
  quantity: 1,
  guest: null,
  course: null,
  modifiers: [],
  notes: null,
  catalog_version: 1,
  price_channel_id: null,
  ...fields,
})

export const eventosDe = (m: Montaje) => m.almacen.eventosDesde(0, 1_000_000)

/** "Ven lo mismo": el hub tiene 1..N sin huecos y cada dispositivo, los mismos eventos y proyecciones. */
export async function venLoMismo(
  hub: HubSync,
  eventosHub: OrderEvent[],
  nodos: Nodo[],
  orders: string[],
) {
  expect(eventosHub.map((e) => e.sequence)).toEqual(eventosHub.map((_, i) => i + 1))
  expect(new Set(eventosHub.map((e) => e.id)).size).toBe(eventosHub.length)
  for (const node of nodos) {
    expect(await node.cliente.pendingList()).toBe(0)
    const confirmados = (await node.cliente.locales())
      .filter((l) => l.status === 'confirmed')
      .map((l) => l.event.id)
    expect(new Set(confirmados)).toEqual(new Set(eventosHub.map((e) => e.id)))
    expect(confirmados).toHaveLength(eventosHub.length)
    expect((await node.almacen.cursor()).until).toBe(eventosHub.length)
    for (const order of orders) expect(await node.cliente.order(order)).toEqual(hub.order(order))
  }
}
