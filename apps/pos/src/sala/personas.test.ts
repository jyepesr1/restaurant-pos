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
  nombre: 'Ana',
  rolId: 'MESERO',
  activo: true,
  usuario: null,
}
const carla: PersonaPersonal = {
  id: 'C',
  nombre: 'Carla',
  rolId: 'CAJERO',
  activo: true,
  usuario: 'carla',
}

describe('borrador de una persona', () => {
  it('una nueva entra con PIN y con el rol sugerido; una existente, como está', () => {
    expect(borradorDe(null, 'MESERO')).toEqual({
      nombre: '',
      rolId: 'MESERO',
      entra: 'pin',
      usuario: '',
      contrasena: '',
    })
    expect(borradorDe(carla, 'MESERO')).toMatchObject({
      id: 'C',
      entra: 'contrasena',
      usuario: 'carla',
      contrasena: '',
    })
  })

  it('sugiere el usuario a partir del nombre, sin tildes ni espacios', () => {
    expect(usuarioSugerido('María José Peña')).toBe('maria.jose.pena')
    expect(usuarioSugerido('  Ñoño  ')).toBe('nono')
    expect(usuarioSugerido('')).toBe('')
  })
})

describe('qué falta para guardar', () => {
  const personas = [ana, carla]

  it('nombre y, con contraseña, un usuario válido y libre y una contraseña de al menos 8', () => {
    const b = { ...borradorDe(null, 'MESERO'), nombre: 'Luis' }
    expect(problemasDe(b, null, personas)).toEqual([])
    expect(problemasDe({ ...b, nombre: ' ' }, null, personas)).toEqual(['Escribe el nombre'])

    const conClave = { ...b, entra: 'contrasena' as const, usuario: 'luis' }
    expect(problemasDe(conClave, null, personas)).toEqual(['Escribe una contraseña'])
    expect(problemasDe({ ...conClave, contrasena: 'corta' }, null, personas)).toEqual([
      'La contraseña debe tener al menos 8 caracteres',
    ])
    expect(problemasDe({ ...conClave, contrasena: 'larga-123' }, null, personas)).toEqual([])
    expect(
      problemasDe({ ...conClave, usuario: ' CARLA ', contrasena: 'larga-123' }, null, personas),
    ).toEqual(['Ya hay alguien con el usuario «carla»: prueba «carla2»'])
    expect(
      problemasDe({ ...conClave, usuario: 'con espacio', contrasena: 'larga-123' }, null, personas),
    ).toHaveLength(1)
  })

  it('quien ya tiene contraseña no tiene que escribirla otra vez, salvo si cambia de usuario', () => {
    const b = borradorDe(carla, 'MESERO')
    expect(problemasDe(b, carla, [ana, carla])).toEqual([])
    expect(problemasDe({ ...b, usuario: 'carla2' }, carla, [ana, carla])).toEqual([
      'Escribe una contraseña',
    ])
  })

  it('un usuario de alguien archivado está libre', () => {
    const b = { ...borradorDe(null, 'CAJERO'), nombre: 'Otra', entra: 'contrasena' as const }
    expect(
      problemasDe({ ...b, usuario: 'carla', contrasena: 'larga-123' }, null, [
        { ...carla, activo: false },
      ]),
    ).toEqual([])
  })
})

describe('rol que pide contraseña y tildes en el usuario', () => {
  const cajero = {
    id: 'CAJERO',
    nombre: 'Cajero',
    sistema: true,
    activo: true,
    permisos: ['tomar_pedido', 'registrar_pago'],
    personas: 1,
  }
  const mesero = { ...cajero, id: 'MESERO', nombre: 'Mesero', permisos: ['tomar_pedido'] }

  it('con un rol que cobra no se puede entrar con PIN', () => {
    expect(pideContrasena(cajero)).toBe(true)
    expect(pideContrasena(mesero)).toBe(false)
    const b = { ...borradorDe(null, 'CAJERO'), nombre: 'Pía' }
    expect(problemasDe(b, null, [], [cajero, mesero])).toEqual([
      'Con ese rol se entra con usuario y contraseña',
    ])
    expect(problemasDe({ ...b, rolId: 'MESERO' }, null, [], [cajero, mesero])).toEqual([])
  })

  it('«María» como usuario se guarda «maria»', () => {
    expect(normalizarUsuario('  María ')).toBe('maria')
    const b = {
      ...borradorDe(null, 'CAJERO'),
      nombre: 'María',
      entra: 'contrasena' as const,
      usuario: 'María',
      contrasena: 'larga-123',
    }
    expect(problemasDe(b, null, [], [cajero])).toEqual([])
    expect(datosPersona(b).acceso).toMatchObject({ usuario: 'maria' })
  })

  it('cuenta quiénes pueden administrar: activos, con usuario y con el permiso', () => {
    const admin = { ...cajero, id: 'ADMIN', permisos: ['administrar_usuarios'] }
    const personas: PersonaPersonal[] = [
      { id: '1', nombre: 'A', rolId: 'ADMIN', activo: true, usuario: 'a' },
      { id: '2', nombre: 'B', rolId: 'ADMIN', activo: false, usuario: 'b' },
      { id: '3', nombre: 'C', rolId: 'ADMIN', activo: true, usuario: null },
      { id: '4', nombre: 'D', rolId: 'CAJERO', activo: true, usuario: 'd' },
    ]
    expect(administradoras({ roles: [admin, cajero], personas }).map((p) => p.id)).toEqual(['1'])
  })
})

describe('lo que va al hub', () => {
  it('con PIN, o con usuario normalizado y la contraseña solo si se escribió', () => {
    expect(datosPersona({ ...borradorDe(null, 'MESERO'), nombre: ' Luis ' })).toEqual({
      nombre: 'Luis',
      rol_id: 'MESERO',
      acceso: { tipo: 'pin' },
    })
    expect(
      datosPersona({ ...borradorDe(carla, 'X'), usuario: ' Carla ' }, { regenerarPin: true }),
    ).toEqual({
      id: 'C',
      nombre: 'Carla',
      rol_id: 'CAJERO',
      acceso: { tipo: 'contrasena', usuario: 'carla' },
      regenerar_pin: true,
    })
    expect(
      datosPersona({ ...borradorDe(carla, 'X'), contrasena: 'nueva-123' }, { activo: false }),
    ).toMatchObject({ acceso: { contrasena: 'nueva-123' }, activo: false })
  })

  it('resume un rol con sus personas y permisos', () => {
    const rol = {
      id: 'R',
      nombre: 'Barra',
      sistema: false,
      activo: true,
      permisos: ['a'],
      personas: 3,
    }
    expect(resumenRol(rol)).toBe('3 personas · 1 permiso')
    expect(resumenRol({ ...rol, personas: 1, permisos: [] })).toBe('1 persona · 0 permisos')
  })
})
