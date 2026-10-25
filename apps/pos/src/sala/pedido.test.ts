import { nuevoId, reconstruir } from '@pos/core'
import type { Catalogo } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import {
  comandasPorEstacion,
  copiaDe,
  datosItem,
  faltaElegir,
  type GrupoCatalogo,
  type ProductoCatalogo,
  pideOpciones,
  porEnviar,
  precioElegido,
} from './pedido'
import { apertura, catalogoDePrueba, datosItem as copia, local } from './pruebas'

const grupo = (campos: Partial<GrupoCatalogo> = {}): GrupoCatalogo => ({
  id: nuevoId(),
  nombre: 'Punto de cocción',
  minimo: 1,
  maximo: 1,
  opciones: [
    { id: 'O-1', nombre: 'Término medio', precioExtra: 0 },
    { id: 'O-2', nombre: 'Bien cocido', precioExtra: 0 },
    { id: 'O-3', nombre: 'Extra queso', precioExtra: 3_000 },
  ],
  ...campos,
})

const producto = (campos: Partial<ProductoCatalogo> = {}): ProductoCatalogo => ({
  id: nuevoId(),
  nombre: 'Ramón Bilbao',
  descripcion: null,
  precio: 20_000,
  impuesto: { tipo: 'inc', tarifa: 800 },
  variantes: [],
  grupos: [],
  ...campos,
})

const vino = producto({
  variantes: [
    { id: 'V-COPA', nombre: 'Copa', precio: 24_000 },
    { id: 'V-BOTELLA', nombre: 'Botella', precio: 98_000 },
  ],
})

describe('pideOpciones', () => {
  it('es falso sin variantes ni grupos y verdadero con cualquiera de los dos', () => {
    expect(pideOpciones(producto())).toBe(false)
    expect(pideOpciones(vino)).toBe(true)
    expect(pideOpciones(producto({ grupos: [grupo()] }))).toBe(true)
  })
})

describe('faltaElegir', () => {
  it('sin variantes ni grupos no falta nada', () => {
    expect(faltaElegir(producto(), null, {})).toEqual([])
  })

  it('pide el tamaño si el producto tiene variantes y no se eligió, o se eligió una ajena', () => {
    expect(faltaElegir(vino, null, {})).toEqual(['tamaño'])
    expect(faltaElegir(vino, 'V-OTRO-PRODUCTO', {})).toEqual(['tamaño'])
    expect(faltaElegir(vino, 'V-COPA', {})).toEqual([])
  })

  it('pide cada grupo bajo su mínimo, con el nombre en minúsculas', () => {
    const g = grupo({ minimo: 2, maximo: 3 })
    const p = producto({ grupos: [g] })
    expect(faltaElegir(p, null, {})).toEqual(['punto de cocción'])
    expect(faltaElegir(p, null, { [g.id]: ['O-1'] })).toEqual(['punto de cocción'])
    expect(faltaElegir(p, null, { [g.id]: ['O-1', 'O-2'] })).toEqual([])
  })

  it('un grupo con mínimo 0 es opcional', () => {
    const p = producto({ grupos: [grupo({ minimo: 0, maximo: 2 })] })
    expect(faltaElegir(p, null, {})).toEqual([])
  })

  it('junta tamaño y grupos, en ese orden', () => {
    const p = producto({ variantes: vino.variantes, grupos: [grupo()] })
    expect(faltaElegir(p, null, {})).toEqual(['tamaño', 'punto de cocción'])
  })
})

describe('datosItem', () => {
  const catalogo = catalogoDePrueba({ version: 7 })

  it('producto simple: copia nombre, precio e impuesto del catálogo', () => {
    const p = producto({ nombre: 'Limonada', precio: 9_900 })
    const d = datosItem(catalogo, p, null, {})
    expect(d).toMatchObject({
      producto_id: p.id,
      variante_id: null,
      nombre: 'Limonada',
      precio_unitario: 9_900,
      impuesto_tipo: 'inc',
      tarifa: 800,
      cantidad: 1,
      modificadores: [],
      catalogo_version: 7,
      precio_canal_id: null,
    })
    expect(d.item_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('con variante: el precio y el nombre son los de la variante', () => {
    const d = datosItem(catalogo, vino, 'V-BOTELLA', {})
    expect(d).toMatchObject({
      variante_id: 'V-BOTELLA',
      nombre: 'Ramón Bilbao · Botella',
      precio_unitario: 98_000,
    })
  })

  it('con modificadores: guarda id, nombre y recargo de lo elegido, en el orden del catálogo', () => {
    const g = grupo({ minimo: 1, maximo: 3 })
    const p = producto({ grupos: [g] })
    const d = datosItem(catalogo, p, null, { [g.id]: ['O-3', 'O-1'] })
    expect(d.modificadores).toEqual([
      { modificador_id: 'O-1', nombre: 'Término medio', precio_extra: 0 },
      { modificador_id: 'O-3', nombre: 'Extra queso', precio_extra: 3_000 },
    ])
    // El precio unitario no incluye el recargo: lo suma el cálculo del pedido.
    expect(d.precio_unitario).toBe(20_000)
  })

  it('un id que no es del grupo no cuenta como elegido', () => {
    const g = grupo({ minimo: 1, maximo: 1 })
    const p = producto({ grupos: [g] })
    expect(faltaElegir(p, null, { [g.id]: ['AJENA'] })).toEqual(['punto de cocción'])
    expect(() => datosItem(catalogo, p, null, { [g.id]: ['AJENA'] })).toThrow('Falta elegir')
    const d = datosItem(catalogo, p, null, { [g.id]: ['O-1', 'AJENA'] })
    expect(d.modificadores.map((m) => m.modificador_id)).toEqual(['O-1'])
  })

  it('pasarse del máximo del grupo no se recorta en silencio: lanza y no guarda nada', () => {
    const g = grupo({ minimo: 1, maximo: 1 })
    const p = producto({ grupos: [g] })
    expect(() => datosItem(catalogo, p, null, { [g.id]: ['O-1', 'O-2'] })).toThrow(
      'En punto de cocción se eligen máximo 1',
    )
    // Justo en el máximo está bien.
    expect(datosItem(catalogo, p, null, { [g.id]: ['O-2'] }).modificadores).toHaveLength(1)
  })

  it('un producto exento queda con tarifa 0', () => {
    const p = producto({ impuesto: { tipo: 'exento', tarifa: 800 } })
    expect(datosItem(catalogo, p, null, {})).toMatchObject({ impuesto_tipo: 'exento', tarifa: 0 })
  })

  it('con variante y modificadores a la vez', () => {
    const g = grupo()
    const p = producto({ variantes: vino.variantes, grupos: [g] })
    const d = datosItem(catalogo, p, 'V-COPA', { [g.id]: ['O-2'] })
    expect(d).toMatchObject({ nombre: 'Ramón Bilbao · Copa', precio_unitario: 24_000 })
    expect(d.modificadores).toHaveLength(1)
  })

  it('si falta elegir, lanza con lo que falta y no genera nada', () => {
    const p = producto({ variantes: vino.variantes, grupos: [grupo()] })
    expect(() => datosItem(catalogo, p, null, {})).toThrow('Falta elegir: tamaño, punto de cocción')
  })

  it('cada llamada genera un item_id nuevo', () => {
    const p = producto()
    expect(datosItem(catalogo, p, null, {}).item_id).not.toBe(
      datosItem(catalogo, p, null, {}).item_id,
    )
  })

  it('los datos pasan el esquema del evento ItemAgregado', async () => {
    const { validarEventoNuevo } = await import('@pos/core')
    const g = grupo()
    const p = producto({ variantes: vino.variantes, grupos: [g] })
    const datos = datosItem(catalogo, p, 'V-COPA', { [g.id]: ['O-1'] })
    // El esquema pide ULID en producto, variante y modificador: se prueban con ids reales.
    const real = { ...datos, producto_id: nuevoId(), variante_id: nuevoId() }
    real.modificadores = real.modificadores.map((m) => ({ ...m, modificador_id: nuevoId() }))
    const evento = local('ItemAgregado', nuevoId(), real, 'pendiente').evento
    expect(validarEventoNuevo(evento).ok).toBe(true)
  })
})

describe('comandasPorEstacion', () => {
  const pedidoId = nuevoId()
  const enCocina = nuevoId()
  const enBarra = nuevoId()
  const sinEstacion = nuevoId()

  function estadoCon(productos: string[]) {
    const eventos = [
      local('PedidoAbierto', pedidoId, apertura),
      ...productos.map((producto_id) =>
        local('ItemAgregado', pedidoId, copia({ producto_id }), 'pendiente'),
      ),
    ]
    const estado = reconstruir(
      eventos.map((l) => l.evento),
      pedidoId,
    )
    if (!estado) throw new Error('sin estado')
    return estado
  }

  const catalogo: Catalogo = catalogoDePrueba({
    categorias: [
      {
        id: 'C1',
        nombre: 'Pizzas',
        estacionId: 'E-COCINA',
        productos: [producto({ id: enCocina })],
      },
      { id: 'C2', nombre: 'Tragos', estacionId: 'E-BARRA', productos: [producto({ id: enBarra })] },
      { id: 'C3', nombre: 'Varios', estacionId: null, productos: [producto({ id: sinEstacion })] },
    ],
  })

  it('una comanda por estación, con los ítems de cada una', () => {
    const estado = estadoCon([enCocina, enBarra, enCocina])
    const r = comandasPorEstacion(catalogo, estado)
    expect(r?.comandas).toHaveLength(2)
    const cocina = r?.comandas.find((c) => c.estacion_id === 'E-COCINA')
    const barra = r?.comandas.find((c) => c.estacion_id === 'E-BARRA')
    expect(cocina?.item_ids).toHaveLength(2)
    expect(barra?.item_ids).toHaveLength(1)
    expect(new Set(r?.comandas.map((c) => c.comanda_id)).size).toBe(2)
    // Todos los pendientes salen en alguna comanda, sin repetirse.
    const enviados = r?.comandas.flatMap((c) => c.item_ids) ?? []
    expect(new Set(enviados)).toEqual(new Set(porEnviar(estado).map((i) => i.id)))
  })

  it('una categoría sin estación va a la primera estación del restaurante', () => {
    const r = comandasPorEstacion(catalogo, estadoCon([sinEstacion]))
    expect(r?.comandas.map((c) => c.estacion_id)).toEqual(['E-COCINA'])
  })

  it('un producto que ya no está en el catálogo también va a la primera estación', () => {
    const r = comandasPorEstacion(catalogo, estadoCon([nuevoId()]))
    expect(r?.comandas.map((c) => c.estacion_id)).toEqual(['E-COCINA'])
  })

  it('sin estaciones en el restaurante no hay a dónde enviar lo de una categoría sin estación', () => {
    const sin = { ...catalogo, estaciones: [] }
    expect(comandasPorEstacion(sin, estadoCon([sinEstacion]))).toBeNull()
    // Lo que sí tiene estación propia (aunque el restaurante no liste ninguna) sigue funcionando.
    expect(comandasPorEstacion(sin, estadoCon([enBarra]))?.comandas).toHaveLength(1)
  })

  it('si algún ítem no tiene a dónde ir, no se envía nada (ni siquiera lo que sí podría)', () => {
    const sin = { ...catalogo, estaciones: [] }
    expect(comandasPorEstacion(sin, estadoCon([enCocina, sinEstacion]))).toBeNull()
  })

  it('sin ítems por enviar devuelve null', () => {
    expect(comandasPorEstacion(catalogo, estadoCon([]))).toBeNull()
  })

  it('lo ya enviado no vuelve a salir', () => {
    const agregado = copia({ producto_id: enCocina })
    const itemId = agregado.item_id
    const eventos = [
      local('PedidoAbierto', pedidoId, apertura),
      local('ItemAgregado', pedidoId, agregado, 'pendiente'),
    ]
    eventos.push(
      local(
        'ItemsEnviados',
        pedidoId,
        { comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [itemId] }] },
        'pendiente',
      ),
    )
    const estado = reconstruir(
      eventos.map((l) => l.evento),
      pedidoId,
    )
    expect(estado?.items[itemId]?.estado).toBe('enviado')
    expect(comandasPorEstacion(catalogo, estado as never)).toBeNull()
  })
})

describe('precioElegido', () => {
  const g = grupo({ minimo: 0, maximo: 3 })

  it('producto simple: su precio', () => {
    expect(precioElegido(producto({ precio: 12_000 }), null, {})).toBe(12_000)
  })

  it('la variante reemplaza el precio base y los extras se suman', () => {
    const p = producto({ variantes: vino.variantes, grupos: [g] })
    expect(precioElegido(p, 'V-BOTELLA', {})).toBe(98_000)
    expect(precioElegido(p, 'V-COPA', { [g.id]: ['O-3'] })).toBe(27_000)
    expect(precioElegido(p, 'V-COPA', { [g.id]: ['O-3', 'O-1'] })).toBe(27_000)
  })

  it('sin variante elegida usa el precio del producto; un id ajeno no suma', () => {
    const p = producto({ precio: 20_000, variantes: vino.variantes, grupos: [g] })
    expect(precioElegido(p, null, { [g.id]: ['AJENA'] })).toBe(20_000)
  })

  it('coincide con lo que cobra el pedido para el ítem guardado', async () => {
    const { reconstruir, totalesPedido } = await import('@pos/core')
    const p = producto({ variantes: vino.variantes, grupos: [g] })
    const elegidas = { [g.id]: ['O-3'] }
    const pedidoId = nuevoId()
    const real = { ...datosItem(catalogoDePrueba(), p, 'V-COPA', elegidas), producto_id: nuevoId() }
    real.variante_id = nuevoId()
    real.modificadores = real.modificadores.map((m) => ({ ...m, modificador_id: nuevoId() }))
    const estado = reconstruir(
      [
        local('PedidoAbierto', pedidoId, apertura).evento,
        local('ItemAgregado', pedidoId, real, 'pendiente').evento,
      ],
      pedidoId,
    )
    expect(totalesPedido(estado as never).neto).toBe(precioElegido(p, 'V-COPA', elegidas))
  })
})

describe('copiaDe', () => {
  it('repite el ítem con id nuevo y la versión de catálogo indicada', () => {
    const pedidoId = nuevoId()
    const original = copia({
      producto_id: nuevoId(),
      nombre: 'Pizza',
      cantidad: 2,
      comensal: 3,
      curso: 'fuerte',
      notas: 'sin cebolla',
      modificadores: [{ modificador_id: nuevoId(), nombre: 'Extra queso', precio_extra: 3_000 }],
    })
    const estado = reconstruir(
      [
        local('PedidoAbierto', pedidoId, apertura).evento,
        local('ItemAgregado', pedidoId, original).evento,
      ],
      pedidoId,
    )
    const item = estado?.items[original.item_id]
    if (!item) throw new Error('sin ítem')
    const c = copiaDe(item, 9)
    expect(c.item_id).not.toBe(original.item_id)
    expect(c).toEqual({ ...original, item_id: c.item_id, catalogo_version: 9 })
  })
})
