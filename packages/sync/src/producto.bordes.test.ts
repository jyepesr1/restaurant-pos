import { type EventoPedido, nuevoId } from '@pos/core'
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

const agotar = (
  nodo: Nodo,
  producto: string,
  variante: string | null = null,
  tipo: 'ProductoAgotado' | 'ProductoDisponible' = 'ProductoAgotado',
) =>
  nodo.crear(
    producto,
    tipo,
    { producto_id: producto, variante_id: variante },
    { agregado_tipo: 'producto' },
  )

const liberar = (nodo: Nodo, producto: string, variante: string | null = null) =>
  agotar(nodo, producto, variante, 'ProductoDisponible')

/** El hub de la prueba con un control de acceso propio, sobre el mismo almacén. */
function conAcceso(m: Montaje, acceso: ControlAcceso) {
  const hub = new HubSync(m.almacen, {
    restauranteId: m.restauranteId,
    zonaHoraria: 'America/Bogota',
    inicioDiaOperativo: '06:00',
    acceso,
    instancia: m.estado.instancia,
    reloj: m.red.horaIso,
  })
  m.estado.hub = hub
  m.red.sala = new SalaSync(hub, m.red.autenticar)
}

/** Lo agotado que dicen estos eventos, en el orden dado (el último de cada clave manda). */
function agotadosDe(eventos: readonly Pick<EventoPedido, 'tipo' | 'datos' | 'secuencia'>[]) {
  const resultado = new Set<string>()
  for (const e of [...eventos].sort((a, b) => a.secuencia - b.secuencia)) {
    if (e.tipo !== 'ProductoAgotado' && e.tipo !== 'ProductoDisponible') continue
    // `Pick` pierde la relación entre tipo y datos.
    const d = e.datos as { producto_id: string; variante_id: string | null }
    const clave = `${d.producto_id}:${d.variante_id ?? ''}`
    if (e.tipo === 'ProductoAgotado') resultado.add(clave)
    else resultado.delete(clave)
  }
  return resultado
}

const confirmadosDe = async (nodo: Nodo) =>
  (await nodo.cliente.locales())
    .filter((l) => l.estado === 'confirmado')
    .map((l) => l.evento as EventoPedido)

describe('pedidosDe con eventos de producto', () => {
  it('un agotado toca solo a su producto: no se confunde con ningún pedido', () => {
    const producto = nuevoId()
    const pedido = nuevoId()
    const agotado = { agregado_id: producto, relacionados: [], afecta: [] }
    expect(pedidosDe(agotado)).toEqual([producto])
    expect(pedidosDe(agotado)).not.toContain(pedido)
    expect(pedidosDe({ agregado_id: pedido, relacionados: [] })).toEqual([pedido])
  })
})

describe('huella de un evento de producto', () => {
  it('ignora secuencia_base y firma, y distingue tipo, variante y agregado_tipo', () => {
    const producto = nuevoId()
    const e = {
      id: nuevoId(),
      tipo: 'ProductoAgotado',
      version_esquema: 1,
      agregado_tipo: 'producto',
      agregado_id: producto,
      relacionados: [],
      datos: { producto_id: producto, variante_id: null },
      sesion_id: null,
      usuario_id: nuevoId(),
      dispositivo_id: nuevoId(),
      autorizacion_id: null,
      motivo: null,
      hora_dispositivo: '2026-10-24T20:00:00.000Z',
      hora_estimada_hub: '2026-10-24T20:00:00.000Z',
      secuencia_base: 0,
    }
    const h = huellaEvento(e)
    expect(huellaEvento({ ...e, secuencia_base: 99, firma: 'f'.repeat(64) })).toBe(h)
    expect(huellaEvento({ ...e, tipo: 'ProductoDisponible' })).not.toBe(h)
    expect(huellaEvento({ ...e, agregado_tipo: 'pedido' })).not.toBe(h)
    expect(
      huellaEvento({ ...e, datos: { producto_id: producto, variante_id: nuevoId() } }),
    ).not.toBe(h)
  })
})

describe('lotes que mezclan agotados y pedidos', () => {
  it('sin conexión: pedido, ítems y agotados se envían juntos, en orden, y todos se confirman', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const luis = m.red.dispositivo('luis')
    await luis.conectar()
    const pedido = nuevoId()
    const x = nuevoId()
    const botella = nuevoId()
    await abrirPedido(ana, pedido)
    await ana.crear(pedido, 'ItemAgregado', item(10_000))
    await agotar(ana, x)
    await ana.crear(pedido, 'ItemAgregado', item(20_000))
    await agotar(ana, x, botella)
    await liberar(ana, x)
    await m.red.conectarTodos()

    expect(eventosDe(m).map((e) => [e.secuencia, e.tipo])).toEqual([
      [1, 'PedidoAbierto'],
      [2, 'ItemAgregado'],
      [3, 'ProductoAgotado'],
      [4, 'ItemAgregado'],
      [5, 'ProductoAgotado'],
      [6, 'ProductoDisponible'],
    ])
    expect(Object.keys(m.hub().pedido(pedido)?.items ?? {})).toHaveLength(2)
    expect(m.hub().pedido(pedido)?.estado).toBe('abierto')
    expect(m.hub().pedido(x)).toBeNull()
    await venLoMismo(m.hub(), eventosDe(m), [ana, luis], [pedido, x])
    // El producto no se filtra al estado de ningún pedido en el dispositivo.
    expect(await luis.cliente.pedido(x)).toBeNull()
    expect(agotadosDe(await confirmadosDe(luis))).toEqual(new Set([`${x}:${botella}`]))
  })

  it('mensajes de producto duplicados o perdidos en la red no repiten ni pierden el agotado', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const luis = m.red.dispositivo('luis')
    await m.red.conectarTodos()
    const pedido = await abrirPedido(ana)
    const x = nuevoId()
    ana.desconectar()
    await ana.crear(pedido, 'ItemAgregado', item())
    await agotar(ana, x)
    await liberar(ana, x)
    await agotar(ana, x)

    ana.regla('al_hub', 'empujar', 'duplicar')
    ana.regla('al_dispositivo', 'resultado', 'perder')
    luis.regla('al_dispositivo', 'nuevo', 'duplicar', 3)
    await m.red.conectarTodos()
    ana.desconectar()
    await m.red.conectarTodos()

    expect(eventosDe(m).map((e) => e.tipo)).toEqual([
      'PedidoAbierto',
      'ItemAgregado',
      'ProductoAgotado',
      'ProductoDisponible',
      'ProductoAgotado',
    ])
    await venLoMismo(m.hub(), eventosDe(m), [ana, luis], [pedido, x])
    expect(agotadosDe(await confirmadosDe(luis))).toEqual(new Set([`${x}:`]))
  })

  it('el hub se cae a mitad de un lote mixto: al volver no hay duplicados ni huecos', async () => {
    for (const caer of [1, 2, 3, 4, 5]) {
      const m = montar()
      const ana = m.red.dispositivo('ana')
      const luis = m.red.dispositivo('luis')
      await luis.conectar()
      const pedido = nuevoId()
      const x = nuevoId()
      await abrirPedido(ana, pedido)
      await agotar(ana, x)
      await ana.crear(pedido, 'ItemAgregado', item())
      await liberar(ana, x)
      await agotar(ana, nuevoId())
      ;(m.almacen as AlmacenQueSeCae).caerEn = caer

      await m.red.conectarTodos()
      await m.red.conectarTodos()

      const eventos = eventosDe(m)
      expect(eventos, `caída en el guardado ${caer}`).toHaveLength(5)
      await venLoMismo(m.hub(), eventos, [ana, luis], [pedido, x])
    }
  })

  it('tras reiniciar el hub los pedidos se reconstruyen igual y los agotados siguen en la secuencia', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    await m.red.conectarTodos()
    const pedido = await abrirPedido(ana)
    const x = nuevoId()
    await agotar(ana, x)
    await ana.crear(pedido, 'ItemAgregado', item(7_000))
    await m.red.estabilizar()
    const antes = structuredClone(m.hub().pedido(pedido))

    // El proceso se reinicia: mismo almacén, hub nuevo, misma instancia.
    ana.desconectar()
    m.red.sala = m.crearSala()
    expect(m.hub().pedido(pedido)).toEqual(antes)
    expect(m.hub().pedido(x)).toBeNull()

    await liberar(ana, x)
    await m.red.conectarTodos()
    expect(eventosDe(m).map((e) => e.secuencia)).toEqual([1, 2, 3, 4])
    await venLoMismo(m.hub(), eventosDe(m), [ana], [pedido, x])
    // Un tercer equipo que llega después recibe los de producto en su sitio.
    const nuevo = m.red.dispositivo('nuevo')
    await nuevo.conectar()
    await m.red.estabilizar()
    expect(agotadosDe(await confirmadosDe(nuevo))).toEqual(new Set())
    expect((await confirmadosDe(nuevo)).map((e) => e.tipo)).toContain('ProductoAgotado')
  })

  it('más agotados que una página: el equipo nuevo los trae todos y termina igual', async () => {
    const m = montar()
    const caja = m.red.dispositivo('caja')
    await caja.conectar()
    const x = nuevoId()
    for (let i = 0; i < TAMANO_PAGINA + 20; i++) {
      await (i % 2 === 0 ? agotar(caja, x) : liberar(caja, x))
    }
    await m.red.estabilizar()
    const nuevo = m.red.dispositivo('nuevo')
    await nuevo.conectar()
    await m.red.estabilizar()

    expect(eventosDe(m)).toHaveLength(TAMANO_PAGINA + 20)
    await venLoMismo(m.hub(), eventosDe(m), [caja, nuevo], [x])
    // 520 eventos: el último (índice 519) es "disponible".
    expect(agotadosDe(await confirmadosDe(nuevo))).toEqual(new Set())
  })

  it('con el reloj del equipo desfasado, el agotado se acepta y el hub le pone su hora', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    ana.desfaseMs = -3 * 3_600_000
    await ana.conectar()
    await m.red.estabilizar()
    const x = nuevoId()
    const e = await agotar(ana, x)
    await m.red.estabilizar()

    const guardado = eventosDe(m)[0] as EventoPedido
    expect(guardado.id).toBe(e.id)
    expect(guardado.recibido_en).toBe(m.red.horaIso())
    expect(Date.parse(guardado.hora_dispositivo)).toBeLessThan(Date.parse(guardado.recibido_en))
  })
})

describe('un dispositivo restaurado con eventos de producto', () => {
  it('el hub vuelve de un respaldo viejo: se reenvían los agotados propios y todos quedan iguales', async () => {
    const m = montar({ almacen: 'memoria' })
    const ana = m.red.dispositivo('ana')
    const caja = m.red.dispositivo('caja')
    await m.red.conectarTodos()
    const pedido = await abrirPedido(ana)
    const x = nuevoId()
    const y = nuevoId()
    await agotar(caja, x)
    await m.red.estabilizar()
    const respaldo = structuredClone((m.almacen as AlmacenMemoria).eventos)

    // Después del respaldo: otro agotado, un ítem y la reposición del primero.
    await agotar(caja, y)
    await ana.crear(pedido, 'ItemAgregado', item())
    await liberar(caja, x)
    await m.red.estabilizar()
    expect(eventosDe(m)).toHaveLength(5)

    for (const nodo of m.red.nodos) nodo.desconectar()
    const restaurado = new AlmacenMemoria()
    restaurado.eventos = respaldo
    m.estado.instancia = 'hub-2'
    m.red.sala = m.crearSala(restaurado)
    await m.red.conectarTodos()

    const eventos = restaurado.eventosDesde(0, 1000)
    expect(eventos).toHaveLength(5)
    expect(restaurado.rechazos).toEqual([])
    await venLoMismo(m.hub(), eventos, [ana, caja], [pedido, x, y])
    // Cada equipo termina con lo mismo que el hub: x repuesto, y agotado.
    const esperado = agotadosDe(eventos)
    expect(esperado).toEqual(new Set([`${y}:`]))
    for (const nodo of [ana, caja]) expect(agotadosDe(await confirmadosDe(nodo))).toEqual(esperado)
    // Y con `reenviarTodo` no quedó ninguno pendiente ni con la base vieja.
    for (const nodo of [ana, caja])
      for (const l of await nodo.cliente.locales())
        expect(l.evento.secuencia_base).toBeLessThanOrEqual(5)
  })

  it('un hub vacío (reinstalado): los agotados de los equipos se vuelven a registrar sin perderse', async () => {
    const m = montar({ almacen: 'memoria' })
    const caja = m.red.dispositivo('caja')
    await m.red.conectarTodos()
    const x = nuevoId()
    const botella = nuevoId()
    await agotar(caja, x, botella)
    await agotar(caja, x)
    await m.red.estabilizar()

    caja.desconectar()
    m.estado.instancia = 'hub-3'
    m.red.sala = m.crearSala(new AlmacenMemoria())
    await m.red.conectarTodos()

    expect(eventosDe(m).map((e) => e.tipo)).toEqual(['ProductoAgotado', 'ProductoAgotado'])
    await venLoMismo(m.hub(), eventosDe(m), [caja], [x])
  })
})

describe('rechazos en cadena: producto y pedido no se arrastran', () => {
  const sinPermisoParaAgotar = (producto: string): ControlAcceso => ({
    verificar: (_c, evento) =>
      evento.tipo === 'ProductoAgotado' && evento.agregado_id === producto
        ? { ok: false, motivo: 'sin_permiso' }
        : { ok: true, autorizadoPorId: null, autorizacionId: null },
    registrarUso: () => {},
  })

  it('un agotado rechazado arrastra a los pendientes de ese mismo producto, no a los de un pedido ni de otro producto', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const x = nuevoId()
    const y = nuevoId()
    const pedido = nuevoId()
    conAcceso(m, sinPermisoParaAgotar(x))

    await abrirPedido(ana, pedido)
    const a1 = await ana.crear(pedido, 'ItemAgregado', item())
    const rechazado = await agotar(ana, x)
    const a2 = await ana.crear(pedido, 'ItemAgregado', item())
    const mismoProducto = await liberar(ana, x)
    const otroProducto = await agotar(ana, y)
    await m.red.conectarTodos()

    const estado = async (id: string) => (await ana.almacen.obtener(id))?.estado
    expect(await estado(rechazado.id)).toBe('rechazado')
    expect((await ana.almacen.obtener(rechazado.id))?.motivo).toBe('sin_permiso')
    expect(await estado(mismoProducto.id)).toBe('rechazado')
    expect((await ana.almacen.obtener(mismoProducto.id))?.motivo).toBe('depende_de_rechazado')
    expect(await estado(a1.id)).toBe('confirmado')
    expect(await estado(a2.id)).toBe('confirmado')
    expect(await estado(otroProducto.id)).toBe('confirmado')
    expect(m.hub().pedido(pedido)?.estado).toBe('abierto')
  })

  it('un ítem rechazado no arrastra a los agotados pendientes, aunque vayan en el mismo lote', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const pedido = nuevoId()
    const x = nuevoId()
    await abrirPedido(ana, pedido)
    const caro = await ana.crear(pedido, 'ItemAgregado', item(100_000_000, { cantidad: 999 }))
    const despues = await ana.crear(pedido, 'ItemAgregado', item())
    const agotado = await agotar(ana, x)
    await m.red.conectarTodos()

    expect((await ana.almacen.obtener(caro.id))?.estado).toBe('rechazado')
    expect((await ana.almacen.obtener(despues.id))?.motivo).toBe('depende_de_rechazado')
    expect((await ana.almacen.obtener(agotado.id))?.estado).toBe('confirmado')
    expect(agotadosDe(await confirmadosDe(ana))).toEqual(new Set([`${x}:`]))
  })

  it('el rechazo de un agotado ya enviado no deshace lo que el hub confirmó de otro equipo', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const luis = m.red.dispositivo('luis')
    await m.red.conectarTodos()
    const x = nuevoId()
    await agotar(luis, x)
    await m.red.estabilizar()
    // Ana aún no estaba al día y marca lo mismo con el permiso retirado: se rechaza solo el suyo.
    conAcceso(m, sinPermisoParaAgotar(x))
    ana.desconectar()
    const suyo = await agotar(ana, x)
    await m.red.conectarTodos()

    expect((await ana.almacen.obtener(suyo.id))?.estado).toBe('rechazado')
    expect(agotadosDe(await confirmadosDe(ana))).toEqual(new Set([`${x}:`]))
    expect(agotadosDe(eventosDe(m))).toEqual(new Set([`${x}:`]))
  })
})

describe('convergencia de agotados entre equipos sin conexión', () => {
  it('dos equipos marcan lo contrario sin conexión: gana el orden en que llegan al hub, y ambos lo ven', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const luis = m.red.dispositivo('luis')
    await m.red.conectarTodos()
    const x = nuevoId()
    await agotar(luis, x)
    await m.red.estabilizar()

    ana.desconectar()
    luis.desconectar()
    await liberar(luis, x)
    await agotar(ana, x)
    // Ana se conecta primero: su "agotado" queda antes que el "disponible" de Luis.
    await ana.conectar()
    await m.red.estabilizar()
    await luis.conectar()
    await m.red.estabilizar()

    expect(eventosDe(m).map((e) => e.tipo)).toEqual([
      'ProductoAgotado',
      'ProductoAgotado',
      'ProductoDisponible',
    ])
    await venLoMismo(m.hub(), eventosDe(m), [ana, luis], [x])
    for (const nodo of [ana, luis]) expect(agotadosDe(await confirmadosDe(nodo))).toEqual(new Set())
  })

  it('la variante y el producto entero son independientes', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    await m.red.conectarTodos()
    const x = nuevoId()
    const botella = nuevoId()
    await agotar(ana, x, botella)
    await liberar(ana, x)
    await m.red.estabilizar()
    expect(agotadosDe(eventosDe(m))).toEqual(new Set([`${x}:${botella}`]))
    await liberar(ana, x, botella)
    await m.red.estabilizar()
    expect(agotadosDe(eventosDe(m))).toEqual(new Set())
  })

  it('propiedad: con cortes, caídas y duplicados, todos terminan con los mismos agotados que el hub', async () => {
    const productos = Array.from({ length: 3 }, () => nuevoId())
    const variantes = [null, nuevoId(), nuevoId()]
    type Acc =
      | { t: 'agotar' | 'liberar'; nodo: number; p: number; v: number }
      | { t: 'cortar' | 'conectar' | 'estabilizar' | 'caerHub' | 'pedido'; nodo: number }
      | { t: 'duplicar' | 'perder'; nodo: number }
    const sel = fc.nat({ max: 5 })
    const arbAccion: fc.Arbitrary<Acc> = fc.oneof(
      {
        weight: 8,
        arbitrary: fc.record({
          t: fc.constantFrom('agotar' as const, 'liberar' as const),
          nodo: sel,
          p: fc.nat({ max: 2 }),
          v: fc.nat({ max: 2 }),
        }),
      },
      { weight: 3, arbitrary: fc.record({ t: fc.constant('cortar' as const), nodo: sel }) },
      { weight: 4, arbitrary: fc.record({ t: fc.constant('conectar' as const), nodo: sel }) },
      { weight: 3, arbitrary: fc.record({ t: fc.constant('estabilizar' as const), nodo: sel }) },
      { weight: 1, arbitrary: fc.record({ t: fc.constant('caerHub' as const), nodo: sel }) },
      { weight: 2, arbitrary: fc.record({ t: fc.constant('pedido' as const), nodo: sel }) },
      {
        weight: 2,
        arbitrary: fc.record({
          t: fc.constantFrom('duplicar' as const, 'perder' as const),
          nodo: sel,
        }),
      },
    )

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 3 }),
        fc.array(arbAccion, { minLength: 6, maxLength: 40 }),
        async (cuantos, acciones) => {
          const m = montar()
          const nodos = Array.from({ length: cuantos }, (_, i) => m.red.dispositivo(`d${i}`))
          for (const a of acciones) {
            const nodo = nodos[a.nodo % nodos.length] as Nodo
            switch (a.t) {
              case 'agotar':
              case 'liberar':
                await (a.t === 'agotar' ? agotar : liberar)(
                  nodo,
                  productos[a.p] as string,
                  variantes[a.v] ?? null,
                )
                break
              case 'pedido':
                await abrirPedido(nodo, nuevoId(), null)
                break
              case 'cortar':
                nodo.desconectar()
                break
              case 'conectar':
                if (!nodo.enLinea) await nodo.conectar()
                break
              case 'estabilizar':
                await m.red.estabilizar()
                break
              case 'caerHub':
                m.red.caerHub()
                break
              case 'duplicar':
                nodo.regla('al_hub', 'empujar', 'duplicar')
                break
              case 'perder':
                nodo.regla('al_dispositivo', 'resultado', 'perder')
                break
            }
          }
          for (const n of nodos) {
            n.reglas = []
            n.desconectar()
          }
          await m.red.conectarTodos()

          const hub = eventosDe(m)
          expect(hub.map((e) => e.secuencia)).toEqual(hub.map((_, i) => i + 1))
          const esperado = agotadosDe(hub)
          for (const n of nodos) {
            expect(await n.cliente.pendientes()).toBe(0)
            expect(agotadosDe(await confirmadosDe(n))).toEqual(esperado)
          }
        },
      ),
      { seed: 20_261_024, numRuns: 80 },
    )
  }, 120_000)
})

// Para que el montaje de acceso libre quede referenciado si cambia la forma de montar.
void accesoLibre
