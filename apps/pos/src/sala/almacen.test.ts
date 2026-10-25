import 'fake-indexeddb/auto'
import { nuevoId } from '@pos/core'
import { AlmacenDispositivoMemoria, type EventoLocal } from '@pos/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { AlmacenIndexedDb, BaseDispositivo } from './almacen'

// El almacén de IndexedDB debe portarse igual que el de memoria con el que se probó toda la
// sincronización (packages/sync).

const bases: BaseDispositivo[] = []
afterEach(async () => {
  for (const b of bases.splice(0)) await b.delete()
})

function abrir() {
  const db = new BaseDispositivo(`prueba-${nuevoId()}`)
  bases.push(db)
  return new AlmacenIndexedDb(db)
}

const local = (
  orden: number,
  campos: Partial<EventoLocal> = {},
  pedido = nuevoId(),
  relacionados: string[] = [],
): EventoLocal =>
  ({
    evento: {
      id: nuevoId(),
      tipo: 'PedidoAbierto',
      agregado_id: pedido,
      relacionados,
      datos: { canal: 'salon', mesa_id: null, comensales: 2 },
    },
    estado: 'pendiente',
    propio: true,
    orden,
    ...campos,
  }) as EventoLocal

describe('AlmacenIndexedDb', () => {
  it('se porta igual que el de memoria', async () => {
    const pedido = nuevoId()
    const otro = nuevoId()
    const eventos = [
      local(3, {}, pedido),
      local(1, { estado: 'confirmado' }, pedido),
      local(2, { propio: false, estado: 'confirmado' }, otro, [pedido]),
      local(5, {}, otro),
      local(4, { estado: 'rechazado', motivo: 'x' }, otro),
    ]
    const idb = abrir()
    const memoria = new AlmacenDispositivoMemoria()
    for (const a of [idb, memoria]) await a.guardar(eventos)

    for (const metodo of ['listar', 'pendientesPropios'] as const)
      expect(await idb[metodo]()).toEqual(await memoria[metodo]())
    expect(await idb.pendientesPropios(1)).toEqual(await memoria.pendientesPropios(1))
    expect((await idb.pendientesPropios()).map((l) => l.orden)).toEqual([3, 5])
    expect(await idb.dePedido(pedido)).toEqual(await memoria.dePedido(pedido))
    expect((await idb.dePedido(pedido)).map((l) => l.orden)).toEqual([1, 2, 3])
    const [primero] = eventos as [EventoLocal]
    expect(await idb.obtener(primero.evento.id)).toEqual(primero)
    expect(await idb.obtener(nuevoId())).toBeUndefined()
  })

  it('al confirmarse, un pendiente sale de la cola; borrar quita del todo', async () => {
    const a = abrir()
    const e = local(1)
    await a.guardar([e])
    await a.guardar([{ ...e, estado: 'confirmado' }])
    expect(await a.pendientesPropios()).toEqual([])
    expect((await a.obtener(e.evento.id))?.estado).toBe('confirmado')
    await a.borrar([e.evento.id])
    expect(await a.listar()).toEqual([])
    await a.guardar([])
  })

  it('el cursor arranca en 0 y sobrevive a cerrar y abrir la base', async () => {
    const nombre = `prueba-${nuevoId()}`
    const db = new BaseDispositivo(nombre)
    bases.push(db)
    const a = new AlmacenIndexedDb(db)
    expect(await a.cursor()).toEqual({ instancia: null, hasta: 0 })
    await a.guardarCursor({ instancia: 'h1', hasta: 7, desfaseMs: -40 })
    await a.guardar([local(1)])
    db.close()

    const otra = new BaseDispositivo(nombre)
    bases.push(otra)
    const b = new AlmacenIndexedDb(otra)
    expect(await b.cursor()).toEqual({ instancia: 'h1', hasta: 7, desfaseMs: -40 })
    expect(await b.pendientesPropios()).toHaveLength(1)
  })
})
