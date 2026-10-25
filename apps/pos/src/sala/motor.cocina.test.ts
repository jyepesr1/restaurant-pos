import 'fake-indexeddb/auto'
import { nuevoId } from '@pos/core'
import {
  AlmacenMemoria,
  type Canal,
  type ControlAcceso,
  type EstadoImpresora,
  HubSync,
  type Manejadores,
  SalaSync,
} from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import { type Equipo, Sala, type Sesion } from './motor'
import { catalogoDePrueba } from './pruebas'

// El motor de la app con la cocina (ADR-015): convertir un equipo en pantalla, que una pantalla no
// venza por inactividad, las llamadas de «Cocina e impresoras» y el aviso de las impresoras.

const salas: Sala[] = []
const bases: BaseDispositivo[] = []
afterEach(async () => {
  for (const s of salas.splice(0)) s.simularSinConexion(true)
  vi.unstubAllGlobals()
  await new Promise((r) => setTimeout(r, 20))
  for (const b of bases.splice(0)) await b.delete()
})

const sinRed = (): Canal => ({ enviar: () => {}, cerrar: () => {} })
const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })

interface Llamada {
  url: string
  metodo: string
  cuerpo: Record<string, unknown> | null
  token: string | null
}

/** El hub como un `fetch` falso: anota cada llamada y responde lo que diga `responder`. */
function hubFalso(responder: (llamada: Llamada) => Response) {
  const llamadas: Llamada[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const llamada: Llamada = {
        url,
        metodo: init?.method ?? 'GET',
        cuerpo: init?.body ? JSON.parse(String(init.body)) : null,
        token: headers.authorization?.replace('Bearer ', '') ?? null,
      }
      llamadas.push(llamada)
      if (url === '/api/catalogo') return json(catalogoDePrueba({ version: 9 }))
      return responder(llamada)
    }),
  )
  return llamadas
}

const caja: Equipo = { dispositivoId: nuevoId(), token: 'token-caja', nombre: 'Caja', tipo: 'caja' }
const sesionAdmin = (): Sesion => ({
  sesionId: nuevoId(),
  secreto: 'secreto-admin',
  usuario: { id: nuevoId(), nombre: 'Administrador', rol: 'Administrador' },
  permisos: ['administrar_dispositivos', 'tomar_pedido'],
  ultimoUso: Date.now(),
})

/** Una sala con ese equipo y esa sesión ya guardados, sin red. */
async function abrir(equipo: Equipo = caja, sesion: Sesion | null = sesionAdmin()) {
  const db = new BaseDispositivo(`prueba-${nuevoId()}`)
  bases.push(db)
  await db.guardarAjuste('equipo', equipo)
  if (sesion) await db.guardarAjuste('sesion', sesion)
  await db.guardarAjuste('catalogo', catalogoDePrueba())
  const sala = new Sala({ db, abrir: sinRed })
  salas.push(sala)
  await sala.cargar()
  return { sala, db, sesion }
}

const respuestaPantalla = () => ({
  sesion_id: nuevoId(),
  secreto: 'secreto-pantalla',
  usuario: { id: nuevoId(), nombre: 'Cocina', rol: 'Pantalla de cocina' },
  permisos: ['agotar_producto', 'marcar_preparacion'],
  tipo: 'kds',
})

describe('Sala.convertirEnPantalla', () => {
  it('manda la sesión del administrador, el nombre y las estaciones, con el token del equipo', async () => {
    const llamadas = hubFalso(() => json(respuestaPantalla(), 201))
    const { sala, sesion } = await abrir()
    await sala.convertirEnPantalla('Cocina', ['E-COCINA', 'E-BARRA'])
    const pedido = llamadas.find((l) => l.url === '/api/pantallas')
    expect(pedido).toMatchObject({
      metodo: 'POST',
      token: 'token-caja',
      cuerpo: {
        sesion_id: sesion?.sesionId,
        secreto: 'secreto-admin',
        nombre: 'Cocina',
        estacion_ids: ['E-COCINA', 'E-BARRA'],
      },
    })
  })

  it('guarda el equipo como kds, con su nombre nuevo, y lo recuerda tras reiniciar', async () => {
    hubFalso(() => json(respuestaPantalla(), 201))
    const { sala, db } = await abrir()
    await sala.convertirEnPantalla('Cocina caliente', ['E-COCINA'])
    const esperado = { ...caja, tipo: 'kds', nombre: 'Cocina caliente' }
    expect(sala.instantanea().equipo).toEqual(esperado)
    expect(await db.leerAjuste<Equipo>('equipo')).toEqual(esperado)
    const reabierta = new Sala({ db, abrir: sinRed })
    salas.push(reabierta)
    await reabierta.cargar()
    expect(reabierta.instantanea().equipo).toEqual(esperado)
  })

  it('cambia la sesión del administrador por la de la pantalla, guardada y sin error de inactividad', async () => {
    const r = respuestaPantalla()
    hubFalso(() => json(r, 201))
    const { sala, db } = await abrir()
    const antes = Date.now()
    await sala.convertirEnPantalla('Cocina', ['E-COCINA'])
    const sesion = sala.instantanea().sesion
    expect(sesion).toMatchObject({
      sesionId: r.sesion_id,
      secreto: 'secreto-pantalla',
      usuario: r.usuario,
      permisos: ['agotar_producto', 'marcar_preparacion'],
    })
    expect(sesion?.ultimoUso).toBeGreaterThanOrEqual(antes)
    expect(await db.leerAjuste<Sesion>('sesion')).toEqual(sesion)
    expect(sala.instantanea().sesionCerradaPor).toBeNull()
  })

  it('vuelve a pedir la carta al terminar', async () => {
    const llamadas = hubFalso(() => json(respuestaPantalla(), 201))
    const { sala } = await abrir()
    const antes = llamadas.filter((l) => l.url === '/api/catalogo').length
    await sala.convertirEnPantalla('Cocina', ['E-COCINA'])
    expect(llamadas.filter((l) => l.url === '/api/catalogo').length).toBeGreaterThan(antes)
    expect(sala.instantanea().catalogo?.version).toBe(9)
  })

  it('si la carta falla después, igual queda convertida', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/pantallas') return json(respuestaPantalla(), 201)
        throw new TypeError('Failed to fetch')
      }),
    )
    const { sala } = await abrir()
    await expect(sala.convertirEnPantalla('Cocina', ['E-COCINA'])).resolves.toBeUndefined()
    expect(sala.instantanea().equipo?.tipo).toBe('kds')
  })

  it.each([
    ['sin permiso (403)', 403, 'sin_permiso'],
    ['datos inválidos (400)', 400, 'datos_invalidos'],
  ])('si el hub dice %s, el equipo y la sesión quedan como estaban', async (_, status, error) => {
    hubFalso(() => json({ error, mensaje: 'No se pudo' }, status))
    const { sala, db, sesion } = await abrir()
    await expect(sala.convertirEnPantalla('Cocina', ['E-COCINA'])).rejects.toMatchObject({
      codigo: error,
      message: 'No se pudo',
    })
    expect(sala.instantanea().equipo).toEqual(caja)
    expect(sala.instantanea().sesion).toEqual(sesion)
    expect(await db.leerAjuste<Equipo>('equipo')).toEqual(caja)
    expect(await db.leerAjuste<Sesion>('sesion')).toEqual(sesion)
  })

  it('sin conexión con la caja no cambia nada', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const { sala, sesion } = await abrir()
    await expect(sala.convertirEnPantalla('Cocina', ['E-COCINA'])).rejects.toMatchObject({
      codigo: 'sin_conexion',
    })
    expect(sala.instantanea().equipo).toEqual(caja)
    expect(sala.instantanea().sesion).toEqual(sesion)
  })

  it('sin sesión no llama al hub', async () => {
    const llamadas = hubFalso(() => json(respuestaPantalla(), 201))
    const { sala } = await abrir(caja, null)
    await expect(sala.convertirEnPantalla('Cocina', ['E-COCINA'])).rejects.toThrow('Sin sesión')
    expect(llamadas.filter((l) => l.url === '/api/pantallas')).toEqual([])
  })

  it('si el hub dice que la sesión ya no vale, se cierra la sesión local', async () => {
    hubFalso(() => json({ error: 'sesion_invalida', mensaje: 'La sesión se cerró' }, 401))
    const { sala } = await abrir()
    await expect(sala.convertirEnPantalla('Cocina', ['E-COCINA'])).rejects.toMatchObject({
      codigo: 'sesion_invalida',
    })
    expect(sala.instantanea().sesion).toBeNull()
    expect(sala.instantanea().equipo).toEqual(caja)
  })
})

describe('la pantalla de cocina no vence por inactividad', () => {
  const UN_DIA = 24 * 60 * 60_000

  it('un equipo kds conserva su sesión aunque pasen días sin uso', async () => {
    const { sala } = await abrir({ ...caja, tipo: 'kds' })
    const sesion = sala.instantanea().sesion as Sesion
    sala.vencerSesionSiToca(sesion.ultimoUso + 30 * 60_000)
    sala.vencerSesionSiToca(sesion.ultimoUso + 3 * UN_DIA)
    await new Promise((r) => setTimeout(r, 20))
    expect(sala.instantanea().sesion).toEqual(sesion)
    expect(sala.instantanea().sesionCerradaPor).toBeNull()
  })

  it('un equipo común sí vence al pasar el tiempo (control de la prueba anterior)', async () => {
    const { sala } = await abrir({ ...caja, tipo: 'mesero' })
    const sesion = sala.instantanea().sesion as Sesion
    sala.vencerSesionSiToca(sesion.ultimoUso + 29 * 60_000)
    expect(sala.instantanea().sesion).not.toBeNull()
    sala.vencerSesionSiToca(sesion.ultimoUso + 30 * 60_000)
    await new Promise((r) => setTimeout(r, 20))
    expect(sala.instantanea().sesion).toBeNull()
    expect(sala.instantanea().sesionCerradaPor).toBe('inactividad')
  })

  it('una caja tampoco es una pantalla: vence igual', async () => {
    const { sala } = await abrir({ ...caja, tipo: 'caja' })
    const sesion = sala.instantanea().sesion as Sesion
    sala.vencerSesionSiToca(sesion.ultimoUso + UN_DIA)
    await new Promise((r) => setTimeout(r, 20))
    expect(sala.instantanea().sesion).toBeNull()
  })

  it('al reabrir la app con la sesión de ayer, la pantalla sigue abierta (no pide PIN)', async () => {
    const vieja: Sesion = { ...sesionAdmin(), ultimoUso: Date.now() - 2 * UN_DIA }
    const { sala } = await abrir({ ...caja, tipo: 'kds' }, vieja)
    expect(sala.instantanea().sesion).toEqual(vieja)
  })

  it('al reabrir la app, un equipo común con sesión de ayer ya no la tiene', async () => {
    const vieja: Sesion = { ...sesionAdmin(), ultimoUso: Date.now() - 2 * UN_DIA }
    const { sala } = await abrir({ ...caja, tipo: 'mesero' }, vieja)
    await new Promise((r) => setTimeout(r, 20))
    expect(sala.instantanea().sesion).toBeNull()
  })

  it('un kds con una carta que dice 1 minuto de inactividad tampoco vence', async () => {
    const db = new BaseDispositivo(`prueba-${nuevoId()}`)
    bases.push(db)
    await db.guardarAjuste('equipo', { ...caja, tipo: 'kds' })
    const sesion = sesionAdmin()
    await db.guardarAjuste('sesion', sesion)
    await db.guardarAjuste(
      'catalogo',
      catalogoDePrueba({ restaurante: { nombre: 'P', sesionInactividadMin: 1 } }),
    )
    const sala = new Sala({ db, abrir: sinRed })
    salas.push(sala)
    await sala.cargar()
    sala.vencerSesionSiToca(sesion.ultimoUso + 60 * 60_000)
    expect(sala.instantanea().sesion).toEqual(sesion)
  })
})

describe('llamadas de «Cocina e impresoras»', () => {
  const impresora = {
    nombre: 'Cocina',
    conexion: 'red' as const,
    direccion: '192.168.1.50',
    puerto: 9100,
    ancho: 80 as const,
    pagina_codigos: 'pc850' as const,
    respaldo_id: null,
    estacion_ids: ['E-COCINA'],
    activo: true,
  }

  it.each([
    ['configuracionCocina', (s: Sala) => s.configuracionCocina(), '/api/cocina/configuracion', {}],
    [
      'guardarImpresora',
      (s: Sala) => s.guardarImpresora(impresora),
      '/api/impresoras',
      { impresora },
    ],
    [
      'probarImpresora',
      (s: Sala) => s.probarImpresora('ID-IMP'),
      '/api/impresoras/prueba',
      { impresora_id: 'ID-IMP' },
    ],
    ['pendientesImpresion', (s: Sala) => s.pendientesImpresion(), '/api/impresion/pendientes', {}],
    [
      'descartarTrabajo',
      (s: Sala) => s.descartarTrabajo('ID-TRAB'),
      '/api/impresion/descartar',
      { trabajo_id: 'ID-TRAB' },
    ],
    [
      'estacionesDePantalla',
      (s: Sala) => s.estacionesDePantalla('ID-DISP', ['E-COCINA']),
      '/api/pantallas/estaciones',
      { dispositivo_id: 'ID-DISP', estacion_ids: ['E-COCINA'] },
    ],
    [
      'tiemposCocina',
      (s: Sala) => s.tiemposCocina(8, 16),
      '/api/cocina/tiempos',
      { amarillo: 8, rojo: 16 },
    ],
  ])('%s llama a %s con la sesión y el token del equipo', async (_, llamar, url, extra) => {
    const llamadas = hubFalso(() => json({ id: 'ID', trabajo_id: 'T' }))
    const { sala, sesion } = await abrir()
    await llamar(sala)
    const l = llamadas.find((x) => x.url === url)
    expect(l).toMatchObject({
      metodo: 'POST',
      token: 'token-caja',
      cuerpo: { sesion_id: sesion?.sesionId, secreto: 'secreto-admin', ...extra },
    })
  })

  it('guardarImpresora devuelve el id que dio el hub', async () => {
    hubFalso(() => json({ id: 'ID-NUEVA' }))
    const { sala } = await abrir()
    await expect(sala.guardarImpresora(impresora)).resolves.toBe('ID-NUEVA')
  })

  it('un error del hub llega con su mensaje; una sesión inválida cierra la sesión', async () => {
    hubFalso(() => json({ error: 'datos_invalidos', mensaje: 'Esa estación no existe' }, 400))
    const { sala } = await abrir()
    await expect(sala.guardarImpresora(impresora)).rejects.toMatchObject({
      codigo: 'datos_invalidos',
      message: 'Esa estación no existe',
    })
    expect(sala.instantanea().sesion).not.toBeNull()
    hubFalso(() => json({ error: 'sesion_invalida', mensaje: 'Vuelve a entrar' }, 401))
    await expect(sala.tiemposCocina(1, 2)).rejects.toMatchObject({ codigo: 'sesion_invalida' })
    expect(sala.instantanea().sesion).toBeNull()
  })

  it('sin sesión ninguna llamada sale', async () => {
    const llamadas = hubFalso(() => json({}))
    const { sala } = await abrir(caja, null)
    await expect(sala.configuracionCocina()).rejects.toThrow('Sin sesión')
    await expect(sala.tiemposCocina(1, 2)).rejects.toThrow('Sin sesión')
    expect(llamadas.filter((l) => l.url.startsWith('/api/cocina'))).toEqual([])
  })
})

// ── Aviso de impresoras y hora del hub, con un hub de verdad ─────────────

const accesoLibre: ControlAcceso = {
  verificar: () => ({ ok: true, autorizadoPorId: null, autorizacionId: null }),
  registrarUso: () => {},
}

function montarHub(desfaseHubMs = 0) {
  const tokens = new Map<string, Equipo>()
  const hub = new HubSync(new AlmacenMemoria(), {
    restauranteId: nuevoId(),
    zonaHoraria: 'America/Bogota',
    inicioDiaOperativo: '06:00',
    instancia: 'hub-prueba',
    reloj: () => new Date(Date.now() + desfaseHubMs).toISOString(),
    acceso: accesoLibre,
  })
  const salaHub = new SalaSync(hub, (token) => {
    const e = tokens.get(token)
    return e ? { dispositivoId: e.dispositivoId, tipo: e.tipo, revocadoEn: null } : null
  })
  const abrirCanal = (m: Manejadores): Canal => {
    let enlace: ReturnType<SalaSync['conectar']> | null = null
    setTimeout(() => {
      enlace = salaHub.conectar((msg) => {
        const copia = JSON.parse(JSON.stringify(msg))
        setTimeout(() => enlace && m.alMensaje(copia))
      })
      m.alAbrir()
    })
    return {
      enviar: (msg) => enlace?.recibir(JSON.parse(JSON.stringify(msg))),
      cerrar: () => {
        enlace?.cerrar()
        enlace = null
      },
    }
  }
  return { hub, tokens, salaHub, abrirCanal }
}

async function conectada(h: ReturnType<typeof montarHub>, equipo: Equipo = caja) {
  h.tokens.set(equipo.token, equipo)
  const db = new BaseDispositivo(`prueba-${nuevoId()}`)
  bases.push(db)
  await db.guardarAjuste('equipo', equipo)
  await db.guardarAjuste('sesion', sesionAdmin())
  await db.guardarAjuste('catalogo', catalogoDePrueba())
  const sala = new Sala({ db, abrir: h.abrirCanal })
  salas.push(sala)
  await sala.cargar()
  return sala
}

async function esperar(condicion: () => boolean, ms = 3000) {
  const fin = Date.now() + ms
  while (!condicion()) {
    if (Date.now() > fin) throw new Error('No se cumplió a tiempo')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Espera a que la sala termine de procesar lo que traía (el contador de cambios deja de subir). */
async function asentar(sala: Sala) {
  let ultimo = -1
  let quietos = 0
  while (quietos < 4) {
    await sala.sync?.listo()
    await new Promise((r) => setTimeout(r, 25))
    const ahora = sala.instantanea().cambios
    quietos = ahora === ultimo ? quietos + 1 : 0
    ultimo = ahora
  }
}

const estados = (...nombres: string[]): EstadoImpresora[] =>
  nombres.map((nombre, i) => ({
    id: nuevoId(),
    nombre,
    estado: i === 0 ? 'falla' : 'lista',
    error: i === 0 ? 'La impresora no responde' : null,
    pendientes: i === 0 ? 2 : 0,
  }))

describe('mensaje «impresoras»', () => {
  it('la instantánea empieza vacía', async () => {
    const { sala } = await abrir()
    expect(sala.instantanea().impresoras).toEqual([])
  })

  it('actualiza la instantánea cada vez que el hub avisa, y avisa a la pantalla', async () => {
    const h = montarHub()
    const sala = await conectada(h)
    await esperar(() => sala.instantanea().conexion === 'conectado')
    let avisos = 0
    sala.suscribir(() => {
      avisos += 1
    })
    const primero = estados('Barra', 'Cocina')
    h.salaHub.avisarImpresoras(primero)
    await esperar(() => sala.instantanea().impresoras.length === 2)
    expect(sala.instantanea().impresoras).toEqual(primero)
    expect(avisos).toBeGreaterThan(0)

    const sano = primero.map((e) => ({
      ...e,
      estado: 'lista' as const,
      error: null,
      pendientes: 0,
    }))
    h.salaHub.avisarImpresoras(sano)
    await esperar(() => sala.instantanea().impresoras[0]?.estado === 'lista')
    expect(sala.instantanea().impresoras).toEqual(sano)

    h.salaHub.avisarImpresoras([])
    await esperar(() => sala.instantanea().impresoras.length === 0)
  })

  it('un equipo que se conecta después recibe el último estado', async () => {
    const h = montarHub()
    const ultimo = estados('Barra')
    h.salaHub.avisarImpresoras(ultimo)
    const sala = await conectada(h)
    await esperar(() => sala.instantanea().impresoras.length === 1)
    expect(sala.instantanea().impresoras).toEqual(ultimo)
  })

  it('el aviso no cambia lo guardado ni los pendientes del equipo', async () => {
    const h = montarHub()
    const sala = await conectada(h)
    await esperar(() => sala.instantanea().conexion === 'conectado')
    await asentar(sala)
    const antes = { pendientes: sala.instantanea().pendientes, cambios: sala.instantanea().cambios }
    h.salaHub.avisarImpresoras(estados('Cocina'))
    await esperar(() => sala.instantanea().impresoras.length === 1)
    expect(sala.instantanea().pendientes).toBe(antes.pendientes)
    expect(sala.instantanea().cambios).toBe(antes.cambios)
    expect(await sala.sync?.locales()).toEqual([])
  })

  it('quien está sin conexión conserva el último estado conocido', async () => {
    const h = montarHub()
    const sala = await conectada(h)
    await esperar(() => sala.instantanea().conexion === 'conectado')
    const ultimo = estados('Cocina')
    h.salaHub.avisarImpresoras(ultimo)
    await esperar(() => sala.instantanea().impresoras.length === 1)
    sala.simularSinConexion(true)
    expect(sala.instantanea().impresoras).toEqual(ultimo)
  })
})

describe('Sala.ahoraHub', () => {
  it('sin conexión usa la hora del equipo', async () => {
    const { sala } = await abrir()
    expect(sala.ahoraHub(123_456)).toBe(123_456)
  })

  it('con el hub adelantado 5 minutos, la hora del hub va 5 minutos adelante de la del equipo', async () => {
    const h = montarHub(5 * 60_000)
    const sala = await conectada(h)
    await esperar(() => Math.abs(sala.ahoraHub() - Date.now() - 5 * 60_000) < 2000)
    expect(sala.ahoraHub() - Date.now()).toBeGreaterThan(5 * 60_000 - 2000)
  })

  it('con el equipo adelantado respecto al hub, la hora del hub va atrás', async () => {
    const h = montarHub(-3 * 60_000)
    const sala = await conectada(h)
    await esperar(() => Math.abs(sala.ahoraHub() - Date.now() + 3 * 60_000) < 2000)
    expect(sala.ahoraHub() - Date.now()).toBeLessThan(-3 * 60_000 + 2000)
  })
})
