import 'fake-indexeddb/auto'
import { type NewEvent, newId, signEvent, validateNewEvent } from '@pos/core'
import {
  type AccessControl,
  type Catalog,
  type Channel,
  type DeviceMessage,
  FloorSync,
  type Handlers,
  HubSync,
  MemoryStore,
} from '@pos/sync'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import { type Equipo, Sala, type Sesion } from './motor'
import { pedidosAbiertos } from './proyeccion'
import { catalogoDePrueba } from './pruebas'

// Fallas de la sala (docs/SYNC.md): el hub se cae a mitad de un lote, el token deja de valer, la
// sesión vence por inactividad, toques rápidos y reloj desfasado. Todo con relojes simulados
// (nada de esperas reales) y un hub en memoria que exige la firma y el dispositivo del evento.

const T0 = new Date('2026-10-24T15:00:00.000Z')
const MIN = 60_000

const secretoDe = (sesionId: string) => `secreto-${sesionId}`

const accesoConFirma: AccessControl = {
  verify: (_c, event) =>
    event.session_id && event.signature === signEvent(event, secretoDe(event.session_id))
      ? { ok: true, authorizedById: null, authorizationId: null }
      : { ok: false, reason: 'invalid_signature' },
  recordUse: () => {},
}

// ── Tiempo: los temporizadores y Date son falsos; IndexedDB sigue en tiempo real ─────────────

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    now: T0,
  })
  // `salir` avisa al hub por HTTP; aquí solo se anota.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  )
})

/** Deja correr las operaciones de IndexedDB (que usan `setImmediate`, no falseado). */
async function asentar(vueltas = 4) {
  for (let i = 0; i < vueltas; i++) await new Promise((r) => setImmediate(r))
}

/** Avanza el reloj simulado en pasos, dejando correr IndexedDB entre paso y paso. */
async function advance(ms: number) {
  for (let t = 0; t < ms; t += 100) {
    await vi.advanceTimersByTimeAsync(Math.min(100, ms - t))
    await asentar(3)
  }
}

/** Avanza hasta que se cumpla la condición; falla si no pasa en `maxMs` de reloj simulado. */
async function until(condicion: () => Promise<boolean> | boolean, maxMs = 20_000) {
  for (let t = 0; t <= maxMs; t += 100) {
    if (await condicion()) return
    await advance(100)
  }
  throw new Error('No se cumplió en el tiempo simulado')
}

// ── Hub en memoria con fallas ────────────────────────────────────────────────────────────────

interface EquipoHub extends Equipo {
  revokedAt: string | null
}

function montarHub(options: { desfaseHubMs?: number } = {}) {
  const tokens = new Map<string, EquipoHub>()
  const store = new MemoryStore()
  const hub = new HubSync(store, {
    restaurantId: newId(),
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    instance: 'hub-test',
    clock: () => new Date(Date.now() + (options.desfaseHubMs ?? 0)).toISOString(),
    access: accesoConFirma,
  })
  const salaHub = new FloorSync(hub, (token) => {
    const e = tokens.get(token)
    return e ? { deviceId: e.deviceId, type: e.type, revokedAt: e.revokedAt } : null
  })

  const channels = new Set<{ cut: () => void }>()
  const h = {
    hub,
    tokens,
    salaHub,
    /** Mientras sea verdad, ningún intento de abrir llega al hub. */
    down: false,
    aperturas: 0,
    /** Mensajes del dispositivo que llegaron al hub, en orden. */
    received: [] as DeviceMessage[],
    /** Si devuelve true para un mensaje que ya llegó al hub, el canal se corta justo después. */
    cortarTras: null as ((m: DeviceMessage) => boolean) | null,
    cortarTodo() {
      for (const c of [...channels]) c.cut()
    },
    open(m: Handlers): Channel {
      h.aperturas += 1
      let link: ReturnType<FloorSync['connect']> | null = null
      let closed = false
      const channel = {
        cut: () => {
          if (closed) return
          closed = true
          channels.delete(channel)
          link?.close()
          link = null
          m.onClose()
        },
      }
      channels.add(channel)
      setTimeout(() => {
        if (closed) return
        if (h.down) {
          channel.cut()
          return
        }
        link = salaHub.connect((msg) => {
          const copy = JSON.parse(JSON.stringify(msg))
          setTimeout(() => {
            if (!closed) m.onMessage(copy)
          })
        })
        m.onOpen()
      })
      return {
        send: (msg) => {
          if (!link || closed) return
          const copy = JSON.parse(JSON.stringify(msg)) as DeviceMessage
          h.received.push(copy)
          link.receive(copy)
          if (h.cortarTras?.(copy)) channel.cut()
        },
        close: () => {
          closed = true
          channels.delete(channel)
          link?.close()
          link = null
        },
      }
    },
  }
  return h
}
type Hub = ReturnType<typeof montarHub>

const salas: Sala[] = []
const bases: BaseDispositivo[] = []
afterEach(async () => {
  for (const s of salas.splice(0)) s.simularSinConexion(true)
  await asentar(10)
  vi.useRealTimers()
  await asentar(10)
  for (const b of bases.splice(0)) await b.delete()
  vi.unstubAllGlobals()
})

interface OpcionesEquipo {
  /** Hace `ultimoUso` más viejo o más nuevo que ahora (ms). */
  haceMs?: number
  catalog?: Catalog | null
  /** El token no está en el hub (equipo retirado o hub reinstalado). */
  sinToken?: boolean
  /** Secreto distinto al que conoce el hub. */
  secret?: string
  /** Empezar sin conexión (el usuario apagó la conexión antes de arrancar). */
  sinConexion?: boolean
  db?: BaseDispositivo
}

async function device(h: Hub, name: string, o: OpcionesEquipo = {}) {
  const db = o.db ?? new BaseDispositivo(`resiliencia-${newId()}`)
  if (!o.db) bases.push(db)
  const e: EquipoHub = {
    deviceId: newId(),
    token: newId(),
    name,
    type: 'waiter',
    revokedAt: null,
  }
  if (!o.sinToken) h.tokens.set(e.token, e)
  const sesionId = newId()
  const session: Sesion = {
    sesionId,
    secret: o.secret ?? secretoDe(sesionId),
    user: { id: newId(), name, role: 'Mesero' },
    permissions: ['take_order'],
    ultimoUso: Date.now() - (o.haceMs ?? 0),
  }
  await db.saveSetting('device', {
    deviceId: e.deviceId,
    token: e.token,
    name: e.name,
    type: e.type,
  } satisfies Equipo)
  await db.saveSetting('session', session)
  if (o.catalog !== null) await db.saveSetting('catalog', o.catalog ?? catalogoDePrueba())
  const floor = new Sala({ db, open: (m) => h.open(m) })
  salas.push(floor)
  if (o.sinConexion) floor.simularSinConexion(true)
  await floor.load()
  return { floor, db, e, session }
}

const item = (price = 1_000) => ({
  item_id: newId(),
  product_id: newId(),
  variant_id: null,
  name: 'Limonada',
  unit_price: price,
  tax_type: 'inc' as const,
  rate: 800,
  quantity: 1,
  guest: null,
  course: null,
  modifiers: [],
  notes: null,
  catalog_version: 4,
  price_channel_id: null,
})

const openOrder = (s: Sala, id = newId()) =>
  s.record('OrderOpened', id, { channel: 'dine_in', table_id: null, guests: 1 }).then(() => id)

const conectada = (s: Sala) => s.instantanea().connection === 'connected'
const sinPendientes = (s: Sala) => s.instantanea().pendingList === 0
const locals = async (s: Sala) => (await s.sync?.locals()) ?? []

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('registrar firma el evento', () => {
  it('lleva la firma de la sesión y el hub la acepta', async () => {
    const h = montarHub()
    const { floor, session, e } = await device(h, 'Ana')
    await until(() => conectada(floor))
    const p = newId()
    const event = await floor.record('OrderOpened', p, {
      channel: 'dine_in',
      table_id: null,
      guests: 2,
    })

    const { signature, ...sinFirma } = event
    expect(signature).toBe(signEvent(sinFirma as NewEvent, session.secret))
    expect(event).toMatchObject({
      session_id: session.sesionId,
      user_id: session.user.id,
      device_id: e.deviceId,
      aggregate_type: 'order',
      aggregate_id: p,
      schema_version: 1,
    })
    expect(validateNewEvent(event).ok).toBe(true)
    // El sobre trae la hora del dispositivo y la estimada del hub.
    expect(event.device_time).toBe(new Date(Date.now()).toISOString())

    await until(() => sinPendientes(floor))
    expect(h.hub.order(p)).not.toBeNull()
  })

  it('con un secreto que el hub no reconoce el evento se rechaza y no se muestra', async () => {
    const h = montarHub()
    const { floor } = await device(h, 'Ana', { secret: 'secreto-equivocado' })
    await until(() => conectada(floor))
    const p = await openOrder(floor)
    // Persistir antes de mostrar: mientras el hub no responde, ya se ve.
    expect(pedidosAbiertos(await locals(floor)).map((v) => v.status.id)).toEqual([p])

    await until(() => sinPendientes(floor))
    const [l] = await locals(floor)
    expect(l?.status).toBe('rejected')
    expect(l?.reason).toBe('invalid_signature')
    expect(pedidosAbiertos(await locals(floor))).toEqual([])
    expect(h.hub.order(p)).toBeNull()
  })

  it('cada evento firmado cubre sus propios datos: la firma cambia con los datos', async () => {
    const h = montarHub()
    const { floor } = await device(h, 'Ana', { sinConexion: true })
    const p = newId()
    const a = await floor.record('OrderOpened', p, {
      channel: 'dine_in',
      table_id: null,
      guests: 1,
    })
    const b = await floor.record('OrderOpened', newId(), {
      channel: 'dine_in',
      table_id: null,
      guests: 1,
    })
    expect(a.signature).not.toBe(b.signature)
    expect(a.id).not.toBe(b.id)
  })
})

describe('el hub se cae a mitad de una operación', () => {
  it('cae justo después de aceptar un lote, sin que llegue la respuesta: al volver no se duplica nada', async () => {
    const h = montarHub()
    const { floor } = await device(h, 'Ana', { sinConexion: true })
    const p = await openOrder(floor)
    const ids = []
    for (let i = 0; i < 5; i++) {
      const it = item(2_000)
      await floor.record('ItemAdded', p, it)
      ids.push(it.item_id)
    }
    expect(floor.instantanea().pendingList).toBe(6)

    // El hub procesa el lote y se corta antes de que la respuesta llegue; sigue caído un rato.
    h.cortarTras = (m) => {
      if (m.type !== 'push') return false
      h.down = true
      return true
    }
    floor.simularSinConexion(false)
    await until(() => h.received.some((m) => m.type === 'push'))
    await asentar(10)
    expect(h.hub.order(p)?.items).toBeDefined()
    expect(Object.keys(h.hub.order(p)?.items ?? {})).toHaveLength(5)
    // El dispositivo no vio la respuesta: sigue creyendo que están pendientes.
    expect(floor.instantanea().pendingList).toBe(6)
    expect(floor.instantanea().connection).not.toBe('connected')

    // Mientras sigue caído hay reintentos, pero espaciados (no un ciclo apretado).
    const attempts = h.aperturas
    await advance(10_000)
    expect(h.aperturas - attempts).toBeLessThanOrEqual(6)
    expect(floor.instantanea().pendingList).toBe(6)

    h.down = false
    h.cortarTras = null
    await until(() => sinPendientes(floor))

    const allConfirmed = (await locals(floor)).filter((l) => l.status === 'confirmed')
    expect(allConfirmed.map((l) => l.event.sequence)).toEqual([1, 2, 3, 4, 5, 6])
    expect(Object.keys(h.hub.order(p)?.items ?? {}).sort()).toEqual([...ids].sort())
    expect(pedidosAbiertos(await locals(floor))[0]?.total).toBe(10_000)
  })

  it('cae entre dos lotes de 100: los 150 eventos quedan una sola vez y en orden', async () => {
    const h = montarHub()
    const { floor } = await device(h, 'Ana', { sinConexion: true })
    const p = await openOrder(floor)
    for (let i = 0; i < 149; i++) await floor.record('ItemAdded', p, item(1_000))
    expect(floor.instantanea().pendingList).toBe(150)

    let lotes = 0
    h.cortarTras = (m) => {
      if (m.type === 'push') lotes += 1
      // El primer lote llega completo y la conexión se corta antes de la respuesta.
      return m.type === 'push' && lotes === 1
    }
    floor.simularSinConexion(false)
    await until(() => sinPendientes(floor), 30_000)

    const hubEventos = h.hub.order(p)
    expect(Object.keys(hubEventos?.items ?? {})).toHaveLength(149)
    const allConfirmed = (await locals(floor)).filter((l) => l.status === 'confirmed')
    expect(allConfirmed).toHaveLength(150)
    expect(allConfirmed.map((l) => l.event.sequence)).toEqual(
      Array.from({ length: 150 }, (_, i) => i + 1),
    )
    expect(new Set(allConfirmed.map((l) => l.event.id)).size).toBe(150)
  })

  it('el hub está apagado al arrancar: lo registrado se conserva y sube cuando vuelve', async () => {
    const h = montarHub()
    h.down = true
    const { floor } = await device(h, 'Ana')
    await advance(3_000)
    expect(floor.instantanea().connection).not.toBe('connected')

    const p = await openOrder(floor)
    await floor.record('ItemAdded', p, item(5_000))
    expect(floor.instantanea().pendingList).toBe(2)
    expect(pedidosAbiertos(await locals(floor))[0]?.total).toBe(5_000)

    h.down = false
    // La espera máxima entre reintentos es de 5 s (docs/SYNC.md).
    await until(() => conectada(floor) && sinPendientes(floor), 8_000)
    expect(h.hub.order(p)).not.toBeNull()
  })

  it('el proceso del hub se reinicia (nueva sala, misma base): el dispositivo reconecta solo', async () => {
    const h = montarHub()
    const { floor } = await device(h, 'Ana')
    await until(() => conectada(floor))
    const p = await openOrder(floor)
    await until(() => sinPendientes(floor))

    h.down = true
    h.cortarTodo()
    expect(floor.instantanea().connection).not.toBe('connected')
    // Sin conexión se sigue tomando el pedido.
    await floor.record('ItemAdded', p, item(3_000))
    expect(floor.instantanea().pendingList).toBe(1)

    h.down = false
    await until(() => conectada(floor) && sinPendientes(floor), 8_000)
    expect(Object.keys(h.hub.order(p)?.items ?? {})).toHaveLength(1)
  })
})

describe('token inválido o revocado', () => {
  it('el hub no reconoce el token: queda errorHub, se detiene la conexión y no reintenta', async () => {
    const h = montarHub()
    const { floor } = await device(h, 'Ana', { sinToken: true })
    await until(() => floor.instantanea().errorHub !== null)

    expect(floor.instantanea().errorHub).toMatchObject({ code: 'invalid_token' })
    expect(floor.instantanea().connection).toBe('disconnected')

    // Pasa un buen rato y no vuelve a intentarlo (cada intento solo gastaría batería y red).
    const attempts = h.aperturas
    await advance(60_000)
    expect(h.aperturas).toBe(attempts)
    expect(floor.instantanea().connection).toBe('disconnected')
  })

  it('con el token inválido se puede seguir registrando: queda guardado como pendiente', async () => {
    const h = montarHub()
    const { floor } = await device(h, 'Ana', { sinToken: true })
    await until(() => floor.instantanea().errorHub !== null)
    await openOrder(floor)
    expect(floor.instantanea().pendingList).toBe(1)
    await advance(10_000)
    expect(floor.instantanea().pendingList).toBe(1)
  })

  it('app_vieja también detiene la conexión', async () => {
    const h = montarHub()
    const oldOne = new Sala({
      db: (() => {
        const db = new BaseDispositivo(`resiliencia-${newId()}`)
        bases.push(db)
        return db
      })(),
      open: (m) => {
        h.aperturas += 1
        setTimeout(() => m.onOpen())
        return {
          send: (msg) => {
            if (msg.type === 'hello')
              setTimeout(() =>
                m.onMessage({ type: 'error', code: 'outdated_app', message: 'Actualiza la app' }),
              )
          },
          close: () => {},
        }
      },
    })
    salas.push(oldOne)
    await oldOne.sync // sin equipo todavía
    const db = (oldOne as unknown as { db: BaseDispositivo }).db
    await db.saveSetting('device', {
      deviceId: newId(),
      token: 't',
      name: 'Viejo',
      type: 'waiter',
    })
    await oldOne.load()
    await until(() => oldOne.instantanea().errorHub !== null)
    expect(oldOne.instantanea().errorHub).toMatchObject({ code: 'outdated_app' })
    const attempts = h.aperturas
    await advance(30_000)
    expect(h.aperturas).toBe(attempts)
  })

  it('token revocado con el equipo conectado: avisa, sigue conectado y deja de recibir el salón', async () => {
    const h = montarHub()
    const ana = await device(h, 'Ana')
    const beto = await device(h, 'Beto')
    await until(() => conectada(ana.floor) && conectada(beto.floor))

    // El gerente retira el equipo de Ana.
    const now = new Date().toISOString()
    const row = h.tokens.get(ana.e.token) as EquipoHub
    row.revokedAt = now
    h.salaHub.revoke(ana.e.deviceId, now)
    await until(() => ana.floor.instantanea().errorHub !== null)
    expect(ana.floor.instantanea().errorHub?.code).toBe('revoked_token')
    expect(conectada(ana.floor)).toBe(true)

    // Lo que Beto hace después ya no le llega a Ana, pero a Beto sí le funciona.
    const p = await openOrder(beto.floor)
    await until(() => sinPendientes(beto.floor))
    await advance(2_000)
    expect(pedidosAbiertos(await locals(ana.floor))).toEqual([])
    expect(pedidosAbiertos(await locals(beto.floor)).map((v) => v.status.id)).toEqual([p])
  })

  it('lo que el equipo retirado hace después de la revocación no entra al salón', async () => {
    const h = montarHub()
    const ana = await device(h, 'Ana')
    await until(() => conectada(ana.floor))
    const now = new Date().toISOString()
    ;(h.tokens.get(ana.e.token) as EquipoHub).revokedAt = now
    h.salaHub.revoke(ana.e.deviceId, now)
    await until(() => ana.floor.instantanea().errorHub !== null)

    vi.setSystemTime(Date.now() + 5_000)
    const p = await openOrder(ana.floor)
    await until(() => sinPendientes(ana.floor))
    expect(h.hub.order(p)).toBeNull()
    const [l] = await locals(ana.floor)
    expect(l?.status).toBe('rejected')
    expect(pedidosAbiertos(await locals(ana.floor))).toEqual([])
  })
})

describe('olvidarEquipo', () => {
  it('borra credenciales y sesión, detiene la conexión y conserva los eventos guardados', async () => {
    const h = montarHub()
    const { floor, db } = await device(h, 'Ana', { sinToken: true })
    await until(() => floor.instantanea().errorHub !== null)
    await openOrder(floor)

    await floor.olvidarEquipo()
    const i = floor.instantanea()
    expect(i).toMatchObject({
      device: null,
      session: null,
      errorHub: null,
      connection: 'disconnected',
    })
    expect(await db.leerAjuste('device')).toBeUndefined()
    expect(await db.leerAjuste('session')).toBeUndefined()
    // El catálogo y los eventos se quedan.
    expect(await db.leerAjuste('catalog')).toBeDefined()
    expect(await db.events.count()).toBe(1)
    expect(floor.sync).toBeNull()

    const attempts = h.aperturas
    await advance(30_000)
    expect(h.aperturas).toBe(attempts)

    // Sin equipo no se puede crear nada ni llamar al hub.
    await expect(openOrder(floor)).rejects.toThrow('Sin sesión')
    await expect(floor.actualizarCatalogo()).rejects.toThrow('todavía no ha entrado')
  })

  it('al volver a abrir la app queda sin equipo (pide emparejar)', async () => {
    const h = montarHub()
    const { floor, db } = await device(h, 'Ana', { sinToken: true })
    await until(() => floor.instantanea().errorHub !== null)
    await floor.olvidarEquipo()
    const another = new Sala({ db, open: (m) => h.open(m) })
    salas.push(another)
    await another.load()
    expect(another.instantanea()).toMatchObject({ cargado: true, device: null, session: null })
    expect(another.instantanea().catalog).not.toBeNull()
  })

  it('emparejar de nuevo conecta con el token nuevo', async () => {
    const h = montarHub()
    const { floor, db } = await device(h, 'Ana', { sinToken: true })
    await until(() => floor.instantanea().errorHub !== null)
    await floor.olvidarEquipo()

    const fresh: EquipoHub = {
      deviceId: newId(),
      token: newId(),
      name: 'Ana',
      type: 'waiter',
      revokedAt: null,
    }
    h.tokens.set(fresh.token, fresh)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe('/api/pair')
        // El código se normaliza: sin espacios y en mayúsculas.
        expect(JSON.parse(String(init?.body))).toEqual({ code: 'ABC123' })
        return new Response(
          JSON.stringify({
            device_id: fresh.deviceId,
            token: fresh.token,
            name: fresh.name,
            type: fresh.type,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }),
    )
    await floor.emparejar('  abc123 ')
    await until(() => conectada(floor))
    expect(floor.instantanea().device?.token).toBe(fresh.token)
    expect(floor.instantanea().errorHub).toBeNull()
    expect(await db.leerAjuste<Equipo>('device')).toMatchObject({ token: fresh.token })
  })

  // Los eventos guardados llevan el device_id del emparejamiento anterior, y el hub rechaza
  // todo evento cuyo dispositivo no sea el de la conexión. Está documentado en `olvidarEquipo`
  // (la pantalla lo advierte antes): esta prueba fija que no se pierde en silencio, queda
  // rechazado con su motivo.
  it('lo pendiente de antes de olvidar el equipo no entra con el token nuevo: queda rechazado con motivo', async () => {
    const h = montarHub()
    const { floor } = await device(h, 'Ana', { sinToken: true })
    await until(() => floor.instantanea().errorHub !== null)
    const p = await openOrder(floor)
    await floor.olvidarEquipo()

    const fresh: EquipoHub = {
      deviceId: newId(),
      token: newId(),
      name: 'Ana',
      type: 'waiter',
      revokedAt: null,
    }
    h.tokens.set(fresh.token, fresh)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              device_id: fresh.deviceId,
              token: fresh.token,
              name: 'Ana',
              type: 'waiter',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    )
    await floor.emparejar('ABC123')
    await until(() => sinPendientes(floor))
    expect(h.hub.order(p)).toBeNull()
    const [l] = await locals(floor)
    expect(l).toMatchObject({ status: 'rejected', reason: 'device_mismatch' })
  })
})

describe('sesión que vence por inactividad', () => {
  it('se cierra exactamente a los minutos configurados y avisa al hub', async () => {
    const h = montarHub()
    const { floor, session, db } = await device(h, 'Ana', {
      catalog: catalogoDePrueba({ restaurant: { name: 'P', sessionIdleMin: 10 } }),
    })
    floor.vencerSesionSiToca(session.ultimoUso + 10 * MIN - 1)
    expect(floor.instantanea().session).not.toBeNull()
    floor.vencerSesionSiToca(session.ultimoUso + 10 * MIN)
    expect(floor.instantanea().session).toBeNull()
    expect(floor.instantanea().sessionClosedBy).toBe('inactivity')

    await asentar(10)
    expect(await db.leerAjuste('session')).toBeUndefined()
    const closeout = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url) === '/api/sessions/close')
    expect(closeout).toBeDefined()
    expect(JSON.parse(String(closeout?.[1]?.body))).toEqual({
      session_id: session.sesionId,
      secret: session.secret,
    })
  })

  it('sin catálogo guardado usa 30 minutos', async () => {
    const h = montarHub()
    const { floor, session } = await device(h, 'Ana', { catalog: null })
    floor.vencerSesionSiToca(session.ultimoUso + 29 * MIN)
    expect(floor.instantanea().session).not.toBeNull()
    floor.vencerSesionSiToca(session.ultimoUso + 30 * MIN)
    expect(floor.instantanea().session).toBeNull()
  })

  it('al abrir la app con una sesión ya vencida pide el PIN de nuevo', async () => {
    const h = montarHub()
    const { floor, db } = await device(h, 'Ana', { haceMs: 31 * MIN })
    expect(floor.instantanea().session).toBeNull()
    await asentar(10)
    expect(await db.leerAjuste('session')).toBeUndefined()
    await expect(openOrder(floor)).rejects.toThrow('Sin sesión')
  })

  it('al volver a la pantalla (desbloquear el celular) revisa el vencimiento', async () => {
    const h = montarHub()
    const { floor } = await device(h, 'Ana')
    vi.setSystemTime(Date.now() + 45 * MIN)
    expect(floor.instantanea().session).not.toBeNull()
    floor.changeVisibility(false)
    expect(floor.instantanea().session).not.toBeNull()
    floor.changeVisibility(true)
    expect(floor.instantanea().session).toBeNull()
  })

  it('cada toque aplaza el cierre: con toques cada 10 minutos nunca vence', async () => {
    const h = montarHub()
    const { floor, session } = await device(h, 'Ana')
    for (let i = 1; i <= 12; i++) floor.usar(session.ultimoUso + i * 10 * MIN)
    expect(floor.instantanea().session).not.toBeNull()
    expect(floor.instantanea().session?.ultimoUso).toBe(session.ultimoUso + 120 * MIN)
    // Y pasados 30 minutos sin toques, sí.
    floor.vencerSesionSiToca(session.ultimoUso + 150 * MIN)
    expect(floor.instantanea().session).toBeNull()
  })

  it('un toque ya vencido no revive la sesión', async () => {
    const h = montarHub()
    const { floor, session } = await device(h, 'Ana')
    floor.usar(session.ultimoUso + 40 * MIN)
    expect(floor.instantanea().session).toBeNull()
    floor.usar(session.ultimoUso + 40 * MIN + 1)
    floor.usar(session.ultimoUso + 41 * MIN)
    expect(floor.instantanea().session).toBeNull()
    await asentar(10)
    expect(await bases[0]?.leerAjuste('session')).toBeUndefined()
  })

  it('salir sin conexión con el hub igual cierra la sesión aquí', async () => {
    const h = montarHub()
    const { floor, db } = await device(h, 'Ana')
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'))
    await floor.exit()
    expect(floor.instantanea().session).toBeNull()
    expect(await db.leerAjuste('session')).toBeUndefined()
  })

  it('registrar con la sesión ya vencida por inactividad no crea el evento', async () => {
    const h = montarHub()
    const { floor } = await device(h, 'Ana', { sinConexion: true })
    // La sesión sigue "abierta" en pantalla (nadie tocó nada), pero pasó más de la inactividad.
    vi.setSystemTime(Date.now() + 31 * MIN)
    expect(floor.instantanea().session).not.toBeNull()
    await expect(openOrder(floor)).rejects.toThrow('Sin sesión')
    expect(floor.instantanea().pendingList).toBe(0)
  })
})

describe('toques rápidos', () => {
  it('cientos de toques en un segundo no escriben en IndexedDB', async () => {
    const h = montarHub()
    const { floor, session, db } = await device(h, 'Ana')
    const escribir = vi.spyOn(db, 'saveSetting')
    for (let i = 0; i < 300; i++) floor.usar(session.ultimoUso + i * 3)
    expect(escribir).not.toHaveBeenCalled()
    expect(floor.instantanea().session?.ultimoUso).toBe(session.ultimoUso)
  })

  it('pasados 15 s se escribe una vez, y los toques del mismo instante no repiten la escritura', async () => {
    const h = montarHub()
    const { floor, session, db } = await device(h, 'Ana')
    const escribir = vi.spyOn(db, 'saveSetting')
    const t = session.ultimoUso + 15_000
    for (let i = 0; i < 50; i++) floor.usar(t)
    expect(escribir).toHaveBeenCalledTimes(1)
    expect(escribir).toHaveBeenCalledWith('session', expect.objectContaining({ ultimoUso: t }))
    await asentar(5)
    expect(await db.leerAjuste<Sesion>('session')).toMatchObject({ ultimoUso: t })
  })

  it('14,9 s no escribe; toques cada 10 s por dos horas mantienen viva la sesión sin escribir en cada uno', async () => {
    const h = montarHub()
    const { floor, session, db } = await device(h, 'Ana')
    floor.usar(session.ultimoUso + 14_999)
    const escribir = vi.spyOn(db, 'saveSetting')
    expect(escribir).not.toHaveBeenCalled()

    let taps = 0
    for (let t = 10_000; t <= 120 * MIN; t += 10_000) {
      floor.usar(session.ultimoUso + t)
      taps += 1
    }
    expect(floor.instantanea().session).not.toBeNull()
    expect(escribir.mock.calls.length).toBeLessThan(taps / 1.5)
    expect(escribir.mock.calls.length).toBeGreaterThan(0)
  })

  it('varios registrar a la vez guardan todo, cada evento una vez, y el hub los confirma', async () => {
    const h = montarHub()
    const { floor } = await device(h, 'Ana')
    await until(() => conectada(floor))
    const p = await openOrder(floor)
    const its = Array.from({ length: 12 }, () => item(1_500))
    await Promise.all(its.map((it) => floor.record('ItemAdded', p, it)))

    const all = await locals(floor)
    expect(all).toHaveLength(13)
    expect(new Set(all.map((l) => l.position)).size).toBe(13)
    expect(new Set(all.map((l) => l.event.id)).size).toBe(13)

    await until(() => sinPendientes(floor))
    const hub = h.hub.order(p)
    expect(Object.keys(hub?.items ?? {}).sort()).toEqual(its.map((i) => i.item_id).sort())
    expect(pedidosAbiertos(await locals(floor))[0]?.total).toBe(18_000)
  })

  it('doble toque en "enviar a cocina": una sola comanda vale y los dos equipos ven lo mismo', async () => {
    const h = montarHub()
    const { floor } = await device(h, 'Ana')
    await until(() => conectada(floor))
    const p = await openOrder(floor)
    const it = item(8_000)
    await floor.record('ItemAdded', p, it)
    await until(() => sinPendientes(floor))

    const envio = () => ({
      tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [it.item_id] }],
    })
    await Promise.all([
      floor.record('ItemsSent', p, envio()),
      floor.record('ItemsSent', p, envio()),
    ])
    await until(() => sinPendientes(floor))

    const enHub = h.hub.order(p)
    expect(enHub?.items[it.item_id]?.status).toBe('sent')
    const [vista] = pedidosAbiertos(await locals(floor))
    expect(vista?.status.items[it.item_id]?.status).toBe('sent')
    expect(vista?.total).toBe(8_000)
    // El segundo envío no se pierde en silencio: o se rechazó o se aceptó como conflicto.
    const envios = (await locals(floor)).filter((l) => l.event.type === 'ItemsSent')
    expect(envios).toHaveLength(2)
    expect(envios.every((l) => l.status !== 'pending')).toBe(true)
  })
})

describe('reloj del dispositivo desfasado', () => {
  it.each([
    ['atrasado', 2 * 60 * MIN],
    ['adelantado', -2 * 60 * MIN],
  ])(
    'con el hub %s 2 h respecto al dispositivo, la hora estimada sigue la del hub',
    async (_n, offset) => {
      const h = montarHub({ desfaseHubMs: offset })
      const { floor } = await device(h, 'Ana')
      await until(() => conectada(floor))
      await advance(500)

      const event = await floor.record('OrderOpened', newId(), {
        channel: 'dine_in',
        table_id: null,
        guests: 1,
      })
      expect(event.device_time).toBe(new Date(Date.now()).toISOString())
      const variance = Date.parse(event.hub_estimated_time) - Date.now()
      expect(Math.abs(variance - offset)).toBeLessThan(1_000)

      await until(() => sinPendientes(floor))
      const [l] = await locals(floor)
      expect(l?.status).toBe('confirmed')
    },
  )

  it('tras reabrir la app sin conexión se acuerda del desfase aprendido', async () => {
    const h = montarHub({ desfaseHubMs: 2 * 60 * MIN })
    const { floor, db } = await device(h, 'Ana')
    await until(() => conectada(floor))
    await asentar(10)
    floor.simularSinConexion(true)

    const another = new Sala({ db, open: (m) => h.open(m) })
    salas.push(another)
    another.simularSinConexion(true)
    await another.load()
    const event = await another.record('OrderOpened', newId(), {
      channel: 'dine_in',
      table_id: null,
      guests: 1,
    })
    const variance = Date.parse(event.hub_estimated_time) - Date.now()
    expect(Math.abs(variance - 2 * 60 * MIN)).toBeLessThan(1_000)
  })

  it('sin haber hablado nunca con el hub, la hora estimada es la del dispositivo', async () => {
    const h = montarHub({ desfaseHubMs: 2 * 60 * MIN })
    const { floor } = await device(h, 'Ana', { sinConexion: true })
    const event = await floor.record('OrderOpened', newId(), {
      channel: 'dine_in',
      table_id: null,
      guests: 1,
    })
    expect(event.hub_estimated_time).toBe(event.device_time)
  })
})

describe('arranque y corte simulado', () => {
  it('cargar dos veces a la vez conecta una sola vez', async () => {
    const h = montarHub()
    const { db } = await device(h, 'Ana', { sinConexion: true })
    const another = new Sala({ db, open: (m) => h.open(m) })
    salas.push(another)
    const [a, b] = [another.load(), another.load()]
    expect(a).toBe(b)
    await Promise.all([a, b])
    await until(() => conectada(another))
    await advance(2_000)
    expect(h.aperturas).toBe(1)
  })

  it('con el corte simulado las llamadas HTTP fallan como sin conexión, sin tocar la red', async () => {
    const h = montarHub()
    const { floor } = await device(h, 'Ana')
    await until(() => conectada(floor))
    floor.simularSinConexion(true)
    vi.mocked(fetch).mockClear()
    await expect(floor.actualizarCatalogo()).rejects.toMatchObject({ code: 'offline' })
    await expect(floor.entrar('1234')).rejects.toMatchObject({ code: 'offline' })
    expect(fetch).not.toHaveBeenCalled()
    expect(floor.instantanea().connection).toBe('disconnected')
  })

  it('el latido y el pong no hacen releer la pantalla', async () => {
    const h = montarHub()
    const { floor } = await device(h, 'Ana')
    await until(() => conectada(floor))
    await advance(500)
    const before = floor.instantanea().changes
    h.salaHub.beat()
    await advance(500)
    expect(floor.instantanea().changes).toBe(before)
  })

  it('apagar y devolver la conexión varias veces seguidas deja una sola conexión viva', async () => {
    const h = montarHub()
    const { floor } = await device(h, 'Ana')
    await until(() => conectada(floor))
    for (let i = 0; i < 10; i++) {
      floor.simularSinConexion(true)
      floor.simularSinConexion(false)
    }
    await until(() => conectada(floor))
    const p = await openOrder(floor)
    await until(() => sinPendientes(floor))
    expect(Object.keys(h.hub.order(p) ?? {})).not.toHaveLength(0)
    expect((await locals(floor)).filter((l) => l.status === 'confirmed')).toHaveLength(1)
  })
})
