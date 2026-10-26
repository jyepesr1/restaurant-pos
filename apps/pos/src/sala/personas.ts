import { PASSWORD_PERMISSIONS, type Permission } from '@pos/core'
import type { Personal } from './motor'

// Lógica de la pantalla de personal y roles (tarea 1.3b), sin React: el borrador de una persona,
// qué le falta para guardarse y qué se le manda al hub. El hub vuelve a revisar todo.

export type PersonaPersonal = Personal['people'][number]
export type RolPersonal = Personal['roles'][number]
export type EquipoPersonal = Personal['devices'][number]

/** Si con ese rol hay que entrar con usuario y contraseña (tiene permisos de caja o de administración). */
export const pideContrasena = (role: RolPersonal | undefined) =>
  role?.permissions.some((p) => PASSWORD_PERMISSIONS.has(p as Permission)) ?? false

/** Quienes, activos y con usuario, pueden administrar el personal. */
export const administradoras = (data: Pick<Personal, 'roles' | 'people'>) =>
  data.people.filter(
    (p) =>
      p.active &&
      p.user !== null &&
      data.roles.find((r) => r.id === p.rolId)?.permissions.includes('manage_users'),
  )

export interface BorradorPersona {
  id?: string
  name: string
  rolId: string
  /** Con PIN (meseros) o con usuario y contraseña (caja, administración, reportes). */
  entra: 'pin' | 'password'
  user: string
  /** Vacía en alguien que ya tiene contraseña: no se cambia. */
  password: string
}

export const LARGO_MINIMO_CONTRASENA = 8

/** El borrador para editar a alguien, o uno vacío con el rol sugerido. */
export function borradorDe(persona: PersonaPersonal | null, rolSugerido: string): BorradorPersona {
  if (!persona) return { name: '', rolId: rolSugerido, entra: 'pin', user: '', password: '' }
  return {
    id: persona.id,
    name: persona.name,
    rolId: persona.rolId,
    entra: persona.user ? 'password' : 'pin',
    user: persona.user ?? '',
    password: '',
  }
}

/**
 * El usuario como lo guarda el hub: sin espacios a los lados, en minúsculas y sin tildes (quien
 * escribe «maría» quiso decir «maria»).
 */
export const normalizarUsuario = (u: string) =>
  u
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

/** «maria2», «maria3»…: el primero que nadie activo tiene. */
function libreParecido(user: string, people: readonly PersonaPersonal[]): string {
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
  original: PersonaPersonal | null,
  people: readonly PersonaPersonal[],
  roles: readonly RolPersonal[] = [],
): string[] {
  const issues: string[] = []
  if (!b.name.trim()) issues.push('Escribe el nombre')
  if (!b.rolId) issues.push('Elige el rol')
  else if (b.entra === 'pin' && pideContrasena(roles.find((r) => r.id === b.rolId)))
    issues.push('Con ese rol se entra con usuario y contraseña')
  if (b.entra === 'password') {
    const user = normalizarUsuario(b.user)
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
    if (b.password.length > 0 && b.password.length < LARGO_MINIMO_CONTRASENA)
      issues.push(`La contraseña debe tener al menos ${LARGO_MINIMO_CONTRASENA} caracteres`)
    else if (necesita && b.password.length === 0) issues.push('Escribe una contraseña')
  }
  return issues
}

/** Lo que va al hub (`POST /api/personal/personas`). */
export function datosPersona(
  b: BorradorPersona,
  extras: { active?: boolean; regenerarPin?: boolean } = {},
) {
  return {
    ...(b.id ? { id: b.id } : {}),
    name: b.name.trim(),
    role_id: b.rolId,
    access:
      b.entra === 'pin'
        ? ({ type: 'pin' } as const)
        : {
            type: 'password' as const,
            user: normalizarUsuario(b.user),
            ...(b.password ? { password: b.password } : {}),
          },
    ...(extras.active === undefined ? {} : { active: extras.active }),
    ...(extras.regenerarPin ? { regenerar_pin: true } : {}),
  }
}

/** «3 personas · 12 permisos». */
export function resumenRol(role: RolPersonal): string {
  const people = `${role.people} ${role.people === 1 ? 'persona' : 'personas'}`
  const permissions = `${role.permissions.length} ${role.permissions.length === 1 ? 'permiso' : 'permisos'}`
  return `${people} · ${permissions}`
}
