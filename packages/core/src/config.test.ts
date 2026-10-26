import { describe, expect, it } from 'vitest'
import { ConfigRestaurante, configCompleta, MARCAS } from './config'
import { cobradoEnEfectivo } from './dinero/efectivo'
import { propinaSugerida } from './dinero/propina'

describe('configuración del restaurante', () => {
  it('sin nada, trae los valores del piloto (MODELO_DATOS.md)', () => {
    expect(configCompleta()).toEqual({
      inicio_dia_operativo: '06:00',
      bloqueo_mesa_por_mesero: false,
      redondeo_efectivo: 100,
      propina_sugerida: 1000,
      propina_base: 'sin_impuesto',
      granularidad_fiscal: 'linea',
      ventas_por_mesero: 'quien_agrega',
      redondeo_modo: 'mitad_arriba',
      redondeo_efectivo_modo: 'cercano_mitad_abajo',
      sesion_inactividad_min: 30,
      marca: 'faro',
      cocina_amarillo_min: 10,
      cocina_rojo_min: 20,
      usar_cursos: false,
      medios_pago: ['efectivo', 'tarjeta', 'nequi', 'daviplata', 'breb', 'transferencia'],
      medios_propios: [],
      impresora_precuenta_id: null,
    })
  })

  describe('medios de pago e impresora de precuentas (tarea 1.6)', () => {
    it('el efectivo siempre está, sin repetidos, y un medio que no existe no se acepta', () => {
      expect(configCompleta({ medios_pago: ['efectivo'] }).medios_pago).toEqual(['efectivo'])
      expect(() => configCompleta({ medios_pago: ['tarjeta'] })).toThrow()
      expect(() => configCompleta({ medios_pago: [] })).toThrow()
      expect(() => configCompleta({ medios_pago: ['efectivo', 'efectivo'] })).toThrow()
      expect(() => configCompleta({ medios_pago: ['efectivo', 'cheque'] })).toThrow()
    })

    it('la impresora de precuentas es un ULID o nada', () => {
      expect(configCompleta({ impresora_precuenta_id: null }).impresora_precuenta_id).toBeNull()
      expect(() => configCompleta({ impresora_precuenta_id: 'impresora' })).toThrow()
    })
  })

  describe('marca del restaurante (tarea 1.3c)', () => {
    it('sin marca (un hub viejo) es Faro; las dos que existen se aceptan', () => {
      expect(configCompleta({}).marca).toBe('faro')
      expect(configCompleta({ sesion_inactividad_min: 10 }).marca).toBe('faro')
      expect(configCompleta({ marca: 'faro' }).marca).toBe('faro')
      expect(configCompleta({ marca: 'la-spritzzeria' }).marca).toBe('la-spritzzeria')
    })

    it('rechaza cualquier otra marca, también las de pruebas anteriores', () => {
      for (const marca of [
        'bagno',
        'taller',
        'noche',
        'neutra',
        'Faro',
        'FARO',
        ' faro',
        '',
        null,
        0,
        true,
        {},
        ['faro'],
      ])
        expect(ConfigRestaurante.safeParse({ marca }).success, JSON.stringify(marca)).toBe(false)
    })

    it('la lista de marcas es la que acepta el esquema, sin repetidos y con Faro primero', () => {
      expect([...MARCAS]).toEqual(['faro', 'la-spritzzeria'])
      for (const marca of MARCAS) expect(configCompleta({ marca }).marca).toBe(marca)
    })

    it('completar dos veces no cambia nada (idempotente), con o sin marca', () => {
      for (const parcial of [
        {},
        { marca: 'la-spritzzeria' },
        { marca: 'faro', redondeo_efectivo: 50 },
      ]) {
        const una = configCompleta(parcial)
        expect(configCompleta(una)).toEqual(una)
      }
    })
  })

  it('respeta lo que trae y rechaza valores fuera de rango o con decimales', () => {
    expect(configCompleta({ redondeo_efectivo: 50 }).redondeo_efectivo).toBe(50)
    for (const malo of [
      { inicio_dia_operativo: '6:00' },
      { propina_sugerida: 10.5 },
      { redondeo_efectivo: 0 },
      { propina_base: 'con_impuesto' },
      { campo_raro: 1 },
    ])
      expect(ConfigRestaurante.safeParse(malo).success).toBe(false)
  })

  it('topes de dinero: propina hasta 10 %, redondeo solo a múltiplos habituales, fiscal por línea', () => {
    for (const bueno of [
      { propina_sugerida: 0 },
      { propina_sugerida: 1000 },
      ...[1, 50, 100, 500, 1000].map((redondeo_efectivo) => ({ redondeo_efectivo })),
      { redondeo_modo: 'mitad_par' },
      ...['cercano_mitad_arriba', 'abajo', 'arriba'].map((m) => ({ redondeo_efectivo_modo: m })),
    ])
      expect(ConfigRestaurante.safeParse(bueno).success).toBe(true)
    for (const malo of [
      { propina_sugerida: -1 },
      { propina_sugerida: 1001 },
      { redondeo_efectivo: 200 },
      { redondeo_efectivo: 10_000 },
      { redondeo_efectivo: 100.5 },
      { granularidad_fiscal: 'documento' },
      { redondeo_modo: 'hacia_cero' },
      { redondeo_efectivo_modo: 'cercano' },
    ])
      expect(ConfigRestaurante.safeParse(malo).success).toBe(false)
  })

  it('los extremos de la configuración funcionan en el código de dinero', () => {
    const c = configCompleta({ redondeo_efectivo: 1000, redondeo_efectivo_modo: 'arriba' })
    expect(cobradoEnEfectivo(36_810, c.redondeo_efectivo, c.redondeo_efectivo_modo)).toBe(37_000)
    expect(propinaSugerida([{ neto: 108_000, tarifa: 800 }], 1000, c.redondeo_modo)).toBe(10_000)
    expect(propinaSugerida([{ neto: 108_000, tarifa: 800 }], 0)).toBe(0)
  })
})
