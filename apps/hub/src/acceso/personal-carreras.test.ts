import { describe, expect, it } from 'vitest'
import { montarApi } from './montaje-api'
import { ABRIR, montarHub, sumar } from './montaje-hub'
import { administradores, guardarPersona, guardarRol } from './personal'
import { SISTEMA } from './registros'
import { huellaPin } from './secretos'

// Carreras y fallos a mitad en personal, roles y equipos autorregistrados (tarea 1.3b). El hub es
// un solo proceso con SQLite síncrono: «a la vez» son dos solicitudes en vuelo (`Promise.all`) que
// el hub atiende una tras otra; lo que se prueba es que el resultado sea coherente en cualquier
// orden y que lo que falla a mitad no deje nada.

const contar = (m: { db: ReturnType<typeof montarHub>['db'] }, sql: string, ...p: string[]) =>
  Number(m.db.prepare(sql).get(...p)?.n)

/** Foto de lo que un cambio fallido no debe tocar. */
function foto(m: ReturnType<typeof montarHub>) {
  const t = (sql: string) => JSON.stringify(m.db.prepare(sql).all())
  return [
    t('SELECT * FROM usuario ORDER BY id'),
    t('SELECT * FROM usuario_credencial ORDER BY usuario_id'),
    t('SELECT * FROM rol ORDER BY id'),
    t('SELECT * FROM rol_permiso ORDER BY id'),
    t('SELECT * FROM sesion ORDER BY id'),
    t('SELECT * FROM contador ORDER BY nombre'),
    t('SELECT * FROM dispositivo ORDER BY id'),
  ].join('\n')
}

async function conDosAdmins() {
  const m = montarHub()
  const api = montarApi(m)
  const jefes = guardarRol(
    m.db,
    m.restauranteId,
    m.acceso,
    {
      nombre: 'Jefes',
      permisos: ['administrar_usuarios', 'administrar_dispositivos', 'tomar_pedido'],
    },
    SISTEMA,
    m.reloj(),
  )
  const jefa = m.acceso.crearUsuario({
    nombre: 'Jefa',
    rolId: jefes,
    usuario: 'jefa',
    contrasena: 'clave-de-la-jefa',
  })
  const x = await api.entrarAdmin()
  const r = await api.post(
    '/api/entrar',
    { usuario: 'jefa', contrasena: 'clave-de-la-jefa' },
    { ip: '10.0.0.77' },
  )
  const y = {
    token: r.json().equipo.token as string,
    sesion: { sesion_id: r.json().sesion_id as string, secreto: r.json().secreto as string },
  }
  const persona = (quien: { token: string; sesion: object }, p: object) =>
    api.post('/api/personal/personas', { ...quien.sesion, persona: p }, { token: quien.token })
  const rol = (quien: { token: string; sesion: object }, p: object) =>
    api.post('/api/personal/roles', { ...quien.sesion, rol: p }, { token: quien.token })
  return { m, api, x, y, jefa, jefes, persona, rol }
}

describe('dos solicitudes a la vez', () => {
  it('dos equipos crean a la persona con el mismo usuario: una entra y la otra recibe «ya hay alguien»', async () => {
    const { m, x, y, persona } = await conDosAdmins()
    const antes = contar(m, 'SELECT count(*) AS n FROM usuario')
    const nueva = (n: string) => ({
      nombre: `Carla ${n}`,
      rol_id: m.roles.cajero,
      acceso: { tipo: 'contrasena', usuario: 'carla', contrasena: `clave-de-carla-${n}` },
    })
    const [a, b] = await Promise.all([persona(x, nueva('uno')), persona(y, nueva('dos'))])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400])
    const mala = a.statusCode === 400 ? a : b
    expect(mala.json().mensaje).toMatch(/Ya hay alguien con el usuario «carla»/)
    expect(contar(m, 'SELECT count(*) AS n FROM usuario')).toBe(antes + 1)
    expect(
      contar(m, "SELECT count(*) AS n FROM usuario_credencial WHERE nombre_usuario = 'carla'"),
    ).toBe(1)
    // Y sin huérfanos: cada usuario activo tiene su credencial.
    expect(
      contar(
        m,
        'SELECT count(*) AS n FROM usuario u WHERE NOT EXISTS (SELECT 1 FROM usuario_credencial c WHERE c.usuario_id = u.id)',
      ),
    ).toBe(0)
  })

  it('crear a «la misma persona» dos veces (doble envío) deja dos personas distintas con PIN distintos: no hay idempotencia', async () => {
    const { m, x, y, persona } = await conDosAdmins()
    const datos = { nombre: 'Bruno', rol_id: m.roles.mesero }
    const [a, b] = await Promise.all([persona(x, datos), persona(y, datos)])
    expect([a.statusCode, b.statusCode]).toEqual([200, 200])
    expect(a.json().id).not.toBe(b.json().id)
    expect(a.json().pin).not.toBe(b.json().pin)
    expect(contar(m, "SELECT count(*) AS n FROM usuario WHERE nombre = 'Bruno'")).toBe(2)
  })

  it('40 meseros creados a la vez desde dos equipos: todos con PIN de 4 dígitos, distintos y que entran', async () => {
    const { m, api, x, y, persona } = await conDosAdmins()
    const lote = Array.from({ length: 40 }, (_, i) =>
      persona(i % 2 ? x : y, { nombre: `Mesero ${i}`, rol_id: m.roles.mesero }),
    )
    const res = await Promise.all(lote)
    const pines = res.map((r) => r.json().pin as string)
    expect(res.every((r) => r.statusCode === 200)).toBe(true)
    expect(new Set(pines).size).toBe(40)
    for (const pin of pines) expect(pin).toMatch(/^\d{4}$/)
    // Cada PIN entra a su persona (IP distinta: no esperan).
    for (const [i, pin] of pines.slice(0, 6).entries()) {
      const r = await api.post('/api/entrar', { pin }, { ip: `10.20.0.${i + 1}` })
      expect(r.statusCode).toBe(201)
    }
  })

  it('cada uno le quita a la rol del otro el permiso de administrar, a la vez: uno se acepta, el otro pierde su permiso, y queda uno', async () => {
    const { m, x, y, jefes, rol } = await conDosAdmins()
    const sin = (id: string) =>
      (
        m.db.prepare('SELECT permiso FROM rol_permiso WHERE rol_id = ? AND activo = 1').all(id) as {
          permiso: string
        }[]
      )
        .map((f) => f.permiso)
        .filter((p) => p !== 'administrar_usuarios')
    const [a, b] = await Promise.all([
      rol(y, { id: m.roles.admin, nombre: 'Administrador', permisos: sin(m.roles.admin) }),
      rol(x, { id: jefes, nombre: 'Jefes', permisos: sin(jefes) }),
    ])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 403])
    expect(administradores(m.db, m.restauranteId)).toHaveLength(1)
  })

  it('el administrador y la jefa se archivan el uno al otro a la vez: queda exactamente uno activo', async () => {
    const { m, x, y, jefa, persona } = await conDosAdmins()
    const [a, b] = await Promise.all([
      persona(x, {
        id: jefa.usuarioId,
        nombre: 'Jefa',
        rol_id: m.db.prepare('SELECT rol_id FROM usuario WHERE id = ?').get(jefa.usuarioId)
          ?.rol_id as string,
        activo: false,
      }),
      persona(y, {
        id: m.personas.admin.usuarioId,
        nombre: 'Administrador',
        rol_id: m.roles.admin,
        activo: false,
      }),
    ])
    const estados = [a.statusCode, b.statusCode].sort()
    // El primero archiva al otro (200); el segundo ya no tiene sesión (401), o le queda ella sola.
    expect(estados[0]).toBe(200)
    expect([400, 401, 403]).toContain(estados[1])
    expect(administradores(m.db, m.restauranteId)).toHaveLength(1)
  })

  it('cada camino por separado para dejar a nadie administrando se rechaza y no deja nada a medias', async () => {
    const m = montarHub()
    const api = montarApi(m)
    const { token, sesion } = await api.entrarAdmin()
    const adminId = m.personas.admin.usuarioId
    const persona = (p: object) =>
      api.post('/api/personal/personas', { ...sesion, persona: p }, { token })
    const rol = (p: object) => api.post('/api/personal/roles', { ...sesion, rol: p }, { token })
    const antes = foto(m)
    const caminos = {
      archivarla: () =>
        persona({ id: adminId, nombre: 'Administrador', rol_id: m.roles.admin, activo: false }),
      pasarla_a_mesero: () =>
        persona({ id: adminId, nombre: 'Administrador', rol_id: m.roles.mesero }),
      quitarle_la_contrasena: () =>
        persona({
          id: adminId,
          nombre: 'Administrador',
          rol_id: m.roles.admin,
          acceso: { tipo: 'pin' },
        }),
      quitarle_el_permiso_al_rol: () =>
        rol({ id: m.roles.admin, nombre: 'Administrador', permisos: ['tomar_pedido'] }),
    }
    for (const [camino, hacer] of Object.entries(caminos)) {
      const r = await hacer()
      expect(r.statusCode, camino).toBe(400)
      expect(foto(m), camino).toBe(antes)
    }
    // Y sigue pudiendo administrar.
    expect((await api.post('/api/personal/leer', sesion, { token })).statusCode).toBe(200)
  })
})

describe('fallos a mitad de una operación (transacciones anidadas)', () => {
  it('crear a alguien con usuario inválido falla después de insertarlo: no queda persona, credencial ni versión gastada', () => {
    const m = montarHub()
    const antes = foto(m)
    expect(() =>
      m.acceso.crearUsuario({
        nombre: 'Rosa',
        rolId: m.roles.cajero,
        usuario: 'x',
        contrasena: 'clave-correcta-1',
      }),
    ).toThrow()
    expect(() =>
      m.acceso.crearUsuario({
        nombre: 'Rosa',
        rolId: m.roles.cajero,
        usuario: 'rosa',
        contrasena: 'corta',
      }),
    ).toThrow()
    expect(foto(m)).toBe(antes)
  })

  it('cambiar rol y usuario de alguien falla en el usuario (tomado): el rol tampoco cambia ni se cierran sus sesiones', async () => {
    const m = montarHub()
    const api = montarApi(m)
    const { token, sesion } = await api.entrarAdmin()
    const enCaja = m.acceso.entrar(
      { usuario: 'carlos', contrasena: 'clave-de-carlos' },
      null,
      '10.0.0.5',
    )
    expect(enCaja).toMatchObject({ ok: true })
    const antes = foto(m)
    const r = await api.post(
      '/api/personal/personas',
      {
        ...sesion,
        persona: {
          id: m.personas.cajero.usuarioId,
          nombre: 'Carlos Cambiado',
          rol_id: m.roles.reportes,
          acceso: {
            tipo: 'contrasena',
            usuario: m.personas.admin.usuario,
            contrasena: 'otra-clave-larga',
          },
        },
      },
      { token },
    )
    expect(r.statusCode).toBe(400)
    expect(foto(m)).toBe(antes)
  })

  it('un rol cuyo cambio de permisos deja al restaurante sin administrador no archiva ni reactiva permisos a medias', () => {
    const m = montarHub()
    const antes = foto(m)
    expect(() =>
      guardarRol(
        m.db,
        m.restauranteId,
        m.acceso,
        { id: m.roles.admin, nombre: 'Administrador', permisos: ['tomar_pedido', 'cortesia'] },
        SISTEMA,
        m.reloj(),
      ),
    ).toThrow()
    expect(foto(m)).toBe(antes)
  })

  it('entrar sin token y fallar al abrir la sesión: el navegador no queda registrado como equipo', () => {
    const m = montarHub()
    m.db.exec(
      "CREATE TRIGGER sesion_falla BEFORE INSERT ON sesion BEGIN SELECT RAISE(ABORT, 'disco lleno'); END",
    )
    const antes = foto(m)
    expect(() => m.acceso.entrar({ pin: m.personas.mesero.pin }, null, '10.0.0.6')).toThrow(
      /disco lleno/,
    )
    expect(foto(m)).toBe(antes)
    expect(contar(m, 'SELECT count(*) AS n FROM dispositivo_credencial')).toBe(0)
    m.db.exec('DROP TRIGGER sesion_falla')
    // Ya sin la falla, entra normal: la base quedó utilizable.
    expect(m.acceso.entrar({ pin: m.personas.mesero.pin }, null, '10.0.0.7')).toMatchObject({
      ok: true,
    })
  })

  it('subir un equipo de mesero a caja y fallar al abrir la sesión: el equipo sigue siendo de mesero', () => {
    const m = montarHub()
    const celular = m.acceso.entrar({ pin: m.personas.mesero.pin }, null, '10.0.0.8')
    if (!celular.ok || !celular.equipo) throw new Error('no entró')
    const conexion = m.acceso.autenticar(celular.equipo.token)
    if (!conexion) throw new Error('sin conexión')
    m.db.exec(
      "CREATE TRIGGER sesion_falla BEFORE INSERT ON sesion BEGIN SELECT RAISE(ABORT, 'falla'); END",
    )
    const antes = foto(m)
    expect(() =>
      m.acceso.entrar({ usuario: 'carlos', contrasena: 'clave-de-carlos' }, conexion, '10.0.0.9'),
    ).toThrow(/falla/)
    expect(foto(m)).toBe(antes)
    expect(
      m.db.prepare('SELECT tipo FROM dispositivo WHERE id = ?').get(conexion.dispositivoId),
    ).toEqual({ tipo: 'mesero' })
  })

  // Lo encontró qa-pruebas en la 1.3b y ya está corregido: sin un manejador de errores propio, Fastify devuelve en un 500 el mensaje de la excepción:
  // aquí llegan textos de SQLite («UNIQUE constraint failed: usuario_credencial…», nombres de tablas
  // y columnas) a cualquier navegador de la red. Esperaba un mensaje genérico, sin detalles.
  it('un 500 no muestra el mensaje interno de la excepción', async () => {
    const m = montarHub()
    const api = montarApi(m)
    m.db.exec(
      "CREATE TRIGGER sesion_falla BEFORE INSERT ON sesion BEGIN SELECT RAISE(ABORT, 'secreto-interno'); END",
    )
    const r = await api.post('/api/entrar', { pin: m.personas.mesero.pin })
    expect(r.statusCode).toBe(500)
    expect(r.body).not.toContain('secreto-interno')
  })

  it('tras un 500 por dentro, el hub sigue sirviendo y no quedó nada a medias', async () => {
    const m = montarHub()
    const api = montarApi(m)
    m.db.exec(
      "CREATE TRIGGER sesion_falla BEFORE INSERT ON sesion BEGIN SELECT RAISE(ABORT, 'falla'); END",
    )
    const antes = foto(m)
    expect((await api.post('/api/entrar', { pin: m.personas.mesero.pin })).statusCode).toBe(500)
    expect(foto(m)).toBe(antes)
    m.db.exec('DROP TRIGGER sesion_falla')
    expect(
      (await api.post('/api/entrar', { pin: m.personas.mesero.pin }, { ip: '10.0.0.30' }))
        .statusCode,
    ).toBe(201)
  })
})

describe('equipo autorregistrado y revocación', () => {
  function celular() {
    const m = montarHub()
    const e = m.acceso.entrar({ pin: m.personas.mesero.pin }, null, '10.0.5.1')
    if (!e.ok || !e.equipo) throw new Error('no entró')
    const conexion = m.acceso.autenticar(e.equipo.token)
    if (!conexion) throw new Error('sin conexión')
    const caja = m.acceso.entrar(
      {
        usuario: m.personas.admin.usuario as string,
        contrasena: m.personas.admin.contrasena as string,
      },
      null,
      '10.0.5.2',
    )
    if (!caja.ok || !caja.equipo) throw new Error('no entró la caja')
    const conexionCaja = m.acceso.autenticar(caja.equipo.token)
    if (!conexionCaja) throw new Error('sin conexión')
    const abrir = (hora: string) =>
      m.evento(conexion, e, 'PedidoAbierto', ABRIR, {
        hora_dispositivo: hora,
        hora_estimada_hub: hora,
      })
    const revocar = () => {
      const r = m.acceso.revocarDispositivo(conexionCaja, {
        sesionId: caja.sesionId,
        secreto: caja.secreto,
        dispositivoId: conexion.dispositivoId,
      })
      if (!r.ok) throw new Error(r.mensaje)
      return r.revocadoEn
    }
    return { m, e, conexion, caja, conexionCaja, abrir, revocar }
  }

  it('revocarlo corta su token en todas las rutas de entrada y su sesión; avisa a la sala', () => {
    const c = celular()
    c.revocar()
    expect(c.m.revocados).toContain(c.conexion.dispositivoId)
    const revocada = c.m.acceso.autenticar(c.e.equipo?.token as string)
    expect(revocada?.revocadoEn).not.toBeNull()
    expect(
      c.m.acceso.entrar({ pin: c.m.personas.mesero2.pin }, revocada, '10.0.5.3'),
    ).toMatchObject({ ok: false, codigo: 'dispositivo_revocado' })
    expect(c.m.acceso.iniciarSesion(revocada as never, c.m.personas.mesero2.pin)).toMatchObject({
      ok: false,
      codigo: 'dispositivo_revocado',
    })
    expect(c.m.acceso.cerrarSesion(revocada as never, c.e)).toMatchObject({ ok: false })
  })

  it('lo que el celular creó antes de la revocación va a cuarentena; lo posterior, rechazado', () => {
    const c = celular()
    const antes = c.abrir(c.m.reloj())
    c.m.avanzar(5000)
    const revocadoEn = c.revocar()
    const despues = c.abrir(sumar(revocadoEn, 1000))
    // La conexión que arma la sala al llegar el lote ya trae la revocación.
    const conexion = c.m.acceso.autenticar(c.e.equipo?.token as string) as never
    const r = c.m.hub.recibirLote(conexion, [antes, despues])
    expect(r.resultados.map((x) => x.estado)).toEqual(['cuarentena', 'rechazado'])
  })

  it('no se puede retirar el equipo desde el que se está entrando, ni uno ya retirado dos veces con fechas distintas', () => {
    const c = celular()
    expect(
      c.m.acceso.revocarDispositivo(c.conexionCaja, {
        sesionId: c.caja.sesionId,
        secreto: c.caja.secreto,
        dispositivoId: c.conexionCaja.dispositivoId,
      }),
    ).toMatchObject({ ok: false, codigo: 'datos_invalidos' })
    const primera = c.revocar()
    c.m.avanzar(60_000)
    expect(c.revocar()).toBe(primera)
  })

  it('un mesero no puede retirar equipos: su sesión no tiene administrar_dispositivos', () => {
    const c = celular()
    const otro = c.m.acceso.entrar({ pin: c.m.personas.mesero2.pin }, null, '10.0.5.4')
    if (!otro.ok || !otro.equipo) throw new Error('no entró')
    const conexion = c.m.acceso.autenticar(otro.equipo.token) as never
    expect(
      c.m.acceso.revocarDispositivo(conexion, {
        sesionId: otro.sesionId,
        secreto: otro.secreto,
        dispositivoId: c.conexion.dispositivoId,
      }),
    ).toMatchObject({ ok: false, codigo: 'sin_permiso' })
  })

  it('el aparato retirado puede volver a registrarse si borra su token (la revocación es del token, no del aparato): riesgo aceptado', () => {
    const c = celular()
    c.revocar()
    const de_nuevo = c.m.acceso.entrar({ pin: c.m.personas.mesero.pin }, null, '10.0.5.1')
    expect(de_nuevo).toMatchObject({ ok: true })
    if (de_nuevo.ok) expect(de_nuevo.equipo?.dispositivoId).not.toBe(c.conexion.dispositivoId)
  })
})

describe('sesión abierta mientras cambian los permisos de su rol', () => {
  it('quitarle administrar_usuarios al rol de una sesión abierta corta la API de personal al instante', async () => {
    const { m, api, y, jefes, persona } = await conDosAdmins()
    expect((await api.post('/api/personal/leer', y.sesion, { token: y.token })).statusCode).toBe(
      200,
    )
    guardarRol(
      m.db,
      m.restauranteId,
      m.acceso,
      { id: jefes, nombre: 'Jefes', permisos: ['tomar_pedido'] },
      SISTEMA,
      m.reloj(),
    )
    for (const url of ['/api/personal/leer'])
      expect((await api.post(url, y.sesion, { token: y.token })).statusCode).toBe(403)
    expect((await persona(y, { nombre: 'Intruso', rol_id: m.roles.mesero })).statusCode).toBe(403)
  })

  it('al mesero le quitan «tomar_pedido» con la sesión abierta: lo anterior va a cuarentena, lo posterior se rechaza', () => {
    const m = montarHub()
    const e = m.acceso.entrar({ pin: m.personas.mesero.pin }, null, '10.0.6.1')
    if (!e.ok || !e.equipo) throw new Error('no entró')
    // El login trajo los permisos de ese momento; el hub juzga con los de ahora.
    expect(e.permisos).toContain('tomar_pedido')
    const conexion = m.acceso.autenticar(e.equipo.token) as never
    const antes = m.evento(conexion, e, 'PedidoAbierto', ABRIR)
    m.avanzar(10 * 60_000)
    guardarRol(
      m.db,
      m.restauranteId,
      m.acceso,
      { id: m.roles.mesero, nombre: 'Mesero', permisos: ['ver_reportes_propios'] },
      SISTEMA,
      m.reloj(),
    )
    const cambio = m.reloj()
    m.avanzar(1000)
    const despues = m.evento(conexion, e, 'PedidoAbierto', ABRIR, {
      hora_dispositivo: sumar(cambio, 500),
      hora_estimada_hub: sumar(cambio, 500),
    })
    const r = m.hub.recibirLote(conexion, [antes, despues])
    expect(r.resultados.map((x) => x.estado)).toEqual(['cuarentena', 'rechazado'])
    expect(r.resultados[1]).toMatchObject({ motivo: 'sin_permiso' })
  })

  it('al darle un permiso nuevo al rol, la sesión abierta lo usa sin volver a entrar', () => {
    const m = montarHub()
    const e = m.acceso.entrar({ pin: m.personas.mesero.pin }, null, '10.0.6.2')
    if (!e.ok || !e.equipo) throw new Error('no entró')
    const conexion = m.acceso.autenticar(e.equipo.token) as never
    expect(e.permisos).not.toContain('agotar_producto')
    const antes = m.acceso.usuarioConPermiso(conexion, e, 'agotar_producto')
    expect(antes).toMatchObject({ ok: false, codigo: 'sin_permiso' })
    guardarRol(
      m.db,
      m.restauranteId,
      m.acceso,
      { id: m.roles.mesero, nombre: 'Mesero', permisos: [...e.permisos, 'agotar_producto'] },
      SISTEMA,
      m.reloj(),
    )
    expect(m.acceso.usuarioConPermiso(conexion, e, 'agotar_producto')).toMatchObject({ ok: true })
  })
})

describe('un mesero que pasa a tener contraseña con su sesión abierta', () => {
  it('su sesión se cierra, su PIN ya no entra pero sí autoriza, y entra con su contraseña', async () => {
    const { m, api, x } = await conDosAdmins()
    // Ana (PIN) con una sesión abierta en su celular y un evento hecho sin conexión.
    const e = m.acceso.entrar({ pin: m.personas.mesero.pin }, null, '10.0.7.1')
    if (!e.ok || !e.equipo) throw new Error('no entró')
    const conexion = m.acceso.autenticar(e.equipo.token) as never
    const hechoAntes = m.evento(conexion, e, 'PedidoAbierto', ABRIR)
    m.avanzar(60_000)
    const r = await api.post(
      '/api/personal/personas',
      {
        ...x.sesion,
        persona: {
          id: m.personas.mesero.usuarioId,
          nombre: 'Ana',
          rol_id: m.roles.cajero,
          acceso: { tipo: 'contrasena', usuario: 'ana', contrasena: 'clave-de-ana-1' },
        },
      },
      { token: x.token },
    )
    expect(r.statusCode).toBe(200)
    // Sesión cerrada: el celular debe volver a entrar.
    expect(m.acceso.cerrarSesion(conexion, e)).toMatchObject({
      ok: false,
      codigo: 'sesion_invalida',
    })
    // Con el PIN ya no entra (ni sin token, ni con el token de su celular).
    expect(m.acceso.entrar({ pin: m.personas.mesero.pin }, conexion, '10.0.7.2')).toMatchObject({
      ok: false,
      codigo: 'pin_incorrecto',
    })
    // Con la contraseña sí, y el celular pasa a ser de caja (su rol cobra).
    const luego = m.acceso.entrar(
      { usuario: 'ANA', contrasena: 'clave-de-ana-1' },
      conexion,
      '10.0.7.3',
    )
    expect(luego).toMatchObject({ ok: true, tipo: 'caja', usuario: { nombre: 'Ana' } })
    // Lo que hizo antes de cambiar, con la sesión de entonces, el hub lo aprueba.
    expect(m.hub.recibirLote(conexion, [hechoAntes]).resultados[0]?.estado).toBe('confirmado')
  })

  it('un evento firmado con la sesión cerrada, creado después del cambio, se rechaza', async () => {
    const { m, api, x } = await conDosAdmins()
    const e = m.acceso.entrar({ pin: m.personas.mesero.pin }, null, '10.0.7.4')
    if (!e.ok || !e.equipo) throw new Error('no entró')
    const conexion = m.acceso.autenticar(e.equipo.token) as never
    await api.post(
      '/api/personal/personas',
      {
        ...x.sesion,
        persona: {
          id: m.personas.mesero.usuarioId,
          nombre: 'Ana',
          rol_id: m.roles.mesero,
          acceso: { tipo: 'contrasena', usuario: 'ana', contrasena: 'clave-de-ana-1' },
        },
      },
      { token: x.token },
    )
    m.avanzar(5 * 60_000)
    const despues = m.evento(conexion, e, 'PedidoAbierto', ABRIR)
    expect(m.hub.recibirLote(conexion, [despues]).resultados[0]).toMatchObject({
      estado: 'rechazado',
      motivo: 'sesion_cerrada',
    })
  })

  it('el PIN de autorización de quien tiene contraseña sigue autorizando en el celular del mesero', () => {
    const m = montarHub()
    const e = m.acceso.entrar({ pin: m.personas.mesero.pin }, null, '10.0.7.5')
    if (!e.ok || !e.equipo) throw new Error('no entró')
    const conexion = m.acceso.autenticar(e.equipo.token) as never
    const r = m.acceso.autorizar(conexion, {
      sesionId: e.sesionId,
      secreto: e.secreto,
      pin: m.personas.cajero.pin,
      accion: 'anular_item_enviado',
      agregadoId: '0'.repeat(26),
      eventoId: '1'.repeat(26),
      huella: 'a'.repeat(64),
    })
    expect(r).toMatchObject({ ok: true, supervisor: { nombre: 'Carlos' } })
  })
})

describe('reactivar a quien se archivó', () => {
  it('si su usuario lo tomó otra persona: error claro (400) y no queda activa a medias', async () => {
    const { m, api, x, persona } = await conDosAdmins()
    const carla = (
      await persona(x, {
        nombre: 'Carla',
        rol_id: m.roles.cajero,
        acceso: { tipo: 'contrasena', usuario: 'carla', contrasena: 'clave-de-carla-1' },
      })
    ).json()
    await persona(x, { id: carla.id, nombre: 'Carla', rol_id: m.roles.cajero, activo: false })
    await persona(x, {
      nombre: 'Carla II',
      rol_id: m.roles.cajero,
      acceso: { tipo: 'contrasena', usuario: 'carla', contrasena: 'clave-de-carla-2' },
    })
    const antes = foto(m)
    const r = await persona(x, {
      id: carla.id,
      nombre: 'Carla',
      rol_id: m.roles.cajero,
      activo: true,
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().mensaje).toMatch(/ya lo tiene otra persona/)
    expect(foto(m)).toBe(antes)
    // Dándole otro usuario con contraseña, sí.
    const bien = await persona(x, {
      id: carla.id,
      nombre: 'Carla',
      rol_id: m.roles.cajero,
      activo: true,
      acceso: { tipo: 'contrasena', usuario: 'carla.vieja', contrasena: 'clave-de-carla-3' },
    })
    expect(bien.statusCode).toBe(200)
    void api
  })

  it('si su PIN lo tomó otra persona mientras estaba archivada, al activarla recibe un PIN nuevo', async () => {
    const { m, x, persona } = await conDosAdmins()
    const bea = (await persona(x, { nombre: 'Bea', rol_id: m.roles.mesero })).json()
    await persona(x, { id: bea.id, nombre: 'Bea', rol_id: m.roles.mesero, activo: false })
    // Otra persona recibe, por azar, el mismo PIN (se fuerza en la base).
    const cora = (await persona(x, { nombre: 'Cora', rol_id: m.roles.mesero })).json()
    m.db
      .prepare('UPDATE usuario_credencial SET pin_huella = ? WHERE usuario_id = ?')
      .run(huellaPin(Buffer.alloc(32, 7), m.restauranteId, bea.pin), cora.id)
    const r = await persona(x, { id: bea.id, nombre: 'Bea', rol_id: m.roles.mesero, activo: true })
    expect(r.statusCode).toBe(200)
    expect(r.json().pin).toMatch(/^\d{4}$/)
    expect(r.json().pin).not.toBe(bea.pin)
    // Cada una entra con el suyo.
    expect(m.acceso.entrar({ pin: bea.pin }, null, '10.0.8.1')).toMatchObject({
      ok: true,
      usuario: { nombre: 'Cora' },
    })
    expect(m.acceso.entrar({ pin: r.json().pin }, null, '10.0.8.2')).toMatchObject({
      ok: true,
      usuario: { nombre: 'Bea' },
    })
  })
})

void guardarPersona
