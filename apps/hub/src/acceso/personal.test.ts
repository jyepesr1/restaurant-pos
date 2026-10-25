import { describe, expect, it } from 'vitest'
import { crearServidor } from '../servidor'
import { montarAcceso } from './montaje'
import { ErrorPersonal, guardarPersona, guardarRol, leerPersonal } from './personal'
import { SISTEMA } from './registros'

// Personal y roles (tarea 1.3b): el administrador decide los permisos de cada rol.

const montar = () => {
  const m = montarAcceso()
  const rol = (datos: Parameters<typeof guardarRol>[3]) =>
    guardarRol(m.db, m.restauranteId, m.acceso, datos, SISTEMA, m.reloj())
  const persona = (datos: Parameters<typeof guardarPersona>[3]) =>
    guardarPersona(m.db, m.restauranteId, m.acceso, datos, SISTEMA, m.reloj())
  const leer = () => leerPersonal(m.db, m.restauranteId, m.acceso)
  return { ...m, rol, persona, leer }
}

describe('roles', () => {
  it('se crea un rol con los permisos que se quieran, y quitar uno lo archiva sin borrarlo', () => {
    const m = montar()
    const id = m.rol({ nombre: 'Bartender', permisos: ['tomar_pedido', 'agotar_producto'] })
    const ana = m.persona({ nombre: 'Bea', rolId: id })
    expect(m.acceso.permisosDe(ana.usuarioId)).toEqual(['agotar_producto', 'tomar_pedido'])

    m.rol({ id, nombre: 'Bartender', permisos: ['tomar_pedido'] })
    expect(m.acceso.permisosDe(ana.usuarioId)).toEqual(['tomar_pedido'])
    const filas = m.db.prepare('SELECT permiso, activo FROM rol_permiso WHERE rol_id = ?').all(id)
    expect(filas).toContainEqual({ permiso: 'agotar_producto', activo: 0 })

    // Volver a darlo reactiva la misma fila.
    m.rol({ id, nombre: 'Bartender', permisos: ['tomar_pedido', 'agotar_producto'] })
    expect(m.db.prepare('SELECT count(*) AS n FROM rol_permiso WHERE rol_id = ?').get(id)?.n).toBe(
      2,
    )
    expect(m.leer().roles.find((r) => r.id === id)).toMatchObject({
      nombre: 'Bartender',
      sistema: false,
      personas: 1,
      permisos: ['agotar_producto', 'tomar_pedido'],
    })
  })

  it('a un rol de fábrica se le cambian los permisos, pero no el nombre ni se archiva', () => {
    const m = montar()
    m.rol({ id: m.roles.cajero, nombre: 'Cajero', permisos: ['tomar_pedido', 'cortesia'] })
    expect(m.acceso.permisosDe(m.personas.cajero.usuarioId)).toEqual(['cortesia', 'tomar_pedido'])
    expect(() => m.rol({ id: m.roles.cajero, nombre: 'Caja', permisos: [] })).toThrow(
      /no se renombran/,
    )
    expect(() =>
      m.rol({ id: m.roles.mesero, nombre: 'Mesero', permisos: [], activo: false }),
    ).toThrow(/no se archivan/)
  })

  it('no hay dos roles activos con el mismo nombre, sin importar mayúsculas ni tildes iguales', () => {
    const m = montar()
    expect(() => m.rol({ nombre: 'mesero', permisos: [] })).toThrow(/Ya hay un rol/)
    expect(() => m.rol({ nombre: '  ', permisos: [] })).toThrow(ErrorPersonal)
    expect(() => m.rol({ nombre: 'X', permisos: ['borrar_todo'] })).toThrow(/desconocido/)
  })

  it('un rol con personas no se archiva; vacío, sí', () => {
    const m = montar()
    expect(() =>
      m.rol({ id: m.roles.gerente, nombre: 'Gerente', permisos: [], activo: false }),
    ).toThrow(/tiene personas/)
    const vacio = m.rol({ nombre: 'Temporada', permisos: ['tomar_pedido'] })
    m.rol({ id: vacio, nombre: 'Temporada', permisos: [], activo: false })
    expect(m.leer().roles.find((r) => r.id === vacio)?.activo).toBe(false)
    // Con el nombre libre, se puede crear otro igual.
    expect(() => m.rol({ nombre: 'Temporada', permisos: [] })).not.toThrow()
  })

  it('no deja al restaurante sin nadie que pueda administrar el personal', () => {
    const m = montar()
    const todos = m.leer().roles.find((r) => r.id === m.roles.admin)?.permisos ?? []
    expect(() =>
      m.rol({
        id: m.roles.admin,
        nombre: 'Administrador',
        permisos: todos.filter((p) => p !== 'administrar_usuarios'),
      }),
    ).toThrow(/Tiene que quedar al menos una persona/)
    // Nada cambió: la transacción se deshizo.
    expect(m.acceso.permisosDe(m.personas.admin.usuarioId)).toContain('administrar_usuarios')
  })
})

describe('quien entra con PIN no puede tener permisos de caja ni de administración', () => {
  it('ni al crearla, ni al darle ese permiso a su rol', () => {
    const m = montar()
    expect(() => m.persona({ nombre: 'Pía', rolId: m.roles.cajero })).toThrow(
      /Pía entra con PIN y su rol permite «/,
    )
    expect(() =>
      m.rol({
        id: m.roles.mesero,
        nombre: 'Mesero',
        permisos: ['tomar_pedido', 'registrar_pago'],
      }),
    ).toThrow(/entra con PIN y su rol permite «Cobrar»/)
    // Nada cambió.
    expect(m.acceso.permisosDe(m.personas.mesero.usuarioId)).not.toContain('registrar_pago')
    // Los permisos de pedidos sí se pueden dar a quien entra con PIN.
    expect(() =>
      m.rol({
        id: m.roles.mesero,
        nombre: 'Mesero',
        permisos: ['tomar_pedido', 'descontar', 'anular_item_enviado'],
      }),
    ).not.toThrow()
  })

  it('el PIN de alguien con permisos de caja no abre sesión, aunque no tenga contraseña (base vieja)', () => {
    const m = montar()
    // Como quedaría un Gerente de antes de ADR-013: rol que cobra, persona sin contraseña.
    const ana = m.personas.mesero
    m.db.prepare('UPDATE usuario SET rol_id = ? WHERE id = ?').run(m.roles.cajero, ana.usuarioId)
    const { conexion } = m.emparejar('mesero')
    expect(m.acceso.iniciarSesion(conexion, ana.pin)).toMatchObject({
      ok: false,
      mensaje: 'PIN incorrecto',
    })
    expect(m.acceso.entrar({ pin: ana.pin }, null, 'ip-9')).toMatchObject({ ok: false })
  })
})

describe('volver a activar a alguien', () => {
  it('si su PIN quedó en otra persona, recibe uno nuevo; si su usuario, hay que ponerle otro', () => {
    const m = montar()
    const ana = m.personas.mesero
    const datos = { id: ana.usuarioId, nombre: 'Ana', rolId: m.roles.mesero }
    m.persona({ ...datos, activo: false })
    // Su PIN lo toma otra persona mientras está archivada.
    const huella = String(
      m.db
        .prepare('SELECT pin_huella FROM usuario_credencial WHERE usuario_id = ?')
        .get(ana.usuarioId)?.pin_huella,
    )
    m.db
      .prepare('UPDATE usuario_credencial SET pin_huella = ? WHERE usuario_id = ?')
      .run(huella, m.personas.mesero2.usuarioId)
    const r = m.persona({ ...datos, activo: true })
    expect(r.pin).toMatch(/^\d{4}$/)
    expect(m.leer().personas.find((p) => p.id === ana.usuarioId)?.activo).toBe(true)

    const carlos = m.personas.cajero
    const deCarlos = { id: carlos.usuarioId, nombre: 'Carlos', rolId: m.roles.cajero }
    m.persona({ ...deCarlos, activo: false })
    m.persona({
      nombre: 'Otro Carlos',
      rolId: m.roles.cajero,
      acceso: { tipo: 'contrasena', usuario: 'carlos', contrasena: 'otra-clave-1' },
    })
    expect(() => m.persona({ ...deCarlos, activo: true })).toThrow(/ya lo tiene otra persona/)
    expect(() =>
      m.persona({
        ...deCarlos,
        activo: true,
        acceso: { tipo: 'contrasena', usuario: 'carlos.b', contrasena: 'nueva-clave-2' },
      }),
    ).not.toThrow()
  })
})

describe('personas', () => {
  it('un mesero nuevo entra con su PIN; alguien de caja, con usuario y contraseña', () => {
    const m = montar()
    const mesero = m.persona({ nombre: 'Pedro', rolId: m.roles.mesero })
    expect(mesero.pin).toMatch(/^\d{4}$/)
    expect(m.acceso.entrar({ pin: mesero.pin as string }, null, 'ip-1')).toMatchObject({ ok: true })

    const caja = m.persona({
      nombre: 'Carla',
      rolId: m.roles.cajero,
      acceso: { tipo: 'contrasena', usuario: 'Carla', contrasena: 'caja-segura-1' },
    })
    expect(
      m.acceso.entrar({ usuario: 'carla', contrasena: 'caja-segura-1' }, null, 'ip-2'),
    ).toMatchObject({
      ok: true,
      usuario: { nombre: 'Carla' },
    })
    // Su PIN no abre sesión: solo autoriza.
    expect(m.acceso.entrar({ pin: caja.pin as string }, null, 'ip-3')).toMatchObject({ ok: false })
    expect(m.leer().personas.find((p) => p.id === caja.usuarioId)?.usuario).toBe('carla')
  })

  it('el usuario es único en el restaurante y la contraseña tiene al menos 8 caracteres', () => {
    const m = montar()
    const con = (usuario: string, contrasena?: string) => () =>
      m.persona({
        nombre: 'X',
        rolId: m.roles.cajero,
        acceso: { tipo: 'contrasena', usuario, contrasena },
      })
    expect(con(String(m.personas.admin.usuario), 'larga-12345')).toThrow(/Ya hay alguien/)
    expect(con('nuevo', 'corta')).toThrow(/al menos 8/)
    expect(con('con espacio', 'larga-12345')).toThrow(/de 3 a 40/)
    expect(con('nuevo')).toThrow(/Escribe una contraseña/)
    // Ninguno de esos intentos dejó a alguien creado.
    expect(m.leer().personas.filter((p) => p.nombre === 'X')).toEqual([])
  })

  it('pasar a alguien de PIN a contraseña y de vuelta; cambiar el rol cierra su sesión', () => {
    const m = montar()
    const { conexion } = m.emparejar('mesero')
    const sesion = m.entrar(conexion, 'mesero')
    const datos = { id: m.personas.mesero.usuarioId, nombre: 'Ana' }

    // Con PIN no puede quedar en un rol que cobra (ADR-013)…
    expect(() => m.persona({ ...datos, rolId: m.roles.cajero })).toThrow(
      /Ana entra con PIN y su rol permite/,
    )
    // …en uno que no cobra, sí; y cambiar el rol cierra su sesión.
    const barra = m.rol({ nombre: 'Barra', permisos: ['tomar_pedido'] })
    m.persona({ ...datos, rolId: barra })
    expect(m.acceso.cerrarSesion(conexion, sesion)).toMatchObject({ codigo: 'sesion_invalida' })

    m.persona({
      ...datos,
      rolId: m.roles.cajero,
      acceso: { tipo: 'contrasena', usuario: 'ana', contrasena: 'ana-clave-99' },
    })
    expect(m.acceso.iniciarSesion(conexion, m.personas.mesero.pin)).toMatchObject({ ok: false })
    // Mismo usuario sin contraseña nueva: no cambia nada.
    expect(() =>
      m.persona({
        ...datos,
        rolId: m.roles.cajero,
        acceso: { tipo: 'contrasena', usuario: 'ana' },
      }),
    ).not.toThrow()
    expect(() =>
      m.persona({
        ...datos,
        rolId: m.roles.cajero,
        acceso: { tipo: 'contrasena', usuario: 'ana2' },
      }),
    ).toThrow(/escribe también una contraseña/)

    m.persona({ ...datos, rolId: m.roles.mesero, acceso: { tipo: 'pin' } })
    m.avanzar(61_000)
    expect(m.acceso.iniciarSesion(conexion, m.personas.mesero.pin)).toMatchObject({ ok: true })
  })

  it('regenerar el PIN da uno nuevo y el viejo deja de servir; archivar libera el usuario', () => {
    const m = montar()
    const { conexion } = m.emparejar('mesero')
    const datos = { id: m.personas.mesero.usuarioId, nombre: 'Ana', rolId: m.roles.mesero }
    const r = m.persona({ ...datos, regenerarPin: true })
    expect(r.pin).toMatch(/^\d{4}$/)
    if (r.pin !== m.personas.mesero.pin)
      expect(m.acceso.iniciarSesion(conexion, m.personas.mesero.pin)).toMatchObject({ ok: false })
    m.avanzar(61_000)
    expect(m.acceso.iniciarSesion(conexion, r.pin as string)).toMatchObject({ ok: true })

    m.persona({ ...datos, activo: false })
    m.avanzar(61_000)
    expect(m.acceso.iniciarSesion(conexion, r.pin as string)).toMatchObject({ ok: false })
    expect(m.leer().personas.find((p) => p.id === datos.id)?.activo).toBe(false)
  })

  it('no se archiva a la última persona que administra el personal', () => {
    const m = montar()
    expect(() =>
      m.persona({
        id: m.personas.admin.usuarioId,
        nombre: 'Administrador',
        rolId: m.roles.admin,
        activo: false,
      }),
    ).toThrow(/Tiene que quedar al menos una persona/)
    expect(
      () =>
        m.persona({
          id: m.personas.admin.usuarioId,
          nombre: 'Administrador',
          rolId: m.roles.admin,
          acceso: { tipo: 'pin' },
        }),
      // Antes de quedarse sin administrador, choca con que un administrador no entra con PIN.
    ).toThrow(/entra con PIN y su rol permite/)
    expect(m.acceso.tieneContrasena(m.personas.admin.usuarioId)).toBe(true)
  })
})

describe('equipos en la pantalla de personal', () => {
  it('cada equipo con su último uso y quién; el retirado al final', () => {
    const m = montar()
    const celular = m.acceso.entrar({ pin: m.personas.mesero.pin }, null, 'ip-1')
    const caja = m.acceso.entrar({ usuario: 'carlos', contrasena: 'clave-de-carlos' }, null, 'ip-2')
    if (!celular.ok || !caja.ok || !celular.equipo || !caja.equipo) throw new Error('no entró')
    m.avanzar(60_000)
    const admin = m.acceso.entrar(
      {
        usuario: String(m.personas.admin.usuario),
        contrasena: String(m.personas.admin.contrasena),
      },
      null,
      'ip-3',
    )
    if (!admin.ok || !admin.equipo) throw new Error('no entró')
    const conexion = m.acceso.autenticar(admin.equipo.token)
    if (!conexion) throw new Error('sin conexión')
    m.acceso.revocarDispositivo(conexion, { ...admin, dispositivoId: celular.equipo.dispositivoId })

    const equipos = m.leer().equipos
    expect(equipos.map((e) => [e.nombre, e.tipo, e.ultimaPersona, e.revocadoEn !== null])).toEqual([
      ['Equipo de Administrador', 'caja', 'Administrador', false],
      ['Equipo de Carlos', 'caja', 'Carlos', false],
      ['Equipo de Ana', 'mesero', 'Ana', true],
    ])
  })
})

describe('API de personal', () => {
  function montarApi() {
    const m = montar()
    const cambios: number[] = []
    const app = crearServidor({
      acceso: m.acceso,
      catalogo: {
        db: m.db,
        restauranteId: m.restauranteId,
        acceso: m.acceso,
        reloj: m.reloj,
        alCambiar: (v) => cambios.push(v),
      },
    })
    const post = (url: string, cuerpo: unknown, token?: string) =>
      app.inject({
        method: 'POST',
        url,
        payload: cuerpo as object,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
    return { ...m, post, cambios }
  }

  it('el administrador lee, crea un rol y una persona; los equipos traen la carta de nuevo', async () => {
    const api = montarApi()
    const caja = (
      await api.post('/api/entrar', {
        usuario: api.personas.admin.usuario,
        contrasena: api.personas.admin.contrasena,
      })
    ).json()
    const sesion = { sesion_id: caja.sesion_id, secreto: caja.secreto }
    const token = caja.equipo.token

    const leido = await api.post('/api/personal/leer', sesion, token)
    expect(leido.statusCode).toBe(200)
    expect(leido.json().roles.map((r: { nombre: string }) => r.nombre)).toContain('Reportes')

    const rol = await api.post(
      '/api/personal/roles',
      { ...sesion, rol: { nombre: 'Barra', permisos: ['tomar_pedido'] } },
      token,
    )
    expect(rol.statusCode).toBe(200)
    const persona = await api.post(
      '/api/personal/personas',
      { ...sesion, persona: { nombre: 'Bruno', rol_id: rol.json().id } },
      token,
    )
    expect(persona.statusCode).toBe(200)
    expect(persona.json().pin).toMatch(/^\d{4}$/)
    expect(api.cambios).toHaveLength(2)

    const repetido = await api.post(
      '/api/personal/roles',
      { ...sesion, rol: { nombre: 'barra', permisos: [] } },
      token,
    )
    expect(repetido.statusCode).toBe(400)
    expect(repetido.json().mensaje).toMatch(/Ya hay un rol/)
  })

  it('sin el permiso responde 403; sin sesión, 401; con datos raros, 400', async () => {
    const api = montarApi()
    const mesero = (await api.post('/api/entrar', { pin: api.personas.mesero.pin })).json()
    const sesion = { sesion_id: mesero.sesion_id, secreto: mesero.secreto }
    expect((await api.post('/api/personal/leer', sesion, mesero.equipo.token)).statusCode).toBe(403)
    expect(
      (await api.post('/api/personal/leer', { ...sesion, secreto: 'otro' }, mesero.equipo.token))
        .statusCode,
    ).toBe(401)
    expect((await api.post('/api/personal/leer', sesion)).statusCode).toBe(401)
    expect(
      (
        await api.post(
          '/api/personal/roles',
          { ...sesion, rol: { nombre: 1 } },
          mesero.equipo.token,
        )
      ).statusCode,
    ).toBe(400)
  })
})
