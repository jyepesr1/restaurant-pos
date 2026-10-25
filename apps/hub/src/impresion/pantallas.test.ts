import { PERMISOS_PANTALLA } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { leerCatalogo } from '../catalogo'
import { type Equipo, type MontajeImpresion, montarImpresion } from './montaje-impresion'

// Pantalla de cocina (KDS) opcional (ADR-015): el administrador convierte un equipo con su
// contraseña; queda a nombre de un usuario técnico que solo marca listo y agotados, que no es una
// persona de Personal y que se va con el equipo cuando se retira.

type Json = Record<string, unknown>

async function convertir(
  t: MontajeImpresion,
  tablet: Equipo,
  extra: Json = {},
  cuerpoSesion: Json = tablet.cuerpoSesion,
) {
  return t.post(
    '/api/pantallas',
    { ...cuerpoSesion, nombre: 'Cocina', estacion_ids: [t.cocina], ...extra },
    tablet.token,
  )
}

/** Una tablet de la cocina ya convertida en pantalla; devuelve su sesión técnica. */
async function pantalla(t: MontajeImpresion, estaciones: string[] = [t.cocina], nombre = 'Cocina') {
  const tablet = t.equipo('admin', 'mesero')
  const r = await convertir(t, tablet, { estacion_ids: estaciones, nombre })
  expect(r.statusCode).toBe(201)
  const c = r.json()
  const sesion = {
    sesionId: c.sesion_id as string,
    secreto: c.secreto as string,
    usuario: { id: c.usuario.id as string },
  }
  /** Un evento de esa pantalla, mandado al hub. */
  const mandar = (pedido: string, tipo: string, datos: unknown, extras: Json = {}) => {
    const x = t.hub.recibirLote(tablet.conexion, [
      t.evento(tablet.conexion, sesion, tipo, datos, {
        agregado_id: pedido,
        secuencia_base: Number(
          t.db.prepare('SELECT coalesce(max(secuencia), 0) AS s FROM evento').get()?.s,
        ),
        ...extras,
      } as never),
    ])
    return x.resultados[0] as { estado: string; motivo?: string }
  }
  return {
    tablet,
    respuesta: c,
    sesion,
    usuarioId: sesion.usuario.id,
    cuerpoSesion: { sesion_id: sesion.sesionId, secreto: sesion.secreto },
    mandar,
  }
}

const usuariosTecnicos = (t: MontajeImpresion) =>
  t.db.prepare('SELECT * FROM usuario WHERE pantalla = 1 ORDER BY creado_en, id').all()

describe('convertir un equipo en pantalla de cocina', () => {
  it('crea el usuario técnico con un rol oculto que solo marca preparación y agotados', async () => {
    const t = montarImpresion()
    const p = await pantalla(t)
    expect(p.respuesta).toMatchObject({
      tipo: 'kds',
      usuario: { nombre: 'Cocina', rol: 'Pantalla de cocina' },
    })
    expect([...p.respuesta.permisos].sort()).toEqual([...PERMISOS_PANTALLA].sort())
    expect([...PERMISOS_PANTALLA].sort()).toEqual(['agotar_producto', 'marcar_preparacion'])

    const usuario = t.db.prepare('SELECT * FROM usuario WHERE id = ?').get(p.usuarioId)
    expect(usuario).toMatchObject({ pantalla: 1, activo: 1, nombre: 'Cocina' })
    const rol = t.db.prepare('SELECT * FROM rol WHERE id = ?').get(usuario?.rol_id as string)
    expect(rol).toMatchObject({ oculto: 1, sistema: 1, nombre: 'Pantalla de cocina', activo: 1 })
    const permisos = t.db
      .prepare('SELECT permiso FROM rol_permiso WHERE rol_id = ? AND activo = 1 ORDER BY permiso')
      .all(rol?.id as string)
      .map((f) => f.permiso)
    expect(permisos).toEqual(['agotar_producto', 'marcar_preparacion'])
  })

  it('el equipo queda como pantalla (kds) con sus estaciones y su nombre', async () => {
    const t = montarImpresion()
    const p = await pantalla(t, [t.cocina, t.barra, t.cocina], '  Cocina caliente ')
    const d = t.db
      .prepare('SELECT * FROM dispositivo WHERE id = ?')
      .get(p.tablet.conexion.dispositivoId)
    expect(d).toMatchObject({ tipo: 'kds', nombre: 'Cocina caliente' })
    expect(JSON.parse(String(d?.estacion_ids))).toEqual([t.cocina, t.barra])
  })

  it('la sesión del administrador se cierra y queda solo la de la pantalla', async () => {
    const t = montarImpresion()
    const tablet = t.equipo('admin', 'mesero')
    const vieja = tablet.cuerpoSesion
    const r = await convertir(t, tablet)
    const nueva = r.json()
    const abiertas = t.db
      .prepare('SELECT id FROM sesion WHERE dispositivo_id = ? AND cerrada_en IS NULL')
      .all(tablet.conexion.dispositivoId)
    expect(abiertas).toEqual([{ id: nueva.sesion_id }])
    // La sesión del administrador ya no sirve para nada: ni siquiera para volver a convertir.
    const otra = await t.post('/api/cocina/configuracion', vieja, tablet.token)
    expect(otra.statusCode).toBe(401)
  })

  it('el usuario técnico no puede entrar con PIN ni con contraseña (no tiene credenciales)', async () => {
    const t = montarImpresion()
    const p = await pantalla(t)
    expect(
      t.db
        .prepare('SELECT count(*) AS n FROM usuario_credencial WHERE usuario_id = ?')
        .get(p.usuarioId),
    ).toEqual({ n: 0 })
    for (const cuerpo of [
      { usuario: 'cocina', contrasena: 'cocina' },
      { usuario: 'pantalla de cocina', contrasena: 'una-clave-larga' },
      { pin: '0000' },
    ]) {
      const r = await t.post('/api/entrar', cuerpo)
      expect(r.statusCode).toBe(401)
    }
  })

  it('no aparece en Personal ni en la carta, y su rol tampoco', async () => {
    const t = montarImpresion()
    const admin = t.equipo('admin', 'caja')
    const antes = (await t.post('/api/personal/leer', admin.cuerpoSesion, admin.token)).json()
    await pantalla(t)
    const r = await t.post('/api/personal/leer', admin.cuerpoSesion, admin.token)
    expect(r.statusCode).toBe(200)
    const despues = r.json()
    expect(despues.personas).toEqual(antes.personas)
    expect(despues.roles).toEqual(antes.roles)
    expect(JSON.stringify(despues.personas)).not.toContain('Cocina')
    expect(despues.roles.map((x: Json) => x.nombre)).not.toContain('Pantalla de cocina')
    // En Equipos sí está la tablet, para poder retirarla.
    expect(despues.equipos.some((e: Json) => e.tipo === 'kds')).toBe(true)
    const catalogo = leerCatalogo(t.db, t.restauranteId)
    expect(catalogo.personal.map((x) => x.nombre)).not.toContain('Cocina')
  })

  it('no se pueden asignar personas al rol oculto, ni cambiarlo, ni editar al usuario técnico', async () => {
    const t = montarImpresion()
    const admin = t.equipo('admin', 'caja')
    const p = await pantalla(t)
    const rolOculto = String(
      t.db.prepare('SELECT rol_id FROM usuario WHERE id = ?').get(p.usuarioId)?.rol_id,
    )
    const llamar = (url: string, cuerpo: Json) =>
      t.post(url, { ...admin.cuerpoSesion, ...cuerpo }, admin.token)

    // Una persona nueva en el rol oculto.
    const nueva = await llamar('/api/personal/personas', {
      persona: { nombre: 'Intruso', rol_id: rolOculto },
    })
    expect(nueva.statusCode).toBe(400)
    // Mover a una persona real al rol oculto.
    const ana = String(t.db.prepare("SELECT id FROM usuario WHERE nombre = 'Ana'").get()?.id)
    const mover = await llamar('/api/personal/personas', {
      persona: { id: ana, nombre: 'Ana', rol_id: rolOculto },
    })
    expect(mover.statusCode).toBe(400)
    // Editar al usuario técnico (nombre, regenerar PIN, ponerle contraseña).
    const rolMesero = String(
      t.db.prepare('SELECT rol_id FROM usuario WHERE id = ?').get(ana)?.rol_id,
    )
    for (const persona of [
      { id: p.usuarioId, nombre: 'Otro', rol_id: rolMesero },
      { id: p.usuarioId, nombre: 'Cocina', rol_id: rolMesero, regenerar_pin: true },
      {
        id: p.usuarioId,
        nombre: 'Cocina',
        rol_id: rolMesero,
        acceso: { tipo: 'contrasena', usuario: 'cocina1', contrasena: 'una-clave-larga' },
      },
      { id: p.usuarioId, nombre: 'Cocina', rol_id: rolMesero, activo: false },
    ]) {
      const r = await llamar('/api/personal/personas', { persona })
      expect(r.statusCode).toBe(400)
    }
    // Editar el rol oculto: permisos, nombre, archivarlo.
    for (const rol of [
      { id: rolOculto, nombre: 'Pantalla de cocina', permisos: ['tomar_pedido'] },
      { id: rolOculto, nombre: 'Pantalla de cocina', permisos: [], activo: false },
      { id: rolOculto, nombre: 'Otro nombre', permisos: ['marcar_preparacion', 'agotar_producto'] },
    ]) {
      const r = await llamar('/api/personal/roles', { rol })
      expect(r.statusCode).toBe(400)
    }
    // Nada cambió.
    const u = t.db.prepare('SELECT * FROM usuario WHERE id = ?').get(p.usuarioId)
    expect(u).toMatchObject({ nombre: 'Cocina', activo: 1, rol_id: rolOculto })
    expect(
      t.db
        .prepare('SELECT count(*) AS n FROM usuario_credencial WHERE usuario_id = ?')
        .get(p.usuarioId),
    ).toEqual({ n: 0 })
    expect(
      t.db
        .prepare('SELECT count(*) AS n FROM rol_permiso WHERE rol_id = ? AND activo = 1')
        .get(rolOculto),
    ).toEqual({ n: 2 })
    // Y un rol visible con el mismo nombre del oculto no choca con él.
    const mismo = await llamar('/api/personal/roles', {
      rol: { nombre: 'Pantalla de cocina', permisos: ['tomar_pedido'] },
    })
    expect(mismo.statusCode).toBe(200)
  })

  it('convertir dos veces la misma tablet reutiliza el usuario y el rol, y cambia nombre y estaciones', async () => {
    const t = montarImpresion()
    const p = await pantalla(t, [t.cocina], 'Cocina')
    // El administrador vuelve a entrar con su contraseña en esa tablet.
    const entro = t.entrar(p.tablet.conexion, 'admin')
    const r = await convertir(
      t,
      p.tablet,
      { nombre: 'Cocina y barra', estacion_ids: [t.cocina, t.barra] },
      { sesion_id: entro.sesionId, secreto: entro.secreto },
    )
    expect(r.statusCode).toBe(201)
    expect(r.json().usuario.id).toBe(p.usuarioId)
    const tecnicos = usuariosTecnicos(t)
    expect(tecnicos).toHaveLength(1)
    expect(tecnicos[0]).toMatchObject({ id: p.usuarioId, nombre: 'Cocina y barra', activo: 1 })
    expect(t.db.prepare('SELECT count(*) AS n FROM rol WHERE oculto = 1').get()).toEqual({ n: 1 })
    expect(t.db.prepare("SELECT count(*) AS n FROM dispositivo WHERE tipo = 'kds'").get()).toEqual({
      n: 1,
    })
    const d = t.db
      .prepare('SELECT estacion_ids, nombre FROM dispositivo WHERE id = ?')
      .get(p.tablet.conexion.dispositivoId)
    expect(d).toMatchObject({ nombre: 'Cocina y barra' })
    expect(JSON.parse(String(d?.estacion_ids))).toEqual([t.cocina, t.barra])
    // La sesión técnica anterior se cerró; la nueva sí marca.
    const nueva = r.json()
    expect(nueva.sesion_id).not.toBe(p.sesion.sesionId)
    expect(
      t.db
        .prepare('SELECT count(*) AS n FROM sesion WHERE dispositivo_id = ? AND cerrada_en IS NULL')
        .get(p.tablet.conexion.dispositivoId),
    ).toEqual({ n: 1 })
  })

  it('dos tablets son dos pantallas con dos usuarios técnicos y un solo rol oculto', async () => {
    const t = montarImpresion()
    const a = await pantalla(t, [t.cocina], 'Cocina')
    const b = await pantalla(t, [t.barra], 'Barra')
    expect(a.usuarioId).not.toBe(b.usuarioId)
    expect(usuariosTecnicos(t)).toHaveLength(2)
    expect(t.db.prepare('SELECT count(*) AS n FROM rol WHERE oculto = 1').get()).toEqual({ n: 1 })
    const catalogo = leerCatalogo(t.db, t.restauranteId)
    expect(catalogo.pantallas?.map((x) => x.nombre)).toEqual(['Barra', 'Cocina'])
    expect(catalogo.estaciones.find((e) => e.id === t.cocina)).toMatchObject({ pantalla: true })
    expect(catalogo.estaciones.find((e) => e.id === t.postres)).toMatchObject({ pantalla: false })
  })

  it('el nombre se recorta a 60 caracteres', async () => {
    const t = montarImpresion()
    const p = await pantalla(t, [t.cocina], 'x'.repeat(100))
    expect(p.respuesta.usuario.nombre).toHaveLength(60)
  })

  it.each([
    ['sin estaciones', { estacion_ids: [] }],
    ['estación que no existe', { estacion_ids: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'] }],
    ['estación con id corto', { estacion_ids: ['x'] }],
    ['nombre vacío', { nombre: '' }],
    ['nombre de espacios', { nombre: '     ' }],
    ['nombre de 101', { nombre: 'x'.repeat(101) }],
    ['nombre número', { nombre: 5 }],
    ['campo de más', { extra: 1 }],
  ])('%s da 400 y no cambia el equipo', async (_, extra) => {
    const t = montarImpresion()
    const tablet = t.equipo('admin', 'mesero')
    const r = await convertir(t, tablet, extra)
    expect(r.statusCode).toBe(400)
    expect(usuariosTecnicos(t)).toEqual([])
    expect(
      t.db.prepare('SELECT tipo FROM dispositivo WHERE id = ?').get(tablet.conexion.dispositivoId),
    ).toEqual({ tipo: 'caja' })
    // La sesión del administrador sigue abierta.
    expect(
      (await t.post('/api/cocina/configuracion', tablet.cuerpoSesion, tablet.token)).statusCode,
    ).toBe(200)
  })

  it('una estación archivada se rechaza al convertir', async () => {
    const t = montarImpresion()
    t.db.prepare('UPDATE estacion SET activo = 0 WHERE id = ?').run(t.postres)
    const tablet = t.equipo('admin', 'mesero')
    const r = await convertir(t, tablet, { estacion_ids: [t.postres] })
    expect(r.statusCode).toBe(400)
    expect(usuariosTecnicos(t)).toEqual([])
  })

  it('el PC del hub no se convierte en pantalla si así lo dice la configuración', async () => {
    const vistos: string[] = []
    const t = montarImpresion({
      esEquipoDelHub: (ip) => {
        vistos.push(ip)
        return ip === '10.0.0.20'
      },
    })
    const tablet = t.equipo('admin', 'caja')
    const r = await convertir(t, tablet)
    expect(r.statusCode).toBe(400)
    expect(r.json().mensaje).toMatch(/PC de la caja/)
    expect(vistos).toEqual(['10.0.0.20'])
    expect(usuariosTecnicos(t)).toEqual([])
    expect(
      t.db.prepare('SELECT tipo FROM dispositivo WHERE id = ?').get(tablet.conexion.dispositivoId),
    ).toEqual({ tipo: 'caja' })
    expect(
      (await t.post('/api/cocina/configuracion', tablet.cuerpoSesion, tablet.token)).statusCode,
    ).toBe(200)
  })

  it('avisa a los equipos (la carta cambia de versión) y despierta la cola', async () => {
    const t = montarImpresion()
    await pantalla(t)
    expect(t.cambiosCatalogo.length).toBeGreaterThan(0)
  })
})

describe('qué puede hacer la pantalla con su sesión', () => {
  /** Un pedido de la caja con un plato enviado, para que la pantalla lo marque. */
  function conPlatoEnviado(t: MontajeImpresion) {
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    t.enviar(ana, pedido, items)
    return { pedido, id: items[0]?.id as string, ana }
  }

  it('puede marcar listo y recuperar lo marcado por error', async () => {
    const t = montarImpresion()
    const p = await pantalla(t)
    const { pedido, id } = conPlatoEnviado(t)
    expect(p.mandar(pedido, 'ItemListo', { item_ids: [id] }).estado).toBe('confirmado')
    expect(t.hub.pedido(pedido)?.items[id]?.estado).toBe('listo')
    expect(p.mandar(pedido, 'ItemDevueltoACola', { item_ids: [id] }).estado).toBe('confirmado')
    expect(t.hub.pedido(pedido)?.items[id]?.estado).toBe('enviado')
    // Y queda a nombre de la pantalla.
    const e = t.db
      .prepare("SELECT usuario_id, dispositivo_id FROM evento WHERE tipo = 'ItemListo'")
      .get()
    expect(e).toEqual({ usuario_id: p.usuarioId, dispositivo_id: p.tablet.conexion.dispositivoId })
  })

  it('puede marcar agotados', async () => {
    const t = montarImpresion()
    const p = await pantalla(t)
    const permisos = (await t.post('/api/cocina/configuracion', p.cuerpoSesion, p.tablet.token))
      .statusCode
    expect(permisos).toBe(403)
    expect(
      t.acceso.usuarioConPermiso(
        p.tablet.conexion,
        { sesionId: p.sesion.sesionId, secreto: p.sesion.secreto },
        'agotar_producto',
      ),
    ).toMatchObject({ ok: true, usuarioId: p.usuarioId })
  })

  it.each([
    ['PedidoAbierto', { canal: 'salon', mesa_id: null, comensales: 2 }],
    ['PedidoCancelado', {}],
    ['PedidoCerrado', {}],
    ['DescuentoAplicado', null],
    ['PagoRegistrado', null],
  ])('no puede mandar %s', async (tipo, datos) => {
    const t = montarImpresion()
    const p = await pantalla(t)
    const { pedido } = conPlatoEnviado(t)
    const antes = Number(t.db.prepare('SELECT count(*) AS n FROM evento').get()?.n)
    const r = p.mandar(
      tipo === 'PedidoAbierto' ? (await import('@pos/core')).nuevoId() : pedido,
      tipo,
      datos ?? {},
    )
    expect(r.estado).toBe('rechazado')
    expect(Number(t.db.prepare('SELECT count(*) AS n FROM evento').get()?.n)).toBe(antes)
  })

  it('no puede agregar ni quitar productos, ni enviar, ni anular, ni mover', async () => {
    const t = montarImpresion()
    const p = await pantalla(t)
    const { pedido, id } = conPlatoEnviado(t)
    const item = {
      item_id: id,
      producto_id: id,
      variante_id: null,
      nombre: 'Otro',
      precio_unitario: 1000,
      impuesto_tipo: 'inc',
      tarifa: 800,
      cantidad: 1,
      comensal: null,
      curso: null,
      modificadores: [],
      notas: null,
      catalogo_version: 1,
      precio_canal_id: null,
    }
    const intentos: [string, unknown][] = [
      ['ItemAgregado', { ...item, item_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }],
      ['ItemQuitado', { item_id: id }],
      ['ItemsEnviados', { comandas: [{ comanda_id: id, estacion_id: t.cocina, item_ids: [id] }] }],
      ['ItemAnulado', { item_id: id, cantidad: 1, ya_preparado: false, comanda_id: null }],
      ['ComandaReimpresa', { comanda_id: id }],
      ['ComensalesCambiados', { comensales: 3 }],
      ['CursoRetenido', { curso: 'postre' }],
      ['MeseroAsignado', { mesero_id: p.usuarioId }],
    ]
    for (const [tipo, datos] of intentos) {
      const r = p.mandar(pedido, tipo, datos, { motivo: 'prueba' })
      // Por permiso, no por un cuerpo mal armado.
      expect({ tipo, estado: r.estado, motivo: r.motivo }).toEqual({
        tipo,
        estado: 'rechazado',
        motivo: 'sin_permiso',
      })
    }
  })

  it('no puede cobrar ni cerrar aunque el equipo sea de caja: no tiene el permiso', async () => {
    const t = montarImpresion()
    const p = await pantalla(t)
    const { pedido } = conPlatoEnviado(t)
    for (const tipo of ['PagoRegistrado', 'PedidoCerrado', 'PagoAnulado', 'ReembolsoRegistrado']) {
      const r = p.mandar(pedido, tipo, {})
      expect(r.estado, tipo).toBe('rechazado')
    }
  })

  it('no puede llamar las rutas de administración ni convertir otros equipos', async () => {
    const t = montarImpresion()
    const p = await pantalla(t)
    for (const [url, cuerpo] of [
      ['/api/cocina/configuracion', {}],
      ['/api/impresoras/prueba', { impresora_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }],
      ['/api/cocina/tiempos', { amarillo: 5, rojo: 9 }],
      ['/api/impresion/pendientes', {}],
      ['/api/pantallas', { nombre: 'Otra', estacion_ids: [t.cocina] }],
      ['/api/personal/leer', {}],
    ] as const) {
      const r = await t.post(url, { ...p.cuerpoSesion, ...cuerpo }, p.tablet.token)
      expect(r.statusCode, url).toBe(403)
    }
    expect(usuariosTecnicos(t)).toHaveLength(1)
  })
})

describe('retirar una pantalla', () => {
  it('archiva su usuario, cierra su sesión y rechaza sus eventos nuevos', async () => {
    const t = montarImpresion()
    const admin = t.equipo('admin', 'caja')
    const p = await pantalla(t)
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(ana, [
      { nombre: 'Tagliata', estacion: t.cocina },
      { nombre: 'Risotto', estacion: t.cocina },
    ])
    t.enviar(ana, pedido, items)
    expect(p.mandar(pedido, 'ItemListo', { item_ids: [items[0]?.id] }).estado).toBe('confirmado')

    t.avanzar(60_000)
    const r = await t.post(
      `/api/dispositivos/${p.tablet.conexion.dispositivoId}/revocar`,
      admin.cuerpoSesion,
      admin.token,
    )
    expect(r.statusCode).toBe(200)
    expect(t.db.prepare('SELECT activo FROM usuario WHERE id = ?').get(p.usuarioId)).toEqual({
      activo: 0,
    })
    expect(
      t.db
        .prepare('SELECT count(*) AS n FROM sesion WHERE dispositivo_id = ? AND cerrada_en IS NULL')
        .get(p.tablet.conexion.dispositivoId),
    ).toEqual({ n: 0 })
    // El usuario técnico no se borra: queda archivado con su historia.
    expect(t.db.prepare('SELECT count(*) AS n FROM usuario WHERE id = ?').get(p.usuarioId)).toEqual(
      { n: 1 },
    )

    t.avanzar(60_000)
    const despues = p.mandar(pedido, 'ItemListo', { item_ids: [items[1]?.id] })
    expect(despues.estado).toBe('rechazado')
    expect(t.hub.pedido(pedido)?.items[items[1]?.id as string]?.estado).toBe('enviado')
    // Sus rutas también dejan de servir.
    const cfg = await t.post('/api/cocina/configuracion', p.cuerpoSesion, p.tablet.token)
    expect(cfg.statusCode).toBe(401)
  })

  it('el usuario archivado ya no tiene permisos aunque alguien reabra la sesión', async () => {
    const t = montarImpresion()
    const admin = t.equipo('admin', 'caja')
    const p = await pantalla(t)
    await t.post(
      `/api/dispositivos/${p.tablet.conexion.dispositivoId}/revocar`,
      admin.cuerpoSesion,
      admin.token,
    )
    expect(t.acceso.permisosDe(p.usuarioId)).toEqual([])
  })

  it('la pantalla retirada sale de la carta y de la configuración; las demás siguen', async () => {
    const t = montarImpresion()
    const admin = t.equipo('admin', 'caja')
    const a = await pantalla(t, [t.cocina], 'Cocina')
    await pantalla(t, [t.barra], 'Barra')
    await t.post(
      `/api/dispositivos/${a.tablet.conexion.dispositivoId}/revocar`,
      admin.cuerpoSesion,
      admin.token,
    )
    const catalogo = leerCatalogo(t.db, t.restauranteId)
    expect(catalogo.pantallas?.map((x) => x.nombre)).toEqual(['Barra'])
    expect(catalogo.estaciones.find((e) => e.id === t.cocina)).toMatchObject({ pantalla: false })
    expect(catalogo.estaciones.find((e) => e.id === t.barra)).toMatchObject({ pantalla: true })
  })

  it('retirar un equipo común no archiva a ninguna persona', async () => {
    const t = montarImpresion()
    const admin = t.equipo('admin', 'caja')
    const ana = t.equipo('mesero')
    await t.post(
      `/api/dispositivos/${ana.conexion.dispositivoId}/revocar`,
      admin.cuerpoSesion,
      admin.token,
    )
    expect(t.db.prepare("SELECT activo FROM usuario WHERE nombre = 'Ana'").get()).toEqual({
      activo: 1,
    })
  })

  it('retirar la tablet cuando el último en entrar fue un administrador no archiva al administrador', async () => {
    const t = montarImpresion()
    const admin = t.equipo('admin', 'caja')
    const p = await pantalla(t)
    // El administrador entra en esa misma tablet para cambiar algo, y luego la retiran.
    t.entrar(p.tablet.conexion, 'admin')
    await t.post(
      `/api/dispositivos/${p.tablet.conexion.dispositivoId}/revocar`,
      admin.cuerpoSesion,
      admin.token,
    )
    expect(t.db.prepare("SELECT activo FROM usuario WHERE nombre = 'Administrador'").get()).toEqual(
      { activo: 1 },
    )
    expect(t.db.prepare('SELECT activo FROM usuario WHERE id = ?').get(p.usuarioId)).toEqual({
      activo: 0,
    })
  })
})
