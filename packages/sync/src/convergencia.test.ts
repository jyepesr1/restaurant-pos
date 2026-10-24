import { type EventoNuevo, nuevoId, type TipoEventoPedido } from '@pos/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type AlmacenQueSeCae, eventosDe, item, montar } from './pruebas/montaje'
import type { Nodo } from './pruebas/red'

// Criterio de aceptación de la Fase 0: pase lo que pase en la red (cortes, mensajes perdidos o
// duplicados, hub caído), al final todos los dispositivos y el hub ven exactamente lo mismo y
// ningún evento se pierde. Semilla fija: la prueba es determinista (`FC_SEMILLA` para explorar).

const SEMILLA = Number(process.env.FC_SEMILLA ?? 20_261_024)
const CORRIDAS = Number(process.env.FC_CORRIDAS ?? 150)

type Direccion = 'al_hub' | 'al_dispositivo'

type Accion =
  | { t: 'abrir'; nodo: number; mesa: number }
  | { t: 'agregar'; nodo: number; pedido: number; precio: number }
  | { t: 'enviar'; nodo: number; pedido: number }
  | { t: 'quitar'; nodo: number; pedido: number; item: number }
  | { t: 'desconectar'; nodo: number }
  | { t: 'conectar'; nodo: number }
  | { t: 'perder'; nodo: number; direccion: Direccion; tipo: number }
  | { t: 'duplicar'; nodo: number; direccion: Direccion; tipo: number }
  | { t: 'entregar'; nodo: number; direccion: Direccion; indice: number }
  | { t: 'estabilizar' }
  | { t: 'caerHub' }
  | { t: 'caerAlGuardar'; en: number }

const TIPOS_MENSAJE: Record<Direccion, string[]> = {
  al_hub: ['empujar', 'traer', 'hola'],
  al_dispositivo: ['resultado', 'nuevo', 'eventos', 'bienvenido'],
}

const sel = fc.nat({ max: 9 })
const direccion = fc.constantFrom<Direccion>('al_hub', 'al_dispositivo')

const arbAccion: fc.Arbitrary<Accion> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({ t: fc.constant('abrir' as const), nodo: sel, mesa: fc.nat({ max: 3 }) }),
  },
  {
    weight: 8,
    arbitrary: fc.record({
      t: fc.constant('agregar' as const),
      nodo: sel,
      pedido: sel,
      precio: fc.integer({ min: 1000, max: 90_000 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ t: fc.constant('enviar' as const), nodo: sel, pedido: sel }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ t: fc.constant('quitar' as const), nodo: sel, pedido: sel, item: sel }),
  },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('desconectar' as const), nodo: sel }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant('conectar' as const), nodo: sel }) },
  {
    weight: 3,
    arbitrary: fc.record({ t: fc.constant('perder' as const), nodo: sel, direccion, tipo: sel }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ t: fc.constant('duplicar' as const), nodo: sel, direccion, tipo: sel }),
  },
  {
    weight: 8,
    arbitrary: fc.record({
      t: fc.constant('entregar' as const),
      nodo: sel,
      direccion,
      indice: sel,
    }),
  },
  { weight: 4, arbitrary: fc.constant({ t: 'estabilizar' as const }) },
  { weight: 1, arbitrary: fc.constant({ t: 'caerHub' as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('caerAlGuardar' as const),
      en: fc.integer({ min: 1, max: 4 }),
    }),
  },
)

const arbEscenario = fc.record({
  dispositivos: fc.integer({ min: 2, max: 4 }),
  acciones: fc.array(arbAccion, { minLength: 8, maxLength: 80, size: 'max' }),
})

/** Ejecuta las acciones sobre un hub real (SQLite) y una red simulada. */
async function ejecutar(dispositivos: number, acciones: Accion[], canalOrdenado = false) {
  const m = montar()
  const almacen = m.almacen as AlmacenQueSeCae
  const nodos = Array.from({ length: dispositivos }, (_, i) => m.red.dispositivo(`d${i}`))
  const mesas = Array.from({ length: 4 }, () => nuevoId())
  const estacion = nuevoId()
  /** Todo evento que algún dispositivo creó, para comprobar que ninguno se pierde. */
  const creados: { id: string; nodo: Nodo }[] = []
  const pedidos: string[] = []

  const registrar = async <T extends TipoEventoPedido>(
    nodo: Nodo,
    pedido: string,
    tipo: T,
    datos: Extract<EventoNuevo, { tipo: T }>['datos'],
  ) => {
    const evento = await nodo.crear(pedido, tipo, datos as never)
    creados.push({ id: evento.id, nodo })
  }

  /** Pedidos que este dispositivo ve abiertos en su propia copia. */
  const abiertosDe = async (nodo: Nodo) => {
    const vistos: string[] = []
    for (const id of pedidos)
      if ((await nodo.cliente.pedido(id))?.estado === 'abierto') vistos.push(id)
    return vistos
  }

  for (const accion of acciones) {
    // Canal como un WebSocket sano: sin pérdidas, duplicados ni reordenamientos.
    if (canalOrdenado && (accion.t === 'perder' || accion.t === 'duplicar')) continue
    const nodo = nodos[('nodo' in accion ? accion.nodo : 0) % nodos.length] as Nodo
    switch (accion.t) {
      case 'abrir': {
        const pedido = nuevoId()
        pedidos.push(pedido)
        // La mesa 3 es "sin mesa" (barra); las demás se comparten entre dispositivos.
        const mesa = accion.mesa === 3 ? null : (mesas[accion.mesa] as string)
        await registrar(nodo, pedido, 'PedidoAbierto', {
          canal: mesa ? 'salon' : 'barra',
          mesa_id: mesa,
          comensales: 2,
        })
        break
      }
      case 'agregar': {
        const abiertos = await abiertosDe(nodo)
        const pedido = abiertos[accion.pedido % abiertos.length]
        if (pedido) await registrar(nodo, pedido, 'ItemAgregado', item(accion.precio))
        break
      }
      case 'enviar': {
        const abiertos = await abiertosDe(nodo)
        const pedido = abiertos[accion.pedido % abiertos.length]
        const estado = pedido ? await nodo.cliente.pedido(pedido) : null
        const ids = Object.values(estado?.items ?? {})
          .filter((i) => i.estado === 'pendiente')
          .slice(0, 3)
          .map((i) => i.id)
        if (pedido && ids.length > 0)
          await registrar(nodo, pedido, 'ItemsEnviados', {
            comandas: [{ comanda_id: nuevoId(), estacion_id: estacion, item_ids: ids }],
          })
        break
      }
      case 'quitar': {
        const abiertos = await abiertosDe(nodo)
        const pedido = abiertos[accion.pedido % abiertos.length]
        const estado = pedido ? await nodo.cliente.pedido(pedido) : null
        const quitables = Object.values(estado?.items ?? {}).filter((i) => i.estado === 'pendiente')
        const elegido = quitables[accion.item % quitables.length]
        if (pedido && elegido) await registrar(nodo, pedido, 'ItemQuitado', { item_id: elegido.id })
        break
      }
      case 'desconectar':
        nodo.desconectar()
        break
      case 'conectar':
        if (!nodo.enLinea) await nodo.conectar()
        break
      case 'perder':
      case 'duplicar': {
        const tipos = TIPOS_MENSAJE[accion.direccion]
        nodo.regla(
          accion.direccion,
          tipos[accion.tipo % tipos.length] as string,
          accion.t === 'perder' ? 'perder' : 'duplicar',
        )
        break
      }
      case 'entregar':
        await m.red.entregarUno(nodo, accion.direccion, canalOrdenado ? 0 : accion.indice)
        break
      case 'estabilizar':
        await m.red.estabilizar()
        break
      case 'caerHub':
        m.red.caerHub()
        break
      case 'caerAlGuardar':
        almacen.caerEn = accion.en
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
    if (!canalOrdenado) n.desconectar()
  }
  await m.red.conectarTodos()
  return { m, nodos, creados, pedidos }
}

/** Todo lo que debe cumplirse al final de cualquier secuencia de acciones. */
async function verificar({ m, nodos, creados, pedidos }: Awaited<ReturnType<typeof ejecutar>>) {
  const hub = eventosDe(m)

  // El hub tiene 1..N sin huecos ni ids repetidos.
  expect(hub.map((e) => e.secuencia)).toEqual(hub.map((_, i) => i + 1))
  expect(new Set(hub.map((e) => e.id)).size).toBe(hub.length)
  // Un solo conflicto por evento.
  const conflictos = m.hub().conflictos()
  expect(new Set(conflictos.map((c) => c.eventoId)).size).toBe(conflictos.length)

  const hubPorId = new Map(hub.map((e) => [e.id, e]))
  for (const nodo of nodos) {
    // Ningún pendiente.
    expect(await nodo.cliente.pendientes()).toBe(0)
    const locales = await nodo.cliente.locales()
    expect(locales.filter((l) => l.estado === 'pendiente')).toEqual([])

    // Los mismos eventos confirmados que el hub, idénticos campo por campo.
    const confirmados = locales.filter((l) => l.estado === 'confirmado')
    expect(confirmados.map((l) => l.evento.id).sort()).toEqual(hub.map((e) => e.id).sort())
    for (const l of confirmados) expect(l.evento).toEqual(hubPorId.get(l.evento.id))
    expect((await nodo.almacen.cursor()).hasta).toBe(hub.length)

    // Las mismas proyecciones.
    for (const pedido of pedidos)
      expect(await nodo.cliente.pedido(pedido), `pedido ${pedido} en ${nodo.nombre}`).toEqual(
        m.hub().pedido(pedido),
      )
  }

  // Ningún evento creado se perdió: confirmado, rechazado con motivo o en cuarentena.
  for (const { id, nodo } of creados) {
    const local = await nodo.almacen.obtener(id)
    expect(local, `evento ${id} desapareció de ${nodo.nombre}`).toBeDefined()
    if (local?.estado === 'confirmado') expect(hubPorId.has(id)).toBe(true)
    else if (local?.estado === 'rechazado') {
      expect(local.motivo, `rechazo sin motivo (${id})`).toBeTruthy()
      expect(hubPorId.has(id), `rechazado en ${nodo.nombre} pero confirmado en el hub`).toBe(false)
    } else expect(local?.estado).toBe('cuarentena')
  }
}

describe('convergencia (propiedades)', () => {
  it('con cortes, pérdidas, duplicados y caídas del hub, todos terminan viendo lo mismo', async () => {
    await fc.assert(
      fc.asyncProperty(arbEscenario, async ({ dispositivos, acciones }) => {
        await verificar(await ejecutar(dispositivos, acciones))
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  }, 120_000)

  it('con el canal ordenado y sin pérdidas, las conexiones vivas se ponen al día sin reconectar', async () => {
    await fc.assert(
      fc.asyncProperty(arbEscenario, async ({ dispositivos, acciones }) => {
        await verificar(await ejecutar(dispositivos, acciones, true))
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  }, 120_000)
})
