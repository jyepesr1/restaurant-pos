import { nuevoId } from '@pos/core'
import type { EventoLocal } from '@pos/sync'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pedidosAbiertos } from './proyeccion'
import { apertura, catalogoDePrueba, datosItem, enOrden, local } from './pruebas'

// El salón con mesas unidas (tarea 1.5), renderizado en el servidor (sin navegador): cada mesa del
// grupo muestra el mismo pedido y dice con cuál está unida.

const estado: {
  catalogo: ReturnType<typeof catalogoDePrueba>
  pedidos: ReturnType<typeof pedidosAbiertos>
} = {
  catalogo: catalogoDePrueba(),
  pedidos: [],
}

vi.mock('./contexto', () => ({
  useSala: () => ({ catalogo: estado.catalogo }),
  usePedidos: () => estado.pedidos,
}))
vi.mock('./MarcoSala', () => ({ MarcoSala: ({ children }: { children: unknown }) => children }))

const { Mesas } = await import('./Mesas')

const mesa = (nombre: string, zonaId: string, x: number) => ({
  id: nuevoId(),
  zonaId,
  nombre,
  x,
  y: 0,
  ancho: 80,
  alto: 80,
  rotacion: 0,
  forma: 'cuadrada' as const,
  capacidad: 4,
})

function salon(pedido: (mesas: Record<string, string>) => EventoLocal[]) {
  const zonaId = nuevoId()
  const m = { '5': mesa('5', zonaId, 0), '6': mesa('6', zonaId, 100), '7': mesa('7', zonaId, 200) }
  estado.catalogo = catalogoDePrueba({
    zonas: [{ id: zonaId, nombre: 'Salón', piso: 1 }],
    mesas: Object.values(m),
  })
  estado.pedidos = pedidosAbiertos(
    enOrden(pedido(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.id])))),
  )
  return m
}

const html = (vista: 'plano' | 'lista') => {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k === 'pos-vista-mesas' ? vista : null),
    setItem: () => {},
  })
  return renderToStaticMarkup(<Mesas />)
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('el salón con mesas unidas', () => {
  it('en la lista, cada mesa del grupo dice con cuál está unida y la libre no', () => {
    salon((id) => {
      const p = nuevoId()
      return [
        local('PedidoAbierto', p, { ...apertura, mesa_id: id['5'] as string }),
        local('MesasUnidas', p, { mesa_ids: [id['6'] as string] }),
        local('ItemAgregado', p, datosItem()),
      ]
    })
    const h = html('lista')
    // La principal nombra las otras y lleva el total; la unida solo dice a cuál está unida.
    expect(h).toContain('Unida con 6')
    expect(h).toContain('Unida a la mesa 5')
    expect(h).toContain('aria-label="Mesa 6, Tomando pedido, unida a la mesa 5"')
    expect(h).not.toMatch(/Mesa 7, [^"]*unida/)
  })

  it('sin mesas unidas no aparece «Unida»', () => {
    salon((id) => {
      const p = nuevoId()
      return [local('PedidoAbierto', p, { ...apertura, mesa_id: id['5'] as string })]
    })
    expect(html('lista')).not.toContain('Unida')
  })

  it('un grupo con tres mesas: la principal nombra las otras dos, y ellas a la principal', () => {
    salon((id) => {
      const p = nuevoId()
      return [
        local('PedidoAbierto', p, { ...apertura, mesa_id: id['5'] as string }),
        local('MesasUnidas', p, { mesa_ids: [id['6'] as string, id['7'] as string] }),
        local('ItemAgregado', p, datosItem()),
      ]
    })
    const h = html('lista')
    expect(h).toContain('Unida con 6, 7')
    expect(h).toContain('aria-label="Mesa 6, Tomando pedido, unida a la mesa 5"')
    expect(h).toContain('aria-label="Mesa 7, Tomando pedido, unida a la mesa 5"')
    expect(h).toContain('Mesa 5 + 6 + 7')
  })

  it('tras separar las mesas, ya no se ven unidas', () => {
    salon((id) => {
      const p = nuevoId()
      return [
        local('PedidoAbierto', p, { ...apertura, mesa_id: id['5'] as string }),
        local('MesasUnidas', p, { mesa_ids: [id['6'] as string] }),
        local('MesasSeparadas', p, { mesa_ids: [id['6'] as string] }),
      ]
    })
    expect(html('lista')).not.toContain('Unida')
  })
})
