import { type NewEvent, newId, type OrderEventType } from '@pos/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type AlmacenQueSeCae, eventosDe, item, montar } from './pruebas/montaje'
import type { Nodo } from './pruebas/red'

// Criterio de aceptación de la Fase 0: pase lo que pase en la red (cortes, mensajes perdidos o
// duplicados, hub caído), al final todos los dispositivos y el hub ven exactamente lo mismo y
// ningún evento se pierde. Semilla fija: la prueba es determinista (`FC_SEMILLA` para explorar).

const SEMILLA = Number(process.env.FC_SEMILLA ?? 20_261_024)
const CORRIDAS = Number(process.env.FC_CORRIDAS ?? 150)

type Direccion = 'to_hub' | 'to_device'

type Action =
  | { t: 'open'; node: number; table: number }
  | { t: 'add'; node: number; order: number; price: number }
  | { t: 'send'; node: number; order: number }
  | { t: 'remove'; node: number; order: number; item: number }
  | { t: 'disconnect'; node: number }
  | { t: 'connect'; node: number }
  | { t: 'drop'; node: number; direction: Direccion; type: number }
  | { t: 'duplicate'; node: number; direction: Direccion; type: number }
  | { t: 'serve'; node: number; direction: Direccion; indice: number }
  | { t: 'settle' }
  | { t: 'crashHub' }
  | { t: 'crashOnSave'; en: number }

const TIPOS_MENSAJE: Record<Direccion, string[]> = {
  to_hub: ['push', 'pull', 'hello'],
  to_device: ['result', 'new', 'events', 'welcome'],
}

const sel = fc.nat({ max: 9 })
const direction = fc.constantFrom<Direccion>('to_hub', 'to_device')

const arbAccion: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({ t: fc.constant('open' as const), node: sel, table: fc.nat({ max: 3 }) }),
  },
  {
    weight: 8,
    arbitrary: fc.record({
      t: fc.constant('add' as const),
      node: sel,
      order: sel,
      price: fc.integer({ min: 1000, max: 90_000 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ t: fc.constant('send' as const), node: sel, order: sel }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ t: fc.constant('remove' as const), node: sel, order: sel, item: sel }),
  },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('disconnect' as const), node: sel }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant('connect' as const), node: sel }) },
  {
    weight: 3,
    arbitrary: fc.record({ t: fc.constant('drop' as const), node: sel, direction, type: sel }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ t: fc.constant('duplicate' as const), node: sel, direction, type: sel }),
  },
  {
    weight: 8,
    arbitrary: fc.record({
      t: fc.constant('serve' as const),
      node: sel,
      direction,
      indice: sel,
    }),
  },
  { weight: 4, arbitrary: fc.constant({ t: 'settle' as const }) },
  { weight: 1, arbitrary: fc.constant({ t: 'crashHub' as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('crashOnSave' as const),
      en: fc.integer({ min: 1, max: 4 }),
    }),
  },
)

const arbEscenario = fc.record({
  dispositivos: fc.integer({ min: 2, max: 4 }),
  actions: fc.array(arbAccion, { minLength: 8, maxLength: 80, size: 'max' }),
})

/** Ejecuta las acciones sobre un hub real (SQLite) y una red simulada. */
async function execute(dispositivos: number, actions: Action[], canalOrdenado = false) {
  const m = montar()
  const almacen = m.almacen as AlmacenQueSeCae
  const nodos = Array.from({ length: dispositivos }, (_, i) => m.network.device(`d${i}`))
  const tables = Array.from({ length: 4 }, () => newId())
  const station = newId()
  /** Todo evento que algún dispositivo creó, para comprobar que ninguno se pierde. */
  const creados: { id: string; node: Nodo }[] = []
  const orders: string[] = []

  const record = async <T extends OrderEventType>(
    node: Nodo,
    order: string,
    type: T,
    data: Extract<NewEvent, { type: T }>['data'],
  ) => {
    const event = await node.crear(order, type, data as never)
    creados.push({ id: event.id, node })
  }

  /** Pedidos que este dispositivo ve abiertos en su propia copia. */
  const abiertosDe = async (node: Nodo) => {
    const seenSet: string[] = []
    for (const id of orders) if ((await node.cliente.order(id))?.status === 'open') seenSet.push(id)
    return seenSet
  }

  for (const action of actions) {
    // Canal como un WebSocket sano: sin pérdidas, duplicados ni reordenamientos.
    if (canalOrdenado && (action.t === 'drop' || action.t === 'duplicate')) continue
    const node = nodos[('node' in action ? action.node : 0) % nodos.length] as Nodo
    switch (action.t) {
      case 'open': {
        const order = newId()
        orders.push(order)
        // La mesa 3 es "sin mesa" (barra); las demás se comparten entre dispositivos.
        const table = action.table === 3 ? null : (tables[action.table] as string)
        await record(node, order, 'OrderOpened', {
          channel: table ? 'dine_in' : 'bar',
          table_id: table,
          guests: 2,
        })
        break
      }
      case 'add': {
        const abiertos = await abiertosDe(node)
        const order = abiertos[action.order % abiertos.length]
        if (order) await record(node, order, 'ItemAdded', item(action.price))
        break
      }
      case 'send': {
        const abiertos = await abiertosDe(node)
        const order = abiertos[action.order % abiertos.length]
        const status = order ? await node.cliente.order(order) : null
        const ids = Object.values(status?.items ?? {})
          .filter((i) => i.status === 'pending')
          .slice(0, 3)
          .map((i) => i.id)
        if (order && ids.length > 0)
          await record(node, order, 'ItemsSent', {
            tickets: [{ ticket_id: newId(), station_id: station, item_ids: ids }],
          })
        break
      }
      case 'remove': {
        const abiertos = await abiertosDe(node)
        const order = abiertos[action.order % abiertos.length]
        const status = order ? await node.cliente.order(order) : null
        const quitables = Object.values(status?.items ?? {}).filter((i) => i.status === 'pending')
        const elegido = quitables[action.item % quitables.length]
        if (order && elegido) await record(node, order, 'ItemRemoved', { item_id: elegido.id })
        break
      }
      case 'disconnect':
        node.disconnect()
        break
      case 'connect':
        if (!node.enLinea) await node.connect()
        break
      case 'drop':
      case 'duplicate': {
        const types = TIPOS_MENSAJE[action.direction]
        node.rule(
          action.direction,
          types[action.type % types.length] as string,
          action.t === 'drop' ? 'drop' : 'duplicate',
        )
        break
      }
      case 'serve':
        await m.network.entregarUno(node, action.direction, canalOrdenado ? 0 : action.indice)
        break
      case 'settle':
        await m.network.settle()
        break
      case 'crashHub':
        m.network.crashHub()
        break
      case 'crashOnSave':
        almacen.caerEn = action.en
        break
    }
  }

  // Final: la red se estabiliza (sin pérdidas ni duplicados nuevos) y todos se conectan. Los que
  // seguían en línea reabren la conexión: con un mensaje perdido en un canal vivo, el latido
  // (15 s sin nada) la daría por muerta y el dispositivo reconectaría. Con el canal ordenado y
  // sin pérdidas no hace falta: las conexiones vivas deben ponerse al día solas.
  almacen.caerEn = 0
  for (const n of nodos) {
    n.reglas = []
    if (!canalOrdenado) n.disconnect()
  }
  await m.network.conectarTodos()
  return { m, nodos, creados, orders }
}

/** Todo lo que debe cumplirse al final de cualquier secuencia de acciones. */
async function verify({ m, nodos, creados, orders }: Awaited<ReturnType<typeof execute>>) {
  const hub = eventosDe(m)

  // El hub tiene 1..N sin huecos ni ids repetidos.
  expect(hub.map((e) => e.sequence)).toEqual(hub.map((_, i) => i + 1))
  expect(new Set(hub.map((e) => e.id)).size).toBe(hub.length)
  // Un solo conflicto por evento.
  const conflictos = m.hub().conflictos()
  expect(new Set(conflictos.map((c) => c.eventId)).size).toBe(conflictos.length)

  const hubPorId = new Map(hub.map((e) => [e.id, e]))
  for (const node of nodos) {
    // Ningún pendiente.
    expect(await node.cliente.pendingList()).toBe(0)
    const locales = await node.cliente.locales()
    expect(locales.filter((l) => l.status === 'pending')).toEqual([])

    // Los mismos eventos confirmados que el hub, idénticos campo por campo.
    const confirmados = locales.filter((l) => l.status === 'confirmed')
    expect(confirmados.map((l) => l.event.id).sort()).toEqual(hub.map((e) => e.id).sort())
    for (const l of confirmados) expect(l.event).toEqual(hubPorId.get(l.event.id))
    expect((await node.almacen.cursor()).until).toBe(hub.length)

    // Las mismas proyecciones.
    for (const order of orders)
      expect(await node.cliente.order(order), `pedido ${order} en ${node.name}`).toEqual(
        m.hub().order(order),
      )
  }

  // Ningún evento creado se perdió: confirmado, rechazado con motivo o en cuarentena.
  for (const { id, node } of creados) {
    const local = await node.almacen.obtener(id)
    expect(local, `evento ${id} desapareció de ${node.name}`).toBeDefined()
    if (local?.status === 'confirmed') expect(hubPorId.has(id)).toBe(true)
    else if (local?.status === 'rejected') {
      expect(local.reason, `rechazo sin motivo (${id})`).toBeTruthy()
      expect(hubPorId.has(id), `rechazado en ${node.name} pero confirmado en el hub`).toBe(false)
    } else expect(local?.status).toBe('quarantine')
  }
}

describe('convergencia (propiedades)', () => {
  it('con cortes, pérdidas, duplicados y caídas del hub, todos terminan viendo lo mismo', async () => {
    await fc.assert(
      fc.asyncProperty(arbEscenario, async ({ dispositivos, actions }) => {
        await verify(await execute(dispositivos, actions))
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  }, 120_000)

  it('con el canal ordenado y sin pérdidas, las conexiones vivas se ponen al día sin reconectar', async () => {
    await fc.assert(
      fc.asyncProperty(arbEscenario, async ({ dispositivos, actions }) => {
        await verify(await execute(dispositivos, actions, true))
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  }, 120_000)
})
