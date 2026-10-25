import { nuevoId } from '@pos/core'
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
  direccion: string
  apagada: boolean
  /** Lo recibido, un trabajo por entrada. */
  recibidos: Uint8Array[]
  /** Cuántas veces se intentó (también las que fallaron). */
  intentos: number
  /** Lo recibido, ya leído como texto (una comanda por entrada). */
  textos(): string[]
}

export type Equipo = ReturnType<ReturnType<typeof montarImpresion>['equipo']>

export interface OpcionesMontaje {
  /** Cambia cómo se reparte el envío de bytes (por ejemplo, para hacerlo lento). */
  enviar?: (base: Enviar) => Enviar
  /** Gancho de `alGuardar` del hub: por defecto, el real del hub (`trabajosDeEvento`). */
  zonaHoraria?: string
  permitirLocales?: boolean
  esEquipoDelHub?: (ip: string) => boolean
}

export function montarImpresion(opciones: OpcionesMontaje = {}) {
  const m = montarAcceso()
  const zonaHoraria = opciones.zonaHoraria ?? 'America/Bogota'
  const ahora = m.reloj()
  const estacion = (nombre: string, orden: number) =>
    insertarVersionado(m.db, 'estacion', m.restauranteId, { nombre, orden }, SISTEMA, ahora)
  const cocina = estacion('Cocina', 1)
  const barra = estacion('Barra', 2)
  const postres = estacion('Postres', 3)

  const sede = String(
    m.db.prepare('SELECT id FROM sede WHERE restaurante_id = ?').get(m.restauranteId)?.id,
  )
  const zona = insertarVersionado(
    m.db,
    'zona',
    m.restauranteId,
    { sede_id: sede, nombre: 'Salón', orden: 1, piso: 1 },
    SISTEMA,
    ahora,
  )
  const mesa = (nombre: string) =>
    insertarVersionado(
      m.db,
      'mesa',
      m.restauranteId,
      { zona_id: zona, nombre, forma: 'cuadrada', x: 0, y: 0, ancho: 1, alto: 1, capacidad: 4 },
      SISTEMA,
      ahora,
    )

  // ── La red de impresoras de mentira ────────────────────────────────
  const red = new Map<string, Papel>()
  let contador = 0
  const papel = (direccion: string): Papel => {
    const p: Papel = {
      direccion,
      apagada: false,
      recibidos: [],
      intentos: 0,
      textos: () => p.recibidos.map((b) => leerEscpos(b).texto),
    }
    red.set(direccion, p)
    return p
  }
  const base: Enviar = async (destino: Destino, bytes: Uint8Array) => {
    const p = red.get(destino.direccion)
    if (p) p.intentos += 1
    if (!p || p.apagada)
      throw new ErrorImpresora(
        'La impresora rechazó la conexión: revisa el puerto (casi siempre 9100).',
      )
    p.recibidos.push(bytes)
  }
  const enviarBytes = opciones.enviar ? opciones.enviar(base) : base

  const impresoraNueva = (
    nombre: string,
    estaciones: string[],
    campos: Record<string, ValorSql> = {},
  ) => {
    contador += 1
    const direccion = `10.0.0.${contador}`
    const p = papel(direccion)
    const id = insertarVersionado(
      m.db,
      'impresora',
      m.restauranteId,
      {
        nombre,
        conexion: 'red',
        direccion,
        puerto: 9100,
        ancho: 80,
        pagina_codigos: 'pc850',
        estacion_ids: JSON.stringify(estaciones),
        ...campos,
      },
      SISTEMA,
      m.reloj(),
    )
    return { id, papel: p, direccion }
  }

  // ── Cola y hub ─────────────────────────────────────────────────────
  const estadosAvisados: unknown[][] = []
  const fallosCola: unknown[] = []
  const reloj = () => Date.parse(m.reloj())
  const crearCola = (extra: Partial<OpcionesCola> = {}) =>
    new ColaImpresion({
      db: m.db,
      restauranteId: m.restauranteId,
      enviar: enviarBytes,
      reloj,
      alCambiar: (e) => estadosAvisados.push(e),
      alFallo: (e) => fallosCola.push(e),
      ...extra,
    })
  const cola = crearCola()

  const opcionesComandas = { db: m.db, restauranteId: m.restauranteId, zonaHoraria }
  const fallosGuardar: { error: unknown; id: string }[] = []
  const crearHub = () =>
    new HubSync(new AlmacenSqlite(m.db, m.restauranteId), {
      restauranteId: m.restauranteId,
      zonaHoraria,
      inicioDiaOperativo: '06:00',
      instancia: 'hub-1',
      reloj: m.reloj,
      acceso: m.acceso,
      alGuardar: (evento, cambios) => {
        trabajosDeEvento(opcionesComandas, evento, cambios)
      },
      alFalloAlGuardar: (error, id) => fallosGuardar.push({ error, id }),
    })
  const hub = crearHub()

  // ── Servidor HTTP ──────────────────────────────────────────────────
  const cambiosCatalogo: number[] = []
  const app = crearServidor({
    acceso: m.acceso,
    catalogo: {
      db: m.db,
      restauranteId: m.restauranteId,
      acceso: m.acceso,
      reloj: m.reloj,
      alCambiar: (v) => cambiosCatalogo.push(v),
    },
    impresion: {
      db: m.db,
      restauranteId: m.restauranteId,
      acceso: m.acceso,
      cola,
      zonaHoraria,
      alCambiar: (v) => cambiosCatalogo.push(v),
      reloj: m.reloj,
      permitirLocales: opciones.permitirLocales,
      esEquipoDelHub: opciones.esEquipoDelHub,
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
  function equipo(
    quien: keyof typeof m.personas = 'mesero',
    tipo: 'mesero' | 'caja' | 'kds' = 'mesero',
  ) {
    const { token, conexion } = m.emparejar(tipo)
    const sesion = m.entrar(conexion, quien)
    const cuerpoSesion = { sesion_id: sesion.sesionId, secreto: sesion.secreto }
    const maxSecuencia = () =>
      Number(
        m.db
          .prepare('SELECT coalesce(max(secuencia), 0) AS s FROM evento WHERE restaurante_id = ?')
          .get(m.restauranteId)?.s,
      )
    /** Manda un evento y devuelve cómo le fue. */
    const mandar = (
      pedido: string,
      tipo: string,
      datos: unknown,
      extras: Record<string, unknown> = {},
      destino: HubSync = hub,
    ) => {
      const r = destino.recibirLote(conexion, [
        m.evento(conexion, sesion, tipo, datos, {
          agregado_id: pedido,
          secuencia_base: maxSecuencia(),
          ...(tipo === 'ItemAnulado' ? { motivo: 'El cliente se arrepintió' } : {}),
          ...extras,
        } as never),
      ])
      return {
        estado: r.resultados[0]?.estado,
        resultado: r.resultados[0],
        aceptado: r.aceptados[0],
      }
    }
    return { token, conexion, sesion, cuerpoSesion, mandar }
  }

  type Producto = {
    nombre: string
    estacion: string
    opciones?: string[]
    curso?: 'entrada' | 'fuerte' | 'postre' | null
    notas?: string | null
    comensal?: number | null
    cantidad?: number
  }

  /** Abre un pedido vacío. */
  function abrir(e: Equipo, mesaId: string | null = null, canal = 'salon') {
    const pedido = nuevoId()
    const abierto = e.mandar(pedido, 'PedidoAbierto', { ...ABRIR, canal, mesa_id: mesaId })
    if (abierto.estado !== 'confirmado')
      throw new Error(`No abrió: ${JSON.stringify(abierto.resultado)}`)
    return pedido
  }

  /** Agrega un producto a un pedido. */
  function agregar(e: Equipo, pedido: string, p: Producto) {
    const it = {
      ...item(
        (p.opciones ?? []).map((n) => ({ modificador_id: nuevoId(), nombre: n, precio_extra: 0 })),
      ),
      nombre: p.nombre,
      curso: p.curso ?? null,
      notas: p.notas ?? null,
      comensal: p.comensal ?? null,
      cantidad: p.cantidad ?? 1,
    }
    const r = e.mandar(pedido, 'ItemAgregado', it)
    if (r.estado !== 'confirmado') throw new Error(`No agregó: ${JSON.stringify(r.resultado)}`)
    return { id: it.item_id, estacion: p.estacion, nombre: p.nombre }
  }

  /** Un pedido con productos ya agregados (sin enviar). */
  function pedidoCon(
    e: Equipo,
    productos: Producto[],
    mesaId: string | null = null,
    canal = 'salon',
  ) {
    const pedido = abrir(e, mesaId, canal)
    return { pedido, items: productos.map((p) => agregar(e, pedido, p)) }
  }

  /** Envía los ítems indicados; `porEstacion` arma una comanda por estación. */
  function enviar(e: Equipo, pedido: string, items: { id: string; estacion: string }[]) {
    const porEstacion = new Map<string, string[]>()
    for (const i of items)
      porEstacion.set(i.estacion, [...(porEstacion.get(i.estacion) ?? []), i.id])
    const comandas = [...porEstacion].map(([estacion_id, item_ids]) => ({
      comanda_id: nuevoId(),
      estacion_id,
      item_ids,
    }))
    const r = e.mandar(pedido, 'ItemsEnviados', { comandas })
    return { ...r, comandas }
  }

  const trabajos = (filtro = '') =>
    m.db
      .prepare(`SELECT * FROM trabajo_impresion ${filtro} ORDER BY creado_en, id`)
      .all() as Record<string, ValorSql>[]
  const pendientes = () => trabajos("WHERE estado = 'pendiente'").length
  const contenido = (fila: Record<string, ValorSql> | undefined) =>
    JSON.parse(String(fila?.contenido ?? 'null'))

  return {
    ...m,
    zonaHoraria,
    cocina,
    barra,
    postres,
    zona,
    mesa,
    sede,
    red,
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
    equipo,
    abrir,
    agregar,
    pedidoCon,
    enviar,
    trabajos,
    pendientes,
    contenido,
    reloj,
  }
}

export type MontajeImpresion = ReturnType<typeof montarImpresion>
