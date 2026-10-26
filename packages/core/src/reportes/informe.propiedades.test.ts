import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { EventoPedido } from '../eventos/pedido'
import { reconstruir } from '../pedido/aplicar'
import type { EstadoPedido } from '../pedido/estado'
import { precioUnidad } from '../pedido/totales'
import { type Accion, accionArb, Servicio } from '../pruebas/simulador'
import { type EntradaInforme, informe } from './informe'

// Propiedades del informe (tarea 1.9, docs/KPIS.md) sobre historias al azar de dos pedidos (el
// simulador del reductor): pagos, anulaciones, descuentos, reembolsos, cierres y reaperturas.
// Las identidades son las de KPIS.md; el período se reparte entre tres días operativos. Semilla
// fija: mismos casos en cada corrida.

const secuencia = fc.array(accionArb, { minLength: 10, maxLength: 80, size: 'max' })
const CONFIG = { seed: 20_261_029, numRuns: 500 }

const DIAS = ['2026-10-23', '2026-10-24', '2026-10-25'] as const
const MESEROS = [
  '01JBAAAAAAAAAAAAAAAAAAAAA1',
  '01JBAAAAAAAAAAAAAAAAAAAAA2',
  '01JBAAAAAAAAAAAAAAAAAAAAA3',
]
const suma = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

const TIPOS_DEL_PERIODO = [
  'PagoRegistrado',
  'PagoAnulado',
  'ReembolsoRegistrado',
  'ItemAnulado',
  'PedidoCancelado',
]

const historia = fc.record({
  acciones: secuencia,
  /** Un día (0..2) y un mesero (0..2) por evento, según su posición. */
  azar: fc.array(fc.tuple(fc.nat(2), fc.nat(2)), { minLength: 1, maxLength: 200 }),
  modo: fc.constantFrom('mitad_arriba' as const, 'mitad_par' as const),
  porMesero: fc.constantFrom('quien_agrega' as const, 'mesero_asignado' as const),
  desde: fc.nat(2),
  largo: fc.nat(2),
})

type Historia = {
  servicio: Servicio
  estados: EstadoPedido[]
  eventos: EventoPedido[]
  /** Todos los eventos que el simulador aplicó, con los días y meseros ya repartidos. */
  config: EntradaInforme['config']
}

type Azar = {
  acciones: Accion[]
  azar: [number, number][]
  modo: 'mitad_arriba' | 'mitad_par'
  porMesero: 'quien_agrega' | 'mesero_asignado'
  desde: number
  largo: number
}

function armar(h: Azar): Historia {
  const servicio = new Servicio()
  for (const a of h.acciones) servicio.paso(a)
  const azar = (i: number) => h.azar[i % h.azar.length] ?? [1, 0]
  // Cada ítem lo agrega uno de tres meseros y cada pago, anulación o reembolso cae en un día.
  const log = servicio.log.map((e, i) =>
    e.tipo === 'ItemAgregado' ? ({ ...e, usuario_id: MESEROS[azar(i)[1]] } as EventoPedido) : e,
  )
  const estados = servicio.pedidos
    .map((id) => reconstruir(log, id))
    .filter((p): p is EstadoPedido => p !== null)
  const aplicados = new Set(servicio.aplicados.map((e) => e.id))
  const eventos = log
    .map((e, i) =>
      TIPOS_DEL_PERIODO.includes(e.tipo) ? { ...e, dia_operativo: DIAS[azar(i)[0]] as string } : e,
    )
    .filter((e) => aplicados.has(e.id)) as EventoPedido[]
  return {
    servicio,
    estados,
    eventos,
    config: { ventas_por_mesero: h.porMesero, redondeo_modo: h.modo },
  }
}

const entradaDe = (
  h: Historia,
  desde: string,
  hasta: string,
  cerrados: EstadoPedido[] = h.estados.filter((p) => p.estado === 'cerrado'),
): EntradaInforme => ({
  desde,
  hasta,
  cerrados,
  relacionados: h.estados,
  eventos: h.eventos,
  config: h.config,
})

/** Lo cobrado por medio en un período, calculado aparte directamente de los eventos. */
function oraculoPorMedio(eventos: readonly EventoPedido[], desde: string, hasta: string) {
  const pagos = new Map<string, { medio: string; propio: string; monto: number; propina: number }>()
  for (const e of eventos)
    if (e.tipo === 'PagoRegistrado')
      pagos.set(e.datos.pago_id, {
        medio: e.datos.medio,
        propio: e.datos.medio_propio_id ?? '',
        monto: e.datos.monto + e.datos.ajuste_redondeo,
        propina: e.datos.propina,
      })
  const total = new Map<string, { venta: number; propina: number; pagos: number }>()
  const sumar = (clave: string, venta: number, propina: number, pagos: number) => {
    const t = total.get(clave) ?? { venta: 0, propina: 0, pagos: 0 }
    t.venta += venta
    t.propina += propina
    t.pagos += pagos
    total.set(clave, t)
  }
  for (const e of eventos) {
    if (e.dia_operativo < desde || e.dia_operativo > hasta) continue
    if (e.tipo === 'PagoRegistrado') {
      const p = pagos.get(e.datos.pago_id)
      if (p) sumar(`${p.medio}:${p.propio}`, p.monto, p.propina, 1)
    } else if (e.tipo === 'PagoAnulado') {
      const p = pagos.get(e.datos.pago_id)
      if (p) sumar(`${p.medio}:${p.propio}`, -p.monto, -p.propina, -1)
    } else if (e.tipo === 'ReembolsoRegistrado') {
      const p = pagos.get(e.datos.pago_id)
      sumar(`${e.datos.medio}:${p?.propio ?? ''}`, -e.datos.monto_venta, -e.datos.monto_propina, 0)
    }
  }
  return new Map([...total].filter(([, t]) => t.venta !== 0 || t.propina !== 0 || t.pagos !== 0))
}

describe('informe: identidades de KPIS.md con historias al azar', () => {
  it('Σ neto por producto = neto, Σ neto por mesero = neto y base + impuesto = neto', () => {
    fc.assert(
      fc.property(historia, (h) => {
        const hist = armar(h)
        const r = informe(entradaDe(hist, DIAS[0], DIAS[2]))
        const { ventas } = r
        expect(suma(r.porProducto.map((p) => p.neto))).toBe(ventas.neto)
        expect(suma(r.porMesero.map((m) => m.neto))).toBe(ventas.neto)
        expect(suma(ventas.impuestos.map((i) => i.base + i.impuesto))).toBe(ventas.neto)
        for (const i of ventas.impuestos) {
          expect(i.impuesto).toBeGreaterThanOrEqual(0)
          expect(i.base).toBeGreaterThanOrEqual(0)
          expect(Number.isInteger(i.base) && Number.isInteger(i.impuesto)).toBe(true)
        }
        // bruto − anulado − descuentos = neto.
        expect(ventas.bruto - ventas.anulado - ventas.descuentos).toBe(ventas.neto)
      }),
      CONFIG,
    )
  })

  it('el neto es Σ (monto − reembolso de venta) de los pagos de los pedidos cerrados', () => {
    fc.assert(
      fc.property(historia, (h) => {
        const hist = armar(h)
        const cerrados = hist.estados.filter((p) => p.estado === 'cerrado')
        const r = informe(entradaDe(hist, DIAS[0], DIAS[2]))
        const pagos = cerrados.flatMap((p) => Object.values(p.pagos)).filter((p) => !p.anulado)
        expect(r.ventas.neto).toBe(suma(pagos.map((p) => p.monto - p.reembolsadoVenta)))
        expect(r.ventas.propinas).toBe(suma(pagos.map((p) => p.propina - p.reembolsadoPropina)))
        expect(r.ventas.comensales).toBe(suma(cerrados.map((p) => p.comensales)))
        expect(r.ventas.cuentas).toBeLessThanOrEqual(cerrados.length)
      }),
      { ...CONFIG, seed: 20_261_030 },
    )
  })

  it('ticket promedio y gasto por comensal: neto ÷ divisor en pesos enteros, 0 sin divisor', () => {
    fc.assert(
      fc.property(historia, (h) => {
        const hist = armar(h)
        const { ventas } = informe(entradaDe(hist, DIAS[0], DIAS[2]))
        for (const [valor, divisor] of [
          [ventas.ticketPromedio, ventas.cuentas],
          [ventas.gastoPorComensal, ventas.comensales],
        ] as const) {
          expect(Number.isInteger(valor)).toBe(true)
          if (divisor === 0) expect(valor).toBe(0)
          // El redondeo no se aparta más de medio peso del cociente exacto.
          else expect(Math.abs(valor * divisor - ventas.neto)).toBeLessThanOrEqual(divisor / 2)
        }
      }),
      { ...CONFIG, seed: 20_261_031 },
    )
  })

  it('por mesero: a quien agregó el ítem o, si así se configura, al mesero de la mesa', () => {
    fc.assert(
      fc.property(historia, (h) => {
        const hist = armar(h)
        const cerrados = hist.estados.filter((p) => p.estado === 'cerrado')
        const agrega = informe({
          ...entradaDe(hist, DIAS[0], DIAS[2]),
          config: { ...hist.config, ventas_por_mesero: 'quien_agrega' },
        })
        const asignado = informe({
          ...entradaDe(hist, DIAS[0], DIAS[2]),
          config: { ...hist.config, ventas_por_mesero: 'mesero_asignado' },
        })
        for (const m of agrega.porMesero) expect(MESEROS).toContain(m.usuarioId)
        const asignados = new Set(cerrados.map((p) => p.meseroAsignadoId))
        for (const m of asignado.porMesero) expect(asignados).toContain(m.usuarioId)
        for (const r of [agrega, asignado]) {
          expect(suma(r.porMesero.map((m) => m.neto))).toBe(r.ventas.neto)
          // Ordenado de más a menos neto, sin repetir mesero, y sin filas vacías.
          expect(new Set(r.porMesero.map((m) => m.usuarioId)).size).toBe(r.porMesero.length)
          for (const m of r.porMesero) {
            expect(m.neto !== 0 || m.cuentas > 0).toBe(true)
            expect(m.cuentas).toBeLessThanOrEqual(cerrados.length)
          }
          for (let i = 1; i < r.porMesero.length; i++)
            expect(r.porMesero[i - 1]?.neto ?? 0).toBeGreaterThanOrEqual(r.porMesero[i]?.neto ?? 0)
        }
        // Las dos formas de repartir suman lo mismo.
        expect(suma(agrega.porMesero.map((m) => m.neto))).toBe(
          suma(asignado.porMesero.map((m) => m.neto)),
        )
      }),
      { ...CONFIG, seed: 20_261_032, numRuns: 250 },
    )
  })

  it('por producto: las unidades son cantidad − anuladas y salen de más a menos neto', () => {
    fc.assert(
      fc.property(historia, (h) => {
        const hist = armar(h)
        const cerrados = hist.estados.filter((p) => p.estado === 'cerrado')
        const r = informe(entradaDe(hist, DIAS[0], DIAS[2]))
        const unidades = suma(
          cerrados.flatMap((p) =>
            Object.values(p.items).map((i) => i.cantidad - i.cantidadAnulada),
          ),
        )
        expect(suma(r.porProducto.map((p) => p.unidades))).toBe(unidades)
        for (let i = 1; i < r.porProducto.length; i++)
          expect(r.porProducto[i - 1]?.neto ?? 0).toBeGreaterThanOrEqual(
            r.porProducto[i]?.neto ?? 0,
          )
        for (const p of r.porProducto) expect(p.unidades).toBeGreaterThanOrEqual(0)
      }),
      { ...CONFIG, seed: 20_261_033, numRuns: 250 },
    )
  })

  it('el orden de los pedidos cerrados no cambia ningún total', () => {
    fc.assert(
      fc.property(historia, (h) => {
        const hist = armar(h)
        const cerrados = hist.estados.filter((p) => p.estado === 'cerrado')
        const a = informe(entradaDe(hist, DIAS[0], DIAS[2], cerrados))
        const b = informe(entradaDe(hist, DIAS[0], DIAS[2], [...cerrados].reverse()))
        expect(b.ventas.neto).toBe(a.ventas.neto)
        expect(b.ventas.bruto).toBe(a.ventas.bruto)
        expect(b.ventas.cuentas).toBe(a.ventas.cuentas)
        const clave = (x: { tipo: string; tarifa: number }) => `${x.tipo}:${x.tarifa}`
        expect(new Map(b.ventas.impuestos.map((i) => [clave(i), i.impuesto]))).toEqual(
          new Map(a.ventas.impuestos.map((i) => [clave(i), i.impuesto])),
        )
        expect(new Map(b.porMesero.map((m) => [m.usuarioId, m.neto]))).toEqual(
          new Map(a.porMesero.map((m) => [m.usuarioId, m.neto])),
        )
      }),
      { ...CONFIG, seed: 20_261_034, numRuns: 250 },
    )
  })
})

describe('informe: lo registrado en el período', () => {
  it('por medio coincide con lo que sale de sumar a mano los eventos del período', () => {
    fc.assert(
      fc.property(historia, (h) => {
        const hist = armar(h)
        const desde = DIAS[Math.min(h.desde, 2)] as string
        const hasta = DIAS[Math.min(h.desde + h.largo, 2)] as string
        const r = informe(entradaDe(hist, desde, hasta))
        const esperado = oraculoPorMedio(hist.eventos, desde, hasta)
        const obtenido = new Map(
          r.porMedio.map((m) => [
            `${m.medio}:${m.medioPropioId ?? ''}`,
            { venta: m.venta, propina: m.propina, pagos: m.pagos },
          ]),
        )
        expect(obtenido).toEqual(esperado)
        // El fondo de propinas son las propinas de todos los medios, netas de reembolsos.
        expect(r.fondoPropinas.propinas).toBe(suma(r.porMedio.map((m) => m.propina)))
        expect(r.fondoPropinas.saldo).toBe(r.fondoPropinas.propinas - r.fondoPropinas.pagadas)
      }),
      { ...CONFIG, seed: 20_261_035 },
    )
  })

  it('es aditivo: los tres días por separado suman lo del período completo', () => {
    fc.assert(
      fc.property(historia, (h) => {
        const hist = armar(h)
        const todo = informe(entradaDe(hist, DIAS[0], DIAS[2]))
        const dias = DIAS.map((d) => informe(entradaDe(hist, d, d)))
        const porClave = (r: ReturnType<typeof informe>) =>
          new Map(r.porMedio.map((m) => [`${m.medio}:${m.medioPropioId ?? ''}`, m]))
        const claves = new Set(dias.flatMap((r) => [...porClave(r).keys()]))
        for (const k of claves) {
          for (const campo of ['venta', 'propina', 'pagos'] as const)
            expect(suma(dias.map((r) => porClave(r).get(k)?.[campo] ?? 0))).toBe(
              porClave(todo).get(k)?.[campo] ?? 0,
            )
        }
        expect(suma(dias.map((r) => r.anulaciones.length))).toBe(todo.anulaciones.length)
        expect(suma(dias.map((r) => r.cancelaciones.length))).toBe(todo.cancelaciones.length)
        expect(suma(dias.map((r) => r.fondoPropinas.propinas))).toBe(todo.fondoPropinas.propinas)
        expect(suma(dias.map((r) => r.fondoPropinas.pagadas))).toBe(todo.fondoPropinas.pagadas)
      }),
      { ...CONFIG, seed: 20_261_036 },
    )
  })

  it('cada ItemAnulado y cada PedidoCancelado aplicados aparecen una vez, en su día', () => {
    fc.assert(
      fc.property(historia, (h) => {
        const hist = armar(h)
        const r = informe(entradaDe(hist, DIAS[0], DIAS[2]))
        const anulados = hist.eventos.filter((e) => e.tipo === 'ItemAnulado')
        const cancelados = hist.eventos.filter((e) => e.tipo === 'PedidoCancelado')
        expect(r.anulaciones.map((a) => a.eventoId)).toEqual(anulados.map((e) => e.id))
        expect(r.cancelaciones.map((c) => c.eventoId)).toEqual(cancelados.map((e) => e.id))
        // Un período sin ningún día de la historia queda vacío.
        const fuera = informe(entradaDe(hist, '2026-11-01', '2026-11-03'))
        expect(fuera.anulaciones).toEqual([])
        expect(fuera.cancelaciones).toEqual([])
        expect(fuera.porMedio).toEqual([])
        expect(fuera.fondoPropinas).toEqual({ propinas: 0, pagadas: 0, saldo: 0 })
      }),
      { ...CONFIG, seed: 20_261_037, numRuns: 250 },
    )
  })

  it('el valor de cada anulación es unidades × precio con extras de la línea', () => {
    fc.assert(
      fc.property(historia, (h) => {
        const hist = armar(h)
        const r = informe(entradaDe(hist, DIAS[0], DIAS[2]))
        for (const [i, a] of r.anulaciones.entries()) {
          const e = hist.eventos.filter((x) => x.tipo === 'ItemAnulado')[i]
          if (e?.tipo !== 'ItemAnulado') throw new Error('desorden')
          const item = hist.estados.map((p) => p.items[e.datos.item_id]).find(Boolean)
          expect(a.unidades).toBe(e.datos.cantidad)
          // Si el ítem sigue en algún pedido, el valor es el de su línea.
          if (item) expect(a.valor).toBe(e.datos.cantidad * precioUnidad(item))
        }
      }),
      { ...CONFIG, seed: 20_261_038, numRuns: 250 },
    )
  })
})

describe('informe: el generador de historias sí llega a todos los casos', () => {
  it('hay pedidos cerrados con neto, pagos, anulaciones, descuentos, reaperturas y cancelaciones', () => {
    const visto = {
      conNeto: 0,
      conPagos: 0,
      anulaciones: 0,
      descuentos: 0,
      reabiertos: 0,
      cancelaciones: 0,
      reembolsos: 0,
      variosMeseros: 0,
    }
    fc.assert(
      fc.property(historia, (h) => {
        const hist = armar(h)
        const r = informe(entradaDe(hist, DIAS[0], DIAS[2]))
        if (r.ventas.neto > 0) visto.conNeto += 1
        if (r.porMedio.length > 0) visto.conPagos += 1
        if (r.anulaciones.length > 0) visto.anulaciones += 1
        if (r.descuentos.length > 0) visto.descuentos += 1
        if (r.cancelaciones.length > 0) visto.cancelaciones += 1
        if (r.porMesero.length > 1) visto.variosMeseros += 1
        if (hist.eventos.some((e) => e.tipo === 'PedidoReabierto')) visto.reabiertos += 1
        if (hist.eventos.some((e) => e.tipo === 'ReembolsoRegistrado')) visto.reembolsos += 1
      }),
      { ...CONFIG, seed: 20_261_039 },
    )
    for (const [caso, n] of Object.entries(visto)) expect(n, caso).toBeGreaterThan(0)
  })
})
