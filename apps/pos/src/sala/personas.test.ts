import { describe, expect, it } from 'vitest'
import {
  administradoras,
  borradorDe,
  datosPersona,
  normalizarUsuario,
  type PersonaPersonal,
  pideContrasena,
  problemasDe,
  resumenRol,
  usuarioSugerido,
} from './personas'

// La lógica de la pantalla de personal y roles (tarea 1.3b).

const ana: PersonaPersonal = {
  id: 'A',
  name: 'Ana',
  rolId: 'MESERO',
  active: true,
  user: null,
}
const carla: PersonaPersonal = {
  id: 'C',
  name: 'Carla',
  rolId: 'CAJERO',
  active: true,
  user: 'carla',
}

describe('borrador de una persona', () => {
  it('una nueva entra con PIN y con el rol sugerido; una existente, como está', () => {
    expect(borradorDe(null, 'MESERO')).toEqual({
      name: '',
      rolId: 'MESERO',
      entra: 'pin',
      user: '',
      password: '',
    })
    expect(borradorDe(carla, 'MESERO')).toMatchObject({
      id: 'C',
      entra: 'password',
      user: 'carla',
      password: '',
    })
  })

  it('sugiere el usuario a partir del nombre, sin tildes ni espacios', () => {
    expect(usuarioSugerido('María José Peña')).toBe('maria.jose.pena')
    expect(usuarioSugerido('  Ñoño  ')).toBe('nono')
    expect(usuarioSugerido('')).toBe('')
  })
})

describe('qué falta para guardar', () => {
  const people = [ana, carla]

  it('nombre y, con contraseña, un usuario válido y libre y una contraseña de al menos 8', () => {
    const b = { ...borradorDe(null, 'MESERO'), name: 'Luis' }
    expect(problemasDe(b, null, people)).toEqual([])
    expect(problemasDe({ ...b, name: ' ' }, null, people)).toEqual(['Escribe el nombre'])

    const conClave = { ...b, entra: 'password' as const, user: 'luis' }
    expect(problemasDe(conClave, null, people)).toEqual(['Escribe una contraseña'])
    expect(problemasDe({ ...conClave, password: 'corta' }, null, people)).toEqual([
      'La contraseña debe tener al menos 8 caracteres',
    ])
    expect(problemasDe({ ...conClave, password: 'larga-123' }, null, people)).toEqual([])
    expect(
      problemasDe({ ...conClave, user: ' CARLA ', password: 'larga-123' }, null, people),
    ).toEqual(['Ya hay alguien con el usuario «carla»: prueba «carla2»'])
    expect(
      problemasDe({ ...conClave, user: 'con espacio', password: 'larga-123' }, null, people),
    ).toHaveLength(1)
  })

  it('quien ya tiene contraseña no tiene que escribirla otra vez, salvo si cambia de usuario', () => {
    const b = borradorDe(carla, 'MESERO')
    expect(problemasDe(b, carla, [ana, carla])).toEqual([])
    expect(problemasDe({ ...b, user: 'carla2' }, carla, [ana, carla])).toEqual([
      'Escribe una contraseña',
    ])
  })

  it('un usuario de alguien archivado está libre', () => {
    const b = { ...borradorDe(null, 'CAJERO'), name: 'Otra', entra: 'password' as const }
    expect(
      problemasDe({ ...b, user: 'carla', password: 'larga-123' }, null, [
        { ...carla, active: false },
      ]),
    ).toEqual([])
  })
})

describe('rol que pide contraseña y tildes en el usuario', () => {
  const cashier = {
    id: 'CAJERO',
    name: 'Cajero',
    system: true,
    active: true,
    permissions: ['take_order', 'record_payment'],
    people: 1,
  }
  const waiter = { ...cashier, id: 'MESERO', name: 'Mesero', permissions: ['take_order'] }

  it('con un rol que cobra no se puede entrar con PIN', () => {
    expect(pideContrasena(cashier)).toBe(true)
    expect(pideContrasena(waiter)).toBe(false)
    const b = { ...borradorDe(null, 'CAJERO'), name: 'Pía' }
    expect(problemasDe(b, null, [], [cashier, waiter])).toEqual([
      'Con ese rol se entra con usuario y contraseña',
    ])
    expect(problemasDe({ ...b, rolId: 'MESERO' }, null, [], [cashier, waiter])).toEqual([])
  })

  it('«María» como usuario se guarda «maria»', () => {
    expect(normalizarUsuario('  María ')).toBe('maria')
    const b = {
      ...borradorDe(null, 'CAJERO'),
      name: 'María',
      entra: 'password' as const,
      user: 'María',
      password: 'larga-123',
    }
    expect(problemasDe(b, null, [], [cashier])).toEqual([])
    expect(datosPersona(b).access).toMatchObject({ user: 'maria' })
  })

  it('cuenta quiénes pueden administrar: activos, con usuario y con el permiso', () => {
    const admin = { ...cashier, id: 'ADMIN', permissions: ['manage_users'] }
    const people: PersonaPersonal[] = [
      { id: '1', name: 'A', rolId: 'ADMIN', active: true, user: 'a' },
      { id: '2', name: 'B', rolId: 'ADMIN', active: false, user: 'b' },
      { id: '3', name: 'C', rolId: 'ADMIN', active: true, user: null },
      { id: '4', name: 'D', rolId: 'CAJERO', active: true, user: 'd' },
    ]
    expect(administradoras({ roles: [admin, cashier], people }).map((p) => p.id)).toEqual(['1'])
  })
})

describe('lo que va al hub', () => {
  it('con PIN, o con usuario normalizado y la contraseña solo si se escribió', () => {
    expect(datosPersona({ ...borradorDe(null, 'MESERO'), name: ' Luis ' })).toEqual({
      name: 'Luis',
      role_id: 'MESERO',
      access: { type: 'pin' },
    })
    expect(
      datosPersona({ ...borradorDe(carla, 'X'), user: ' Carla ' }, { regenerarPin: true }),
    ).toEqual({
      id: 'C',
      name: 'Carla',
      role_id: 'CAJERO',
      access: { type: 'password', user: 'carla' },
      regenerar_pin: true,
    })
    expect(
      datosPersona({ ...borradorDe(carla, 'X'), password: 'nueva-123' }, { active: false }),
    ).toMatchObject({ access: { password: 'nueva-123' }, active: false })
  })

  it('resume un rol con sus personas y permisos', () => {
    const role = {
      id: 'R',
      name: 'Barra',
      system: false,
      active: true,
      permissions: ['a'],
      people: 3,
    }
    expect(resumenRol(role)).toBe('3 personas · 1 permiso')
    expect(resumenRol({ ...role, people: 1, permissions: [] })).toBe('1 persona · 0 permisos')
  })
})
