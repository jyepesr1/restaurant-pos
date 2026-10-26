import { SCREEN_PERMISSIONS } from '@pos/core'
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
    '/api/screens',
    { ...cuerpoSesion, name: 'Cocina', station_ids: [t.kitchen], ...extra },
    tablet.token,
  )
}

/** Una tablet de la cocina ya convertida en pantalla; devuelve su sesión técnica. */
async function screen(t: MontajeImpresion, stations: string[] = [t.kitchen], name = 'Cocina') {
  const tablet = t.device('admin', 'waiter')
  const r = await convertir(t, tablet, { station_ids: stations, name })
  expect(r.statusCode).toBe(201)
  const c = r.json()
  const session = {
    sesionId: c.session_id as string,
    secret: c.secret as string,
    user: { id: c.user.id as string },
  }
  /** Un evento de esa pantalla, mandado al hub. */
  const mandar = (order: string, type: string, data: unknown, extras: Json = {}) => {
    const x = t.hub.recibirLote(tablet.connection, [
      t.event(tablet.connection, session, type, data, {
        aggregate_id: order,
        base_sequence: Number(
          t.db.prepare('SELECT coalesce(max(sequence), 0) AS s FROM events').get()?.s,
        ),
        ...extras,
      } as never),
    ])
    return x.resultados[0] as { status: string; reason?: string }
  }
  return {
    tablet,
    respuesta: c,
    session,
    userId: session.user.id,
    cuerpoSesion: { session_id: session.sesionId, secret: session.secret },
    mandar,
  }
}

const usuariosTecnicos = (t: MontajeImpresion) =>
  t.db.prepare('SELECT * FROM users WHERE screen = 1 ORDER BY created_at, id').all()

describe('convertir un equipo en pantalla de cocina', () => {
  it('crea el usuario técnico con un rol oculto que solo marca preparación y agotados', async () => {
    const t = montarImpresion()
    const p = await screen(t)
    expect(p.respuesta).toMatchObject({
      type: 'kds',
      user: { name: 'Cocina', role: 'Pantalla de cocina' },
    })
    expect([...p.respuesta.permissions].sort()).toEqual([...SCREEN_PERMISSIONS].sort())
    expect([...SCREEN_PERMISSIONS].sort()).toEqual(['mark_preparation', 'mark_product_sold_out'])

    const user = t.db.prepare('SELECT * FROM users WHERE id = ?').get(p.userId)
    expect(user).toMatchObject({ screen: 1, active: 1, name: 'Cocina' })
    const role = t.db.prepare('SELECT * FROM roles WHERE id = ?').get(user?.role_id as string)
    expect(role).toMatchObject({ hidden: 1, system: 1, name: 'Pantalla de cocina', active: 1 })
    const permissions = t.db
      .prepare(
        'SELECT permission FROM role_permissions WHERE role_id = ? AND active = 1 ORDER BY permission',
      )
      .all(role?.id as string)
      .map((f) => f.permission)
    expect(permissions).toEqual(['mark_preparation', 'mark_product_sold_out'])
  })

  it('el equipo queda como pantalla (kds) con sus estaciones y su nombre', async () => {
    const t = montarImpresion()
    const p = await screen(t, [t.kitchen, t.bar, t.kitchen], '  Cocina caliente ')
    const d = t.db
      .prepare('SELECT * FROM devices WHERE id = ?')
      .get(p.tablet.connection.dispositivoId)
    expect(d).toMatchObject({ type: 'kds', name: 'Cocina caliente' })
    expect(JSON.parse(String(d?.station_ids))).toEqual([t.kitchen, t.bar])
  })

  it('la sesión del administrador se cierra y queda solo la de la pantalla', async () => {
    const t = montarImpresion()
    const tablet = t.device('admin', 'waiter')
    const vieja = tablet.cuerpoSesion
    const r = await convertir(t, tablet)
    const newOne = r.json()
    const abiertas = t.db
      .prepare('SELECT id FROM sessions WHERE device_id = ? AND closed_at IS NULL')
      .all(tablet.connection.dispositivoId)
    expect(abiertas).toEqual([{ id: newOne.session_id }])
    // La sesión del administrador ya no sirve para nada: ni siquiera para volver a convertir.
    const another = await t.post('/api/kitchen/config', vieja, tablet.token)
    expect(another.statusCode).toBe(401)
  })

  it('el usuario técnico no puede entrar con PIN ni con contraseña (no tiene credenciales)', async () => {
    const t = montarImpresion()
    const p = await screen(t)
    expect(
      t.db.prepare('SELECT count(*) AS n FROM user_credentials WHERE user_id = ?').get(p.userId),
    ).toEqual({ n: 0 })
    for (const cuerpo of [
      { user: 'cocina', password: 'cocina' },
      { user: 'pantalla de cocina', password: 'una-clave-larga' },
      { pin: '0000' },
    ]) {
      const r = await t.post('/api/sign-in', cuerpo)
      expect(r.statusCode).toBe(401)
    }
  })

  it('no aparece en Personal ni en la carta, y su rol tampoco', async () => {
    const t = montarImpresion()
    const admin = t.device('admin', 'register')
    const before = (await t.post('/api/staff/read', admin.cuerpoSesion, admin.token)).json()
    await screen(t)
    const r = await t.post('/api/staff/read', admin.cuerpoSesion, admin.token)
    expect(r.statusCode).toBe(200)
    const after = r.json()
    expect(after.people).toEqual(before.people)
    expect(after.roles).toEqual(before.roles)
    expect(JSON.stringify(after.people)).not.toContain('Cocina')
    expect(after.roles.map((x: Json) => x.name)).not.toContain('Pantalla de cocina')
    // En Equipos sí está la tablet, para poder retirarla.
    expect(after.devices.some((e: Json) => e.type === 'kds')).toBe(true)
    const catalog = leerCatalogo(t.db, t.restauranteId)
    expect(catalog.staff.map((x) => x.name)).not.toContain('Cocina')
  })

  it('no se pueden asignar personas al rol oculto, ni cambiarlo, ni editar al usuario técnico', async () => {
    const t = montarImpresion()
    const admin = t.device('admin', 'register')
    const p = await screen(t)
    const rolOculto = String(
      t.db.prepare('SELECT role_id FROM users WHERE id = ?').get(p.userId)?.role_id,
    )
    const llamar = (url: string, cuerpo: Json) =>
      t.post(url, { ...admin.cuerpoSesion, ...cuerpo }, admin.token)

    // Una persona nueva en el rol oculto.
    const newOne = await llamar('/api/staff/people', {
      person: { name: 'Intruso', role_id: rolOculto },
    })
    expect(newOne.statusCode).toBe(400)
    // Mover a una persona real al rol oculto.
    const ana = String(t.db.prepare("SELECT id FROM users WHERE name = 'Ana'").get()?.id)
    const move = await llamar('/api/staff/people', {
      person: { id: ana, name: 'Ana', role_id: rolOculto },
    })
    expect(move.statusCode).toBe(400)
    // Editar al usuario técnico (nombre, regenerar PIN, ponerle contraseña).
    const rolMesero = String(
      t.db.prepare('SELECT role_id FROM users WHERE id = ?').get(ana)?.role_id,
    )
    for (const person of [
      { id: p.userId, name: 'Otro', role_id: rolMesero },
      { id: p.userId, name: 'Cocina', role_id: rolMesero, regenerar_pin: true },
      {
        id: p.userId,
        name: 'Cocina',
        role_id: rolMesero,
        access: { type: 'password', user: 'cocina1', password: 'una-clave-larga' },
      },
      { id: p.userId, name: 'Cocina', role_id: rolMesero, active: false },
    ]) {
      const r = await llamar('/api/staff/people', { person })
      expect(r.statusCode).toBe(400)
    }
    // Editar el rol oculto: permisos, nombre, archivarlo.
    for (const role of [
      { id: rolOculto, name: 'Pantalla de cocina', permissions: ['take_order'] },
      { id: rolOculto, name: 'Pantalla de cocina', permissions: [], active: false },
      {
        id: rolOculto,
        name: 'Otro nombre',
        permissions: ['mark_preparation', 'mark_product_sold_out'],
      },
    ]) {
      const r = await llamar('/api/staff/roles', { role })
      expect(r.statusCode).toBe(400)
    }
    // Nada cambió.
    const u = t.db.prepare('SELECT * FROM users WHERE id = ?').get(p.userId)
    expect(u).toMatchObject({ name: 'Cocina', active: 1, role_id: rolOculto })
    expect(
      t.db.prepare('SELECT count(*) AS n FROM user_credentials WHERE user_id = ?').get(p.userId),
    ).toEqual({ n: 0 })
    expect(
      t.db
        .prepare('SELECT count(*) AS n FROM role_permissions WHERE role_id = ? AND active = 1')
        .get(rolOculto),
    ).toEqual({ n: 2 })
    // Y un rol visible con el mismo nombre del oculto no choca con él.
    const same = await llamar('/api/staff/roles', {
      role: { name: 'Pantalla de cocina', permissions: ['take_order'] },
    })
    expect(same.statusCode).toBe(200)
  })

  it('convertir dos veces la misma tablet reutiliza el usuario y el rol, y cambia nombre y estaciones', async () => {
    const t = montarImpresion()
    const p = await screen(t, [t.kitchen], 'Cocina')
    // El administrador vuelve a entrar con su contraseña en esa tablet.
    const entro = t.entrar(p.tablet.connection, 'admin')
    const r = await convertir(
      t,
      p.tablet,
      { name: 'Cocina y barra', station_ids: [t.kitchen, t.bar] },
      { session_id: entro.sesionId, secret: entro.secret },
    )
    expect(r.statusCode).toBe(201)
    expect(r.json().user.id).toBe(p.userId)
    const tecnicos = usuariosTecnicos(t)
    expect(tecnicos).toHaveLength(1)
    expect(tecnicos[0]).toMatchObject({ id: p.userId, name: 'Cocina y barra', active: 1 })
    expect(t.db.prepare('SELECT count(*) AS n FROM roles WHERE hidden = 1').get()).toEqual({ n: 1 })
    expect(t.db.prepare("SELECT count(*) AS n FROM devices WHERE type = 'kds'").get()).toEqual({
      n: 1,
    })
    const d = t.db
      .prepare('SELECT station_ids, name FROM devices WHERE id = ?')
      .get(p.tablet.connection.dispositivoId)
    expect(d).toMatchObject({ name: 'Cocina y barra' })
    expect(JSON.parse(String(d?.station_ids))).toEqual([t.kitchen, t.bar])
    // La sesión técnica anterior se cerró; la nueva sí marca.
    const newOne = r.json()
    expect(newOne.session_id).not.toBe(p.session.sesionId)
    expect(
      t.db
        .prepare('SELECT count(*) AS n FROM sessions WHERE device_id = ? AND closed_at IS NULL')
        .get(p.tablet.connection.dispositivoId),
    ).toEqual({ n: 1 })
  })

  it('dos tablets son dos pantallas con dos usuarios técnicos y un solo rol oculto', async () => {
    const t = montarImpresion()
    const a = await screen(t, [t.kitchen], 'Cocina')
    const b = await screen(t, [t.bar], 'Barra')
    expect(a.userId).not.toBe(b.userId)
    expect(usuariosTecnicos(t)).toHaveLength(2)
    expect(t.db.prepare('SELECT count(*) AS n FROM roles WHERE hidden = 1').get()).toEqual({ n: 1 })
    const catalog = leerCatalogo(t.db, t.restauranteId)
    expect(catalog.pantallas?.map((x) => x.name)).toEqual(['Barra', 'Cocina'])
    expect(catalog.stations.find((e) => e.id === t.kitchen)).toMatchObject({ screen: true })
    expect(catalog.stations.find((e) => e.id === t.postres)).toMatchObject({ screen: false })
  })

  it('el nombre se recorta a 60 caracteres', async () => {
    const t = montarImpresion()
    const p = await screen(t, [t.kitchen], 'x'.repeat(100))
    expect(p.respuesta.user.name).toHaveLength(60)
  })

  it.each([
    ['sin estaciones', { station_ids: [] }],
    ['estación que no existe', { station_ids: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'] }],
    ['estación con id corto', { station_ids: ['x'] }],
    ['nombre vacío', { name: '' }],
    ['nombre de espacios', { name: '     ' }],
    ['nombre de 101', { name: 'x'.repeat(101) }],
    ['nombre número', { name: 5 }],
    ['campo de más', { extra: 1 }],
  ])('%s da 400 y no cambia el equipo', async (_, extra) => {
    const t = montarImpresion()
    const tablet = t.device('admin', 'waiter')
    const r = await convertir(t, tablet, extra)
    expect(r.statusCode).toBe(400)
    expect(usuariosTecnicos(t)).toEqual([])
    expect(
      t.db.prepare('SELECT type FROM devices WHERE id = ?').get(tablet.connection.dispositivoId),
    ).toEqual({ type: 'register' })
    // La sesión del administrador sigue abierta.
    expect(
      (await t.post('/api/kitchen/config', tablet.cuerpoSesion, tablet.token)).statusCode,
    ).toBe(200)
  })

  it('una estación archivada se rechaza al convertir', async () => {
    const t = montarImpresion()
    t.db.prepare('UPDATE stations SET active = 0 WHERE id = ?').run(t.postres)
    const tablet = t.device('admin', 'waiter')
    const r = await convertir(t, tablet, { station_ids: [t.postres] })
    expect(r.statusCode).toBe(400)
    expect(usuariosTecnicos(t)).toEqual([])
  })

  it('el PC del hub no se convierte en pantalla si así lo dice la configuración', async () => {
    const seenSet: string[] = []
    const t = montarImpresion({
      esEquipoDelHub: (ip) => {
        seenSet.push(ip)
        return ip === '10.0.0.20'
      },
    })
    const tablet = t.device('admin', 'register')
    const r = await convertir(t, tablet)
    expect(r.statusCode).toBe(400)
    expect(r.json().message).toMatch(/PC de la caja/)
    expect(seenSet).toEqual(['10.0.0.20'])
    expect(usuariosTecnicos(t)).toEqual([])
    expect(
      t.db.prepare('SELECT type FROM devices WHERE id = ?').get(tablet.connection.dispositivoId),
    ).toEqual({ type: 'register' })
    expect(
      (await t.post('/api/kitchen/config', tablet.cuerpoSesion, tablet.token)).statusCode,
    ).toBe(200)
  })

  it('avisa a los equipos (la carta cambia de versión) y despierta la cola', async () => {
    const t = montarImpresion()
    await screen(t)
    expect(t.cambiosCatalogo.length).toBeGreaterThan(0)
  })
})

describe('qué puede hacer la pantalla con su sesión', () => {
  /** Un pedido de la caja con un plato enviado, para que la pantalla lo marque. */
  function conPlatoEnviado(t: MontajeImpresion) {
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    return { order, id: items[0]?.id as string, ana }
  }

  it('puede marcar listo y recuperar lo marcado por error', async () => {
    const t = montarImpresion()
    const p = await screen(t)
    const { order, id } = conPlatoEnviado(t)
    expect(p.mandar(order, 'ItemReady', { item_ids: [id] }).status).toBe('confirmed')
    expect(t.hub.order(order)?.items[id]?.status).toBe('ready')
    expect(p.mandar(order, 'ItemReturnedToQueue', { item_ids: [id] }).status).toBe('confirmed')
    expect(t.hub.order(order)?.items[id]?.status).toBe('sent')
    // Y queda a nombre de la pantalla.
    const e = t.db.prepare("SELECT user_id, device_id FROM events WHERE type = 'ItemReady'").get()
    expect(e).toEqual({ user_id: p.userId, device_id: p.tablet.connection.dispositivoId })
  })

  it('puede marcar agotados', async () => {
    const t = montarImpresion()
    const p = await screen(t)
    const permissions = (await t.post('/api/kitchen/config', p.cuerpoSesion, p.tablet.token))
      .statusCode
    expect(permissions).toBe(403)
    expect(
      t.access.usuarioConPermiso(
        p.tablet.connection,
        { sesionId: p.session.sesionId, secret: p.session.secret },
        'mark_product_sold_out',
      ),
    ).toMatchObject({ ok: true, userId: p.userId })
  })

  it.each([
    ['OrderOpened', { channel: 'dine_in', table_id: null, guests: 2 }],
    ['OrderCanceled', {}],
    ['OrderClosed', {}],
    ['DiscountApplied', null],
    ['PaymentRecorded', null],
  ])('no puede mandar %s', async (type, data) => {
    const t = montarImpresion()
    const p = await screen(t)
    const { order } = conPlatoEnviado(t)
    const before = Number(t.db.prepare('SELECT count(*) AS n FROM events').get()?.n)
    const r = p.mandar(
      type === 'OrderOpened' ? (await import('@pos/core')).newId() : order,
      type,
      data ?? {},
    )
    expect(r.status).toBe('rejected')
    expect(Number(t.db.prepare('SELECT count(*) AS n FROM events').get()?.n)).toBe(before)
  })

  it('no puede agregar ni quitar productos, ni enviar, ni anular, ni mover', async () => {
    const t = montarImpresion()
    const p = await screen(t)
    const { order, id } = conPlatoEnviado(t)
    const item = {
      item_id: id,
      product_id: id,
      variant_id: null,
      name: 'Otro',
      unit_price: 1000,
      tax_type: 'inc',
      rate: 800,
      quantity: 1,
      guest: null,
      course: null,
      modifiers: [],
      notes: null,
      catalog_version: 1,
      price_channel_id: null,
    }
    const attempts: [string, unknown][] = [
      ['ItemAdded', { ...item, item_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }],
      ['ItemRemoved', { item_id: id }],
      ['ItemsSent', { tickets: [{ ticket_id: id, station_id: t.kitchen, item_ids: [id] }] }],
      ['ItemVoided', { item_id: id, quantity: 1, already_prepared: false, ticket_id: null }],
      ['TicketReprinted', { ticket_id: id }],
      ['GuestsChanged', { guests: 3 }],
      ['CourseHeld', { course: 'dessert' }],
      ['WaiterAssigned', { waiter_id: p.userId }],
    ]
    for (const [type, data] of attempts) {
      const r = p.mandar(order, type, data, { reason: 'prueba' })
      // Por permiso, no por un cuerpo mal armado.
      expect({ type, status: r.status, reason: r.reason }).toEqual({
        type,
        status: 'rejected',
        reason: 'no_permission',
      })
    }
  })

  it('no puede cobrar ni cerrar aunque el equipo sea de caja: no tiene el permiso', async () => {
    const t = montarImpresion()
    const p = await screen(t)
    const { order } = conPlatoEnviado(t)
    for (const type of ['PaymentRecorded', 'OrderClosed', 'PaymentVoided', 'RefundRecorded']) {
      const r = p.mandar(order, type, {})
      expect(r.status, type).toBe('rejected')
    }
  })

  it('no puede llamar las rutas de administración ni convertir otros equipos', async () => {
    const t = montarImpresion()
    const p = await screen(t)
    for (const [url, cuerpo] of [
      ['/api/kitchen/config', {}],
      ['/api/printers/test', { printer_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }],
      ['/api/kitchen/timers', { amarillo: 5, rojo: 9 }],
      ['/api/printing/pending', {}],
      ['/api/screens', { name: 'Otra', station_ids: [t.kitchen] }],
      ['/api/staff/read', {}],
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
    const admin = t.device('admin', 'register')
    const p = await screen(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [
      { name: 'Tagliata', station: t.kitchen },
      { name: 'Risotto', station: t.kitchen },
    ])
    t.send(ana, order, items)
    expect(p.mandar(order, 'ItemReady', { item_ids: [items[0]?.id] }).status).toBe('confirmed')

    t.advance(60_000)
    const r = await t.post(
      `/api/devices/${p.tablet.connection.dispositivoId}/revoke`,
      admin.cuerpoSesion,
      admin.token,
    )
    expect(r.statusCode).toBe(200)
    expect(t.db.prepare('SELECT active FROM users WHERE id = ?').get(p.userId)).toEqual({
      active: 0,
    })
    expect(
      t.db
        .prepare('SELECT count(*) AS n FROM sessions WHERE device_id = ? AND closed_at IS NULL')
        .get(p.tablet.connection.dispositivoId),
    ).toEqual({ n: 0 })
    // El usuario técnico no se borra: queda archivado con su historia.
    expect(t.db.prepare('SELECT count(*) AS n FROM users WHERE id = ?').get(p.userId)).toEqual({
      n: 1,
    })

    t.advance(60_000)
    const after = p.mandar(order, 'ItemReady', { item_ids: [items[1]?.id] })
    expect(after.status).toBe('rejected')
    expect(t.hub.order(order)?.items[items[1]?.id as string]?.status).toBe('sent')
    // Sus rutas también dejan de servir.
    const cfg = await t.post('/api/kitchen/config', p.cuerpoSesion, p.tablet.token)
    expect(cfg.statusCode).toBe(401)
  })

  it('el usuario archivado ya no tiene permisos aunque alguien reabra la sesión', async () => {
    const t = montarImpresion()
    const admin = t.device('admin', 'register')
    const p = await screen(t)
    await t.post(
      `/api/devices/${p.tablet.connection.dispositivoId}/revoke`,
      admin.cuerpoSesion,
      admin.token,
    )
    expect(t.access.permisosDe(p.userId)).toEqual([])
  })

  it('la pantalla retirada sale de la carta y de la configuración; las demás siguen', async () => {
    const t = montarImpresion()
    const admin = t.device('admin', 'register')
    const a = await screen(t, [t.kitchen], 'Cocina')
    await screen(t, [t.bar], 'Barra')
    await t.post(
      `/api/devices/${a.tablet.connection.dispositivoId}/revoke`,
      admin.cuerpoSesion,
      admin.token,
    )
    const catalog = leerCatalogo(t.db, t.restauranteId)
    expect(catalog.pantallas?.map((x) => x.name)).toEqual(['Barra'])
    expect(catalog.stations.find((e) => e.id === t.kitchen)).toMatchObject({ screen: false })
    expect(catalog.stations.find((e) => e.id === t.bar)).toMatchObject({ screen: true })
  })

  it('retirar un equipo común no archiva a ninguna persona', async () => {
    const t = montarImpresion()
    const admin = t.device('admin', 'register')
    const ana = t.device('waiter')
    await t.post(
      `/api/devices/${ana.connection.dispositivoId}/revoke`,
      admin.cuerpoSesion,
      admin.token,
    )
    expect(t.db.prepare("SELECT active FROM users WHERE name = 'Ana'").get()).toEqual({
      active: 1,
    })
  })

  it('retirar la tablet cuando el último en entrar fue un administrador no archiva al administrador', async () => {
    const t = montarImpresion()
    const admin = t.device('admin', 'register')
    const p = await screen(t)
    // El administrador entra en esa misma tablet para cambiar algo, y luego la retiran.
    t.entrar(p.tablet.connection, 'admin')
    await t.post(
      `/api/devices/${p.tablet.connection.dispositivoId}/revoke`,
      admin.cuerpoSesion,
      admin.token,
    )
    expect(t.db.prepare("SELECT active FROM users WHERE name = 'Administrador'").get()).toEqual({
      active: 1,
    })
    expect(t.db.prepare('SELECT active FROM users WHERE id = ?').get(p.userId)).toEqual({
      active: 0,
    })
  })
})
