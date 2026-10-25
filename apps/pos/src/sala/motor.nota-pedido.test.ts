import 'fake-indexeddb/auto'
import { type EventoNuevo, firmarEvento, nuevoId } from '@pos/core'
import { AlmacenMemoria, type Canal, type ControlAcceso, HubSync } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import { type Equipo, Sala, type Sesion } from './motor'
import { itemsVigentes, pedidosAbiertos } from './proyeccion'
import { catalogoDePrueba, datosItem } from './pruebas'

// Motor de la sala con lo nuevo de los ajustes del pedido: la nota de todo el pedido (también
// sin conexión) y el interruptor de cursos, sobre el motor real (`registrar`, IndexedDB, reductor).

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

const equipo: Equipo = {
  dispositivoId: nuevoId(),
  token: 'token-mesero',
  nombre: 'Celular',
  tipo: 'mesero',
}
const sesion = (): Sesion => ({
  sesionId: nuevoId(),
  secreto: 'secreto-ana',
  usuario: { id: nuevoId(), nombre: 'Ana', rol: 'Mesero' },
  permisos: ['tomar_pedido', 'administrar_dispositivos'],
  ultimoUso: Date.now(),
})

async function abrir(catalogo = catalogoDePrueba(), sinConexion = true) {
  const db = new BaseDispositivo(`nota-${nuevoId()}`)
  bases.push(db)
  await db.guardarAjuste('equipo', equipo)
  await db.guardarAjuste('sesion', sesion())
  await db.guardarAjuste('catalogo', catalogo)
  const sala = new Sala({ db, abrir: sinRed })
  salas.push(sala)
  if (sinConexion) sala.simularSinConexion(true)
  await sala.cargar()
  return { sala, db }
}

const locales = async (s: Sala) => (await s.sync?.locales()) ?? []
const estadoDe = async (s: Sala, id: string) =>
  pedidosAbiertos(await locales(s)).find((p) => p.estado.id === id)?.estado ?? null

async function pedidoConLimonadas(
  sala: Sala,
  cantidad: number,
  campos: Record<string, unknown> = {},
) {
  const pedido = nuevoId()
  await sala.registrar('PedidoAbierto', pedido, { canal: 'salon', mesa_id: null, comensales: 2 })
  const it = datosItem({ cantidad, ...campos })
  await sala.registrar('ItemAgregado', pedido, it)
  return { pedido, it }
}

describe('NotaPedidoCambiada sobre el motor', () => {
  it('se guarda antes de mostrarse, firmada, y la proyección la muestra sin conexión', async () => {
    const { sala } = await abrir()
    const pedido = nuevoId()
    await sala.registrar('PedidoAbierto', pedido, { canal: 'salon', mesa_id: null, comensales: 2 })
    const e = await sala.registrar('NotaPedidoCambiada', pedido, { notas: 'alérgico al maní' })
    const { firma, ...sinFirma } = e
    expect(firma).toBe(firmarEvento(sinFirma as EventoNuevo, 'secreto-ana'))
    expect(e).toMatchObject({
      tipo: 'NotaPedidoCambiada',
      agregado_tipo: 'pedido',
      agregado_id: pedido,
    })
    expect((await estadoDe(sala, pedido))?.notas).toBe('alérgico al maní')
    expect(sala.instantanea().pendientes).toBe(2)
    expect(sala.instantanea().conexion).not.toBe('conectado')
  })

  it('rechaza en el cliente una nota de más de 500 caracteres (no se guarda)', async () => {
    const { sala } = await abrir()
    const pedido = nuevoId()
    await sala.registrar('PedidoAbierto', pedido, { canal: 'salon', mesa_id: null, comensales: 2 })
    await expect(
      sala.registrar('NotaPedidoCambiada', pedido, { notas: 'a'.repeat(501) }),
    ).rejects.toThrow('Evento inválido')
    expect((await estadoDe(sala, pedido))?.notas).toBeNull()
    expect(sala.instantanea().pendientes).toBe(1)
  })

  it('quitar la nota la deja en null; el último evento manda', async () => {
    const { sala } = await abrir()
    const pedido = nuevoId()
    await sala.registrar('PedidoAbierto', pedido, { canal: 'salon', mesa_id: null, comensales: 2 })
    await sala.registrar('NotaPedidoCambiada', pedido, { notas: 'uno' })
    await sala.registrar('NotaPedidoCambiada', pedido, { notas: '  dos  ' })
    expect((await estadoDe(sala, pedido))?.notas).toBe('dos')
    await sala.registrar('NotaPedidoCambiada', pedido, { notas: null })
    expect((await estadoDe(sala, pedido))?.notas).toBeNull()
  })

  it('al reiniciar la app la nota sigue ahí (viene de IndexedDB)', async () => {
    const { sala, db } = await abrir()
    const pedido = nuevoId()
    await sala.registrar('PedidoAbierto', pedido, { canal: 'salon', mesa_id: null, comensales: 2 })
    await sala.registrar('NotaPedidoCambiada', pedido, { notas: 'todo junto' })
    sala.simularSinConexion(true)
    const otra = new Sala({ db, abrir: sinRed })
    salas.push(otra)
    otra.simularSinConexion(true)
    await otra.cargar()
    expect((await estadoDe(otra, pedido))?.notas).toBe('todo junto')
  })

  it('al volver la conexión, el hub acepta el pedido, los ítems y la nota en orden', async () => {
    const { sala } = await abrir()
    const { pedido } = await pedidoConLimonadas(sala, 1)
    await sala.registrar('NotaPedidoCambiada', pedido, { notas: 'cumpleaños' })

    // Un hub en memoria que revisa la firma, como el real.
    const acceso: ControlAcceso = {
      verificar: (_c, ev) =>
        ev.sesion_id && ev.firma === firmarEvento(ev, 'secreto-ana')
          ? { ok: true, autorizadoPorId: null, autorizacionId: null }
          : { ok: false, motivo: 'firma_invalida' },
      registrarUso: () => {},
    }
    const hub = new HubSync(new AlmacenMemoria(), {
      restauranteId: nuevoId(),
      zonaHoraria: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      instancia: 'hub-prueba',
      reloj: () => new Date().toISOString(),
      acceso,
    })
    const eventos = (await locales(sala)).map((l) => l.evento as EventoNuevo)
    const r = hub.recibirLote(
      { dispositivoId: equipo.dispositivoId, tipo: 'mesero' } as never,
      eventos,
    )
    expect(r.resultados.map((x) => x.estado)).toEqual(['confirmado', 'confirmado', 'confirmado'])
    expect(hub.pedido(pedido)?.notas).toBe('cumpleaños')
  })
})

describe('cursos apagados', () => {
  it('Sala.usarCursos llama a /api/cocina/cursos con la sesión, el token y el booleano', async () => {
    const llamadas: {
      url: string
      cuerpo: Record<string, unknown> | null
      token: string | null
    }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>
        llamadas.push({
          url,
          cuerpo: init?.body ? JSON.parse(String(init.body)) : null,
          token: headers.authorization?.replace('Bearer ', '') ?? null,
        })
        return url === '/api/catalogo'
          ? json(catalogoDePrueba({ version: 9 }))
          : new Response(null, { status: 204 })
      }),
    )
    const { sala } = await abrir(catalogoDePrueba(), false)
    await sala.usarCursos(true)
    await sala.usarCursos(false)
    const mias = llamadas.filter((l) => l.url === '/api/cocina/cursos')
    expect(mias.map((l) => l.cuerpo?.usar)).toEqual([true, false])
    expect(mias[0]).toMatchObject({
      token: 'token-mesero',
      cuerpo: { secreto: 'secreto-ana', usar: true },
    })
  })

  it('un error del hub (sin permiso) llega como error y no cambia el catálogo local', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'sin_permiso', mensaje: 'No tienes permiso' }, 403)),
    )
    const { sala } = await abrir(catalogoDePrueba(), false)
    await expect(sala.usarCursos(true)).rejects.toMatchObject({ codigo: 'sin_permiso' })
    expect(sala.instantanea().catalogo?.restaurante.usarCursos ?? false).toBe(false)
  })

  it('sin conexión con la caja, usarCursos falla con sin_conexion y no llama al hub', async () => {
    const fetchFalso = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchFalso)
    const { sala } = await abrir()
    await expect(sala.usarCursos(true)).rejects.toMatchObject({ codigo: 'sin_conexion' })
    expect(fetchFalso).not.toHaveBeenCalled()
  })

  it('un catálogo guardado de antes (sin usarCursos) se lee como cursos apagados', async () => {
    const { sala } = await abrir()
    expect(sala.instantanea().catalogo?.restaurante.usarCursos ?? false).toBe(false)
  })

  it('el catálogo con usarCursos: true sobrevive a guardarse y cargarse', async () => {
    const base = catalogoDePrueba()
    const { sala } = await abrir({
      ...base,
      restaurante: { ...base.restaurante, usarCursos: true },
    })
    expect(sala.instantanea().catalogo?.restaurante.usarCursos).toBe(true)
  })

  it('sin cursos, lo que se agrega no lleva curso y nada queda retenido ni se separa por curso', async () => {
    const { sala } = await abrir()
    const pedido = nuevoId()
    await sala.registrar('PedidoAbierto', pedido, { canal: 'salon', mesa_id: null, comensales: 2 })
    for (let i = 0; i < 4; i++)
      await sala.registrar('ItemAgregado', pedido, datosItem({ curso: null }))
    const estado = await estadoDe(sala, pedido)
    const lineas = itemsVigentes(estado as never)
    expect(lineas).toHaveLength(4)
    expect(lineas.every((i) => i.curso === null && i.estado === 'pendiente')).toBe(true)
    expect(estado?.cursosRetenidos).toEqual([])
  })
})
