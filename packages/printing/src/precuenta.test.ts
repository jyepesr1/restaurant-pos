import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  COLUMNAS,
  codificar,
  comoTexto,
  escpos,
  type Linea,
  leerEscpos,
  lineasPrecuenta,
  nombreImpuesto,
  PAGINAS_CODIGOS,
  type Precuenta,
  pesos,
} from './index'

// La precuenta en papel (tarea 1.6): 58 y 80 mm, con y sin pagos previos, con cuenta dividida, sin
// propina, con tildes y con el formato de pesos.

const precuenta: Precuenta = {
  restaurante: 'La Spritzzería',
  destino: 'Mesa 5',
  pedido: 12,
  mesero: 'Ana',
  hora: '8:42 p. m.',
  comensales: 4,
  lineas: [
    { cantidad: 2, nombre: 'Garden Margarita', opciones: [], valor: 81_800 },
    { cantidad: 1, nombre: 'Tagliata', opciones: ['Término medio'], valor: 58_900 },
  ],
  impuestos: [{ nombre: 'INC 8 %', base: 130_093, valor: 10_407 }],
  total: 140_700,
  pagado: 0,
  cuenta: null,
  subtotal: 140_700,
  propina: 13_028,
  tasaPropina: 1000,
}

const f80 = { columnas: COLUMNAS[80], pagina: 'pc850' as const }
const f58 = { columnas: COLUMNAS[58], pagina: 'pc850' as const }
const texto = (p: Precuenta, formato = f80) =>
  comoTexto(lineasPrecuenta(p, formato), formato.columnas)

const anchoDeLinea = (l: Linea, columnas: number, pagina: (typeof PAGINAS_CODIGOS)[number]) => {
  if (!('texto' in l)) return 0
  return codificar(l.texto, pagina).length / (l.grande ? 2 : 1) <=
    (l.grande ? columnas / 2 : columnas)
    ? 0
    : codificar(l.texto, pagina).length
}

describe('pesos: formato colombiano', () => {
  it.each([
    [0, '$0'],
    [5, '$5'],
    [999, '$999'],
    [1_000, '$1.000'],
    [40_900, '$40.900'],
    [100_000, '$100.000'],
    [1_234_567, '$1.234.567'],
    [10_000_000_000, '$10.000.000.000'],
  ])('%i → %s', (n, esperado) => {
    expect(pesos(n)).toBe(esperado)
  })

  it.each([
    [-1, '-$1'],
    [-10, '-$10'],
    [-1_000, '-$1.000'],
    [-1_234_567, '-$1.234.567'],
  ])('un negativo lleva el signo antes del peso: %i → %s', (n, esperado) => {
    expect(pesos(n)).toBe(esperado)
  })

  it('propiedad: sin los puntos y el signo vuelve al número, y los puntos van de tres en tres', () => {
    fc.assert(
      fc.property(fc.integer({ min: -10_000_000_000, max: 10_000_000_000 }), (n) => {
        const t = pesos(n)
        expect(Number(t.replace(/[$.]/g, ''))).toBe(n)
        expect(t).toMatch(/^-?\$\d{1,3}(\.\d{3})*$/)
      }),
    )
  })
})

describe('nombreImpuesto', () => {
  it('INC e IVA con su tarifa, y exento sin porcentaje', () => {
    expect(nombreImpuesto('inc', 800)).toBe('INC 8 %')
    expect(nombreImpuesto('iva', 1900)).toBe('IVA 19 %')
    expect(nombreImpuesto('exento', 0)).toBe('Exento')
    expect(nombreImpuesto('exento', 800)).toBe('Exento')
    expect(nombreImpuesto('inc', 0)).toBe('Exento')
  })

  it('una tarifa con decimales usa coma', () => {
    expect(nombreImpuesto('iva', 550)).toBe('IVA 5,5 %')
  })
})

describe('lineasPrecuenta: lo que sale en el papel', () => {
  it('lleva restaurante, PRECUENTA, mesa, datos del pedido, los platos con su valor y el total', () => {
    const t = texto(precuenta)
    expect(t).toContain('LA SPRITZZERÍA')
    expect(t).toContain('[PRECUENTA]')
    expect(t).toContain('MESA 5')
    expect(t).toContain('Pedido 12 · Ana · 8:42 p. m. · 4 pers.')
    expect(t).toMatch(/2 x Garden Margarita +\$81\.800/)
    expect(t).toMatch(/1 x Tagliata +\$58\.900/)
    expect(t).toContain('Término medio')
    expect(t).toMatch(/Total +\$140\.700/)
    expect(t.indexOf('PRECUENTA')).toBeLessThan(t.indexOf('MESA 5'))
    expect(t.indexOf('Garden')).toBeLessThan(t.indexOf('Total '))
  })

  it('la propina sugerida y el total con propina cuadran con los montos recibidos', () => {
    const t = texto(precuenta)
    expect(t).toMatch(/Propina sugerida \(10 %\) +\$13\.028/)
    expect(t.replace(/\s+/g, ' ')).toMatch(/TOTAL CON PROPINA \$153\.728/)
    expect(t).not.toContain('A PAGAR')
  })

  it('termina avisando que la propina es voluntaria y que no es una factura', () => {
    const t = texto(precuenta)
    expect(t).toContain('La propina es voluntaria.')
    expect(t.trimEnd().endsWith('Esta precuenta no es una factura.')).toBe(true)
  })

  it('el impuesto discriminado: base sin impuestos y cada impuesto con valor', () => {
    const t = texto({
      ...precuenta,
      impuestos: [
        { nombre: 'INC 8 %', base: 100_000, valor: 8_000 },
        { nombre: 'IVA 19 %', base: 10_000, valor: 1_900 },
        { nombre: 'Exento', base: 5_000, valor: 0 },
      ],
    })
    expect(t).toMatch(/Base sin impuestos +\$115\.000/)
    expect(t).toMatch(/INC 8 % +\$8\.000/)
    expect(t).toMatch(/IVA 19 % +\$1\.900/)
    // El exento no suma impuesto: no se lista como renglón.
    expect(t).not.toMatch(/Exento +\$/)
  })

  it('un hub de antes sin impuestos (undefined o vacío) no imprime renglón de base', () => {
    const { impuestos: _i, ...sinImpuestos } = precuenta
    expect(texto(sinImpuestos as Precuenta)).not.toContain('Base sin impuestos')
    expect(texto({ ...precuenta, impuestos: [] })).not.toContain('Base sin impuestos')
  })

  it('sin pagos previos no aparece «Ya pagado» ni «Saldo»', () => {
    const t = texto(precuenta)
    expect(t).not.toContain('Ya pagado')
    expect(t).not.toContain('Saldo')
  })

  it('con pagos previos: total, lo ya pagado en negativo y el saldo', () => {
    const t = texto({
      ...precuenta,
      pagado: 40_000,
      subtotal: 100_700,
      propina: 9_324,
    })
    expect(t).toMatch(/Total +\$140\.700/)
    expect(t).toMatch(/Ya pagado +-\$40\.000/)
    expect(t).toMatch(/Saldo +\$100\.700/)
    expect(t).toMatch(/Propina sugerida \(10 %\) +\$9\.324/)
    expect(t).toContain('$110.024')
    expect(t.indexOf('Total ')).toBeLessThan(t.indexOf('Ya pagado'))
    expect(t.indexOf('Ya pagado')).toBeLessThan(t.indexOf('Saldo'))
  })

  it('con la cuenta pagada por completo el saldo sale en $0', () => {
    const t = texto({ ...precuenta, pagado: 140_700, subtotal: 0, propina: 0 })
    expect(t).toMatch(/Saldo +\$0/)
    expect(t).toMatch(/A PAGAR|A pagar/i)
  })

  it('con cuenta dividida: nombre de la cuenta y su monto, y la propina de esa cuenta', () => {
    const t = texto({
      ...precuenta,
      pagado: 40_000,
      cuenta: { nombre: 'Cuenta 1', monto: 50_350 },
      subtotal: 50_350,
      propina: 4_662,
    })
    expect(t).toMatch(/Cuenta 1 +\$50\.350/)
    expect(t).toMatch(/Propina sugerida \(10 %\) +\$4\.662/)
    expect(t).toContain('$55.012')
    // La cuenta va después del saldo y antes de la propina.
    expect(t.indexOf('Saldo')).toBeLessThan(t.indexOf('Cuenta 1'))
    expect(t.indexOf('Cuenta 1')).toBeLessThan(t.indexOf('Propina sugerida'))
  })

  it('sin cuenta dividida no hay renglón de cuenta', () => {
    expect(texto(precuenta)).not.toMatch(/Cuenta \d/)
  })

  it('sin propina (tasa 0 o propina 0): sale «A pagar» con el subtotal y nada de propina', () => {
    const t = texto({ ...precuenta, propina: 0, tasaPropina: 0 })
    expect(t).toMatch(/A PAGAR +\$140\.700|A PAGAR/)
    expect(t).not.toContain('Propina sugerida')
    expect(t).not.toContain('Total con propina')
    // La advertencia de propina voluntaria se mantiene.
    expect(t).toContain('La propina es voluntaria.')
  })

  it('si el cliente pidió otra propina (tasa null) dice «Propina» y no «sugerida», con el total que suma', () => {
    const t = texto({ ...precuenta, tasaPropina: null, propina: 20_000 })
    expect(t).toMatch(/Propina +\$20\.000/)
    expect(t).not.toContain('sugerida')
    expect(t).not.toContain('NaN')
    expect(t.replace(/\s+/g, ' ')).toContain('TOTAL CON PROPINA $160.700')
  })

  it('la tasa de propina con decimales usa coma: 7,5 %', () => {
    expect(texto({ ...precuenta, tasaPropina: 750, propina: 10_553 })).toContain(
      'Propina sugerida (7,5 %)',
    )
  })

  it('un pedido sin número de día, sin comensales y sin mesero omite esos datos', () => {
    const t = texto({ ...precuenta, pedido: null, comensales: null, mesero: '' })
    expect(t).toContain('8:42 p. m.')
    expect(t).not.toContain('Pedido')
    expect(t).not.toContain('pers.')
    expect(t).not.toContain(' · · ')
  })

  it('«Para llevar» y varias mesas se imprimen tal cual', () => {
    expect(texto({ ...precuenta, destino: 'Mesa 5 + 6' })).toContain('MESA 5 + 6')
    expect(texto({ ...precuenta, destino: 'Para llevar' })).toContain('PARA LLEVAR')
  })

  it('una precuenta sin platos (mesa vacía) no rompe', () => {
    const t = texto({ ...precuenta, lineas: [], total: 0, subtotal: 0, propina: 0, impuestos: [] })
    expect(t).toMatch(/Total +\$0/)
  })
})

describe('lineasPrecuenta: opciones del plato', () => {
  // BUG: precuenta.ts agrega `  ${opcion}` para sangrar las opciones bajo su plato, pero `parrafo`
  // → `partir` (documento.ts) descarta los espacios del principio, así que «Término medio» sale
  // pegado al margen, igual que un plato.
  it('las opciones de un plato salen sangradas bajo el plato', () => {
    const renglon = texto(precuenta)
      .split('\n')
      .find((l) => l.includes('Término medio'))
    expect(renglon?.startsWith('  ')).toBe(true)
  })

  it('las opciones salen justo debajo de su plato, antes del plato siguiente', () => {
    const t = texto({
      ...precuenta,
      lineas: [
        { cantidad: 1, nombre: 'Tagliata', opciones: ['Término medio', 'Sin sal'], valor: 58_900 },
        { cantidad: 1, nombre: 'Tiramisú', opciones: [], valor: 18_000 },
      ],
    })
    expect(t.indexOf('Tagliata')).toBeLessThan(t.indexOf('Término medio'))
    expect(t.indexOf('Término medio')).toBeLessThan(t.indexOf('Sin sal'))
    expect(t.indexOf('Sin sal')).toBeLessThan(t.indexOf('Tiramisú'))
  })
})

describe('lineasPrecuenta: 58 mm (32 columnas) frente a 80 mm (48)', () => {
  it('en 58 mm los mismos datos caben en líneas de hasta 32 caracteres', () => {
    for (const l of lineasPrecuenta(precuenta, f58)) {
      if (!('texto' in l)) continue
      expect(codificar(l.texto, 'pc850').length).toBeLessThanOrEqual(l.grande ? 16 : 32)
    }
    const t = texto(precuenta, f58)
    expect(t).toContain('2 x Garden Margarita')
    expect(t).toContain('$81.800')
    expect(t).toContain('$140.700')
    expect(t).toContain('$13.028')
  })

  it('en 80 mm las líneas llegan hasta 48 caracteres', () => {
    const anchos = lineasPrecuenta(precuenta, f80).map((l) =>
      'texto' in l && !l.grande ? l.texto.length : 0,
    )
    expect(Math.max(...anchos)).toBeLessThanOrEqual(48)
    expect(Math.max(...anchos)).toBeGreaterThan(32)
  })

  it('el monto va pegado al borde derecho: el renglón mide justo el ancho', () => {
    const lineas = lineasPrecuenta(precuenta, f80)
    const total = lineas.find(
      (l) => 'texto' in l && l.texto.startsWith('Total ') && l.texto.endsWith('$140.700'),
    )
    expect(total && 'texto' in total ? total.texto.length : 0).toBe(48)
    const en58 = lineasPrecuenta(precuenta, f58).find(
      (l) => 'texto' in l && l.texto.startsWith('Total ') && l.texto.endsWith('$140.700'),
    )
    expect(en58 && 'texto' in en58 ? en58.texto.length : 0).toBe(32)
  })

  it('un nombre de plato muy largo se parte en 58 mm y el valor no se pierde', () => {
    const largo = 'Pizza Margarita Especial de la Casa con Doble Queso y Albahaca'
    const t = texto(
      { ...precuenta, lineas: [{ cantidad: 1, nombre: largo, opciones: [], valor: 58_900 }] },
      f58,
    )
    expect(t).toContain('$58.900')
    expect(t.replace(/\s+/g, ' ')).toContain('Margarita Especial')
    for (const linea of t.split('\n')) expect(linea.length).toBeLessThanOrEqual(32)
  })

  it('un valor que no cabe junto al nombre baja a su propia línea sin cortarse', () => {
    const t = texto(
      {
        ...precuenta,
        lineas: [
          {
            cantidad: 1,
            nombre: 'Nombre larguísimo de plato aquí',
            opciones: [],
            valor: 1_234_567,
          },
        ],
      },
      f58,
    )
    expect(t).toContain('$1.234.567')
  })

  it('«Total con propina» (letra grande) con 58 mm se parte sin perder el monto', () => {
    const t = texto(precuenta, f58)
    expect(t.replace(/\s+/g, ' ').toUpperCase()).toContain('TOTAL CON PROPINA')
    expect(t).toContain('$153.728')
  })
})

describe('lineasPrecuenta: tildes y caracteres', () => {
  const conTildes: Precuenta = {
    ...precuenta,
    restaurante: 'Café Ñandú',
    destino: 'Terraza ¡Bogotá!',
    mesero: 'José Ñáñez',
    lineas: [
      {
        cantidad: 1,
        nombre: 'Piña colada · señor',
        opciones: ['Sin azúcar', 'Más hielo ¿sí?'],
        valor: 22_000,
      },
    ],
  }

  it('pc850: las tildes y eñes salen en el byte de la tabla y se leen de vuelta', () => {
    const bytes = escpos(lineasPrecuenta(conTildes, f80), f80)
    const leido = leerEscpos(bytes).texto
    expect(leido).toContain('Piña colada')
    expect(leido).toContain('Sin azúcar')
    expect(leido).toContain('José Ñáñez')
    expect(leido).toContain('Más hielo ¿sí?')
    expect(leido).toContain('Esta precuenta no es una factura.')
  })

  it('wpc1252 también conserva las tildes', () => {
    const f = { columnas: 48, pagina: 'wpc1252' as const }
    const leido = leerEscpos(escpos(lineasPrecuenta(conTildes, f), f)).texto
    expect(leido).toContain('Piña colada')
    expect(leido).toContain('José Ñáñez')
  })

  it('sin_tildes quita las tildes pero deja legible todo el texto', () => {
    const f = { columnas: 48, pagina: 'sin_tildes' as const }
    const leido = leerEscpos(escpos(lineasPrecuenta(conTildes, f), f)).texto
    expect(leido).toContain('Pina colada')
    expect(leido).toContain('Sin azucar')
    expect(leido).toContain('Jose Nanez')
    expect(leido).not.toMatch(/[ñáéíóú¿¡]/i)
  })

  it('el aviso de «no es una factura» y los montos salen igual en todas las tablas', () => {
    for (const pagina of PAGINAS_CODIGOS) {
      const f = { columnas: 48, pagina }
      const leido = leerEscpos(escpos(lineasPrecuenta(precuenta, f), f)).texto
      expect(leido).toContain('$140.700')
      expect(leido).toContain('$153.728')
      expect(leido).toMatch(/precuenta no es una factura/)
    }
  })
})

describe('lineasPrecuenta: ESC/POS', () => {
  it('corta el papel una sola vez, al final', () => {
    expect(leerEscpos(escpos(lineasPrecuenta(precuenta, f80), f80)).cortes).toBe(1)
    expect(leerEscpos(escpos(lineasPrecuenta(precuenta, f58), f58)).cortes).toBe(1)
  })

  it('el nombre del plato no le da órdenes a la impresora (sin bytes de control)', () => {
    const malo = 'Plato\u001b@\u001dVB\u0000 raro\n'
    const bytes = escpos(
      lineasPrecuenta(
        { ...precuenta, lineas: [{ cantidad: 1, nombre: malo, opciones: [malo], valor: 1_000 }] },
        f80,
      ),
      f80,
    )
    expect(leerEscpos(bytes).cortes).toBe(1)
  })
})

describe('lineasPrecuenta: propiedades', () => {
  it('ninguna línea pasa del ancho para cualquier texto, ancho, tabla y montos', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 100 }),
        fc.string({ maxLength: 60 }),
        fc.constantFrom(32, 48),
        fc.constantFrom(...PAGINAS_CODIGOS),
        fc.integer({ min: 0, max: 10_000_000_000 }),
        fc.integer({ min: 0, max: 10_000_000_000 }),
        fc.boolean(),
        (nombre, opcion, columnas, pagina, valor, pagado, conCuenta) => {
          const p: Precuenta = {
            ...precuenta,
            restaurante: nombre,
            destino: nombre,
            lineas: [{ cantidad: 3, nombre, opciones: [opcion], valor }],
            total: valor,
            pagado,
            subtotal: valor,
            cuenta: conCuenta ? { nombre, monto: valor } : null,
          }
          for (const l of lineasPrecuenta(p, { columnas, pagina })) {
            if (!('texto' in l)) continue
            const ancho = l.grande ? Math.floor(columnas / 2) : columnas
            expect(codificar(l.texto, pagina).length).toBeLessThanOrEqual(ancho)
          }
        },
      ),
      { seed: 16, numRuns: 300 },
    )
  })

  it('siempre aparecen el total y el aviso final, sea cual sea el tamaño de los montos', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000_000 }),
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.constantFrom(32, 48),
        (total, propina, columnas) => {
          const t = comoTexto(
            lineasPrecuenta(
              { ...precuenta, total, subtotal: total, propina },
              { columnas, pagina: 'pc850' },
            ),
            columnas,
          )
          expect(t).toContain(pesos(total))
          expect(t.replace(/\s+/g, ' ')).toContain('Esta precuenta no es una factura.')
        },
      ),
      { seed: 17, numRuns: 200 },
    )
  })

  it('el total con propina impreso es el subtotal más la propina', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000_000 }),
        fc.integer({ min: 1, max: 500_000_000 }),
        (subtotal, propina) => {
          const t = comoTexto(
            lineasPrecuenta({ ...precuenta, subtotal, propina }, f80),
            48,
          ).replace(/\s+/g, ' ')
          expect(t).toContain(pesos(subtotal + propina))
        },
      ),
      { seed: 18, numRuns: 200 },
    )
  })

  it('anchoDeLinea de apoyo: ninguna línea de la precuenta de ejemplo se pasa', () => {
    for (const pagina of PAGINAS_CODIGOS)
      for (const columnas of [32, 48])
        for (const l of lineasPrecuenta(precuenta, { columnas, pagina }))
          expect(anchoDeLinea(l, columnas, pagina)).toBe(0)
  })
})
