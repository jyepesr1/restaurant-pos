import { describe, expect, it } from 'vitest'
import { esIdValido, nuevoId } from './id'

describe('nuevoId', () => {
  it('genera ULID válidos de 26 caracteres', () => {
    const id = nuevoId()
    expect(id).toHaveLength(26)
    expect(esIdValido(id)).toBe(true)
  })

  it('no repite y conserva el orden aunque se creen en el mismo milisegundo', () => {
    const ids = Array.from({ length: 10_000 }, () => nuevoId())
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(ids)
  })

  it('rechaza valores que no son ULID', () => {
    expect(esIdValido('mesa-5')).toBe(false)
    expect(esIdValido('')).toBe(false)
  })

  it('rechaza ULID en minúsculas o fuera de rango', () => {
    const id = nuevoId()
    expect(esIdValido(id.toLowerCase())).toBe(false)
    expect(esIdValido(`8${id.slice(1)}`)).toBe(false)
  })
})
