import { newId } from '@pos/core'
import type { LocalEvent } from '@pos/sync'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openOrders } from './projection'
import { inOrder, itemData, local, opening, testCatalog } from './testing'

// The dining room with merged tables (task 1.5), rendered on the server (no browser): each table in
// the group shows the same order and says which one it is merged with.

const status: {
  catalog: ReturnType<typeof testCatalog>
  orders: ReturnType<typeof openOrders>
} = {
  catalog: testCatalog(),
  orders: [],
}

vi.mock('./context', () => ({
  useFloor: () => ({ catalog: status.catalog }),
  useOrders: () => status.orders,
}))
vi.mock('./FloorFrame', () => ({ FloorFrame: ({ children }: { children: unknown }) => children }))

const { Tables } = await import('./Tables')

const table = (name: string, zoneId: string, x: number) => ({
  id: newId(),
  zoneId,
  name,
  x,
  y: 0,
  width: 80,
  height: 80,
  rotation: 0,
  shape: 'square' as const,
  capacity: 4,
})

function diningRoom(order: (tables: Record<string, string>) => LocalEvent[]) {
  const zoneId = newId()
  const m = {
    '5': table('5', zoneId, 0),
    '6': table('6', zoneId, 100),
    '7': table('7', zoneId, 200),
  }
  status.catalog = testCatalog({
    zones: [{ id: zoneId, name: 'Salón', level: 1 }],
    tables: Object.values(m),
  })
  status.orders = openOrders(
    inOrder(order(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.id])))),
  )
  return m
}

const html = (view: 'floorPlan' | 'list') => {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k === 'pos-tables-view' ? view : null),
    setItem: () => {},
  })
  return renderToStaticMarkup(<Tables />)
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('the dining room with merged tables', () => {
  it('in the list, each table in the group says which one it is merged with, and the free one does not', () => {
    diningRoom((id) => {
      const p = newId()
      return [
        local('OrderOpened', p, { ...opening, table_id: id['5'] as string }),
        local('TablesMerged', p, { table_ids: [id['6'] as string] }),
        local('ItemAdded', p, itemData()),
      ]
    })
    const h = html('list')
    // The main one names the others and carries the total; the merged one only says which one it
    // is merged with.
    expect(h).toContain('Unida con 6')
    expect(h).toContain('Unida a la mesa 5')
    expect(h).toContain('aria-label="Mesa 6, Tomando pedido, unida a la mesa 5"')
    expect(h).not.toMatch(/Mesa 7, [^"]*unida/)
  })

  it('without merged tables «Unida» does not appear', () => {
    diningRoom((id) => {
      const p = newId()
      return [local('OrderOpened', p, { ...opening, table_id: id['5'] as string })]
    })
    expect(html('list')).not.toContain('Unida')
  })

  it('a group of three tables: the main one names the other two, and they name the main one', () => {
    diningRoom((id) => {
      const p = newId()
      return [
        local('OrderOpened', p, { ...opening, table_id: id['5'] as string }),
        local('TablesMerged', p, { table_ids: [id['6'] as string, id['7'] as string] }),
        local('ItemAdded', p, itemData()),
      ]
    })
    const h = html('list')
    expect(h).toContain('Unida con 6, 7')
    expect(h).toContain('aria-label="Mesa 6, Tomando pedido, unida a la mesa 5"')
    expect(h).toContain('aria-label="Mesa 7, Tomando pedido, unida a la mesa 5"')
    expect(h).toContain('Mesa 5 + 6 + 7')
  })

  it('after separating the tables, they no longer show as merged', () => {
    diningRoom((id) => {
      const p = newId()
      return [
        local('OrderOpened', p, { ...opening, table_id: id['5'] as string }),
        local('TablesMerged', p, { table_ids: [id['6'] as string] }),
        local('TablesSeparated', p, { table_ids: [id['6'] as string] }),
      ]
    })
    expect(html('list')).not.toContain('Unida')
  })
})
