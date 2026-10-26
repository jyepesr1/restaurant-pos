import 'fake-indexeddb/auto'
import { newId } from '@pos/core'
import { AlmacenDispositivoMemoria, type EventoLocal } from '@pos/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { AlmacenIndexedDb, BaseDispositivo } from './almacen'

// El almacén de IndexedDB debe portarse igual que el de memoria con el que se probó toda la
// sincronización (packages/sync).

const bases: BaseDispositivo[] = []
afterEach(async () => {
  for (const b of bases.splice(0)) await b.delete()
})

function open() {
  const db = new BaseDispositivo(`prueba-${newId()}`)
  bases.push(db)
  return new AlmacenIndexedDb(db)
}

const local = (
  position: number,
  fields: Partial<EventoLocal> = {},
  order = newId(),
  related: string[] = [],
): EventoLocal =>
  ({
    event: {
      id: newId(),
      type: 'OrderOpened',
      aggregate_id: order,
      related,
      data: { channel: 'dine_in', table_id: null, guests: 2 },
    },
    status: 'pending',
    own: true,
    position,
    ...fields,
  }) as EventoLocal

describe('AlmacenIndexedDb', () => {
  it('se porta igual que el de memoria', async () => {
    const order = newId()
    const other = newId()
    const events = [
      local(3, {}, order),
      local(1, { status: 'confirmed' }, order),
      local(2, { own: false, status: 'confirmed' }, other, [order]),
      local(5, {}, other),
      local(4, { status: 'rejected', reason: 'x' }, other),
    ]
    const idb = open()
    const memory = new AlmacenDispositivoMemoria()
    for (const a of [idb, memory]) await a.guardar(events)

    for (const metodo of ['listAll', 'ownPending'] as const)
      expect(await idb[metodo]()).toEqual(await memory[metodo]())
    expect(await idb.ownPending(1)).toEqual(await memory.ownPending(1))
    expect((await idb.ownPending()).map((l) => l.position)).toEqual([3, 5])
    expect(await idb.dePedido(order)).toEqual(await memory.dePedido(order))
    expect((await idb.dePedido(order)).map((l) => l.position)).toEqual([1, 2, 3])
    const [firstOne] = events as [EventoLocal]
    expect(await idb.obtener(firstOne.event.id)).toEqual(firstOne)
    expect(await idb.obtener(newId())).toBeUndefined()
  })

  it('al confirmarse, un pendiente sale de la cola; borrar quita del todo', async () => {
    const a = open()
    const e = local(1)
    await a.guardar([e])
    await a.guardar([{ ...e, status: 'confirmed' }])
    expect(await a.ownPending()).toEqual([])
    expect((await a.obtener(e.event.id))?.status).toBe('confirmed')
    await a.erase([e.event.id])
    expect(await a.listAll()).toEqual([])
    await a.guardar([])
  })

  it('el cursor arranca en 0 y sobrevive a cerrar y abrir la base', async () => {
    const name = `prueba-${newId()}`
    const db = new BaseDispositivo(name)
    bases.push(db)
    const a = new AlmacenIndexedDb(db)
    expect(await a.cursor()).toEqual({ instancia: null, until: 0 })
    await a.guardarCursor({ instancia: 'h1', until: 7, desfaseMs: -40 })
    await a.guardar([local(1)])
    db.close()

    const another = new BaseDispositivo(name)
    bases.push(another)
    const b = new AlmacenIndexedDb(another)
    expect(await b.cursor()).toEqual({ instancia: 'h1', until: 7, desfaseMs: -40 })
    expect(await b.ownPending()).toHaveLength(1)
  })
})
