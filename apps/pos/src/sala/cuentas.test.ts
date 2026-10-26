import {
  cobradoEnEfectivo,
  type EstadoPedido,
  MedioPago,
  nuevoId,
  propinaSugerida,
  totalesPedido,
  validarEventoNuevo,
} from '@pos/core'
import type { Catalogo, EstadoLocal, EventoLocal } from '@pos/sync'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  enPartesIguales,
  lineasDe,
  NOMBRE_MEDIO,
  nombreDeMedio,
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
import { apertura, catalogoDePrueba, datosItem, enOrden, HORA, local } from './pruebas'

// Precuenta, división, pagos y propina de la caja (tarea 1.6): cada monto sale de `@pos/core` con
// las reglas del restaurante (docs/DINERO.md). Aquí se prueba lo que arma `cuentas.ts`.

const REGLAS: ReglasCobro = {
  mediosPago: ['efectivo', 'tarjeta', 'nequi', 'daviplata', 'breb', 'transferencia'],
  propinaSugerida: 1000,
  redondeoModo: 'mitad_arriba',
  redondeoEfectivo: 100,
  redondeoEfectivoModo: 'cercano_mitad_abajo',
  imprimePrecuenta: false,
}

const TURNO = nuevoId()
const pagoIdDe = (l: EventoLocal) => (l.evento.datos as { pago_id: string }).pago_id
const sumar = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)

/** Un contador de ids para que las pruebas de división sean legibles. */
const ids = () => {
  let n = 0
  return () => `cuenta-${++n}`
}

/** Un pedido abierto con esos productos (precio × cantidad, al 8 %). */
function pedidoCon(
  productos: { precio: number; cantidad?: number; nombre?: string; tarifa?: number }[],
  extra: EventoLocal[] = [],
): { id: string; estado: EstadoPedido; items: string[] } {
  const id = nuevoId()
  const items = productos.map((p) =>
    datosItem({
      precio_unitario: p.precio,
      cantidad: p.cantidad ?? 1,
      nombre: p.nombre ?? 'Plato',
      tarifa: p.tarifa ?? 800,
    }),
  )
  const eventos = [
    local('PedidoAbierto', id, apertura),
    ...items.map((i) => local('ItemAgregado', id, i)),
    ...extra.map((e) => ({ ...e, evento: { ...e.evento, agregado_id: id } })),
  ] as EventoLocal[]
  const visible = pedidosAbiertos(enOrden(eventos)).find((p) => p.estado.id === id)
  if (!visible) throw new Error('sin pedido')
  return { id, estado: visible.estado, items: items.map((i) => i.item_id) }
}

/** El mismo pedido tras aplicar más eventos propios. */
function conEventos(id: string, base: EventoLocal[], mas: EventoLocal[]): EstadoPedido {
  const v = pedidosAbiertos(enOrden([...base, ...mas])).find((p) => p.estado.id === id)
  if (!v) throw new Error('sin pedido')
  return v.estado
}

const pagoDatos = (campos: Record<string, unknown> = {}) => ({
  pago_id: nuevoId(),
  cuenta_id: null,
  turno_caja_id: TURNO,
  medio: 'nequi' as const,
  monto: 1_000,
  propina: 0,
  recibido: null,
  cambio: null,
  ajuste_redondeo: 0,
  redondeo: null,
  datafono: null,
  referencia_cobro: null,
  ...campos,
})

/** Un pedido de un plato con eventos propios (para pagos y divisiones). */
function pedidoDeUnPlato(precio: number, mas: (id: string) => EventoLocal[] = () => []) {
  const id = nuevoId()
  const plato = datosItem({ precio_unitario: precio })
  const base = [
    local('PedidoAbierto', id, apertura),
    local('ItemAgregado', id, plato),
  ] as EventoLocal[]
  const eventos = [...base, ...mas(id)]
  const v = pedidosAbiertos(enOrden(eventos)).find((p) => p.estado.id === id)
  if (!v) throw new Error('sin pedido')
  return { id, estado: v.estado, base, plato, eventos }
}

describe('reglasDe, nombres y formato', () => {
  it('un catálogo sin cobro (hub de antes de la 1.6) o sin catálogo no tiene reglas', () => {
    expect(reglasDe(null)).toBeNull()
    expect(reglasDe(catalogoDePrueba())).toBeNull()
  })

  it('con cobro devuelve las reglas tal cual', () => {
    const catalogo: Catalogo = catalogoDePrueba()
    catalogo.restaurante.cobro = REGLAS
    expect(reglasDe(catalogo)).toBe(REGLAS)
  })

  it('cada medio de pago tiene su nombre en español', () => {
    expect(Object.keys(NOMBRE_MEDIO).sort()).toEqual([...MedioPago.options].sort())
    expect(NOMBRE_MEDIO.nequi).toBe('Nequi')
    expect(NOMBRE_MEDIO.breb).toBe('Bre-B')
    for (const nombre of Object.values(NOMBRE_MEDIO)) expect(nombre.length).toBeGreaterThan(2)
  })

  it('nombreImpuesto: INC, IVA y exento', () => {
    expect(nombreImpuesto('inc', 800)).toBe('INC 8 %')
    expect(nombreImpuesto('iva', 1900)).toBe('IVA 19 %')
    expect(nombreImpuesto('iva', 550)).toBe('IVA 5,5 %')
    expect(nombreImpuesto('exento', 0)).toBe('Exento')
    expect(nombreImpuesto('inc', 0)).toBe('Exento')
  })
})

describe('propinaSugeridaDe y propinaParaEfectivo', () => {
  it('es la propina del pedido: 100.000 al 8 % → 9.259; un monto de 0 o menos, 0', () => {
    const { estado } = pedidoCon([{ precio: 100_000 }])
    expect(propinaSugeridaDe(estado, 100_000, REGLAS)).toBe(9_259)
    expect(propinaSugeridaDe(estado, 0, REGLAS)).toBe(0)
    expect(propinaSugeridaDe(estado, -5, REGLAS)).toBe(0)
  })

  it('sigue la tasa del restaurante: 0 % no sugiere nada', () => {
    const { estado } = pedidoCon([{ precio: 100_000 }])
    expect(propinaSugeridaDe(estado, 100_000, { ...REGLAS, propinaSugerida: 0 })).toBe(0)
    expect(propinaSugeridaDe(estado, 100_000, { ...REGLAS, propinaSugerida: 500 })).toBe(4_630)
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
    (propina, esperada) => {
      expect(propinaParaEfectivo(propina, REGLAS)).toBe(esperada)
    },
  )

  it('con otro múltiplo o modo del restaurante', () => {
    expect(propinaParaEfectivo(23_843, { ...REGLAS, redondeoEfectivo: 50 })).toBe(23_850)
    expect(propinaParaEfectivo(23_843, { ...REGLAS, redondeoEfectivo: 1 })).toBe(23_843)
    expect(propinaParaEfectivo(23_843, { ...REGLAS, redondeoEfectivoModo: 'arriba' })).toBe(23_900)
    expect(propinaParaEfectivo(23_843, { ...REGLAS, redondeoEfectivoModo: 'abajo' })).toBe(23_800)
  })
})

describe('propinaDePago: los pagos parciales suman la propina entera', () => {
  it('100.000: 30.000 + 70.000 dan 2.778 + 6.481 = 9.259', () => {
    const { estado } = pedidoCon([{ precio: 100_000 }])
    const a = propinaDePago(estado, null, 100_000, 30_000, REGLAS)
    const b = propinaDePago(estado, null, 70_000, 70_000, REGLAS)
    expect([a, b]).toEqual([2_778, 6_481])
    expect(a + b).toBe(propinaSugeridaDe(estado, 100_000, REGLAS))
  })

  it('valor 0, negativo o mayor que lo disponible: 0', () => {
    const { estado } = pedidoCon([{ precio: 100_000 }])
    expect(propinaDePago(estado, null, 100_000, 0, REGLAS)).toBe(0)
    expect(propinaDePago(estado, null, 100_000, -1, REGLAS)).toBe(0)
    expect(propinaDePago(estado, null, 100_000, 100_001, REGLAS)).toBe(0)
  })

  it('pagar todo lo disponible lleva la propina de todo lo disponible', () => {
    const { estado } = pedidoCon([{ precio: 100_000 }])
    expect(propinaDePago(estado, null, 60_000, 60_000, REGLAS)).toBe(5_556)
  })

  it('en una cuenta dividida usa la propina fijada al dividir (4.630 de 50.000)', () => {
    const { estado } = pedidoCon([{ precio: 100_000 }])
    const cuenta = { monto: 50_000, propinaSugerida: 4_630 }
    expect(propinaDePago(estado, cuenta, 50_000, 50_000, REGLAS)).toBe(4_630)
    const a = propinaDePago(estado, cuenta, 50_000, 20_000, REGLAS)
    const b = propinaDePago(estado, cuenta, 30_000, 30_000, REGLAS)
    expect(a + b).toBe(4_630)
  })

  it('propiedad: cualquier reparto del saldo en pagos suma la propina del saldo', () => {
    const { estado } = pedidoCon([{ precio: 87_650 }, { precio: 12_300, cantidad: 3 }])
    const saldo = totalesPedido(estado).saldo
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 6 }),
        (pesosRelativos) => {
          const total = sumar(pesosRelativos)
          // Partes enteras que suman el saldo (la última se lleva el resto).
          const partes = pesosRelativos.map((p) => Math.floor((saldo * p) / total))
          partes[partes.length - 1] = (partes.at(-1) ?? 0) + (saldo - sumar(partes))
          let disponible = saldo
          let suma = 0
          for (const parte of partes) {
            if (parte <= 0) continue
            suma += propinaDePago(estado, null, disponible, parte, REGLAS)
            disponible -= parte
          }
          expect(suma).toBe(propinaSugeridaDe(estado, saldo, REGLAS))
        },
      ),
      { seed: 16, numRuns: 200 },
    )
  })
})

describe('lineasDe: lo que sigue en pie', () => {
  it('en el orden en que se pidió, con opciones y neto', () => {
    const { estado } = pedidoCon([
      { precio: 40_900, nombre: 'Margarita', cantidad: 2 },
      { precio: 58_900, nombre: 'Tagliata' },
    ])
    expect(lineasDe(estado).map((l) => [l.nombre, l.cantidad, l.neto])).toEqual([
      ['Margarita', 2, 81_800],
      ['Tagliata', 1, 58_900],
    ])
  })

  it('un pedido sin productos no tiene líneas', () => {
    expect(lineasDe(pedidoCon([]).estado)).toEqual([])
  })
})

describe('enPartesIguales', () => {
  it('100.000 en 3: 33.334 + 33.333 + 33.333, con sus nombres y sin productos fijos', () => {
    const { estado } = pedidoCon([{ precio: 100_000 }])
    const cuentas = enPartesIguales(estado, 3, REGLAS, ids())
    expect(cuentas.map((c) => c.monto)).toEqual([33_334, 33_333, 33_333])
    expect(cuentas.map((c) => c.nombre)).toEqual(['Persona 1', 'Persona 2', 'Persona 3'])
    expect(cuentas.map((c) => c.cuenta_id)).toEqual(['cuenta-1', 'cuenta-2', 'cuenta-3'])
    for (const c of cuentas) expect(c.items).toEqual([])
  })

  it('las propinas suman la del saldo repartida por mayor residuo (9.259 en 3)', () => {
    const { estado } = pedidoCon([{ precio: 100_000 }])
    const cuentas = enPartesIguales(estado, 3, REGLAS, ids())
    expect(sumar(cuentas.map((c) => c.propina_sugerida))).toBe(9_259)
    expect(cuentas.map((c) => c.propina_sugerida)).toEqual([3_087, 3_086, 3_086])
  })

  it('con $40.000 ya pagados: el saldo de $60.000 en 2 → 30.000 + 30.000 y propinas 2.778 + 2.778', () => {
    const p = pedidoDeUnPlato(100_000, (id) => [
      local('PagoRegistrado', id, pagoDatos({ monto: 40_000 })),
    ])
    const cuentas = enPartesIguales(p.estado, 2, REGLAS, ids())
    expect(cuentas.map((c) => c.monto)).toEqual([30_000, 30_000])
    expect(cuentas.map((c) => c.propina_sugerida)).toEqual([2_778, 2_778])
  })

  it('más personas que pesos: 2 pesos en 3 → 1 + 1 + 0, sin montos negativos', () => {
    const { estado } = pedidoCon([{ precio: 2 }])
    const cuentas = enPartesIguales(estado, 3, REGLAS, ids())
    expect(cuentas.map((c) => c.monto)).toEqual([1, 1, 0])
  })

  it('un saldo de 0 (todo pagado) da cuentas en 0 y propinas en 0, sin lanzar', () => {
    const p = pedidoDeUnPlato(40_000, (id) => [
      local('PagoRegistrado', id, pagoDatos({ monto: 40_000 })),
    ])
    const cuentas = enPartesIguales(p.estado, 2, REGLAS, ids())
    expect(cuentas.map((c) => [c.monto, c.propina_sugerida])).toEqual([
      [0, 0],
      [0, 0],
    ])
  })

  it('sin propina sugerida en el restaurante, las cuentas llevan 0', () => {
    const { estado } = pedidoCon([{ precio: 100_000 }])
    const cuentas = enPartesIguales(estado, 4, { ...REGLAS, propinaSugerida: 0 }, ids())
    expect(cuentas.map((c) => c.propina_sugerida)).toEqual([0, 0, 0, 0])
  })

  it('la división pasa el esquema de CuentaDividida y el reductor la acepta, y las cuentas suman el saldo', () => {
    const { id, estado, base } = pedidoDeUnPlato(100_000)
    const cuentas = enPartesIguales(estado, 3, REGLAS, nuevoId)
    const evento = local('CuentaDividida', id, { cuentas })
    expect(validarEventoNuevo(sinHub(evento)).ok).toBe(true)
    const despues = conEventos(id, base, [evento])
    expect(despues.cuentas?.map((c) => c.monto)).toEqual([33_334, 33_333, 33_333])
    expect(sumar(despues.cuentas?.map((c) => c.monto) ?? [])).toBe(totalesPedido(despues).saldo)
  })

  it('propiedad: Σ montos = saldo, Σ propinas = propina del saldo, nada negativo', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            precio: fc.integer({ min: 0, max: 300_000 }),
            cantidad: fc.integer({ min: 1, max: 5 }),
            tarifa: fc.constantFrom(0, 800, 1900),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        fc.integer({ min: 2, max: 12 }),
        fc.integer({ min: 0, max: 1000 }),
        (productos, personas, tasa) => {
          const { estado } = pedidoCon(productos)
          const reglas = { ...REGLAS, propinaSugerida: tasa }
          const saldo = totalesPedido(estado).saldo
          const cuentas = enPartesIguales(estado, personas, reglas, nuevoId)
          expect(sumar(cuentas.map((c) => c.monto))).toBe(saldo)
          expect(sumar(cuentas.map((c) => c.propina_sugerida))).toBe(
            propinaSugeridaDe(estado, saldo, reglas),
          )
          for (const c of cuentas) {
            expect(c.monto).toBeGreaterThanOrEqual(0)
            expect(c.propina_sugerida).toBeGreaterThanOrEqual(0)
          }
          const mayor = Math.max(...cuentas.map((c) => c.monto))
          const menor = Math.min(...cuentas.map((c) => c.monto))
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
    secuencia: _s,
    recibido_en: _r,
    dia_operativo: _d,
    asignaciones: _a,
    afecta: _f,
    autorizado_por_id: _p,
    ...nuevo
  } = l.evento as unknown as Record<string, unknown>
  return nuevo
}

function estadoConAnulado(
  p: ReturnType<typeof pedidoDeUnPlato>,
  otro: ReturnType<typeof datosItem>,
) {
  return conEventos(
    p.id,
    [...p.base, local('ItemAgregado', p.id, otro)],
    [
      local('ItemsEnviados', p.id, {
        comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [otro.item_id] }],
      }),
      local(
        'ItemAnulado',
        p.id,
        { item_id: otro.item_id, cantidad: 1, ya_preparado: false, comanda_id: null },
        'confirmado',
        { motivo: 'Error' },
      ),
    ],
  )
}

describe('porProductos', () => {
  it('cada producto a su cuenta: montos, fracciones enteras y nada sin asignar', () => {
    const { estado, items } = pedidoCon([{ precio: 40_000 }, { precio: 60_000 }])
    const r = porProductos(
      estado,
      new Map([
        [items[0] as string, [0]],
        [items[1] as string, [1]],
      ]),
      2,
      REGLAS,
      ids(),
    )
    expect(r.sinAsignar).toBe(0)
    expect(r.cuentas.map((c) => c.monto)).toEqual([40_000, 60_000])
    expect(r.cuentas.map((c) => c.nombre)).toEqual(['Cuenta 1', 'Cuenta 2'])
    expect(r.cuentas[0]?.items).toEqual([{ item_id: items[0], fraccion: { n: 1, d: 1 } }])
    expect(sumar(r.cuentas.map((c) => c.propina_sugerida))).toBe(
      propinaSugeridaDe(estado, 100_000, REGLAS),
    )
  })

  it('un producto compartido entre 3 se reparte por mayor residuo con fracción 1/3 en cada cuenta', () => {
    const { estado, items } = pedidoCon([{ precio: 100_000, nombre: 'Botella' }])
    const r = porProductos(estado, new Map([[items[0] as string, [0, 1, 2]]]), 3, REGLAS, ids())
    expect(r.cuentas.map((c) => c.monto)).toEqual([33_334, 33_333, 33_333])
    for (const c of r.cuentas) expect(c.items[0]?.fraccion).toEqual({ n: 1, d: 3 })
    expect(r.sinAsignar).toBe(0)
  })

  it('un producto compartido por dos cuentas (1/2) y otro de una sola', () => {
    const { estado, items } = pedidoCon([{ precio: 50_001 }, { precio: 20_000 }])
    const r = porProductos(
      estado,
      new Map([
        [items[0] as string, [0, 1]],
        [items[1] as string, [1]],
      ]),
      2,
      REGLAS,
      ids(),
    )
    expect(r.cuentas.map((c) => c.monto)).toEqual([25_001, 45_000])
    expect(r.cuentas[1]?.items.map((i) => i.fraccion)).toEqual([
      { n: 1, d: 2 },
      { n: 1, d: 1 },
    ])
  })

  it('nada asignado: todo queda sin asignar, las cuentas en 0 y sin propina', () => {
    const { estado } = pedidoCon([{ precio: 40_000 }, { precio: 60_000 }])
    const r = porProductos(estado, new Map(), 3, REGLAS, ids())
    expect(r.sinAsignar).toBe(100_000)
    expect(r.cuentas.map((c) => [c.monto, c.propina_sugerida, c.items])).toEqual([
      [0, 0, []],
      [0, 0, []],
      [0, 0, []],
    ])
  })

  it('lo que nadie toma queda sin asignar y sus montos no entran en la propina de las cuentas', () => {
    const { estado, items } = pedidoCon([{ precio: 40_000 }, { precio: 60_000 }])
    const r = porProductos(estado, new Map([[items[0] as string, [0]]]), 2, REGLAS, ids())
    expect(r.sinAsignar).toBe(60_000)
    expect(r.cuentas.map((c) => c.monto)).toEqual([40_000, 0])
    expect(sumar(r.cuentas.map((c) => c.propina_sugerida))).toBe(
      propinaSugeridaDe(estado, 40_000, REGLAS),
    )
  })

  it('cuentas recortadas: lo asignado a una cuenta que ya no existe se ignora', () => {
    const { estado, items } = pedidoCon([{ precio: 40_000 }, { precio: 60_000 }])
    const r = porProductos(
      estado,
      new Map([
        [items[0] as string, [0, 3]],
        [items[1] as string, [4]],
      ]),
      2,
      REGLAS,
      ids(),
    )
    // El primero queda solo en la cuenta 0 (fracción 1/1); el segundo, sin dueño.
    expect(r.cuentas.map((c) => c.monto)).toEqual([40_000, 0])
    expect(r.cuentas[0]?.items).toEqual([{ item_id: items[0], fraccion: { n: 1, d: 1 } }])
    expect(r.sinAsignar).toBe(60_000)
  })

  it('un producto anulado que no está asignado no entra en la división', () => {
    const p = pedidoDeUnPlato(40_000)
    const otro = datosItem({ precio_unitario: 10_000 })
    const estado = estadoConAnulado(p, otro)
    const r = porProductos(estado, new Map([[p.plato.item_id, [0]]]), 2, REGLAS, ids())
    expect(r.cuentas.map((c) => c.monto)).toEqual([40_000, 0])
    expect(r.sinAsignar).toBe(0)
  })

  // BUG: si un producto se anula (otro equipo) después de que el cajero lo asignó a una cuenta, la
  // asignación sigue en el mapa y `dividirPorItems` lanza «El ítem … no está en el pedido».
  // apps/pos/src/sala/cuentas.ts, porProductos: las asignaciones no se filtran por `lineasDe`.
  it('un producto asignado que luego se anula no rompe la división', () => {
    const p = pedidoDeUnPlato(40_000)
    const otro = datosItem({ precio_unitario: 10_000 })
    const estado = estadoConAnulado(p, otro)
    const r = porProductos(
      estado,
      new Map([
        [p.plato.item_id, [0]],
        [otro.item_id, [1]],
      ]),
      2,
      REGLAS,
      ids(),
    )
    expect(r.cuentas.map((c) => c.monto)).toEqual([40_000, 0])
  })

  it('el resultado pasa el esquema de CuentaDividida y el reductor lo acepta', () => {
    const p = pedidoDeUnPlato(90_000)
    const otro = datosItem({ precio_unitario: 30_000 })
    const base = [...p.base, local('ItemAgregado', p.id, otro)]
    const estado = conEventos(p.id, base, [])
    const r = porProductos(
      estado,
      new Map([
        [p.plato.item_id, [0, 1, 2]],
        [otro.item_id, [2]],
      ]),
      3,
      REGLAS,
      nuevoId,
    )
    const evento = local('CuentaDividida', p.id, { cuentas: r.cuentas })
    expect(validarEventoNuevo(sinHub(evento)).ok).toBe(true)
    const despues = conEventos(p.id, base, [evento])
    expect(despues.cuentas?.map((c) => c.monto)).toEqual([30_000, 30_000, 60_000])
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
        (precios, cuentas, reparto) => {
          const { estado, items } = pedidoCon(precios.map((precio) => ({ precio })))
          const asignadas = new Map(
            items.map((id, i) => [id, [...new Set(reparto[i] ?? [])]] as const),
          )
          const r = porProductos(estado, asignadas, cuentas, REGLAS, nuevoId)
          expect(sumar(r.cuentas.map((c) => c.monto)) + r.sinAsignar).toBe(sumar(precios))
          for (const c of r.cuentas) expect(c.monto).toBeGreaterThanOrEqual(0)
          const porItem = new Map<string, number>()
          for (const c of r.cuentas)
            for (const i of c.items)
              porItem.set(i.item_id, (porItem.get(i.item_id) ?? 0) + i.fraccion.n / i.fraccion.d)
          for (const total of porItem.values()) expect(total).toBeLessThanOrEqual(1 + 1e-9)
          const evento = local('CuentaDividida', estado.id, { cuentas: r.cuentas })
          expect(validarEventoNuevo(sinHub(evento)).ok).toBe(true)
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
    saldo: number,
    recibido: number,
    extra: Partial<{ monto: number; propina: number }> = {},
  ) =>
    pagoEnEfectivo(
      { saldo, monto: extra.monto ?? saldo, propina: extra.propina ?? 0, recibido },
      REGLAS,
    )
  const REDONDEO = { multiplo: 100, modo: 'cercano_mitad_abajo' }

  it.each([
    // saldo, recibido, cobrado, ajuste, cambio
    [36_810, 40_000, 36_800, -10, 3_200],
    [36_850, 40_000, 36_800, -50, 3_200],
    [36_851, 40_000, 36_900, 49, 3_100],
    [36_860, 50_000, 36_900, 40, 13_100],
    [36_800, 36_800, 36_800, 0, 0],
  ])(
    'saldo %i, el cliente da %i → cobra %i, ajuste %i, cambio %i',
    (saldo, recibido, cobrado, ajuste, cambio) => {
      const c = cobra(saldo, recibido)
      expect(c).toMatchObject({ cobrado, ajuste, cambio, falta: 0, aEntregar: cobrado })
      expect(c.redondeo).toEqual(ajuste === 0 ? null : REDONDEO)
    },
  )

  it('el cobro con ajuste es el mismo del núcleo (cobradoEnEfectivo)', () => {
    for (const saldo of [36_810, 36_850, 36_851, 36_860, 36_800, 1, 49, 50, 51, 99, 100])
      expect(cobra(saldo, saldo + 1_000_000).cobrado).toBe(cobradoEnEfectivo(saldo, 100))
  })

  it('pago parcial: se cobra el monto exacto, sin redondeo ni regla en el evento', () => {
    const c = pagoEnEfectivo(
      { saldo: 100_000, monto: 36_851, propina: 0, recibido: 40_000 },
      REGLAS,
    )
    expect(c).toMatchObject({ cobrado: 36_851, ajuste: 0, cambio: 3_149, falta: 0, redondeo: null })
  })

  it('un monto un peso menos que el saldo ya es parcial: sin redondeo', () => {
    const c = pagoEnEfectivo({ saldo: 36_851, monto: 36_850, propina: 0, recibido: 36_850 }, REGLAS)
    expect(c).toMatchObject({ cobrado: 36_850, ajuste: 0, redondeo: null })
  })

  it('el saldo de medio múltiplo o menos se cobra en $0 con ajuste negativo', () => {
    expect(cobra(30, 0)).toMatchObject({
      cobrado: 0,
      ajuste: -30,
      aEntregar: 0,
      cambio: 0,
      falta: 0,
    })
    expect(cobra(50, 0)).toMatchObject({ cobrado: 0, ajuste: -50, redondeo: REDONDEO })
    expect(cobra(51, 100)).toMatchObject({ cobrado: 100, ajuste: 49 })
  })

  it('después de pagar con tarjeta: saldo de $30 en efectivo, la propina sí se entrega', () => {
    const c = cobra(30, 3_000, { propina: 3_000 })
    expect(c).toMatchObject({ cobrado: 0, ajuste: -30, aEntregar: 3_000, cambio: 0 })
  })

  it('saldo múltiplo de medio múltiplo exacto (150) y saldo 0 con monto 0 es un error', () => {
    expect(cobra(150, 200)).toMatchObject({ cobrado: 100, ajuste: -50 })
    expect(() => cobra(0, 0)).toThrow(RangeError)
  })

  it('la propina se suma a lo que entrega el cliente; el cambio que sobra se calcula sobre el total', () => {
    const c = cobra(36_810, 50_000, { propina: 3_000 })
    expect(c).toMatchObject({ cobrado: 36_800, aEntregar: 39_800, cambio: 10_200, falta: 0 })
  })

  it('si lo recibido no alcanza: falta lo que falta y el cambio es 0', () => {
    expect(cobra(36_810, 30_000)).toMatchObject({ falta: 6_800, cambio: 0 })
    expect(cobra(36_810, 36_799)).toMatchObject({ falta: 1, cambio: 0 })
    expect(cobra(36_810, 36_800)).toMatchObject({ falta: 0, cambio: 0 })
  })

  it('rechaza monto 0, monto mayor que el saldo, decimales y negativos', () => {
    const base = { saldo: 36_810, monto: 36_810, propina: 0, recibido: 40_000 }
    expect(() => pagoEnEfectivo({ ...base, monto: 0 }, REGLAS)).toThrow(RangeError)
    expect(() => pagoEnEfectivo({ ...base, monto: 36_811 }, REGLAS)).toThrow(RangeError)
    expect(() => pagoEnEfectivo({ ...base, monto: 1.5 }, REGLAS)).toThrow()
    expect(() => pagoEnEfectivo({ ...base, propina: -1 }, REGLAS)).toThrow()
    expect(() => pagoEnEfectivo({ ...base, recibido: Number.NaN }, REGLAS)).toThrow()
    expect(() => pagoEnEfectivo({ ...base, saldo: -5 }, REGLAS)).toThrow()
  })

  it.each([
    ['cercano_mitad_arriba', 50, 36_825, 36_850, 25],
    ['abajo', 100, 36_899, 36_800, -99],
    ['arriba', 100, 36_801, 36_900, 99],
  ] as const)(
    'modo %s con múltiplo %i: saldo %i → cobra %i (ajuste %i)',
    (modo, multiplo, saldo, cobrado, ajuste) => {
      const c = pagoEnEfectivo(
        { saldo, monto: saldo, propina: 0, recibido: 1_000_000 },
        { ...REGLAS, redondeoEfectivo: multiplo, redondeoEfectivoModo: modo },
      )
      expect(c).toMatchObject({ cobrado, ajuste, redondeo: { multiplo, modo } })
    },
  )

  it('con múltiplo 1 nunca hay ajuste ni regla en el evento', () => {
    const c = pagoEnEfectivo(
      { saldo: 36_851, monto: 36_851, propina: 0, recibido: 36_851 },
      { ...REGLAS, redondeoEfectivo: 1 },
    )
    expect(c).toMatchObject({ cobrado: 36_851, ajuste: 0, redondeo: null })
  })

  it('propiedad: recibido = monto + ajuste + propina + cambio cuando alcanza, y el ajuste es menor que el múltiplo', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 50_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.constantFrom(1, 50, 100, 500, 1000),
        fc.constantFrom('cercano_mitad_abajo', 'cercano_mitad_arriba', 'abajo', 'arriba'),
        (saldo, fraccion, propina, extra, multiplo, modo) => {
          const monto = Math.max(1, Math.floor(saldo * fraccion))
          const reglas = { ...REGLAS, redondeoEfectivo: multiplo, redondeoEfectivoModo: modo }
          const base = pagoEnEfectivo({ saldo, monto, propina, recibido: 0 }, reglas)
          const recibido = base.aEntregar + extra
          const c = pagoEnEfectivo({ saldo, monto, propina, recibido }, reglas)
          expect(c.falta).toBe(0)
          expect(recibido).toBe(monto + c.ajuste + propina + c.cambio)
          expect(Math.abs(c.ajuste)).toBeLessThan(multiplo)
          if (monto < saldo) expect(c.ajuste).toBe(0)
          // La regla viaja solo cuando hay un ajuste que explicar.
          expect(c.redondeo === null).toBe(c.ajuste === 0)
          expect(c.cambio).toBe(extra)
        },
      ),
      { seed: 19, numRuns: 300 },
    )
  })
})

describe('porCobrar', () => {
  it('sin división: el saldo del pedido, sin cuentas ni sin asignar', () => {
    const { estado } = pedidoCon([{ precio: 100_000 }])
    expect(porCobrar(estado)).toEqual({ saldo: 100_000, cuentas: [], sinAsignar: 0 })
  })

  it('con pagos previos y sin división: el saldo baja', () => {
    const p = pedidoDeUnPlato(100_000, (id) => [
      local('PagoRegistrado', id, pagoDatos({ monto: 40_000 })),
    ])
    expect(porCobrar(p.estado)).toMatchObject({ saldo: 60_000, cuentas: [], sinAsignar: 0 })
  })

  function dividido(montos: number[], pagos: { cuenta: number; monto: number }[] = []) {
    const p = pedidoDeUnPlato(100_000)
    const cuentas = montos.map((monto, i) => ({
      cuenta_id: nuevoId(),
      nombre: `Cuenta ${i + 1}`,
      monto,
      propina_sugerida: Math.round(monto * 0.0926),
      items: [],
    }))
    const division = local('CuentaDividida', p.id, { cuentas })
    const pagosEv = pagos.map((x) =>
      local(
        'PagoRegistrado',
        p.id,
        pagoDatos({ cuenta_id: cuentas[x.cuenta]?.cuenta_id, monto: x.monto }),
      ),
    )
    return { ...p, cuentas, estado: conEventos(p.id, p.base, [division, ...pagosEv]) }
  }

  it('cada cuenta con su saldo y la propina pendiente, y nada sin asignar si suman el total', () => {
    const d = dividido([60_000, 40_000])
    const r = porCobrar(d.estado)
    expect(r.saldo).toBe(100_000)
    expect(r.sinAsignar).toBe(0)
    expect(r.cuentas.map((c) => [c.nombre, c.monto, c.saldo])).toEqual([
      ['Cuenta 1', 60_000, 60_000],
      ['Cuenta 2', 40_000, 40_000],
    ])
    for (const c of r.cuentas) expect(c.propinaPendiente).toBe(c.propinaSugerida)
  })

  it('una cuenta pagada del todo queda en saldo 0 y propina pendiente 0', () => {
    const d = dividido([60_000, 40_000], [{ cuenta: 0, monto: 60_000 }])
    const r = porCobrar(d.estado)
    expect(r.cuentas[0]).toMatchObject({ saldo: 0, propinaPendiente: 0 })
    expect(r.cuentas[1]).toMatchObject({ saldo: 40_000 })
    expect(r.saldo).toBe(40_000)
    expect(r.sinAsignar).toBe(0)
  })

  it('una cuenta pagada en parte conserva la parte proporcional de su propina', () => {
    const d = dividido([60_000, 40_000], [{ cuenta: 0, monto: 20_000 }])
    const c = porCobrar(d.estado).cuentas[0]
    expect(c).toMatchObject({ saldo: 40_000 })
    expect(c?.propinaPendiente).toBeGreaterThan(0)
    expect(c?.propinaPendiente).toBeLessThan(c?.propinaSugerida ?? 0)
  })

  it('lo que no quedó en ninguna cuenta aparece como sin asignar (división por monto libre)', () => {
    const d = dividido([30_000, 30_000])
    const r = porCobrar(d.estado)
    expect(r.saldo).toBe(100_000)
    expect(r.sinAsignar).toBe(40_000)
  })

  it('lo agregado después de dividir va a sin asignar', () => {
    const d = dividido([60_000, 40_000])
    const extra = datosItem({ precio_unitario: 10_000 })
    const estado = conEventos(
      d.id,
      [...d.base],
      [local('CuentaDividida', d.id, { cuentas: d.cuentas }), local('ItemAgregado', d.id, extra)],
    )
    const r = porCobrar(estado)
    expect(r.saldo).toBe(110_000)
    expect(r.sinAsignar).toBe(10_000)
  })

  it('un pago en la cuenta general (antes de dividir) baja el saldo y se descuenta de lo sin asignar', () => {
    const p = pedidoDeUnPlato(100_000)
    const cuentas = [
      { cuenta_id: nuevoId(), nombre: 'A', monto: 30_000, propina_sugerida: 2_778, items: [] },
      { cuenta_id: nuevoId(), nombre: 'B', monto: 30_000, propina_sugerida: 2_778, items: [] },
    ]
    const estado = conEventos(p.id, p.base, [
      local('PagoRegistrado', p.id, pagoDatos({ monto: 40_000 })),
      local('CuentaDividida', p.id, { cuentas }),
    ])
    expect(porCobrar(estado)).toMatchObject({ saldo: 60_000, sinAsignar: 0 })
  })

  it('la suma de saldos de las cuentas más lo sin asignar es el saldo del pedido', () => {
    const d = dividido([25_000, 25_000], [{ cuenta: 1, monto: 5_000 }])
    const r = porCobrar(d.estado)
    expect(sumar(r.cuentas.map((c) => c.saldo)) + r.sinAsignar).toBe(r.saldo)
  })
})

// ── Turno y resumen ──────────────────────────────────────────────────────────

const CAJA = nuevoId()
const turnoEvento = (
  cajaId: string,
  base: number,
  estado: EstadoLocal = 'confirmado',
  extras: object = {},
) =>
  local('TurnoAbierto', nuevoId(), { caja_id: cajaId, base }, estado, {
    agregado_tipo: 'turno_caja',
    ...extras,
  } as never)

describe('turnoDeCaja', () => {
  it('sin turnos, o con turnos de otra caja, no hay turno', () => {
    expect(turnoDeCaja([], CAJA)).toBeNull()
    expect(turnoDeCaja([turnoEvento(nuevoId(), 50_000)], CAJA)).toBeNull()
  })

  it('un turno confirmado: su base y su id, sin «por confirmar»', () => {
    const t = turnoEvento(CAJA, 200_000)
    expect(turnoDeCaja([t], CAJA)).toEqual({
      id: t.evento.agregado_id,
      base: 200_000,
      abiertoEn: HORA,
      porConfirmar: false,
    })
  })

  it('un turno pendiente ya cuenta (se guardó aquí) y se marca por confirmar', () => {
    const t = turnoEvento(CAJA, 0, 'pendiente')
    expect(turnoDeCaja([t], CAJA)).toMatchObject({ base: 0, porConfirmar: true })
  })

  it('un turno rechazado por el hub no cuenta; el anterior sigue', () => {
    const bueno = turnoEvento(CAJA, 100)
    const rechazado = turnoEvento(CAJA, 999, 'rechazado', {
      hora_estimada_hub: '2026-10-24T18:00:00.000Z',
    })
    expect(turnoDeCaja([bueno, rechazado], CAJA)?.base).toBe(100)
    expect(turnoDeCaja([rechazado], CAJA)).toBeNull()
  })

  it('con dos turnos de la misma caja gana el más reciente, sin importar el orden de la lista', () => {
    const viejo = turnoEvento(CAJA, 100, 'pendiente', {
      hora_estimada_hub: '2026-10-24T10:00:00.000Z',
    })
    const nuevo = turnoEvento(CAJA, 200, 'pendiente', {
      hora_estimada_hub: '2026-10-24T22:00:00.000Z',
    })
    expect(turnoDeCaja([viejo, nuevo], CAJA)?.base).toBe(200)
    expect(turnoDeCaja([nuevo, viejo], CAJA)?.base).toBe(200)
  })

  it('con cajas distintas, cada una ve el suyo', () => {
    const otra = nuevoId()
    const a = turnoEvento(CAJA, 111)
    const b = turnoEvento(otra, 222)
    expect(turnoDeCaja([a, b], CAJA)?.base).toBe(111)
    expect(turnoDeCaja([a, b], otra)?.base).toBe(222)
  })

  it('ignora los eventos que no son de turno', () => {
    const p = pedidoDeUnPlato(1_000)
    expect(turnoDeCaja(p.eventos, CAJA)).toBeNull()
  })
})

describe('resumenTurno', () => {
  const T1 = nuevoId()
  const T2 = nuevoId()
  const pagoEv = (
    pedido: string,
    campos: Record<string, unknown>,
    estado: EstadoLocal = 'confirmado',
  ) => local('PagoRegistrado', pedido, pagoDatos(campos), estado)
  const pid = nuevoId()

  const efectivo = (monto: number, ajuste: number, propina = 0, turno = T1) => ({
    turno_caja_id: turno,
    medio: 'efectivo',
    monto,
    ajuste_redondeo: ajuste,
    propina,
    recibido: monto + ajuste + propina,
    cambio: 0,
    redondeo: ajuste === 0 ? null : { multiplo: 100, modo: 'cercano_mitad_abajo' },
  })

  it('sin pagos: nada, 0 pagos', () => {
    expect(resumenTurno([], T1)).toEqual({ porMedio: [], pagos: 0 })
  })

  it('suma por medio: venta con su ajuste, propina y cantidad de pagos', () => {
    const r = resumenTurno(
      [
        pagoEv(pid, efectivo(36_810, -10, 3_000)),
        pagoEv(pid, { turno_caja_id: T1, monto: 20_000, propina: 2_000 }),
        pagoEv(pid, { turno_caja_id: T1, monto: 5_000, propina: 0 }),
      ],
      T1,
    )
    expect(r.pagos).toBe(3)
    expect(r.porMedio).toEqual([
      { medio: 'efectivo', medioPropioId: null, venta: 36_800, propina: 3_000, pagos: 1 },
      { medio: 'nequi', medioPropioId: null, venta: 25_000, propina: 2_000, pagos: 2 },
    ])
  })

  it('solo cuenta el turno pedido: los pagos de otro turno no entran', () => {
    const eventos = [
      pagoEv(pid, efectivo(10_000, 0, 0, T1)),
      pagoEv(pid, efectivo(7_000, 0, 0, T2)),
    ]
    expect(resumenTurno(eventos, T1).porMedio).toEqual([
      { medio: 'efectivo', medioPropioId: null, venta: 10_000, propina: 0, pagos: 1 },
    ])
    expect(resumenTurno(eventos, T2).porMedio[0]).toMatchObject({ venta: 7_000 })
  })

  it('cuenta los pendientes y no cuenta los rechazados', () => {
    const r = resumenTurno(
      [
        pagoEv(pid, { turno_caja_id: T1, monto: 1_000 }, 'pendiente'),
        pagoEv(pid, { turno_caja_id: T1, monto: 2_000 }, 'rechazado'),
      ],
      T1,
    )
    expect(r.porMedio).toEqual([
      { medio: 'nequi', medioPropioId: null, venta: 1_000, propina: 0, pagos: 1 },
    ])
  })

  it('un pago anulado en el mismo turno se resta completo: venta con ajuste, propina y el pago', () => {
    const pago = pagoEv(pid, efectivo(36_810, -10, 3_000))
    const anulado = local('PagoAnulado', pid, {
      pago_id: pagoIdDe(pago),
      turno_caja_id: T1,
    })
    const r = resumenTurno([pago, anulado], T1)
    expect(r.pagos).toBe(0)
    // Un medio que queda en cero no sale en el resumen.
    expect(r.porMedio).toEqual([])
  })

  it('un pago anulado en otro turno: el original queda en el suyo y la reversa cae en el que se registra', () => {
    const pago = pagoEv(pid, efectivo(36_810, -10, 3_000, T1))
    const anulado = local('PagoAnulado', pid, {
      pago_id: pagoIdDe(pago),
      turno_caja_id: T2,
    })
    const eventos = [pago, anulado]
    expect(resumenTurno(eventos, T1).porMedio).toEqual([
      { medio: 'efectivo', medioPropioId: null, venta: 36_800, propina: 3_000, pagos: 1 },
    ])
    expect(resumenTurno(eventos, T2).porMedio).toEqual([
      { medio: 'efectivo', medioPropioId: null, venta: -36_800, propina: -3_000, pagos: -1 },
    ])
  })

  it('un reembolso resta venta y propina del medio de su turno, sin cambiar la cantidad de pagos', () => {
    const pago = pagoEv(pid, { turno_caja_id: T1, monto: 20_000, propina: 2_000 })
    const reembolso = local('ReembolsoRegistrado', pid, {
      pago_id: pagoIdDe(pago),
      reembolso_id: nuevoId(),
      monto_venta: 5_000,
      monto_propina: 500,
      medio: 'nequi',
      turno_caja_id: T1,
    })
    expect(resumenTurno([pago, reembolso], T1).porMedio).toEqual([
      { medio: 'nequi', medioPropioId: null, venta: 15_000, propina: 1_500, pagos: 1 },
    ])
  })

  it('una anulación cuyo pago no se conoce aquí (rechazado) no resta nada', () => {
    const rechazado = pagoEv(pid, { turno_caja_id: T1, monto: 9_000 }, 'rechazado')
    const anulado = local(
      'PagoAnulado',
      pid,
      { pago_id: pagoIdDe(rechazado), turno_caja_id: T1 },
      'pendiente',
    )
    expect(resumenTurno([rechazado, anulado], T1)).toEqual({ porMedio: [], pagos: 0 })
  })

  it('una anulación rechazada no resta', () => {
    const pago = pagoEv(pid, { turno_caja_id: T1, monto: 9_000 })
    const anulado = local(
      'PagoAnulado',
      pid,
      { pago_id: pagoIdDe(pago), turno_caja_id: T1 },
      'rechazado',
    )
    expect(resumenTurno([pago, anulado], T1).porMedio[0]).toMatchObject({ venta: 9_000, pagos: 1 })
  })

  it('efectivo y propina por medio suman al total cobrado del turno (identidad de DINERO.md)', () => {
    const pagos = [
      pagoEv(pid, efectivo(36_810, -10, 3_000)),
      pagoEv(pid, {
        turno_caja_id: T1,
        monto: 63_190,
        propina: 0,
        medio: 'tarjeta',
        datafono: {
          datafono_id: nuevoId(),
          franquicia: null,
          ultimos4: null,
          aprobacion: null,
          recibo: null,
        },
      }),
    ]
    const r = resumenTurno(pagos, T1)
    // Σ cobrado = Σ monto + Σ ajuste: 36.800 + 63.190 = 99.990; 3.000 de propina.
    expect(sumar(r.porMedio.map((m) => m.venta))).toBe(99_990)
    expect(sumar(r.porMedio.map((m) => m.propina))).toBe(3_000)
  })

  it('propiedad: cada pago anulado deja el resumen igual que si nunca se hubiera hecho', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            monto: fc.integer({ min: 1, max: 100_000 }),
            propina: fc.integer({ min: 0, max: 10_000 }),
            medio: fc.constantFrom('nequi', 'daviplata', 'breb'),
            anular: fc.boolean(),
          }),
          { maxLength: 8 },
        ),
        (pagos) => {
          const eventos: EventoLocal[] = []
          const quedan: EventoLocal[] = []
          for (const p of pagos) {
            const e = pagoEv(pid, { turno_caja_id: T1, ...p })
            eventos.push(e)
            if (p.anular)
              eventos.push(local('PagoAnulado', pid, { pago_id: pagoIdDe(e), turno_caja_id: T1 }))
            else quedan.push(e)
          }
          const dejaCero = (r: ReturnType<typeof resumenTurno>) =>
            r.porMedio
              .filter((m) => m.venta !== 0 || m.propina !== 0 || m.pagos !== 0)
              .sort((a, b) => a.medio.localeCompare(b.medio))
          expect(dejaCero(resumenTurno(eventos, T1))).toEqual(dejaCero(resumenTurno(quedan, T1)))
        },
      ),
      { seed: 20, numRuns: 100 },
    )
  })
})

// El panel de cobro (Cobro.tsx) arma así el pago al registrar; aquí se prueba que lo que sale de
// `pagoEnEfectivo` y de las reglas pasa el esquema de PagoRegistrado y el reductor.
describe('los datos del panel de cobro pasan el esquema y el reductor', () => {
  type Medio = 'efectivo' | 'tarjeta' | 'nequi'

  /** Espejo de `registrar` en FormularioCobro (Cobro.tsx): mismos campos y mismas fuentes. */
  function armarPago(p: {
    medio: Medio
    saldo: number
    monto: number
    propina: number
    recibido?: number
    cuentaId?: string | null
    datafonoId?: string
  }) {
    const calculo = pagoEnEfectivo(
      { saldo: p.saldo, monto: p.monto, propina: p.propina, recibido: p.recibido ?? 0 },
      REGLAS,
    )
    const entregado = p.recibido ?? calculo.aEntregar
    const final = pagoEnEfectivo(
      { saldo: p.saldo, monto: p.monto, propina: p.propina, recibido: entregado },
      REGLAS,
    )
    return {
      pago_id: nuevoId(),
      cuenta_id: p.cuentaId ?? null,
      turno_caja_id: TURNO,
      medio: p.medio,
      monto: p.monto,
      propina: p.propina,
      recibido: p.medio === 'efectivo' ? entregado : null,
      cambio: p.medio === 'efectivo' ? final.cambio : null,
      ajuste_redondeo: p.medio === 'efectivo' ? final.ajuste : 0,
      redondeo: p.medio === 'efectivo' ? final.redondeo : null,
      datafono:
        p.medio === 'tarjeta' && p.datafonoId
          ? {
              datafono_id: p.datafonoId,
              franquicia: null,
              ultimos4: null,
              aprobacion: null,
              recibo: null,
              tipo_tarjeta: 'debito' as const,
            }
          : null,
      referencia_cobro: null,
      medio_propio_id: null,
    }
  }

  const aplicar = (precio: number, pago: ReturnType<typeof armarPago>) => {
    const p = pedidoDeUnPlato(precio)
    const evento = local('PagoRegistrado', p.id, pago as never)
    const ok = validarEventoNuevo(sinHub(evento)).ok
    const estado = conEventos(p.id, p.base, [evento])
    return { ok, estado, pagos: Object.values(estado.pagos) }
  }

  it('efectivo que cierra con ajuste negativo: $36.810 → cobra 36.800, regla en el evento', () => {
    const pago = armarPago({
      medio: 'efectivo',
      saldo: 36_810,
      monto: 36_810,
      propina: 3_000,
      recibido: 50_000,
    })
    expect(pago).toMatchObject({ ajuste_redondeo: -10, cambio: 10_200, recibido: 50_000 })
    const r = aplicar(36_810, pago)
    expect(r.ok).toBe(true)
    expect(r.pagos).toHaveLength(1)
    expect(totalesPedido(r.estado)).toMatchObject({ saldo: 0, ajustes: -10, propinas: 3_000 })
  })

  it('efectivo exacto por defecto (el cliente entrega justo): cambio 0', () => {
    const pago = armarPago({ medio: 'efectivo', saldo: 36_851, monto: 36_851, propina: 0 })
    expect(pago).toMatchObject({ ajuste_redondeo: 49, cambio: 0, recibido: 36_900 })
    const r = aplicar(36_851, pago)
    expect(r.ok).toBe(true)
    expect(r.pagos).toHaveLength(1)
  })

  it('efectivo parcial sin redondeo, el reductor lo acepta y deja saldo', () => {
    const pago = armarPago({
      medio: 'efectivo',
      saldo: 100_000,
      monto: 36_851,
      propina: 0,
      recibido: 40_000,
    })
    expect(pago).toMatchObject({ ajuste_redondeo: 0, redondeo: null, cambio: 3_149 })
    const r = aplicar(100_000, pago)
    expect(r.ok).toBe(true)
    expect(totalesPedido(r.estado).saldo).toBe(63_149)
  })

  it('el cambio que el cliente deja pasa a propina: recibido = monto + ajuste + propina + cambio', () => {
    // Saldo 36.810, entrega 40.000 y deja los 3.200 de cambio como propina.
    const calculo = pagoEnEfectivo(
      { saldo: 36_810, monto: 36_810, propina: 0, recibido: 40_000 },
      REGLAS,
    )
    const pago = armarPago({
      medio: 'efectivo',
      saldo: 36_810,
      monto: 36_810,
      propina: calculo.cambio,
      recibido: 40_000,
    })
    expect(pago).toMatchObject({ propina: 3_200, cambio: 0, recibido: 40_000 })
    expect(aplicar(36_810, pago).ok).toBe(true)
  })

  it('tarjeta con datáfono y solo el monto (sin aprobación): pasa el esquema y el reductor', () => {
    const pago = armarPago({
      medio: 'tarjeta',
      saldo: 40_900,
      monto: 40_900,
      propina: 4_090,
      datafonoId: nuevoId(),
    })
    expect(pago).toMatchObject({
      recibido: null,
      cambio: null,
      ajuste_redondeo: 0,
      redondeo: null,
      datafono: { aprobacion: null, franquicia: null, ultimos4: null, recibo: null },
    })
    const r = aplicar(40_900, pago)
    expect(r.ok).toBe(true)
    expect(r.pagos[0]).toMatchObject({ medio: 'tarjeta', monto: 40_900, propina: 4_090 })
  })

  it('tarjeta sin datáfono no pasa el esquema (el panel no deja cobrar sin elegir uno)', () => {
    const pago = armarPago({ medio: 'tarjeta', saldo: 40_900, monto: 40_900, propina: 0 })
    expect(pago.datafono).toBeNull()
    expect(aplicar(40_900, pago).ok).toBe(false)
  })

  it('Nequi: sin recibido, cambio ni datáfono, y el saldo no se redondea', () => {
    const pago = armarPago({ medio: 'nequi', saldo: 36_851, monto: 36_851, propina: 3_685 })
    expect(pago).toMatchObject({
      recibido: null,
      cambio: null,
      ajuste_redondeo: 0,
      redondeo: null,
      datafono: null,
    })
    const r = aplicar(36_851, pago)
    expect(r.ok).toBe(true)
    expect(totalesPedido(r.estado)).toMatchObject({ saldo: 0, ajustes: 0 })
  })

  it('pago a una cuenta dividida: lleva el cuenta_id y el reductor lo acepta', () => {
    const p = pedidoDeUnPlato(100_000)
    const cuenta = {
      cuenta_id: nuevoId(),
      nombre: 'Cuenta 1',
      monto: 50_000,
      propina_sugerida: 4_630,
      items: [],
    }
    const otra = { ...cuenta, cuenta_id: nuevoId(), nombre: 'Cuenta 2', propina_sugerida: 4_629 }
    const pago = armarPago({
      medio: 'nequi',
      saldo: 50_000,
      monto: 50_000,
      propina: 4_630,
      cuentaId: cuenta.cuenta_id,
    })
    const estado = conEventos(p.id, p.base, [
      local('CuentaDividida', p.id, { cuentas: [cuenta, otra] }),
      local('PagoRegistrado', p.id, pago as never),
    ])
    expect(estado.pagos[pago.pago_id]).toMatchObject({ cuentaId: cuenta.cuenta_id, monto: 50_000 })
    expect(porCobrar(estado).cuentas.map((c) => c.saldo)).toEqual([0, 50_000])
  })

  it('propiedad: efectivo, tarjeta y Nequi siempre pasan esquema y reductor', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2_000_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.constantFrom<Medio>('efectivo', 'tarjeta', 'nequi'),
        (precio, fraccion, propina, sobra, medio) => {
          const monto = Math.max(1, Math.floor(precio * fraccion))
          const base = pagoEnEfectivo({ saldo: precio, monto, propina, recibido: 0 }, REGLAS)
          const pago = armarPago({
            medio,
            saldo: precio,
            monto,
            propina,
            recibido: base.aEntregar + sobra,
            datafonoId: nuevoId(),
          })
          const r = aplicar(precio, pago)
          expect(r.ok).toBe(true)
          expect(r.pagos).toHaveLength(1)
        },
      ),
      { seed: 21, numRuns: 200 },
    )
  })
})

describe('propinaSugerida del núcleo frente a la de la pantalla', () => {
  it('con todo el pedido la pantalla da lo mismo que propinaSugerida de las líneas', () => {
    const { estado } = pedidoCon([
      { precio: 53_800 },
      { precio: 14_900, cantidad: 3, tarifa: 0 },
      { precio: 10_000, tarifa: 1900 },
    ])
    const lineas = Object.values(estado.items).map((i) => ({
      neto: i.cantidad * i.precioUnitario,
      tarifa: i.tarifa,
    }))
    expect(propinaSugeridaDe(estado, totalesPedido(estado).saldo, REGLAS)).toBe(
      propinaSugerida(lineas, 1000),
    )
  })
})

const SODEXO = nuevoId()
const QR = nuevoId()
const CON_PROPIOS: ReglasCobro = {
  ...REGLAS,
  mediosPropios: [
    { id: SODEXO, nombre: 'Sodexo' },
    { id: QR, nombre: 'QR Bancolombia' },
  ],
}

describe('opcionesDeCobro y nombreDeMedio (medios propios)', () => {
  it('los de fábrica en orden, con la tarjeta partida en crédito y débito', () => {
    const o = opcionesDeCobro(REGLAS)
    expect(o.map((x) => x.clave)).toEqual([
      'efectivo',
      'credito',
      'debito',
      'nequi',
      'daviplata',
      'breb',
      'transferencia',
    ])
    expect(o.filter((x) => x.medio === 'tarjeta').map((x) => x.tipoTarjeta)).toEqual([
      'credito',
      'debito',
    ])
    expect(o.find((x) => x.clave === 'credito')?.nombre).toBe('Tarjeta crédito')
    expect(o.find((x) => x.clave === 'debito')?.nombre).toBe('Tarjeta débito')
    for (const x of o.filter((x) => x.medio !== 'tarjeta')) expect(x.tipoTarjeta).toBeNull()
    for (const x of o) expect(x.medioPropioId).toBeNull()
  })

  it('sin tarjeta habilitada no salen crédito ni débito', () => {
    const o = opcionesDeCobro({ ...REGLAS, mediosPago: ['efectivo', 'nequi'] })
    expect(o.map((x) => x.clave)).toEqual(['efectivo', 'nequi'])
  })

  it('los medios propios salen al final, como medio «otro» con su id y su nombre', () => {
    const o = opcionesDeCobro(CON_PROPIOS)
    expect(o.slice(-2)).toEqual([
      { clave: SODEXO, nombre: 'Sodexo', medio: 'otro', medioPropioId: SODEXO, tipoTarjeta: null },
      { clave: QR, nombre: 'QR Bancolombia', medio: 'otro', medioPropioId: QR, tipoTarjeta: null },
    ])
    expect(new Set(o.map((x) => x.clave)).size).toBe(o.length)
  })

  it('un hub sin medios propios (undefined o lista vacía) no agrega nada', () => {
    expect(opcionesDeCobro({ ...REGLAS, mediosPropios: [] })).toEqual(opcionesDeCobro(REGLAS))
  })

  it('nombreDeMedio: el normal por su nombre, el propio por el suyo y uno archivado o ajeno, «Otro»', () => {
    expect(nombreDeMedio('nequi', null, REGLAS)).toBe('Nequi')
    expect(nombreDeMedio('otro', SODEXO, CON_PROPIOS)).toBe('Sodexo')
    expect(nombreDeMedio('otro', nuevoId(), CON_PROPIOS)).toBe('Otro')
    expect(nombreDeMedio('otro', SODEXO, REGLAS)).toBe('Otro')
    expect(nombreDeMedio('otro', null, null)).toBe('Otro')
    expect(nombreDeMedio('efectivo', undefined, null)).toBe('Efectivo')
  })
})

describe('propinaConPorcentaje', () => {
  it('5 % de $100.000 al 8 %: 4.630; 15 %: 13.889; 0 %: 0', () => {
    const { estado } = pedidoCon([{ precio: 100_000 }])
    expect(propinaConPorcentaje(estado, 100_000, 100_000, 500, REGLAS)).toBe(4_630)
    expect(propinaConPorcentaje(estado, 100_000, 100_000, 1500, REGLAS)).toBe(13_889)
    expect(propinaConPorcentaje(estado, 100_000, 100_000, 0, REGLAS)).toBe(0)
  })

  it('el 10 % coincide con la sugerida, y los pagos parciales suman la del total', () => {
    const { estado } = pedidoCon([{ precio: 100_000 }])
    expect(propinaConPorcentaje(estado, 100_000, 100_000, 1000, REGLAS)).toBe(
      propinaSugeridaDe(estado, 100_000, REGLAS),
    )
    const a = propinaConPorcentaje(estado, 100_000, 30_000, 500, REGLAS)
    const b = propinaConPorcentaje(estado, 70_000, 70_000, 500, REGLAS)
    expect(a + b).toBe(4_630)
  })

  it('un valor mayor que lo disponible o 0, propina 0', () => {
    const { estado } = pedidoCon([{ precio: 100_000 }])
    expect(propinaConPorcentaje(estado, 50_000, 60_000, 500, REGLAS)).toBe(0)
    expect(propinaConPorcentaje(estado, 50_000, 0, 500, REGLAS)).toBe(0)
  })
})

describe('resumenTurno con medios propios y tipo de tarjeta', () => {
  const T = nuevoId()
  const pid = nuevoId()
  const propio = (id: string, monto: number, extra: Record<string, unknown> = {}) =>
    local(
      'PagoRegistrado',
      pid,
      pagoDatos({ turno_caja_id: T, medio: 'otro', medio_propio_id: id, monto, ...extra }) as never,
    )

  it('cada medio propio es su propio renglón, distinto de los demás y entre sí', () => {
    const r = resumenTurno(
      [propio(SODEXO, 10_000), propio(QR, 5_000, { propina: 500 }), propio(SODEXO, 2_000)],
      T,
    )
    expect(r.porMedio).toEqual([
      { medio: 'otro', medioPropioId: SODEXO, venta: 12_000, propina: 0, pagos: 2 },
      { medio: 'otro', medioPropioId: QR, venta: 5_000, propina: 500, pagos: 1 },
    ])
  })

  it('anular o reembolsar un pago propio resta del renglón de ese medio propio', () => {
    const pago = propio(SODEXO, 10_000)
    const anulado = local('PagoAnulado', pid, {
      pago_id: pagoIdDe(pago),
      turno_caja_id: T,
    })
    expect(resumenTurno([pago, anulado], T).porMedio).toEqual([])
    const otro = propio(QR, 8_000)
    const reembolso = local('ReembolsoRegistrado', pid, {
      pago_id: pagoIdDe(otro),
      reembolso_id: nuevoId(),
      monto_venta: 3_000,
      monto_propina: 0,
      medio: 'otro',
      turno_caja_id: T,
    })
    expect(resumenTurno([otro, reembolso], T).porMedio).toEqual([
      { medio: 'otro', medioPropioId: QR, venta: 5_000, propina: 0, pagos: 1 },
    ])
  })

  it('el crédito y el débito son el mismo medio «tarjeta» en el resumen', () => {
    const tarjeta = (tipo: 'credito' | 'debito' | null) =>
      local(
        'PagoRegistrado',
        pid,
        pagoDatos({
          turno_caja_id: T,
          medio: 'tarjeta',
          monto: 1_000,
          datafono: {
            datafono_id: nuevoId(),
            franquicia: null,
            ultimos4: null,
            aprobacion: null,
            recibo: null,
            tipo_tarjeta: tipo,
          },
        }) as never,
      )
    const r = resumenTurno([tarjeta('credito'), tarjeta('debito'), tarjeta(null)], T)
    expect(r.porMedio).toEqual([
      { medio: 'tarjeta', medioPropioId: null, venta: 3_000, propina: 0, pagos: 3 },
    ])
  })
})

describe('pagos con medio propio y tipo de tarjeta pasan esquema y reductor', () => {
  it('un medio propio con su id se acepta y queda en el pago', () => {
    const p = pedidoDeUnPlato(10_000)
    const ev = local(
      'PagoRegistrado',
      p.id,
      pagoDatos({ medio: 'otro', medio_propio_id: SODEXO, monto: 10_000 }) as never,
    )
    expect(validarEventoNuevo(sinHub(ev)).ok).toBe(true)
    const estado = conEventos(p.id, p.base, [ev])
    expect(Object.values(estado.pagos)[0]).toMatchObject({ medio: 'otro', medioPropioId: SODEXO })
  })

  it('«otro» sin id, o un id con otro medio, no pasan el esquema', () => {
    const p = pedidoDeUnPlato(10_000)
    const sinId = local(
      'PagoRegistrado',
      p.id,
      pagoDatos({ medio: 'otro', monto: 10_000 }) as never,
    )
    const conId = local(
      'PagoRegistrado',
      p.id,
      pagoDatos({ medio: 'nequi', medio_propio_id: SODEXO, monto: 10_000 }) as never,
    )
    expect(validarEventoNuevo(sinHub(sinId)).ok).toBe(false)
    expect(validarEventoNuevo(sinHub(conId)).ok).toBe(false)
  })

  it.each(['credito', 'debito', null] as const)('tarjeta con tipo %s se acepta', (tipo) => {
    const p = pedidoDeUnPlato(10_000)
    const ev = local(
      'PagoRegistrado',
      p.id,
      pagoDatos({
        medio: 'tarjeta',
        monto: 10_000,
        datafono: {
          datafono_id: nuevoId(),
          franquicia: null,
          ultimos4: null,
          aprobacion: null,
          recibo: null,
          tipo_tarjeta: tipo,
        },
      }) as never,
    )
    expect(validarEventoNuevo(sinHub(ev)).ok).toBe(true)
    expect(Object.values(conEventos(p.id, p.base, [ev]).pagos)).toHaveLength(1)
  })

  it('un tipo de tarjeta que no existe se rechaza', () => {
    const p = pedidoDeUnPlato(10_000)
    const ev = local(
      'PagoRegistrado',
      p.id,
      pagoDatos({
        medio: 'tarjeta',
        monto: 10_000,
        datafono: {
          datafono_id: nuevoId(),
          franquicia: null,
          ultimos4: null,
          aprobacion: null,
          recibo: null,
          tipo_tarjeta: 'prepago',
        },
      }) as never,
    )
    expect(validarEventoNuevo(sinHub(ev)).ok).toBe(false)
  })
})
