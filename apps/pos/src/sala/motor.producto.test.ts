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
import { agotados, claveAgotado, pedidosAbiertos } from './proyeccion'

// Agotado (86) por el motor de la app: `registrar` arma el sobre del producto, lo firma, lo guarda
// antes de mostrarlo y el hub de prueba lo acepta, lo difunde o lo rechaza (tarea 1.3).

const secretoDe = (sesionId: string) => `secreto-${sesionId}`

const firmaValida = (evento: Parameters<ControlAcceso['verificar']>[1]) =>
  evento.sesion_id !== null && evento.firma === firmarEvento(evento, secretoDe(evento.sesion_id))

const accesoConFirma: ControlAcceso = {
  verificar: (_c, evento) =>
    firmaValida(evento)
      ? { ok: true, autorizadoPorId: null, autorizacionId: null }
      : { ok: false, motivo: 'firma_invalida' },
  registrarUso: () => {},
}
/** Como el real: el agotado exige permiso, y este usuario no lo tiene. */
const accesoSinPermisoDeAgotar: ControlAcceso = {
  verificar: (c, evento, pedido) =>
    evento.tipo === 'ProductoAgotado' || evento.tipo === 'ProductoDisponible'
      ? { ok: false, motivo: 'sin_permiso' }
      : accesoConFirma.verificar(c, evento, pedido),
  registrarUso: () => {},
}

const catalogo: Catalogo = {
  version: 3,
  restaurante: { nombre: 'Prueba', sesionInactividadMin: 30 },
  zonas: [{ id: nuevoId(), nombre: 'Salón', piso: 1 }],
  mesas: [],
  elementos: [],
  personal: [],
  estaciones: [{ id: nuevoId(), nombre: 'Cocina' }],
  categorias: [],
}

const salas: Sala[] = []
const bases: BaseDispositivo[] = []
afterEach(async () => {
  for (const s of salas.splice(0)) s.simularSinConexion(true)
  await new Promise((r) => setTimeout(r, 50))
  for (const b of bases.splice(0)) await b.delete()
})

function montarHub(acceso: ControlAcceso = accesoConFirma) {
  const tokens = new Map<string, Equipo>()
  const hub = new HubSync(new AlmacenMemoria(), {
    restauranteId: nuevoId(),
    zonaHoraria: 'America/Bogota',
    inicioDiaOperativo: '06:00',
    instancia: 'hub-prueba',
    reloj: () => new Date().toISOString(),
    acceso,
  })
  const salaHub = new SalaSync(hub, (token) => {
    const e = tokens.get(token)
    return e ? { dispositivoId: e.dispositivoId, tipo: e.tipo, revocadoEn: null } : null
  })
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
  const e: Equipo = { dispositivoId: nuevoId(), token: nuevoId(), nombre, tipo: 'caja' }
  h.tokens.set(e.token, e)
  const sesionId = nuevoId()
  const sesion: Sesion = {
    sesionId,
    secreto: secretoDe(sesionId),
    usuario: { id: nuevoId(), nombre, rol: 'Cajero' },
    permisos: ['tomar_pedido', 'agotar_producto'],
    ultimoUso: Date.now(),
  }
  await db.guardarAjuste('equipo', e)
  await db.guardarAjuste('sesion', sesion)
  await db.guardarAjuste('catalogo', catalogo)
  const sala = new Sala({ db, abrir: h.abrir })
  salas.push(sala)
  await sala.cargar()
  return { sala, sesion, equipo: e }
}

async function esperar(condicion: () => Promise<boolean> | boolean, ms = 3000) {
  const fin = Date.now() + ms
  while (!(await condicion())) {
    if (Date.now() > fin) throw new Error('No se cumplió a tiempo')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const locales = async (s: Sala) => (await s.sync?.locales()) ?? []
const enLinea = (s: Sala) => esperar(() => s.instantanea().conexion === 'conectado')

describe('Sala.registrar con eventos de producto', () => {
  it('arma el sobre del producto: agregado_tipo producto, su id, firmado y sin pedido', async () => {
    const h = montarHub()
    const { sala, sesion, equipo: e } = await equipo(h, 'Caja')
    const producto = nuevoId()

    const creado = await sala.registrar('ProductoAgotado', producto, {
      producto_id: producto,
      variante_id: null,
    })

    expect(creado).toMatchObject({
      tipo: 'ProductoAgotado',
      agregado_tipo: 'producto',
      agregado_id: producto,
      relacionados: [],
      sesion_id: sesion.sesionId,
      usuario_id: sesion.usuario.id,
      dispositivo_id: e.dispositivoId,
      motivo: null,
      autorizacion_id: null,
    })
    expect(creado.firma).toBe(
      firmarEvento({ ...creado, firma: undefined } as never, sesion.secreto),
    )
    const guardados = await locales(sala)
    expect(guardados).toHaveLength(1)
    expect(guardados[0]?.estado).toBe('pendiente')
    // Persistir antes de mostrar: ya se ve agotado, y ningún pedido nació.
    expect(agotados(guardados)).toEqual(new Set([producto]))
    expect(pedidosAbiertos(guardados)).toEqual([])
  })

  it('un evento de pedido sigue armándose como pedido', async () => {
    const h = montarHub()
    const { sala } = await equipo(h, 'Caja')
    const pedido = nuevoId()
    const creado = await sala.registrar('PedidoAbierto', pedido, {
      canal: 'para_llevar',
      mesa_id: null,
      comensales: 1,
    })
    expect(creado.agregado_tipo).toBe('pedido')
    expect(pedidosAbiertos(await locales(sala))).toHaveLength(1)
  })

  it('el hub de prueba lo acepta con su secuencia y el otro equipo lo recibe', async () => {
    const h = montarHub()
    const caja = await equipo(h, 'Caja')
    const mesero = await equipo(h, 'Ana')
    await enLinea(caja.sala)
    await enLinea(mesero.sala)
    const producto = nuevoId()
    const botella = nuevoId()

    await caja.sala.registrar('ProductoAgotado', producto, {
      producto_id: producto,
      variante_id: botella,
    })
    await esperar(async () => (await locales(mesero.sala)).length === 1)
    await esperar(() => caja.sala.instantanea().pendientes === 0)

    for (const s of [caja.sala, mesero.sala]) {
      const l = await locales(s)
      expect(l[0]).toMatchObject({ estado: 'confirmado' })
      expect(l[0]?.evento.secuencia).toBe(1)
      expect(agotados(l)).toEqual(new Set([claveAgotado(producto, botella)]))
    }
    expect(h.hub.pedido(producto)).toBeNull()

    // Y la reposición también les llega a los dos.
    await caja.sala.registrar('ProductoDisponible', producto, {
      producto_id: producto,
      variante_id: botella,
    })
    await esperar(async () => agotados(await locales(mesero.sala)).size === 0)
    expect(agotados(await locales(caja.sala))).toEqual(new Set())
  })

  it('sin conexión se ve agotado al instante y al volver se confirma sin duplicarse', async () => {
    const h = montarHub()
    const caja = await equipo(h, 'Caja')
    const mesero = await equipo(h, 'Ana')
    await enLinea(caja.sala)
    await enLinea(mesero.sala)
    caja.sala.simularSinConexion(true)
    const producto = nuevoId()

    await caja.sala.registrar('ProductoAgotado', producto, {
      producto_id: producto,
      variante_id: null,
    })
    expect(caja.sala.instantanea().pendientes).toBe(1)
    expect(agotados(await locales(caja.sala))).toEqual(new Set([producto]))
    // El mesero todavía no lo sabe.
    expect(agotados(await locales(mesero.sala))).toEqual(new Set())

    caja.sala.simularSinConexion(false)
    await esperar(async () => agotados(await locales(mesero.sala)).has(producto))
    await esperar(() => caja.sala.instantanea().pendientes === 0)
    expect(await locales(caja.sala)).toHaveLength(1)
    expect(await locales(mesero.sala)).toHaveLength(1)
  })

  it('si el hub lo rechaza (sin permiso), deja de verse agotado en el equipo', async () => {
    const h = montarHub(accesoSinPermisoDeAgotar)
    const caja = await equipo(h, 'Caja')
    caja.sala.simularSinConexion(true)
    const producto = nuevoId()
    await caja.sala.registrar('ProductoAgotado', producto, {
      producto_id: producto,
      variante_id: null,
    })
    expect(agotados(await locales(caja.sala))).toEqual(new Set([producto]))

    caja.sala.simularSinConexion(false)
    await esperar(async () => (await locales(caja.sala))[0]?.estado === 'rechazado')
    const [l] = await locales(caja.sala)
    expect(l?.motivo).toBe('sin_permiso')
    expect(agotados(await locales(caja.sala))).toEqual(new Set())
  })

  it('un agotado con datos inválidos no se guarda', async () => {
    const h = montarHub()
    const { sala } = await equipo(h, 'Caja')
    await expect(
      sala.registrar('ProductoAgotado', nuevoId(), {
        producto_id: 'no-es-ulid',
        variante_id: null,
      }),
    ).rejects.toThrow('Evento inválido')
    // El agregado y el producto deben ser el mismo.
    await expect(
      sala.registrar('ProductoAgotado', nuevoId(), { producto_id: nuevoId(), variante_id: null }),
    ).rejects.toThrow('Evento inválido')
    expect(sala.instantanea().pendientes).toBe(0)
    expect(await locales(sala)).toEqual([])
  })

  it('un hub que se reinicia y vuelve: el agotado propio ya confirmado sigue visible', async () => {
    const h = montarHub()
    const caja = await equipo(h, 'Caja')
    await enLinea(caja.sala)
    const producto = nuevoId()
    await caja.sala.registrar('ProductoAgotado', producto, {
      producto_id: producto,
      variante_id: null,
    })
    await esperar(() => caja.sala.instantanea().pendientes === 0)

    caja.sala.simularSinConexion(true)
    caja.sala.simularSinConexion(false)
    await enLinea(caja.sala)
    expect(agotados(await locales(caja.sala))).toEqual(new Set([producto]))
    expect(await locales(caja.sala)).toHaveLength(1)
  })
})
