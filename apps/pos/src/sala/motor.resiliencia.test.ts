import 'fake-indexeddb/auto'
import { type EventoNuevo, firmarEvento, nuevoId, validarEventoNuevo } from '@pos/core'
import {
  AlmacenMemoria,
  type Canal,
  type Catalogo,
  type ControlAcceso,
  HubSync,
  type Manejadores,
  type MensajeDispositivo,
  SalaSync,
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

const accesoConFirma: ControlAcceso = {
  verificar: (_c, evento) =>
    evento.sesion_id && evento.firma === firmarEvento(evento, secretoDe(evento.sesion_id))
      ? { ok: true, autorizadoPorId: null, autorizacionId: null }
      : { ok: false, motivo: 'firma_invalida' },
  registrarUso: () => {},
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
async function avanzar(ms: number) {
  for (let t = 0; t < ms; t += 100) {
    await vi.advanceTimersByTimeAsync(Math.min(100, ms - t))
    await asentar(3)
  }
}

/** Avanza hasta que se cumpla la condición; falla si no pasa en `maxMs` de reloj simulado. */
async function hasta(condicion: () => Promise<boolean> | boolean, maxMs = 20_000) {
  for (let t = 0; t <= maxMs; t += 100) {
    if (await condicion()) return
    await avanzar(100)
  }
  throw new Error('No se cumplió en el tiempo simulado')
}

// ── Hub en memoria con fallas ────────────────────────────────────────────────────────────────

interface EquipoHub extends Equipo {
  revocadoEn: string | null
}

function montarHub(opciones: { desfaseHubMs?: number } = {}) {
  const tokens = new Map<string, EquipoHub>()
  const almacen = new AlmacenMemoria()
  const hub = new HubSync(almacen, {
    restauranteId: nuevoId(),
    zonaHoraria: 'America/Bogota',
    inicioDiaOperativo: '06:00',
    instancia: 'hub-prueba',
    reloj: () => new Date(Date.now() + (opciones.desfaseHubMs ?? 0)).toISOString(),
    acceso: accesoConFirma,
  })
  const salaHub = new SalaSync(hub, (token) => {
    const e = tokens.get(token)
    return e ? { dispositivoId: e.dispositivoId, tipo: e.tipo, revocadoEn: e.revocadoEn } : null
  })

  const canales = new Set<{ cortar: () => void }>()
  const h = {
    hub,
    tokens,
    salaHub,
    /** Mientras sea verdad, ningún intento de abrir llega al hub. */
    caido: false,
    aperturas: 0,
    /** Mensajes del dispositivo que llegaron al hub, en orden. */
    recibidos: [] as MensajeDispositivo[],
    /** Si devuelve true para un mensaje que ya llegó al hub, el canal se corta justo después. */
    cortarTras: null as ((m: MensajeDispositivo) => boolean) | null,
    cortarTodo() {
      for (const c of [...canales]) c.cortar()
    },
    abrir(m: Manejadores): Canal {
      h.aperturas += 1
      let enlace: ReturnType<SalaSync['conectar']> | null = null
      let cerrado = false
      const canal = {
        cortar: () => {
          if (cerrado) return
          cerrado = true
          canales.delete(canal)
          enlace?.cerrar()
          enlace = null
          m.alCerrar()
        },
      }
      canales.add(canal)
      setTimeout(() => {
        if (cerrado) return
        if (h.caido) {
          canal.cortar()
          return
        }
        enlace = salaHub.conectar((msg) => {
          const copia = JSON.parse(JSON.stringify(msg))
          setTimeout(() => {
            if (!cerrado) m.alMensaje(copia)
          })
        })
        m.alAbrir()
      })
      return {
        enviar: (msg) => {
          if (!enlace || cerrado) return
          const copia = JSON.parse(JSON.stringify(msg)) as MensajeDispositivo
          h.recibidos.push(copia)
          enlace.recibir(copia)
          if (h.cortarTras?.(copia)) canal.cortar()
        },
        cerrar: () => {
          cerrado = true
          canales.delete(canal)
          enlace?.cerrar()
          enlace = null
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
  catalogo?: Catalogo | null
  /** El token no está en el hub (equipo retirado o hub reinstalado). */
  sinToken?: boolean
  /** Secreto distinto al que conoce el hub. */
  secreto?: string
  /** Empezar sin conexión (el usuario apagó la conexión antes de arrancar). */
  sinConexion?: boolean
  db?: BaseDispositivo
}

async function equipo(h: Hub, nombre: string, o: OpcionesEquipo = {}) {
  const db = o.db ?? new BaseDispositivo(`resiliencia-${nuevoId()}`)
  if (!o.db) bases.push(db)
  const e: EquipoHub = {
    dispositivoId: nuevoId(),
    token: nuevoId(),
    nombre,
    tipo: 'mesero',
    revocadoEn: null,
  }
  if (!o.sinToken) h.tokens.set(e.token, e)
  const sesionId = nuevoId()
  const sesion: Sesion = {
    sesionId,
    secreto: o.secreto ?? secretoDe(sesionId),
    usuario: { id: nuevoId(), nombre, rol: 'Mesero' },
    permisos: ['tomar_pedido'],
    ultimoUso: Date.now() - (o.haceMs ?? 0),
  }
  await db.guardarAjuste('equipo', {
    dispositivoId: e.dispositivoId,
    token: e.token,
    nombre: e.nombre,
    tipo: e.tipo,
  } satisfies Equipo)
  await db.guardarAjuste('sesion', sesion)
  if (o.catalogo !== null) await db.guardarAjuste('catalogo', o.catalogo ?? catalogoDePrueba())
  const sala = new Sala({ db, abrir: (m) => h.abrir(m) })
  salas.push(sala)
  if (o.sinConexion) sala.simularSinConexion(true)
  await sala.cargar()
  return { sala, db, e, sesion }
}

const item = (precio = 1_000) => ({
  item_id: nuevoId(),
  producto_id: nuevoId(),
  variante_id: null,
  nombre: 'Limonada',
  precio_unitario: precio,
  impuesto_tipo: 'inc' as const,
  tarifa: 800,
  cantidad: 1,
  comensal: null,
  curso: null,
  modificadores: [],
  notas: null,
  catalogo_version: 4,
  precio_canal_id: null,
})

const abrirPedido = (s: Sala, id = nuevoId()) =>
  s.registrar('PedidoAbierto', id, { canal: 'salon', mesa_id: null, comensales: 1 }).then(() => id)

const conectada = (s: Sala) => s.instantanea().conexion === 'conectado'
const sinPendientes = (s: Sala) => s.instantanea().pendientes === 0
const locales = async (s: Sala) => (await s.sync?.locales()) ?? []

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('registrar firma el evento', () => {
  it('lleva la firma de la sesión y el hub la acepta', async () => {
    const h = montarHub()
    const { sala, sesion, e } = await equipo(h, 'Ana')
    await hasta(() => conectada(sala))
    const p = nuevoId()
    const evento = await sala.registrar('PedidoAbierto', p, {
      canal: 'salon',
      mesa_id: null,
      comensales: 2,
    })

    const { firma, ...sinFirma } = evento
    expect(firma).toBe(firmarEvento(sinFirma as EventoNuevo, sesion.secreto))
    expect(evento).toMatchObject({
      sesion_id: sesion.sesionId,
      usuario_id: sesion.usuario.id,
      dispositivo_id: e.dispositivoId,
      agregado_tipo: 'pedido',
      agregado_id: p,
      version_esquema: 1,
    })
    expect(validarEventoNuevo(evento).ok).toBe(true)
    // El sobre trae la hora del dispositivo y la estimada del hub.
    expect(evento.hora_dispositivo).toBe(new Date(Date.now()).toISOString())

    await hasta(() => sinPendientes(sala))
    expect(h.hub.pedido(p)).not.toBeNull()
  })

  it('con un secreto que el hub no reconoce el evento se rechaza y no se muestra', async () => {
    const h = montarHub()
    const { sala } = await equipo(h, 'Ana', { secreto: 'secreto-equivocado' })
    await hasta(() => conectada(sala))
    const p = await abrirPedido(sala)
    // Persistir antes de mostrar: mientras el hub no responde, ya se ve.
    expect(pedidosAbiertos(await locales(sala)).map((v) => v.estado.id)).toEqual([p])

    await hasta(() => sinPendientes(sala))
    const [l] = await locales(sala)
    expect(l?.estado).toBe('rechazado')
    expect(l?.motivo).toBe('firma_invalida')
    expect(pedidosAbiertos(await locales(sala))).toEqual([])
    expect(h.hub.pedido(p)).toBeNull()
  })

  it('cada evento firmado cubre sus propios datos: la firma cambia con los datos', async () => {
    const h = montarHub()
    const { sala } = await equipo(h, 'Ana', { sinConexion: true })
    const p = nuevoId()
    const a = await sala.registrar('PedidoAbierto', p, {
      canal: 'salon',
      mesa_id: null,
      comensales: 1,
    })
    const b = await sala.registrar('PedidoAbierto', nuevoId(), {
      canal: 'salon',
      mesa_id: null,
      comensales: 1,
    })
    expect(a.firma).not.toBe(b.firma)
    expect(a.id).not.toBe(b.id)
  })
})

describe('el hub se cae a mitad de una operación', () => {
  it('cae justo después de aceptar un lote, sin que llegue la respuesta: al volver no se duplica nada', async () => {
    const h = montarHub()
    const { sala } = await equipo(h, 'Ana', { sinConexion: true })
    const p = await abrirPedido(sala)
    const ids = []
    for (let i = 0; i < 5; i++) {
      const it = item(2_000)
      await sala.registrar('ItemAgregado', p, it)
      ids.push(it.item_id)
    }
    expect(sala.instantanea().pendientes).toBe(6)

    // El hub procesa el lote y se corta antes de que la respuesta llegue; sigue caído un rato.
    h.cortarTras = (m) => {
      if (m.tipo !== 'empujar') return false
      h.caido = true
      return true
    }
    sala.simularSinConexion(false)
    await hasta(() => h.recibidos.some((m) => m.tipo === 'empujar'))
    await asentar(10)
    expect(h.hub.pedido(p)?.items).toBeDefined()
    expect(Object.keys(h.hub.pedido(p)?.items ?? {})).toHaveLength(5)
    // El dispositivo no vio la respuesta: sigue creyendo que están pendientes.
    expect(sala.instantanea().pendientes).toBe(6)
    expect(sala.instantanea().conexion).not.toBe('conectado')

    // Mientras sigue caído hay reintentos, pero espaciados (no un ciclo apretado).
    const intentos = h.aperturas
    await avanzar(10_000)
    expect(h.aperturas - intentos).toBeLessThanOrEqual(6)
    expect(sala.instantanea().pendientes).toBe(6)

    h.caido = false
    h.cortarTras = null
    await hasta(() => sinPendientes(sala))

    const confirmados = (await locales(sala)).filter((l) => l.estado === 'confirmado')
    expect(confirmados.map((l) => l.evento.secuencia)).toEqual([1, 2, 3, 4, 5, 6])
    expect(Object.keys(h.hub.pedido(p)?.items ?? {}).sort()).toEqual([...ids].sort())
    expect(pedidosAbiertos(await locales(sala))[0]?.total).toBe(10_000)
  })

  it('cae entre dos lotes de 100: los 150 eventos quedan una sola vez y en orden', async () => {
    const h = montarHub()
    const { sala } = await equipo(h, 'Ana', { sinConexion: true })
    const p = await abrirPedido(sala)
    for (let i = 0; i < 149; i++) await sala.registrar('ItemAgregado', p, item(1_000))
    expect(sala.instantanea().pendientes).toBe(150)

    let lotes = 0
    h.cortarTras = (m) => {
      if (m.tipo === 'empujar') lotes += 1
      // El primer lote llega completo y la conexión se corta antes de la respuesta.
      return m.tipo === 'empujar' && lotes === 1
    }
    sala.simularSinConexion(false)
    await hasta(() => sinPendientes(sala), 30_000)

    const hubEventos = h.hub.pedido(p)
    expect(Object.keys(hubEventos?.items ?? {})).toHaveLength(149)
    const confirmados = (await locales(sala)).filter((l) => l.estado === 'confirmado')
    expect(confirmados).toHaveLength(150)
    expect(confirmados.map((l) => l.evento.secuencia)).toEqual(
      Array.from({ length: 150 }, (_, i) => i + 1),
    )
    expect(new Set(confirmados.map((l) => l.evento.id)).size).toBe(150)
  })

  it('el hub está apagado al arrancar: lo registrado se conserva y sube cuando vuelve', async () => {
    const h = montarHub()
    h.caido = true
    const { sala } = await equipo(h, 'Ana')
    await avanzar(3_000)
    expect(sala.instantanea().conexion).not.toBe('conectado')

    const p = await abrirPedido(sala)
    await sala.registrar('ItemAgregado', p, item(5_000))
    expect(sala.instantanea().pendientes).toBe(2)
    expect(pedidosAbiertos(await locales(sala))[0]?.total).toBe(5_000)

    h.caido = false
    // La espera máxima entre reintentos es de 5 s (docs/SYNC.md).
    await hasta(() => conectada(sala) && sinPendientes(sala), 8_000)
    expect(h.hub.pedido(p)).not.toBeNull()
  })

  it('el proceso del hub se reinicia (nueva sala, misma base): el dispositivo reconecta solo', async () => {
    const h = montarHub()
    const { sala } = await equipo(h, 'Ana')
    await hasta(() => conectada(sala))
    const p = await abrirPedido(sala)
    await hasta(() => sinPendientes(sala))

    h.caido = true
    h.cortarTodo()
    expect(sala.instantanea().conexion).not.toBe('conectado')
    // Sin conexión se sigue tomando el pedido.
    await sala.registrar('ItemAgregado', p, item(3_000))
    expect(sala.instantanea().pendientes).toBe(1)

    h.caido = false
    await hasta(() => conectada(sala) && sinPendientes(sala), 8_000)
    expect(Object.keys(h.hub.pedido(p)?.items ?? {})).toHaveLength(1)
  })
})

describe('token inválido o revocado', () => {
  it('el hub no reconoce el token: queda errorHub, se detiene la conexión y no reintenta', async () => {
    const h = montarHub()
    const { sala } = await equipo(h, 'Ana', { sinToken: true })
    await hasta(() => sala.instantanea().errorHub !== null)

    expect(sala.instantanea().errorHub).toMatchObject({ codigo: 'token_invalido' })
    expect(sala.instantanea().conexion).toBe('desconectado')

    // Pasa un buen rato y no vuelve a intentarlo (cada intento solo gastaría batería y red).
    const intentos = h.aperturas
    await avanzar(60_000)
    expect(h.aperturas).toBe(intentos)
    expect(sala.instantanea().conexion).toBe('desconectado')
  })

  it('con el token inválido se puede seguir registrando: queda guardado como pendiente', async () => {
    const h = montarHub()
    const { sala } = await equipo(h, 'Ana', { sinToken: true })
    await hasta(() => sala.instantanea().errorHub !== null)
    await abrirPedido(sala)
    expect(sala.instantanea().pendientes).toBe(1)
    await avanzar(10_000)
    expect(sala.instantanea().pendientes).toBe(1)
  })

  it('app_vieja también detiene la conexión', async () => {
    const h = montarHub()
    const viejo = new Sala({
      db: (() => {
        const db = new BaseDispositivo(`resiliencia-${nuevoId()}`)
        bases.push(db)
        return db
      })(),
      abrir: (m) => {
        h.aperturas += 1
        setTimeout(() => m.alAbrir())
        return {
          enviar: (msg) => {
            if (msg.tipo === 'hola')
              setTimeout(() =>
                m.alMensaje({ tipo: 'error', codigo: 'app_vieja', mensaje: 'Actualiza la app' }),
              )
          },
          cerrar: () => {},
        }
      },
    })
    salas.push(viejo)
    await viejo.sync // sin equipo todavía
    const db = (viejo as unknown as { db: BaseDispositivo }).db
    await db.guardarAjuste('equipo', {
      dispositivoId: nuevoId(),
      token: 't',
      nombre: 'Viejo',
      tipo: 'mesero',
    })
    await viejo.cargar()
    await hasta(() => viejo.instantanea().errorHub !== null)
    expect(viejo.instantanea().errorHub).toMatchObject({ codigo: 'app_vieja' })
    const intentos = h.aperturas
    await avanzar(30_000)
    expect(h.aperturas).toBe(intentos)
  })

  it('token revocado con el equipo conectado: avisa, sigue conectado y deja de recibir el salón', async () => {
    const h = montarHub()
    const ana = await equipo(h, 'Ana')
    const beto = await equipo(h, 'Beto')
    await hasta(() => conectada(ana.sala) && conectada(beto.sala))

    // El gerente retira el equipo de Ana.
    const ahora = new Date().toISOString()
    const fila = h.tokens.get(ana.e.token) as EquipoHub
    fila.revocadoEn = ahora
    h.salaHub.revocar(ana.e.dispositivoId, ahora)
    await hasta(() => ana.sala.instantanea().errorHub !== null)
    expect(ana.sala.instantanea().errorHub?.codigo).toBe('token_revocado')
    expect(conectada(ana.sala)).toBe(true)

    // Lo que Beto hace después ya no le llega a Ana, pero a Beto sí le funciona.
    const p = await abrirPedido(beto.sala)
    await hasta(() => sinPendientes(beto.sala))
    await avanzar(2_000)
    expect(pedidosAbiertos(await locales(ana.sala))).toEqual([])
    expect(pedidosAbiertos(await locales(beto.sala)).map((v) => v.estado.id)).toEqual([p])
  })

  it('lo que el equipo retirado hace después de la revocación no entra al salón', async () => {
    const h = montarHub()
    const ana = await equipo(h, 'Ana')
    await hasta(() => conectada(ana.sala))
    const ahora = new Date().toISOString()
    ;(h.tokens.get(ana.e.token) as EquipoHub).revocadoEn = ahora
    h.salaHub.revocar(ana.e.dispositivoId, ahora)
    await hasta(() => ana.sala.instantanea().errorHub !== null)

    vi.setSystemTime(Date.now() + 5_000)
    const p = await abrirPedido(ana.sala)
    await hasta(() => sinPendientes(ana.sala))
    expect(h.hub.pedido(p)).toBeNull()
    const [l] = await locales(ana.sala)
    expect(l?.estado).toBe('rechazado')
    expect(pedidosAbiertos(await locales(ana.sala))).toEqual([])
  })
})

describe('olvidarEquipo', () => {
  it('borra credenciales y sesión, detiene la conexión y conserva los eventos guardados', async () => {
    const h = montarHub()
    const { sala, db } = await equipo(h, 'Ana', { sinToken: true })
    await hasta(() => sala.instantanea().errorHub !== null)
    await abrirPedido(sala)

    await sala.olvidarEquipo()
    const i = sala.instantanea()
    expect(i).toMatchObject({
      equipo: null,
      sesion: null,
      errorHub: null,
      conexion: 'desconectado',
    })
    expect(await db.leerAjuste('equipo')).toBeUndefined()
    expect(await db.leerAjuste('sesion')).toBeUndefined()
    // El catálogo y los eventos se quedan.
    expect(await db.leerAjuste('catalogo')).toBeDefined()
    expect(await db.eventos.count()).toBe(1)
    expect(sala.sync).toBeNull()

    const intentos = h.aperturas
    await avanzar(30_000)
    expect(h.aperturas).toBe(intentos)

    // Sin equipo no se puede crear nada ni llamar al hub.
    await expect(abrirPedido(sala)).rejects.toThrow('Sin sesión')
    await expect(sala.actualizarCatalogo()).rejects.toThrow('no está emparejado')
  })

  it('al volver a abrir la app queda sin equipo (pide emparejar)', async () => {
    const h = montarHub()
    const { sala, db } = await equipo(h, 'Ana', { sinToken: true })
    await hasta(() => sala.instantanea().errorHub !== null)
    await sala.olvidarEquipo()
    const otra = new Sala({ db, abrir: (m) => h.abrir(m) })
    salas.push(otra)
    await otra.cargar()
    expect(otra.instantanea()).toMatchObject({ cargado: true, equipo: null, sesion: null })
    expect(otra.instantanea().catalogo).not.toBeNull()
  })

  it('emparejar de nuevo conecta con el token nuevo', async () => {
    const h = montarHub()
    const { sala, db } = await equipo(h, 'Ana', { sinToken: true })
    await hasta(() => sala.instantanea().errorHub !== null)
    await sala.olvidarEquipo()

    const nuevo: EquipoHub = {
      dispositivoId: nuevoId(),
      token: nuevoId(),
      nombre: 'Ana',
      tipo: 'mesero',
      revocadoEn: null,
    }
    h.tokens.set(nuevo.token, nuevo)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe('/api/emparejar')
        // El código se normaliza: sin espacios y en mayúsculas.
        expect(JSON.parse(String(init?.body))).toEqual({ codigo: 'ABC123' })
        return new Response(
          JSON.stringify({
            dispositivo_id: nuevo.dispositivoId,
            token: nuevo.token,
            nombre: nuevo.nombre,
            tipo: nuevo.tipo,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }),
    )
    await sala.emparejar('  abc123 ')
    await hasta(() => conectada(sala))
    expect(sala.instantanea().equipo?.token).toBe(nuevo.token)
    expect(sala.instantanea().errorHub).toBeNull()
    expect(await db.leerAjuste<Equipo>('equipo')).toMatchObject({ token: nuevo.token })
  })

  // Los eventos guardados llevan el dispositivo_id del emparejamiento anterior, y el hub rechaza
  // todo evento cuyo dispositivo no sea el de la conexión. Está documentado en `olvidarEquipo`
  // (la pantalla lo advierte antes): esta prueba fija que no se pierde en silencio, queda
  // rechazado con su motivo.
  it('lo pendiente de antes de olvidar el equipo no entra con el token nuevo: queda rechazado con motivo', async () => {
    const h = montarHub()
    const { sala } = await equipo(h, 'Ana', { sinToken: true })
    await hasta(() => sala.instantanea().errorHub !== null)
    const p = await abrirPedido(sala)
    await sala.olvidarEquipo()

    const nuevo: EquipoHub = {
      dispositivoId: nuevoId(),
      token: nuevoId(),
      nombre: 'Ana',
      tipo: 'mesero',
      revocadoEn: null,
    }
    h.tokens.set(nuevo.token, nuevo)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              dispositivo_id: nuevo.dispositivoId,
              token: nuevo.token,
              nombre: 'Ana',
              tipo: 'mesero',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    )
    await sala.emparejar('ABC123')
    await hasta(() => sinPendientes(sala))
    expect(h.hub.pedido(p)).toBeNull()
    const [l] = await locales(sala)
    expect(l).toMatchObject({ estado: 'rechazado', motivo: 'dispositivo_distinto' })
  })
})

describe('sesión que vence por inactividad', () => {
  it('se cierra exactamente a los minutos configurados y avisa al hub', async () => {
    const h = montarHub()
    const { sala, sesion, db } = await equipo(h, 'Ana', {
      catalogo: catalogoDePrueba({ restaurante: { nombre: 'P', sesionInactividadMin: 10 } }),
    })
    sala.vencerSesionSiToca(sesion.ultimoUso + 10 * MIN - 1)
    expect(sala.instantanea().sesion).not.toBeNull()
    sala.vencerSesionSiToca(sesion.ultimoUso + 10 * MIN)
    expect(sala.instantanea().sesion).toBeNull()
    expect(sala.instantanea().sesionCerradaPor).toBe('inactividad')

    await asentar(10)
    expect(await db.leerAjuste('sesion')).toBeUndefined()
    const cierre = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url) === '/api/sesiones/cerrar')
    expect(cierre).toBeDefined()
    expect(JSON.parse(String(cierre?.[1]?.body))).toEqual({
      sesion_id: sesion.sesionId,
      secreto: sesion.secreto,
    })
  })

  it('sin catálogo guardado usa 30 minutos', async () => {
    const h = montarHub()
    const { sala, sesion } = await equipo(h, 'Ana', { catalogo: null })
    sala.vencerSesionSiToca(sesion.ultimoUso + 29 * MIN)
    expect(sala.instantanea().sesion).not.toBeNull()
    sala.vencerSesionSiToca(sesion.ultimoUso + 30 * MIN)
    expect(sala.instantanea().sesion).toBeNull()
  })

  it('al abrir la app con una sesión ya vencida pide el PIN de nuevo', async () => {
    const h = montarHub()
    const { sala, db } = await equipo(h, 'Ana', { haceMs: 31 * MIN })
    expect(sala.instantanea().sesion).toBeNull()
    await asentar(10)
    expect(await db.leerAjuste('sesion')).toBeUndefined()
    await expect(abrirPedido(sala)).rejects.toThrow('Sin sesión')
  })

  it('al volver a la pantalla (desbloquear el celular) revisa el vencimiento', async () => {
    const h = montarHub()
    const { sala } = await equipo(h, 'Ana')
    vi.setSystemTime(Date.now() + 45 * MIN)
    expect(sala.instantanea().sesion).not.toBeNull()
    sala.cambiarVisibilidad(false)
    expect(sala.instantanea().sesion).not.toBeNull()
    sala.cambiarVisibilidad(true)
    expect(sala.instantanea().sesion).toBeNull()
  })

  it('cada toque aplaza el cierre: con toques cada 10 minutos nunca vence', async () => {
    const h = montarHub()
    const { sala, sesion } = await equipo(h, 'Ana')
    for (let i = 1; i <= 12; i++) sala.usar(sesion.ultimoUso + i * 10 * MIN)
    expect(sala.instantanea().sesion).not.toBeNull()
    expect(sala.instantanea().sesion?.ultimoUso).toBe(sesion.ultimoUso + 120 * MIN)
    // Y pasados 30 minutos sin toques, sí.
    sala.vencerSesionSiToca(sesion.ultimoUso + 150 * MIN)
    expect(sala.instantanea().sesion).toBeNull()
  })

  it('un toque ya vencido no revive la sesión', async () => {
    const h = montarHub()
    const { sala, sesion } = await equipo(h, 'Ana')
    sala.usar(sesion.ultimoUso + 40 * MIN)
    expect(sala.instantanea().sesion).toBeNull()
    sala.usar(sesion.ultimoUso + 40 * MIN + 1)
    sala.usar(sesion.ultimoUso + 41 * MIN)
    expect(sala.instantanea().sesion).toBeNull()
    await asentar(10)
    expect(await bases[0]?.leerAjuste('sesion')).toBeUndefined()
  })

  it('salir sin conexión con el hub igual cierra la sesión aquí', async () => {
    const h = montarHub()
    const { sala, db } = await equipo(h, 'Ana')
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'))
    await sala.salir()
    expect(sala.instantanea().sesion).toBeNull()
    expect(await db.leerAjuste('sesion')).toBeUndefined()
  })

  it('registrar con la sesión ya vencida por inactividad no crea el evento', async () => {
    const h = montarHub()
    const { sala } = await equipo(h, 'Ana', { sinConexion: true })
    // La sesión sigue "abierta" en pantalla (nadie tocó nada), pero pasó más de la inactividad.
    vi.setSystemTime(Date.now() + 31 * MIN)
    expect(sala.instantanea().sesion).not.toBeNull()
    await expect(abrirPedido(sala)).rejects.toThrow('Sin sesión')
    expect(sala.instantanea().pendientes).toBe(0)
  })
})

describe('toques rápidos', () => {
  it('cientos de toques en un segundo no escriben en IndexedDB', async () => {
    const h = montarHub()
    const { sala, sesion, db } = await equipo(h, 'Ana')
    const escribir = vi.spyOn(db, 'guardarAjuste')
    for (let i = 0; i < 300; i++) sala.usar(sesion.ultimoUso + i * 3)
    expect(escribir).not.toHaveBeenCalled()
    expect(sala.instantanea().sesion?.ultimoUso).toBe(sesion.ultimoUso)
  })

  it('pasados 15 s se escribe una vez, y los toques del mismo instante no repiten la escritura', async () => {
    const h = montarHub()
    const { sala, sesion, db } = await equipo(h, 'Ana')
    const escribir = vi.spyOn(db, 'guardarAjuste')
    const t = sesion.ultimoUso + 15_000
    for (let i = 0; i < 50; i++) sala.usar(t)
    expect(escribir).toHaveBeenCalledTimes(1)
    expect(escribir).toHaveBeenCalledWith('sesion', expect.objectContaining({ ultimoUso: t }))
    await asentar(5)
    expect(await db.leerAjuste<Sesion>('sesion')).toMatchObject({ ultimoUso: t })
  })

  it('14,9 s no escribe; toques cada 10 s por dos horas mantienen viva la sesión sin escribir en cada uno', async () => {
    const h = montarHub()
    const { sala, sesion, db } = await equipo(h, 'Ana')
    sala.usar(sesion.ultimoUso + 14_999)
    const escribir = vi.spyOn(db, 'guardarAjuste')
    expect(escribir).not.toHaveBeenCalled()

    let toques = 0
    for (let t = 10_000; t <= 120 * MIN; t += 10_000) {
      sala.usar(sesion.ultimoUso + t)
      toques += 1
    }
    expect(sala.instantanea().sesion).not.toBeNull()
    expect(escribir.mock.calls.length).toBeLessThan(toques / 1.5)
    expect(escribir.mock.calls.length).toBeGreaterThan(0)
  })

  it('varios registrar a la vez guardan todo, cada evento una vez, y el hub los confirma', async () => {
    const h = montarHub()
    const { sala } = await equipo(h, 'Ana')
    await hasta(() => conectada(sala))
    const p = await abrirPedido(sala)
    const its = Array.from({ length: 12 }, () => item(1_500))
    await Promise.all(its.map((it) => sala.registrar('ItemAgregado', p, it)))

    const todos = await locales(sala)
    expect(todos).toHaveLength(13)
    expect(new Set(todos.map((l) => l.orden)).size).toBe(13)
    expect(new Set(todos.map((l) => l.evento.id)).size).toBe(13)

    await hasta(() => sinPendientes(sala))
    const hub = h.hub.pedido(p)
    expect(Object.keys(hub?.items ?? {}).sort()).toEqual(its.map((i) => i.item_id).sort())
    expect(pedidosAbiertos(await locales(sala))[0]?.total).toBe(18_000)
  })

  it('doble toque en "enviar a cocina": una sola comanda vale y los dos equipos ven lo mismo', async () => {
    const h = montarHub()
    const { sala } = await equipo(h, 'Ana')
    await hasta(() => conectada(sala))
    const p = await abrirPedido(sala)
    const it = item(8_000)
    await sala.registrar('ItemAgregado', p, it)
    await hasta(() => sinPendientes(sala))

    const envio = () => ({
      comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [it.item_id] }],
    })
    await Promise.all([
      sala.registrar('ItemsEnviados', p, envio()),
      sala.registrar('ItemsEnviados', p, envio()),
    ])
    await hasta(() => sinPendientes(sala))

    const enHub = h.hub.pedido(p)
    expect(enHub?.items[it.item_id]?.estado).toBe('enviado')
    const [vista] = pedidosAbiertos(await locales(sala))
    expect(vista?.estado.items[it.item_id]?.estado).toBe('enviado')
    expect(vista?.total).toBe(8_000)
    // El segundo envío no se pierde en silencio: o se rechazó o se aceptó como conflicto.
    const envios = (await locales(sala)).filter((l) => l.evento.tipo === 'ItemsEnviados')
    expect(envios).toHaveLength(2)
    expect(envios.every((l) => l.estado !== 'pendiente')).toBe(true)
  })
})

describe('reloj del dispositivo desfasado', () => {
  it.each([
    ['atrasado', 2 * 60 * MIN],
    ['adelantado', -2 * 60 * MIN],
  ])(
    'con el hub %s 2 h respecto al dispositivo, la hora estimada sigue la del hub',
    async (_n, desfase) => {
      const h = montarHub({ desfaseHubMs: desfase })
      const { sala } = await equipo(h, 'Ana')
      await hasta(() => conectada(sala))
      await avanzar(500)

      const evento = await sala.registrar('PedidoAbierto', nuevoId(), {
        canal: 'salon',
        mesa_id: null,
        comensales: 1,
      })
      expect(evento.hora_dispositivo).toBe(new Date(Date.now()).toISOString())
      const diferencia = Date.parse(evento.hora_estimada_hub) - Date.now()
      expect(Math.abs(diferencia - desfase)).toBeLessThan(1_000)

      await hasta(() => sinPendientes(sala))
      const [l] = await locales(sala)
      expect(l?.estado).toBe('confirmado')
    },
  )

  it('tras reabrir la app sin conexión se acuerda del desfase aprendido', async () => {
    const h = montarHub({ desfaseHubMs: 2 * 60 * MIN })
    const { sala, db } = await equipo(h, 'Ana')
    await hasta(() => conectada(sala))
    await asentar(10)
    sala.simularSinConexion(true)

    const otra = new Sala({ db, abrir: (m) => h.abrir(m) })
    salas.push(otra)
    otra.simularSinConexion(true)
    await otra.cargar()
    const evento = await otra.registrar('PedidoAbierto', nuevoId(), {
      canal: 'salon',
      mesa_id: null,
      comensales: 1,
    })
    const diferencia = Date.parse(evento.hora_estimada_hub) - Date.now()
    expect(Math.abs(diferencia - 2 * 60 * MIN)).toBeLessThan(1_000)
  })

  it('sin haber hablado nunca con el hub, la hora estimada es la del dispositivo', async () => {
    const h = montarHub({ desfaseHubMs: 2 * 60 * MIN })
    const { sala } = await equipo(h, 'Ana', { sinConexion: true })
    const evento = await sala.registrar('PedidoAbierto', nuevoId(), {
      canal: 'salon',
      mesa_id: null,
      comensales: 1,
    })
    expect(evento.hora_estimada_hub).toBe(evento.hora_dispositivo)
  })
})

describe('arranque y corte simulado', () => {
  it('cargar dos veces a la vez conecta una sola vez', async () => {
    const h = montarHub()
    const { db } = await equipo(h, 'Ana', { sinConexion: true })
    const otra = new Sala({ db, abrir: (m) => h.abrir(m) })
    salas.push(otra)
    const [a, b] = [otra.cargar(), otra.cargar()]
    expect(a).toBe(b)
    await Promise.all([a, b])
    await hasta(() => conectada(otra))
    await avanzar(2_000)
    expect(h.aperturas).toBe(1)
  })

  it('con el corte simulado las llamadas HTTP fallan como sin conexión, sin tocar la red', async () => {
    const h = montarHub()
    const { sala } = await equipo(h, 'Ana')
    await hasta(() => conectada(sala))
    sala.simularSinConexion(true)
    vi.mocked(fetch).mockClear()
    await expect(sala.actualizarCatalogo()).rejects.toMatchObject({ codigo: 'sin_conexion' })
    await expect(sala.entrar('1234')).rejects.toMatchObject({ codigo: 'sin_conexion' })
    expect(fetch).not.toHaveBeenCalled()
    expect(sala.instantanea().conexion).toBe('desconectado')
  })

  it('el latido y el pong no hacen releer la pantalla', async () => {
    const h = montarHub()
    const { sala } = await equipo(h, 'Ana')
    await hasta(() => conectada(sala))
    await avanzar(500)
    const antes = sala.instantanea().cambios
    h.salaHub.latir()
    await avanzar(500)
    expect(sala.instantanea().cambios).toBe(antes)
  })

  it('apagar y devolver la conexión varias veces seguidas deja una sola conexión viva', async () => {
    const h = montarHub()
    const { sala } = await equipo(h, 'Ana')
    await hasta(() => conectada(sala))
    for (let i = 0; i < 10; i++) {
      sala.simularSinConexion(true)
      sala.simularSinConexion(false)
    }
    await hasta(() => conectada(sala))
    const p = await abrirPedido(sala)
    await hasta(() => sinPendientes(sala))
    expect(Object.keys(h.hub.pedido(p) ?? {})).not.toHaveLength(0)
    expect((await locales(sala)).filter((l) => l.estado === 'confirmado')).toHaveLength(1)
  })
})
