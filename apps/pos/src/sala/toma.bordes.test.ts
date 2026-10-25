import { type EventoAplicable, nuevoId, reconstruir, validarEventoNuevo } from '@pos/core'
import type { EventoLocal } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import { comandasDeCurso, comandasPorEstacion, datosItem, lineaIgual } from './pedido'
import {
  agotados,
  claveAgotado,
  estadoMesa,
  masPedidos,
  type PedidoVisible,
  pedidosAbiertos,
} from './proyeccion'
import { apertura, catalogoDePrueba, datosItem as item, local } from './pruebas'

// Bordes de la toma de pedido de la 1.3: agotados con su orden, lo más pedido, sumar a la línea
// igual, marchar un curso, los datos del ítem y el pedido para llevar.

const conSecuencia = (l: EventoLocal, secuencia: number): EventoLocal => ({
  ...l,
  evento: { ...l.evento, secuencia } as EventoAplicable,
})
const deProducto = { agregado_tipo: 'producto' } as const
const marca = (
  tipo: 'ProductoAgotado' | 'ProductoDisponible',
  producto: string,
  variante: string | null = null,
  estado: 'confirmado' | 'pendiente' = 'confirmado',
) => local(tipo, producto, { producto_id: producto, variante_id: variante }, estado, deProducto)

const simple = {
  id: nuevoId(),
  nombre: 'Limonada',
  descripcion: null,
  favorito: false,
  precio: 9_900,
  impuesto: { tipo: 'inc' as const, tarifa: 800 },
  variantes: [],
  grupos: [],
}
const catalogo = catalogoDePrueba({
  categorias: [{ id: nuevoId(), nombre: 'Bebidas', estacionId: 'E-BARRA', productos: [simple] }],
})

const pedidoCon = (...eventos: ((p: string) => EventoLocal)[]) => {
  const p = nuevoId()
  const locales = [local('PedidoAbierto', p, apertura), ...eventos.map((f) => f(p))]
  return {
    p,
    locales,
    estado: reconstruir(
      locales.map((l) => l.evento),
      p,
    ),
  }
}
const agregado =
  (datos: ReturnType<typeof item>, estado: 'confirmado' | 'pendiente' = 'confirmado') =>
  (p: string) =>
    local('ItemAgregado', p, datos, estado)

describe('agotados(): orden de confirmados y pendientes', () => {
  it('los confirmados mandan por secuencia aunque la lista venga desordenada', () => {
    const p = nuevoId()
    const agotar = conSecuencia(marca('ProductoAgotado', p), 5)
    const liberar = conSecuencia(marca('ProductoDisponible', p), 9)
    expect(agotados([liberar, agotar])).toEqual(new Set())
    expect(agotados([agotar, liberar])).toEqual(new Set())
    const liberar2 = conSecuencia(marca('ProductoDisponible', p), 3)
    expect(agotados([agotar, liberar2])).toEqual(new Set([p]))
  })

  it('lo pendiente propio va siempre encima de lo confirmado, esté donde esté en la lista', () => {
    const p = nuevoId()
    const confirmadoAgotado = conSecuencia(marca('ProductoAgotado', p), 50)
    const pendienteLibre = marca('ProductoDisponible', p, null, 'pendiente')
    expect(agotados([pendienteLibre, confirmadoAgotado])).toEqual(new Set())
    expect(agotados([confirmadoAgotado, pendienteLibre])).toEqual(new Set())
    // Y al revés: pendiente "agotado" sobre un "disponible" confirmado posterior en secuencia.
    const confirmadoLibre = conSecuencia(marca('ProductoDisponible', p), 99)
    const pendienteAgotado = marca('ProductoAgotado', p, null, 'pendiente')
    expect(agotados([pendienteAgotado, confirmadoLibre])).toEqual(new Set([p]))
  })

  it('varios pendientes se aplican en el orden de la lista; el último manda', () => {
    const p = nuevoId()
    expect(
      agotados([
        marca('ProductoAgotado', p, null, 'pendiente'),
        marca('ProductoDisponible', p, null, 'pendiente'),
        marca('ProductoAgotado', p, null, 'pendiente'),
      ]),
    ).toEqual(new Set([p]))
    expect(
      agotados([
        marca('ProductoAgotado', p, null, 'pendiente'),
        marca('ProductoDisponible', p, null, 'pendiente'),
      ]),
    ).toEqual(new Set())
  })

  it('un confirmado sin secuencia cuenta como 0: va antes que cualquiera con secuencia', () => {
    const p = nuevoId()
    const sinSecuencia = conSecuencia(
      marca('ProductoDisponible', p),
      undefined as unknown as number,
    )
    const conSec = conSecuencia(marca('ProductoAgotado', p), 1)
    expect(agotados([conSec, sinSecuencia])).toEqual(new Set([p]))
    expect(agotados([sinSecuencia, conSec])).toEqual(new Set([p]))
  })

  it('con variantes: cada una va sola y el producto entero es otra clave', () => {
    const p = nuevoId()
    const copa = nuevoId()
    const botella = nuevoId()
    const eventos = [
      conSecuencia(marca('ProductoAgotado', p, botella), 1),
      conSecuencia(marca('ProductoAgotado', p, copa), 2),
      conSecuencia(marca('ProductoDisponible', p, copa), 3),
    ]
    expect(agotados(eventos)).toEqual(new Set([claveAgotado(p, botella)]))
    // Marcar disponible el producto entero no libera la botella, y agotarlo no toca a la copa.
    expect(agotados([...eventos, conSecuencia(marca('ProductoDisponible', p), 4)])).toEqual(
      new Set([claveAgotado(p, botella)]),
    )
    expect(agotados([...eventos, conSecuencia(marca('ProductoAgotado', p), 4)])).toEqual(
      new Set([claveAgotado(p, botella), claveAgotado(p)]),
    )
    expect(claveAgotado(p)).toBe(p)
    expect(claveAgotado(p, null)).toBe(p)
    expect(claveAgotado(p, copa)).not.toBe(claveAgotado(p, botella))
  })

  it('un evento rechazado o en cuarentena no cuenta; uno confirmado de otro producto tampoco influye', () => {
    const p = nuevoId()
    const otro = nuevoId()
    const rechazado = { ...marca('ProductoAgotado', p), estado: 'rechazado' as const }
    const cuarentena = { ...marca('ProductoAgotado', p), estado: 'cuarentena' as const }
    expect(agotados([rechazado, cuarentena])).toEqual(new Set())
    expect(agotados([rechazado, conSecuencia(marca('ProductoAgotado', otro), 1)])).toEqual(
      new Set([otro]),
    )
    // Un rechazado "disponible" no libera lo que sigue agotado.
    const liberaRechazado = { ...marca('ProductoDisponible', p), estado: 'rechazado' as const }
    expect(agotados([conSecuencia(marca('ProductoAgotado', p), 1), liberaRechazado])).toEqual(
      new Set([p]),
    )
  })

  it('los eventos de pedido no cuentan, y sin eventos no hay nada agotado', () => {
    const { locales } = pedidoCon(agregado(item()))
    expect(agotados(locales)).toEqual(new Set())
    expect(agotados([])).toEqual(new Set())
  })
})

describe('masPedidos con eventos rechazados y otros bordes', () => {
  it('los ítems rechazados o en cuarentena no suman', () => {
    const p = nuevoId()
    const bueno = nuevoId()
    const malo = nuevoId()
    const locales = [
      local('PedidoAbierto', p, apertura),
      local('ItemAgregado', p, item({ producto_id: bueno, cantidad: 1 })),
      {
        ...local('ItemAgregado', p, item({ producto_id: malo, cantidad: 9 })),
        estado: 'rechazado' as const,
      },
      {
        ...local('ItemAgregado', p, item({ producto_id: malo, cantidad: 9 })),
        estado: 'cuarentena' as const,
      },
    ]
    expect(masPedidos(locales)).toEqual([bueno])
  })

  it('un pendiente propio sí cuenta; en un empate va primero lo confirmado, en el orden del hub', () => {
    const p = nuevoId()
    const a = nuevoId()
    const b = nuevoId()
    const c = nuevoId()
    const locales = [
      local('ItemAgregado', p, item({ producto_id: a, cantidad: 2 })),
      local('ItemAgregado', p, item({ producto_id: b, cantidad: 2 }), 'pendiente'),
      local('ItemAgregado', p, item({ producto_id: c, cantidad: 2 })),
    ]
    expect(masPedidos(locales)).toEqual([a, c, b])
    expect(masPedidos(locales, 2)).toEqual([a, c])
    expect(masPedidos(locales, 0)).toEqual([])
    expect(masPedidos([])).toEqual([])
  })

  it('el tope por defecto es 12 productos', () => {
    const p = nuevoId()
    const locales = Array.from({ length: 15 }, (_, i) =>
      local('ItemAgregado', p, item({ producto_id: nuevoId(), cantidad: 15 - i })),
    )
    expect(masPedidos(locales)).toHaveLength(12)
  })

  // Lo encontró qa-pruebas en la 1.3 y ya está corregido: sumar el mismo producto otra vez se
  // guarda como `ItemCambiado` sobre la línea, y `masPedidos` solo miraba ItemAgregado.
  it('masPedidos cuenta las unidades que se suman con ItemCambiado', () => {
    const p = nuevoId()
    const limonada = nuevoId()
    const cerveza = nuevoId()
    const linea = item({ producto_id: limonada, cantidad: 1 })
    const locales = [
      local('PedidoAbierto', p, apertura),
      local('ItemAgregado', p, linea),
      local('ItemAgregado', p, item({ producto_id: cerveza, cantidad: 3 })),
      local('ItemCambiado', p, { item_id: linea.item_id, cantidad: 10 }),
    ]
    expect(masPedidos(locales)).toEqual([limonada, cerveza])
  })

  it('lo quitado no cuenta y lo anulado se descuenta', () => {
    const p = nuevoId()
    const [limonada, cerveza, agua] = [nuevoId(), nuevoId(), nuevoId()]
    const quitada = item({ producto_id: limonada, cantidad: 5 })
    const anulada = item({ producto_id: cerveza, cantidad: 4 })
    const locales = [
      local('PedidoAbierto', p, apertura),
      local('ItemAgregado', p, quitada),
      local('ItemAgregado', p, anulada),
      local('ItemAgregado', p, item({ producto_id: agua, cantidad: 2 })),
      local('ItemQuitado', p, { item_id: quitada.item_id }),
      local('ItemAnulado', p, {
        item_id: anulada.item_id,
        cantidad: 3,
        ya_preparado: false,
        comanda_id: null,
      }),
    ]
    expect(masPedidos(locales)).toEqual([agua, cerveza])
  })
})

describe('lineaIgual: retenido, anulado y opciones en otro orden', () => {
  const op = (n: string) => ({ modificador_id: n, nombre: n, precio_extra: 0 })

  it('las opciones en otro orden son la misma línea', () => {
    const producto = nuevoId()
    const [a, b, c] = [nuevoId(), nuevoId(), nuevoId()]
    const primera = item({ producto_id: producto, modificadores: [op(a), op(b), op(c)] })
    const { estado } = pedidoCon(agregado(primera))
    const igual = lineaIgual(
      estado,
      item({ producto_id: producto, modificadores: [op(c), op(a), op(b)] }),
    )
    expect(igual?.id).toBe(primera.item_id)
    // Una opción de más o de menos ya no lo es.
    expect(
      lineaIgual(estado, item({ producto_id: producto, modificadores: [op(a), op(b)] })),
    ).toBeNull()
    expect(
      lineaIgual(
        estado,
        item({ producto_id: producto, modificadores: [op(a), op(b), op(c), op(nuevoId())] }),
      ),
    ).toBeNull()
  })

  it('una línea ya enviada o quitada no se suma', () => {
    const producto = nuevoId()
    const linea = item({ producto_id: producto })
    const enviada = pedidoCon(agregado(linea), (p) =>
      local('ItemsEnviados', p, {
        comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [linea.item_id] }],
      }),
    )
    expect(lineaIgual(enviada.estado, item({ producto_id: producto }))).toBeNull()

    const quitada = pedidoCon(agregado(linea), (p) =>
      local('ItemQuitado', p, { item_id: linea.item_id }),
    )
    expect(lineaIgual(quitada.estado, item({ producto_id: producto }))).toBeNull()
  })

  it('con dos líneas iguales posibles (otra persona) elige la de la misma persona', () => {
    const producto = nuevoId()
    const mesa = item({ producto_id: producto, comensal: null })
    const p2 = item({ producto_id: producto, comensal: 2 })
    const { estado } = pedidoCon(agregado(mesa), agregado(p2))
    expect(lineaIgual(estado, item({ producto_id: producto, comensal: 2 }))?.id).toBe(p2.item_id)
    expect(lineaIgual(estado, item({ producto_id: producto, comensal: null }))?.id).toBe(
      mesa.item_id,
    )
    expect(lineaIgual(estado, item({ producto_id: producto, comensal: 3 }))).toBeNull()
  })

  it('no suma si lo nuevo lleva nota ni a una línea que ya tiene nota', () => {
    const producto = nuevoId()
    const conNota = pedidoCon(agregado(item({ producto_id: producto, notas: 'sin hielo' })))
    expect(lineaIgual(conNota.estado, item({ producto_id: producto }))).toBeNull()
    expect(
      lineaIgual(conNota.estado, item({ producto_id: producto, notas: 'sin hielo' })),
    ).toBeNull()
  })

  it('distingue la variante (copa y botella son líneas distintas)', () => {
    const producto = nuevoId()
    const copa = nuevoId()
    const botella = nuevoId()
    const { estado } = pedidoCon(agregado(item({ producto_id: producto, variante_id: copa })))
    expect(lineaIgual(estado, item({ producto_id: producto, variante_id: botella }))).toBeNull()
    expect(lineaIgual(estado, item({ producto_id: producto, variante_id: copa }))).not.toBeNull()
    expect(lineaIgual(estado, item({ producto_id: producto, variante_id: null }))).toBeNull()
  })

  it('un pedido sin líneas o un pedido distinto no da coincidencia', () => {
    const { estado } = pedidoCon()
    expect(lineaIgual(estado, item())).toBeNull()
  })

  it('el mismo producto en un curso retenido suma a su línea retenida', () => {
    const producto = nuevoId()
    const primera = item({ producto_id: producto, curso: 'postre' })
    const { estado } = pedidoCon(
      (p) => local('CursoRetenido', p, { curso: 'postre' }),
      agregado(primera),
    )
    expect(estado?.items[primera.item_id]?.estado).toBe('retenido')
    expect(lineaIgual(estado, item({ producto_id: producto, curso: 'postre' }))?.id).toBe(
      primera.item_id,
    )
  })

  it('no suma a una línea con otro precio copiado (otra versión de la carta)', () => {
    const producto = nuevoId()
    const vieja = item({ producto_id: producto, precio_unitario: 9_900, catalogo_version: 1 })
    const { estado } = pedidoCon(agregado(vieja))
    const nueva = (campos: Record<string, unknown>) =>
      lineaIgual(estado, item({ producto_id: producto, precio_unitario: 9_900, ...campos }))
    expect(nueva({ precio_unitario: 10_900, catalogo_version: 2 })).toBeNull()
    expect(nueva({ catalogo_version: 2 })?.id).toBe(vieja.item_id)
    expect(nueva({ impuesto_tipo: 'iva', tarifa: 1_900 })).toBeNull()
    expect(nueva({ tarifa: 1_900 })).toBeNull()
    expect(nueva({ impuesto_tipo: 'exento', tarifa: 0 })).toBeNull()
  })

  it('la misma opción con otro precio extra no es la misma línea', () => {
    const producto = nuevoId()
    const o = nuevoId()
    const conOpcion = (precio: number) => ({
      modificador_id: o,
      nombre: 'Doble',
      precio_extra: precio,
    })
    const { estado } = pedidoCon(
      agregado(item({ producto_id: producto, modificadores: [conOpcion(2_000)] })),
    )
    expect(
      lineaIgual(estado, item({ producto_id: producto, modificadores: [conOpcion(3_000)] })),
    ).toBeNull()
    expect(
      lineaIgual(estado, item({ producto_id: producto, modificadores: [conOpcion(2_000)] })),
    ).not.toBeNull()
  })

  it('no suma a una línea con descuento ni en un pedido dividido', () => {
    const producto = nuevoId()
    const linea = item({ producto_id: producto })
    const { estado } = pedidoCon(agregado(linea))
    if (!estado) throw new Error('falta')
    const conDescuento = {
      ...estado,
      descuentos: {
        D1: { id: 'D1', montos: { [linea.item_id]: 500 } },
      },
    } as unknown as typeof estado
    expect(lineaIgual(conDescuento, item({ producto_id: producto }))).toBeNull()
    const dividido = { ...estado, cuentas: [] } as unknown as typeof estado
    expect(lineaIgual(dividido, item({ producto_id: producto }))).toBeNull()
    expect(lineaIgual(estado, item({ producto_id: producto }))?.id).toBe(linea.item_id)
  })
})

describe('comandasDeCurso con pendientes de otros cursos', () => {
  const catalogoDos = catalogoDePrueba({
    categorias: [
      { id: nuevoId(), nombre: 'Bebidas', estacionId: 'E-BARRA', productos: [simple] },
      {
        id: nuevoId(),
        nombre: 'Platos',
        estacionId: 'E-COCINA',
        productos: [{ ...simple, id: 'P-PLATO', nombre: 'Pizza' }],
      },
    ],
  })

  it('solo manda el curso marchado: las de otros cursos y las sin curso se quedan pendientes', () => {
    const entrada = item({ producto_id: simple.id, curso: 'entrada' })
    const fuerteBarra = item({ producto_id: simple.id, curso: 'fuerte' })
    const fuerteCocina = item({ producto_id: 'P-PLATO', curso: 'fuerte' })
    const postre = item({ producto_id: 'P-PLATO', curso: 'postre' })
    const sinCurso = item({ producto_id: simple.id, curso: null })
    const { estado } = pedidoCon(
      agregado(entrada),
      agregado(fuerteBarra),
      agregado(fuerteCocina),
      agregado(postre),
      agregado(sinCurso),
    )
    if (!estado) throw new Error('falta')

    const datos = comandasDeCurso(catalogoDos, estado, 'fuerte')
    const enviados = datos?.comandas.flatMap((c) => c.item_ids).sort()
    expect(enviados).toEqual([fuerteBarra.item_id, fuerteCocina.item_id].sort())
    expect(datos?.comandas.map((c) => c.estacion_id).sort()).toEqual(['E-BARRA', 'E-COCINA'])
    // El estado original no se modificó: los demás siguen por enviar.
    expect(Object.keys(estado.items)).toHaveLength(5)
    expect(
      comandasPorEstacion(catalogoDos, estado)?.comandas.flatMap((c) => c.item_ids),
    ).toHaveLength(5)
  })

  it('si el curso ya salió o no tiene nada, no hay nada que mandar (aunque haya pendientes de otros)', () => {
    const fuerte = item({ producto_id: simple.id, curso: 'fuerte' })
    const postre = item({ producto_id: simple.id, curso: 'postre' })
    const { estado } = pedidoCon(agregado(fuerte), agregado(postre), (p) =>
      local('ItemsEnviados', p, {
        comandas: [{ comanda_id: nuevoId(), estacion_id: 'E-BARRA', item_ids: [fuerte.item_id] }],
      }),
    )
    if (!estado) throw new Error('falta')
    expect(comandasDeCurso(catalogoDos, estado, 'fuerte')).toBeNull()
    expect(comandasDeCurso(catalogoDos, estado, 'entrada')).toBeNull()
    expect(comandasDeCurso(catalogoDos, estado, 'postre')?.comandas).toHaveLength(1)
  })

  it('lo retenido de ese curso espera hasta marchar; después sale', () => {
    const postre = item({ producto_id: simple.id, curso: 'postre' })
    const retenido = pedidoCon(
      (p) => local('CursoRetenido', p, { curso: 'postre' }),
      agregado(postre),
    )
    if (!retenido.estado) throw new Error('falta')
    expect(comandasDeCurso(catalogoDos, retenido.estado, 'postre')).toBeNull()

    const marchado = pedidoCon(
      (p) => local('CursoRetenido', p, { curso: 'postre' }),
      agregado(postre),
      (p) => local('CursoMarchado', p, { curso: 'postre' }),
    )
    if (!marchado.estado) throw new Error('falta')
    expect(comandasDeCurso(catalogoDos, marchado.estado, 'postre')?.comandas[0]?.item_ids).toEqual([
      postre.item_id,
    ])
  })
})

describe('datosItem con extras fuera de rango', () => {
  const datosValidos = (extras: Parameters<typeof datosItem>[4]) => {
    const d = datosItem(catalogo, simple, null, {}, extras)
    const p = nuevoId()
    return validarEventoNuevo({
      id: nuevoId(),
      tipo: 'ItemAgregado',
      version_esquema: 1,
      agregado_tipo: 'pedido',
      agregado_id: p,
      relacionados: [],
      datos: d,
      sesion_id: null,
      usuario_id: nuevoId(),
      dispositivo_id: nuevoId(),
      autorizacion_id: null,
      motivo: null,
      hora_dispositivo: '2026-10-24T15:00:00.000Z',
      hora_estimada_hub: '2026-10-24T15:00:00.000Z',
      secuencia_base: 0,
    })
  }

  it('sin extras: una unidad, para la mesa, sin curso ni nota', () => {
    expect(datosItem(catalogo, simple, null, {})).toMatchObject({
      cantidad: 1,
      comensal: null,
      curso: null,
      notas: null,
      catalogo_version: catalogo.version,
      precio_canal_id: null,
    })
  })

  it('cantidad 0 y comensal 0 llegan tal cual, y el esquema los rechaza antes de guardarse', () => {
    expect(datosItem(catalogo, simple, null, {}, { cantidad: 0 }).cantidad).toBe(0)
    expect(datosItem(catalogo, simple, null, {}, { comensal: 0 }).comensal).toBe(0)
    expect(datosValidos({ cantidad: 0 }).ok).toBe(false)
    expect(datosValidos({ comensal: 0 }).ok).toBe(false)
    expect(datosValidos({ cantidad: -3 }).ok).toBe(false)
    expect(datosValidos({ comensal: 100 }).ok).toBe(false)
    expect(datosValidos({ cantidad: 1.5 }).ok).toBe(false)
  })

  it('cantidad 99 vale; 100 pasa el esquema pero la pantalla nunca pasa de 99', () => {
    expect(datosValidos({ cantidad: 99 }).ok).toBe(true)
    // El esquema admite hasta el tope de cantidad (999); el límite de 99 lo pone la pantalla.
    expect(datosValidos({ cantidad: 100 }).ok).toBe(true)
    expect(datosValidos({ cantidad: 1_000 }).ok).toBe(false)
  })

  it('comensal 1 y 99 valen; la nota se recorta y una de más de 500 letras no pasa el esquema', () => {
    expect(datosValidos({ comensal: 1 }).ok).toBe(true)
    expect(datosValidos({ comensal: 99 }).ok).toBe(true)
    expect(datosItem(catalogo, simple, null, {}, { notas: '\n  sin hielo \t' }).notas).toBe(
      'sin hielo',
    )
    expect(datosValidos({ notas: 'a'.repeat(500) }).ok).toBe(true)
    expect(datosValidos({ notas: 'a'.repeat(501) }).ok).toBe(false)
  })

  it('extras vacíos o con null explícito valen como "sin extras"', () => {
    const d = datosItem(
      catalogo,
      simple,
      null,
      {},
      { comensal: null, curso: null, notas: undefined },
    )
    expect(d).toMatchObject({ comensal: null, curso: null, notas: null, cantidad: 1 })
  })
})

describe('proyección de un pedido para llevar (sin mesa, con número del día)', () => {
  it('lleva canal, número del día y ningún mesaId; los agotados no lo estorban', () => {
    const p = nuevoId()
    const locales = [
      local('PedidoAbierto', p, { canal: 'para_llevar', mesa_id: null, comensales: 1 }),
      conSecuencia(marca('ProductoAgotado', nuevoId()), 7),
      local('ItemAgregado', p, item({ precio_unitario: 12_000 })),
    ]
    const [v] = pedidosAbiertos(locales)
    expect(v?.estado.canal).toBe('para_llevar')
    expect(v?.estado.mesaId).toBeNull()
    expect(v?.estado.numeroDia).toBe(1)
    expect(v?.total).toBe(12_000)
    expect(estadoMesa(v ? [v] : [])).toBe('tomando')
  })

  it('sin confirmar todavía no tiene número del día; al confirmarse lo recibe del hub', () => {
    const p = nuevoId()
    const abierto = local(
      'PedidoAbierto',
      p,
      { canal: 'para_llevar', mesa_id: null, comensales: 1 },
      'pendiente',
    )
    expect(pedidosAbiertos([abierto])[0]?.estado.numeroDia).toBeNull()
    expect(pedidosAbiertos([abierto])[0]?.porConfirmar).toBe(true)

    const confirmado = {
      ...abierto,
      estado: 'confirmado' as const,
      evento: {
        ...abierto.evento,
        secuencia: 4,
        recibido_en: '2026-10-24T15:00:00.000Z',
        dia_operativo: '2026-10-24',
        asignaciones: { numero_dia: 12 },
        afecta: [],
        autorizado_por_id: null,
      } as EventoAplicable,
    }
    expect(pedidosAbiertos([confirmado])[0]?.estado.numeroDia).toBe(12)
  })

  it('dos pedidos para llevar y uno de salón se distinguen; los de producto nunca aparecen como pedido', () => {
    const [a, b, c] = [nuevoId(), nuevoId(), nuevoId()]
    const x = nuevoId()
    const mesa = nuevoId()
    const vistos: PedidoVisible[] = pedidosAbiertos([
      local('PedidoAbierto', a, { canal: 'para_llevar', mesa_id: null, comensales: 1 }),
      local('PedidoAbierto', b, { canal: 'domicilio', mesa_id: null, comensales: 1 }),
      local('PedidoAbierto', c, { canal: 'salon', mesa_id: mesa, comensales: 2 }),
      marca('ProductoAgotado', x),
      marca('ProductoDisponible', x),
    ])
    expect(vistos.map((v) => v.estado.canal).sort()).toEqual(['domicilio', 'para_llevar', 'salon'])
    expect(vistos.map((v) => v.estado.id)).not.toContain(x)
    expect(vistos.find((v) => v.estado.canal === 'salon')?.estado.mesaId).toBe(mesa)
    expect(vistos.filter((v) => v.estado.mesaId === null)).toHaveLength(2)
  })
})
