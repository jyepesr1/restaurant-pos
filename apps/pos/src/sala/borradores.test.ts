import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import {
  borradorDeGrupo,
  borradorDeProducto,
  cambiosDeGrupo,
  cambiosDeProducto,
  grupoNuevo,
  leerPesos,
  problemasDeGrupo,
  problemasDeProducto,
  productoNuevo,
  productosConGrupo,
} from './borradores'
import type { CatalogoEdicion } from './motor'

const reg = { version: 1, activo: true }

function edicion(): CatalogoEdicion {
  const impuesto = nuevoId()
  const categoria = nuevoId()
  const vino = nuevoId()
  const termino = nuevoId()
  const tagliata = nuevoId()
  return {
    version: 10,
    impuestos: [{ ...reg, id: impuesto, nombre: 'INC 8 %', tipo: 'inc', tarifa: 800 }],
    estaciones: [],
    categorias: [{ ...reg, id: categoria, nombre: 'Vinos', orden: 0, estacion_id: null }],
    productos: [
      {
        ...reg,
        id: vino,
        categoria_id: categoria,
        nombre: 'Ramón Bilbao',
        descripcion: null,
        precio: 30_900,
        impuesto_id: impuesto,
        favorito: false,
      },
      {
        ...reg,
        id: tagliata,
        categoria_id: categoria,
        nombre: 'Tagliata',
        descripcion: 'Solomito',
        precio: 40_900,
        impuesto_id: impuesto,
        favorito: false,
      },
    ],
    variantes: [
      { ...reg, id: nuevoId(), producto_id: vino, nombre: 'Botella', precio: 129_900, orden: 1 },
      { ...reg, id: nuevoId(), producto_id: vino, nombre: 'Copa', precio: 30_900, orden: 0 },
    ],
    grupos: [{ ...reg, id: termino, nombre: 'Término', minimo: 1, maximo: 1 }],
    enlaces: [{ ...reg, id: nuevoId(), producto_id: tagliata, grupo_id: termino, orden: 0 }],
    modificadores: [
      { ...reg, id: nuevoId(), grupo_id: termino, nombre: 'Medio', precio_extra: 0, orden: 1 },
      { ...reg, id: nuevoId(), grupo_id: termino, nombre: 'Rojo', precio_extra: 0, orden: 0 },
    ],
  }
}

const idDe = (c: CatalogoEdicion, nombre: string) =>
  c.productos.find((p) => p.nombre === nombre)?.id as string

describe('leerPesos', () => {
  it.each([
    ['40.900', 40_900],
    ['$ 40900', 40_900],
    ['40 900', 40_900],
    ['0', 0],
    ['100.000.000', 100_000_000],
  ])('%s → %d', (texto, valor) => expect(leerPesos(texto)).toBe(valor))

  it.each([
    '',
    '40,5',
    '-100',
    'abc',
    '100.000.001',
    '1e5',
    '1.5',
    '40.90',
    '4.09.00',
    '1.500,00',
    '1..500',
  ])('rechaza «%s»', (texto) => expect(leerPesos(texto)).toBeNull())
})

describe('producto', () => {
  it('sin tocar nada no hay cambios', () => {
    const c = edicion()
    for (const nombre of ['Ramón Bilbao', 'Tagliata'])
      expect(cambiosDeProducto(c, borradorDeProducto(c, idDe(c, nombre)))).toEqual([])
  })

  it('el borrador trae las variantes y los grupos en su orden', () => {
    const c = edicion()
    const b = borradorDeProducto(c, idDe(c, 'Ramón Bilbao'))
    expect(b.variantes.map((v) => v.nombre)).toEqual(['Copa', 'Botella'])
    expect(borradorDeProducto(c, idDe(c, 'Tagliata')).grupos).toEqual([c.grupos[0]?.id])
  })

  it('cambiar el precio de la botella solo cambia esa variante', () => {
    const c = edicion()
    const b = borradorDeProducto(c, idDe(c, 'Ramón Bilbao'))
    const botella = b.variantes[1]
    if (!botella) throw new Error('falta')
    botella.precio = 135_000
    expect(cambiosDeProducto(c, b)).toEqual([
      { entidad: 'variante', id: botella.id, datos: { precio: 135_000 } },
    ])
  })

  it('con variantes, el precio del producto es el de la más barata', () => {
    const c = edicion()
    const b = borradorDeProducto(c, idDe(c, 'Ramón Bilbao'))
    const copa = b.variantes[0]
    if (!copa) throw new Error('falta')
    copa.precio = 28_000
    expect(cambiosDeProducto(c, b)).toEqual([
      { entidad: 'producto', id: b.id, datos: { precio: 28_000 } },
      { entidad: 'variante', id: copa.id, datos: { precio: 28_000 } },
    ])
  })

  it('quitar una variante la archiva; una nueva lleva todos sus campos', () => {
    const c = edicion()
    const b = borradorDeProducto(c, idDe(c, 'Ramón Bilbao'))
    const botella = b.variantes[1]
    if (!botella) throw new Error('falta')
    botella.activo = false
    const media = {
      id: nuevoId(),
      nuevo: true,
      nombre: 'Media botella',
      precio: 70_000,
      activo: true,
    }
    b.variantes.push(media)
    expect(cambiosDeProducto(c, b)).toEqual([
      { entidad: 'variante', id: botella.id, datos: { activo: false } },
      {
        entidad: 'variante',
        id: media.id,
        datos: {
          producto_id: b.id,
          nombre: 'Media botella',
          precio: 70_000,
          // Va después de la copa: la botella archivada no ocupa lugar.
          orden: 1,
          activo: true,
        },
      },
    ])
  })

  it('una variante nueva que se quitó antes de guardar no viaja', () => {
    const c = edicion()
    const b = borradorDeProducto(c, idDe(c, 'Tagliata'))
    b.variantes.push({ id: nuevoId(), nuevo: true, nombre: 'X', precio: 1, activo: false })
    expect(cambiosDeProducto(c, b)).toEqual([])
  })

  it('un producto nuevo lleva todos los campos, con la descripción vacía como null', () => {
    const c = edicion()
    const b = productoNuevo(c, c.categorias[0]?.id as string)
    b.nombre = '  Pinsa  '
    b.precio = 20_900
    expect(cambiosDeProducto(c, b)).toEqual([
      {
        entidad: 'producto',
        id: b.id,
        datos: {
          categoria_id: b.categoriaId,
          nombre: 'Pinsa',
          descripcion: null,
          precio: 20_900,
          impuesto_id: c.impuestos[0]?.id,
          favorito: false,
          activo: true,
        },
      },
    ])
  })

  it('quitar un grupo archiva su enlace y volver a ponerlo lo reactiva, sin duplicarlo', () => {
    const c = edicion()
    const tagliata = idDe(c, 'Tagliata')
    const enlace = c.enlaces[0]
    if (!enlace) throw new Error('falta')
    const b = borradorDeProducto(c, tagliata)
    b.grupos = []
    expect(cambiosDeProducto(c, b)).toEqual([
      { entidad: 'producto_grupo_modificador', id: enlace.id, datos: { activo: false } },
    ])
    enlace.activo = false
    const otra = borradorDeProducto(c, tagliata)
    otra.grupos = [enlace.grupo_id]
    expect(cambiosDeProducto(c, otra)).toEqual([
      { entidad: 'producto_grupo_modificador', id: enlace.id, datos: { activo: true } },
    ])
  })

  it('un grupo nuevo en un producto crea su enlace', () => {
    const c = edicion()
    const b = borradorDeProducto(c, idDe(c, 'Ramón Bilbao'))
    b.grupos = [c.grupos[0]?.id as string]
    const [cambio] = cambiosDeProducto(c, b)
    expect(cambio).toMatchObject({
      entidad: 'producto_grupo_modificador',
      datos: { producto_id: b.id, grupo_id: c.grupos[0]?.id, orden: 0, activo: true },
    })
  })

  it('avisa lo que falta antes de guardar', () => {
    const c = edicion()
    const b = productoNuevo(c, '')
    b.variantes = [
      { id: nuevoId(), nuevo: true, nombre: 'Copa', precio: 1, activo: true },
      { id: nuevoId(), nuevo: true, nombre: 'copa ', precio: 2, activo: true },
    ]
    b.grupos = ['a', 'a']
    expect(problemasDeProducto(b)).toEqual([
      'Falta el nombre',
      'Falta la categoría',
      'Hay dos tamaños con el mismo nombre',
      'Un grupo de opciones está dos veces',
    ])
  })

  it('un producto nuevo sin tamaños pide el precio', () => {
    const c = edicion()
    const b = productoNuevo(c, c.categorias[0]?.id as string)
    b.nombre = 'Pinsa'
    expect(problemasDeProducto(b)).toEqual(['Escribe el precio'])
    b.precio = 20_900
    expect(problemasDeProducto(b)).toEqual([])
  })
})

describe('grupo de opciones', () => {
  it('sin tocar nada no hay cambios; el borrador trae las opciones en orden', () => {
    const c = edicion()
    const g = borradorDeGrupo(c, c.grupos[0]?.id as string)
    expect(g.opciones.map((o) => o.nombre)).toEqual(['Rojo', 'Medio'])
    expect(cambiosDeGrupo(c, g)).toEqual([])
  })

  it('una opción con precio, el máximo y archivar una opción', () => {
    const c = edicion()
    const g = borradorDeGrupo(c, c.grupos[0]?.id as string)
    const [rojo, medio] = g.opciones
    if (!rojo || !medio) throw new Error('falta')
    g.maximo = 2
    rojo.precioExtra = 2_000
    medio.activo = false
    expect(cambiosDeGrupo(c, g)).toEqual([
      { entidad: 'grupo_modificador', id: g.id, datos: { maximo: 2 } },
      { entidad: 'modificador', id: rojo.id, datos: { precio_extra: 2_000 } },
      { entidad: 'modificador', id: medio.id, datos: { activo: false } },
    ])
  })

  it('un grupo nuevo lleva todo', () => {
    const c = edicion()
    const g = grupoNuevo()
    g.nombre = 'Adicionales'
    g.maximo = 3
    g.opciones.push({
      id: nuevoId(),
      nuevo: true,
      nombre: 'Tocineta',
      precioExtra: 4_000,
      activo: true,
    })
    expect(cambiosDeGrupo(c, g).map((x) => x.entidad)).toEqual(['grupo_modificador', 'modificador'])
    expect(problemasDeGrupo(g)).toEqual([])
  })

  it('avisa lo que no cuadra', () => {
    const g = grupoNuevo()
    g.minimo = 2
    g.maximo = 1
    expect(problemasDeGrupo(g)).toEqual([
      'Falta el nombre',
      'Agrega al menos una opción',
      'El mínimo no puede pasar del máximo',
    ])
    g.maximo = 3
    g.opciones.push({ id: nuevoId(), nuevo: true, nombre: 'Uno', precioExtra: 0, activo: true })
    expect(problemasDeGrupo(g)).toContain('El mínimo (2) es mayor que las opciones que hay (1)')
  })

  it('cuenta los productos activos que lo usan', () => {
    const c = edicion()
    const grupo = c.grupos[0]?.id as string
    expect(productosConGrupo(c, grupo)).toBe(1)
    const tagliata = c.productos.find((p) => p.nombre === 'Tagliata')
    if (tagliata) tagliata.activo = false
    expect(productosConGrupo(c, grupo)).toBe(0)
  })
})
