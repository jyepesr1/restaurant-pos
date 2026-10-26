import { newId } from '@pos/core'
import type { EventoLocal } from '@pos/sync'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pedidosAbiertos } from './proyeccion'
import { catalogoDePrueba, datosItem, inOrder, local, opening } from './pruebas'

// El salón con mesas unidas (tarea 1.5), renderizado en el servidor (sin navegador): cada mesa del
// grupo muestra el mismo pedido y dice con cuál está unida.

const status: {
  catalog: ReturnType<typeof catalogoDePrueba>
  orders: ReturnType<typeof pedidosAbiertos>
} = {
  catalog: catalogoDePrueba(),
  orders: [],
}

vi.mock('./contexto', () => ({
  useSala: () => ({ catalog: status.catalog }),
  usePedidos: () => status.orders,
}))
vi.mock('./MarcoSala', () => ({ MarcoSala: ({ children }: { children: unknown }) => children }))

const { Mesas } = await import('./Mesas')

const table = (name: string, zonaId: string, x: number) => ({
  id: newId(),
  zonaId,
  name,
  x,
  y: 0,
  width: 80,
  height: 80,
  rotation: 0,
  shape: 'square' as const,
  capacity: 4,
})

function diningRoom(order: (tables: Record<string, string>) => EventoLocal[]) {
  const zonaId = newId()
  const m = {
    '5': table('5', zonaId, 0),
    '6': table('6', zonaId, 100),
    '7': table('7', zonaId, 200),
  }
  status.catalog = catalogoDePrueba({
    zones: [{ id: zonaId, name: 'Salón', level: 1 }],
    tables: Object.values(m),
  })
  status.orders = pedidosAbiertos(
    inOrder(order(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.id])))),
  )
  return m
}

const html = (vista: 'floorPlan' | 'list') => {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k === 'pos-tables-view' ? vista : null),
    setItem: () => {},
  })
  return renderToStaticMarkup(<Mesas />)
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('el salón con mesas unidas', () => {
  it('en la lista, cada mesa del grupo dice con cuál está unida y la libre no', () => {
    diningRoom((id) => {
      const p = newId()
      return [
        local('OrderOpened', p, { ...opening, table_id: id['5'] as string }),
        local('TablesMerged', p, { table_ids: [id['6'] as string] }),
        local('ItemAdded', p, datosItem()),
      ]
    })
    const h = html('list')
    // La principal nombra las otras y lleva el total; la unida solo dice a cuál está unida.
    expect(h).toContain('Unida con 6')
    expect(h).toContain('Unida a la mesa 5')
    expect(h).toContain('aria-label="Mesa 6, Tomando pedido, unida a la mesa 5"')
    expect(h).not.toMatch(/Mesa 7, [^"]*unida/)
  })

  it('sin mesas unidas no aparece «Unida»', () => {
    diningRoom((id) => {
      const p = newId()
      return [local('OrderOpened', p, { ...opening, table_id: id['5'] as string })]
    })
    expect(html('list')).not.toContain('Unida')
  })

  it('un grupo con tres mesas: la principal nombra las otras dos, y ellas a la principal', () => {
    diningRoom((id) => {
      const p = newId()
      return [
        local('OrderOpened', p, { ...opening, table_id: id['5'] as string }),
        local('TablesMerged', p, { table_ids: [id['6'] as string, id['7'] as string] }),
        local('ItemAdded', p, datosItem()),
      ]
    })
    const h = html('list')
    expect(h).toContain('Unida con 6, 7')
    expect(h).toContain('aria-label="Mesa 6, Tomando pedido, unida a la mesa 5"')
    expect(h).toContain('aria-label="Mesa 7, Tomando pedido, unida a la mesa 5"')
    expect(h).toContain('Mesa 5 + 6 + 7')
  })

  it('tras separar las mesas, ya no se ven unidas', () => {
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
