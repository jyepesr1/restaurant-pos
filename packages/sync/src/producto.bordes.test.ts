import { newId, type OrderEvent } from '@pos/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { AlmacenMemoria } from './hub/almacen'
import { type ControlAcceso, HubSync, pedidosDe } from './hub/hub'
import { SalaSync } from './hub/sala'
import { huellaEvento } from './huella'
import { TAMANO_PAGINA } from './protocolo'
import { accesoLibre } from './pruebas/acceso'
import {
  type AlmacenQueSeCae,
  abrirPedido,
  eventosDe,
  item,
  type Montaje,
  montar,
  venLoMismo,
} from './pruebas/montaje'
import type { Nodo } from './pruebas/red'

// Agotado (86) mezclado con pedidos en la sincronización: lotes, cortes, caídas del hub, hub
// restaurado, rechazos en cadena y convergencia entre equipos sin conexión (tarea 1.3).

const markSoldOut = (
  node: Nodo,
  product: string,
  variant: string | null = null,
  type: 'ProductSoldOut' | 'ProductAvailable' = 'ProductSoldOut',
) =>
  node.crear(
    product,
    type,
    { product_id: product, variant_id: variant },
    { aggregate_type: 'product' },
  )

const release = (node: Nodo, product: string, variant: string | null = null) =>
  markSoldOut(node, product, variant, 'ProductAvailable')

/** El hub de la prueba con un control de acceso propio, sobre el mismo almacén. */
function conAcceso(m: Montaje, access: ControlAcceso) {
  const hub = new HubSync(m.almacen, {
    restauranteId: m.restauranteId,
    timeZone: 'America/Bogota',
    inicioDiaOperativo: '06:00',
    access,
    instancia: m.status.instancia,
    clock: m.network.horaIso,
  })
  m.status.hub = hub
  m.network.sala = new SalaSync(hub, m.network.authenticate)
}

/** Lo agotado que dicen estos eventos, en el orden dado (el último de cada clave manda). */
function agotadosDe(events: readonly Pick<OrderEvent, 'type' | 'data' | 'sequence'>[]) {
  const result = new Set<string>()
  for (const e of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (e.type !== 'ProductSoldOut' && e.type !== 'ProductAvailable') continue
    // `Pick` pierde la relación entre tipo y datos.
    const d = e.data as { product_id: string; variant_id: string | null }
    const key = `${d.product_id}:${d.variant_id ?? ''}`
    if (e.type === 'ProductSoldOut') result.add(key)
    else result.delete(key)
  }
  return result
}

const confirmadosDe = async (node: Nodo) =>
  (await node.cliente.locales())
    .filter((l) => l.status === 'confirmed')
    .map((l) => l.event as OrderEvent)

describe('pedidosDe con eventos de producto', () => {
  it('un agotado toca solo a su producto: no se confunde con ningún pedido', () => {
    const product = newId()
    const order = newId()
    const soldOut = { aggregate_id: product, related: [], affects: [] }
    expect(pedidosDe(soldOut)).toEqual([product])
    expect(pedidosDe(soldOut)).not.toContain(order)
    expect(pedidosDe({ aggregate_id: order, related: [] })).toEqual([order])
  })
})

describe('huella de un evento de producto', () => {
  it('ignora secuencia_base y firma, y distingue tipo, variante y agregado_tipo', () => {
    const product = newId()
    const e = {
      id: newId(),
      type: 'ProductSoldOut',
      schema_version: 1,
      aggregate_type: 'product',
      aggregate_id: product,
      related: [],
      data: { product_id: product, variant_id: null },
      session_id: null,
      user_id: newId(),
      device_id: newId(),
      authorization_id: null,
      reason: null,
      device_time: '2026-10-24T20:00:00.000Z',
      hub_estimated_time: '2026-10-24T20:00:00.000Z',
      base_sequence: 0,
    }
    const h = huellaEvento(e)
    expect(huellaEvento({ ...e, base_sequence: 99, signature: 'f'.repeat(64) })).toBe(h)
    expect(huellaEvento({ ...e, type: 'ProductAvailable' })).not.toBe(h)
    expect(huellaEvento({ ...e, aggregate_type: 'order' })).not.toBe(h)
    expect(huellaEvento({ ...e, data: { product_id: product, variant_id: newId() } })).not.toBe(h)
  })
})

describe('lotes que mezclan agotados y pedidos', () => {
  it('sin conexión: pedido, ítems y agotados se envían juntos, en orden, y todos se confirman', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await luis.connect()
    const order = newId()
    const x = newId()
    const bottle = newId()
    await abrirPedido(ana, order)
    await ana.crear(order, 'ItemAdded', item(10_000))
    await markSoldOut(ana, x)
    await ana.crear(order, 'ItemAdded', item(20_000))
    await markSoldOut(ana, x, bottle)
    await release(ana, x)
    await m.network.conectarTodos()

    expect(eventosDe(m).map((e) => [e.sequence, e.type])).toEqual([
      [1, 'OrderOpened'],
      [2, 'ItemAdded'],
      [3, 'ProductSoldOut'],
      [4, 'ItemAdded'],
      [5, 'ProductSoldOut'],
      [6, 'ProductAvailable'],
    ])
    expect(Object.keys(m.hub().order(order)?.items ?? {})).toHaveLength(2)
    expect(m.hub().order(order)?.status).toBe('open')
    expect(m.hub().order(x)).toBeNull()
    await venLoMismo(m.hub(), eventosDe(m), [ana, luis], [order, x])
    // El producto no se filtra al estado de ningún pedido en el dispositivo.
    expect(await luis.cliente.order(x)).toBeNull()
    expect(agotadosDe(await confirmadosDe(luis))).toEqual(new Set([`${x}:${bottle}`]))
  })

  it('mensajes de producto duplicados o perdidos en la red no repiten ni pierden el agotado', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await m.network.conectarTodos()
    const order = await abrirPedido(ana)
    const x = newId()
    ana.disconnect()
    await ana.crear(order, 'ItemAdded', item())
    await markSoldOut(ana, x)
    await release(ana, x)
    await markSoldOut(ana, x)

    ana.rule('to_hub', 'push', 'duplicate')
    ana.rule('to_device', 'result', 'drop')
    luis.rule('to_device', 'new', 'duplicate', 3)
    await m.network.conectarTodos()
    ana.disconnect()
    await m.network.conectarTodos()

    expect(eventosDe(m).map((e) => e.type)).toEqual([
      'OrderOpened',
      'ItemAdded',
      'ProductSoldOut',
      'ProductAvailable',
      'ProductSoldOut',
    ])
    await venLoMismo(m.hub(), eventosDe(m), [ana, luis], [order, x])
    expect(agotadosDe(await confirmadosDe(luis))).toEqual(new Set([`${x}:`]))
  })

  it('el hub se cae a mitad de un lote mixto: al volver no hay duplicados ni huecos', async () => {
    for (const caer of [1, 2, 3, 4, 5]) {
      const m = montar()
      const ana = m.network.device('ana')
      const luis = m.network.device('luis')
      await luis.connect()
      const order = newId()
      const x = newId()
      await abrirPedido(ana, order)
      await markSoldOut(ana, x)
      await ana.crear(order, 'ItemAdded', item())
      await release(ana, x)
      await markSoldOut(ana, newId())
      ;(m.almacen as AlmacenQueSeCae).caerEn = caer

      await m.network.conectarTodos()
      await m.network.conectarTodos()

      const events = eventosDe(m)
      expect(events, `caída en el guardado ${caer}`).toHaveLength(5)
      await venLoMismo(m.hub(), events, [ana, luis], [order, x])
    }
  })

  it('tras reiniciar el hub los pedidos se reconstruyen igual y los agotados siguen en la secuencia', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    await m.network.conectarTodos()
    const order = await abrirPedido(ana)
    const x = newId()
    await markSoldOut(ana, x)
    await ana.crear(order, 'ItemAdded', item(7_000))
    await m.network.settle()
    const before = structuredClone(m.hub().order(order))

    // El proceso se reinicia: mismo almacén, hub nuevo, misma instancia.
    ana.disconnect()
    m.network.sala = m.crearSala()
    expect(m.hub().order(order)).toEqual(before)
    expect(m.hub().order(x)).toBeNull()

    await release(ana, x)
    await m.network.conectarTodos()
    expect(eventosDe(m).map((e) => e.sequence)).toEqual([1, 2, 3, 4])
    await venLoMismo(m.hub(), eventosDe(m), [ana], [order, x])
    // Un tercer equipo que llega después recibe los de producto en su sitio.
    const fresh = m.network.device('nuevo')
    await fresh.connect()
    await m.network.settle()
    expect(agotadosDe(await confirmadosDe(fresh))).toEqual(new Set())
    expect((await confirmadosDe(fresh)).map((e) => e.type)).toContain('ProductSoldOut')
  })

  it('más agotados que una página: el equipo nuevo los trae todos y termina igual', async () => {
    const m = montar()
    const register = m.network.device('register')
    await register.connect()
    const x = newId()
    for (let i = 0; i < TAMANO_PAGINA + 20; i++) {
      await (i % 2 === 0 ? markSoldOut(register, x) : release(register, x))
    }
    await m.network.settle()
    const fresh = m.network.device('nuevo')
    await fresh.connect()
    await m.network.settle()

    expect(eventosDe(m)).toHaveLength(TAMANO_PAGINA + 20)
    await venLoMismo(m.hub(), eventosDe(m), [register, fresh], [x])
    // 520 eventos: el último (índice 519) es "disponible".
    expect(agotadosDe(await confirmadosDe(fresh))).toEqual(new Set())
  })

  it('con el reloj del equipo desfasado, el agotado se acepta y el hub le pone su hora', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    ana.desfaseMs = -3 * 3_600_000
    await ana.connect()
    await m.network.settle()
    const x = newId()
    const e = await markSoldOut(ana, x)
    await m.network.settle()

    const saved = eventosDe(m)[0] as OrderEvent
    expect(saved.id).toBe(e.id)
    expect(saved.received_at).toBe(m.network.horaIso())
    expect(Date.parse(saved.device_time)).toBeLessThan(Date.parse(saved.received_at))
  })
})

describe('un dispositivo restaurado con eventos de producto', () => {
  it('el hub vuelve de un respaldo viejo: se reenvían los agotados propios y todos quedan iguales', async () => {
    const m = montar({ almacen: 'memory' })
    const ana = m.network.device('ana')
    const register = m.network.device('register')
    await m.network.conectarTodos()
    const order = await abrirPedido(ana)
    const x = newId()
    const y = newId()
    await markSoldOut(register, x)
    await m.network.settle()
    const respaldo = structuredClone((m.almacen as AlmacenMemoria).events)

    // Después del respaldo: otro agotado, un ítem y la reposición del primero.
    await markSoldOut(register, y)
    await ana.crear(order, 'ItemAdded', item())
    await release(register, x)
    await m.network.settle()
    expect(eventosDe(m)).toHaveLength(5)

    for (const node of m.network.nodos) node.disconnect()
    const restaurado = new AlmacenMemoria()
    restaurado.events = respaldo
    m.status.instancia = 'hub-2'
    m.network.sala = m.crearSala(restaurado)
    await m.network.conectarTodos()

    const events = restaurado.eventosDesde(0, 1000)
    expect(events).toHaveLength(5)
    expect(restaurado.rechazos).toEqual([])
    await venLoMismo(m.hub(), events, [ana, register], [order, x, y])
    // Cada equipo termina con lo mismo que el hub: x repuesto, y agotado.
    const expected = agotadosDe(events)
    expect(expected).toEqual(new Set([`${y}:`]))
    for (const node of [ana, register])
      expect(agotadosDe(await confirmadosDe(node))).toEqual(expected)
    // Y con `reenviarTodo` no quedó ninguno pendiente ni con la base vieja.
    for (const node of [ana, register])
      for (const l of await node.cliente.locales())
        expect(l.event.base_sequence).toBeLessThanOrEqual(5)
  })

  it('un hub vacío (reinstalado): los agotados de los equipos se vuelven a registrar sin perderse', async () => {
    const m = montar({ almacen: 'memory' })
    const register = m.network.device('register')
    await m.network.conectarTodos()
    const x = newId()
    const bottle = newId()
    await markSoldOut(register, x, bottle)
    await markSoldOut(register, x)
    await m.network.settle()

    register.disconnect()
    m.status.instancia = 'hub-3'
    m.network.sala = m.crearSala(new AlmacenMemoria())
    await m.network.conectarTodos()

    expect(eventosDe(m).map((e) => e.type)).toEqual(['ProductSoldOut', 'ProductSoldOut'])
    await venLoMismo(m.hub(), eventosDe(m), [register], [x])
  })
})

describe('rechazos en cadena: producto y pedido no se arrastran', () => {
  const sinPermisoParaAgotar = (product: string): ControlAcceso => ({
    verify: (_c, event) =>
      event.type === 'ProductSoldOut' && event.aggregate_id === product
        ? { ok: false, reason: 'no_permission' }
        : { ok: true, authorizedById: null, autorizacionId: null },
    registrarUso: () => {},
  })

  it('un agotado rechazado arrastra a los pendientes de ese mismo producto, no a los de un pedido ni de otro producto', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const x = newId()
    const y = newId()
    const order = newId()
    conAcceso(m, sinPermisoParaAgotar(x))

    await abrirPedido(ana, order)
    const a1 = await ana.crear(order, 'ItemAdded', item())
    const rejected = await markSoldOut(ana, x)
    const a2 = await ana.crear(order, 'ItemAdded', item())
    const mismoProducto = await release(ana, x)
    const otroProducto = await markSoldOut(ana, y)
    await m.network.conectarTodos()

    const status = async (id: string) => (await ana.almacen.obtener(id))?.status
    expect(await status(rejected.id)).toBe('rejected')
    expect((await ana.almacen.obtener(rejected.id))?.reason).toBe('no_permission')
    expect(await status(mismoProducto.id)).toBe('rejected')
    expect((await ana.almacen.obtener(mismoProducto.id))?.reason).toBe('depends_on_rejected')
    expect(await status(a1.id)).toBe('confirmed')
    expect(await status(a2.id)).toBe('confirmed')
    expect(await status(otroProducto.id)).toBe('confirmed')
    expect(m.hub().order(order)?.status).toBe('open')
  })

  it('un ítem rechazado no arrastra a los agotados pendientes, aunque vayan en el mismo lote', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const order = newId()
    const x = newId()
    await abrirPedido(ana, order)
    const expensive = await ana.crear(order, 'ItemAdded', item(100_000_000, { quantity: 999 }))
    const after = await ana.crear(order, 'ItemAdded', item())
    const soldOut = await markSoldOut(ana, x)
    await m.network.conectarTodos()

    expect((await ana.almacen.obtener(expensive.id))?.status).toBe('rejected')
    expect((await ana.almacen.obtener(after.id))?.reason).toBe('depends_on_rejected')
    expect((await ana.almacen.obtener(soldOut.id))?.status).toBe('confirmed')
    expect(agotadosDe(await confirmadosDe(ana))).toEqual(new Set([`${x}:`]))
  })

  it('el rechazo de un agotado ya enviado no deshace lo que el hub confirmó de otro equipo', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await m.network.conectarTodos()
    const x = newId()
    await markSoldOut(luis, x)
    await m.network.settle()
    // Ana aún no estaba al día y marca lo mismo con el permiso retirado: se rechaza solo el suyo.
    conAcceso(m, sinPermisoParaAgotar(x))
    ana.disconnect()
    const suyo = await markSoldOut(ana, x)
    await m.network.conectarTodos()

    expect((await ana.almacen.obtener(suyo.id))?.status).toBe('rejected')
    expect(agotadosDe(await confirmadosDe(ana))).toEqual(new Set([`${x}:`]))
    expect(agotadosDe(eventosDe(m))).toEqual(new Set([`${x}:`]))
  })
})

describe('convergencia de agotados entre equipos sin conexión', () => {
  it('dos equipos marcan lo contrario sin conexión: gana el orden en que llegan al hub, y ambos lo ven', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await m.network.conectarTodos()
    const x = newId()
    await markSoldOut(luis, x)
    await m.network.settle()

    ana.disconnect()
    luis.disconnect()
    await release(luis, x)
    await markSoldOut(ana, x)
    // Ana se conecta primero: su "agotado" queda antes que el "disponible" de Luis.
    await ana.connect()
    await m.network.settle()
    await luis.connect()
    await m.network.settle()

    expect(eventosDe(m).map((e) => e.type)).toEqual([
      'ProductSoldOut',
      'ProductSoldOut',
      'ProductAvailable',
    ])
    await venLoMismo(m.hub(), eventosDe(m), [ana, luis], [x])
    for (const node of [ana, luis]) expect(agotadosDe(await confirmadosDe(node))).toEqual(new Set())
  })

  it('la variante y el producto entero son independientes', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    await m.network.conectarTodos()
    const x = newId()
    const bottle = newId()
    await markSoldOut(ana, x, bottle)
    await release(ana, x)
    await m.network.settle()
    expect(agotadosDe(eventosDe(m))).toEqual(new Set([`${x}:${bottle}`]))
    await release(ana, x, bottle)
    await m.network.settle()
    expect(agotadosDe(eventosDe(m))).toEqual(new Set())
  })

  it('propiedad: con cortes, caídas y duplicados, todos terminan con los mismos agotados que el hub', async () => {
    const products = Array.from({ length: 3 }, () => newId())
    const variants = [null, newId(), newId()]
    type Acc =
      | { t: 'markSoldOut' | 'release'; node: number; p: number; v: number }
      | { t: 'cut' | 'connect' | 'settle' | 'crashHub' | 'order'; node: number }
      | { t: 'duplicate' | 'drop'; node: number }
    const sel = fc.nat({ max: 5 })
    const arbAccion: fc.Arbitrary<Acc> = fc.oneof(
      {
        weight: 8,
        arbitrary: fc.record({
          t: fc.constantFrom('markSoldOut' as const, 'release' as const),
          node: sel,
          p: fc.nat({ max: 2 }),
          v: fc.nat({ max: 2 }),
        }),
      },
      { weight: 3, arbitrary: fc.record({ t: fc.constant('cut' as const), node: sel }) },
      { weight: 4, arbitrary: fc.record({ t: fc.constant('connect' as const), node: sel }) },
      { weight: 3, arbitrary: fc.record({ t: fc.constant('settle' as const), node: sel }) },
      { weight: 1, arbitrary: fc.record({ t: fc.constant('crashHub' as const), node: sel }) },
      { weight: 2, arbitrary: fc.record({ t: fc.constant('order' as const), node: sel }) },
      {
        weight: 2,
        arbitrary: fc.record({
          t: fc.constantFrom('duplicate' as const, 'drop' as const),
          node: sel,
        }),
      },
    )

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 3 }),
        fc.array(arbAccion, { minLength: 6, maxLength: 40 }),
        async (cuantos, actions) => {
          const m = montar()
          const nodos = Array.from({ length: cuantos }, (_, i) => m.network.device(`d${i}`))
          for (const a of actions) {
            const node = nodos[a.node % nodos.length] as Nodo
            switch (a.t) {
              case 'markSoldOut':
              case 'release':
                await (a.t === 'markSoldOut' ? markSoldOut : release)(
                  node,
                  products[a.p] as string,
                  variants[a.v] ?? null,
                )
                break
              case 'order':
                await abrirPedido(node, newId(), null)
                break
              case 'cut':
                node.disconnect()
                break
              case 'connect':
                if (!node.enLinea) await node.connect()
                break
              case 'settle':
                await m.network.settle()
                break
              case 'crashHub':
                m.network.crashHub()
                break
              case 'duplicate':
                node.rule('to_hub', 'push', 'duplicate')
                break
              case 'drop':
                node.rule('to_device', 'result', 'drop')
                break
            }
          }
          for (const n of nodos) {
            n.reglas = []
            n.disconnect()
          }
          await m.network.conectarTodos()

          const hub = eventosDe(m)
          expect(hub.map((e) => e.sequence)).toEqual(hub.map((_, i) => i + 1))
          const expected = agotadosDe(hub)
          for (const n of nodos) {
            expect(await n.cliente.pendingList()).toBe(0)
            expect(agotadosDe(await confirmadosDe(n))).toEqual(expected)
          }
        },
      ),
      { seed: 20_261_024, numRuns: 80 },
    )
  }, 120_000)
})

// Para que el montaje de acceso libre quede referenciado si cambia la forma de montar.
void accesoLibre
