import 'fake-indexeddb/auto'
import { firmarEvento, nuevoId } from '@pos/core'
import {
  AlmacenMemoria,
  type Canal,
  type Catalogo,
  type ControlAcceso,
  HubSync,
  type Manejadores,
  SalaSync,
} from '@pos/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { BaseDispositivo } from './almacen'
import { type Equipo, Sala, type Sesion } from './motor'
import { pedidosAbiertos } from './proyeccion'

// La prueba de aceptación de la Fase 0 sin navegador: dos equipos con su IndexedDB, un hub en
// memoria que exige la firma de la sesión, pedidos hechos sin conexión y, al volver, los dos ven
// lo mismo sin duplicados.

const secretoDe = (sesionId: string) => `secreto-${sesionId}`

/** Exige que cada evento venga firmado con el secreto de su sesión. */
const accesoConFirma: ControlAcceso = {
  verificar: (_c, evento) =>
    evento.sesion_id && evento.firma === firmarEvento(evento, secretoDe(evento.sesion_id))
      ? { ok: true, autorizadoPorId: null, autorizacionId: null }
      : { ok: false, motivo: 'firma_invalida' },
  registrarUso: () => {},
}

const mesaId = nuevoId()
const catalogo: Catalogo = {
  version: 3,
  restaurante: { nombre: 'Prueba', sesionInactividadMin: 30 },
  zonas: [{ id: nuevoId(), nombre: 'Salón' }],
  mesas: [],
  estaciones: [{ id: nuevoId(), nombre: 'Cocina' }],
  categorias: [],
}

const salas: Sala[] = []
const bases: BaseDispositivo[] = []
afterEach(async () => {
  for (const s of salas.splice(0)) s.simularSinConexion(true)
  // Que terminen los trabajos de fondo (guardar el cierre de sesión) antes de borrar la base.
  await new Promise((r) => setTimeout(r, 50))
  for (const b of bases.splice(0)) await b.delete()
})

function montarHub() {
  const tokens = new Map<string, Equipo>()
  const hub = new HubSync(new AlmacenMemoria(), {
    restauranteId: nuevoId(),
    zonaHoraria: 'America/Bogota',
    inicioDiaOperativo: '06:00',
    instancia: 'hub-prueba',
    reloj: () => new Date().toISOString(),
    acceso: accesoConFirma,
  })
  const salaHub = new SalaSync(hub, (token) => {
    const e = tokens.get(token)
    return e ? { dispositivoId: e.dispositivoId, tipo: e.tipo, revocadoEn: null } : null
  })
  /** Un "WebSocket" en memoria: los mensajes viajan como JSON y llegan en otra vuelta. */
  const abrir = (m: Manejadores): Canal => {
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
  return { hub, tokens, abrir }
}

async function equipo(h: ReturnType<typeof montarHub>, nombre: string) {
  const db = new BaseDispositivo(`prueba-${nuevoId()}`)
  bases.push(db)
  const e: Equipo = { dispositivoId: nuevoId(), token: nuevoId(), nombre, tipo: 'mesero' }
  h.tokens.set(e.token, e)
  const sesionId = nuevoId()
  const sesion: Sesion = {
    sesionId,
    secreto: secretoDe(sesionId),
    usuario: { id: nuevoId(), nombre, rol: 'Mesero' },
    permisos: ['tomar_pedido'],
    ultimoUso: Date.now(),
  }
  await db.guardarAjuste('equipo', e)
  await db.guardarAjuste('sesion', sesion)
  await db.guardarAjuste('catalogo', catalogo)
  const sala = new Sala({ db, abrir: h.abrir })
  salas.push(sala)
  await sala.cargar()
  return sala
}

const item = (nombre: string, precio: number) => ({
  item_id: nuevoId(),
  producto_id: nuevoId(),
  variante_id: null,
  nombre,
  precio_unitario: precio,
  impuesto_tipo: 'inc' as const,
  tarifa: 800,
  cantidad: 1,
  comensal: null,
  curso: null,
  modificadores: [],
  notas: null,
  catalogo_version: 3,
  precio_canal_id: null,
})

async function esperar(condicion: () => Promise<boolean> | boolean, ms = 3000) {
  const fin = Date.now() + ms
  while (!(await condicion())) {
    if (Date.now() > fin) throw new Error('No se cumplió a tiempo')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const vista = async (s: Sala) =>
  pedidosAbiertos((await s.sync?.locales()) ?? []).map((p) => ({
    id: p.estado.id,
    total: p.total,
    items: Object.keys(p.estado.items).sort(),
  }))

describe('Sala (motor de la app)', () => {
  it('dos equipos sin conexión crean pedidos y al volver ven lo mismo, sin duplicados', async () => {
    const h = montarHub()
    const ana = await equipo(h, 'Ana')
    const beto = await equipo(h, 'Beto')
    await esperar(() => ana.instantanea().conexion === 'conectado')
    await esperar(() => beto.instantanea().conexion === 'conectado')

    ana.simularSinConexion(true)
    beto.simularSinConexion(true)
    expect(ana.instantanea().conexion).toBe('desconectado')

    const p1 = nuevoId()
    await ana.registrar('PedidoAbierto', p1, { canal: 'salon', mesa_id: mesaId, comensales: 2 })
    await ana.registrar('ItemAgregado', p1, item('Aperol Spritz', 32_000))
    const p2 = nuevoId()
    await beto.registrar('PedidoAbierto', p2, { canal: 'salon', mesa_id: null, comensales: 1 })
    await beto.registrar('ItemAgregado', p2, item('Pizza Margarita', 44_900))
    await beto.registrar('ItemAgregado', p2, item('Limonada', 9_900))

    // Persistir antes de mostrar: sin conexión ya se ve, como pendiente.
    expect(ana.instantanea().pendientes).toBe(2)
    expect(beto.instantanea().pendientes).toBe(3)
    expect(await vista(ana)).toEqual([expect.objectContaining({ id: p1, total: 32_000 })])

    ana.simularSinConexion(false)
    beto.simularSinConexion(false)
    await esperar(async () => {
      const [a, b] = [await vista(ana), await vista(beto)]
      return (
        ana.instantanea().pendientes === 0 &&
        beto.instantanea().pendientes === 0 &&
        a.length === 2 &&
        JSON.stringify(a) === JSON.stringify(b)
      )
    })
    expect(h.hub.pedido(p1)).not.toBeNull()
    const confirmados = (await ana.sync?.locales())?.filter((l) => l.estado === 'confirmado')
    expect(confirmados?.map((l) => l.evento.secuencia).sort()).toEqual([1, 2, 3, 4, 5])
  })

  it('sin sesión no se puede crear un evento; tras el tiempo sin uso la sesión se cierra', async () => {
    const h = montarHub()
    const s = await equipo(h, 'Ana')
    const sesion = s.instantanea().sesion as Sesion
    s.vencerSesionSiToca(sesion.ultimoUso + 29 * 60_000)
    expect(s.instantanea().sesion).not.toBeNull()
    s.vencerSesionSiToca(sesion.ultimoUso + 30 * 60_000)
    expect(s.instantanea().sesion).toBeNull()
    await expect(
      s.registrar('PedidoAbierto', nuevoId(), { canal: 'salon', mesa_id: null, comensales: 0 }),
    ).rejects.toThrow('Sin sesión')
  })

  it('un evento con datos inválidos no se guarda', async () => {
    const h = montarHub()
    const s = await equipo(h, 'Ana')
    await expect(
      s.registrar('PedidoAbierto', nuevoId(), { canal: 'salon', mesa_id: null, comensales: -1 }),
    ).rejects.toThrow('Evento inválido')
    expect(s.instantanea().pendientes).toBe(0)
  })
})
