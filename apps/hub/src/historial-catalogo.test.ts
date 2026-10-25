import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { type Autor, actualizarVersionado, insertarVersionado } from './acceso/registros'
import { HistorialCatalogo, revisorPrecios } from './precios'
import { montarCarta } from './pruebas-catalogo'

// El historial del catálogo y la revisión del precio copiado cuando el catálogo cambió entre la
// versión que vio el equipo y la que tiene el hub (docs/DINERO.md#precio-copiado).

const AUTOR: Autor = { usuarioId: null, dispositivoId: null }

function montar() {
  const m = montarCarta()
  const historial = new HistorialCatalogo(m.db, m.restauranteId)
  const cambiar = (tabla: string, id: string, campos: Record<string, string | number | null>) => {
    actualizarVersionado(m.db, tabla, m.restauranteId, id, campos, AUTOR, m.reloj())
    return historial.versionActual()
  }
  const crear = (tabla: string, campos: Record<string, string | number | null>) => {
    const id = insertarVersionado(m.db, tabla, m.restauranteId, campos, AUTOR, m.reloj())
    return { id, version: historial.versionActual() }
  }
  const datos = (p: ReturnType<typeof m.producto>, campos: Record<string, unknown> = {}) => ({
    item_id: nuevoId(),
    producto_id: p.id,
    variante_id: null as string | null,
    nombre: p.nombre,
    precio_unitario: p.precio,
    impuesto_tipo: p.impuesto.tipo,
    tarifa: p.impuesto.tarifa,
    cantidad: 1,
    comensal: null,
    curso: null,
    modificadores: [] as { modificador_id: string; nombre: string; precio_extra: number }[],
    notas: null,
    catalogo_version: historial.versionActual(),
    precio_canal_id: null,
    ...campos,
  })
  const diferencia = (d: ReturnType<typeof datos>) =>
    historial.diferencia({ tipo: 'ItemAgregado', datos: d } as Parameters<
      HistorialCatalogo['diferencia']
    >[0])
  return { ...m, historial, cambiar, crear, datos, diferencia }
}

describe('historial con muchos cambios del mismo registro', () => {
  it('cada versión devuelve el precio que tenía, y entre versiones el último anterior', () => {
    const m = montar()
    const burrata = m.producto('Burrata Spritz')
    const versiones: { version: number; precio: number }[] = [
      { version: m.historial.versionActual(), precio: burrata.precio },
    ]
    for (let i = 1; i <= 300; i++) {
      const precio = burrata.precio + i * 100
      versiones.push({ version: m.cambiar('producto', burrata.id, { precio }), precio })
      // Un cambio de otro registro en medio: la versión avanza sin tocar la burrata.
      if (i % 7 === 0) m.crear('estacion', { nombre: `Estación ${i}`, orden: i })
    }
    for (const { version, precio } of versiones)
      expect(m.historial.estadoEn('producto', burrata.id, version)?.precio, `v${version}`).toBe(
        precio,
      )
    // Una versión entre dos cambios del producto vale lo del cambio anterior.
    const [a, b] = [versiones[7], versiones[8]]
    if (!a || !b) throw new Error('falta')
    for (let v = a.version; v < b.version; v++)
      expect(m.historial.estadoEn('producto', burrata.id, v)?.precio).toBe(a.precio)
  })

  it('cada fila guarda como "antes" el "después" de la anterior y las versiones solo suben', () => {
    const m = montar()
    const burrata = m.producto('Burrata Spritz')
    for (let i = 1; i <= 120; i++) m.cambiar('producto', burrata.id, { precio: 1_000 + i })
    const filas = m.db
      .prepare('SELECT * FROM catalogo_cambio WHERE registro_id = ? ORDER BY version')
      .all(burrata.id)
    expect(filas).toHaveLength(121)
    expect(filas[0]?.antes).toBeNull()
    for (let i = 1; i < filas.length; i++) {
      expect(filas[i]?.antes).toBe(filas[i - 1]?.despues)
      expect(Number(filas[i]?.version)).toBeGreaterThan(Number(filas[i - 1]?.version))
    }
    const todas = m.db.prepare('SELECT version FROM catalogo_cambio').all()
    expect(new Set(todas.map((f) => f.version)).size).toBe(todas.length)
  })

  it('antes de que el registro existiera no hay estado', () => {
    const m = montar()
    const { id, version } = m.crear('estacion', { nombre: 'Nueva', orden: 9 })
    expect(m.historial.estadoEn('estacion', id, version - 1)).toBeUndefined()
    expect(m.historial.estadoEn('estacion', id, 0)).toBeUndefined()
    expect(m.historial.estadoEn('estacion', id, version)?.nombre).toBe('Nueva')
    expect(m.historial.estadoEn('estacion', nuevoId(), version)).toBeUndefined()
    // Con la entidad equivocada, el mismo id no existe.
    expect(m.historial.estadoEn('producto', id, version)).toBeUndefined()
  })

  it('los registros de otro restaurante no se mezclan', () => {
    const m = montar()
    const otro = new HistorialCatalogo(m.db, nuevoId())
    const burrata = m.producto('Burrata Spritz')
    expect(otro.estadoEn('producto', burrata.id, m.historial.versionActual())).toBeUndefined()
    expect(otro.versionActual()).toBe(0)
  })

  it('el historial con el catálogo migrado coincide con lo que tiene cada tabla hoy', () => {
    const m = montar()
    for (const p of m.catalogo().categorias.flatMap((c) => c.productos)) {
      const fila = m.db.prepare('SELECT * FROM producto WHERE id = ?').get(p.id)
      expect(m.historial.estadoEn('producto', p.id, m.historial.versionActual())).toEqual(fila)
    }
  })
})

describe('precio_distinto con el catálogo cambiado después', () => {
  it('una variante archivada después: el ítem viejo cuadra, el nuevo ya no', () => {
    const m = montar()
    const vino = m.producto('Ramón Bilbao Crianza')
    const [copa, botella] = vino.variantes
    if (!copa || !botella) throw new Error('falta')
    const viejo = (extra = {}) =>
      m.datos(vino, { variante_id: botella.id, precio_unitario: botella.precio, ...extra })
    const versionVieja = m.historial.versionActual()
    expect(m.diferencia(viejo())).toBeNull()

    const v = m.cambiar('variante', botella.id, { activo: 0 })
    // El equipo que seguía con la carta de antes vendió la botella: cuadra con su versión.
    expect(m.diferencia(viejo({ catalogo_version: versionVieja }))).toBeNull()
    // Con la versión en la que ya estaba archivada, la botella no existe.
    expect(m.diferencia(viejo({ catalogo_version: v }))).toMatch(/sin elegir una de sus opciones/)
    // La copa sigue.
    expect(
      m.diferencia(
        m.datos(vino, { variante_id: copa.id, precio_unitario: copa.precio, catalogo_version: v }),
      ),
    ).toBeNull()
  })

  it('archivar todas las variantes: el producto vuelve a venderse sin opción', () => {
    const m = montar()
    const vino = m.producto('Ramón Bilbao Crianza')
    let v = 0
    for (const variante of vino.variantes) v = m.cambiar('variante', variante.id, { activo: 0 })
    expect(m.diferencia(m.datos(vino, { catalogo_version: v }))).toBeNull()
    expect(
      m.diferencia(m.datos(vino, { variante_id: vino.variantes[0]?.id, catalogo_version: v })),
    ).toMatch(/opción que el producto no tiene/)
  })

  it('una variante que cambió de precio entre versiones', () => {
    const m = montar()
    const vino = m.producto('Ramón Bilbao Crianza')
    const botella = vino.variantes[1]
    if (!botella) throw new Error('falta')
    const antes = m.historial.versionActual()
    const despues = m.cambiar('variante', botella.id, { precio: botella.precio + 10_000 })
    const item = (precio: number, catalogo_version: number) =>
      m.datos(vino, { variante_id: botella.id, precio_unitario: precio, catalogo_version })
    expect(m.diferencia(item(botella.precio, antes))).toBeNull()
    expect(m.diferencia(item(botella.precio + 10_000, antes))).toMatch(/la carta decía/)
    expect(m.diferencia(item(botella.precio, despues))).toMatch(/la carta decía/)
    expect(m.diferencia(item(botella.precio + 10_000, despues))).toBeNull()
  })

  it('una variante creada después: con la versión vieja el producto no pedía opción', () => {
    const m = montar()
    const pizza = m.producto('Burrata Spritz')
    const antes = m.historial.versionActual()
    const nueva = m.crear('variante', {
      producto_id: pizza.id,
      nombre: 'Familiar',
      precio: 90_000,
      orden: 0,
    })
    expect(m.diferencia(m.datos(pizza, { catalogo_version: antes }))).toBeNull()
    expect(m.diferencia(m.datos(pizza, { catalogo_version: nueva.version }))).toMatch(
      /sin elegir una de sus opciones/,
    )
    expect(
      m.diferencia(
        m.datos(pizza, {
          catalogo_version: nueva.version,
          variante_id: nueva.id,
          precio_unitario: 90_000,
        }),
      ),
    ).toBeNull()
    // La variante todavía no existía en la versión vieja.
    expect(
      m.diferencia(
        m.datos(pizza, { catalogo_version: antes, variante_id: nueva.id, precio_unitario: 90_000 }),
      ),
    ).toMatch(/opción que el producto no tiene/)
  })

  it('un modificador que cambió de precio entre versiones', () => {
    const m = montar()
    const tagliata = m.producto('Tagliata di Manzo')
    const opcion = tagliata.grupos[0]?.opciones[0]
    if (!opcion) throw new Error('falta')
    const antes = m.historial.versionActual()
    const despues = m.cambiar('modificador', opcion.id, {
      precio_extra: opcion.precioExtra + 2_500,
    })
    const item = (extra: number, catalogo_version: number) =>
      m.datos(tagliata, {
        catalogo_version,
        modificadores: [{ modificador_id: opcion.id, nombre: opcion.nombre, precio_extra: extra }],
      })
    expect(m.diferencia(item(opcion.precioExtra, antes))).toBeNull()
    expect(m.diferencia(item(opcion.precioExtra, despues))).toMatch(/La opción «.+» se cobró/)
    expect(m.diferencia(item(opcion.precioExtra + 2_500, despues))).toBeNull()
    expect(m.diferencia(item(opcion.precioExtra + 2_500, antes))).toMatch(/La opción «.+» se cobró/)
  })

  it('un modificador archivado después ya no estaba en la carta; antes sí', () => {
    const m = montar()
    const tagliata = m.producto('Tagliata di Manzo')
    const opcion = tagliata.grupos[0]?.opciones[0]
    if (!opcion) throw new Error('falta')
    const antes = m.historial.versionActual()
    const despues = m.cambiar('modificador', opcion.id, { activo: 0 })
    const item = (catalogo_version: number) =>
      m.datos(tagliata, {
        catalogo_version,
        modificadores: [
          { modificador_id: opcion.id, nombre: opcion.nombre, precio_extra: opcion.precioExtra },
        ],
      })
    expect(m.diferencia(item(antes))).toBeNull()
    expect(m.diferencia(item(despues))).toMatch(/no estaba en la carta/)
  })

  it('un impuesto cambiado: la tarifa vieja vale con la versión vieja', () => {
    const m = montar()
    const pizza = m.producto('Burrata Spritz')
    const impuestoId = String(
      m.db.prepare('SELECT impuesto_id FROM producto WHERE id = ?').get(pizza.id)?.impuesto_id,
    )
    const antes = m.historial.versionActual()
    const despues = m.cambiar('impuesto', impuestoId, { tarifa: pizza.impuesto.tarifa + 100 })
    expect(m.diferencia(m.datos(pizza, { catalogo_version: antes }))).toBeNull()
    expect(m.diferencia(m.datos(pizza, { catalogo_version: despues }))).toMatch(/impuesto/)
    expect(
      m.diferencia(
        m.datos(pizza, { catalogo_version: despues, tarifa: pizza.impuesto.tarifa + 100 }),
      ),
    ).toBeNull()
  })

  it('un producto que cambió de impuesto (otro registro) también se detecta', () => {
    const m = montar()
    const pizza = m.producto('Burrata Spritz')
    const exento = m.crear('impuesto', { nombre: 'Exento', tipo: 'exento', tarifa: 0 })
    const antes = m.historial.versionActual()
    const despues = m.cambiar('producto', pizza.id, { impuesto_id: exento.id })
    expect(m.diferencia(m.datos(pizza, { catalogo_version: antes }))).toBeNull()
    expect(m.diferencia(m.datos(pizza, { catalogo_version: despues }))).toMatch(/impuesto/)
    expect(
      m.diferencia(
        m.datos(pizza, { catalogo_version: despues, impuesto_tipo: 'exento', tarifa: 0 }),
      ),
    ).toBeNull()
  })

  it('el tipo de impuesto distinto con la misma tarifa tampoco cuadra', () => {
    const m = montar()
    const pizza = m.producto('Burrata Spritz')
    const otroTipo = pizza.impuesto.tipo === 'inc' ? 'iva' : 'inc'
    expect(m.diferencia(m.datos(pizza, { impuesto_tipo: otroTipo }))).toMatch(/impuesto/)
  })

  it('un producto creado después de la versión del ítem no estaba en la carta', () => {
    const m = montar()
    const base = m.producto('Burrata Spritz')
    const impuesto = String(
      m.db.prepare('SELECT impuesto_id FROM producto WHERE id = ?').get(base.id)?.impuesto_id,
    )
    const categoria = String(
      m.db.prepare('SELECT categoria_id FROM producto WHERE id = ?').get(base.id)?.categoria_id,
    )
    const antes = m.historial.versionActual()
    const nuevo = m.crear('producto', {
      categoria_id: categoria,
      nombre: 'Postre nuevo',
      precio: 15_000,
      impuesto_id: impuesto,
    })
    const comoLoVeria = (catalogo_version: number) => ({
      ...m.datos(base, { catalogo_version }),
      producto_id: nuevo.id,
      nombre: 'Postre nuevo',
      precio_unitario: 15_000,
    })
    expect(m.diferencia(comoLoVeria(antes))).toMatch(/no estaba en la carta/)
    expect(m.diferencia(comoLoVeria(nuevo.version - 1))).toMatch(/no estaba en la carta/)
    expect(m.diferencia(comoLoVeria(nuevo.version))).toBeNull()
  })

  it('archivado y reactivado: cuadra antes y después, no en el hueco', () => {
    const m = montar()
    const pizza = m.producto('Burrata Spritz')
    const antes = m.historial.versionActual()
    const archivado = m.cambiar('producto', pizza.id, { activo: 0 })
    const reactivado = m.cambiar('producto', pizza.id, { activo: 1 })
    expect(m.diferencia(m.datos(pizza, { catalogo_version: antes }))).toBeNull()
    expect(m.diferencia(m.datos(pizza, { catalogo_version: archivado }))).toMatch(
      /no estaba en la carta/,
    )
    expect(m.diferencia(m.datos(pizza, { catalogo_version: reactivado }))).toBeNull()
  })

  it('una versión del futuro que el hub no tiene se marca, sea cual sea el producto', () => {
    const m = montar()
    const pizza = m.producto('Burrata Spritz')
    const futura = m.historial.versionActual() + 1
    expect(m.diferencia(m.datos(pizza, { catalogo_version: futura }))).toMatch(
      /versión del catálogo/,
    )
    expect(m.diferencia(m.datos(pizza, { catalogo_version: Number.MAX_SAFE_INTEGER }))).toMatch(
      /versión del catálogo/,
    )
  })

  it('un producto_id que en realidad es otra cosa del catálogo se marca', () => {
    const m = montar()
    const pizza = m.producto('Burrata Spritz')
    const vino = m.producto('Ramón Bilbao Crianza')
    const variante = vino.variantes[0]
    const grupo = m.producto('Tagliata di Manzo').grupos[0]
    if (!variante || !grupo) throw new Error('falta')
    for (const id of [variante.id, grupo.id, grupo.opciones[0]?.id, nuevoId()])
      expect(m.diferencia(m.datos(pizza, { producto_id: id })), String(id)).not.toBeNull()
  })

  it('con un modificador repetido', () => {
    const m = montar()
    const tagliata = m.producto('Tagliata di Manzo')
    const opcion = tagliata.grupos[0]?.opciones[0]
    if (!opcion) throw new Error('falta')
    const mod = {
      modificador_id: opcion.id,
      nombre: opcion.nombre,
      precio_extra: opcion.precioExtra,
    }
    expect(m.diferencia(m.datos(tagliata, { modificadores: [mod] }))).toBeNull()
    expect(m.diferencia(m.datos(tagliata, { modificadores: [mod, mod] }))).toMatch(
      /viene dos veces/,
    )
  })

  it('revisorPrecios solo mira los ItemAgregado', () => {
    const m = montar()
    const revisor = revisorPrecios(m.db, m.restauranteId)
    const pizza = m.producto('Burrata Spritz')
    const malo = m.datos(pizza, { precio_unitario: 1 })
    expect(revisor.revisar({ tipo: 'ItemAgregado', datos: malo } as never)).toMatch(
      /la carta decía/,
    )
    expect(revisor.revisar({ tipo: 'PedidoAbierto', datos: {} } as never)).toBeNull()
  })

  it('un ítem con 200 cambios de precio después sigue comparando contra su versión', () => {
    const m = montar()
    const pizza = m.producto('Burrata Spritz')
    const vistaPorElEquipo = m.historial.versionActual()
    for (let i = 1; i <= 200; i++) m.cambiar('producto', pizza.id, { precio: pizza.precio + i })
    expect(m.diferencia(m.datos(pizza, { catalogo_version: vistaPorElEquipo }))).toBeNull()
    expect(m.diferencia(m.datos(pizza))).toMatch(/la carta decía/)
  })

  it('un precio especial (precio_canal_id) se marca: todavía no existen', () => {
    const m = montar()
    const pizza = m.producto('Burrata Spritz')
    expect(m.diferencia(m.datos(pizza, { precio_canal_id: nuevoId() }))).toMatch(/precio especial/)
  })

  it('un impuesto archivado después no cuadra con la versión nueva, sí con la vieja', () => {
    const m = montar()
    const pizza = m.producto('Burrata Spritz')
    const impuestoId = String(
      m.db.prepare('SELECT impuesto_id FROM producto WHERE id = ?').get(pizza.id)?.impuesto_id,
    )
    const antes = m.historial.versionActual()
    const despues = m.cambiar('impuesto', impuestoId, { activo: 0 })
    expect(m.diferencia(m.datos(pizza, { catalogo_version: antes }))).toBeNull()
    expect(m.diferencia(m.datos(pizza, { catalogo_version: despues }))).toMatch(/impuesto/)
  })

  it('una opción de un grupo archivado, o de un producto que no tiene ese grupo, se marca', () => {
    const m = montar()
    const tagliata = m.producto('Tagliata di Manzo')
    const grupo = tagliata.grupos[0]
    const opcion = grupo?.opciones[0]
    if (!grupo || !opcion) throw new Error('falta')
    const conOpcion = (p: ReturnType<typeof m.producto>, catalogo_version?: number) =>
      m.datos(p, {
        ...(catalogo_version === undefined ? {} : { catalogo_version }),
        modificadores: [
          { modificador_id: opcion.id, nombre: opcion.nombre, precio_extra: opcion.precioExtra },
        ],
      })
    // De otro producto.
    expect(m.diferencia(conOpcion(m.producto('Burrata Spritz')))).toMatch(/no es de/)
    // Del grupo archivado después: antes valía.
    const antes = m.historial.versionActual()
    const despues = m.cambiar('grupo_modificador', grupo.id, { activo: 0 })
    expect(m.diferencia(conOpcion(tagliata, antes))).toBeNull()
    expect(m.diferencia(conOpcion(tagliata, despues))).toMatch(/no es de/)
  })

  it('una opción cuyo enlace con el producto se archivó después valía con la versión anterior', () => {
    const m = montar()
    const tagliata = m.producto('Tagliata di Manzo')
    const opcion = tagliata.grupos[0]?.opciones[0]
    if (!opcion) throw new Error('falta')
    const enlace = String(
      m.db
        .prepare('SELECT id FROM producto_grupo_modificador WHERE producto_id = ?')
        .get(tagliata.id)?.id,
    )
    const antes = m.historial.versionActual()
    const despues = m.cambiar('producto_grupo_modificador', enlace, { activo: 0 })
    const item = (catalogo_version: number) =>
      m.datos(tagliata, {
        catalogo_version,
        modificadores: [
          { modificador_id: opcion.id, nombre: opcion.nombre, precio_extra: opcion.precioExtra },
        ],
      })
    expect(m.diferencia(item(antes))).toBeNull()
    expect(m.diferencia(item(despues))).toMatch(/no es de/)
  })
})

describe('historial_desde: lo anterior a la migración', () => {
  it('antes de esa versión se usa el estado más viejo conocido, no "no existía"', () => {
    const m = montar()
    const burrata = m.producto('Burrata Spritz')
    const creada = Number(
      m.db
        .prepare('SELECT version FROM catalogo_cambio WHERE registro_id = ? AND antes IS NULL')
        .get(burrata.id)?.version,
    )
    const v = m.cambiar('producto', burrata.id, { precio: burrata.precio + 500 })
    // Sin `historial_desde`, una versión anterior a su alta no lo conoce.
    expect(m.historial.estadoEn('producto', burrata.id, creada - 1)).toBeUndefined()
    // La migración de una base vieja deja ese contador: lo anterior toma el estado más viejo.
    m.db
      .prepare(
        "INSERT INTO contador (restaurante_id, nombre, valor) VALUES (?, 'historial_desde', ?)",
      )
      .run(m.restauranteId, v)
    expect(m.historial.estadoEn('producto', burrata.id, creada - 1)?.precio).toBe(burrata.precio)
    expect(m.historial.estadoEn('producto', burrata.id, v - 1)?.precio).toBe(burrata.precio)
    // Desde esa versión ya hay historial completo.
    expect(m.historial.estadoEn('producto', burrata.id, v)?.precio).toBe(burrata.precio + 500)
    // Lo que no existe en ninguna versión sigue sin existir.
    expect(m.historial.estadoEn('producto', nuevoId(), creada - 1)).toBeUndefined()
    // Un ítem de la versión vieja cuadra con el precio viejo.
    expect(m.diferencia(m.datos(burrata, { catalogo_version: creada - 1 }))).toBeNull()
  })
})
