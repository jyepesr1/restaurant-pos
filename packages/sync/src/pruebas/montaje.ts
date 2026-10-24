import { type EventoPedido, nuevoId } from '@pos/core'
import { aplicarMigraciones } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import { expect } from 'vitest'
import { AlmacenMemoria } from '../hub/almacen'
import { AlmacenSqlite } from '../hub/almacen-sqlite'
import { HubSync } from '../hub/hub'
import { SalaSync } from '../hub/sala'
import { type Nodo, RedSimulada } from './red'

// Montaje común de las pruebas de sincronización: un hub sobre SQLite real y una red simulada.

export const AHORA = '2026-10-24T15:00:00.000Z'

export function baseSqlite() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db)
  const restauranteId = nuevoId()
  db.prepare(
    `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
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

  override guardarEvento(...args: Parameters<AlmacenSqlite['guardarEvento']>) {
    if (this.caerEn > 0) {
      this.caerEn -= 1
      if (this.caerEn === 0) {
        this.caido = true
        throw new Error('el hub se apagó')
      }
    }
    super.guardarEvento(...args)
  }
}

/** Hub + red simulada. El hub siempre se levanta con el mismo almacén (la base sobrevive). */
export function montar(opciones: { almacen?: 'sqlite' | 'memoria' } = {}) {
  const { db, restauranteId } = baseSqlite()
  const almacen =
    opciones.almacen === 'memoria' ? new AlmacenMemoria() : new AlmacenQueSeCae(db, restauranteId)
  const estado: { hub: HubSync | null; instancia: string } = { hub: null, instancia: 'hub-1' }
  const red: RedSimulada = new RedSimulada(null as unknown as SalaSync)
  const crearSala = (almacenHub = almacen) => {
    estado.hub = new HubSync(almacenHub, {
      restauranteId,
      zonaHoraria: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      instancia: estado.instancia,
      reloj: red.horaIso,
    })
    return new SalaSync(estado.hub, red.autenticar)
  }
  red.sala = crearSala()
  red.alCaerHub = () => {
    if (almacen instanceof AlmacenQueSeCae) almacen.caido = false
    return crearSala()
  }
  return { red, db, almacen, hub: () => estado.hub as HubSync, crearSala, estado, restauranteId }
}

export type Montaje = ReturnType<typeof montar>

export const abrirPedido = (nodo: Nodo, pedido = nuevoId(), mesa: string | null = nuevoId()) =>
  nodo
    .crear(pedido, 'PedidoAbierto', { canal: 'salon', mesa_id: mesa, comensales: 2 })
    .then(() => pedido)

export const item = (precio = 40_900, campos = {}) => ({
  item_id: nuevoId(),
  producto_id: nuevoId(),
  variante_id: null,
  nombre: 'Garden Margarita',
  precio_unitario: precio,
  impuesto_tipo: 'inc' as const,
  tarifa: 800,
  cantidad: 1,
  comensal: null,
  curso: null,
  modificadores: [],
  notas: null,
  catalogo_version: 1,
  precio_canal_id: null,
  ...campos,
})

export const eventosDe = (m: Montaje) => m.almacen.eventosDesde(0, 1_000_000)

/** "Ven lo mismo": el hub tiene 1..N sin huecos y cada dispositivo, los mismos eventos y proyecciones. */
export async function venLoMismo(
  hub: HubSync,
  eventosHub: EventoPedido[],
  nodos: Nodo[],
  pedidos: string[],
) {
  expect(eventosHub.map((e) => e.secuencia)).toEqual(eventosHub.map((_, i) => i + 1))
  expect(new Set(eventosHub.map((e) => e.id)).size).toBe(eventosHub.length)
  for (const nodo of nodos) {
    expect(await nodo.cliente.pendientes()).toBe(0)
    const confirmados = (await nodo.cliente.locales())
      .filter((l) => l.estado === 'confirmado')
      .map((l) => l.evento.id)
    expect(new Set(confirmados)).toEqual(new Set(eventosHub.map((e) => e.id)))
    expect(confirmados).toHaveLength(eventosHub.length)
    expect((await nodo.almacen.cursor()).hasta).toBe(eventosHub.length)
    for (const pedido of pedidos)
      expect(await nodo.cliente.pedido(pedido)).toEqual(hub.pedido(pedido))
  }
}
