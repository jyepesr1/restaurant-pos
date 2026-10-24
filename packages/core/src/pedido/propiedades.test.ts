import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { TIPOS_EVENTO_PEDIDO } from '../eventos/pedido'
import { barajar } from '../pruebas/congelar'
import { type Accion, accionArb, Servicio } from '../pruebas/simulador'
import { reconstruir } from './aplicar'
import type { EstadoPedido } from './estado'
import { saldoCuenta, totalesItem, totalesPedido } from './totales'

// Pruebas de propiedades del reductor sobre dos pedidos que se mueven ítems y se unen. Las
// identidades son las de docs/DINERO.md#día-operativo-e-informes. Semilla fija: mismos casos
// en cada corrida.

const secuencia = fc.array(accionArb, { minLength: 10, maxLength: 80, size: 'max' })
const CONFIG = { seed: 20_261_024, numRuns: 600 }

const suma = (valores: number[]) => valores.reduce((a, b) => a + b, 0)

/** Invariantes que debe cumplir cualquier estado, sea cual sea el camino que llevó a él. */
function verificarEstado(estado: EstadoPedido) {
  const t = totalesPedido(estado)

  // bruto − descuentos − anulaciones = neto, en el pedido y en cada línea.
  expect(t.bruto - t.descuento - t.anulado).toBe(t.neto)
  let netoLineas = 0
  for (const item of Object.values(estado.items)) {
    const ti = totalesItem(estado, item)
    expect(ti.bruto - ti.descuento - ti.anulado).toBe(ti.neto)
    expect(ti.neto, `la línea ${item.nombre} quedó con neto negativo`).toBeGreaterThanOrEqual(0)
    expect(item.cantidadAnulada).toBeLessThanOrEqual(item.cantidad)
    netoLineas += ti.neto
  }
  expect(netoLineas).toBe(t.neto)

  // Ningún descuento guarda un monto negativo.
  for (const descuento of Object.values(estado.descuentos)) {
    for (const monto of Object.values(descuento.montos)) expect(monto).toBeGreaterThanOrEqual(0)
  }

  // Nunca se cobra de más.
  expect(t.saldo).toBeGreaterThanOrEqual(0)
  for (const pago of Object.values(estado.pagos)) {
    expect(pago.reembolsadoVenta).toBeLessThanOrEqual(pago.monto)
    expect(pago.reembolsadoPropina).toBeLessThanOrEqual(pago.propina)
  }

  // Σ cobrado = Σ monto + Σ ajuste_redondeo, y un pedido cerrado cobró exactamente su neto.
  const vigentes = Object.values(estado.pagos).filter((p) => !p.anulado)
  const cobrado = suma(vigentes.map((p) => p.monto + p.ajusteRedondeo))
  expect(cobrado).toBe(
    suma(vigentes.map((p) => p.monto)) + suma(vigentes.map((p) => p.ajusteRedondeo)),
  )
  expect(t.pagado + suma(vigentes.map((p) => p.reembolsadoVenta)) + t.ajustes).toBe(cobrado)
  if (estado.estado === 'cerrado') {
    expect(t.saldo).toBe(0)
    expect(suma(vigentes.map((p) => p.monto - p.reembolsadoVenta))).toBe(t.neto)
    expect(estado.diaOperativo).not.toBeNull()
  }

  // Con la cuenta dividida, ninguna cuenta se sobrepaga y lo asignado cabe en el saldo.
  if (estado.cuentas) {
    let pendiente = 0
    for (const cuenta of estado.cuentas) {
      const saldo = saldoCuenta(estado, cuenta.id) ?? Number.NaN
      expect(saldo).toBeGreaterThanOrEqual(0)
      pendiente += saldo
    }
    expect(pendiente).toBeLessThanOrEqual(t.saldo)
  }
}

function ejecutar(acciones: Accion[], alCadaPaso?: (s: Servicio) => void): Servicio {
  const servicio = new Servicio()
  for (const accion of acciones) {
    servicio.paso(accion)
    for (const estado of servicio.estados) if (estado) verificarEstado(estado)
    alCadaPaso?.(servicio)
  }
  return servicio
}

describe('propiedades del reductor con dos pedidos', () => {
  it('identidades del informe, líneas sin neto negativo y conservación al mover y unir', () => {
    const vistos = new Set<string>()
    fc.assert(
      fc.property(secuencia, (acciones) => {
        const servicio = ejecutar(acciones)
        for (const tipo of servicio.tiposAplicados) vistos.add(tipo)

        expect(servicio.invalidos).toEqual([])

        // Σ cobrado de los pagos vigentes, recalculado desde los eventos aplicados.
        const pagosAplicados = new Map<string, number>()
        for (const e of servicio.aplicados) {
          if (e.tipo === 'PagoRegistrado') {
            pagosAplicados.set(e.datos.pago_id, e.datos.monto + e.datos.ajuste_redondeo)
          }
        }
        for (const e of servicio.aplicados) {
          if (e.tipo === 'PagoAnulado') pagosAplicados.delete(e.datos.pago_id)
        }
        const desdeEventos = suma([...pagosAplicados.values()])
        const desdeEstados = suma(
          servicio.estados.flatMap((estado) =>
            Object.values(estado?.pagos ?? {})
              .filter((pago) => !pago.anulado)
              .map((pago) => pago.monto + pago.ajusteRedondeo),
          ),
        )
        expect(desdeEstados).toBe(desdeEventos)

        for (const m of servicio.movimientos.filter((x) => x.tipo === 'ItemsMovidos')) {
          // Mover un ítem entre pedidos no crea ni destruye dinero: el total de los dos pedidos
          // (y su bruto y lo anulado) queda igual. Los descuentos impiden mover la línea.
          const antes = m.antes.map((e) => totalesPedido(e))
          const despues = m.despues.map((e) => totalesPedido(e))
          for (const campo of ['neto', 'bruto', 'anulado', 'descuento'] as const) {
            expect(suma(despues.map((t) => t[campo])), `ItemsMovidos cambió ${campo}`).toBe(
              suma(antes.map((t) => t[campo])),
            )
          }
        }
      }),
      CONFIG,
    )

    // El simulador ejerce todos los eventos salvo el de rescate, que crea otro pedido.
    const faltan = TIPOS_EVENTO_PEDIDO.filter(
      (tipo) => tipo !== 'PedidoRescateCreado' && !vistos.has(tipo),
    )
    expect(faltan).toEqual([])
  })

  it('unir conserva el total: lo del pedido origen llega entero al destino', () => {
    fc.assert(
      fc.property(secuencia, (acciones) => {
        const servicio = ejecutar(acciones)
        for (const m of servicio.movimientos.filter((x) => x.tipo === 'PedidosUnidos')) {
          const antes = m.antes.map((e) => totalesPedido(e))
          const despues = m.despues.map((e) => totalesPedido(e))
          expect(suma(despues.map((t) => t.neto)), 'PedidosUnidos no conservó el total').toBe(
            suma(antes.map((t) => t.neto)),
          )
          // El origen queda vacío y cancelado, sin pagos vigentes.
          expect(despues[m.origen]?.neto).toBe(0)
          expect(m.despues[m.origen]?.estado).toBe('cancelado')
        }
      }),
      { ...CONFIG, seed: 20_261_027 },
    )
  })

  it('el reductor no modifica nunca su entrada (estado y evento congelados en profundidad)', () => {
    fc.assert(
      fc.property(secuencia, (acciones) => {
        const servicio = ejecutar(acciones)
        // Un evento válido nunca se trata como inválido: si el reductor mutara su entrada
        // congelada lanzaría y aparecería aquí como `evento_invalido`.
        expect(servicio.invalidos).toEqual([])
        for (const estado of servicio.estados) {
          if (estado) expect(Object.isFrozen(estado)).toBe(true)
        }
      }),
      { ...CONFIG, seed: 20_261_025 },
    )
  })

  it('reconstruir con los eventos barajados o invertidos da el mismo estado que aplicarlos en orden', () => {
    fc.assert(
      fc.property(secuencia, fc.integer({ min: 0, max: 2 ** 31 }), (acciones, semilla) => {
        const servicio = ejecutar(acciones)
        const baraja = barajar(servicio.log, semilla)
        const invertido = [...servicio.log].reverse()

        for (const p of [0, 1] as const) {
          const id = servicio.pedidos[p]
          const enOrden = reconstruir(servicio.log, id)
          expect(enOrden).toEqual(servicio.estados[p])
          expect(reconstruir(baraja, id)).toEqual(enOrden)
          expect(reconstruir(invertido, id)).toEqual(enOrden)
        }
      }),
      { ...CONFIG, seed: 20_261_026 },
    )
  })
})
