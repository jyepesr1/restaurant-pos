import { newId } from '@pos/core'
import type { ValorSql } from '@pos/db'
import { leerEscpos } from '@pos/printing'
import { HubSync } from '@pos/sync'
import { AlmacenSqlite } from '@pos/sync/sqlite'
import { montarAcceso } from '../acceso/montaje'
import { ABRIR, item } from '../acceso/montaje-hub'
import { insertarVersionado, SISTEMA } from '../acceso/registros'
import { crearServidor } from '../servidor'
import { ColaImpresion, type OpcionesCola } from './cola'
import { trabajosDeEvento } from './comandas'
import { type Destino, type Enviar, ErrorImpresora } from './transporte'

// Montaje de las pruebas de la tarea 1.4 (ADR-015): el hub con acceso, una red de impresoras de
// mentira (sin sockets, a voluntad: encendidas, apagadas, lentas), la cola de impresión con reloj
// manual, el `HubSync` con el gancho de comandas y el servidor HTTP con las rutas de impresión.
// Solo para pruebas.

/** Una impresora de la red de mentira: guarda lo que recibe y se puede apagar. */
export interface Papel {
  address: string
  apagada: boolean
  /** Lo recibido, un trabajo por entrada. */
  recibidos: Uint8Array[]
  /** Cuántas veces se intentó (también las que fallaron). */
  attempts: number
  /** Lo recibido, ya leído como texto (una comanda por entrada). */
  textos(): string[]
}

export type Equipo = ReturnType<ReturnType<typeof montarImpresion>['device']>

export interface OpcionesMontaje {
  /** Cambia cómo se reparte el envío de bytes (por ejemplo, para hacerlo lento). */
  send?: (base: Enviar) => Enviar
  /** Gancho de `onSave` del hub: por defecto, el real del hub (`trabajosDeEvento`). */
  timeZone?: string
  permitirLocales?: boolean
  esEquipoDelHub?: (ip: string) => boolean
}

export function montarImpresion(options: OpcionesMontaje = {}) {
  const m = montarAcceso()
  const timeZone = options.timeZone ?? 'America/Bogota'
  const ahora = m.clock()
  const station = (name: string, position: number) =>
    insertarVersionado(m.db, 'stations', m.restauranteId, { name, position }, SISTEMA, ahora)
  const kitchen = station('Cocina', 1)
  const bar = station('Barra', 2)
  const postres = station('Postres', 3)

  const location = String(
    m.db.prepare('SELECT id FROM locations WHERE restaurant_id = ?').get(m.restauranteId)?.id,
  )
  const zone = insertarVersionado(
    m.db,
    'zones',
    m.restauranteId,
    { location_id: location, name: 'Salón', position: 1, level: 1 },
    SISTEMA,
    ahora,
  )
  const table = (name: string) =>
    insertarVersionado(
      m.db,
      'dining_tables',
      m.restauranteId,
      { zone_id: zone, name, shape: 'square', x: 0, y: 0, width: 1, height: 1, capacity: 4 },
      SISTEMA,
      ahora,
    )

  // ── La red de impresoras de mentira ────────────────────────────────
  const network = new Map<string, Papel>()
  let counter = 0
  const papel = (address: string): Papel => {
    const p: Papel = {
      address,
      apagada: false,
      recibidos: [],
      attempts: 0,
      textos: () => p.recibidos.map((b) => leerEscpos(b).text),
    }
    network.set(address, p)
    return p
  }
  const base: Enviar = async (target: Destino, bytes: Uint8Array) => {
    const p = network.get(target.address)
    if (p) p.attempts += 1
    if (!p || p.apagada)
      throw new ErrorImpresora(
        'La impresora rechazó la conexión: revisa el puerto (casi siempre 9100).',
      )
    p.recibidos.push(bytes)
  }
  const enviarBytes = options.send ? options.send(base) : base

  const impresoraNueva = (
    name: string,
    stations: string[],
    fields: Record<string, ValorSql> = {},
  ) => {
    counter += 1
    const address = `10.0.0.${counter}`
    const p = papel(address)
    const id = insertarVersionado(
      m.db,
      'printers',
      m.restauranteId,
      {
        name,
        connection: 'network',
        address,
        port: 9100,
        width: 80,
        code_page: 'pc850',
        station_ids: JSON.stringify(stations),
        ...fields,
      },
      SISTEMA,
      m.clock(),
    )
    return { id, papel: p, address }
  }

  // ── Cola y hub ─────────────────────────────────────────────────────
  const estadosAvisados: unknown[][] = []
  const fallosCola: unknown[] = []
  const clock = () => Date.parse(m.clock())
  const crearCola = (extra: Partial<OpcionesCola> = {}) =>
    new ColaImpresion({
      db: m.db,
      restauranteId: m.restauranteId,
      send: enviarBytes,
      clock,
      onChange: (e) => estadosAvisados.push(e),
      onFailure: (e) => fallosCola.push(e),
      ...extra,
    })
  const cola = crearCola()

  const opcionesComandas = { db: m.db, restauranteId: m.restauranteId, timeZone }
  const fallosGuardar: { error: unknown; id: string }[] = []
  const crearHub = () =>
    new HubSync(new AlmacenSqlite(m.db, m.restauranteId), {
      restauranteId: m.restauranteId,
      timeZone,
      inicioDiaOperativo: '06:00',
      instancia: 'hub-1',
      clock: m.clock,
      access: m.access,
      onSave: (event, changes) => {
        trabajosDeEvento(opcionesComandas, event, changes)
      },
      onSaveFailure: (error, id) => fallosGuardar.push({ error, id }),
    })
  const hub = crearHub()

  // ── Servidor HTTP ──────────────────────────────────────────────────
  const cambiosCatalogo: number[] = []
  const app = crearServidor({
    access: m.access,
    catalog: {
      db: m.db,
      restauranteId: m.restauranteId,
      access: m.access,
      clock: m.clock,
      onChange: (v) => cambiosCatalogo.push(v),
    },
    impresion: {
      db: m.db,
      restauranteId: m.restauranteId,
      access: m.access,
      cola,
      timeZone,
      onChange: (v) => cambiosCatalogo.push(v),
      clock: m.clock,
      permitirLocales: options.permitirLocales,
      esEquipoDelHub: options.esEquipoDelHub,
    },
  })
  const post = (url: string, cuerpo: unknown, token?: string) =>
    app.inject({
      method: 'POST',
      url,
      payload: cuerpo as object,
      remoteAddress: '10.0.0.20',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })

  // ── Equipos ────────────────────────────────────────────────────────
  /** Un equipo emparejado con alguien dentro; sabe mandar eventos al hub. */
  function device(
    quien: keyof typeof m.people = 'waiter',
    type: 'waiter' | 'register' | 'kds' = 'waiter',
  ) {
    const { token, connection } = m.emparejar(type)
    const session = m.entrar(connection, quien)
    const cuerpoSesion = { session_id: session.sesionId, secret: session.secret }
    const maxSecuencia = () =>
      Number(
        m.db
          .prepare('SELECT coalesce(max(sequence), 0) AS s FROM events WHERE restaurant_id = ?')
          .get(m.restauranteId)?.s,
      )
    /** Manda un evento y devuelve cómo le fue. */
    const mandar = (
      order: string,
      type: string,
      data: unknown,
      extras: Record<string, unknown> = {},
      target: HubSync = hub,
    ) => {
      const r = target.recibirLote(connection, [
        m.event(connection, session, type, data, {
          aggregate_id: order,
          base_sequence: maxSecuencia(),
          ...(type === 'ItemVoided' ? { reason: 'El cliente se arrepintió' } : {}),
          ...extras,
        } as never),
      ])
      return {
        status: r.resultados[0]?.status,
        result: r.resultados[0],
        accepted: r.aceptados[0],
      }
    }
    return { token, connection, session, cuerpoSesion, mandar }
  }

  type Product = {
    name: string
    station: string
    options?: string[]
    course?: 'entry' | 'main' | 'dessert' | null
    notes?: string | null
    guest?: number | null
    quantity?: number
  }

  /** Abre un pedido vacío. */
  function open(e: Equipo, tableId: string | null = null, channel = 'dine_in') {
    const order = newId()
    const opened = e.mandar(order, 'OrderOpened', { ...ABRIR, channel, table_id: tableId })
    if (opened.status !== 'confirmed') throw new Error(`No abrió: ${JSON.stringify(opened.result)}`)
    return order
  }

  /** Agrega un producto a un pedido. */
  function add(e: Equipo, order: string, p: Product) {
    const it = {
      ...item((p.options ?? []).map((n) => ({ modifier_id: newId(), name: n, extra_price: 0 }))),
      name: p.name,
      course: p.course ?? null,
      notes: p.notes ?? null,
      guest: p.guest ?? null,
      quantity: p.quantity ?? 1,
    }
    const r = e.mandar(order, 'ItemAdded', it)
    if (r.status !== 'confirmed') throw new Error(`No agregó: ${JSON.stringify(r.result)}`)
    return { id: it.item_id, station: p.station, name: p.name }
  }

  /** Un pedido con productos ya agregados (sin enviar). */
  function orderWith(
    e: Equipo,
    products: Product[],
    tableId: string | null = null,
    channel = 'dine_in',
  ) {
    const order = open(e, tableId, channel)
    return { order, items: products.map((p) => add(e, order, p)) }
  }

  /** Envía los ítems indicados; `porEstacion` arma una comanda por estación. */
  function send(e: Equipo, order: string, items: { id: string; station: string }[]) {
    const porEstacion = new Map<string, string[]>()
    for (const i of items) porEstacion.set(i.station, [...(porEstacion.get(i.station) ?? []), i.id])
    const tickets = [...porEstacion].map(([station_id, item_ids]) => ({
      ticket_id: newId(),
      station_id,
      item_ids,
    }))
    const r = e.mandar(order, 'ItemsSent', { tickets })
    return { ...r, tickets }
  }

  const trabajos = (filtro = '') =>
    m.db.prepare(`SELECT * FROM print_jobs ${filtro} ORDER BY created_at, id`).all() as Record<
      string,
      ValorSql
    >[]
  const pendingList = () => trabajos("WHERE status = 'pending'").length
  const content = (fila: Record<string, ValorSql> | undefined) =>
    JSON.parse(String(fila?.content ?? 'null'))

  return {
    ...m,
    timeZone,
    kitchen,
    bar,
    postres,
    zone,
    table,
    location,
    network,
    papel,
    impresoraNueva,
    cola,
    crearCola,
    estadosAvisados,
    fallosCola,
    hub,
    crearHub,
    fallosGuardar,
    opcionesComandas,
    app,
    post,
    cambiosCatalogo,
    device,
    open,
    add,
    orderWith,
    send,
    trabajos,
    pendingList,
    content,
    clock,
  }
}

export type MontajeImpresion = ReturnType<typeof montarImpresion>
