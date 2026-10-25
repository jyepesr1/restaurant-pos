import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { nuevoId } from '@pos/core'
import { HubSync } from '@pos/sync'
import { AlmacenSqlite } from '@pos/sync/sqlite'
import { describe, expect, it } from 'vitest'
import { montarAcceso } from './acceso/montaje'
import { actualizarVersionado } from './acceso/registros'
import { leerCatalogo } from './catalogo'
import { HistorialCatalogo, revisorPrecios } from './precios'
import { leerCarta } from './seed/carta'
import { sembrar } from './seed/sembrar'

// El precio copiado se compara con el catálogo en la versión que vio el equipo, sobre la carta
// real del piloto (docs/DINERO.md#precio-copiado).

const CARTA = leerCarta(
  readFileSync(
    fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
    'utf8',
  ),
)

function montar() {
  const m = montarAcceso()
  sembrar(
    m.db,
    m.acceso,
    { restauranteId: m.restauranteId, roles: m.roles, carta: CARTA, sinPersonal: true },
    m.reloj(),
  )
  const catalogo = leerCatalogo(m.db, m.restauranteId)
  const productos = catalogo.categorias.flatMap((c) => c.productos)
  const producto = (nombre: string) => {
    const p = productos.find((x) => x.nombre === nombre)
    if (!p) throw new Error(`No está ${nombre}`)
    return p
  }
  const historial = new HistorialCatalogo(m.db, m.restauranteId)
  return { ...m, catalogo, producto, historial }
}

type Montaje = ReturnType<typeof montar>
type Producto = ReturnType<Montaje['producto']>

const datos = (m: Montaje, p: Producto, campos: Record<string, unknown> = {}) => ({
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
  catalogo_version: m.catalogo.version,
  precio_canal_id: null,
  ...campos,
})

const item = (d: ReturnType<typeof datos>) =>
  ({ tipo: 'ItemAgregado', datos: d }) as Parameters<HistorialCatalogo['diferencia']>[0]

describe('precio copiado contra el historial del catálogo', () => {
  it('un ítem igual a la carta no tiene diferencias', () => {
    const m = montar()
    expect(m.historial.diferencia(item(datos(m, m.producto('Burrata Spritz'))))).toBeNull()
  })

  it('con copa y botella: exige la variante y su precio, no el del producto', () => {
    const m = montar()
    const vino = m.producto('Ramón Bilbao Crianza')
    const [copa, botella] = vino.variantes as [Producto['variantes'][0], Producto['variantes'][0]]
    expect(m.historial.diferencia(item(datos(m, vino)))).toMatch(/sin elegir una de sus opciones/)
    const conBotella = datos(m, vino, { variante_id: botella.id, precio_unitario: botella.precio })
    expect(m.historial.diferencia(item(conBotella))).toBeNull()
    // La botella cobrada al precio de la copa.
    const barata = datos(m, vino, { variante_id: botella.id, precio_unitario: copa.precio })
    expect(m.historial.diferencia(item(barata))).toMatch(/se cobró a \$/)
  })

  it('una variante en un producto sin variantes, o de otro producto, no cuadra', () => {
    const m = montar()
    const vino = m.producto('Ramón Bilbao Crianza')
    const pizza = m.producto('Burrata Spritz')
    const ajena = datos(m, pizza, { variante_id: vino.variantes[0]?.id })
    expect(m.historial.diferencia(item(ajena))).toMatch(/opción que el producto no tiene/)
  })

  it('el precio, el impuesto y los extras se comparan', () => {
    const m = montar()
    const tagliata = m.producto('Tagliata di Manzo')
    const termino = tagliata.grupos[0]?.opciones[0]
    if (!termino) throw new Error('La Tagliata debe tener término')
    const conTermino = (precio_extra: number) =>
      datos(m, tagliata, {
        modificadores: [{ modificador_id: termino.id, nombre: termino.nombre, precio_extra }],
      })
    expect(m.historial.diferencia(item(conTermino(termino.precioExtra)))).toBeNull()
    expect(m.historial.diferencia(item(conTermino(termino.precioExtra + 500)))).toMatch(
      /La opción «.+» se cobró/,
    )
    const otroImpuesto = datos(m, tagliata, { tarifa: 1900 })
    expect(m.historial.diferencia(item(otroImpuesto))).toMatch(/impuesto/)
    const masBarato = datos(m, tagliata, { precio_unitario: tagliata.precio - 100 })
    expect(m.historial.diferencia(item(masBarato))).toMatch(/la carta decía/)
    const fantasma = datos(m, tagliata, {
      modificadores: [{ modificador_id: nuevoId(), nombre: 'Trufa', precio_extra: 0 }],
    })
    expect(m.historial.diferencia(item(fantasma))).toMatch(/no estaba en la carta/)
  })

  it('cuenta la versión que vio el equipo: el precio de antes vale con la versión de antes', () => {
    const m = montar()
    const burrata = m.producto('Burrata Spritz')
    const antes = m.catalogo.version
    actualizarVersionado(
      m.db,
      'producto',
      m.restauranteId,
      burrata.id,
      { precio: burrata.precio + 2_000 },
      { usuarioId: null, dispositivoId: null },
      m.reloj(),
    )
    const despues = m.historial.versionActual()
    expect(despues).toBeGreaterThan(antes)
    // Equipo sin conexión con la carta vieja: su precio era el correcto.
    expect(m.historial.diferencia(item(datos(m, burrata)))).toBeNull()
    // Con la carta nueva, el precio viejo ya no cuadra.
    const tarde = datos(m, burrata, { catalogo_version: despues })
    expect(m.historial.diferencia(item(tarde))).toMatch(/la carta decía/)
    const nuevo = datos(m, burrata, {
      catalogo_version: despues,
      precio_unitario: burrata.precio + 2_000,
    })
    expect(m.historial.diferencia(item(nuevo))).toBeNull()
  })

  it('un producto archivado o una versión que el hub no tiene no cuadran', () => {
    const m = montar()
    const burrata = m.producto('Burrata Spritz')
    expect(
      m.historial.diferencia(item(datos(m, burrata, { catalogo_version: m.catalogo.version + 1 }))),
    ).toMatch(/versión del catálogo/)
    actualizarVersionado(
      m.db,
      'producto',
      m.restauranteId,
      burrata.id,
      { activo: 0 },
      { usuarioId: null, dispositivoId: null },
      m.reloj(),
    )
    const v = m.historial.versionActual()
    expect(m.historial.diferencia(item(datos(m, burrata, { catalogo_version: v })))).toMatch(
      /no estaba en la carta/,
    )
    expect(m.historial.diferencia(item(datos(m, burrata, { catalogo_version: 0 })))).toMatch(
      /no estaba en la carta/,
    )
  })

  it('una opción de otro producto, repetida o un precio especial no cuadran', () => {
    const m = montar()
    const tagliata = m.producto('Tagliata di Manzo')
    const te = m.producto('Té Hatsu')
    const sabor = te.grupos[0]?.opciones[0]
    const termino = tagliata.grupos[0]?.opciones[0]
    if (!sabor || !termino) throw new Error('falta')
    const mod = (o: { id: string; nombre: string; precioExtra: number }) => ({
      modificador_id: o.id,
      nombre: o.nombre,
      precio_extra: o.precioExtra,
    })
    expect(
      m.historial.diferencia(item(datos(m, tagliata, { modificadores: [mod(sabor)] }))),
    ).toMatch(/no es de «Tagliata/)
    expect(
      m.historial.diferencia(
        item(datos(m, tagliata, { modificadores: [mod(termino), mod(termino)] })),
      ),
    ).toMatch(/dos veces/)
    expect(
      m.historial.diferencia(
        item(datos(m, tagliata, { modificadores: [mod(termino)], precio_canal_id: nuevoId() })),
      ),
    ).toMatch(/precio especial/)
  })

  it('un impuesto archivado no cuadra', () => {
    const m = montar()
    const burrata = m.producto('Burrata Spritz')
    const impuesto = String(
      m.db.prepare('SELECT impuesto_id FROM producto WHERE id = ?').get(burrata.id)?.impuesto_id,
    )
    actualizarVersionado(
      m.db,
      'impuesto',
      m.restauranteId,
      impuesto,
      { activo: 0 },
      { usuarioId: null, dispositivoId: null },
      m.reloj(),
    )
    const v = m.historial.versionActual()
    expect(m.historial.diferencia(item(datos(m, burrata, { catalogo_version: v })))).toMatch(
      /impuesto/,
    )
  })

  it('en el hub: el ítem con precio distinto se acepta y queda como conflicto', () => {
    const m = montar()
    const hub = new HubSync(new AlmacenSqlite(m.db, m.restauranteId), {
      restauranteId: m.restauranteId,
      zonaHoraria: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      instancia: 'hub-1',
      reloj: m.reloj,
      acceso: {
        verificar: () => ({ ok: true, autorizadoPorId: null, autorizacionId: null }),
        registrarUso: () => {},
      },
      precios: revisorPrecios(m.db, m.restauranteId),
    })
    const { conexion } = m.emparejar('mesero')
    const pedido = nuevoId()
    const burrata = m.producto('Burrata Spritz')
    const sobre = (tipo: string, d: unknown, secuencia_base: number) => ({
      id: nuevoId(),
      tipo,
      version_esquema: 1,
      agregado_tipo: 'pedido',
      agregado_id: pedido,
      relacionados: [],
      datos: d,
      sesion_id: null,
      usuario_id: nuevoId(),
      dispositivo_id: conexion.dispositivoId,
      autorizacion_id: null,
      motivo: null,
      hora_dispositivo: m.reloj(),
      hora_estimada_hub: m.reloj(),
      secuencia_base,
    })
    const r = hub.recibirLote(conexion, [
      sobre('PedidoAbierto', { canal: 'salon', mesa_id: null, comensales: 2 }, 0),
      sobre('ItemAgregado', datos(m, burrata), 1),
      sobre('ItemAgregado', datos(m, burrata, { precio_unitario: 1_000 }), 1),
    ])
    expect(r.resultados.map((x) => x.estado)).toEqual(['confirmado', 'confirmado', 'confirmado'])
    expect(r.resultados.map((x) => (x as { conflicto?: string | null }).conflicto ?? null)).toEqual(
      [null, null, 'precio_distinto'],
    )
    expect(hub.conflictos()).toEqual([
      expect.objectContaining({
        tipo: 'precio_distinto',
        descripcion: expect.stringMatching(/\$1\.000/),
      }),
    ])
  })
})
