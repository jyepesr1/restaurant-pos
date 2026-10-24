import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { jsonCanonico, PROFUNDIDAD_MAXIMA } from '../canonico'
import { evento } from '../pruebas/fabrica'
import { firmarEvento, huellaAutorizable, igualesSinFiltrarTiempo } from './firma'

const abierto = () =>
  evento('01JB0000000000000000000000', 'PedidoAbierto', {
    canal: 'salon',
    mesa_id: null,
    comensales: 2,
  })

describe('JSON canónico', () => {
  it('ordena las claves y omite lo indefinido', () => {
    expect(jsonCanonico({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}')
    expect(jsonCanonico(undefined)).toBe('null')
  })

  it('corta lo demasiado anidado', () => {
    let valor: unknown = 1
    for (let i = 0; i <= PROFUNDIDAD_MAXIMA; i++) valor = [valor]
    expect(() => jsonCanonico(valor)).toThrow(RangeError)
  })
})

describe('firma del evento', () => {
  it('es HMAC-SHA256 del contenido canónico, sin la firma ni `secuencia_base`', () => {
    const e = abierto()
    const { secuencia_base: _b, ...resto } = e
    const esperada = bytesToHex(
      hmac(sha256, utf8ToBytes('secreto'), utf8ToBytes(jsonCanonico(resto))),
    )

    expect(firmarEvento(e, 'secreto')).toBe(esperada)
    expect(firmarEvento({ ...e, secuencia_base: 9, firma: 'f'.repeat(64) }, 'secreto')).toBe(
      esperada,
    )
  })

  it('cambia con el secreto o con cualquier dato del evento', () => {
    const e = abierto()
    const base = firmarEvento(e, 'secreto')
    expect(firmarEvento(e, 'otro')).not.toBe(base)
    expect(firmarEvento({ ...e, usuario_id: '01JB0000000000000000000001' }, 'secreto')).not.toBe(
      base,
    )
    expect(
      firmarEvento({ ...e, hora_estimada_hub: '2026-10-24T21:00:00.000Z' }, 'secreto'),
    ).not.toBe(base)
  })
})

describe('huella para el comprobante de supervisor', () => {
  it('no depende del comprobante que se agrega después, sí del contenido', () => {
    const e = abierto()
    const h = huellaAutorizable(e)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(huellaAutorizable({ ...e, autorizacion_id: '01JB0000000000000000000002' })).toBe(h)
    expect(huellaAutorizable({ ...e, motivo: 'otro' })).not.toBe(h)
  })
})

describe('comparación de textos', () => {
  it('compara completo', () => {
    expect(igualesSinFiltrarTiempo('abc', 'abc')).toBe(true)
    expect(igualesSinFiltrarTiempo('abc', 'abd')).toBe(false)
    expect(igualesSinFiltrarTiempo('abc', 'ab')).toBe(false)
  })
})
