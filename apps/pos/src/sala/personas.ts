import { PERMISOS_CON_CONTRASENA, type Permiso } from '@pos/core'
import type { Personal } from './motor'

// Lógica de la pantalla de personal y roles (tarea 1.3b), sin React: el borrador de una persona,
// qué le falta para guardarse y qué se le manda al hub. El hub vuelve a revisar todo.

export type PersonaPersonal = Personal['personas'][number]
export type RolPersonal = Personal['roles'][number]
export type EquipoPersonal = Personal['equipos'][number]

/** Si con ese rol hay que entrar con usuario y contraseña (tiene permisos de caja o de administración). */
export const pideContrasena = (rol: RolPersonal | undefined) =>
  rol?.permisos.some((p) => PERMISOS_CON_CONTRASENA.has(p as Permiso)) ?? false

/** Quienes, activos y con usuario, pueden administrar el personal. */
export const administradoras = (datos: Pick<Personal, 'roles' | 'personas'>) =>
  datos.personas.filter(
    (p) =>
      p.activo &&
      p.usuario !== null &&
      datos.roles.find((r) => r.id === p.rolId)?.permisos.includes('administrar_usuarios'),
  )

export interface BorradorPersona {
  id?: string
  nombre: string
  rolId: string
  /** Con PIN (meseros) o con usuario y contraseña (caja, administración, reportes). */
  entra: 'pin' | 'contrasena'
  usuario: string
  /** Vacía en alguien que ya tiene contraseña: no se cambia. */
  contrasena: string
}

export const LARGO_MINIMO_CONTRASENA = 8

/** El borrador para editar a alguien, o uno vacío con el rol sugerido. */
export function borradorDe(persona: PersonaPersonal | null, rolSugerido: string): BorradorPersona {
  if (!persona) return { nombre: '', rolId: rolSugerido, entra: 'pin', usuario: '', contrasena: '' }
  return {
    id: persona.id,
    nombre: persona.nombre,
    rolId: persona.rolId,
    entra: persona.usuario ? 'contrasena' : 'pin',
    usuario: persona.usuario ?? '',
    contrasena: '',
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
function libreParecido(usuario: string, personas: readonly PersonaPersonal[]): string {
  for (let i = 2; ; i++) {
    const otro = `${usuario.slice(0, 38)}${i}`
    if (!personas.some((p) => p.activo && p.usuario === otro)) return otro
  }
}

/** Un usuario a partir del nombre («María José» → «maria.jose»), para no tener que inventarlo. */
export function usuarioSugerido(nombre: string): string {
  return nombre
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
  personas: readonly PersonaPersonal[],
  roles: readonly RolPersonal[] = [],
): string[] {
  const problemas: string[] = []
  if (!b.nombre.trim()) problemas.push('Escribe el nombre')
  if (!b.rolId) problemas.push('Elige el rol')
  else if (b.entra === 'pin' && pideContrasena(roles.find((r) => r.id === b.rolId)))
    problemas.push('Con ese rol se entra con usuario y contraseña')
  if (b.entra === 'contrasena') {
    const usuario = normalizarUsuario(b.usuario)
    if (!/^[a-z0-9._-]{3,40}$/.test(usuario))
      problemas.push(
        'El usuario lleva de 3 a 40 letras (sin tildes ni espacios), números, punto o guion',
      )
    else if (personas.some((p) => p.activo && p.id !== b.id && p.usuario === usuario))
      problemas.push(
        `Ya hay alguien con el usuario «${usuario}»: prueba «${libreParecido(usuario, personas)}»`,
      )
    // Una contraseña nueva hace falta si no tenía, o si cambia de usuario.
    const necesita = !original?.usuario || original.usuario !== usuario
    if (b.contrasena.length > 0 && b.contrasena.length < LARGO_MINIMO_CONTRASENA)
      problemas.push(`La contraseña debe tener al menos ${LARGO_MINIMO_CONTRASENA} caracteres`)
    else if (necesita && b.contrasena.length === 0) problemas.push('Escribe una contraseña')
  }
  return problemas
}

/** Lo que va al hub (`POST /api/personal/personas`). */
export function datosPersona(
  b: BorradorPersona,
  extras: { activo?: boolean; regenerarPin?: boolean } = {},
) {
  return {
    ...(b.id ? { id: b.id } : {}),
    nombre: b.nombre.trim(),
    rol_id: b.rolId,
    acceso:
      b.entra === 'pin'
        ? ({ tipo: 'pin' } as const)
        : {
            tipo: 'contrasena' as const,
            usuario: normalizarUsuario(b.usuario),
            ...(b.contrasena ? { contrasena: b.contrasena } : {}),
          },
    ...(extras.activo === undefined ? {} : { activo: extras.activo }),
    ...(extras.regenerarPin ? { regenerar_pin: true } : {}),
  }
}

/** «3 personas · 12 permisos». */
export function resumenRol(rol: RolPersonal): string {
  const personas = `${rol.personas} ${rol.personas === 1 ? 'persona' : 'personas'}`
  const permisos = `${rol.permisos.length} ${rol.permisos.length === 1 ? 'permiso' : 'permisos'}`
  return `${personas} · ${permisos}`
}
