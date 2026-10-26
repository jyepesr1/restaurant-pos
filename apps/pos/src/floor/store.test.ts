import 'fake-indexeddb/auto'
import { newId } from '@pos/core'
import { type LocalEvent, MemoryDeviceStore } from '@pos/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { DeviceDatabase, IndexedDbStore } from './store'

// The IndexedDB store must behave the same as the memory one with which all of sync
// was tested (packages/sync).

const databases: DeviceDatabase[] = []
afterEach(async () => {
  for (const b of databases.splice(0)) await b.delete()
})

function open() {
  const db = new DeviceDatabase(`prueba-${newId()}`)
  databases.push(db)
  return new IndexedDbStore(db)
}

const local = (
  position: number,
  fields: Partial<LocalEvent> = {},
  order = newId(),
  related: string[] = [],
): LocalEvent =>
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
  }) as LocalEvent

describe('IndexedDbStore', () => {
  it('behaves the same as the memory one', async () => {
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
    const memory = new MemoryDeviceStore()
    for (const a of [idb, memory]) await a.save(events)

    for (const httpMethod of ['listAll', 'ownPending'] as const)
      expect(await idb[httpMethod]()).toEqual(await memory[httpMethod]())
    expect(await idb.ownPending(1)).toEqual(await memory.ownPending(1))
    expect((await idb.ownPending()).map((l) => l.position)).toEqual([3, 5])
    expect(await idb.ofOrder(order)).toEqual(await memory.ofOrder(order))
    expect((await idb.ofOrder(order)).map((l) => l.position)).toEqual([1, 2, 3])
    const [firstOne] = events as [LocalEvent]
    expect(await idb.get(firstOne.event.id)).toEqual(firstOne)
    expect(await idb.get(newId())).toBeUndefined()
  })

  it('once confirmed, a pending event leaves the queue; delete removes it entirely', async () => {
    const a = open()
    const e = local(1)
    await a.save([e])
    await a.save([{ ...e, status: 'confirmed' }])
    expect(await a.ownPending()).toEqual([])
    expect((await a.get(e.event.id))?.status).toBe('confirmed')
    await a.erase([e.event.id])
    expect(await a.listAll()).toEqual([])
    await a.save([])
  })

  it('the cursor starts at 0 and survives closing and opening the database', async () => {
    const name = `prueba-${newId()}`
    const db = new DeviceDatabase(name)
    databases.push(db)
    const a = new IndexedDbStore(db)
    expect(await a.cursor()).toEqual({ instance: null, until: 0 })
    await a.saveCursor({ instance: 'h1', until: 7, offsetMs: -40 })
    await a.save([local(1)])
    db.close()

    const another = new DeviceDatabase(name)
    databases.push(another)
    const b = new IndexedDbStore(another)
    expect(await b.cursor()).toEqual({ instance: 'h1', until: 7, offsetMs: -40 })
    expect(await b.ownPending()).toHaveLength(1)
  })
})
