import {
  chargedInCash,
  METHOD_NAME,
  newId,
  type OrderState,
  orderTotals,
  PaymentMethod,
  suggestedTip,
  validateNewEvent,
} from '@pos/core'
import type { Catalogo, EstadoLocal, EventoLocal } from '@pos/sync'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  enPartesIguales,
  lineasDe,
  methodName,
  nombreImpuesto,
  opcionesDeCobro,
  pagoEnEfectivo,
  porCobrar,
  porProductos,
  propinaConPorcentaje,
  propinaDePago,
  propinaParaEfectivo,
  propinaSugeridaDe,
  type ReglasCobro,
  recortarAsignaciones,
  reglasDe,
  resumenTurno,
  turnoDeCaja,
} from './cuentas'
import { pedidosAbiertos } from './proyeccion'
import { catalogoDePrueba, datosItem, inOrder, local, opening, TIME } from './pruebas'

// Precuenta, división, pagos y propina de la caja (tarea 1.6): cada monto sale de `@pos/core` con
// las reglas del restaurante (docs/DINERO.md). Aquí se prueba lo que arma `cuentas.ts`.

const REGLAS: ReglasCobro = {
  mediosPago: ['cash', 'card', 'nequi', 'daviplata', 'breb', 'transfer'],
  suggestedTip: 1000,
  redondeoModo: 'half_up',
  redondeoEfectivo: 100,
  cashRoundingMode: 'nearest_half_down',
  imprimePrecuenta: false,
}

const SHIFT = newId()
const pagoIdDe = (l: EventoLocal) => (l.event.data as { payment_id: string }).payment_id
const add = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)

/** Un contador de ids para que las pruebas de división sean legibles. */
const ids = () => {
  let n = 0
  return () => `check-${++n}`
}

/** Un pedido abierto con esos productos (precio × cantidad, al 8 %). */
function orderWith(
  products: { price: number; quantity?: number; name?: string; rate?: number }[],
  extra: EventoLocal[] = [],
): { id: string; status: OrderState; items: string[] } {
  const id = newId()
  const items = products.map((p) =>
    datosItem({
      unit_price: p.price,
      quantity: p.quantity ?? 1,
      name: p.name ?? 'Plato',
      rate: p.rate ?? 800,
    }),
  )
  const events = [
    local('OrderOpened', id, opening),
    ...items.map((i) => local('ItemAdded', id, i)),
    ...extra.map((e) => ({ ...e, event: { ...e.event, aggregate_id: id } })),
  ] as EventoLocal[]
  const visible = pedidosAbiertos(inOrder(events)).find((p) => p.status.id === id)
  if (!visible) throw new Error('sin pedido')
  return { id, status: visible.status, items: items.map((i) => i.item_id) }
}

/** El mismo pedido tras aplicar más eventos propios. */
function conEventos(id: string, base: EventoLocal[], more: EventoLocal[]): OrderState {
  const v = pedidosAbiertos(inOrder([...base, ...more])).find((p) => p.status.id === id)
  if (!v) throw new Error('sin pedido')
  return v.status
}

const pagoDatos = (fields: Record<string, unknown> = {}) => ({
  payment_id: newId(),
  check_id: null,
  register_shift_id: SHIFT,
  method: 'nequi' as const,
  amount: 1_000,
  tip: 0,
  tendered: null,
  change: null,
  rounding_adjustment: 0,
  rounding: null,
  cardTerminal: null,
  charge_reference: null,
  ...fields,
})

/** Un pedido de un plato con eventos propios (para pagos y divisiones). */
function pedidoDeUnPlato(price: number, more: (id: string) => EventoLocal[] = () => []) {
  const id = newId()
  const dish = datosItem({ unit_price: price })
  const base = [local('OrderOpened', id, opening), local('ItemAdded', id, dish)] as EventoLocal[]
  const events = [...base, ...more(id)]
  const v = pedidosAbiertos(inOrder(events)).find((p) => p.status.id === id)
  if (!v) throw new Error('sin pedido')
  return { id, status: v.status, base, dish, events }
}

describe('reglasDe, nombres y formato', () => {
  it('un catálogo sin cobro (hub de antes de la 1.6) o sin catálogo no tiene reglas', () => {
    expect(reglasDe(null)).toBeNull()
    expect(reglasDe(catalogoDePrueba())).toBeNull()
  })

  it('con cobro devuelve las reglas tal cual', () => {
    const catalog: Catalogo = catalogoDePrueba()
    catalog.restaurant.checkout = REGLAS
    expect(reglasDe(catalog)).toBe(REGLAS)
  })

  it('cada medio de pago tiene su nombre en español', () => {
    expect(Object.keys(METHOD_NAME).sort()).toEqual([...PaymentMethod.options].sort())
    expect(METHOD_NAME.nequi).toBe('Nequi')
    expect(METHOD_NAME.breb).toBe('Bre-B')
    for (const name of Object.values(METHOD_NAME)) expect(name.length).toBeGreaterThan(2)
  })

  it('nombreImpuesto: INC, IVA y exento', () => {
    expect(nombreImpuesto('inc', 800)).toBe('INC 8 %')
    expect(nombreImpuesto('iva', 1900)).toBe('IVA 19 %')
    expect(nombreImpuesto('iva', 550)).toBe('IVA 5,5 %')
    expect(nombreImpuesto('exempt', 0)).toBe('Exento')
    expect(nombreImpuesto('inc', 0)).toBe('Exento')
  })
})

describe('propinaSugeridaDe y propinaParaEfectivo', () => {
  it('es la propina del pedido: 100.000 al 8 % → 9.259; un monto de 0 o menos, 0', () => {
    const { status } = orderWith([{ price: 100_000 }])
    expect(propinaSugeridaDe(status, 100_000, REGLAS)).toBe(9_259)
    expect(propinaSugeridaDe(status, 0, REGLAS)).toBe(0)
    expect(propinaSugeridaDe(status, -5, REGLAS)).toBe(0)
  })

  it('sigue la tasa del restaurante: 0 % no sugiere nada', () => {
    const { status } = orderWith([{ price: 100_000 }])
    expect(propinaSugeridaDe(status, 100_000, { ...REGLAS, suggestedTip: 0 })).toBe(0)
    expect(propinaSugeridaDe(status, 100_000, { ...REGLAS, suggestedTip: 500 })).toBe(4_630)
  })

  it.each([
    [23_843, 23_800],
    [23_850, 23_800],
    [23_851, 23_900],
    [23_800, 23_800],
    [0, 0],
    [49, 0],
    [50, 0],
    [51, 100],
  ])(
    'en efectivo la propina %i se sugiere redondeada a %i (múltiplo 100, mitad hacia el cliente)',
    (tip, expected) => {
      expect(propinaParaEfectivo(tip, REGLAS)).toBe(expected)
    },
  )

  it('con otro múltiplo o modo del restaurante', () => {
    expect(propinaParaEfectivo(23_843, { ...REGLAS, redondeoEfectivo: 50 })).toBe(23_850)
    expect(propinaParaEfectivo(23_843, { ...REGLAS, redondeoEfectivo: 1 })).toBe(23_843)
    expect(propinaParaEfectivo(23_843, { ...REGLAS, cashRoundingMode: 'up' })).toBe(23_900)
    expect(propinaParaEfectivo(23_843, { ...REGLAS, cashRoundingMode: 'down' })).toBe(23_800)
  })
})

describe('propinaDePago: los pagos parciales suman la propina entera', () => {
  it('100.000: 30.000 + 70.000 dan 2.778 + 6.481 = 9.259', () => {
    const { status } = orderWith([{ price: 100_000 }])
    const a = propinaDePago(status, null, 100_000, 30_000, REGLAS)
    const b = propinaDePago(status, null, 70_000, 70_000, REGLAS)
    expect([a, b]).toEqual([2_778, 6_481])
    expect(a + b).toBe(propinaSugeridaDe(status, 100_000, REGLAS))
  })

  it('valor 0, negativo o mayor que lo disponible: 0', () => {
    const { status } = orderWith([{ price: 100_000 }])
    expect(propinaDePago(status, null, 100_000, 0, REGLAS)).toBe(0)
    expect(propinaDePago(status, null, 100_000, -1, REGLAS)).toBe(0)
    expect(propinaDePago(status, null, 100_000, 100_001, REGLAS)).toBe(0)
  })

  it('pagar todo lo disponible lleva la propina de todo lo disponible', () => {
    const { status } = orderWith([{ price: 100_000 }])
    expect(propinaDePago(status, null, 60_000, 60_000, REGLAS)).toBe(5_556)
  })

  it('en una cuenta dividida usa la propina fijada al dividir (4.630 de 50.000)', () => {
    const { status } = orderWith([{ price: 100_000 }])
    const check = { amount: 50_000, suggestedTip: 4_630 }
    expect(propinaDePago(status, check, 50_000, 50_000, REGLAS)).toBe(4_630)
    const a = propinaDePago(status, check, 50_000, 20_000, REGLAS)
    const b = propinaDePago(status, check, 30_000, 30_000, REGLAS)
    expect(a + b).toBe(4_630)
  })

  it('propiedad: cualquier reparto del saldo en pagos suma la propina del saldo', () => {
    const { status } = orderWith([{ price: 87_650 }, { price: 12_300, quantity: 3 }])
    const balance = orderTotals(status).balance
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 6 }),
        (pesosRelativos) => {
          const total = add(pesosRelativos)
          // Partes enteras que suman el saldo (la última se lleva el resto).
          const parts = pesosRelativos.map((p) => Math.floor((balance * p) / total))
          parts[parts.length - 1] = (parts.at(-1) ?? 0) + (balance - add(parts))
          let available = balance
          let sum = 0
          for (const share of parts) {
            if (share <= 0) continue
            sum += propinaDePago(status, null, available, share, REGLAS)
            available -= share
          }
          expect(sum).toBe(propinaSugeridaDe(status, balance, REGLAS))
        },
      ),
      { seed: 16, numRuns: 200 },
    )
  })
})

describe('lineasDe: lo que sigue en pie', () => {
  it('en el orden en que se pidió, con opciones y neto', () => {
    const { status } = orderWith([
      { price: 40_900, name: 'Margarita', quantity: 2 },
      { price: 58_900, name: 'Tagliata' },
    ])
    expect(lineasDe(status).map((l) => [l.name, l.quantity, l.net])).toEqual([
      ['Margarita', 2, 81_800],
      ['Tagliata', 1, 58_900],
    ])
  })

  it('un pedido sin productos no tiene líneas', () => {
    expect(lineasDe(orderWith([]).status)).toEqual([])
  })
})

describe('enPartesIguales', () => {
  it('100.000 en 3: 33.334 + 33.333 + 33.333, con sus nombres y sin productos fijos', () => {
    const { status } = orderWith([{ price: 100_000 }])
    const checks = enPartesIguales(status, 3, REGLAS, ids())
    expect(checks.map((c) => c.amount)).toEqual([33_334, 33_333, 33_333])
    expect(checks.map((c) => c.name)).toEqual(['Persona 1', 'Persona 2', 'Persona 3'])
    expect(checks.map((c) => c.check_id)).toEqual(['check-1', 'check-2', 'check-3'])
    for (const c of checks) expect(c.items).toEqual([])
  })

  it('las propinas suman la del saldo repartida por mayor residuo (9.259 en 3)', () => {
    const { status } = orderWith([{ price: 100_000 }])
    const checks = enPartesIguales(status, 3, REGLAS, ids())
    expect(add(checks.map((c) => c.suggested_tip))).toBe(9_259)
    expect(checks.map((c) => c.suggested_tip)).toEqual([3_087, 3_086, 3_086])
  })

  it('con $40.000 ya pagados: el saldo de $60.000 en 2 → 30.000 + 30.000 y propinas 2.778 + 2.778', () => {
    const p = pedidoDeUnPlato(100_000, (id) => [
      local('PaymentRecorded', id, pagoDatos({ amount: 40_000 })),
    ])
    const checks = enPartesIguales(p.status, 2, REGLAS, ids())
    expect(checks.map((c) => c.amount)).toEqual([30_000, 30_000])
    expect(checks.map((c) => c.suggested_tip)).toEqual([2_778, 2_778])
  })

  it('más personas que pesos: 2 pesos en 3 → 1 + 1 + 0, sin montos negativos', () => {
    const { status } = orderWith([{ price: 2 }])
    const checks = enPartesIguales(status, 3, REGLAS, ids())
    expect(checks.map((c) => c.amount)).toEqual([1, 1, 0])
  })

  it('un saldo de 0 (todo pagado) da cuentas en 0 y propinas en 0, sin lanzar', () => {
    const p = pedidoDeUnPlato(40_000, (id) => [
      local('PaymentRecorded', id, pagoDatos({ amount: 40_000 })),
    ])
    const checks = enPartesIguales(p.status, 2, REGLAS, ids())
    expect(checks.map((c) => [c.amount, c.suggested_tip])).toEqual([
      [0, 0],
      [0, 0],
    ])
  })

  it('sin propina sugerida en el restaurante, las cuentas llevan 0', () => {
    const { status } = orderWith([{ price: 100_000 }])
    const checks = enPartesIguales(status, 4, { ...REGLAS, suggestedTip: 0 }, ids())
    expect(checks.map((c) => c.suggested_tip)).toEqual([0, 0, 0, 0])
  })

  it('la división pasa el esquema de CuentaDividida y el reductor la acepta, y las cuentas suman el saldo', () => {
    const { id, status, base } = pedidoDeUnPlato(100_000)
    const checks = enPartesIguales(status, 3, REGLAS, newId)
    const event = local('CheckSplit', id, { checks })
    expect(validateNewEvent(sinHub(event)).ok).toBe(true)
    const after = conEventos(id, base, [event])
    expect(after.checks?.map((c) => c.amount)).toEqual([33_334, 33_333, 33_333])
    expect(add(after.checks?.map((c) => c.amount) ?? [])).toBe(orderTotals(after).balance)
  })

  it('propiedad: Σ montos = saldo, Σ propinas = propina del saldo, nada negativo', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            price: fc.integer({ min: 0, max: 300_000 }),
            quantity: fc.integer({ min: 1, max: 5 }),
            rate: fc.constantFrom(0, 800, 1900),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        fc.integer({ min: 2, max: 12 }),
        fc.integer({ min: 0, max: 1000 }),
        (products, people, tipRate) => {
          const { status } = orderWith(products)
          const reglas = { ...REGLAS, suggestedTip: tipRate }
          const balance = orderTotals(status).balance
          const checks = enPartesIguales(status, people, reglas, newId)
          expect(add(checks.map((c) => c.amount))).toBe(balance)
          expect(add(checks.map((c) => c.suggested_tip))).toBe(
            propinaSugeridaDe(status, balance, reglas),
          )
          for (const c of checks) {
            expect(c.amount).toBeGreaterThanOrEqual(0)
            expect(c.suggested_tip).toBeGreaterThanOrEqual(0)
          }
          const mayor = Math.max(...checks.map((c) => c.amount))
          const menor = Math.min(...checks.map((c) => c.amount))
          expect(mayor - menor).toBeLessThanOrEqual(1)
        },
      ),
      { seed: 17, numRuns: 150 },
    )
  })
})

/** El evento como lo crea el dispositivo (sin lo que agrega el hub), para el esquema. */
function sinHub(l: EventoLocal) {
  const {
    sequence: _s,
    received_at: _r,
    business_day: _d,
    assignments: _a,
    affects: _f,
    authorized_by_id: _p,
    ...fresh
  } = l.event as unknown as Record<string, unknown>
  return fresh
}

function estadoConAnulado(
  p: ReturnType<typeof pedidoDeUnPlato>,
  other: ReturnType<typeof datosItem>,
) {
  return conEventos(
    p.id,
    [...p.base, local('ItemAdded', p.id, other)],
    [
      local('ItemsSent', p.id, {
        tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [other.item_id] }],
      }),
      local(
        'ItemVoided',
        p.id,
        { item_id: other.item_id, quantity: 1, already_prepared: false, ticket_id: null },
        'confirmed',
        { reason: 'Error' },
      ),
    ],
  )
}

describe('porProductos', () => {
  it('cada producto a su cuenta: montos, fracciones enteras y nada sin asignar', () => {
    const { status, items } = orderWith([{ price: 40_000 }, { price: 60_000 }])
    const r = porProductos(
      status,
      new Map([
        [items[0] as string, [0]],
        [items[1] as string, [1]],
      ]),
      2,
      REGLAS,
      ids(),
    )
    expect(r.unassigned).toBe(0)
    expect(r.checks.map((c) => c.amount)).toEqual([40_000, 60_000])
    expect(r.checks.map((c) => c.name)).toEqual(['Cuenta 1', 'Cuenta 2'])
    expect(r.checks[0]?.items).toEqual([{ item_id: items[0], fraction: { n: 1, d: 1 } }])
    expect(add(r.checks.map((c) => c.suggested_tip))).toBe(
      propinaSugeridaDe(status, 100_000, REGLAS),
    )
  })

  it('un producto compartido entre 3 se reparte por mayor residuo con fracción 1/3 en cada cuenta', () => {
    const { status, items } = orderWith([{ price: 100_000, name: 'Botella' }])
    const r = porProductos(status, new Map([[items[0] as string, [0, 1, 2]]]), 3, REGLAS, ids())
    expect(r.checks.map((c) => c.amount)).toEqual([33_334, 33_333, 33_333])
    for (const c of r.checks) expect(c.items[0]?.fraction).toEqual({ n: 1, d: 3 })
    expect(r.unassigned).toBe(0)
  })

  it('un producto compartido por dos cuentas (1/2) y otro de una sola', () => {
    const { status, items } = orderWith([{ price: 50_001 }, { price: 20_000 }])
    const r = porProductos(
      status,
      new Map([
        [items[0] as string, [0, 1]],
        [items[1] as string, [1]],
      ]),
      2,
      REGLAS,
      ids(),
    )
    expect(r.checks.map((c) => c.amount)).toEqual([25_001, 45_000])
    expect(r.checks[1]?.items.map((i) => i.fraction)).toEqual([
      { n: 1, d: 2 },
      { n: 1, d: 1 },
    ])
  })

  it('nada asignado: todo queda sin asignar, las cuentas en 0 y sin propina', () => {
    const { status } = orderWith([{ price: 40_000 }, { price: 60_000 }])
    const r = porProductos(status, new Map(), 3, REGLAS, ids())
    expect(r.unassigned).toBe(100_000)
    expect(r.checks.map((c) => [c.amount, c.suggested_tip, c.items])).toEqual([
      [0, 0, []],
      [0, 0, []],
      [0, 0, []],
    ])
  })

  it('lo que nadie toma queda sin asignar y sus montos no entran en la propina de las cuentas', () => {
    const { status, items } = orderWith([{ price: 40_000 }, { price: 60_000 }])
    const r = porProductos(status, new Map([[items[0] as string, [0]]]), 2, REGLAS, ids())
    expect(r.unassigned).toBe(60_000)
    expect(r.checks.map((c) => c.amount)).toEqual([40_000, 0])
    expect(add(r.checks.map((c) => c.suggested_tip))).toBe(
      propinaSugeridaDe(status, 40_000, REGLAS),
    )
  })

  it('cuentas recortadas: lo asignado a una cuenta que ya no existe se ignora', () => {
    const { status, items } = orderWith([{ price: 40_000 }, { price: 60_000 }])
    const r = porProductos(
      status,
      new Map([
        [items[0] as string, [0, 3]],
        [items[1] as string, [4]],
      ]),
      2,
      REGLAS,
      ids(),
    )
    // El primero queda solo en la cuenta 0 (fracción 1/1); el segundo, sin dueño.
    expect(r.checks.map((c) => c.amount)).toEqual([40_000, 0])
    expect(r.checks[0]?.items).toEqual([{ item_id: items[0], fraction: { n: 1, d: 1 } }])
    expect(r.unassigned).toBe(60_000)
  })

  it('un producto anulado que no está asignado no entra en la división', () => {
    const p = pedidoDeUnPlato(40_000)
    const other = datosItem({ unit_price: 10_000 })
    const status = estadoConAnulado(p, other)
    const r = porProductos(status, new Map([[p.dish.item_id, [0]]]), 2, REGLAS, ids())
    expect(r.checks.map((c) => c.amount)).toEqual([40_000, 0])
    expect(r.unassigned).toBe(0)
  })

  // BUG: si un producto se anula (otro equipo) después de que el cajero lo asignó a una cuenta, la
  // asignación sigue en el mapa y `splitByItems` lanza «El ítem … no está en el pedido».
  // apps/pos/src/sala/cuentas.ts, porProductos: las asignaciones no se filtran por `lineasDe`.
  it('un producto asignado que luego se anula no rompe la división', () => {
    const p = pedidoDeUnPlato(40_000)
    const other = datosItem({ unit_price: 10_000 })
    const status = estadoConAnulado(p, other)
    const r = porProductos(
      status,
      new Map([
        [p.dish.item_id, [0]],
        [other.item_id, [1]],
      ]),
      2,
      REGLAS,
      ids(),
    )
    expect(r.checks.map((c) => c.amount)).toEqual([40_000, 0])
  })

  it('el resultado pasa el esquema de CuentaDividida y el reductor lo acepta', () => {
    const p = pedidoDeUnPlato(90_000)
    const other = datosItem({ unit_price: 30_000 })
    const base = [...p.base, local('ItemAdded', p.id, other)]
    const status = conEventos(p.id, base, [])
    const r = porProductos(
      status,
      new Map([
        [p.dish.item_id, [0, 1, 2]],
        [other.item_id, [2]],
      ]),
      3,
      REGLAS,
      newId,
    )
    const event = local('CheckSplit', p.id, { checks: r.checks })
    expect(validateNewEvent(sinHub(event)).ok).toBe(true)
    const after = conEventos(p.id, base, [event])
    expect(after.checks?.map((c) => c.amount)).toEqual([30_000, 30_000, 60_000])
  })

  it('propiedad: Σ montos + sin asignar = total de las líneas, y las fracciones de un producto no pasan de 1', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 200_000 }), { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 2, max: 5 }),
        fc.array(fc.array(fc.integer({ min: 0, max: 6 }), { maxLength: 4 }), {
          minLength: 5,
          maxLength: 5,
        }),
        (prices, checks, reparto) => {
          const { status, items } = orderWith(prices.map((price) => ({ price })))
          const asignadas = new Map(
            items.map((id, i) => [id, [...new Set(reparto[i] ?? [])]] as const),
          )
          const r = porProductos(status, asignadas, checks, REGLAS, newId)
          expect(add(r.checks.map((c) => c.amount)) + r.unassigned).toBe(add(prices))
          for (const c of r.checks) expect(c.amount).toBeGreaterThanOrEqual(0)
          const byItem = new Map<string, number>()
          for (const c of r.checks)
            for (const i of c.items)
              byItem.set(i.item_id, (byItem.get(i.item_id) ?? 0) + i.fraction.n / i.fraction.d)
          for (const total of byItem.values()) expect(total).toBeLessThanOrEqual(1 + 1e-9)
          const event = local('CheckSplit', status.id, { checks: r.checks })
          expect(validateNewEvent(sinHub(event)).ok).toBe(true)
        },
      ),
      { seed: 18, numRuns: 150 },
    )
  })
})

describe('recortarAsignaciones', () => {
  it('quita las cuentas que ya no existen y los productos que quedan sin ninguna', () => {
    const asignadas = new Map<string, readonly number[]>([
      ['a', [0, 1, 2]],
      ['b', [2]],
      ['c', [1]],
    ])
    const r = recortarAsignaciones(asignadas, 2)
    expect([...r]).toEqual([
      ['a', [0, 1]],
      ['c', [1]],
    ])
    // No toca el mapa original.
    expect(asignadas.get('a')).toEqual([0, 1, 2])
  })

  it('con cuentas de sobra no cambia nada, y con 0 cuentas queda vacío', () => {
    const asignadas = new Map<string, readonly number[]>([['a', [0, 1]]])
    expect([...recortarAsignaciones(asignadas, 5)]).toEqual([['a', [0, 1]]])
    expect(recortarAsignaciones(asignadas, 0).size).toBe(0)
  })
})

describe('pagoEnEfectivo: los ejemplos de docs/DINERO.md', () => {
  const cobra = (
    balance: number,
    tendered: number,
    extra: Partial<{ amount: number; tip: number }> = {},
  ) =>
    pagoEnEfectivo(
      { balance, amount: extra.amount ?? balance, tip: extra.tip ?? 0, tendered },
      REGLAS,
    )
  const REDONDEO = { multiple: 100, mode: 'nearest_half_down' }

  it.each([
    // saldo, recibido, cobrado, ajuste, cambio
    [36_810, 40_000, 36_800, -10, 3_200],
    [36_850, 40_000, 36_800, -50, 3_200],
    [36_851, 40_000, 36_900, 49, 3_100],
    [36_860, 50_000, 36_900, 40, 13_100],
    [36_800, 36_800, 36_800, 0, 0],
  ])(
    'saldo %i, el cliente da %i → cobra %i, ajuste %i, cambio %i',
    (balance, tendered, charged, adjustment, change) => {
      const c = cobra(balance, tendered)
      expect(c).toMatchObject({ charged, adjustment, change, missing: 0, aEntregar: charged })
      expect(c.rounding).toEqual(adjustment === 0 ? null : REDONDEO)
    },
  )

  it('el cobro con ajuste es el mismo del núcleo (cobradoEnEfectivo)', () => {
    for (const balance of [36_810, 36_850, 36_851, 36_860, 36_800, 1, 49, 50, 51, 99, 100])
      expect(cobra(balance, balance + 1_000_000).charged).toBe(chargedInCash(balance, 100))
  })

  it('pago parcial: se cobra el monto exacto, sin redondeo ni regla en el evento', () => {
    const c = pagoEnEfectivo({ balance: 100_000, amount: 36_851, tip: 0, tendered: 40_000 }, REGLAS)
    expect(c).toMatchObject({
      charged: 36_851,
      adjustment: 0,
      change: 3_149,
      missing: 0,
      rounding: null,
    })
  })

  it('un monto un peso menos que el saldo ya es parcial: sin redondeo', () => {
    const c = pagoEnEfectivo({ balance: 36_851, amount: 36_850, tip: 0, tendered: 36_850 }, REGLAS)
    expect(c).toMatchObject({ charged: 36_850, adjustment: 0, rounding: null })
  })

  it('el saldo de medio múltiplo o menos se cobra en $0 con ajuste negativo', () => {
    expect(cobra(30, 0)).toMatchObject({
      charged: 0,
      adjustment: -30,
      aEntregar: 0,
      change: 0,
      missing: 0,
    })
    expect(cobra(50, 0)).toMatchObject({ charged: 0, adjustment: -50, rounding: REDONDEO })
    expect(cobra(51, 100)).toMatchObject({ charged: 100, adjustment: 49 })
  })

  it('después de pagar con tarjeta: saldo de $30 en efectivo, la propina sí se entrega', () => {
    const c = cobra(30, 3_000, { tip: 3_000 })
    expect(c).toMatchObject({ charged: 0, adjustment: -30, aEntregar: 3_000, change: 0 })
  })

  it('saldo múltiplo de medio múltiplo exacto (150) y saldo 0 con monto 0 es un error', () => {
    expect(cobra(150, 200)).toMatchObject({ charged: 100, adjustment: -50 })
    expect(() => cobra(0, 0)).toThrow(RangeError)
  })

  it('la propina se suma a lo que entrega el cliente; el cambio que sobra se calcula sobre el total', () => {
    const c = cobra(36_810, 50_000, { tip: 3_000 })
    expect(c).toMatchObject({ charged: 36_800, aEntregar: 39_800, change: 10_200, missing: 0 })
  })

  it('si lo recibido no alcanza: falta lo que falta y el cambio es 0', () => {
    expect(cobra(36_810, 30_000)).toMatchObject({ missing: 6_800, change: 0 })
    expect(cobra(36_810, 36_799)).toMatchObject({ missing: 1, change: 0 })
    expect(cobra(36_810, 36_800)).toMatchObject({ missing: 0, change: 0 })
  })

  it('rechaza monto 0, monto mayor que el saldo, decimales y negativos', () => {
    const base = { balance: 36_810, amount: 36_810, tip: 0, tendered: 40_000 }
    expect(() => pagoEnEfectivo({ ...base, amount: 0 }, REGLAS)).toThrow(RangeError)
    expect(() => pagoEnEfectivo({ ...base, amount: 36_811 }, REGLAS)).toThrow(RangeError)
    expect(() => pagoEnEfectivo({ ...base, amount: 1.5 }, REGLAS)).toThrow()
    expect(() => pagoEnEfectivo({ ...base, tip: -1 }, REGLAS)).toThrow()
    expect(() => pagoEnEfectivo({ ...base, tendered: Number.NaN }, REGLAS)).toThrow()
    expect(() => pagoEnEfectivo({ ...base, balance: -5 }, REGLAS)).toThrow()
  })

  it.each([
    ['nearest_half_up', 50, 36_825, 36_850, 25],
    ['down', 100, 36_899, 36_800, -99],
    ['up', 100, 36_801, 36_900, 99],
  ] as const)(
    'modo %s con múltiplo %i: saldo %i → cobra %i (ajuste %i)',
    (mode, multiple, balance, charged, adjustment) => {
      const c = pagoEnEfectivo(
        { balance, amount: balance, tip: 0, tendered: 1_000_000 },
        { ...REGLAS, redondeoEfectivo: multiple, cashRoundingMode: mode },
      )
      expect(c).toMatchObject({ charged, adjustment, rounding: { multiple, mode } })
    },
  )

  it('con múltiplo 1 nunca hay ajuste ni regla en el evento', () => {
    const c = pagoEnEfectivo(
      { balance: 36_851, amount: 36_851, tip: 0, tendered: 36_851 },
      { ...REGLAS, redondeoEfectivo: 1 },
    )
    expect(c).toMatchObject({ charged: 36_851, adjustment: 0, rounding: null })
  })

  it('propiedad: recibido = monto + ajuste + propina + cambio cuando alcanza, y el ajuste es menor que el múltiplo', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 50_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.constantFrom(1, 50, 100, 500, 1000),
        fc.constantFrom('nearest_half_down', 'nearest_half_up', 'down', 'up'),
        (balance, fraction, tip, extra, multiple, mode) => {
          const amount = Math.max(1, Math.floor(balance * fraction))
          const reglas = { ...REGLAS, redondeoEfectivo: multiple, cashRoundingMode: mode }
          const base = pagoEnEfectivo({ balance, amount, tip, tendered: 0 }, reglas)
          const tendered = base.aEntregar + extra
          const c = pagoEnEfectivo({ balance, amount, tip, tendered }, reglas)
          expect(c.missing).toBe(0)
          expect(tendered).toBe(amount + c.adjustment + tip + c.change)
          expect(Math.abs(c.adjustment)).toBeLessThan(multiple)
          if (amount < balance) expect(c.adjustment).toBe(0)
          // La regla viaja solo cuando hay un ajuste que explicar.
          expect(c.rounding === null).toBe(c.adjustment === 0)
          expect(c.change).toBe(extra)
        },
      ),
      { seed: 19, numRuns: 300 },
    )
  })
})

describe('porCobrar', () => {
  it('sin división: el saldo del pedido, sin cuentas ni sin asignar', () => {
    const { status } = orderWith([{ price: 100_000 }])
    expect(porCobrar(status)).toEqual({ balance: 100_000, checks: [], unassigned: 0 })
  })

  it('con pagos previos y sin división: el saldo baja', () => {
    const p = pedidoDeUnPlato(100_000, (id) => [
      local('PaymentRecorded', id, pagoDatos({ amount: 40_000 })),
    ])
    expect(porCobrar(p.status)).toMatchObject({ balance: 60_000, checks: [], unassigned: 0 })
  })

  function divided(amounts: number[], payments: { check: number; amount: number }[] = []) {
    const p = pedidoDeUnPlato(100_000)
    const checks = amounts.map((amount, i) => ({
      check_id: newId(),
      name: `Cuenta ${i + 1}`,
      amount,
      suggested_tip: Math.round(amount * 0.0926),
      items: [],
    }))
    const division = local('CheckSplit', p.id, { checks })
    const pagosEv = payments.map((x) =>
      local(
        'PaymentRecorded',
        p.id,
        pagoDatos({ check_id: checks[x.check]?.check_id, amount: x.amount }),
      ),
    )
    return { ...p, checks, status: conEventos(p.id, p.base, [division, ...pagosEv]) }
  }

  it('cada cuenta con su saldo y la propina pendiente, y nada sin asignar si suman el total', () => {
    const d = divided([60_000, 40_000])
    const r = porCobrar(d.status)
    expect(r.balance).toBe(100_000)
    expect(r.unassigned).toBe(0)
    expect(r.checks.map((c) => [c.name, c.amount, c.balance])).toEqual([
      ['Cuenta 1', 60_000, 60_000],
      ['Cuenta 2', 40_000, 40_000],
    ])
    for (const c of r.checks) expect(c.propinaPendiente).toBe(c.suggestedTip)
  })

  it('una cuenta pagada del todo queda en saldo 0 y propina pendiente 0', () => {
    const d = divided([60_000, 40_000], [{ check: 0, amount: 60_000 }])
    const r = porCobrar(d.status)
    expect(r.checks[0]).toMatchObject({ balance: 0, propinaPendiente: 0 })
    expect(r.checks[1]).toMatchObject({ balance: 40_000 })
    expect(r.balance).toBe(40_000)
    expect(r.unassigned).toBe(0)
  })

  it('una cuenta pagada en parte conserva la parte proporcional de su propina', () => {
    const d = divided([60_000, 40_000], [{ check: 0, amount: 20_000 }])
    const c = porCobrar(d.status).checks[0]
    expect(c).toMatchObject({ balance: 40_000 })
    expect(c?.propinaPendiente).toBeGreaterThan(0)
    expect(c?.propinaPendiente).toBeLessThan(c?.suggestedTip ?? 0)
  })

  it('lo que no quedó en ninguna cuenta aparece como sin asignar (división por monto libre)', () => {
    const d = divided([30_000, 30_000])
    const r = porCobrar(d.status)
    expect(r.balance).toBe(100_000)
    expect(r.unassigned).toBe(40_000)
  })

  it('lo agregado después de dividir va a sin asignar', () => {
    const d = divided([60_000, 40_000])
    const extra = datosItem({ unit_price: 10_000 })
    const status = conEventos(
      d.id,
      [...d.base],
      [local('CheckSplit', d.id, { checks: d.checks }), local('ItemAdded', d.id, extra)],
    )
    const r = porCobrar(status)
    expect(r.balance).toBe(110_000)
    expect(r.unassigned).toBe(10_000)
  })

  it('un pago en la cuenta general (antes de dividir) baja el saldo y se descuenta de lo sin asignar', () => {
    const p = pedidoDeUnPlato(100_000)
    const checks = [
      { check_id: newId(), name: 'A', amount: 30_000, suggested_tip: 2_778, items: [] },
      { check_id: newId(), name: 'B', amount: 30_000, suggested_tip: 2_778, items: [] },
    ]
    const status = conEventos(p.id, p.base, [
      local('PaymentRecorded', p.id, pagoDatos({ amount: 40_000 })),
      local('CheckSplit', p.id, { checks }),
    ])
    expect(porCobrar(status)).toMatchObject({ balance: 60_000, unassigned: 0 })
  })

  it('la suma de saldos de las cuentas más lo sin asignar es el saldo del pedido', () => {
    const d = divided([25_000, 25_000], [{ check: 1, amount: 5_000 }])
    const r = porCobrar(d.status)
    expect(add(r.checks.map((c) => c.balance)) + r.unassigned).toBe(r.balance)
  })
})

// ── Turno y resumen ──────────────────────────────────────────────────────────

const CAJA = newId()
const turnoEvento = (
  registerId: string,
  base: number,
  status: EstadoLocal = 'confirmed',
  extras: object = {},
) =>
  local('ShiftOpened', newId(), { register_id: registerId, base }, status, {
    aggregate_type: 'register_shift',
    ...extras,
  } as never)

describe('turnoDeCaja', () => {
  it('sin turnos, o con turnos de otra caja, no hay turno', () => {
    expect(turnoDeCaja([], CAJA)).toBeNull()
    expect(turnoDeCaja([turnoEvento(newId(), 50_000)], CAJA)).toBeNull()
  })

  it('un turno confirmado: su base y su id, sin «por confirmar»', () => {
    const t = turnoEvento(CAJA, 200_000)
    expect(turnoDeCaja([t], CAJA)).toEqual({
      id: t.event.aggregate_id,
      base: 200_000,
      openedAt: TIME,
      porConfirmar: false,
    })
  })

  it('un turno pendiente ya cuenta (se guardó aquí) y se marca por confirmar', () => {
    const t = turnoEvento(CAJA, 0, 'pending')
    expect(turnoDeCaja([t], CAJA)).toMatchObject({ base: 0, porConfirmar: true })
  })

  it('un turno rechazado por el hub no cuenta; el anterior sigue', () => {
    const good = turnoEvento(CAJA, 100)
    const rejected = turnoEvento(CAJA, 999, 'rejected', {
      hub_estimated_time: '2026-10-24T18:00:00.000Z',
    })
    expect(turnoDeCaja([good, rejected], CAJA)?.base).toBe(100)
    expect(turnoDeCaja([rejected], CAJA)).toBeNull()
  })

  it('con dos turnos de la misma caja gana el más reciente, sin importar el orden de la lista', () => {
    const oldOne = turnoEvento(CAJA, 100, 'pending', {
      hub_estimated_time: '2026-10-24T10:00:00.000Z',
    })
    const fresh = turnoEvento(CAJA, 200, 'pending', {
      hub_estimated_time: '2026-10-24T22:00:00.000Z',
    })
    expect(turnoDeCaja([oldOne, fresh], CAJA)?.base).toBe(200)
    expect(turnoDeCaja([fresh, oldOne], CAJA)?.base).toBe(200)
  })

  it('con cajas distintas, cada una ve el suyo', () => {
    const another = newId()
    const a = turnoEvento(CAJA, 111)
    const b = turnoEvento(another, 222)
    expect(turnoDeCaja([a, b], CAJA)?.base).toBe(111)
    expect(turnoDeCaja([a, b], another)?.base).toBe(222)
  })

  it('ignora los eventos que no son de turno', () => {
    const p = pedidoDeUnPlato(1_000)
    expect(turnoDeCaja(p.events, CAJA)).toBeNull()
  })
})

describe('resumenTurno', () => {
  const T1 = newId()
  const T2 = newId()
  const pagoEv = (
    order: string,
    fields: Record<string, unknown>,
    status: EstadoLocal = 'confirmed',
  ) => local('PaymentRecorded', order, pagoDatos(fields), status)
  const pid = newId()

  const cash = (amount: number, adjustment: number, tip = 0, shift = T1) => ({
    register_shift_id: shift,
    method: 'cash',
    amount,
    rounding_adjustment: adjustment,
    tip,
    tendered: amount + adjustment + tip,
    change: 0,
    rounding: adjustment === 0 ? null : { multiple: 100, mode: 'nearest_half_down' },
  })

  it('sin pagos: nada, 0 pagos', () => {
    expect(resumenTurno([], T1)).toEqual({ byMethod: [], payments: 0 })
  })

  it('suma por medio: venta con su ajuste, propina y cantidad de pagos', () => {
    const r = resumenTurno(
      [
        pagoEv(pid, cash(36_810, -10, 3_000)),
        pagoEv(pid, { register_shift_id: T1, amount: 20_000, tip: 2_000 }),
        pagoEv(pid, { register_shift_id: T1, amount: 5_000, tip: 0 }),
      ],
      T1,
    )
    expect(r.payments).toBe(3)
    expect(r.byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: 36_800, tip: 3_000, payments: 1 },
      { method: 'nequi', customMethodId: null, sale: 25_000, tip: 2_000, payments: 2 },
    ])
  })

  it('solo cuenta el turno pedido: los pagos de otro turno no entran', () => {
    const events = [pagoEv(pid, cash(10_000, 0, 0, T1)), pagoEv(pid, cash(7_000, 0, 0, T2))]
    expect(resumenTurno(events, T1).byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: 10_000, tip: 0, payments: 1 },
    ])
    expect(resumenTurno(events, T2).byMethod[0]).toMatchObject({ sale: 7_000 })
  })

  it('cuenta los pendientes y no cuenta los rechazados', () => {
    const r = resumenTurno(
      [
        pagoEv(pid, { register_shift_id: T1, amount: 1_000 }, 'pending'),
        pagoEv(pid, { register_shift_id: T1, amount: 2_000 }, 'rejected'),
      ],
      T1,
    )
    expect(r.byMethod).toEqual([
      { method: 'nequi', customMethodId: null, sale: 1_000, tip: 0, payments: 1 },
    ])
  })

  it('un pago anulado en el mismo turno se resta completo: venta con ajuste, propina y el pago', () => {
    const payment = pagoEv(pid, cash(36_810, -10, 3_000))
    const voided = local('PaymentVoided', pid, {
      payment_id: pagoIdDe(payment),
      register_shift_id: T1,
    })
    const r = resumenTurno([payment, voided], T1)
    expect(r.payments).toBe(0)
    // Un medio que queda en cero no sale en el resumen.
    expect(r.byMethod).toEqual([])
  })

  it('un pago anulado en otro turno: el original queda en el suyo y la reversa cae en el que se registra', () => {
    const payment = pagoEv(pid, cash(36_810, -10, 3_000, T1))
    const voided = local('PaymentVoided', pid, {
      payment_id: pagoIdDe(payment),
      register_shift_id: T2,
    })
    const events = [payment, voided]
    expect(resumenTurno(events, T1).byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: 36_800, tip: 3_000, payments: 1 },
    ])
    expect(resumenTurno(events, T2).byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: -36_800, tip: -3_000, payments: -1 },
    ])
  })

  it('un reembolso resta venta y propina del medio de su turno, sin cambiar la cantidad de pagos', () => {
    const payment = pagoEv(pid, { register_shift_id: T1, amount: 20_000, tip: 2_000 })
    const refund = local('RefundRecorded', pid, {
      payment_id: pagoIdDe(payment),
      refund_id: newId(),
      sale_amount: 5_000,
      tip_amount: 500,
      method: 'nequi',
      register_shift_id: T1,
    })
    expect(resumenTurno([payment, refund], T1).byMethod).toEqual([
      { method: 'nequi', customMethodId: null, sale: 15_000, tip: 1_500, payments: 1 },
    ])
  })

  it('una anulación cuyo pago no se conoce aquí (rechazado) no resta nada', () => {
    const rejected = pagoEv(pid, { register_shift_id: T1, amount: 9_000 }, 'rejected')
    const voided = local(
      'PaymentVoided',
      pid,
      { payment_id: pagoIdDe(rejected), register_shift_id: T1 },
      'pending',
    )
    expect(resumenTurno([rejected, voided], T1)).toEqual({ byMethod: [], payments: 0 })
  })

  it('una anulación rechazada no resta', () => {
    const payment = pagoEv(pid, { register_shift_id: T1, amount: 9_000 })
    const voided = local(
      'PaymentVoided',
      pid,
      { payment_id: pagoIdDe(payment), register_shift_id: T1 },
      'rejected',
    )
    expect(resumenTurno([payment, voided], T1).byMethod[0]).toMatchObject({
      sale: 9_000,
      payments: 1,
    })
  })

  it('efectivo y propina por medio suman al total cobrado del turno (identidad de DINERO.md)', () => {
    const payments = [
      pagoEv(pid, cash(36_810, -10, 3_000)),
      pagoEv(pid, {
        register_shift_id: T1,
        amount: 63_190,
        tip: 0,
        method: 'card',
        cardTerminal: {
          card_terminal_id: newId(),
          franchise: null,
          last4: null,
          approval_code: null,
          receipt: null,
        },
      }),
    ]
    const r = resumenTurno(payments, T1)
    // Σ cobrado = Σ monto + Σ ajuste: 36.800 + 63.190 = 99.990; 3.000 de propina.
    expect(add(r.byMethod.map((m) => m.sale))).toBe(99_990)
    expect(add(r.byMethod.map((m) => m.tip))).toBe(3_000)
  })

  it('propiedad: cada pago anulado deja el resumen igual que si nunca se hubiera hecho', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            amount: fc.integer({ min: 1, max: 100_000 }),
            tip: fc.integer({ min: 0, max: 10_000 }),
            method: fc.constantFrom('nequi', 'daviplata', 'breb'),
            voidItem: fc.boolean(),
          }),
          { maxLength: 8 },
        ),
        (payments) => {
          const events: EventoLocal[] = []
          const quedan: EventoLocal[] = []
          for (const p of payments) {
            const e = pagoEv(pid, { register_shift_id: T1, ...p })
            events.push(e)
            if (p.voidItem)
              events.push(
                local('PaymentVoided', pid, { payment_id: pagoIdDe(e), register_shift_id: T1 }),
              )
            else quedan.push(e)
          }
          const dejaCero = (r: ReturnType<typeof resumenTurno>) =>
            r.byMethod
              .filter((m) => m.sale !== 0 || m.tip !== 0 || m.payments !== 0)
              .sort((a, b) => a.method.localeCompare(b.method))
          expect(dejaCero(resumenTurno(events, T1))).toEqual(dejaCero(resumenTurno(quedan, T1)))
        },
      ),
      { seed: 20, numRuns: 100 },
    )
  })
})

// El panel de cobro (Cobro.tsx) arma así el pago al registrar; aquí se prueba que lo que sale de
// `pagoEnEfectivo` y de las reglas pasa el esquema de PaymentRecorded y el reductor.
describe('los datos del panel de cobro pasan el esquema y el reductor', () => {
  type Medio = 'cash' | 'card' | 'nequi'

  /** Espejo de `registrar` en FormularioCobro (Cobro.tsx): mismos campos y mismas fuentes. */
  function armarPago(p: {
    method: Medio
    balance: number
    amount: number
    tip: number
    tendered?: number
    checkId?: string | null
    datafonoId?: string
  }) {
    const calculo = pagoEnEfectivo(
      { balance: p.balance, amount: p.amount, tip: p.tip, tendered: p.tendered ?? 0 },
      REGLAS,
    )
    const served = p.tendered ?? calculo.aEntregar
    const final = pagoEnEfectivo(
      { balance: p.balance, amount: p.amount, tip: p.tip, tendered: served },
      REGLAS,
    )
    return {
      payment_id: newId(),
      check_id: p.checkId ?? null,
      register_shift_id: SHIFT,
      method: p.method,
      amount: p.amount,
      tip: p.tip,
      tendered: p.method === 'cash' ? served : null,
      change: p.method === 'cash' ? final.change : null,
      rounding_adjustment: p.method === 'cash' ? final.adjustment : 0,
      rounding: p.method === 'cash' ? final.rounding : null,
      cardTerminal:
        p.method === 'card' && p.datafonoId
          ? {
              card_terminal_id: p.datafonoId,
              franchise: null,
              last4: null,
              approval_code: null,
              receipt: null,
              card_type: 'debit' as const,
            }
          : null,
      charge_reference: null,
      custom_method_id: null,
    }
  }

  const apply = (price: number, payment: ReturnType<typeof armarPago>) => {
    const p = pedidoDeUnPlato(price)
    const event = local('PaymentRecorded', p.id, payment as never)
    const ok = validateNewEvent(sinHub(event)).ok
    const status = conEventos(p.id, p.base, [event])
    return { ok, status, payments: Object.values(status.payments) }
  }

  it('efectivo que cierra con ajuste negativo: $36.810 → cobra 36.800, regla en el evento', () => {
    const payment = armarPago({
      method: 'cash',
      balance: 36_810,
      amount: 36_810,
      tip: 3_000,
      tendered: 50_000,
    })
    expect(payment).toMatchObject({ rounding_adjustment: -10, change: 10_200, tendered: 50_000 })
    const r = apply(36_810, payment)
    expect(r.ok).toBe(true)
    expect(r.payments).toHaveLength(1)
    expect(orderTotals(r.status)).toMatchObject({ balance: 0, settings: -10, tips: 3_000 })
  })

  it('efectivo exacto por defecto (el cliente entrega justo): cambio 0', () => {
    const payment = armarPago({ method: 'cash', balance: 36_851, amount: 36_851, tip: 0 })
    expect(payment).toMatchObject({ rounding_adjustment: 49, change: 0, tendered: 36_900 })
    const r = apply(36_851, payment)
    expect(r.ok).toBe(true)
    expect(r.payments).toHaveLength(1)
  })

  it('efectivo parcial sin redondeo, el reductor lo acepta y deja saldo', () => {
    const payment = armarPago({
      method: 'cash',
      balance: 100_000,
      amount: 36_851,
      tip: 0,
      tendered: 40_000,
    })
    expect(payment).toMatchObject({ rounding_adjustment: 0, rounding: null, change: 3_149 })
    const r = apply(100_000, payment)
    expect(r.ok).toBe(true)
    expect(orderTotals(r.status).balance).toBe(63_149)
  })

  it('el cambio que el cliente deja pasa a propina: recibido = monto + ajuste + propina + cambio', () => {
    // Saldo 36.810, entrega 40.000 y deja los 3.200 de cambio como propina.
    const calculo = pagoEnEfectivo(
      { balance: 36_810, amount: 36_810, tip: 0, tendered: 40_000 },
      REGLAS,
    )
    const payment = armarPago({
      method: 'cash',
      balance: 36_810,
      amount: 36_810,
      tip: calculo.change,
      tendered: 40_000,
    })
    expect(payment).toMatchObject({ tip: 3_200, change: 0, tendered: 40_000 })
    expect(apply(36_810, payment).ok).toBe(true)
  })

  it('tarjeta con datáfono y solo el monto (sin aprobación): pasa el esquema y el reductor', () => {
    const payment = armarPago({
      method: 'card',
      balance: 40_900,
      amount: 40_900,
      tip: 4_090,
      datafonoId: newId(),
    })
    expect(payment).toMatchObject({
      tendered: null,
      change: null,
      rounding_adjustment: 0,
      rounding: null,
      cardTerminal: { approval_code: null, franchise: null, last4: null, receipt: null },
    })
    const r = apply(40_900, payment)
    expect(r.ok).toBe(true)
    expect(r.payments[0]).toMatchObject({ method: 'card', amount: 40_900, tip: 4_090 })
  })

  it('tarjeta sin datáfono no pasa el esquema (el panel no deja cobrar sin elegir uno)', () => {
    const payment = armarPago({ method: 'card', balance: 40_900, amount: 40_900, tip: 0 })
    expect(payment.cardTerminal).toBeNull()
    expect(apply(40_900, payment).ok).toBe(false)
  })

  it('Nequi: sin recibido, cambio ni datáfono, y el saldo no se redondea', () => {
    const payment = armarPago({ method: 'nequi', balance: 36_851, amount: 36_851, tip: 3_685 })
    expect(payment).toMatchObject({
      tendered: null,
      change: null,
      rounding_adjustment: 0,
      rounding: null,
      cardTerminal: null,
    })
    const r = apply(36_851, payment)
    expect(r.ok).toBe(true)
    expect(orderTotals(r.status)).toMatchObject({ balance: 0, settings: 0 })
  })

  it('pago a una cuenta dividida: lleva el cuenta_id y el reductor lo acepta', () => {
    const p = pedidoDeUnPlato(100_000)
    const check = {
      check_id: newId(),
      name: 'Cuenta 1',
      amount: 50_000,
      suggested_tip: 4_630,
      items: [],
    }
    const another = { ...check, check_id: newId(), name: 'Cuenta 2', suggested_tip: 4_629 }
    const payment = armarPago({
      method: 'nequi',
      balance: 50_000,
      amount: 50_000,
      tip: 4_630,
      checkId: check.check_id,
    })
    const status = conEventos(p.id, p.base, [
      local('CheckSplit', p.id, { checks: [check, another] }),
      local('PaymentRecorded', p.id, payment as never),
    ])
    expect(status.payments[payment.payment_id]).toMatchObject({
      checkId: check.check_id,
      amount: 50_000,
    })
    expect(porCobrar(status).checks.map((c) => c.balance)).toEqual([0, 50_000])
  })

  it('propiedad: efectivo, tarjeta y Nequi siempre pasan esquema y reductor', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2_000_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.constantFrom<Medio>('cash', 'card', 'nequi'),
        (price, fraction, tip, sobra, method) => {
          const amount = Math.max(1, Math.floor(price * fraction))
          const base = pagoEnEfectivo({ balance: price, amount, tip, tendered: 0 }, REGLAS)
          const payment = armarPago({
            method,
            balance: price,
            amount,
            tip,
            tendered: base.aEntregar + sobra,
            datafonoId: newId(),
          })
          const r = apply(price, payment)
          expect(r.ok).toBe(true)
          expect(r.payments).toHaveLength(1)
        },
      ),
      { seed: 21, numRuns: 200 },
    )
  })
})

describe('propinaSugerida del núcleo frente a la de la pantalla', () => {
  it('con todo el pedido la pantalla da lo mismo que propinaSugerida de las líneas', () => {
    const { status } = orderWith([
      { price: 53_800 },
      { price: 14_900, quantity: 3, rate: 0 },
      { price: 10_000, rate: 1900 },
    ])
    const lines = Object.values(status.items).map((i) => ({
      net: i.quantity * i.unitPrice,
      rate: i.rate,
    }))
    expect(propinaSugeridaDe(status, orderTotals(status).balance, REGLAS)).toBe(
      suggestedTip(lines, 1000),
    )
  })
})

const SODEXO = newId()
const QR = newId()
const CON_PROPIOS: ReglasCobro = {
  ...REGLAS,
  mediosPropios: [
    { id: SODEXO, name: 'Sodexo' },
    { id: QR, name: 'QR Bancolombia' },
  ],
}

describe('opcionesDeCobro y nombreDeMedio (medios propios)', () => {
  it('los de fábrica en orden, con la tarjeta partida en crédito y débito', () => {
    const o = opcionesDeCobro(REGLAS)
    expect(o.map((x) => x.key)).toEqual([
      'cash',
      'credit',
      'debit',
      'nequi',
      'daviplata',
      'breb',
      'transfer',
    ])
    expect(o.filter((x) => x.method === 'card').map((x) => x.tipoTarjeta)).toEqual([
      'credit',
      'debit',
    ])
    expect(o.find((x) => x.key === 'credit')?.name).toBe('Tarjeta crédito')
    expect(o.find((x) => x.key === 'debit')?.name).toBe('Tarjeta débito')
    for (const x of o.filter((x) => x.method !== 'card')) expect(x.tipoTarjeta).toBeNull()
    for (const x of o) expect(x.customMethodId).toBeNull()
  })

  it('sin tarjeta habilitada no salen crédito ni débito', () => {
    const o = opcionesDeCobro({ ...REGLAS, mediosPago: ['cash', 'nequi'] })
    expect(o.map((x) => x.key)).toEqual(['cash', 'nequi'])
  })

  it('los medios propios salen al final, como medio «otro» con su id y su nombre', () => {
    const o = opcionesDeCobro(CON_PROPIOS)
    expect(o.slice(-2)).toEqual([
      { key: SODEXO, name: 'Sodexo', method: 'other', customMethodId: SODEXO, tipoTarjeta: null },
      { key: QR, name: 'QR Bancolombia', method: 'other', customMethodId: QR, tipoTarjeta: null },
    ])
    expect(new Set(o.map((x) => x.key)).size).toBe(o.length)
  })

  it('un hub sin medios propios (undefined o lista vacía) no agrega nada', () => {
    expect(opcionesDeCobro({ ...REGLAS, mediosPropios: [] })).toEqual(opcionesDeCobro(REGLAS))
  })

  it('nombreDeMedio: el normal por su nombre, el propio por el suyo y uno archivado o ajeno, «Otro»', () => {
    expect(methodName('nequi', null, REGLAS)).toBe('Nequi')
    expect(methodName('other', SODEXO, CON_PROPIOS)).toBe('Sodexo')
    expect(methodName('other', newId(), CON_PROPIOS)).toBe('Otro')
    expect(methodName('other', SODEXO, REGLAS)).toBe('Otro')
    expect(methodName('other', null, null)).toBe('Otro')
    expect(methodName('cash', undefined, null)).toBe('Efectivo')
  })
})

describe('propinaConPorcentaje', () => {
  it('5 % de $100.000 al 8 %: 4.630; 15 %: 13.889; 0 %: 0', () => {
    const { status } = orderWith([{ price: 100_000 }])
    expect(propinaConPorcentaje(status, 100_000, 100_000, 500, REGLAS)).toBe(4_630)
    expect(propinaConPorcentaje(status, 100_000, 100_000, 1500, REGLAS)).toBe(13_889)
    expect(propinaConPorcentaje(status, 100_000, 100_000, 0, REGLAS)).toBe(0)
  })

  it('el 10 % coincide con la sugerida, y los pagos parciales suman la del total', () => {
    const { status } = orderWith([{ price: 100_000 }])
    expect(propinaConPorcentaje(status, 100_000, 100_000, 1000, REGLAS)).toBe(
      propinaSugeridaDe(status, 100_000, REGLAS),
    )
    const a = propinaConPorcentaje(status, 100_000, 30_000, 500, REGLAS)
    const b = propinaConPorcentaje(status, 70_000, 70_000, 500, REGLAS)
    expect(a + b).toBe(4_630)
  })

  it('un valor mayor que lo disponible o 0, propina 0', () => {
    const { status } = orderWith([{ price: 100_000 }])
    expect(propinaConPorcentaje(status, 50_000, 60_000, 500, REGLAS)).toBe(0)
    expect(propinaConPorcentaje(status, 50_000, 0, 500, REGLAS)).toBe(0)
  })
})

describe('resumenTurno con medios propios y tipo de tarjeta', () => {
  const T = newId()
  const pid = newId()
  const own = (id: string, amount: number, extra: Record<string, unknown> = {}) =>
    local(
      'PaymentRecorded',
      pid,
      pagoDatos({
        register_shift_id: T,
        method: 'other',
        custom_method_id: id,
        amount,
        ...extra,
      }) as never,
    )

  it('cada medio propio es su propio renglón, distinto de los demás y entre sí', () => {
    const r = resumenTurno(
      [own(SODEXO, 10_000), own(QR, 5_000, { tip: 500 }), own(SODEXO, 2_000)],
      T,
    )
    expect(r.byMethod).toEqual([
      { method: 'other', customMethodId: SODEXO, sale: 12_000, tip: 0, payments: 2 },
      { method: 'other', customMethodId: QR, sale: 5_000, tip: 500, payments: 1 },
    ])
  })

  it('anular o reembolsar un pago propio resta del renglón de ese medio propio', () => {
    const payment = own(SODEXO, 10_000)
    const voided = local('PaymentVoided', pid, {
      payment_id: pagoIdDe(payment),
      register_shift_id: T,
    })
    expect(resumenTurno([payment, voided], T).byMethod).toEqual([])
    const other = own(QR, 8_000)
    const refund = local('RefundRecorded', pid, {
      payment_id: pagoIdDe(other),
      refund_id: newId(),
      sale_amount: 3_000,
      tip_amount: 0,
      method: 'other',
      register_shift_id: T,
    })
    expect(resumenTurno([other, refund], T).byMethod).toEqual([
      { method: 'other', customMethodId: QR, sale: 5_000, tip: 0, payments: 1 },
    ])
  })

  it('el crédito y el débito son el mismo medio «tarjeta» en el resumen', () => {
    const card = (type: 'credit' | 'debit' | null) =>
      local(
        'PaymentRecorded',
        pid,
        pagoDatos({
          register_shift_id: T,
          method: 'card',
          amount: 1_000,
          cardTerminal: {
            card_terminal_id: newId(),
            franchise: null,
            last4: null,
            approval_code: null,
            receipt: null,
            card_type: type,
          },
        }) as never,
      )
    const r = resumenTurno([card('credit'), card('debit'), card(null)], T)
    expect(r.byMethod).toEqual([
      { method: 'card', customMethodId: null, sale: 3_000, tip: 0, payments: 3 },
    ])
  })
})

describe('pagos con medio propio y tipo de tarjeta pasan esquema y reductor', () => {
  it('un medio propio con su id se acepta y queda en el pago', () => {
    const p = pedidoDeUnPlato(10_000)
    const ev = local(
      'PaymentRecorded',
      p.id,
      pagoDatos({ method: 'other', custom_method_id: SODEXO, amount: 10_000 }) as never,
    )
    expect(validateNewEvent(sinHub(ev)).ok).toBe(true)
    const status = conEventos(p.id, p.base, [ev])
    expect(Object.values(status.payments)[0]).toMatchObject({
      method: 'other',
      customMethodId: SODEXO,
    })
  })

  it('«otro» sin id, o un id con otro medio, no pasan el esquema', () => {
    const p = pedidoDeUnPlato(10_000)
    const sinId = local(
      'PaymentRecorded',
      p.id,
      pagoDatos({ method: 'other', amount: 10_000 }) as never,
    )
    const conId = local(
      'PaymentRecorded',
      p.id,
      pagoDatos({ method: 'nequi', custom_method_id: SODEXO, amount: 10_000 }) as never,
    )
    expect(validateNewEvent(sinHub(sinId)).ok).toBe(false)
    expect(validateNewEvent(sinHub(conId)).ok).toBe(false)
  })

  it.each(['credit', 'debit', null] as const)('tarjeta con tipo %s se acepta', (type) => {
    const p = pedidoDeUnPlato(10_000)
    const ev = local(
      'PaymentRecorded',
      p.id,
      pagoDatos({
        method: 'card',
        amount: 10_000,
        cardTerminal: {
          card_terminal_id: newId(),
          franchise: null,
          last4: null,
          approval_code: null,
          receipt: null,
          card_type: type,
        },
      }) as never,
    )
    expect(validateNewEvent(sinHub(ev)).ok).toBe(true)
    expect(Object.values(conEventos(p.id, p.base, [ev]).payments)).toHaveLength(1)
  })

  it('un tipo de tarjeta que no existe se rechaza', () => {
    const p = pedidoDeUnPlato(10_000)
    const ev = local(
      'PaymentRecorded',
      p.id,
      pagoDatos({
        method: 'card',
        amount: 10_000,
        cardTerminal: {
          card_terminal_id: newId(),
          franchise: null,
          last4: null,
          approval_code: null,
          receipt: null,
          card_type: 'prepago',
        },
      }) as never,
    )
    expect(validateNewEvent(sinHub(ev)).ok).toBe(false)
  })
})
