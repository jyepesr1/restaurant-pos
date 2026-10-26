import { PASSWORD_PERMISSIONS, type Permission } from '@pos/core'
import type { Staff } from './engine'

// Logic of the staff and roles screen (task 1.3b), without React: a person's draft, what it is
// missing to be saved and what is sent to the hub. The hub checks everything again.

export type StaffMember = Staff['people'][number]
export type StaffRole = Staff['roles'][number]
export type StaffDevice = Staff['devices'][number]

/** Whether that role signs in with username and password (it has register or admin permissions). */
export const asksPassword = (role: StaffRole | undefined) =>
  role?.permissions.some((p) => PASSWORD_PERMISSIONS.has(p as Permission)) ?? false

/** Those who, active and with a username, can manage staff. */
export const adminStaff = (data: Pick<Staff, 'roles' | 'people'>) =>
  data.people.filter(
    (p) =>
      p.active &&
      p.user !== null &&
      data.roles.find((r) => r.id === p.roleId)?.permissions.includes('manage_users'),
  )

export interface StaffMemberDraft {
  id?: string
  name: string
  roleId: string
  /** With PIN (waiters) or with username and password (register, admin, reports). */
  signInMethod: 'pin' | 'password'
  user: string
  /** Empty for someone who already has a password: it is not changed. */
  password: string
}

export const PASSWORD_MIN_LENGTH = 8

/** The draft to edit someone, or an empty one with the suggested role. */
export function draftOf(person: StaffMember | null, suggestedRole: string): StaffMemberDraft {
  if (!person)
    return { name: '', roleId: suggestedRole, signInMethod: 'pin', user: '', password: '' }
  return {
    id: person.id,
    name: person.name,
    roleId: person.roleId,
    signInMethod: person.user ? 'password' : 'pin',
    user: person.user ?? '',
    password: '',
  }
}

/**
 * The username as the hub saves it: no surrounding spaces, lowercase and without accents (whoever
 * types «maría» meant «maria»).
 */
export const normalizeUsername = (u: string) =>
  u
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

/** «maria2», «maria3»…: the first one no active person has. */
function similarFree(user: string, people: readonly StaffMember[]): string {
  for (let i = 2; ; i++) {
    const other = `${user.slice(0, 38)}${i}`
    if (!people.some((p) => p.active && p.user === other)) return other
  }
}

/** A username from the name («María José» → «maria.jose»), so nobody has to make one up. */
export function suggestedUsername(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 40)
}

/** What is missing or invalid, in the order shown on screen. Empty: it can be saved. */
export function issuesOf(
  b: StaffMemberDraft,
  original: StaffMember | null,
  people: readonly StaffMember[],
  roles: readonly StaffRole[] = [],
): string[] {
  const issues: string[] = []
  if (!b.name.trim()) issues.push('Escribe el nombre')
  if (!b.roleId) issues.push('Elige el rol')
  else if (b.signInMethod === 'pin' && asksPassword(roles.find((r) => r.id === b.roleId)))
    issues.push('Con ese rol se entra con usuario y contraseña')
  if (b.signInMethod === 'password') {
    const user = normalizeUsername(b.user)
    if (!/^[a-z0-9._-]{3,40}$/.test(user))
      issues.push(
        'El usuario lleva de 3 a 40 letras (sin tildes ni espacios), números, punto o guion',
      )
    else if (people.some((p) => p.active && p.id !== b.id && p.user === user))
      issues.push(`Ya hay alguien con el usuario «${user}»: prueba «${similarFree(user, people)}»`)
    // A new password is needed if there was none, or if the username changes.
    const needs = !original?.user || original.user !== user
    if (b.password.length > 0 && b.password.length < PASSWORD_MIN_LENGTH)
      issues.push(`La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`)
    else if (needs && b.password.length === 0) issues.push('Escribe una contraseña')
  }
  return issues
}

/** What goes to the hub (`POST /api/staff/people`). */
export function staffMemberData(
  b: StaffMemberDraft,
  extras: { active?: boolean; regeneratePin?: boolean } = {},
) {
  return {
    ...(b.id ? { id: b.id } : {}),
    name: b.name.trim(),
    role_id: b.roleId,
    access:
      b.signInMethod === 'pin'
        ? ({ type: 'pin' } as const)
        : {
            type: 'password' as const,
            user: normalizeUsername(b.user),
            ...(b.password ? { password: b.password } : {}),
          },
    ...(extras.active === undefined ? {} : { active: extras.active }),
    ...(extras.regeneratePin ? { regenerate_pin: true } : {}),
  }
}

/** «3 personas · 12 permisos». */
export function roleSummary(role: StaffRole): string {
  const people = `${role.people} ${role.people === 1 ? 'persona' : 'personas'}`
  const permissions = `${role.permissions.length} ${role.permissions.length === 1 ? 'permiso' : 'permisos'}`
  return `${people} · ${permissions}`
}
