import { describe, expect, it } from 'vitest'
import { ConfigRestaurante, configCompleta } from './config'
import { nuevoId } from './id'

// Configuración del cobro (tarea 1.6): `medios_pago` e `impresora_precuenta_id`.

const TODOS = ['efectivo', 'tarjeta', 'nequi', 'daviplata', 'breb', 'transferencia']

describe('config.medios_pago', () => {
  it('sin nada trae los seis medios en el orden en que salen al cobrar', () => {
    expect(configCompleta().medios_pago).toEqual(TODOS)
    expect(configCompleta({}).medios_pago[0]).toBe('efectivo')
  })

  it('conserva el orden que el restaurante eligió, aunque el efectivo no vaya primero', () => {
    expect(configCompleta({ medios_pago: ['nequi', 'efectivo', 'tarjeta'] }).medios_pago).toEqual([
      'nequi',
      'efectivo',
      'tarjeta',
    ])
  })

  it('acepta un subconjunto con el efectivo y el bono, que no viene por defecto', () => {
    expect(configCompleta({ medios_pago: ['efectivo', 'bono'] }).medios_pago).toEqual([
      'efectivo',
      'bono',
    ])
    expect(configCompleta({ medios_pago: [...TODOS, 'bono'] }).medios_pago).toHaveLength(7)
  })

  it.each([
    ['sin efectivo', ['tarjeta', 'nequi']],
    ['vacía', []],
    ['con repetidos', ['efectivo', 'tarjeta', 'tarjeta']],
    ['con un medio que no existe', ['efectivo', 'cheque']],
    ['con mayúsculas', ['Efectivo']],
    ['no es una lista', 'efectivo'],
    ['null', null],
    ['con un elemento que no es texto', ['efectivo', 3]],
  ])('rechaza una lista %s', (_, medios_pago) => {
    expect(ConfigRestaurante.safeParse({ medios_pago }).success).toBe(false)
  })

  it('completar una config ya completa no cambia los medios (idempotente)', () => {
    const una = configCompleta({ medios_pago: ['efectivo', 'breb'] })
    expect(configCompleta(una).medios_pago).toEqual(['efectivo', 'breb'])
  })

  it('el valor por defecto no se comparte: cambiar la lista de una config no toca la siguiente', () => {
    const a = configCompleta()
    a.medios_pago.push('bono')
    a.medios_pago.shift()
    expect(configCompleta().medios_pago).toEqual(TODOS)
  })
})

describe('config.impresora_precuenta_id', () => {
  it('por defecto no hay impresora: la precuenta solo se ve en pantalla', () => {
    expect(configCompleta().impresora_precuenta_id).toBeNull()
  })

  it('acepta un ULID', () => {
    const id = nuevoId()
    expect(configCompleta({ impresora_precuenta_id: id }).impresora_precuenta_id).toBe(id)
  })

  it.each([
    ['texto cualquiera', 'impresora'],
    ['cadena vacía', ''],
    ['un ULID en minúsculas', nuevoId().toLowerCase()],
    ['con un espacio', ` ${nuevoId()}`],
    ['un número', 5],
    ['un objeto', {}],
  ])('rechaza %s', (_, impresora_precuenta_id) => {
    expect(ConfigRestaurante.safeParse({ impresora_precuenta_id }).success).toBe(false)
  })

  it('quitarla (null) es válido, y las dos opciones conviven con el resto de la config', () => {
    const id = nuevoId()
    const config = configCompleta({
      impresora_precuenta_id: id,
      medios_pago: ['efectivo'],
      redondeo_efectivo: 50,
    })
    expect(config).toMatchObject({
      impresora_precuenta_id: id,
      medios_pago: ['efectivo'],
      redondeo_efectivo: 50,
    })
    expect(configCompleta({ ...config, impresora_precuenta_id: null }).impresora_precuenta_id).toBe(
      null,
    )
  })
})

describe('config.medios_propios', () => {
  const propio = (extra: object = {}) => ({
    id: nuevoId(),
    nombre: 'Sodexo',
    activo: true,
    ...extra,
  })

  it('por defecto no hay medios propios', () => {
    expect(configCompleta().medios_propios).toEqual([])
  })

  it('acepta medios con id, nombre y activo, también archivados', () => {
    const a = propio()
    const b = propio({ nombre: 'QR Bancolombia', activo: false })
    expect(configCompleta({ medios_propios: [a, b] }).medios_propios).toEqual([a, b])
  })

  it('el nombre se recorta y va de 1 a 30 caracteres', () => {
    expect(
      configCompleta({ medios_propios: [propio({ nombre: '  Rappi  ' })] }).medios_propios[0]
        ?.nombre,
    ).toBe('Rappi')
    expect(() =>
      configCompleta({ medios_propios: [propio({ nombre: 'x'.repeat(30) })] }),
    ).not.toThrow()
    expect(() => configCompleta({ medios_propios: [propio({ nombre: 'x'.repeat(31) })] })).toThrow()
    expect(() => configCompleta({ medios_propios: [propio({ nombre: '   ' })] })).toThrow()
    expect(() => configCompleta({ medios_propios: [propio({ nombre: '' })] })).toThrow()
  })

  it('rechaza ids repetidos, ids que no son ULID, campos de más y activo que no es booleano', () => {
    const a = propio()
    expect(() => configCompleta({ medios_propios: [a, { ...a, nombre: 'Otro nombre' }] })).toThrow()
    expect(() => configCompleta({ medios_propios: [propio({ id: 'sodexo' })] })).toThrow()
    expect(() => configCompleta({ medios_propios: [propio({ color: 'rojo' })] })).toThrow()
    expect(() => configCompleta({ medios_propios: [propio({ activo: 1 })] })).toThrow()
    expect(() => configCompleta({ medios_propios: 'Sodexo' })).toThrow()
  })

  it('máximo 20', () => {
    const veinte = Array.from({ length: 20 }, () => propio())
    expect(configCompleta({ medios_propios: veinte }).medios_propios).toHaveLength(20)
    expect(() => configCompleta({ medios_propios: [...veinte, propio()] })).toThrow()
  })

  it('«otro» no va en medios_pago: los medios propios van en medios_propios', () => {
    expect(() => configCompleta({ medios_pago: ['efectivo', 'otro'] })).toThrow()
    expect(configCompleta({ medios_pago: ['efectivo', 'bono'] }).medios_pago).toContain('bono')
  })

  it('completar dos veces no cambia nada', () => {
    const una = configCompleta({ medios_propios: [propio()] })
    expect(configCompleta(una)).toEqual(una)
  })
})
