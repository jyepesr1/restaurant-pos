import 'fake-indexeddb/auto'
import { authorizableFingerprint, newId, signEvent } from '@pos/core'
import type { Channel } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import { ErrorApi } from './api'
import { type Equipo, Sala, type Sesion } from './motor'
import { catalogoDePrueba } from './pruebas'

// El motor con el PIN de un supervisor (tarea 1.5, ADR-008): `registrar(..., { motivo, autoriza })`
// pide `/api/autorizaciones` con la huella del evento, y el evento sale con el comprobante y su
// firma. Sin conexión, o con un PIN que el hub no acepta, no se guarda nada.

const salas: Sala[] = []
const bases: BaseDispositivo[] = []
afterEach(async () => {
  for (const s of salas.splice(0)) s.simularSinConexion(true)
  vi.unstubAllGlobals()
  await new Promise((r) => setTimeout(r, 20))
  for (const b of bases.splice(0)) await b.delete()
})

const sinRed = (): Channel => ({ send: () => {}, close: () => {} })
const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })

interface Call {
  url: string
  cuerpo: Record<string, unknown> | null
  token: string | null
}

function hubFalso(responder: (l: Call) => Response) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const llamada: Call = {
        url,
        cuerpo: init?.body ? JSON.parse(String(init.body)) : null,
        token: headers.authorization?.replace('Bearer ', '') ?? null,
      }
      calls.push(llamada)
      if (url === '/api/catalog') return json(catalogoDePrueba())
      return responder(llamada)
    }),
  )
  return calls
}
const autorizaciones = (l: Call[]) => l.filter((x) => x.url === '/api/authorizations')

const device: Equipo = {
  deviceId: newId(),
  token: 'token-ana',
  name: 'Ana',
  type: 'waiter',
}
const sesionMesero = (): Sesion => ({
  sesionId: newId(),
  secret: 'secreto-ana',
  user: { id: newId(), name: 'Ana', role: 'Mesero' },
  permissions: ['take_order'],
  ultimoUso: Date.now(),
})

async function open(session: Sesion | null = sesionMesero()) {
  const db = new BaseDispositivo(`prueba-${newId()}`)
  bases.push(db)
  await db.saveSetting('device', device)
  if (session) await db.saveSetting('session', session)
  await db.saveSetting('catalog', catalogoDePrueba())
  const floor = new Sala({ db, open: sinRed })
  salas.push(floor)
  await floor.load()
  return { floor, session }
}

const ANULAR = { item_id: newId(), quantity: 1, already_prepared: false, ticket_id: null }
const COMPROBANTE = newId()
const concede = () =>
  json({ authorization_id: COMPROBANTE, supervisor: { id: newId(), name: 'Gloria' } }, 201)
const savedList = async (floor: Sala) => (await floor.sync?.locals()) ?? []

describe('Sala.registrar con autoriza', () => {
  it('pide el comprobante con la huella del evento, para ese pedido, ese evento y esa acción', async () => {
    const calls = hubFalso(concede)
    const { floor, session } = await open()
    const order = newId()
    const event = await floor.record('ItemVoided', order, ANULAR, {
      reason: 'Error del mesero',
      authorizes: { pin: '4321', permission: 'void_sent_item' },
    })
    const [llamada, ...otras] = autorizaciones(calls)
    expect(otras).toEqual([])
    expect(llamada).toMatchObject({
      token: 'token-ana',
      cuerpo: {
        session_id: session?.sesionId,
        secret: 'secreto-ana',
        pin: '4321',
        action: 'void_sent_item',
        aggregate_id: order,
        event_id: event.id,
      },
    })
    // La huella es la del evento tal como salió (sin comprobante ni firma).
    expect(llamada?.cuerpo?.fingerprint).toBe(authorizableFingerprint(event))
    expect(llamada?.cuerpo?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('el evento sale con el autorizacion_id del hub y una firma válida que cubre ese comprobante', async () => {
    hubFalso(concede)
    const { floor } = await open()
    const event = await floor.record('ItemVoided', newId(), ANULAR, {
      reason: 'Demora',
      authorizes: { pin: '4321', permission: 'void_sent_item' },
    })
    expect(event.authorization_id).toBe(COMPROBANTE)
    const { signature, ...sinFirma } = event
    expect(signature).toBe(signEvent(sinFirma as never, 'secreto-ana'))
    // La firma cambia si el comprobante cambia: está firmado con él puesto.
    expect(signEvent({ ...sinFirma, authorization_id: null } as never, 'secreto-ana')).not.toBe(
      signature,
    )
    // Y la huella (sin comprobante) no cambia por ponerlo.
    expect(authorizableFingerprint({ ...sinFirma, authorization_id: null } as never)).toBe(
      authorizableFingerprint(event),
    )
  })

  it('el evento queda guardado en el equipo, pendiente, con el comprobante y el motivo', async () => {
    hubFalso(concede)
    const { floor } = await open()
    const event = await floor.record(
      'OrderCanceled',
      newId(),
      {},
      {
        reason: 'El cliente cambió',
        authorizes: { pin: '1111', permission: 'cancel_order' },
      },
    )
    const saved = (await savedList(floor)).find((l) => l.event.id === event.id)
    expect(saved).toMatchObject({
      status: 'pending',
      event: {
        authorization_id: COMPROBANTE,
        reason: 'El cliente cambió',
        type: 'OrderCanceled',
      },
    })
  })

  it('la acción que se pide es la del permiso, tal cual (cancelar_pedido)', async () => {
    const calls = hubFalso(concede)
    const { floor } = await open()
    await floor.record(
      'OrderCanceled',
      newId(),
      {},
      {
        reason: 'x',
        authorizes: { pin: '1111', permission: 'cancel_order' },
      },
    )
    expect(autorizaciones(calls)[0]?.cuerpo?.action).toBe('cancel_order')
  })

  it('cada evento pide su propio comprobante (evento_id distinto)', async () => {
    const calls = hubFalso(concede)
    const { floor } = await open()
    const a = await floor.record('ItemVoided', newId(), ANULAR, {
      reason: 'x',
      authorizes: { pin: '4321', permission: 'void_sent_item' },
    })
    const b = await floor.record('ItemVoided', newId(), ANULAR, {
      reason: 'x',
      authorizes: { pin: '4321', permission: 'void_sent_item' },
    })
    const ids = autorizaciones(calls).map((l) => l.cuerpo?.event_id)
    expect(ids).toEqual([a.id, b.id])
    expect(a.id).not.toBe(b.id)
  })

  it('motivo y relacionados llegan al evento, con o sin comprobante', async () => {
    const calls = hubFalso(concede)
    const { floor } = await open()
    const target = newId()
    const move = await floor.record(
      'OrderMovedTable',
      newId(),
      { target_table_id: newId() },
      { related: [target], reason: 'por si acaso' },
    )
    expect(move).toMatchObject({
      related: [target],
      reason: 'por si acaso',
      authorization_id: null,
    })
    expect(autorizaciones(calls)).toHaveLength(0)
    const voidItem = await floor.record('ItemVoided', newId(), ANULAR, {
      reason: 'Demora',
      related: [target],
      authorizes: { pin: '4321', permission: 'void_sent_item' },
    })
    expect(voidItem).toMatchObject({ related: [target], reason: 'Demora' })
    // La huella cubre el motivo y los relacionados: son parte del contenido que se autoriza.
    expect(autorizaciones(calls)[0]?.cuerpo?.fingerprint).toBe(authorizableFingerprint(voidItem))
  })

  it('sin opciones: motivo null, sin relacionados y sin comprobante (como antes)', async () => {
    const calls = hubFalso(concede)
    const { floor } = await open()
    const e = await floor.record('GuestsChanged', newId(), { guests: 3 })
    expect(e).toMatchObject({ reason: null, related: [], authorization_id: null })
    expect(autorizaciones(calls)).toEqual([])
  })

  it('sin conexión con la caja falla limpio: ErrorApi sin_conexion y no se guarda nada', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const { floor } = await open()
    await expect(
      floor.record('ItemVoided', newId(), ANULAR, {
        reason: 'x',
        authorizes: { pin: '4321', permission: 'void_sent_item' },
      }),
    ).rejects.toMatchObject({ code: 'offline' })
    expect(await savedList(floor)).toEqual([])
  })

  it('con el corte simulado tampoco sale la llamada ni se guarda el evento', async () => {
    const calls = hubFalso(concede)
    const { floor } = await open()
    floor.simularSinConexion(true)
    const r = floor.record('ItemVoided', newId(), ANULAR, {
      reason: 'x',
      authorizes: { pin: '4321', permission: 'void_sent_item' },
    })
    await expect(r).rejects.toBeInstanceOf(ErrorApi)
    await expect(r).rejects.toMatchObject({ code: 'offline' })
    expect(autorizaciones(calls)).toEqual([])
    expect(await savedList(floor)).toEqual([])
  })

  it.each([
    ['PIN incorrecto', 401, 'wrong_pin'],
    ['el mismo usuario', 403, 'self_authorization'],
    ['muchos intentos', 429, 'too_many_attempts'],
  ])(
    'si el hub dice %s, falla con ese código y no se guarda ni se firma nada',
    async (_n, status, code) => {
      hubFalso(() => json({ error: code, message: 'No se pudo autorizar' }, status))
      const { floor } = await open()
      await expect(
        floor.record('ItemVoided', newId(), ANULAR, {
          reason: 'x',
          authorizes: { pin: '0000', permission: 'void_sent_item' },
        }),
      ).rejects.toMatchObject({ code, message: 'No se pudo autorizar' })
      expect(await savedList(floor)).toEqual([])
      expect(floor.instantanea().session).not.toBeNull()
    },
  )

  it('si el hub dice que la sesión ya no vale, se cierra la sesión del equipo', async () => {
    hubFalso(() => json({ error: 'invalid_session', message: 'Entra otra vez' }, 401))
    const { floor } = await open()
    await expect(
      floor.record('ItemVoided', newId(), ANULAR, {
        reason: 'x',
        authorizes: { pin: '4321', permission: 'void_sent_item' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_session' })
    expect(floor.instantanea().session).toBeNull()
    expect(await savedList(floor)).toEqual([])
  })

  it('sin sesión no llama al hub y avisa que hay que entrar', async () => {
    const calls = hubFalso(concede)
    const { floor } = await open(null)
    await expect(
      floor.record('ItemVoided', newId(), ANULAR, {
        reason: 'x',
        authorizes: { pin: '4321', permission: 'void_sent_item' },
      }),
    ).rejects.toThrow('Sin sesión')
    expect(autorizaciones(calls)).toEqual([])
  })

  it('un fallo del comprobante deja la sesión abierta y el siguiente intento sí funciona', async () => {
    let n = 0
    const calls = hubFalso(() =>
      n++ === 0 ? json({ error: 'wrong_pin', message: 'PIN incorrecto' }, 401) : concede(),
    )
    const { floor } = await open()
    const data = {
      reason: 'x',
      authorizes: { pin: '4321', permission: 'void_sent_item' },
    }
    await expect(floor.record('ItemVoided', newId(), ANULAR, data)).rejects.toMatchObject({
      code: 'wrong_pin',
    })
    const e = await floor.record('ItemVoided', newId(), ANULAR, data)
    expect(e.authorization_id).toBe(COMPROBANTE)
    expect(autorizaciones(calls)).toHaveLength(2)
    expect((await savedList(floor)).map((l) => l.event.id)).toEqual([e.id])
  })
})
