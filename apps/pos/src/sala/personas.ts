import { PASSWORD_PERMISSIONS, type Permission } from '@pos/core'
import type { Personal } from './motor'

// Lógica de la pantalla de personal y roles (tarea 1.3b), sin React: el borrador de una persona,
// qué le falta para guardarse y qué se le manda al hub. El hub vuelve a revisar todo.

export type StaffMember = Personal['people'][number]
export type StaffRole = Personal['roles'][number]
export type StaffDevice = Personal['devices'][number]

/** Si con ese rol hay que entrar con usuario y contraseña (tiene permisos de caja o de administración). */
export const pideContrasena = (role: StaffRole | undefined) =>
  role?.permissions.some((p) => PASSWORD_PERMISSIONS.has(p as Permission)) ?? false

/** Quienes, activos y con usuario, pueden administrar el personal. */
export const administradoras = (data: Pick<Personal, 'roles' | 'people'>) =>
  data.people.filter(
    (p) =>
      p.active &&
      p.user !== null &&
      data.roles.find((r) => r.id === p.roleId)?.permissions.includes('manage_users'),
  )

export interface BorradorPersona {
  id?: string
  name: string
  roleId: string
  /** Con PIN (meseros) o con usuario y contraseña (caja, administración, reportes). */
  signInMethod: 'pin' | 'password'
  user: string
  /** Vacía en alguien que ya tiene contraseña: no se cambia. */
  password: string
}

export const PASSWORD_MIN_LENGTH = 8

/** El borrador para editar a alguien, o uno vacío con el rol sugerido. */
export function borradorDe(person: StaffMember | null, rolSugerido: string): BorradorPersona {
  if (!person) return { name: '', roleId: rolSugerido, signInMethod: 'pin', user: '', password: '' }
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
 * El usuario como lo guarda el hub: sin espacios a los lados, en minúsculas y sin tildes (quien
 * escribe «maría» quiso decir «maria»).
 */
export const normalizeUsername = (u: string) =>
  u
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

/** «maria2», «maria3»…: el primero que nadie activo tiene. */
function libreParecido(user: string, people: readonly StaffMember[]): string {
  for (let i = 2; ; i++) {
    const other = `${user.slice(0, 38)}${i}`
    if (!people.some((p) => p.active && p.user === other)) return other
  }
}

/** Un usuario a partir del nombre («María José» → «maria.jose»), para no tener que inventarlo. */
export function usuarioSugerido(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 40)
}

/** Lo que falta o no sirve, en el orden en que se ve en la pantalla. Vacío: se puede guardar. */
export function problemasDe(
  b: BorradorPersona,
  original: StaffMember | null,
  people: readonly StaffMember[],
  roles: readonly StaffRole[] = [],
): string[] {
  const issues: string[] = []
  if (!b.name.trim()) issues.push('Escribe el nombre')
  if (!b.roleId) issues.push('Elige el rol')
  else if (b.signInMethod === 'pin' && pideContrasena(roles.find((r) => r.id === b.roleId)))
    issues.push('Con ese rol se entra con usuario y contraseña')
  if (b.signInMethod === 'password') {
    const user = normalizeUsername(b.user)
    if (!/^[a-z0-9._-]{3,40}$/.test(user))
      issues.push(
        'El usuario lleva de 3 a 40 letras (sin tildes ni espacios), números, punto o guion',
      )
    else if (people.some((p) => p.active && p.id !== b.id && p.user === user))
      issues.push(
        `Ya hay alguien con el usuario «${user}»: prueba «${libreParecido(user, people)}»`,
      )
    // Una contraseña nueva hace falta si no tenía, o si cambia de usuario.
    const necesita = !original?.user || original.user !== user
    if (b.password.length > 0 && b.password.length < PASSWORD_MIN_LENGTH)
      issues.push(`La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`)
    else if (necesita && b.password.length === 0) issues.push('Escribe una contraseña')
  }
  return issues
}

/** Lo que va al hub (`POST /api/personal/personas`). */
export function datosPersona(
  b: BorradorPersona,
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
export function resumenRol(role: StaffRole): string {
  const people = `${role.people} ${role.people === 1 ? 'persona' : 'personas'}`
  const permissions = `${role.permissions.length} ${role.permissions.length === 1 ? 'permiso' : 'permisos'}`
  return `${people} · ${permissions}`
}
