import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { insertarVersionado, SISTEMA } from '../acceso/registros'
import { type Equipo, type MontajeImpresion, montarImpresion } from './montaje-impresion'

// Tarea 1.5 en la cocina (ADR-015): cancelar un pedido saca «ANULAR» de lo que tenía la cocina, y
// cambiar de mesa o mover productos saca «CAMBIO DE MESA» con la mesa nueva y «Antes: …».

function conImpresoras(t: MontajeImpresion) {
  return {
    cocina: t.impresoraNueva('Cocina', [t.cocina]),
    barra: t.impresoraNueva('Barra', [t.barra]),
  }
}

const trabajosTipo = (t: MontajeImpresion, tipo: string) =>
  t.trabajos().filter((f) => t.contenido(f).tipo === tipo)

/** El ítem movido tal como lo manda el equipo, tomado del pedido real. */
function movidoDe(t: MontajeImpresion, pedido: string, itemId: string) {
  const i = t.hub.pedido(pedido)?.items[itemId]
  if (!i) throw new Error('sin ítem')
  return {
    item: {
      item_id: i.id,
      producto_id: i.productoId,
      variante_id: i.varianteId,
      nombre: i.nombre,
      precio_unitario: i.precioUnitario,
      impuesto_tipo: i.impuestoTipo,
      tarifa: i.tarifa,
      cantidad: i.cantidad,
      comensal: i.comensal,
      curso: i.curso,
      modificadores: i.modificadores.map((m) => ({
        modificador_id: m.modificadorId,
        nombre: m.nombre,
        precio_extra: m.precioExtra,
      })),
      notas: i.notas,
    },
    estado: i.estado,
    cantidad_anulada: i.cantidadAnulada,
    agregado_por: i.agregadoPor,
  }
}

function mover(t: MontajeImpresion, e: Equipo, origen: string, destino: string, ids: string[]) {
  return e.mandar(
    origen,
    'ItemsMovidos',
    { pedido_destino_id: destino, items: ids.map((id) => movidoDe(t, origen, id)) },
    { relacionados: [destino] },
  )
}

const cancelar = (caja: Equipo, pedido: string) =>
  caja.mandar(pedido, 'PedidoCancelado', {}, { motivo: 'Error del mesero' })

describe('cancelar el pedido', () => {
  it('lo que tenía la cocina sale como ANULAR, una comanda por la que salió, con su número', async () => {
    const t = montarImpresion()
    const imp = conImpresoras(t)
    const ana = t.equipo('mesero')
    const caja = t.equipo('admin', 'caja')
    const { pedido, items } = t.pedidoCon(
      ana,
      [
        { nombre: 'Tagliata', estacion: t.cocina, cantidad: 2 },
        { nombre: 'Aperol Spritz', estacion: t.barra },
      ],
      t.mesa('5'),
    )
    t.enviar(ana, pedido, items)
    await t.cola.vuelta()
    expect(cancelar(caja, pedido).estado).toBe('confirmado')
    const anulaciones = trabajosTipo(t, 'anulacion')
    expect(anulaciones).toHaveLength(2)
    const porEstacion = Object.fromEntries(
      anulaciones.map((f) => [t.contenido(f).estacion, t.contenido(f)]),
    )
    expect(porEstacion.Cocina).toMatchObject({ destino: 'Mesa 5', numero: 1 })
    expect(porEstacion.Cocina.items).toMatchObject([{ nombre: 'Tagliata', cantidad: 2 }])
    expect(porEstacion.Barra.items).toMatchObject([{ nombre: 'Aperol Spritz', cantidad: 1 }])
    await t.cola.vuelta()
    expect(imp.cocina.papel.textos().at(-1)).toContain('ANULAR')
  })

  it('solo se anula lo que sigue en cocina: no lo entregado ni lo anulado, y las unidades que quedan', async () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const caja = t.equipo('admin', 'caja')
    const { pedido, items } = t.pedidoCon(
      ana,
      [
        { nombre: 'Tagliata', estacion: t.cocina, cantidad: 3 },
        { nombre: 'Risotto', estacion: t.cocina },
        { nombre: 'Pizza', estacion: t.cocina },
      ],
      t.mesa('5'),
    )
    t.enviar(ana, pedido, items)
    const [tagliata, risotto, pizza] = items
    ana.mandar(pedido, 'ItemEntregado', { item_ids: [risotto?.id] })
    caja.mandar(pedido, 'ItemAnulado', {
      item_id: tagliata?.id,
      cantidad: 1,
      ya_preparado: false,
      comanda_id: null,
    })
    caja.mandar(pedido, 'ItemAnulado', {
      item_id: pizza?.id,
      cantidad: 1,
      ya_preparado: false,
      comanda_id: null,
    })
    const antes = trabajosTipo(t, 'anulacion').length
    cancelar(caja, pedido)
    const nuevas = trabajosTipo(t, 'anulacion').slice(antes)
    expect(nuevas).toHaveLength(1)
    expect(t.contenido(nuevas[0]).items).toMatchObject([{ nombre: 'Tagliata', cantidad: 2 }])
  })

  it('sin nada en cocina (solo pendientes, entregados o un pedido vacío) no imprime nada', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const caja = t.equipo('admin', 'caja')
    const vacio = t.abrir(ana, t.mesa('1'))
    const pendientes = t.pedidoCon(ana, [{ nombre: 'Pizza', estacion: t.cocina }], t.mesa('2'))
    const entregado = t.pedidoCon(ana, [{ nombre: 'Risotto', estacion: t.cocina }], t.mesa('3'))
    t.enviar(ana, entregado.pedido, entregado.items)
    ana.mandar(entregado.pedido, 'ItemEntregado', { item_ids: [entregado.items[0]?.id] })
    const hechos = t.trabajos().length
    expect(cancelar(caja, vacio).estado).toBe('confirmado')
    expect(cancelar(caja, pendientes.pedido).estado).toBe('confirmado')
    expect(cancelar(caja, entregado.pedido).estado).toBe('confirmado')
    expect(t.trabajos()).toHaveLength(hechos)
    expect(t.fallosGuardar).toEqual([])
  })

  it('un platillo ya listo todavía se anula; una cancelación rechazada no imprime', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const caja = t.equipo('admin', 'caja')
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    t.enviar(ana, pedido, items)
    ana.mandar(pedido, 'ItemListo', { item_ids: [items[0]?.id] })
    // El mesero no puede cancelar: se rechaza y no hay comanda.
    expect(ana.mandar(pedido, 'PedidoCancelado', {}, { motivo: 'x' }).estado).toBe('rechazado')
    expect(trabajosTipo(t, 'anulacion')).toHaveLength(0)
    cancelar(caja, pedido)
    expect(trabajosTipo(t, 'anulacion')).toHaveLength(1)
  })

  it('lleva "Mesa 5 + 6" cuando el pedido tenía mesas unidas', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const caja = t.equipo('admin', 'caja')
    const [m5, m6] = [t.mesa('5'), t.mesa('6')]
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Pizza', estacion: t.cocina }], m5)
    ana.mandar(pedido, 'MesasUnidas', { mesa_ids: [m6] })
    t.enviar(ana, pedido, items)
    cancelar(caja, pedido)
    expect(t.contenido(trabajosTipo(t, 'anulacion')[0]).destino).toBe('Mesa 5 + 6')
  })
})

describe('cambiar de mesa (traslado)', () => {
  it('con platos en cocina, cada estación recibe CAMBIO DE MESA con la mesa nueva y «Antes: Mesa 5»', async () => {
    const t = montarImpresion()
    const imp = conImpresoras(t)
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(
      ana,
      [
        { nombre: 'Tagliata', estacion: t.cocina },
        { nombre: 'Aperol Spritz', estacion: t.barra },
      ],
      t.mesa('5'),
    )
    t.enviar(ana, pedido, items)
    await t.cola.vuelta()
    const m6 = t.mesa('6')
    expect(ana.mandar(pedido, 'PedidoMovidoDeMesa', { mesa_destino_id: m6 }).estado).toBe(
      'confirmado',
    )
    const traslados = trabajosTipo(t, 'traslado')
    expect(traslados).toHaveLength(2)
    for (const f of traslados)
      expect(t.contenido(f)).toMatchObject({ destino: 'Mesa 6', antes: 'Mesa 5' })
    await t.cola.vuelta()
    const texto = imp.cocina.papel.textos().at(-1) as string
    expect(texto).toContain('CAMBIO DE MESA')
    expect(texto).toContain('Antes: Mesa 5')
    expect(texto).toMatch(/Mesa 6 +#1/)
    expect(texto).toContain('1 x Tagliata')
  })

  it('conserva el número de la comanda original y no lleva la nota del pedido', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(
      ana,
      [{ nombre: 'Tagliata', estacion: t.cocina }],
      t.mesa('5'),
    )
    ana.mandar(pedido, 'NotaPedidoCambiada', { notas: 'alérgico al maní' })
    t.enviar(ana, pedido, items)
    ana.mandar(pedido, 'PedidoMovidoDeMesa', { mesa_destino_id: t.mesa('6') })
    const c = t.contenido(trabajosTipo(t, 'traslado')[0])
    expect(c.numero).toBe(1)
    expect(c.notaPedido ?? null).toBeNull()
  })

  it('nada en cocina, nada que avisar: pendientes, entregados y pedidos sin enviar no imprimen', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const a = t.pedidoCon(ana, [{ nombre: 'Pizza', estacion: t.cocina }], t.mesa('1'))
    const b = t.pedidoCon(ana, [{ nombre: 'Risotto', estacion: t.cocina }], t.mesa('2'))
    t.enviar(ana, b.pedido, b.items)
    ana.mandar(b.pedido, 'ItemEntregado', { item_ids: [b.items[0]?.id] })
    expect(
      ana.mandar(a.pedido, 'PedidoMovidoDeMesa', { mesa_destino_id: t.mesa('8') }).estado,
    ).toBe('confirmado')
    expect(
      ana.mandar(b.pedido, 'PedidoMovidoDeMesa', { mesa_destino_id: t.mesa('9') }).estado,
    ).toBe('confirmado')
    expect(trabajosTipo(t, 'traslado')).toHaveLength(0)
  })

  it('pasarse a la misma mesa no imprime', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const m5 = t.mesa('5')
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Pizza', estacion: t.cocina }], m5)
    t.enviar(ana, pedido, items)
    ana.mandar(pedido, 'PedidoMovidoDeMesa', { mesa_destino_id: m5 })
    expect(trabajosTipo(t, 'traslado')).toHaveLength(0)
  })

  it('con mesas unidas: «Antes: Mesa 5 + 6» y la nueva sigue con su grupo', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const [m5, m6, m7] = [t.mesa('5'), t.mesa('6'), t.mesa('7')]
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Pizza', estacion: t.cocina }], m5)
    ana.mandar(pedido, 'MesasUnidas', { mesa_ids: [m6] })
    t.enviar(ana, pedido, items)
    ana.mandar(pedido, 'PedidoMovidoDeMesa', { mesa_destino_id: m7 })
    expect(t.contenido(trabajosTipo(t, 'traslado')[0])).toMatchObject({
      antes: 'Mesa 5 + 6',
      destino: 'Mesa 7 + 6',
    })
  })

  it('pasarse a una de sus mesas unidas: la nueva es solo esa', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const [m5, m6] = [t.mesa('5'), t.mesa('6')]
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Pizza', estacion: t.cocina }], m5)
    ana.mandar(pedido, 'MesasUnidas', { mesa_ids: [m6] })
    t.enviar(ana, pedido, items)
    ana.mandar(pedido, 'PedidoMovidoDeMesa', { mesa_destino_id: m6 })
    expect(t.contenido(trabajosTipo(t, 'traslado')[0])).toMatchObject({
      antes: 'Mesa 5 + 6',
      destino: 'Mesa 6',
    })
  })

  it('unir o separar mesas sin cambiar la principal no avisa a la cocina', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const [m5, m6] = [t.mesa('5'), t.mesa('6')]
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Pizza', estacion: t.cocina }], m5)
    t.enviar(ana, pedido, items)
    const antes = t.trabajos().length
    ana.mandar(pedido, 'MesasUnidas', { mesa_ids: [m6] })
    ana.mandar(pedido, 'MesasSeparadas', { mesa_ids: [m6] })
    expect(t.trabajos()).toHaveLength(antes)
  })

  it('un pedido de barra que pasa a una mesa dice «Antes: Barra»', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(
      ana,
      [{ nombre: 'Pizza', estacion: t.cocina }],
      null,
      'barra',
    )
    t.enviar(ana, pedido, items)
    ana.mandar(pedido, 'PedidoMovidoDeMesa', { mesa_destino_id: t.mesa('4') })
    expect(t.contenido(trabajosTipo(t, 'traslado')[0])).toMatchObject({
      antes: 'Barra',
      destino: 'Mesa 4',
    })
  })
})

describe('mover productos (traslado)', () => {
  function origenConDosEstaciones() {
    const t = montarImpresion()
    const imp = conImpresoras(t)
    const ana = t.equipo('mesero')
    const m5 = t.mesa('5')
    const { pedido, items } = t.pedidoCon(
      ana,
      [
        { nombre: 'Tagliata', estacion: t.cocina },
        { nombre: 'Risotto', estacion: t.cocina },
        { nombre: 'Aperol Spritz', estacion: t.barra },
      ],
      m5,
    )
    t.enviar(ana, pedido, items)
    return { t, imp, ana, pedido, items, m5 }
  }

  it('a una mesa libre (pedido nuevo): solo lo movido sale, con el destino y «Antes: Mesa 5»', async () => {
    const { t, imp, ana, pedido, items } = origenConDosEstaciones()
    const destino = nuevoId()
    ana.mandar(destino, 'PedidoAbierto', { canal: 'salon', mesa_id: t.mesa('8'), comensales: 1 })
    expect(mover(t, ana, pedido, destino, [items[1]?.id as string]).estado).toBe('confirmado')
    const traslados = trabajosTipo(t, 'traslado')
    expect(traslados).toHaveLength(1)
    expect(t.contenido(traslados[0])).toMatchObject({
      estacion: 'Cocina',
      destino: 'Mesa 8',
      antes: 'Mesa 5',
      numero: 1,
    })
    expect(t.contenido(traslados[0]).items).toMatchObject([{ nombre: 'Risotto' }])
    await t.cola.vuelta()
    expect(imp.cocina.papel.textos().at(-1)).toContain('Antes: Mesa 5')
  })

  it('a un pedido que ya existe con productos: el destino es la mesa de ese pedido', () => {
    const { t, ana, pedido, items } = origenConDosEstaciones()
    const otro = t.pedidoCon(ana, [{ nombre: 'Pizza', estacion: t.cocina }], t.mesa('9'))
    mover(t, ana, pedido, otro.pedido, [items[0]?.id as string])
    expect(t.contenido(trabajosTipo(t, 'traslado')[0])).toMatchObject({
      destino: 'Mesa 9',
      antes: 'Mesa 5',
    })
    expect(t.contenido(trabajosTipo(t, 'traslado')[0]).items).toMatchObject([
      { nombre: 'Tagliata' },
    ])
  })

  it('un destino con mesas unidas se anuncia «Mesa 8 + 9»', () => {
    const { t, ana, pedido, items } = origenConDosEstaciones()
    const [m8, m9] = [t.mesa('8'), t.mesa('9')]
    const otro = t.pedidoCon(ana, [{ nombre: 'Pizza', estacion: t.cocina }], m8)
    ana.mandar(otro.pedido, 'MesasUnidas', { mesa_ids: [m9] })
    mover(t, ana, pedido, otro.pedido, [items[0]?.id as string])
    expect(t.contenido(trabajosTipo(t, 'traslado')[0]).destino).toBe('Mesa 8 + 9')
  })

  it('platos de dos estaciones: una comanda de traslado por la que salieron', () => {
    const { t, ana, pedido, items } = origenConDosEstaciones()
    const destino = nuevoId()
    ana.mandar(destino, 'PedidoAbierto', { canal: 'salon', mesa_id: t.mesa('8'), comensales: 1 })
    mover(
      t,
      ana,
      pedido,
      destino,
      items.map((i) => i.id),
    )
    const porEstacion = Object.fromEntries(
      trabajosTipo(t, 'traslado').map((f) => [
        t.contenido(f).estacion,
        t.contenido(f).items.length,
      ]),
    )
    expect(porEstacion).toEqual({ Cocina: 2, Barra: 1 })
  })

  it('lo pendiente o entregado que se mueve no avisa a la cocina; lo demás, sí', () => {
    const { t, ana, pedido, items } = origenConDosEstaciones()
    const pendiente = t.agregar(ana, pedido, { nombre: 'Pan', estacion: t.cocina })
    ana.mandar(pedido, 'ItemEntregado', { item_ids: [items[1]?.id] })
    const destino = nuevoId()
    ana.mandar(destino, 'PedidoAbierto', { canal: 'salon', mesa_id: t.mesa('8'), comensales: 1 })
    mover(t, ana, pedido, destino, [pendiente.id, items[1]?.id as string])
    expect(trabajosTipo(t, 'traslado')).toHaveLength(0)
    mover(t, ana, pedido, destino, [items[0]?.id as string])
    expect(trabajosTipo(t, 'traslado')).toHaveLength(1)
  })

  it('moverlo otra vez sigue encontrando la comanda de su envío original', () => {
    const { t, ana, pedido, items } = origenConDosEstaciones()
    const [uno, dos] = [nuevoId(), nuevoId()]
    ana.mandar(uno, 'PedidoAbierto', { canal: 'salon', mesa_id: t.mesa('8'), comensales: 1 })
    ana.mandar(dos, 'PedidoAbierto', { canal: 'salon', mesa_id: t.mesa('9'), comensales: 1 })
    mover(t, ana, pedido, uno, [items[0]?.id as string])
    mover(t, ana, uno, dos, [items[0]?.id as string])
    const traslados = trabajosTipo(t, 'traslado')
    expect(traslados).toHaveLength(2)
    expect(t.contenido(traslados[1])).toMatchObject({
      destino: 'Mesa 9',
      antes: 'Mesa 8',
      numero: 1,
    })
  })

  it('un movimiento rechazado no imprime', () => {
    const { t, ana, pedido, items } = origenConDosEstaciones()
    const destino = nuevoId() // no existe
    const r = mover(t, ana, pedido, destino, [items[0]?.id as string])
    expect(r.estado).toBe('rechazado')
    expect(trabajosTipo(t, 'traslado')).toHaveLength(0)
  })
})

describe('reimprimir la comanda de platos que se movieron', () => {
  it('ComandaReimpresa en el pedido de destino encuentra la comanda del origen', async () => {
    const t = montarImpresion()
    const imp = conImpresoras(t)
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(
      ana,
      [{ nombre: 'Tagliata', estacion: t.cocina }],
      t.mesa('5'),
    )
    const enviado = t.enviar(ana, pedido, items)
    const destino = nuevoId()
    ana.mandar(destino, 'PedidoAbierto', { canal: 'salon', mesa_id: t.mesa('8'), comensales: 1 })
    mover(t, ana, pedido, destino, [items[0]?.id as string])
    await t.cola.vuelta()
    const comandaId = enviado.comandas[0]?.comanda_id
    expect(ana.mandar(destino, 'ComandaReimpresa', { comanda_id: comandaId }).estado).toBe(
      'confirmado',
    )
    const reimpresiones = trabajosTipo(t, 'reimpresion')
    expect(reimpresiones).toHaveLength(1)
    expect(t.contenido(reimpresiones[0])).toMatchObject({ destino: 'Mesa 8', numero: 1 })
    expect(t.contenido(reimpresiones[0]).items).toMatchObject([{ nombre: 'Tagliata' }])
    await t.cola.vuelta()
    expect(imp.cocina.papel.textos().at(-1)).toContain('REIMPRESIÓN')
  })

  it('una comanda que no existe en ningún pedido no imprime nada', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const { pedido } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    ana.mandar(pedido, 'ComandaReimpresa', { comanda_id: nuevoId() })
    expect(trabajosTipo(t, 'reimpresion')).toHaveLength(0)
  })
})

describe('varios restaurantes en la misma base (mesas)', () => {
  it('el nombre de la mesa se busca en el restaurante del evento: una mesa de otro no se imprime', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const otro = nuevoId()
    t.db
      .prepare(
        `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
         VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
      )
      .run(otro, otro, '2026-10-24T20:00:00.000Z', '2026-10-24T20:00:00.000Z')
    const sedeOtro = insertarVersionado(
      t.db,
      'sede',
      otro,
      { nombre: 'Sede', direccion: null, zona_horaria: 'America/Bogota' },
      SISTEMA,
      '2026-10-24T20:00:00.000Z',
    )
    const zonaOtro = insertarVersionado(
      t.db,
      'zona',
      otro,
      { sede_id: sedeOtro, nombre: 'Salón', orden: 1, piso: 1 },
      SISTEMA,
      '2026-10-24T20:00:00.000Z',
    )
    const mesaAjena = insertarVersionado(
      t.db,
      'mesa',
      otro,
      {
        zona_id: zonaOtro,
        nombre: 'AJENA',
        forma: 'cuadrada',
        x: 0,
        y: 0,
        ancho: 1,
        alto: 1,
        capacidad: 4,
      },
      SISTEMA,
      '2026-10-24T20:00:00.000Z',
    )
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(
      ana,
      [{ nombre: 'Pizza', estacion: t.cocina }],
      t.mesa('5'),
    )
    t.enviar(ana, pedido, items)
    ana.mandar(pedido, 'PedidoMovidoDeMesa', { mesa_destino_id: mesaAjena })
    const c = t.contenido(trabajosTipo(t, 'traslado')[0])
    expect(c.destino).toBe('Mesa')
    expect(JSON.stringify(c)).not.toContain('AJENA')
    expect(c.antes).toBe('Mesa 5')
  })

  it('una cancelación de otro restaurante no genera trabajos en este', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const caja = t.equipo('admin', 'caja')
    const { pedido, items } = t.pedidoCon(
      ana,
      [{ nombre: 'Pizza', estacion: t.cocina }],
      t.mesa('5'),
    )
    t.enviar(ana, pedido, items)
    cancelar(caja, pedido)
    const filas = t.db.prepare('SELECT DISTINCT restaurante_id AS r FROM trabajo_impresion').all()
    expect(filas.map((f) => f.r)).toEqual([t.restauranteId])
  })
})
