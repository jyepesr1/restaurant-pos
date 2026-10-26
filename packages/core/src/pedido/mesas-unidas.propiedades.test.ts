import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { nuevoId } from '../id'
import { aplicarTodos } from '../pruebas/ayudas'
import { evento } from '../pruebas/fabrica'
import { type Accion, accionArb, Servicio } from '../pruebas/simulador'
import { aplicarEvento } from './aplicar'
import type { EstadoPedido } from './estado'
import { totalesPedido } from './totales'

// Propiedades de unir mesas (tarea 1.5): un modelo mínimo escrito aparte contra el reductor, y
// los invariantes sobre las secuencias del simulador de servicio. Semilla fija.

const CONFIG = { seed: 20_261_025, numRuns: 400 }
const MESAS = Array.from({ length: 6 }, () => nuevoId())

type Paso =
  | { t: 'unir'; mesas: number[] }
  | { t: 'separar'; mesas: number[] }
  | { t: 'pasar'; mesa: number }

const indices = fc.uniqueArray(fc.nat(MESAS.length - 1), { minLength: 1, maxLength: 4 })
const pasoArb: fc.Arbitrary<Paso> = fc.oneof(
  indices.map((mesas): Paso => ({ t: 'unir', mesas })),
  indices.map((mesas): Paso => ({ t: 'separar', mesas })),
  fc.nat(MESAS.length - 1).map((mesa): Paso => ({ t: 'pasar', mesa })),
)

/** Lo que dice el documento: el modelo, sin tocar el reductor. */
interface Modelo {
  principal: string | null
  unidas: string[]
}

function modelar(m: Modelo, p: Paso): { modelo: Modelo; problema: string | null } {
  if (p.t === 'pasar') {
    const mesa = MESAS[p.mesa] as string
    return {
      modelo: { principal: mesa, unidas: m.unidas.filter((x) => x !== mesa) },
      problema: null,
    }
  }
  const dadas = p.mesas.map((i) => MESAS[i] as string)
  if (p.t === 'unir') {
    if (!m.principal) return { modelo: m, problema: 'sin_mesa' }
    const nuevas = dadas.filter((x) => x !== m.principal && !m.unidas.includes(x))
    if (nuevas.length === 0) return { modelo: m, problema: 'mesas_ya_unidas' }
    return { modelo: { ...m, unidas: [...m.unidas, ...nuevas] }, problema: null }
  }
  if (!m.unidas.some((x) => dadas.includes(x))) return { modelo: m, problema: 'mesas_no_unidas' }
  return { modelo: { ...m, unidas: m.unidas.filter((x) => !dadas.includes(x)) }, problema: null }
}

const comoEvento = (pedido: string, p: Paso) =>
  p.t === 'pasar'
    ? evento(pedido, 'PedidoMovidoDeMesa', { mesa_destino_id: MESAS[p.mesa] as string })
    : evento(pedido, p.t === 'unir' ? 'MesasUnidas' : 'MesasSeparadas', {
        mesa_ids: p.mesas.map((i) => MESAS[i] as string),
      })

const sinRepetidas = (lista: readonly string[]) => new Set(lista).size === lista.length

describe('mesas unidas: el reductor contra un modelo', () => {
  it.each([
    ['con mesa', true],
    ['sin mesa (barra)', false],
  ])(
    'pedido %s: mismas mesas y mismos problemas que el modelo en cualquier secuencia',
    (_n, conMesa) => {
      fc.assert(
        fc.property(fc.array(pasoArb, { maxLength: 40 }), (pasos) => {
          const pedido = nuevoId()
          let estado: EstadoPedido | null = aplicarTodos([
            evento(pedido, 'PedidoAbierto', {
              canal: 'salon',
              mesa_id: conMesa ? (MESAS[0] as string) : null,
              comensales: 2,
            }),
          ])
          let modelo: Modelo = { principal: conMesa ? (MESAS[0] as string) : null, unidas: [] }
          for (const paso of pasos) {
            const esperado = modelar(modelo, paso)
            const r = aplicarEvento(estado, comoEvento(pedido, paso))
            expect(r.problema?.tipo ?? null).toBe(esperado.problema)
            estado = r.estado
            modelo = esperado.modelo
            expect(estado?.mesaId).toBe(modelo.principal)
            expect(estado?.mesasUnidas).toEqual(modelo.unidas)
            // Invariantes: sin repetidas y la principal nunca está entre las unidas.
            expect(sinRepetidas(estado?.mesasUnidas ?? [])).toBe(true)
            if (estado?.mesaId) expect(estado.mesasUnidas).not.toContain(estado.mesaId)
          }
        }),
        CONFIG,
      )
    },
  )

  it('un evento rechazado deja el estado exactamente igual (misma referencia)', () => {
    fc.assert(
      fc.property(fc.array(pasoArb, { maxLength: 30 }), (pasos) => {
        const pedido = nuevoId()
        let estado: EstadoPedido | null = aplicarTodos([
          evento(pedido, 'PedidoAbierto', {
            canal: 'salon',
            mesa_id: MESAS[0] as string,
            comensales: 1,
          }),
        ])
        for (const paso of pasos) {
          const r = aplicarEvento(estado, comoEvento(pedido, paso))
          if (r.problema) expect(r.estado).toBe(estado)
          estado = r.estado
        }
      }),
      { ...CONFIG, seed: 20_261_026 },
    )
  })

  it('las mesas que ocupa un pedido (principal + unidas) son siempre distintas entre sí', () => {
    fc.assert(
      fc.property(fc.array(pasoArb, { maxLength: 40 }), (pasos) => {
        const pedido = nuevoId()
        let estado = aplicarTodos([
          evento(pedido, 'PedidoAbierto', {
            canal: 'salon',
            mesa_id: MESAS[0] as string,
            comensales: 1,
          }),
        ])
        for (const paso of pasos) {
          estado = aplicarEvento(estado, comoEvento(pedido, paso)).estado as EstadoPedido
          const ocupadas = [estado.mesaId, ...estado.mesasUnidas].filter(Boolean) as string[]
          expect(sinRepetidas(ocupadas)).toBe(true)
        }
      }),
      { ...CONFIG, seed: 20_261_027 },
    )
  })
})

describe('mesas unidas con el simulador de servicio', () => {
  const secuencia = fc.array(accionArb, { minLength: 10, maxLength: 80, size: 'max' })

  it('en cualquier camino, las unidas no se repiten ni incluyen la mesa principal', () => {
    fc.assert(
      fc.property(secuencia, (acciones) => {
        const servicio = new Servicio()
        for (const accion of acciones) {
          servicio.paso(accion)
          for (const estado of servicio.estados) {
            if (!estado) continue
            expect(sinRepetidas(estado.mesasUnidas)).toBe(true)
            if (estado.mesaId) expect(estado.mesasUnidas).not.toContain(estado.mesaId)
          }
        }
        expect(servicio.invalidos).toEqual([])
      }),
      CONFIG,
    )
  })

  it('unir, separar y cambiar de mesa no mueven dinero, ítems ni pagos', () => {
    let unidos = 0
    fc.assert(
      fc.property(secuencia, (acciones) => {
        const servicio = new Servicio()
        for (const accion of acciones as Accion[]) {
          const antes = servicio.estados.map((e) => (e ? structuredClone(e) : null))
          const largo = servicio.log.length
          servicio.paso(accion)
          const nuevo = servicio.log.at(-1)
          if (servicio.log.length === largo || !nuevo) continue
          if (!['MesasUnidas', 'MesasSeparadas', 'PedidoMovidoDeMesa'].includes(nuevo.tipo))
            continue
          if (servicio.aplicados.at(-1) !== nuevo) continue
          if (nuevo.tipo === 'MesasUnidas') unidos += 1
          const p = servicio.pedidos.indexOf(nuevo.agregado_id)
          const a = antes[p]
          const d = servicio.estados[p]
          if (!a || !d) throw new Error('falta el pedido')
          expect(totalesPedido(d)).toEqual(totalesPedido(a))
          expect(d.items).toEqual(a.items)
          expect(d.pagos).toEqual(a.pagos)
          expect(d.descuentos).toEqual(a.descuentos)
          expect(d.estado).toBe(a.estado)
          // Y el otro pedido ni se entera.
          expect(servicio.estados[1 - p]).toEqual(antes[1 - p])
        }
      }),
      { ...CONFIG, seed: 20_261_028 },
    )
    // El simulador sí ejerce la unión: sin esto la propiedad no probaría nada.
    expect(unidos).toBeGreaterThan(0)
  })
})
