import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { AlmacenDispositivoMemoria } from './dispositivo/almacen'
import { ClienteSync } from './dispositivo/cliente'
import { AlmacenMemoria } from './hub/almacen'
import { HubSync } from './hub/hub'
import { canonicalJson, fingerprint, huellaEvento, MAX_DEPTH } from './huella'
import type { MensajeDispositivo, MensajeHub } from './protocolo'
import { accesoLibre } from './pruebas/acceso'
import {
  AHORA,
  abrirPedido,
  eventosDe,
  item,
  type Montaje,
  montar,
  venLoMismo,
} from './pruebas/montaje'
import type { Nodo } from './pruebas/red'

// Lo que encontró la revisión de la tarea 0.6: entradas que no deben tumbar al hub, carreras del
// dispositivo al reconectar, el reloj desfasado y lo que ve un dispositivo revocado.

const crudo = (node: Nodo, order: string, type: string, data: unknown, extras = {}) => ({
  id: newId(),
  type,
  schema_version: 1,
  aggregate_type: 'order',
  aggregate_id: order,
  related: [],
  data,
  session_id: null,
  user_id: node.userId,
  device_id: node.dispositivoId,
  authorization_id: null,
  reason: null,
  device_time: AHORA,
  hub_estimated_time: AHORA,
  base_sequence: 0,
  ...extras,
})

const open = (node: Nodo, order: string, extras = {}) =>
  crudo(node, order, 'OrderOpened', { channel: 'bar', table_id: null, guests: 1 }, extras)

const conexionDe = (m: Montaje, node: Nodo) => {
  const connection = m.network.tokens.get(`token-${node.name}`)
  if (!connection) throw new Error(`Sin token para ${node.name}`)
  return connection
}

function anidado(niveles: number): unknown {
  let value: unknown = 'fondo'
  for (let i = 0; i < niveles; i++) value = { a: value }
  return value
}

describe('huella', () => {
  it('no depende del orden de las claves ni de `secuencia_base`', () => {
    expect(fingerprint({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      fingerprint({ b: [1, { d: 3, c: 2 }], a: 1 }),
    )
    expect(huellaEvento({ id: 'x', base_sequence: 7 })).toBe(
      huellaEvento({ id: 'x', base_sequence: 0 }),
    )
    expect(huellaEvento({ id: 'x', reason: 'a' })).not.toBe(huellaEvento({ id: 'x', reason: 'b' }))
  })

  it('corta el recorrido de algo demasiado anidado en vez de agotar la pila', () => {
    expect(() => canonicalJson(anidado(MAX_DEPTH - 1))).not.toThrow()
    expect(() => canonicalJson(anidado(MAX_DEPTH + 1))).toThrow(RangeError)
    expect(() => fingerprint(anidado(100_000))).toThrow(RangeError)
  })
})

describe('hub: entradas que no deben tumbarlo', () => {
  it('un evento sin id, malformado, repetido: misma respuesta y un solo rechazo guardado', () => {
    const m = montar()
    const ana = m.network.device('ana')
    const badCase = { type: 'OrderOpened', data: null }
    const r1 = m.hub().recibirLote(conexionDe(m, ana), [badCase])
    const r2 = m.hub().recibirLote(conexionDe(m, ana), [badCase])

    expect(r1.resultados).toEqual(r2.resultados)
    expect(r1.resultados[0]).toMatchObject({ id: '', status: 'rejected' })
    expect(m.db.prepare('SELECT count(*) AS n FROM rejected_events').get()?.n).toBe(1)
  })

  it('eventos enormes o muy anidados se rechazan sin recorrerlos y el lote sigue', () => {
    const m = montar()
    const ana = m.network.device('ana')
    const order = newId()
    const r = m
      .hub()
      .recibirLote(conexionDe(m, ana), [
        { ...open(ana, order), reason: 'x'.repeat(70_000) },
        { ...open(ana, newId()), data: anidado(100_000) },
        open(ana, newId()),
      ])

    expect(r.resultados.map((x) => x.status)).toEqual(['rejected', 'rejected', 'confirmed'])
    expect(r.resultados[0]).toMatchObject({ reason: 'esquema: too_large' })
    expect(r.resultados[1]).toMatchObject({ reason: 'esquema: too_deeply_nested' })
  })

  it('un evento que hace fallar al hub se rechaza como `error_interno`; el resto del lote sigue', () => {
    const m = montar()
    const ana = m.network.device('ana')
    const errors: string[] = []
    const almacen = new AlmacenMemoria()
    const veneno = open(ana, newId())
    const original = almacen.saveEvent.bind(almacen)
    almacen.saveEvent = (event, ...rest) => {
      if (event.id === veneno.id) throw new Error('falla con este evento')
      original(event, ...rest)
    }
    const hub = new HubSync(almacen, {
      restauranteId: '',
      timeZone: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      access: accesoLibre,
      instancia: 'hub-1',
      clock: m.network.horaIso,
      alErrorInterno: (_error, id) => errors.push(id),
    })

    const r = hub.recibirLote(conexionDe(m, ana), [veneno, open(ana, newId())])
    const onceMore = hub.recibirLote(conexionDe(m, ana), [veneno])

    expect(r.resultados.map((x) => x.status)).toEqual(['rejected', 'confirmed'])
    expect(r.resultados[0]).toMatchObject({ reason: 'internal_error' })
    expect(onceMore.resultados).toEqual([r.resultados[0]])
    expect(errors).toEqual([veneno.id])
  })

  it('si el almacén no guarda ni el rechazo, el hub lanza (se reinicia) y no queda nada a medias', () => {
    const m = montar({ almacen: 'memory' })
    const ana = m.network.device('ana')
    const almacen = m.almacen as AlmacenMemoria
    almacen.fallar = () => {
      throw new Error('disco lleno')
    }

    expect(() => m.hub().recibirLote(conexionDe(m, ana), [open(ana, newId())])).toThrow(
      'disco lleno',
    )
    expect(almacen.events).toHaveLength(0)
    expect(almacen.rechazos).toHaveLength(0)
  })

  it('una conexión que falla al enviar no deja sin el evento a las demás', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await m.network.conectarTodos()
    const broken = m.network.sala.connect((message) => {
      if (message.type === 'new') throw new Error('socket cerrado')
    })
    broken.recibir({
      type: 'hello',
      token: 'token-luis',
      hub_instancia: null,
      until: 0,
      version_app: 'x',
    })

    const order = await abrirPedido(ana)
    await m.network.settle()

    await venLoMismo(m.hub(), eventosDe(m), [ana, luis], [order])
  })
})

describe('hub: al día y proyecciones', () => {
  it('lo que el mismo dispositivo hizo antes cuenta como conocido: un error suyo se rechaza', () => {
    const m = montar()
    const ana = m.network.device('ana')
    const order = newId()
    const r = m.hub().recibirLote(conexionDe(m, ana), [
      open(ana, order),
      crudo(ana, order, 'ItemAdded', item()),
      // Todo lo que hay en el pedido lo hizo ana: no hay nada que no conociera.
      crudo(ana, order, 'ItemRemoved', { item_id: newId() }),
    ])

    expect(r.resultados[2]).toMatchObject({ status: 'rejected', reason: 'item_not_found' })
    expect(m.hub().conflictos()).toEqual([])
  })

  it('un pedido cancelado sale de la memoria del hub pero se sigue consultando de la base', () => {
    const m = montar()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    const order = newId()
    m.hub().recibirLote(conexionDe(m, ana), [
      open(ana, order),
      crudo(ana, order, 'OrderCanceled', {}, { base_sequence: 1, reason: 'Se fueron' }),
    ])
    expect(m.hub().order(order)?.status).toBe('canceled')

    // Luis no sabía de la cancelación: su cambio entra como conflicto, no cambia el pedido.
    const tarde = m
      .hub()
      .recibirLote(conexionDe(m, luis), [
        crudo(luis, order, 'GuestsChanged', { guests: 3 }, { base_sequence: 1 }),
      ])
    expect(tarde.resultados[0]).toMatchObject({ status: 'confirmed', conflict: 'order_closed' })
    expect(m.hub().order(order)?.guests).toBe(1)
  })
})

describe('dispositivo revocado', () => {
  it('no recibe eventos del salón; lo suyo de antes va a cuarentena, con tope', async () => {
    const m = montar({ almacen: 'memory' })
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    const errors: string[] = []
    await m.network.conectarTodos()
    const connection = conexionDe(m, ana)
    connection.revocadoEn = m.network.horaIso()
    ana.aDispositivo = []

    await abrirPedido(luis)
    await m.network.settle()
    expect(ana.aDispositivo).toEqual([])

    const sala = m.network.sala.connect((message) => {
      if (message.type === 'error') errors.push(message.code)
    })
    sala.recibir({
      type: 'hello',
      token: 'token-ana',
      hub_instancia: null,
      until: 0,
      version_app: 'x',
    })
    sala.recibir({ type: 'pull', from: 0 })
    expect(errors).toEqual(['revoked_token'])

    const before = { hub_estimated_time: '2026-10-24T19:00:00.000Z' }
    for (let i = 0; i < 6; i++) {
      m.hub().recibirLote(
        connection,
        Array.from({ length: 100 }, () => open(ana, newId(), before)),
      )
    }
    expect((m.almacen as AlmacenMemoria).cuarentenas).toHaveLength(500)
  })
})

describe('sesión de quien creó el evento', () => {
  it('solo la recibe el dispositivo que lo creó', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const luis = m.network.device('luis')
    await m.network.conectarTodos()
    const session = newId()
    await ana.crear(
      newId(),
      'OrderOpened',
      { channel: 'bar', table_id: null, guests: 1 },
      {
        session_id: session,
      },
    )
    await m.network.settle()

    const [deAna] = await ana.cliente.locales()
    const [deLuis] = await luis.cliente.locales()
    expect(deAna?.event.session_id).toBe(session)
    expect(deLuis?.event.session_id).toBeNull()
    expect(m.hub().pull(0, 'waiter', ana.dispositivoId).events[0]?.session_id).toBe(session)
    expect(m.hub().pull(0, 'waiter', luis.dispositivoId).events[0]?.session_id).toBeNull()
  })
})

describe('cliente: reconexiones y reloj', () => {
  /** Un cliente suelto, sin red: lo que envía queda en `enviados`. */
  function suelto() {
    const enviados: MensajeDispositivo[] = []
    const almacen = new AlmacenDispositivoMemoria()
    let clock = Date.parse('2026-10-24T20:00:00.000Z')
    const cliente = new ClienteSync({
      almacen,
      token: 't',
      versionApp: 'x',
      send: (message) => enviados.push(message),
      ahora: () => clock,
    })
    return { cliente, enviados, almacen, advance: (ms: number) => (clock += ms) }
  }
  const welcome = (time = '2026-10-24T20:00:00.000Z'): MensajeHub => ({
    type: 'welcome',
    hub_instancia: 'hub-1',
    secuencia_max: 0,
    hora_hub: time,
  })

  it('lo que llega por una conexión ya cerrada no se procesa ni envía nada por la nueva', async () => {
    const { cliente, enviados } = suelto()
    await cliente.alConectar()
    const tardio = cliente.recibir(welcome())
    cliente.alDesconectar()
    const newOne = cliente.alConectar()
    await Promise.all([tardio, newOne])

    expect(enviados.map((x) => x.type)).toEqual(['hello', 'hello'])
  })

  it('un evento registrado dos veces se guarda una sola vez', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    const event = await ana.crear(newId(), 'OrderOpened', {
      channel: 'bar',
      table_id: null,
      guests: 1,
    })
    expect(await ana.cliente.record(event)).toEqual({ ok: true })
    expect(await ana.cliente.pendingList()).toBe(1)
  })

  it('aprende el desfase del reloj al conectar, lo usa en `hora_estimada_hub` y lo guarda', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    ana.desfaseMs = -59_000 // como el Android de la prueba en celulares (ADR-001)
    await m.network.conectarTodos()

    const event = await ana.crear(newId(), 'OrderOpened', {
      channel: 'bar',
      table_id: null,
      guests: 1,
    })
    expect(event.hub_estimated_time).toBe(m.network.horaIso())
    expect(event.device_time).not.toBe(m.network.horaIso())
    expect((await ana.almacen.cursor()).desfaseMs).toBe(59_000)

    const other = new ClienteSync({
      almacen: ana.almacen,
      token: 't',
      versionApp: 'x',
      send: () => {},
      ahora: () => m.network.ahora() - 59_000,
    })
    await other.begin()
    expect(other.horaEstimadaHub()).toBe(m.network.horaIso())
  })

  it('un rechazo que llega después de que el evento volvió confirmado no lo deshace', async () => {
    const m = montar()
    const ana = m.network.device('ana')
    await m.network.conectarTodos()
    ana.rule('to_device', 'result', 'drop')
    const event = await ana.crear(newId(), 'OrderOpened', {
      channel: 'bar',
      table_id: null,
      guests: 1,
    })
    await m.network.settle()
    expect((await ana.cliente.locales())[0]?.status).toBe('confirmed')

    // Llega tarde un resultado (de un reenvío) que dice que no.
    const batch = (ana.cliente as unknown as { loteEnVuelo: unknown }).loteEnVuelo
    expect(batch).toBeNull()
    ;(ana.cliente as unknown as { loteEnVuelo: unknown }).loteEnVuelo = {
      id: 'tarde',
      events: [event.id],
    }
    await ana.cliente.recibir({
      type: 'result',
      lote_id: 'tarde',
      resultados: [{ id: event.id, status: 'rejected', reason: 'duplicate_id' }],
    })
    expect((await ana.cliente.locales())[0]?.status).toBe('confirmed')
  })

  it('un error del hub por token inválido deja de enviar y avisa a la app', async () => {
    const errors: string[] = []
    const enviados: MensajeDispositivo[] = []
    const cliente = new ClienteSync({
      almacen: new AlmacenDispositivoMemoria(),
      token: 't',
      versionApp: 'x',
      send: (message) => enviados.push(message),
      onHubError: (code) => errors.push(code),
    })
    await cliente.alConectar()
    await cliente.recibir({ type: 'error', code: 'invalid_token', message: 'no' })
    await cliente.recibir(welcome())

    expect(errors).toEqual(['invalid_token'])
    expect(enviados.map((x) => x.type)).toEqual(['hello'])
  })

  it('un fallo al procesar un mensaje no rompe la cola: llega a `alFallo` y lo siguiente sigue', async () => {
    const fallos: unknown[] = []
    const almacen = new AlmacenDispositivoMemoria()
    const enviados: MensajeDispositivo[] = []
    const cliente = new ClienteSync({
      almacen,
      token: 't',
      versionApp: 'x',
      send: (message) => enviados.push(message),
      onFailure: (error) => fallos.push(error),
    })
    await cliente.alConectar()
    const cursor = almacen.cursor.bind(almacen)
    almacen.cursor = async () => {
      almacen.cursor = cursor
      throw new Error('IndexedDB cerrada')
    }
    await cliente.recibir(welcome())
    await cliente.recibir(welcome())

    expect(fallos).toHaveLength(1)
    expect(enviados.map((x) => x.type)).toEqual(['hello', 'pull'])
  })
})
