import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { AlmacenMemoria } from './hub/almacen'
import type { MensajeHub } from './protocolo'
import { TAMANO_PAGINA } from './protocolo'
import {
  AHORA,
  abrirPedido,
  eventosDe,
  item,
  type Montaje,
  montar,
  venLoMismo,
} from './pruebas/montaje'
import type { Nodo } from './pruebas/red'

// Casos borde del protocolo de sincronización (docs/SYNC.md): mensajes del hub fuera de orden,
// `traer` de varias páginas, cortes con un lote y un `traer` en vuelo, y rechazos reenviados.

/** Evento en bruto, como lo envía un dispositivo, para hablarle al hub sin pasar por el cliente. */
const crudo = (node: Nodo, order: string, type: string, data: unknown, base = 0) => ({
  id: newId(),
  type,
  schema_version: 1,
  aggregate_type: 'order',
  aggregate_id: order,
  related: [],
  data,
  session_id: null,
  user_id: node.userId,
  device_id: node.dispositivoId,
  authorization_id: null,
  reason: null,
  device_time: AHORA,
  hub_estimated_time: AHORA,
  base_sequence: base,
})

const conexionDe = (m: Montaje, node: Nodo) => {
  const connection = m.network.tokens.get(`token-${node.name}`)
  if (!connection) throw new Error(`Sin token para ${node.name}`)
  return connection
}

const open = (node: Nodo, order: string) =>
  crudo(node, order, 'OrderOpened', { channel: 'bar', table_id: null, guests: 1 })

/** Mete `total` eventos directo en el hub (un pedido y sus ítems), sin dispositivos conectados. */
function sembrar(m: Montaje, node: Nodo, total: number) {
  const order = newId()
  const events = [open(node, order)]
  for (let i = 1; i < total; i++)
    events.push(crudo(node, order, 'ItemAdded', item(1000 + (i % 500))))
  for (let i = 0; i < events.length; i += 100) {
    const r = m.hub().recibirLote(conexionDe(m, node), events.slice(i, i + 100))
    expect(r.aceptados).toHaveLength(Math.min(100, events.length - i))
  }
  return order
}

/** Anota todo mensaje del hub que recibe un dispositivo. */
function espiar(node: Nodo) {
  const seenSet: MensajeHub[] = []
  const original = node.cliente.recibir.bind(node.cliente)
  node.cliente.recibir = (message) => {
    seenSet.push(message)
    return original(message)
  }
  return seenSet
}

/** Entrega al hub el mensaje de ese tipo que esté en vuelo, sin importar su lugar en la cola. */
async function entregarAlHub(m: Montaje, node: Nodo, type: string) {
  const indice = node.aHub.findIndex((x) => x.type === type)
  expect(indice, `no hay un ${type} en vuelo`).toBeGreaterThanOrEqual(0)
  await m.network.entregarUno(node, 'to_hub', indice)
}

const types = (mensajes: readonly { type: string }[]) => mensajes.map((x) => x.type)

describe('mensajes del hub fuera de orden', () => {
  it('una página vieja de `eventos` después de un `nuevo` no retrocede el cursor ni duplica', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const register = m.network.device('register')
    await m.network.conectarTodos()
    const order = await abrirPedido(ana)
    await m.network.settle()

    const paginaVieja = m.hub().pull(0, 'register') // hasta 1
    expect(paginaVieja).toMatchObject({ until: 1, hay_mas: false })
    await ana.crear(order, 'ItemAdded', item())
    await ana.crear(order, 'ItemAdded', item(12_900))
    await m.network.settle()
    expect((await register.almacen.cursor()).until).toBe(3)

    await register.cliente.recibir(paginaVieja)

    expect((await register.almacen.cursor()).until).toBe(3)
    expect(await register.cliente.locales()).toHaveLength(3)
    await venLoMismo(m.hub(), eventosDe(m), [ana, register], [order])
  })

  it('una página vieja con `hay_mas` hace traer de nuevo desde el cursor, sin dañar nada', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const register = m.network.device('register')
    await m.network.conectarTodos()
    const order = await abrirPedido(ana)
    await m.network.settle()
    const paginaVieja = { ...m.hub().pull(0, 'register'), hay_mas: true }
    await ana.crear(order, 'ItemAdded', item())
    await m.network.settle()

    const seenSet = espiar(register)
    await register.cliente.recibir(paginaVieja)
    // El cursor ya va en 2: no vuelve a pedir lo que tiene.
    expect(register.aHub).toEqual([{ type: 'pull', from: 2 }])
    await m.network.settle()

    expect(types(seenSet)).toEqual(['events', 'events'])
    await venLoMismo(m.hub(), eventosDe(m), [ana, register], [order])
  })

  it('un `nuevo` que llega antes que la página que ya lo incluye se absorbe sin dejar al dispositivo atrás', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const register = m.network.device('register')
    await ana.connect()
    await m.network.settle()
    const order = await abrirPedido(ana)
    await ana.crear(order, 'ItemAdded', item())
    await m.network.settle()

    // La caja se conecta y pide `traer 0`; mientras la respuesta viaja, ana agrega otro ítem.
    await register.connect()
    await m.network.entregarUno(register, 'to_hub') // hola
    await m.network.entregarUno(register, 'to_device') // bienvenido → traer
    await m.network.entregarUno(register, 'to_hub') // traer → eventos (1 y 2)
    await ana.crear(order, 'ItemAdded', item(12_900))
    await m.network.entregarUno(ana, 'to_hub') // el hub acepta el 3 y difunde `nuevo`
    expect(types(register.aDispositivo)).toEqual(['events', 'new'])

    // El canal los reordena: `nuevo` (hueco: la caja está en 0) llega antes que `eventos`.
    await m.network.entregarUno(register, 'to_device', 1)
    await m.network.settle()

    await venLoMismo(m.hub(), eventosDe(m), [ana, register], [order])
  })

  it('un `resultado` repetido o de un lote que ya no está en vuelo se ignora', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    await m.network.conectarTodos()
    const seenSet = espiar(ana)
    const order = await abrirPedido(ana)
    await m.network.settle()
    const result = seenSet.find((x) => x.type === 'result')
    expect(result).toBeDefined()

    const before = await ana.cliente.locales()
    await ana.cliente.recibir(result as MensajeHub)
    await ana.cliente.recibir({
      ...(result as MensajeHub & { type: 'result' }),
      lote_id: 'other',
    })

    expect(await ana.cliente.locales()).toEqual(before)
    await venLoMismo(m.hub(), eventosDe(m), [ana], [order])
  })
})

// Cientos de ítems en un solo pedido: cada evento copia el pedido entero, así que tardan unos
// segundos. Un pedido real tiene decenas de ítems.
describe('traer con varias páginas', () => {
  it.each([
    // [eventos en el hub, páginas de `eventos` esperadas]
    [TAMANO_PAGINA - 1, 1],
    [TAMANO_PAGINA, 2], // justo una página llena: `hay_mas` obliga a pedir otra, que viene vacía
    [TAMANO_PAGINA + 1, 2],
    [2 * TAMANO_PAGINA + 203, 3],
  ])(
    'un dispositivo nuevo con %i eventos en el hub se pone al día en %i página(s)',
    async (total, paginas) => {
      const m = montar()
      const ana = m.network.device('ana')
      const order = sembrar(m, ana, total)
      expect(eventosDe(m)).toHaveLength(total)

      const register = m.network.device('register')
      const seenSet = espiar(register)
      await m.network.conectarTodos()

      const paginasRecibidas = seenSet.filter((x) => x.type === 'events')
      expect(paginasRecibidas).toHaveLength(paginas)
      expect(paginasRecibidas.map((p) => p.events.length)).toEqual(
        Array.from({ length: paginas }, (_, i) =>
          Math.min(TAMANO_PAGINA, Math.max(0, total - i * TAMANO_PAGINA)),
        ),
      )
      // Ni `traer` repetidos: uno por página.
      expect(paginasRecibidas.map((p) => p.hay_mas)).toEqual(
        Array.from({ length: paginas }, (_, i) => i < paginas - 1),
      )
      await venLoMismo(m.hub(), eventosDe(m), [register], [order])
    },
  )

  it('un evento nuevo que llega entre dos páginas no se pierde ni retrasa el cursor', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const order = sembrar(m, ana, 2 * TAMANO_PAGINA + 203)
    // Ana solo saluda: queda conectada para enviar un evento, sin descargar lo sembrado.
    await ana.connect()
    await m.network.entregarUno(ana, 'to_hub') // hola

    const register = m.network.device('register')
    await register.connect()
    await m.network.entregarUno(register, 'to_hub') // hola
    await m.network.entregarUno(register, 'to_device') // bienvenido → traer 0
    await m.network.entregarUno(register, 'to_hub') // traer
    await m.network.entregarUno(register, 'to_device') // página 1 → traer 500
    expect((await register.almacen.cursor()).until).toBe(TAMANO_PAGINA)

    await ana.crear(order, 'ItemAdded', item(7000))
    await entregarAlHub(m, ana, 'push') // el hub acepta el 1204 y lo difunde a la caja
    expect(types(register.aDispositivo)).toEqual(['new'])
    await m.network.entregarUno(register, 'to_device') // `nuevo` con hueco: no avanza
    expect((await register.almacen.cursor()).until).toBe(TAMANO_PAGINA)

    await m.network.settle()
    expect(eventosDe(m)).toHaveLength(2 * TAMANO_PAGINA + 204)
    await venLoMismo(m.hub(), eventosDe(m), [register], [order])
  })

  it('se corta la conexión entre dos páginas: al volver sigue desde su cursor, no desde cero', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const order = sembrar(m, ana, 2 * TAMANO_PAGINA + 1)
    const register = m.network.device('register')
    await register.connect()
    await m.network.entregarUno(register, 'to_hub') // hola
    await m.network.entregarUno(register, 'to_device') // bienvenido
    await m.network.entregarUno(register, 'to_hub') // traer 0
    await m.network.entregarUno(register, 'to_device') // página 1
    expect((await register.almacen.cursor()).until).toBe(TAMANO_PAGINA)

    register.disconnect()
    await register.connect()
    await m.network.entregarUno(register, 'to_hub') // hola
    await m.network.entregarUno(register, 'to_device') // bienvenido
    expect(register.aHub).toEqual([{ type: 'pull', from: TAMANO_PAGINA }])

    await m.network.settle()
    await venLoMismo(m.hub(), eventosDe(m), [register], [order])
  })
})

describe('corte con un lote y un `traer` en vuelo', () => {
  /** Qué alcanzó a llegar al hub antes del corte. */
  const casos = [
    { llego: 'nada', pull: false, push: false },
    { llego: 'solo el traer', pull: true, push: false },
    { llego: 'solo el lote', pull: false, push: true },
    { llego: 'el traer y el lote', pull: true, push: true },
  ] as const

  for (const caseName of casos) {
    for (const tardios of [false, true]) {
      it(`llegó ${caseName.llego}${tardios ? ' y los mensajes viejos llegan tarde' : ''}: nada se pierde ni se duplica`, async () => {
        const m = montar()
        const ana = m.network.device('ana')
        const luis = m.network.device('luis')
        await m.network.conectarTodos()
        const order = await abrirPedido(luis)
        await m.network.settle()

        ana.disconnect()
        await ana.crear(order, 'ItemAdded', item(10_000))
        await ana.crear(order, 'ItemAdded', item(20_000))
        await ana.crear(order, 'ItemAdded', item(30_000))

        // Se reconecta: sale `traer` y el lote de 3, y la conexión se corta con ambos en vuelo.
        await ana.connect()
        await m.network.entregarUno(ana, 'to_hub') // hola
        await m.network.entregarUno(ana, 'to_device') // bienvenido
        expect(types(ana.aHub)).toEqual(['pull', 'push'])
        if (caseName.pull) await entregarAlHub(m, ana, 'pull')
        if (caseName.push) await entregarAlHub(m, ana, 'push')
        const viejos = [...ana.aDispositivo]
        const enElHub = eventosDe(m).length
        expect(enElHub).toBe(caseName.push ? 4 : 1)

        ana.disconnect()
        await ana.connect()
        if (tardios) for (const oldOne of viejos) await ana.cliente.recibir(oldOne)
        await m.network.entregarUno(ana, 'to_hub') // hola
        await m.network.entregarUno(ana, 'to_device') // bienvenido

        // El estado de la conexión vieja no se arrastra: sale un `traer` y, si queda algo
        // pendiente, un solo lote. (El eco `nuevo` tardío puede haber confirmado ya los eventos.)
        const pendingList = await ana.cliente.pendingList()
        expect(types(ana.aHub).sort()).toEqual(pendingList > 0 ? ['pull', 'push'] : ['pull'])

        await m.network.settle()
        expect(eventosDe(m)).toHaveLength(4)
        await venLoMismo(m.hub(), eventosDe(m), [ana, luis], [order])
      })
    }
  }

  it('al cortar con el lote en vuelo, el siguiente lote sale completo y en orden', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const order = await abrirPedido(ana)
    const items = Array.from({ length: 230 }, (_, i) => item(1000 + i))
    for (const i of items) await ana.crear(order, 'ItemAdded', i)

    await ana.connect()
    await m.network.entregarUno(ana, 'to_hub') // hola
    await m.network.entregarUno(ana, 'to_device') // bienvenido → traer + lote de 100
    await entregarAlHub(m, ana, 'push') // el hub acepta los primeros 100
    expect(eventosDe(m)).toHaveLength(100)
    ana.disconnect() // el `resultado` se pierde con el corte

    await m.network.conectarTodos()
    const position = eventosDe(m)
      .slice(1)
      .map((e) => (e.data as { item_id: string }).item_id)
    expect(position).toEqual(items.map((i) => i.item_id))
    await venLoMismo(m.hub(), eventosDe(m), [ana], [order])
  })
})

describe('evento rechazado que se reenvía tal cual', () => {
  const rechazos = (m: Montaje) =>
    Number(m.db.prepare('SELECT count(*) AS n FROM rejected_events').get()?.n)

  it('el hub responde lo mismo y no guarda un segundo rechazo', () => {
    const m = montar()
    const ana = m.network.device('ana')
    const connection = conexionDe(m, ana)
    const order = newId()
    m.hub().recibirLote(connection, [open(ana, order)])
    const expensive = crudo(ana, order, 'ItemAdded', item(100_000_000, { quantity: 999 }), 1)
    const after = crudo(ana, order, 'ItemAdded', item(5000), 1)

    const first = m.hub().recibirLote(connection, [expensive, after])
    const segunda = m.hub().recibirLote(connection, [expensive, after])
    const solaLaDependiente = m.hub().recibirLote(connection, [after])

    expect(first.resultados).toEqual([
      { id: expensive.id, status: 'rejected', reason: 'total_exceeds' },
      { id: after.id, status: 'rejected', reason: 'depends_on_rejected' },
    ])
    expect(segunda.resultados).toEqual(first.resultados)
    expect(solaLaDependiente.resultados).toEqual([first.resultados[1]])
    expect(segunda.aceptados).toEqual([])
    expect(rechazos(m)).toBe(2)
    expect(eventosDe(m)).toHaveLength(1)
  })

  it('el rechazo es estable: aunque el hub cambie, el mismo evento recibe la misma respuesta', () => {
    const m = montar()
    const ana = m.network.device('ana')
    const connection = conexionDe(m, ana)
    const order = newId()
    const huerfano = crudo(ana, order, 'ItemAdded', item())

    const before = m.hub().recibirLote(connection, [huerfano])
    m.hub().recibirLote(connection, [open(ana, order)]) // ahora el pedido sí existe
    const after = m.hub().recibirLote(connection, [huerfano])

    expect(before.resultados[0]).toMatchObject({ status: 'rejected', reason: 'order_not_found' })
    expect(after.resultados).toEqual(before.resultados)
    expect(after.aceptados).toEqual([])
    expect(eventosDe(m)).toHaveLength(1)
  })

  it('el mismo id rechazado con otro contenido da `id_repetido`, y repetido igual da la misma respuesta', () => {
    const m = montar()
    const ana = m.network.device('ana')
    const connection = conexionDe(m, ana)
    const order = newId()
    const huerfano = crudo(ana, order, 'ItemAdded', item())
    const otroContenido = { ...huerfano, data: item(2000) }
    m.hub().recibirLote(connection, [huerfano])

    const a = m.hub().recibirLote(connection, [otroContenido])
    const b = m.hub().recibirLote(connection, [otroContenido])

    // Rechazado antes con otro contenido: este es nuevo, y se rechaza por la regla del pedido.
    expect(a.resultados[0]).toMatchObject({ status: 'rejected' })
    expect(b.resultados).toEqual(a.resultados)
  })

  it('un evento ya confirmado que vuelve con otro contenido da `id_repetido` cada vez, sin tumbar el lote', () => {
    const m = montar()
    const ana = m.network.device('ana')
    const connection = conexionDe(m, ana)
    const original = open(ana, newId())
    const alterado = { ...original, data: { channel: 'bar', table_id: null, guests: 7 } }
    const other = open(ana, newId())
    m.hub().recibirLote(connection, [original])

    const a = m.hub().recibirLote(connection, [alterado, other])
    const b = m.hub().recibirLote(connection, [alterado, other])

    expect(a.resultados[0]).toMatchObject({ status: 'rejected', reason: 'duplicate_id' })
    expect(b.resultados[0]).toEqual(a.resultados[0])
    expect(a.resultados[1]?.status).toBe('confirmed')
    expect(b.resultados[1]).toEqual(a.resultados[1])
    expect(eventosDe(m)).toHaveLength(2)
  })

  it('por la red: se pierde el `resultado` con rechazos, el lote se reenvía y el dispositivo recibe lo mismo', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await m.network.conectarTodos()
    const order = await abrirPedido(ana)
    const other = await abrirPedido(luis)
    await m.network.settle()

    ana.disconnect()
    const expensive = item(100_000_000, { quantity: 999 })
    const after = item()
    await ana.crear(order, 'ItemAdded', expensive)
    await ana.crear(order, 'ItemAdded', after)
    await ana.crear(other, 'ItemAdded', item(5000))

    ana.rule('to_device', 'result', 'drop')
    await m.network.conectarTodos()
    // Sin `resultado`, los dos rechazados siguen pendientes; el tercero ya se confirmó por el eco.
    expect(await ana.cliente.pendingList()).toBe(2)
    const rechazosAntes = rechazos(m)
    expect(rechazosAntes).toBe(2)

    ana.disconnect()
    await m.network.conectarTodos()

    const motivos = (await ana.cliente.locales())
      .filter((l) => l.status === 'rejected')
      .map((l) => l.reason)
    expect(motivos).toEqual(['total_exceeds', 'depends_on_rejected'])
    expect(rechazos(m)).toBe(rechazosAntes)
    expect(eventosDe(m)).toHaveLength(3)
    await venLoMismo(m.hub(), eventosDe(m), [ana, luis], [order, other])
  })

  it('el hub restaurado de un respaldo que ya tiene el evento no lo rechaza como `id_repetido` al reenviarlo', async () => {
    const m = montar({ almacen: 'memory' })
    const ana = m.network.device('ana')
    await m.network.conectarTodos()
    const order = await abrirPedido(ana)
    await m.network.settle()
    // Con el pedido ya confirmado (cursor 1), ana agrega un ítem: lleva `base_sequence` 1.
    await ana.crear(order, 'ItemAdded', item())
    await m.network.settle()
    const respaldo = structuredClone((m.almacen as AlmacenMemoria).events)
    // Después del respaldo, un ítem más: el único que el respaldo no tiene.
    const latest = await ana.crear(order, 'ItemAdded', item(8900))
    await m.network.settle()
    expect(eventosDe(m)).toHaveLength(3)

    for (const node of m.network.nodos) node.disconnect()
    const restaurado = new AlmacenMemoria()
    restaurado.events = respaldo
    m.status.instancia = 'hub-2'
    m.network.sala = m.crearSala(restaurado)
    await m.network.conectarTodos()

    const local = await ana.almacen.obtener(latest.id)
    expect(local?.status, `el último ítem terminó ${local?.status} (${local?.reason})`).toBe(
      'confirmed',
    )
    expect(restaurado.rechazos).toEqual([])
    await venLoMismo(m.hub(), restaurado.eventosDesde(0, 1000), [ana], [order])
  })
})
