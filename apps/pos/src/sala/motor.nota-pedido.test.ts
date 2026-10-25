import 'fake-indexeddb/auto'
import {
  type EventoAplicable,
  type EventoNuevo,
  firmarEvento,
  nuevoId,
  reconstruir,
  totalesPedido,
} from '@pos/core'
import { AlmacenMemoria, type Canal, type ControlAcceso, HubSync } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import { type Equipo, Sala, type Sesion } from './motor'
import { lineaIgual, unidadesPorEnviar } from './pedido'
import { itemsVigentes, pedidosAbiertos } from './proyeccion'
import { catalogoDePrueba, datosItem } from './pruebas'

// Motor de la sala con lo nuevo de los ajustes del pedido: la nota de todo el pedido, «Separar
// uno» (ItemCambiado cantidad−1 + ItemAgregado de 1) sin conexión, y el interruptor de cursos.
// «Separar uno» vive dentro de TomaPedido (React); aquí se repite su secuencia de eventos sobre
// el motor real (`registrar`, IndexedDB, reductor) para comprobar lo que queda guardado.

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

/**
 * La secuencia de `separar` en TomaPedido.tsx: leer la línea guardada, bajarla una unidad y,
 * solo si bajó de verdad, agregar la copia de 1 con la nota escrita (o null).
 */
async function separar(sala: Sala, pedidoId: string, itemId: string, nota: string | null) {
  const estado = await estadoDe(sala, pedidoId)
  const item = estado?.items[itemId]
  if (!estado || !item || item.cantidad - item.cantidadAnulada < 2) return false
  await sala.registrar('ItemCambiado', estado.id, { item_id: item.id, cantidad: item.cantidad - 1 })
  const bajo = (await estadoDe(sala, pedidoId))?.items[item.id]
  if (!bajo || bajo.cantidad !== item.cantidad - 1) return false
  const original = (await locales(sala)).find(
    (l) => l.evento.tipo === 'ItemAgregado' && l.evento.datos.item_id === item.id,
  )?.evento
  if (original?.tipo !== 'ItemAgregado') throw new Error('falta el ItemAgregado original')
  await sala.registrar('ItemAgregado', estado.id, {
    ...original.datos,
    item_id: nuevoId(),
    cantidad: 1,
    comensal: item.comensal,
    curso: item.curso,
    notas: nota,
  })
  return true
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

describe('«Separar uno» sobre el motor', () => {
  it('3 limonadas → una línea de 2 y otra de 1 con su nota; el total no cambia', async () => {
    const { sala } = await abrir()
    const { pedido, it } = await pedidoConLimonadas(sala, 3)
    const antes = await estadoDe(sala, pedido)
    expect(await separar(sala, pedido, it.item_id, 'sin hielo')).toBe(true)
    const estado = await estadoDe(sala, pedido)
    const lineas = itemsVigentes(estado as never)
    expect(lineas.map((i) => [i.cantidad, i.notas])).toEqual([
      [2, null],
      [1, 'sin hielo'],
    ])
    expect(lineas[0]?.id).toBe(it.item_id)
    expect(lineas[1]?.id).not.toBe(it.item_id)
    expect(unidadesPorEnviar(estado as never)).toBe(3)
    expect(totalesPedido(estado as never).neto).toBe(totalesPedido(antes as never).neto)
    // La copia es del mismo producto, precio, impuesto, y quedó sin enviar.
    expect(lineas[1]).toMatchObject({
      productoId: it.producto_id,
      precioUnitario: it.precio_unitario,
      impuestoTipo: it.impuesto_tipo,
      tarifa: it.tarifa,
      estado: 'pendiente',
    })
  })

  it('funciona sin conexión: quedan dos eventos pendientes, en ese orden, y se ve al instante', async () => {
    const { sala } = await abrir()
    const { pedido, it } = await pedidoConLimonadas(sala, 2)
    const antes = sala.instantanea().pendientes
    expect(sala.instantanea().conexion).not.toBe('conectado')
    await separar(sala, pedido, it.item_id, null)
    expect(sala.instantanea().pendientes).toBe(antes + 2)
    const nuevos = (await locales(sala)).slice(-2).map((l) => [l.evento.tipo, l.estado])
    expect(nuevos).toEqual([
      ['ItemCambiado', 'pendiente'],
      ['ItemAgregado', 'pendiente'],
    ])
    expect(itemsVigentes((await estadoDe(sala, pedido)) as never).map((i) => i.cantidad)).toEqual([
      1, 1,
    ])
  })

  it('sin nota, la copia nace con null (no hereda la de la línea) y la original conserva la suya', async () => {
    const { sala } = await abrir()
    const { pedido, it } = await pedidoConLimonadas(sala, 3, { notas: 'bien fría' })
    await separar(sala, pedido, it.item_id, null)
    const lineas = itemsVigentes((await estadoDe(sala, pedido)) as never)
    expect(lineas.map((i) => [i.cantidad, i.notas])).toEqual([
      [2, 'bien fría'],
      [1, null],
    ])
  })

  it('con nota nueva, la original conserva la suya y la copia lleva la escrita', async () => {
    const { sala } = await abrir()
    const { pedido, it } = await pedidoConLimonadas(sala, 3, { notas: 'bien fría' })
    await separar(sala, pedido, it.item_id, 'sin azúcar')
    const lineas = itemsVigentes((await estadoDe(sala, pedido)) as never)
    expect(lineas.map((i) => i.notas)).toEqual(['bien fría', 'sin azúcar'])
  })

  it('la copia conserva persona y curso de la línea', async () => {
    const { sala } = await abrir()
    const { pedido, it } = await pedidoConLimonadas(sala, 2, { comensal: 3, curso: 'fuerte' })
    await separar(sala, pedido, it.item_id, 'sin hielo')
    const lineas = itemsVigentes((await estadoDe(sala, pedido)) as never)
    expect(lineas.map((i) => [i.comensal, i.curso])).toEqual([
      [3, 'fuerte'],
      [3, 'fuerte'],
    ])
  })

  it('no se fusiona con la línea de origen: otro toque de la misma limonada suma a la primera, no a la copia', async () => {
    const { sala } = await abrir()
    const { pedido, it } = await pedidoConLimonadas(sala, 3)
    await separar(sala, pedido, it.item_id, null)
    const estado = await estadoDe(sala, pedido)
    // Dos líneas iguales en contenido (2 y 1, ambas sin nota): siguen separadas...
    expect(itemsVigentes(estado as never)).toHaveLength(2)
    // ...y un toque nuevo sin nota cae en la primera (la de menor orden), no en la copia.
    const otra = datosItem({ producto_id: it.producto_id })
    expect(lineaIgual(estado, otra)?.id).toBe(it.item_id)
    // Con nota, la copia nunca se usa para sumar (lineaIgual descarta toda nota).
    expect(lineaIgual(estado, datosItem({ producto_id: it.producto_id, notas: 'x' }))).toBeNull()
  })

  it('una línea de 1 no se separa y no escribe nada', async () => {
    const { sala } = await abrir()
    const { pedido, it } = await pedidoConLimonadas(sala, 1)
    const antes = sala.instantanea().pendientes
    expect(await separar(sala, pedido, it.item_id, 'x')).toBe(false)
    expect(sala.instantanea().pendientes).toBe(antes)
  })

  it('separar dos veces seguidas de 3 deja tres líneas de 1 y ni una unidad de más', async () => {
    const { sala } = await abrir()
    const { pedido, it } = await pedidoConLimonadas(sala, 3)
    expect(await separar(sala, pedido, it.item_id, 'a')).toBe(true)
    expect(await separar(sala, pedido, it.item_id, 'b')).toBe(true)
    expect(await separar(sala, pedido, it.item_id, 'c')).toBe(false)
    const estado = await estadoDe(sala, pedido)
    expect(itemsVigentes(estado as never).map((i) => [i.cantidad, i.notas])).toEqual([
      [1, null],
      [1, 'a'],
      [1, 'b'],
    ])
    expect(unidadesPorEnviar(estado as never)).toBe(3)
  })

  it('si la línea ya se envió (otro equipo), el ItemCambiado no baja la cantidad y la copia no entra', async () => {
    const { sala } = await abrir()
    const { pedido, it } = await pedidoConLimonadas(sala, 3)
    await sala.registrar('ItemsEnviados', pedido, {
      comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [it.item_id] }],
    })
    const antes = sala.instantanea().pendientes
    expect(await separar(sala, pedido, it.item_id, 'x')).toBe(false)
    // El ItemCambiado sí quedó guardado (el hub lo rechazará), pero la copia no.
    expect(sala.instantanea().pendientes).toBe(antes + 1)
    const estado = (await estadoDe(sala, pedido)) as never as {
      items: Record<string, { cantidad: number }>
    }
    expect(Object.keys(estado.items)).toHaveLength(1)
    expect(estado.items[it.item_id]?.cantidad).toBe(3)
  })

  it('después de separar y enviar, «Enviar» cuenta unidades (3), no líneas (2)', async () => {
    const { sala } = await abrir()
    const { pedido, it } = await pedidoConLimonadas(sala, 3)
    await separar(sala, pedido, it.item_id, 'sin hielo')
    const estado = await estadoDe(sala, pedido)
    expect(unidadesPorEnviar(estado as never)).toBe(3)
    expect(itemsVigentes(estado as never)).toHaveLength(2)
  })

  it('reconstruir el log guardado (sin secuencia: orden de registro) deja 3 y 1 unidades', async () => {
    const { sala } = await abrir()
    const { pedido, it } = await pedidoConLimonadas(sala, 4)
    await separar(sala, pedido, it.item_id, 'x')
    const log = (await locales(sala)).map((l) => l.evento as EventoAplicable)
    const estado = reconstruir(log, pedido)
    expect(estado?.items[it.item_id]?.cantidad).toBe(3)
    expect(
      Object.values(estado?.items ?? {})
        .map((i) => i.cantidad)
        .sort(),
    ).toEqual([1, 3])
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
