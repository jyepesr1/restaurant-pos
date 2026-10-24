import { describe, expect, it } from 'vitest'
import { ConfigRestaurante, configCompleta } from './config'
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
