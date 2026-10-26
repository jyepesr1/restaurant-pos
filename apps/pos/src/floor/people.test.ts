import { describe, expect, it } from 'vitest'
import {
  adminStaff,
  asksPassword,
  draftOf,
  issuesOf,
  normalizeUsername,
  roleSummary,
  type StaffMember,
  staffMemberData,
  suggestedUsername,
} from './people'

// The logic of the staff and roles screen (task 1.3b).

const ana: StaffMember = {
  id: 'A',
  name: 'Ana',
  roleId: 'MESERO',
  active: true,
  user: null,
}
const carla: StaffMember = {
  id: 'C',
  name: 'Carla',
  roleId: 'CAJERO',
  active: true,
  user: 'carla',
}

describe('a person draft', () => {
  it('a new one signs in with a PIN and the suggested role; an existing one, as it is', () => {
    expect(draftOf(null, 'MESERO')).toEqual({
      name: '',
      roleId: 'MESERO',
      signInMethod: 'pin',
      user: '',
      password: '',
    })
    expect(draftOf(carla, 'MESERO')).toMatchObject({
      id: 'C',
      signInMethod: 'password',
      user: 'carla',
      password: '',
    })
  })

  it('suggests the username from the name, without accents or spaces', () => {
    expect(suggestedUsername('María José Peña')).toBe('maria.jose.pena')
    expect(suggestedUsername('  Ñoño  ')).toBe('nono')
    expect(suggestedUsername('')).toBe('')
  })
})

describe('what is missing to save', () => {
  const people = [ana, carla]

  it('name and, with password, a valid and free username and a password of at least 8', () => {
    const b = { ...draftOf(null, 'MESERO'), name: 'Luis' }
    expect(issuesOf(b, null, people)).toEqual([])
    expect(issuesOf({ ...b, name: ' ' }, null, people)).toEqual(['Escribe el nombre'])

    const withKey = { ...b, signInMethod: 'password' as const, user: 'luis' }
    expect(issuesOf(withKey, null, people)).toEqual(['Escribe una contraseña'])
    expect(issuesOf({ ...withKey, password: 'corta' }, null, people)).toEqual([
      'La contraseña debe tener al menos 8 caracteres',
    ])
    expect(issuesOf({ ...withKey, password: 'larga-123' }, null, people)).toEqual([])
    expect(issuesOf({ ...withKey, user: ' CARLA ', password: 'larga-123' }, null, people)).toEqual([
      'Ya hay alguien con el usuario «carla»: prueba «carla2»',
    ])
    expect(
      issuesOf({ ...withKey, user: 'con espacio', password: 'larga-123' }, null, people),
    ).toHaveLength(1)
  })

  it('someone who already has a password does not have to type it again, unless the username changes', () => {
    const b = draftOf(carla, 'MESERO')
    expect(issuesOf(b, carla, [ana, carla])).toEqual([])
    expect(issuesOf({ ...b, user: 'carla2' }, carla, [ana, carla])).toEqual([
      'Escribe una contraseña',
    ])
  })

  it('the username of someone archived is free', () => {
    const b = { ...draftOf(null, 'CAJERO'), name: 'Otra', signInMethod: 'password' as const }
    expect(
      issuesOf({ ...b, user: 'carla', password: 'larga-123' }, null, [{ ...carla, active: false }]),
    ).toEqual([])
  })
})

describe('role that requires a password and accents in the username', () => {
  const cashier = {
    id: 'CAJERO',
    name: 'Cajero',
    system: true,
    active: true,
    permissions: ['take_order', 'record_payment'],
    people: 1,
  }
  const waiter = { ...cashier, id: 'MESERO', name: 'Mesero', permissions: ['take_order'] }

  it('with a role that takes payments you cannot sign in with a PIN', () => {
    expect(asksPassword(cashier)).toBe(true)
    expect(asksPassword(waiter)).toBe(false)
    const b = { ...draftOf(null, 'CAJERO'), name: 'Pía' }
    expect(issuesOf(b, null, [], [cashier, waiter])).toEqual([
      'Con ese rol se entra con usuario y contraseña',
    ])
    expect(issuesOf({ ...b, roleId: 'MESERO' }, null, [], [cashier, waiter])).toEqual([])
  })

  it('«María» as a username is saved as «maria»', () => {
    expect(normalizeUsername('  María ')).toBe('maria')
    const b = {
      ...draftOf(null, 'CAJERO'),
      name: 'María',
      signInMethod: 'password' as const,
      user: 'María',
      password: 'larga-123',
    }
    expect(issuesOf(b, null, [], [cashier])).toEqual([])
    expect(staffMemberData(b).access).toMatchObject({ user: 'maria' })
  })

  it('counts who can administer: active, with a username and with the permission', () => {
    const admin = { ...cashier, id: 'ADMIN', permissions: ['manage_users'] }
    const people: StaffMember[] = [
      { id: '1', name: 'A', roleId: 'ADMIN', active: true, user: 'a' },
      { id: '2', name: 'B', roleId: 'ADMIN', active: false, user: 'b' },
      { id: '3', name: 'C', roleId: 'ADMIN', active: true, user: null },
      { id: '4', name: 'D', roleId: 'CAJERO', active: true, user: 'd' },
    ]
    expect(adminStaff({ roles: [admin, cashier], people }).map((p) => p.id)).toEqual(['1'])
  })
})

describe('what goes to the hub', () => {
  it('with a PIN, or with a normalized username and the password only if it was typed', () => {
    expect(staffMemberData({ ...draftOf(null, 'MESERO'), name: ' Luis ' })).toEqual({
      name: 'Luis',
      role_id: 'MESERO',
      access: { type: 'pin' },
    })
    expect(
      staffMemberData({ ...draftOf(carla, 'X'), user: ' Carla ' }, { regeneratePin: true }),
    ).toEqual({
      id: 'C',
      name: 'Carla',
      role_id: 'CAJERO',
      access: { type: 'password', user: 'carla' },
      regenerate_pin: true,
    })
    expect(
      staffMemberData({ ...draftOf(carla, 'X'), password: 'nueva-123' }, { active: false }),
    ).toMatchObject({ access: { password: 'nueva-123' }, active: false })
  })

  it('summarizes a role with its people and permissions', () => {
    const role = {
      id: 'R',
      name: 'Barra',
      system: false,
      active: true,
      permissions: ['a'],
      people: 3,
    }
    expect(roleSummary(role)).toBe('3 personas · 1 permiso')
    expect(roleSummary({ ...role, people: 1, permissions: [] })).toBe('1 persona · 0 permisos')
  })
})
