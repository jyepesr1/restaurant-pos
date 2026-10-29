import { SCREEN_PERMISSIONS } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { readCatalog } from '../catalog'
import { type Device, type PrintingSetup, setupPrinting } from './printing-setup'

// Optional kitchen screen (KDS) (ADR-015): the admin converts a device with their password; it
// belongs to a technical user that only marks ready and sold out, that is not a person in Staff
// and that leaves with the device when it is retired.

type Json = Record<string, unknown>

async function convert(
  t: PrintingSetup,
  tablet: Device,
  extra: Json = {},
  sessionBody: Json = tablet.sessionBody,
) {
  return t.post(
    '/api/screens',
    { ...sessionBody, name: 'Cocina', station_ids: [t.kitchen], ...extra },
    tablet.token,
  )
}

/** A kitchen tablet already converted into a screen; returns its technical session. */
async function screen(t: PrintingSetup, stations: string[] = [t.kitchen], name = 'Cocina') {
  const tablet = t.device('admin', 'waiter')
  const r = await convert(t, tablet, { station_ids: stations, name })
  expect(r.statusCode).toBe(201)
  const c = r.json()
  const session = {
    sessionId: c.session_id as string,
    secret: c.secret as string,
    user: { id: c.user.id as string },
  }
  /** An event from that screen, sent to the hub. */
  const submit = (order: string, type: string, data: unknown, extras: Json = {}) => {
    const x = t.hub.receiveBatch(tablet.connection, [
      t.event(tablet.connection, session, type, data, {
        aggregate_id: order,
        base_sequence: Number(
          t.db.prepare('SELECT coalesce(max(sequence), 0) AS s FROM events').get()?.s,
        ),
        ...extras,
      } as never),
    ])
    return x.results[0] as { status: string; reason?: string }
  }
  return {
    tablet,
    response: c,
    session,
    userId: session.user.id,
    sessionBody: { session_id: session.sessionId, secret: session.secret },
    submit,
  }
}

const technicalUsers = (t: PrintingSetup) =>
  t.db.prepare('SELECT * FROM users WHERE screen = 1 ORDER BY created_at, id').all()

describe('convert a device into a kitchen screen', () => {
  it('creates the technical user with a hidden role that only marks preparation and sold out', async () => {
    const t = setupPrinting()
    const p = await screen(t)
    expect(p.response).toMatchObject({
      type: 'kds',
      user: { name: 'Cocina', role: 'Pantalla de cocina' },
    })
    expect([...p.response.permissions].sort()).toEqual([...SCREEN_PERMISSIONS].sort())
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

  it('the device becomes a screen (kds) with its stations and its name', async () => {
    const t = setupPrinting()
    const p = await screen(t, [t.kitchen, t.bar, t.kitchen], '  Cocina caliente ')
    const d = t.db.prepare('SELECT * FROM devices WHERE id = ?').get(p.tablet.connection.deviceId)
    expect(d).toMatchObject({ type: 'kds', name: 'Cocina caliente' })
    expect(JSON.parse(String(d?.station_ids))).toEqual([t.kitchen, t.bar])
  })

  it('the admin session is closed and only the screen session remains', async () => {
    const t = setupPrinting()
    const tablet = t.device('admin', 'waiter')
    const old = tablet.sessionBody
    const r = await convert(t, tablet)
    const converted = r.json()
    const openHandles = t.db
      .prepare('SELECT id FROM sessions WHERE device_id = ? AND closed_at IS NULL')
      .all(tablet.connection.deviceId)
    expect(openHandles).toEqual([{ id: converted.session_id }])
    // The admin session is no longer good for anything: not even to convert again.
    const another = await t.post('/api/kitchen/config', old, tablet.token)
    expect(another.statusCode).toBe(401)
  })

  it('the technical user cannot sign in with a PIN or a password (it has no credentials)', async () => {
    const t = setupPrinting()
    const p = await screen(t)
    expect(
      t.db.prepare('SELECT count(*) AS n FROM user_credentials WHERE user_id = ?').get(p.userId),
    ).toEqual({ n: 0 })
    for (const body of [
      { user: 'cocina', password: 'cocina' },
      { user: 'pantalla de cocina', password: 'una-clave-larga' },
      { pin: '0000' },
    ]) {
      const r = await t.post('/api/sign-in', body)
      expect(r.statusCode).toBe(401)
    }
  })

  it('does not appear in Staff or in the menu, and neither does its role', async () => {
    const t = setupPrinting()
    const admin = t.device('admin', 'register')
    const before = (await t.post('/api/staff/read', admin.sessionBody, admin.token)).json()
    await screen(t)
    const r = await t.post('/api/staff/read', admin.sessionBody, admin.token)
    expect(r.statusCode).toBe(200)
    const after = r.json()
    expect(after.people).toEqual(before.people)
    expect(after.roles).toEqual(before.roles)
    expect(JSON.stringify(after.people)).not.toContain('Cocina')
    expect(after.roles.map((x: Json) => x.name)).not.toContain('Pantalla de cocina')
    // The tablet does appear in Devices, so it can be retired.
    expect(after.devices.some((e: Json) => e.type === 'kds')).toBe(true)
    const catalog = readCatalog(t.db, t.restaurantId)
    expect(catalog.staff.map((x) => x.name)).not.toContain('Cocina')
  })

  it('people cannot be assigned to the hidden role, nor can it be changed, nor the technical user edited', async () => {
    const t = setupPrinting()
    const admin = t.device('admin', 'register')
    const p = await screen(t)
    const hiddenRole = String(
      t.db.prepare('SELECT role_id FROM users WHERE id = ?').get(p.userId)?.role_id,
    )
    const makeCall = (url: string, body: Json) =>
      t.post(url, { ...admin.sessionBody, ...body }, admin.token)

    // A new person in the hidden role.
    const created = await makeCall('/api/staff/people', {
      person: { name: 'Intruso', role_id: hiddenRole },
    })
    expect(created.statusCode).toBe(400)
    // Move a real person to the hidden role.
    const ana = String(t.db.prepare("SELECT id FROM users WHERE name = 'Ana'").get()?.id)
    const move = await makeCall('/api/staff/people', {
      person: { id: ana, name: 'Ana', role_id: hiddenRole },
    })
    expect(move.statusCode).toBe(400)
    // Edit the technical user (name, regenerate PIN, give it a password).
    const waiterRole = String(
      t.db.prepare('SELECT role_id FROM users WHERE id = ?').get(ana)?.role_id,
    )
    for (const person of [
      { id: p.userId, name: 'Otro', role_id: waiterRole },
      { id: p.userId, name: 'Cocina', role_id: waiterRole, regenerate_pin: true },
      {
        id: p.userId,
        name: 'Cocina',
        role_id: waiterRole,
        access: { type: 'password', user: 'cocina1', password: 'una-clave-larga' },
      },
      { id: p.userId, name: 'Cocina', role_id: waiterRole, active: false },
    ]) {
      const r = await makeCall('/api/staff/people', { person })
      expect(r.statusCode).toBe(400)
    }
    // Edit the hidden role: permissions, name, archive it.
    for (const role of [
      { id: hiddenRole, name: 'Pantalla de cocina', permissions: ['take_order'] },
      { id: hiddenRole, name: 'Pantalla de cocina', permissions: [], active: false },
      {
        id: hiddenRole,
        name: 'Otro nombre',
        permissions: ['mark_preparation', 'mark_product_sold_out'],
      },
    ]) {
      const r = await makeCall('/api/staff/roles', { role })
      expect(r.statusCode).toBe(400)
    }
    // Nothing changed.
    const u = t.db.prepare('SELECT * FROM users WHERE id = ?').get(p.userId)
    expect(u).toMatchObject({ name: 'Cocina', active: 1, role_id: hiddenRole })
    expect(
      t.db.prepare('SELECT count(*) AS n FROM user_credentials WHERE user_id = ?').get(p.userId),
    ).toEqual({ n: 0 })
    expect(
      t.db
        .prepare('SELECT count(*) AS n FROM role_permissions WHERE role_id = ? AND active = 1')
        .get(hiddenRole),
    ).toEqual({ n: 2 })
    // And a visible role with the same name as the hidden one does not clash with it.
    const same = await makeCall('/api/staff/roles', {
      role: { name: 'Pantalla de cocina', permissions: ['take_order'] },
    })
    expect(same.statusCode).toBe(200)
  })

  it('converting the same tablet twice reuses the user and the role, and changes name and stations', async () => {
    const t = setupPrinting()
    const p = await screen(t, [t.kitchen], 'Cocina')
    // The admin signs in again with their password on that tablet.
    const signedIn = t.signIn(p.tablet.connection, 'admin')
    const r = await convert(
      t,
      p.tablet,
      { name: 'Cocina y barra', station_ids: [t.kitchen, t.bar] },
      { session_id: signedIn.sessionId, secret: signedIn.secret },
    )
    expect(r.statusCode).toBe(201)
    expect(r.json().user.id).toBe(p.userId)
    const technical = technicalUsers(t)
    expect(technical).toHaveLength(1)
    expect(technical[0]).toMatchObject({ id: p.userId, name: 'Cocina y barra', active: 1 })
    expect(t.db.prepare('SELECT count(*) AS n FROM roles WHERE hidden = 1').get()).toEqual({ n: 1 })
    expect(t.db.prepare("SELECT count(*) AS n FROM devices WHERE type = 'kds'").get()).toEqual({
      n: 1,
    })
    const d = t.db
      .prepare('SELECT station_ids, name FROM devices WHERE id = ?')
      .get(p.tablet.connection.deviceId)
    expect(d).toMatchObject({ name: 'Cocina y barra' })
    expect(JSON.parse(String(d?.station_ids))).toEqual([t.kitchen, t.bar])
    // The previous technical session was closed; the new one can mark.
    const converted = r.json()
    expect(converted.session_id).not.toBe(p.session.sessionId)
    expect(
      t.db
        .prepare('SELECT count(*) AS n FROM sessions WHERE device_id = ? AND closed_at IS NULL')
        .get(p.tablet.connection.deviceId),
    ).toEqual({ n: 1 })
  })

  it('two tablets are two screens with two technical users and a single hidden role', async () => {
    const t = setupPrinting()
    const a = await screen(t, [t.kitchen], 'Cocina')
    const b = await screen(t, [t.bar], 'Barra')
    expect(a.userId).not.toBe(b.userId)
    expect(technicalUsers(t)).toHaveLength(2)
    expect(t.db.prepare('SELECT count(*) AS n FROM roles WHERE hidden = 1').get()).toEqual({ n: 1 })
    const catalog = readCatalog(t.db, t.restaurantId)
    expect(catalog.screens?.map((x) => x.name)).toEqual(['Barra', 'Cocina'])
    expect(catalog.stations.find((e) => e.id === t.kitchen)).toMatchObject({ screen: true })
    expect(catalog.stations.find((e) => e.id === t.desserts)).toMatchObject({ screen: false })
  })

  it('the name is truncated to 60 characters', async () => {
    const t = setupPrinting()
    const p = await screen(t, [t.kitchen], 'x'.repeat(100))
    expect(p.response.user.name).toHaveLength(60)
  })

  it.each([
    ['no stations', { station_ids: [] }],
    ['nonexistent station', { station_ids: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'] }],
    ['station with a short id', { station_ids: ['x'] }],
    ['empty name', { name: '' }],
    ['name of spaces', { name: '     ' }],
    ['name of 101', { name: 'x'.repeat(101) }],
    ['numeric name', { name: 5 }],
    ['extra field', { extra: 1 }],
  ])('%s gives 400 and does not change the device', async (_, extra) => {
    const t = setupPrinting()
    const tablet = t.device('admin', 'waiter')
    const r = await convert(t, tablet, extra)
    expect(r.statusCode).toBe(400)
    expect(technicalUsers(t)).toEqual([])
    expect(
      t.db.prepare('SELECT type FROM devices WHERE id = ?').get(tablet.connection.deviceId),
    ).toEqual({ type: 'register' })
    // The admin session stays open.
    expect((await t.post('/api/kitchen/config', tablet.sessionBody, tablet.token)).statusCode).toBe(
      200,
    )
  })

  it('an archived station is rejected when converting', async () => {
    const t = setupPrinting()
    t.db.prepare('UPDATE stations SET active = 0 WHERE id = ?').run(t.desserts)
    const tablet = t.device('admin', 'waiter')
    const r = await convert(t, tablet, { station_ids: [t.desserts] })
    expect(r.statusCode).toBe(400)
    expect(technicalUsers(t)).toEqual([])
  })

  it('the hub PC is not converted into a screen if the config says so', async () => {
    const seenSet: string[] = []
    const t = setupPrinting({
      isHubDevice: (ip) => {
        seenSet.push(ip)
        return ip === '10.0.0.20'
      },
    })
    const tablet = t.device('admin', 'register')
    const r = await convert(t, tablet)
    expect(r.statusCode).toBe(400)
    expect(r.json().message).toMatch(/PC de la caja/)
    expect(seenSet).toEqual(['10.0.0.20'])
    expect(technicalUsers(t)).toEqual([])
    expect(
      t.db.prepare('SELECT type FROM devices WHERE id = ?').get(tablet.connection.deviceId),
    ).toEqual({ type: 'register' })
    expect((await t.post('/api/kitchen/config', tablet.sessionBody, tablet.token)).statusCode).toBe(
      200,
    )
  })

  it('alerts the devices (the menu changes version) and wakes the queue', async () => {
    const t = setupPrinting()
    await screen(t)
    expect(t.catalogChanges.length).toBeGreaterThan(0)
  })
})

describe('what the screen can do with its session', () => {
  /** A register order with a sent dish, for the screen to mark. */
  function withSentDish(t: PrintingSetup) {
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    return { order, id: items[0]?.id as string, ana }
  }

  it('can mark ready and undo what was marked by mistake', async () => {
    const t = setupPrinting()
    const p = await screen(t)
    const { order, id } = withSentDish(t)
    expect(p.submit(order, 'ItemReady', { item_ids: [id] }).status).toBe('confirmed')
    expect(t.hub.order(order)?.items[id]?.status).toBe('ready')
    expect(p.submit(order, 'ItemReturnedToQueue', { item_ids: [id] }).status).toBe('confirmed')
    expect(t.hub.order(order)?.items[id]?.status).toBe('sent')
    // And it is recorded under the screen.
    const e = t.db.prepare("SELECT user_id, device_id FROM events WHERE type = 'ItemReady'").get()
    expect(e).toEqual({ user_id: p.userId, device_id: p.tablet.connection.deviceId })
  })

  it('can mark sold out', async () => {
    const t = setupPrinting()
    const p = await screen(t)
    const permissions = (await t.post('/api/kitchen/config', p.sessionBody, p.tablet.token))
      .statusCode
    expect(permissions).toBe(403)
    expect(
      t.access.userWithPermission(
        p.tablet.connection,
        { sessionId: p.session.sessionId, secret: p.session.secret },
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
  ])('cannot send %s', async (type, data) => {
    const t = setupPrinting()
    const p = await screen(t)
    const { order } = withSentDish(t)
    const before = Number(t.db.prepare('SELECT count(*) AS n FROM events').get()?.n)
    const r = p.submit(
      type === 'OrderOpened' ? (await import('@pos/core')).newId() : order,
      type,
      data ?? {},
    )
    expect(r.status).toBe('rejected')
    expect(Number(t.db.prepare('SELECT count(*) AS n FROM events').get()?.n)).toBe(before)
  })

  it('cannot add or remove products, send, void or move', async () => {
    const t = setupPrinting()
    const p = await screen(t)
    const { order, id } = withSentDish(t)
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
      const r = p.submit(order, type, data, { reason: 'prueba' })
      // Because of the permission, not a malformed body.
      expect({ type, status: r.status, reason: r.reason }).toEqual({
        type,
        status: 'rejected',
        reason: 'no_permission',
      })
    }
  })

  it('cannot charge or close even if the device is a register: it lacks the permission', async () => {
    const t = setupPrinting()
    const p = await screen(t)
    const { order } = withSentDish(t)
    for (const type of ['PaymentRecorded', 'OrderClosed', 'PaymentVoided', 'RefundRecorded']) {
      const r = p.submit(order, type, {})
      expect(r.status, type).toBe('rejected')
    }
  })

  it('cannot call the admin routes or convert other devices', async () => {
    const t = setupPrinting()
    const p = await screen(t)
    for (const [url, body] of [
      ['/api/kitchen/config', {}],
      ['/api/printers/test', { printer_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }],
      ['/api/kitchen/timers', { yellow: 5, red: 9 }],
      ['/api/printing/pending', {}],
      ['/api/screens', { name: 'Otra', station_ids: [t.kitchen] }],
      ['/api/staff/read', {}],
    ] as const) {
      const r = await t.post(url, { ...p.sessionBody, ...body }, p.tablet.token)
      expect(r.statusCode, url).toBe(403)
    }
    expect(technicalUsers(t)).toHaveLength(1)
  })
})

describe('retire a screen', () => {
  it('archives its user, closes its session and rejects its new events', async () => {
    const t = setupPrinting()
    const admin = t.device('admin', 'register')
    const p = await screen(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [
      { name: 'Tagliata', station: t.kitchen },
      { name: 'Risotto', station: t.kitchen },
    ])
    t.send(ana, order, items)
    expect(p.submit(order, 'ItemReady', { item_ids: [items[0]?.id] }).status).toBe('confirmed')

    t.advance(60_000)
    const r = await t.post(
      `/api/devices/${p.tablet.connection.deviceId}/revoke`,
      admin.sessionBody,
      admin.token,
    )
    expect(r.statusCode).toBe(200)
    expect(t.db.prepare('SELECT active FROM users WHERE id = ?').get(p.userId)).toEqual({
      active: 0,
    })
    expect(
      t.db
        .prepare('SELECT count(*) AS n FROM sessions WHERE device_id = ? AND closed_at IS NULL')
        .get(p.tablet.connection.deviceId),
    ).toEqual({ n: 0 })
    // The technical user is not deleted: it stays archived with its history.
    expect(t.db.prepare('SELECT count(*) AS n FROM users WHERE id = ?').get(p.userId)).toEqual({
      n: 1,
    })

    t.advance(60_000)
    const after = p.submit(order, 'ItemReady', { item_ids: [items[1]?.id] })
    expect(after.status).toBe('rejected')
    expect(t.hub.order(order)?.items[items[1]?.id as string]?.status).toBe('sent')
    // Its routes stop working too.
    const cfg = await t.post('/api/kitchen/config', p.sessionBody, p.tablet.token)
    expect(cfg.statusCode).toBe(401)
  })

  it('the archived user no longer has permissions even if someone reopens the session', async () => {
    const t = setupPrinting()
    const admin = t.device('admin', 'register')
    const p = await screen(t)
    await t.post(
      `/api/devices/${p.tablet.connection.deviceId}/revoke`,
      admin.sessionBody,
      admin.token,
    )
    expect(t.access.permissionsOf(p.userId)).toEqual([])
  })

  it('the retired screen leaves the menu and the config; the others remain', async () => {
    const t = setupPrinting()
    const admin = t.device('admin', 'register')
    const a = await screen(t, [t.kitchen], 'Cocina')
    await screen(t, [t.bar], 'Barra')
    await t.post(
      `/api/devices/${a.tablet.connection.deviceId}/revoke`,
      admin.sessionBody,
      admin.token,
    )
    const catalog = readCatalog(t.db, t.restaurantId)
    expect(catalog.screens?.map((x) => x.name)).toEqual(['Barra'])
    expect(catalog.stations.find((e) => e.id === t.kitchen)).toMatchObject({ screen: false })
    expect(catalog.stations.find((e) => e.id === t.bar)).toMatchObject({ screen: true })
  })

  it('retiring a regular device does not archive any person', async () => {
    const t = setupPrinting()
    const admin = t.device('admin', 'register')
    const ana = t.device('waiter')
    await t.post(`/api/devices/${ana.connection.deviceId}/revoke`, admin.sessionBody, admin.token)
    expect(t.db.prepare("SELECT active FROM users WHERE name = 'Ana'").get()).toEqual({
      active: 1,
    })
  })

  it('retiring the tablet when the last to sign in was an admin does not archive the admin', async () => {
    const t = setupPrinting()
    const admin = t.device('admin', 'register')
    const p = await screen(t)
    // The admin signs in on that same tablet to change something, and then it is retired.
    t.signIn(p.tablet.connection, 'admin')
    await t.post(
      `/api/devices/${p.tablet.connection.deviceId}/revoke`,
      admin.sessionBody,
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
