import { nuevoId } from '@pos/core'
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
const crudo = (nodo: Nodo, pedido: string, tipo: string, datos: unknown, base = 0) => ({
  id: nuevoId(),
  tipo,
  version_esquema: 1,
  agregado_tipo: 'pedido',
  agregado_id: pedido,
  relacionados: [],
  datos,
  sesion_id: null,
  usuario_id: nodo.usuarioId,
  dispositivo_id: nodo.dispositivoId,
  autorizacion_id: null,
  motivo: null,
  hora_dispositivo: AHORA,
  hora_estimada_hub: AHORA,
  secuencia_base: base,
})

const conexionDe = (m: Montaje, nodo: Nodo) => {
  const conexion = m.red.tokens.get(`token-${nodo.nombre}`)
  if (!conexion) throw new Error(`Sin token para ${nodo.nombre}`)
  return conexion
}

const abrir = (nodo: Nodo, pedido: string) =>
  crudo(nodo, pedido, 'PedidoAbierto', { canal: 'barra', mesa_id: null, comensales: 1 })

/** Mete `total` eventos directo en el hub (un pedido y sus ítems), sin dispositivos conectados. */
function sembrar(m: Montaje, nodo: Nodo, total: number) {
  const pedido = nuevoId()
  const eventos = [abrir(nodo, pedido)]
  for (let i = 1; i < total; i++)
    eventos.push(crudo(nodo, pedido, 'ItemAgregado', item(1000 + (i % 500))))
  for (let i = 0; i < eventos.length; i += 100) {
    const r = m.hub().recibirLote(conexionDe(m, nodo), eventos.slice(i, i + 100))
    expect(r.aceptados).toHaveLength(Math.min(100, eventos.length - i))
  }
  return pedido
}

/** Anota todo mensaje del hub que recibe un dispositivo. */
function espiar(nodo: Nodo) {
  const vistos: MensajeHub[] = []
  const original = nodo.cliente.recibir.bind(nodo.cliente)
  nodo.cliente.recibir = (mensaje) => {
    vistos.push(mensaje)
    return original(mensaje)
  }
  return vistos
}

/** Entrega al hub el mensaje de ese tipo que esté en vuelo, sin importar su lugar en la cola. */
async function entregarAlHub(m: Montaje, nodo: Nodo, tipo: string) {
  const indice = nodo.aHub.findIndex((x) => x.tipo === tipo)
  expect(indice, `no hay un ${tipo} en vuelo`).toBeGreaterThanOrEqual(0)
  await m.red.entregarUno(nodo, 'al_hub', indice)
}

const tipos = (mensajes: readonly { tipo: string }[]) => mensajes.map((x) => x.tipo)

describe('mensajes del hub fuera de orden', () => {
  it('una página vieja de `eventos` después de un `nuevo` no retrocede el cursor ni duplica', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const caja = m.red.dispositivo('caja')
    await m.red.conectarTodos()
    const pedido = await abrirPedido(ana)
    await m.red.estabilizar()

    const paginaVieja = m.hub().traer(0, 'caja') // hasta 1
    expect(paginaVieja).toMatchObject({ hasta: 1, hay_mas: false })
    await ana.crear(pedido, 'ItemAgregado', item())
    await ana.crear(pedido, 'ItemAgregado', item(12_900))
    await m.red.estabilizar()
    expect((await caja.almacen.cursor()).hasta).toBe(3)

    await caja.cliente.recibir(paginaVieja)

    expect((await caja.almacen.cursor()).hasta).toBe(3)
    expect(await caja.cliente.locales()).toHaveLength(3)
    await venLoMismo(m.hub(), eventosDe(m), [ana, caja], [pedido])
  })

  it('una página vieja con `hay_mas` hace traer de nuevo desde el cursor, sin dañar nada', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const caja = m.red.dispositivo('caja')
    await m.red.conectarTodos()
    const pedido = await abrirPedido(ana)
    await m.red.estabilizar()
    const paginaVieja = { ...m.hub().traer(0, 'caja'), hay_mas: true }
    await ana.crear(pedido, 'ItemAgregado', item())
    await m.red.estabilizar()

    const vistos = espiar(caja)
    await caja.cliente.recibir(paginaVieja)
    // El cursor ya va en 2: no vuelve a pedir lo que tiene.
    expect(caja.aHub).toEqual([{ tipo: 'traer', desde: 2 }])
    await m.red.estabilizar()

    expect(tipos(vistos)).toEqual(['eventos', 'eventos'])
    await venLoMismo(m.hub(), eventosDe(m), [ana, caja], [pedido])
  })

  it('un `nuevo` que llega antes que la página que ya lo incluye se absorbe sin dejar al dispositivo atrás', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const caja = m.red.dispositivo('caja')
    await ana.conectar()
    await m.red.estabilizar()
    const pedido = await abrirPedido(ana)
    await ana.crear(pedido, 'ItemAgregado', item())
    await m.red.estabilizar()

    // La caja se conecta y pide `traer 0`; mientras la respuesta viaja, ana agrega otro ítem.
    await caja.conectar()
    await m.red.entregarUno(caja, 'al_hub') // hola
    await m.red.entregarUno(caja, 'al_dispositivo') // bienvenido → traer
    await m.red.entregarUno(caja, 'al_hub') // traer → eventos (1 y 2)
    await ana.crear(pedido, 'ItemAgregado', item(12_900))
    await m.red.entregarUno(ana, 'al_hub') // el hub acepta el 3 y difunde `nuevo`
    expect(tipos(caja.aDispositivo)).toEqual(['eventos', 'nuevo'])

    // El canal los reordena: `nuevo` (hueco: la caja está en 0) llega antes que `eventos`.
    await m.red.entregarUno(caja, 'al_dispositivo', 1)
    await m.red.estabilizar()

    await venLoMismo(m.hub(), eventosDe(m), [ana, caja], [pedido])
  })

  it('un `resultado` repetido o de un lote que ya no está en vuelo se ignora', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    await m.red.conectarTodos()
    const vistos = espiar(ana)
    const pedido = await abrirPedido(ana)
    await m.red.estabilizar()
    const resultado = vistos.find((x) => x.tipo === 'resultado')
    expect(resultado).toBeDefined()

    const antes = await ana.cliente.locales()
    await ana.cliente.recibir(resultado as MensajeHub)
    await ana.cliente.recibir({
      ...(resultado as MensajeHub & { tipo: 'resultado' }),
      lote_id: 'otro',
    })

    expect(await ana.cliente.locales()).toEqual(antes)
    await venLoMismo(m.hub(), eventosDe(m), [ana], [pedido])
  })
})

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
      const ana = m.red.dispositivo('ana')
      const pedido = sembrar(m, ana, total)
      expect(eventosDe(m)).toHaveLength(total)

      const caja = m.red.dispositivo('caja')
      const vistos = espiar(caja)
      await m.red.conectarTodos()

      const paginasRecibidas = vistos.filter((x) => x.tipo === 'eventos')
      expect(paginasRecibidas).toHaveLength(paginas)
      expect(paginasRecibidas.map((p) => p.eventos.length)).toEqual(
        Array.from({ length: paginas }, (_, i) =>
          Math.min(TAMANO_PAGINA, Math.max(0, total - i * TAMANO_PAGINA)),
        ),
      )
      // Ni `traer` repetidos: uno por página.
      expect(paginasRecibidas.map((p) => p.hay_mas)).toEqual(
        Array.from({ length: paginas }, (_, i) => i < paginas - 1),
      )
      await venLoMismo(m.hub(), eventosDe(m), [caja], [pedido])
    },
  )

  it('un evento nuevo que llega entre dos páginas no se pierde ni retrasa el cursor', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const pedido = sembrar(m, ana, 2 * TAMANO_PAGINA + 203)
    // Ana solo saluda: queda conectada para enviar un evento, sin descargar lo sembrado.
    await ana.conectar()
    await m.red.entregarUno(ana, 'al_hub') // hola

    const caja = m.red.dispositivo('caja')
    await caja.conectar()
    await m.red.entregarUno(caja, 'al_hub') // hola
    await m.red.entregarUno(caja, 'al_dispositivo') // bienvenido → traer 0
    await m.red.entregarUno(caja, 'al_hub') // traer
    await m.red.entregarUno(caja, 'al_dispositivo') // página 1 → traer 500
    expect((await caja.almacen.cursor()).hasta).toBe(TAMANO_PAGINA)

    await ana.crear(pedido, 'ItemAgregado', item(7000))
    await entregarAlHub(m, ana, 'empujar') // el hub acepta el 1204 y lo difunde a la caja
    expect(tipos(caja.aDispositivo)).toEqual(['nuevo'])
    await m.red.entregarUno(caja, 'al_dispositivo') // `nuevo` con hueco: no avanza
    expect((await caja.almacen.cursor()).hasta).toBe(TAMANO_PAGINA)

    await m.red.estabilizar()
    expect(eventosDe(m)).toHaveLength(2 * TAMANO_PAGINA + 204)
    await venLoMismo(m.hub(), eventosDe(m), [caja], [pedido])
  })

  it('se corta la conexión entre dos páginas: al volver sigue desde su cursor, no desde cero', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const pedido = sembrar(m, ana, 2 * TAMANO_PAGINA + 1)
    const caja = m.red.dispositivo('caja')
    await caja.conectar()
    await m.red.entregarUno(caja, 'al_hub') // hola
    await m.red.entregarUno(caja, 'al_dispositivo') // bienvenido
    await m.red.entregarUno(caja, 'al_hub') // traer 0
    await m.red.entregarUno(caja, 'al_dispositivo') // página 1
    expect((await caja.almacen.cursor()).hasta).toBe(TAMANO_PAGINA)

    caja.desconectar()
    await caja.conectar()
    await m.red.entregarUno(caja, 'al_hub') // hola
    await m.red.entregarUno(caja, 'al_dispositivo') // bienvenido
    expect(caja.aHub).toEqual([{ tipo: 'traer', desde: TAMANO_PAGINA }])

    await m.red.estabilizar()
    await venLoMismo(m.hub(), eventosDe(m), [caja], [pedido])
  })
})

describe('corte con un lote y un `traer` en vuelo', () => {
  /** Qué alcanzó a llegar al hub antes del corte. */
  const casos = [
    { llego: 'nada', traer: false, empujar: false },
    { llego: 'solo el traer', traer: true, empujar: false },
    { llego: 'solo el lote', traer: false, empujar: true },
    { llego: 'el traer y el lote', traer: true, empujar: true },
  ] as const

  for (const caso of casos) {
    for (const tardios of [false, true]) {
      it(`llegó ${caso.llego}${tardios ? ' y los mensajes viejos llegan tarde' : ''}: nada se pierde ni se duplica`, async () => {
        const m = montar()
        const ana = m.red.dispositivo('ana')
        const luis = m.red.dispositivo('luis')
        await m.red.conectarTodos()
        const pedido = await abrirPedido(luis)
        await m.red.estabilizar()

        ana.desconectar()
        await ana.crear(pedido, 'ItemAgregado', item(10_000))
        await ana.crear(pedido, 'ItemAgregado', item(20_000))
        await ana.crear(pedido, 'ItemAgregado', item(30_000))

        // Se reconecta: sale `traer` y el lote de 3, y la conexión se corta con ambos en vuelo.
        await ana.conectar()
        await m.red.entregarUno(ana, 'al_hub') // hola
        await m.red.entregarUno(ana, 'al_dispositivo') // bienvenido
        expect(tipos(ana.aHub)).toEqual(['traer', 'empujar'])
        if (caso.traer) await entregarAlHub(m, ana, 'traer')
        if (caso.empujar) await entregarAlHub(m, ana, 'empujar')
        const viejos = [...ana.aDispositivo]
        const enElHub = eventosDe(m).length
        expect(enElHub).toBe(caso.empujar ? 4 : 1)

        ana.desconectar()
        await ana.conectar()
        if (tardios) for (const viejo of viejos) await ana.cliente.recibir(viejo)
        await m.red.entregarUno(ana, 'al_hub') // hola
        await m.red.entregarUno(ana, 'al_dispositivo') // bienvenido

        // El estado de la conexión vieja no se arrastra: sale un `traer` y, si queda algo
        // pendiente, un solo lote. (El eco `nuevo` tardío puede haber confirmado ya los eventos.)
        const pendientes = await ana.cliente.pendientes()
        expect(tipos(ana.aHub).sort()).toEqual(pendientes > 0 ? ['empujar', 'traer'] : ['traer'])

        await m.red.estabilizar()
        expect(eventosDe(m)).toHaveLength(4)
        await venLoMismo(m.hub(), eventosDe(m), [ana, luis], [pedido])
      })
    }
  }

  it('al cortar con el lote en vuelo, el siguiente lote sale completo y en orden', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const pedido = await abrirPedido(ana)
    const items = Array.from({ length: 230 }, (_, i) => item(1000 + i))
    for (const i of items) await ana.crear(pedido, 'ItemAgregado', i)

    await ana.conectar()
    await m.red.entregarUno(ana, 'al_hub') // hola
    await m.red.entregarUno(ana, 'al_dispositivo') // bienvenido → traer + lote de 100
    await entregarAlHub(m, ana, 'empujar') // el hub acepta los primeros 100
    expect(eventosDe(m)).toHaveLength(100)
    ana.desconectar() // el `resultado` se pierde con el corte

    await m.red.conectarTodos()
    const orden = eventosDe(m)
      .slice(1)
      .map((e) => (e.datos as { item_id: string }).item_id)
    expect(orden).toEqual(items.map((i) => i.item_id))
    await venLoMismo(m.hub(), eventosDe(m), [ana], [pedido])
  })
})

describe('evento rechazado que se reenvía tal cual', () => {
  const rechazos = (m: Montaje) =>
    Number(m.db.prepare('SELECT count(*) AS n FROM evento_rechazado').get()?.n)

  it('el hub responde lo mismo y no guarda un segundo rechazo', () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const conexion = conexionDe(m, ana)
    const pedido = nuevoId()
    m.hub().recibirLote(conexion, [abrir(ana, pedido)])
    const caro = crudo(ana, pedido, 'ItemAgregado', item(100_000_000, { cantidad: 999 }), 1)
    const despues = crudo(ana, pedido, 'ItemAgregado', item(5000), 1)

    const primera = m.hub().recibirLote(conexion, [caro, despues])
    const segunda = m.hub().recibirLote(conexion, [caro, despues])
    const solaLaDependiente = m.hub().recibirLote(conexion, [despues])

    expect(primera.resultados).toEqual([
      { id: caro.id, estado: 'rechazado', motivo: 'total_excede' },
      { id: despues.id, estado: 'rechazado', motivo: 'depende_de_rechazado' },
    ])
    expect(segunda.resultados).toEqual(primera.resultados)
    expect(solaLaDependiente.resultados).toEqual([primera.resultados[1]])
    expect(segunda.aceptados).toEqual([])
    expect(rechazos(m)).toBe(2)
    expect(eventosDe(m)).toHaveLength(1)
  })

  it('el rechazo es estable: aunque el hub cambie, el mismo evento recibe la misma respuesta', () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const conexion = conexionDe(m, ana)
    const pedido = nuevoId()
    const huerfano = crudo(ana, pedido, 'ItemAgregado', item())

    const antes = m.hub().recibirLote(conexion, [huerfano])
    m.hub().recibirLote(conexion, [abrir(ana, pedido)]) // ahora el pedido sí existe
    const despues = m.hub().recibirLote(conexion, [huerfano])

    expect(antes.resultados[0]).toMatchObject({ estado: 'rechazado', motivo: 'pedido_inexistente' })
    expect(despues.resultados).toEqual(antes.resultados)
    expect(despues.aceptados).toEqual([])
    expect(eventosDe(m)).toHaveLength(1)
  })

  it('el mismo id rechazado con otro contenido da `id_repetido`, y repetido igual da la misma respuesta', () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const conexion = conexionDe(m, ana)
    const pedido = nuevoId()
    const huerfano = crudo(ana, pedido, 'ItemAgregado', item())
    const otroContenido = { ...huerfano, datos: item(2000) }
    m.hub().recibirLote(conexion, [huerfano])

    const a = m.hub().recibirLote(conexion, [otroContenido])
    const b = m.hub().recibirLote(conexion, [otroContenido])

    // Rechazado antes con otro contenido: este es nuevo, y se rechaza por la regla del pedido.
    expect(a.resultados[0]).toMatchObject({ estado: 'rechazado' })
    expect(b.resultados).toEqual(a.resultados)
  })

  it('un evento ya confirmado que vuelve con otro contenido da `id_repetido` cada vez, sin tumbar el lote', () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const conexion = conexionDe(m, ana)
    const original = abrir(ana, nuevoId())
    const alterado = { ...original, datos: { canal: 'barra', mesa_id: null, comensales: 7 } }
    const otro = abrir(ana, nuevoId())
    m.hub().recibirLote(conexion, [original])

    const a = m.hub().recibirLote(conexion, [alterado, otro])
    const b = m.hub().recibirLote(conexion, [alterado, otro])

    expect(a.resultados[0]).toMatchObject({ estado: 'rechazado', motivo: 'id_repetido' })
    expect(b.resultados[0]).toEqual(a.resultados[0])
    expect(a.resultados[1]?.estado).toBe('confirmado')
    expect(b.resultados[1]).toEqual(a.resultados[1])
    expect(eventosDe(m)).toHaveLength(2)
  })

  it('por la red: se pierde el `resultado` con rechazos, el lote se reenvía y el dispositivo recibe lo mismo', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const luis = m.red.dispositivo('luis')
    await m.red.conectarTodos()
    const pedido = await abrirPedido(ana)
    const otro = await abrirPedido(luis)
    await m.red.estabilizar()

    ana.desconectar()
    const caro = item(100_000_000, { cantidad: 999 })
    const despues = item()
    await ana.crear(pedido, 'ItemAgregado', caro)
    await ana.crear(pedido, 'ItemAgregado', despues)
    await ana.crear(otro, 'ItemAgregado', item(5000))

    ana.regla('al_dispositivo', 'resultado', 'perder')
    await m.red.conectarTodos()
    // Sin `resultado`, los dos rechazados siguen pendientes; el tercero ya se confirmó por el eco.
    expect(await ana.cliente.pendientes()).toBe(2)
    const rechazosAntes = rechazos(m)
    expect(rechazosAntes).toBe(2)

    ana.desconectar()
    await m.red.conectarTodos()

    const motivos = (await ana.cliente.locales())
      .filter((l) => l.estado === 'rechazado')
      .map((l) => l.motivo)
    expect(motivos).toEqual(['total_excede', 'depende_de_rechazado'])
    expect(rechazos(m)).toBe(rechazosAntes)
    expect(eventosDe(m)).toHaveLength(3)
    await venLoMismo(m.hub(), eventosDe(m), [ana, luis], [pedido, otro])
  })

  it('el hub restaurado de un respaldo que ya tiene el evento no lo rechaza como `id_repetido` al reenviarlo', async () => {
    const m = montar({ almacen: 'memoria' })
    const ana = m.red.dispositivo('ana')
    await m.red.conectarTodos()
    const pedido = await abrirPedido(ana)
    await m.red.estabilizar()
    // Con el pedido ya confirmado (cursor 1), ana agrega un ítem: lleva `secuencia_base` 1.
    await ana.crear(pedido, 'ItemAgregado', item())
    await m.red.estabilizar()
    const respaldo = structuredClone((m.almacen as AlmacenMemoria).eventos)
    // Después del respaldo, un ítem más: el único que el respaldo no tiene.
    const ultimo = await ana.crear(pedido, 'ItemAgregado', item(8900))
    await m.red.estabilizar()
    expect(eventosDe(m)).toHaveLength(3)

    for (const nodo of m.red.nodos) nodo.desconectar()
    const restaurado = new AlmacenMemoria()
    restaurado.eventos = respaldo
    m.estado.instancia = 'hub-2'
    m.red.sala = m.crearSala(restaurado)
    await m.red.conectarTodos()

    const local = await ana.almacen.obtener(ultimo.id)
    expect(local?.estado, `el último ítem terminó ${local?.estado} (${local?.motivo})`).toBe(
      'confirmado',
    )
    expect(restaurado.rechazos).toEqual([])
    await venLoMismo(m.hub(), restaurado.eventosDesde(0, 1000), [ana], [pedido])
  })
})
