import { nuevoId, PERMISOS } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { crearServidor } from '../servidor'
import { asegurarAdministrador, asegurarRoles } from './inicial'
import { montarAcceso } from './montaje'
import { ErrorPersonal, guardarPersona, guardarRol, leerPersonal } from './personal'
import { insertarVersionado, SISTEMA } from './registros'
import { huellaPin } from './secretos'
import { ServicioAcceso } from './servicio'

// Dos restaurantes en la misma base (ADR-013, multirestaurante): usuarios, roles, PIN, contraseñas,
// sesiones y equipos son por `restaurante_id`. Nada de uno debe verse ni cambiarse desde el otro,
// ni siquiera con la misma clave del hub (el peor caso: huellas calculadas con la misma clave).

const CLAVE = Buffer.alloc(32, 7)

function dosRestaurantes() {
  const a = montarAcceso()
  const { db } = a
  const ahora = a.reloj()
  const idB = nuevoId()
  db.prepare(
    `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
     VALUES (?, ?, ?, ?, 1, 'Otro restaurante', '{}')`,
  ).run(idB, idB, ahora, ahora)
  db.prepare("INSERT INTO contador (restaurante_id, nombre, valor) VALUES (?, 'catalogo', 1)").run(
    idB,
  )
  insertarVersionado(
    db,
    'sede',
    idB,
    { nombre: 'Principal', direccion: null, zona_horaria: 'America/Bogota' },
    SISTEMA,
    ahora,
  )
  const rolesB = asegurarRoles(db, idB, ahora)
  const accesoB = new ServicioAcceso({
    db,
    restauranteId: idB,
    clave: CLAVE,
    reloj: a.reloj,
    costoContrasena: 1,
  })
  const adminB = accesoB.crearUsuario({
    nombre: 'Administrador B',
    rolId: rolesB.admin,
    usuario: 'admin',
    contrasena: 'clave-del-admin-b',
  })
  const appA = crearServidor({
    acceso: a.acceso,
    catalogo: { db, restauranteId: a.restauranteId, acceso: a.acceso, reloj: a.reloj },
  })
  const appB = crearServidor({
    acceso: accesoB,
    catalogo: { db, restauranteId: idB, acceso: accesoB, reloj: a.reloj },
  })
  const llamar = (app: typeof appA) => (url: string, cuerpo: unknown, token?: string) =>
    app.inject({
      method: 'POST',
      url,
      payload: cuerpo as object,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  return {
    a,
    db,
    idA: a.restauranteId,
    idB,
    rolesB,
    accesoA: a.acceso,
    accesoB,
    adminB,
    postA: llamar(appA),
    postB: llamar(appB),
  }
}

const conCajaEnAmbos = () => {
  const m = dosRestaurantes()
  const cajaA = m.accesoA.crearUsuario({
    nombre: 'Caja A',
    rolId: m.a.roles.cajero,
    usuario: 'caja',
    contrasena: 'clave-de-la-caja-a',
  })
  const cajaB = m.accesoB.crearUsuario({
    nombre: 'Caja B',
    rolId: m.rolesB.cajero,
    usuario: 'caja',
    contrasena: 'clave-de-la-caja-b',
  })
  return { ...m, cajaA, cajaB }
}

describe('el mismo usuario en dos restaurantes', () => {
  it('cada contraseña sirve solo en su restaurante, y entra la persona de ese restaurante', () => {
    const m = conCajaEnAmbos()
    const enA = m.accesoA.entrar(
      { usuario: 'caja', contrasena: 'clave-de-la-caja-a' },
      null,
      '10.0.0.1',
    )
    const enB = m.accesoB.entrar(
      { usuario: 'caja', contrasena: 'clave-de-la-caja-b' },
      null,
      '10.0.0.1',
    )
    expect(enA).toMatchObject({ ok: true, usuario: { id: m.cajaA.usuarioId, nombre: 'Caja A' } })
    expect(enB).toMatchObject({ ok: true, usuario: { id: m.cajaB.usuarioId, nombre: 'Caja B' } })
    // Cruzadas, no entran.
    expect(
      m.accesoA.entrar({ usuario: 'caja', contrasena: 'clave-de-la-caja-b' }, null, '10.0.0.2'),
    ).toMatchObject({
      ok: false,
      codigo: 'credenciales_incorrectas',
    })
    expect(
      m.accesoB.entrar({ usuario: 'caja', contrasena: 'clave-de-la-caja-a' }, null, '10.0.0.2'),
    ).toMatchObject({
      ok: false,
      codigo: 'credenciales_incorrectas',
    })
  })

  it('un usuario que solo existe en el otro restaurante falla igual que uno inventado', () => {
    const m = conCajaEnAmbos()
    const soloB = m.accesoB.crearUsuario({
      nombre: 'Solo B',
      rolId: m.rolesB.cajero,
      usuario: 'solo.b',
      contrasena: 'clave-solo-b-1',
    })
    expect(soloB.usuarioId).toBeTruthy()
    const dePrueba = m.accesoA.entrar(
      { usuario: 'solo.b', contrasena: 'clave-solo-b-1' },
      null,
      '10.0.0.3',
    )
    const inventado = m.accesoA.entrar(
      { usuario: 'inventado', contrasena: 'clave-solo-b-1' },
      null,
      '10.0.0.4',
    )
    expect(dePrueba).toEqual(inventado)
  })

  it('el administrador «admin» de cada restaurante es independiente: cambiar la contraseña de uno no toca al otro', () => {
    const m = conCajaEnAmbos()
    const adminA = m.a.personas.admin
    m.accesoA.ponerContrasena(adminA.usuarioId, 'admin', 'nueva-clave-de-a-1')
    expect(
      m.accesoB.entrar({ usuario: 'admin', contrasena: 'clave-del-admin-b' }, null, '10.0.0.5'),
    ).toMatchObject({ ok: true })
    expect(
      m.accesoA.entrar(
        { usuario: 'admin', contrasena: adminA.contrasena as string },
        null,
        '10.0.0.6',
      ),
    ).toMatchObject({ ok: false })
    expect(
      m.accesoA.entrar({ usuario: 'admin', contrasena: 'nueva-clave-de-a-1' }, null, '10.0.0.7'),
    ).toMatchObject({ ok: true })
  })

  it('archivar «caja» en un restaurante libera el usuario allí y no toca al «caja» del otro', () => {
    const m = conCajaEnAmbos()
    const sesionB = m.accesoB.entrar(
      { usuario: 'caja', contrasena: 'clave-de-la-caja-b' },
      null,
      '10.0.0.8',
    )
    expect(sesionB).toMatchObject({ ok: true })
    m.accesoA.archivarUsuario(m.cajaA.usuarioId)
    expect(
      m.accesoA.entrar({ usuario: 'caja', contrasena: 'clave-de-la-caja-a' }, null, '10.0.0.9'),
    ).toMatchObject({ ok: false })
    expect(
      m.accesoB.entrar({ usuario: 'caja', contrasena: 'clave-de-la-caja-b' }, null, '10.0.0.10'),
    ).toMatchObject({ ok: true })
    // Y el usuario queda libre en A para otra persona.
    expect(() =>
      m.accesoA.crearUsuario({
        nombre: 'Nueva caja',
        rolId: m.a.roles.cajero,
        usuario: 'caja',
        contrasena: 'otra-clave-nueva-1',
      }),
    ).not.toThrow()
  })

  it('cambiar o quitar la contraseña de «caja» en A no cierra la sesión del «caja» de B', () => {
    const m = conCajaEnAmbos()
    const equipoB = m.accesoB.entrar(
      { usuario: 'caja', contrasena: 'clave-de-la-caja-b' },
      null,
      '10.0.0.11',
    )
    if (!equipoB.ok || !equipoB.equipo) throw new Error('no entró')
    const conexionB = m.accesoB.autenticar(equipoB.equipo.token)
    if (!conexionB) throw new Error('sin conexión')
    m.accesoA.ponerContrasena(m.cajaA.usuarioId, 'caja', 'clave-nueva-de-a-1')
    m.accesoA.quitarContrasena(m.cajaA.usuarioId)
    const sesionAbierta = m.accesoB.usuarioConPermiso(
      conexionB,
      { sesionId: equipoB.sesionId, secreto: equipoB.secreto },
      'registrar_pago',
    )
    expect(sesionAbierta).toMatchObject({ ok: true, usuarioId: m.cajaB.usuarioId })
  })
})

describe('el mismo PIN en dos restaurantes', () => {
  /** Fuerza que dos personas de restaurantes distintos tengan los mismos 4 dígitos. */
  function mismoPin() {
    const m = dosRestaurantes()
    const meseroA = m.accesoA.crearUsuario({ nombre: 'Mesera A', rolId: m.a.roles.mesero })
    const meseroB = m.accesoB.crearUsuario({ nombre: 'Mesera B', rolId: m.rolesB.mesero })
    const fijar = (restaurante: string, usuarioId: string) =>
      m.db
        .prepare('UPDATE usuario_credencial SET pin_huella = ? WHERE usuario_id = ?')
        .run(huellaPin(CLAVE, restaurante, '4821'), usuarioId)
    fijar(m.idA, meseroA.usuarioId)
    fijar(m.idB, meseroB.usuarioId)
    return { ...m, meseroA, meseroB }
  }

  it('el PIN lleva a la persona de ese restaurante, y la huella de uno no es la del otro', () => {
    const m = mismoPin()
    expect(huellaPin(CLAVE, m.idA, '4821')).not.toBe(huellaPin(CLAVE, m.idB, '4821'))
    expect(m.accesoA.entrar({ pin: '4821' }, null, '10.0.1.1')).toMatchObject({
      ok: true,
      usuario: { nombre: 'Mesera A' },
    })
    expect(m.accesoB.entrar({ pin: '4821' }, null, '10.0.1.2')).toMatchObject({
      ok: true,
      usuario: { nombre: 'Mesera B' },
    })
  })

  it('un PIN de B no entra en A si en A nadie lo tiene', () => {
    const m = mismoPin()
    const soloB = m.accesoB.crearUsuario({ nombre: 'Solo B', rolId: m.rolesB.mesero })
    expect(soloB.pin).toMatch(/^\d{4}$/)
    // Con 10 000 PIN posibles puede coincidir por azar con alguno de A; se compara contra A.
    const enA = m.accesoA.entrar({ pin: soloB.pin }, null, '10.0.1.3')
    const dueñoEnA = [
      m.a.personas.mesero.pin,
      m.a.personas.mesero2.pin,
      m.a.personas.cajero.pin,
      m.a.personas.gerente.pin,
      '4821',
    ]
    if (!dueñoEnA.includes(soloB.pin))
      expect(enA).toMatchObject({ ok: false, codigo: 'pin_incorrecto' })
  })

  it('archivar a la persona de A deja libre el PIN en A y no toca el de B', () => {
    const m = mismoPin()
    m.accesoA.archivarUsuario(m.meseroA.usuarioId)
    expect(m.accesoA.entrar({ pin: '4821' }, null, '10.0.1.4')).toMatchObject({ ok: false })
    expect(m.accesoB.entrar({ pin: '4821' }, null, '10.0.1.5')).toMatchObject({ ok: true })
  })

  it('regenerar el PIN en A no cambia el de B', () => {
    const m = mismoPin()
    m.accesoA.regenerarPin(m.meseroA.usuarioId)
    expect(m.accesoB.entrar({ pin: '4821' }, null, '10.0.1.6')).toMatchObject({
      ok: true,
      usuario: { nombre: 'Mesera B' },
    })
  })

  it('el PIN de autorización de un administrador de B no autoriza en A', () => {
    const m = mismoPin()
    const entrada = m.accesoA.entrar({ pin: '4821' }, null, '10.0.1.7')
    if (!entrada.ok || !entrada.equipo) throw new Error('no entró')
    const conexion = m.accesoA.autenticar(entrada.equipo.token)
    if (!conexion) throw new Error('sin conexión')
    const r = m.accesoA.autorizar(conexion, {
      sesionId: entrada.sesionId,
      secreto: entrada.secreto,
      pin: m.adminB.pin,
      accion: 'anular_item_enviado',
      agregadoId: '0'.repeat(26),
      eventoId: '1'.repeat(26),
      huella: 'a'.repeat(64),
    })
    expect(r).toMatchObject({ ok: false })
    if (!m.a.personas.admin.pin.includes(m.adminB.pin))
      expect(r).toMatchObject({ codigo: 'pin_incorrecto' })
  })
})

describe('sesiones, equipos y permisos no cruzan', () => {
  it('el token de un equipo de A no existe en B, ni al revés', () => {
    const m = conCajaEnAmbos()
    const a = m.accesoA.entrar({ pin: m.a.personas.mesero.pin }, null, '10.0.2.1')
    const b = m.accesoB.entrar(
      { usuario: 'caja', contrasena: 'clave-de-la-caja-b' },
      null,
      '10.0.2.2',
    )
    if (!a.ok || !a.equipo || !b.ok || !b.equipo) throw new Error('no entraron')
    expect(m.accesoA.autenticar(a.equipo.token)).not.toBeNull()
    expect(m.accesoB.autenticar(a.equipo.token)).toBeNull()
    expect(m.accesoA.autenticar(b.equipo.token)).toBeNull()
  })

  it('por la API: el token y la sesión de A en el servidor de B dan 401 en todo', async () => {
    const m = conCajaEnAmbos()
    const r = await m.postA('/api/entrar', {
      usuario: m.a.personas.admin.usuario,
      contrasena: m.a.personas.admin.contrasena,
    })
    const cuerpo = r.json()
    const sesion = { sesion_id: cuerpo.sesion_id, secreto: cuerpo.secreto }
    const token = cuerpo.equipo.token
    for (const url of ['/api/personal/leer', '/api/personal/roles', '/api/personal/personas'])
      expect((await m.postB(url, sesion, token)).statusCode, url).toBe(401)
    expect((await m.postB('/api/entrar', { pin: m.a.personas.mesero.pin }, token)).statusCode).toBe(
      401,
    )
    expect((await m.postB('/api/sesiones/cerrar', sesion, token)).statusCode).toBe(401)
    // En A sí sirve.
    expect((await m.postA('/api/personal/leer', sesion, token)).statusCode).toBe(200)
  })

  it('la sesión de B no vale en A ni con el equipo correcto de A (mismo token, sesión ajena)', async () => {
    const m = conCajaEnAmbos()
    const enA = m.accesoA.entrar(
      {
        usuario: m.a.personas.admin.usuario as string,
        contrasena: m.a.personas.admin.contrasena as string,
      },
      null,
      '10.0.2.3',
    )
    const enB = m.accesoB.entrar(
      { usuario: 'admin', contrasena: 'clave-del-admin-b' },
      null,
      '10.0.2.4',
    )
    if (!enA.ok || !enA.equipo || !enB.ok) throw new Error('no entraron')
    const r = await m.postA(
      '/api/personal/leer',
      { sesion_id: enB.sesionId, secreto: enB.secreto },
      enA.equipo.token,
    )
    expect(r.statusCode).toBe(401)
    expect(r.json()).toMatchObject({ error: 'sesion_invalida' })
  })

  it('los permisos de un usuario de A son vacíos vistos desde B, y cambiar un rol de A no cambia el de B', () => {
    const m = conCajaEnAmbos()
    expect(m.accesoB.permisosDe(m.a.personas.admin.usuarioId)).toEqual([])
    expect(m.accesoA.permisosDe(m.adminB.usuarioId)).toEqual([])
    const antes = m.accesoB.permisosDe(m.cajaB.usuarioId)
    guardarRol(
      m.db,
      m.idA,
      m.accesoA,
      { id: m.a.roles.cajero, nombre: 'Cajero', permisos: ['tomar_pedido'] },
      SISTEMA,
      m.a.reloj(),
    )
    expect(m.accesoA.permisosDe(m.cajaA.usuarioId)).toEqual(['tomar_pedido'])
    expect(m.accesoB.permisosDe(m.cajaB.usuarioId)).toEqual(antes)
    expect(antes.length).toBeGreaterThan(5)
  })

  it('un rol de A tiene nombre repetido en B sin chocar: cada restaurante tiene su «Mesero» y su «Cajero»', () => {
    const m = dosRestaurantes()
    const nombres = (id: string) =>
      m.db
        .prepare('SELECT nombre FROM rol WHERE restaurante_id = ? AND sistema = 1 ORDER BY nombre')
        .all(id)
        .map((f) => f.nombre)
    expect(nombres(m.idA)).toEqual(nombres(m.idB))
    expect(m.a.roles.mesero).not.toBe(m.rolesB.mesero)
  })

  it('dos restaurantes tienen su propio administrador y cada rol Administrador conserva todos los permisos', () => {
    const m = dosRestaurantes()
    const esperados = PERMISOS.filter((p) => p !== 'ver_reportes_propios').sort()
    expect(m.accesoA.permisosDe(m.a.personas.admin.usuarioId)).toEqual(esperados)
    expect(m.accesoB.permisosDe(m.adminB.usuarioId)).toEqual(esperados)
  })

  it('revocar desde A un equipo de B: «ese equipo no existe», y B no se entera', () => {
    const m = conCajaEnAmbos()
    const a = m.accesoA.entrar(
      {
        usuario: m.a.personas.admin.usuario as string,
        contrasena: m.a.personas.admin.contrasena as string,
      },
      null,
      '10.0.2.5',
    )
    const b = m.accesoB.entrar({ pin: '0000' }, null, '10.0.2.6')
    expect(b).toMatchObject({ ok: false })
    const cajaB = m.accesoB.entrar(
      { usuario: 'caja', contrasena: 'clave-de-la-caja-b' },
      null,
      '10.0.2.7',
    )
    if (!a.ok || !a.equipo || !cajaB.ok || !cajaB.equipo) throw new Error('no entraron')
    const conexionA = m.accesoA.autenticar(a.equipo.token)
    if (!conexionA) throw new Error('sin conexión')
    const r = m.accesoA.revocarDispositivo(conexionA, {
      sesionId: a.sesionId,
      secreto: a.secreto,
      dispositivoId: cajaB.equipo.dispositivoId,
    })
    expect(r).toMatchObject({ ok: false, codigo: 'datos_invalidos' })
    expect(m.accesoB.autenticar(cajaB.equipo.token)).toMatchObject({ revocadoEn: null })
  })
})

describe('la API de personal de un restaurante no toca al otro', () => {
  const personal = (m: ReturnType<typeof dosRestaurantes>, id: string, acceso: ServicioAcceso) =>
    leerPersonal(m.db, id, acceso)

  it('leer personal lista solo a la gente y los roles de su restaurante', () => {
    const m = conCajaEnAmbos()
    const a = personal(m, m.idA, m.accesoA)
    const b = personal(m, m.idB, m.accesoB)
    expect(a.personas.map((p) => p.nombre)).toContain('Caja A')
    expect(a.personas.map((p) => p.nombre)).not.toContain('Caja B')
    expect(b.personas.map((p) => p.nombre)).toEqual(
      expect.arrayContaining(['Caja B', 'Administrador B']),
    )
    expect(b.personas.map((p) => p.nombre)).not.toContain('Caja A')
    const idsB = new Set(b.roles.map((r) => r.id))
    for (const r of a.roles) expect(idsB.has(r.id)).toBe(false)
    expect(b.roles.find((r) => r.id === m.rolesB.cajero)?.personas).toBe(1)
  })

  it('editar desde A una persona o un rol que es de B: «no existe», sin cambiar nada en B', () => {
    const m = conCajaEnAmbos()
    const antes = JSON.stringify(
      m.db.prepare('SELECT * FROM usuario WHERE restaurante_id = ? ORDER BY id').all(m.idB),
    )
    const antesRoles = JSON.stringify(
      m.db.prepare('SELECT * FROM rol_permiso WHERE restaurante_id = ? ORDER BY id').all(m.idB),
    )
    const persona = (datos: Parameters<typeof guardarPersona>[3]) => () =>
      guardarPersona(m.db, m.idA, m.accesoA, datos, SISTEMA, m.a.reloj())
    expect(persona({ id: m.cajaB.usuarioId, nombre: 'Cambiada', rolId: m.a.roles.mesero })).toThrow(
      /Esa persona no existe/,
    )
    expect(persona({ nombre: 'Intrusa', rolId: m.rolesB.admin })).toThrow(/Ese rol no existe/)
    expect(
      persona({ id: m.cajaB.usuarioId, nombre: 'Cambiada', rolId: m.rolesB.mesero, activo: false }),
    ).toThrow(ErrorPersonal)
    expect(() =>
      guardarRol(
        m.db,
        m.idA,
        m.accesoA,
        { id: m.rolesB.admin, nombre: 'Administrador', permisos: [] },
        SISTEMA,
        m.a.reloj(),
      ),
    ).toThrow(/Ese rol no existe/)
    expect(
      JSON.stringify(
        m.db.prepare('SELECT * FROM usuario WHERE restaurante_id = ? ORDER BY id').all(m.idB),
      ),
    ).toBe(antes)
    expect(
      JSON.stringify(
        m.db.prepare('SELECT * FROM rol_permiso WHERE restaurante_id = ? ORDER BY id').all(m.idB),
      ),
    ).toBe(antesRoles)
  })

  it('el servicio de A no puede archivar, regenerar el PIN, quitar ni cambiar la contraseña de alguien de B', () => {
    const m = conCajaEnAmbos()
    const abierta = m.accesoB.entrar(
      { usuario: 'caja', contrasena: 'clave-de-la-caja-b' },
      null,
      '10.0.3.1',
    )
    expect(abierta).toMatchObject({ ok: true })
    const pinAntes = m.db
      .prepare('SELECT pin_huella FROM usuario_credencial WHERE usuario_id = ?')
      .get(m.cajaB.usuarioId)
    expect(() => m.accesoA.regenerarPin(m.cajaB.usuarioId)).toThrow(/no tiene credencial/)
    expect(() => m.accesoA.ponerContrasena(m.cajaB.usuarioId, 'otro', 'clave-intrusa-1')).toThrow(
      /no tiene credencial/,
    )
    m.accesoA.quitarContrasena(m.cajaB.usuarioId)
    m.accesoA.archivarUsuario(m.cajaB.usuarioId)
    expect(m.db.prepare('SELECT activo FROM usuario WHERE id = ?').get(m.cajaB.usuarioId)).toEqual({
      activo: 1,
    })
    expect(
      m.db
        .prepare('SELECT pin_huella FROM usuario_credencial WHERE usuario_id = ?')
        .get(m.cajaB.usuarioId),
    ).toEqual(pinAntes)
    expect(m.accesoB.usuarioDe(m.cajaB.usuarioId)).toBe('caja')
    expect(
      m.db
        .prepare('SELECT count(*) AS n FROM sesion WHERE usuario_id = ? AND cerrada_en IS NULL')
        .get(m.cajaB.usuarioId),
    ).toEqual({ n: 1 })
  })

  it('no se puede quitar al último administrador de A aunque B tenga el suyo', () => {
    const m = dosRestaurantes()
    expect(() =>
      guardarPersona(
        m.db,
        m.idA,
        m.accesoA,
        {
          id: m.a.personas.admin.usuarioId,
          nombre: 'Administrador',
          rolId: m.a.roles.admin,
          activo: false,
        },
        SISTEMA,
        m.a.reloj(),
      ),
    ).toThrow(/al menos una persona/)
    expect(
      m.accesoA.entrar(
        {
          usuario: m.a.personas.admin.usuario as string,
          contrasena: m.a.personas.admin.contrasena as string,
        },
        null,
        '10.0.3.2',
      ),
    ).toMatchObject({ ok: true })
  })

  it('quitarle el permiso de administrar a B no depende de A: el de A sigue en pie y viceversa', () => {
    const m = dosRestaurantes()
    expect(() =>
      guardarRol(
        m.db,
        m.idB,
        m.accesoB,
        { id: m.rolesB.admin, nombre: 'Administrador', permisos: ['tomar_pedido'] },
        SISTEMA,
        m.a.reloj(),
      ),
    ).toThrow(/al menos una persona/)
    // Dentro de A sí se puede cuando hay otra persona con el permiso.
    const otra = m.accesoA.crearUsuario({
      nombre: 'Otra admin',
      rolId: m.a.roles.admin,
      usuario: 'otra.admin',
      contrasena: 'clave-de-otra-admin',
    })
    expect(otra.usuarioId).toBeTruthy()
    expect(() =>
      guardarPersona(
        m.db,
        m.idA,
        m.accesoA,
        {
          id: m.a.personas.admin.usuarioId,
          nombre: 'Administrador',
          rolId: m.a.roles.admin,
          activo: false,
        },
        SISTEMA,
        m.a.reloj(),
      ),
    ).not.toThrow()
  })
})

describe('arranque con un segundo restaurante en la base', () => {
  // Antes fallaba: `asegurarAdministrador` y `usuarioLibre` no filtraban por restaurante.
  it('un restaurante nuevo recibe su propio administrador aunque otro ya tenga el suyo', () => {
    const m = dosRestaurantes()
    const ahora = m.a.reloj()
    const idC = nuevoId()
    m.db
      .prepare(
        `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
         VALUES (?, ?, ?, ?, 1, 'Tercero', '{}')`,
      )
      .run(idC, idC, ahora, ahora)
    m.db
      .prepare("INSERT INTO contador (restaurante_id, nombre, valor) VALUES (?, 'catalogo', 1)")
      .run(idC)
    insertarVersionado(
      m.db,
      'sede',
      idC,
      { nombre: 'Principal', direccion: null, zona_horaria: 'America/Bogota' },
      SISTEMA,
      ahora,
    )
    const rolesC = asegurarRoles(m.db, idC, ahora)
    const accesoC = new ServicioAcceso({
      db: m.db,
      restauranteId: idC,
      clave: CLAVE,
      reloj: m.a.reloj,
      costoContrasena: 1,
    })
    const r = asegurarAdministrador(m.db, accesoC, rolesC.admin, false)
    expect(r.usuario).toBe('admin')
    expect(
      accesoC.entrar({ usuario: 'admin', contrasena: r.contrasena as string }, null, '10.0.4.1'),
    ).toMatchObject({ ok: true })
  })
})
