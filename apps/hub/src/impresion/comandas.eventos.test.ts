import { nuevoId } from '@pos/core'
import { leerEscpos } from '@pos/printing'
import { describe, expect, it } from 'vitest'
import { insertarVersionado, SISTEMA } from '../acceso/registros'
import { trabajosDeEvento } from './comandas'
import { type MontajeImpresion, montarImpresion } from './montaje-impresion'

// De un evento aceptado a las comandas en la cola (ADR-015): numeración, ítems repetidos, los
// tipos de comanda (nueva, reimpresión, anulación, cambio), cursos retenidos, estaciones sin
// impresora, archivadas, un fallo del gancho y varios restaurantes en la misma base.

const HORA = /(\d{1,2}):(\d{2})\s*([ap])\.\s*m\./

/** Una impresora para cada estación (cocina, barra, postres), cada una con su papel. */
function conImpresoras(t: MontajeImpresion) {
  return {
    cocina: t.impresoraNueva('Cocina', [t.cocina]),
    barra: t.impresoraNueva('Barra', [t.barra]),
    postres: t.impresoraNueva('Postres', [t.postres]),
  }
}

describe('numeración de las comandas por día operativo', () => {
  it('varias estaciones en un envío: un número por comanda, seguidos, y cada una con el suyo', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(ana, [
      { nombre: 'Tagliata', estacion: t.cocina },
      { nombre: 'Aperol Spritz', estacion: t.barra },
      { nombre: 'Tiramisú', estacion: t.postres },
    ])
    const r = t.enviar(ana, pedido, items)
    expect(r.estado).toBe('confirmado')
    const numeros = r.aceptado?.asignaciones.numeros_comanda as Record<string, number>
    expect(r.comandas.map((c) => numeros[c.comanda_id])).toEqual([1, 2, 3])
    const porEstacion = Object.fromEntries(
      t.trabajos().map((f) => [t.contenido(f).estacion, t.contenido(f).numero]),
    )
    expect(porEstacion).toEqual({ Cocina: 1, Barra: 2, Postres: 3 })
  })

  it('al cambiar de día operativo (6:00 a. m.) la numeración vuelve a 1', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const enviarUno = () => {
      const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
      t.enviar(ana, pedido, items)
    }
    enviarUno() // 3:00 p. m. del 24
    t.avanzar(14 * 3_600_000 + 59 * 60_000) // 5:59 a. m. del 25: sigue siendo el día 24
    enviarUno()
    t.avanzar(60_000) // 6:00 a. m.
    enviarUno()
    t.avanzar(60_000)
    enviarUno()
    expect(t.trabajos().map((f) => t.contenido(f).numero)).toEqual([1, 2, 1, 2])
  })

  it('la hora de la comanda sale en la zona horaria del restaurante', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    t.enviar(ana, pedido, items)
    // INICIO = 20:00 UTC = 3:00 p. m. en Bogotá.
    const hora = HORA.exec(String(t.contenido(t.trabajos()[0]).hora))
    expect(hora?.slice(1, 5)).toEqual(['3', '00', 'p'])
  })

  it('otra zona horaria cambia la hora impresa pero no los números', () => {
    const t = montarImpresion({ zonaHoraria: 'Europe/Madrid' })
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    t.enviar(ana, pedido, items)
    expect(HORA.exec(String(t.contenido(t.trabajos()[0]).hora))?.[1]).toBe('10')
  })
})

describe('ItemsEnviados con ítems ya enviados por otro equipo', () => {
  /** Dos meseros ven el mismo pedido; el segundo no se enteró de lo que mandó el primero. */
  function dosEquipos() {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const luis = t.equipo('mesero2')
    const { pedido, items } = t.pedidoCon(ana, [
      { nombre: 'Tagliata', estacion: t.cocina },
      { nombre: 'Risotto', estacion: t.cocina },
    ])
    const baseDeLuis = Number(t.db.prepare('SELECT max(secuencia) AS s FROM evento').get()?.s)
    return { t, ana, luis, pedido, items, baseDeLuis }
  }

  it('lo ya enviado no se imprime dos veces: la segunda comanda lleva solo lo que faltaba', () => {
    const { t, ana, luis, pedido, items, baseDeLuis } = dosEquipos()
    t.enviar(ana, pedido, [items[0] as (typeof items)[0]])
    const r = luis.mandar(
      pedido,
      'ItemsEnviados',
      {
        comandas: [
          { comanda_id: nuevoId(), estacion_id: t.cocina, item_ids: items.map((i) => i.id) },
        ],
      },
      { secuencia_base: baseDeLuis },
    )
    expect(r.estado).toBe('confirmado')
    const trabajos = t.trabajos()
    expect(trabajos).toHaveLength(2)
    expect(t.contenido(trabajos[0]).items.map((i: { nombre: string }) => i.nombre)).toEqual([
      'Tagliata',
    ])
    expect(t.contenido(trabajos[1]).items.map((i: { nombre: string }) => i.nombre)).toEqual([
      'Risotto',
    ])
  })

  it('un envío donde todo ya salió, sin estar al día, se acepta y no imprime nada', () => {
    const { t, ana, luis, pedido, items, baseDeLuis } = dosEquipos()
    t.enviar(ana, pedido, items)
    expect(t.trabajos()).toHaveLength(1)
    const r = luis.mandar(
      pedido,
      'ItemsEnviados',
      {
        comandas: [
          { comanda_id: nuevoId(), estacion_id: t.cocina, item_ids: items.map((i) => i.id) },
        ],
      },
      { secuencia_base: baseDeLuis },
    )
    expect(r.estado).toBe('confirmado')
    expect(t.trabajos()).toHaveLength(1)
    expect(t.fallosGuardar).toEqual([])
  })

  it('el mismo envío reenviado por el mismo equipo no duplica la comanda', () => {
    const { t, ana, pedido, items } = dosEquipos()
    const r = t.enviar(ana, pedido, items)
    expect(t.trabajos()).toHaveLength(1)
    // El hub vuelve a recibir exactamente el mismo evento (reintento tras un corte).
    const igual = ana.mandar(pedido, 'ItemsEnviados', { comandas: r.comandas })
    expect(igual.estado).toBe('rechazado')
    expect(t.trabajos()).toHaveLength(1)
  })

  it('la llamada directa al gancho con un evento ya aplicado no crea nada', () => {
    const { t, ana, pedido, items } = dosEquipos()
    const r = t.enviar(ana, pedido, items)
    if (!r.aceptado) throw new Error('sin evento')
    const ya = t.hub.pedido(pedido)
    expect(trabajosDeEvento(t.opcionesComandas, r.aceptado, [{ antes: ya, despues: ya }])).toBe(0)
    expect(t.trabajos()).toHaveLength(1)
  })

  it('un envío que no imprime nada no gasta número de comanda', () => {
    // El hub numera antes de saber si algo pasará a «enviado»: la cocina vería la comanda 1 y la
    // 3 sin que la 2 exista en papel.
    const { t, ana, luis, pedido, items, baseDeLuis } = dosEquipos()
    t.enviar(ana, pedido, items)
    luis.mandar(
      pedido,
      'ItemsEnviados',
      {
        comandas: [
          { comanda_id: nuevoId(), estacion_id: t.cocina, item_ids: items.map((i) => i.id) },
        ],
      },
      { secuencia_base: baseDeLuis },
    )
    const otro = t.pedidoCon(ana, [{ nombre: 'Pizza', estacion: t.cocina }])
    t.enviar(ana, otro.pedido, otro.items)
    const ultimo = t.trabajos().at(-1)
    expect(t.contenido(ultimo).numero).toBe(2)
  })
})

describe('un envío hecho sin conexión que llega tarde', () => {
  it('se imprime al llegar, con la hora de llegada y el número del día en que se hizo', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const luis = t.equipo('mesero2')
    // Luis arma el pedido y lo envía a las 11:30 p. m. sin red; llega a las 6:40 a. m.
    const { pedido, items } = t.pedidoCon(luis, [{ nombre: 'Tagliata', estacion: t.cocina }])
    const antes = t.pedidoCon(ana, [{ nombre: 'Pizza', estacion: t.cocina }])
    t.enviar(ana, antes.pedido, antes.items) // número 1 del día 24
    const horaDelEnvio = new Date(t.reloj() + 8.5 * 3_600_000).toISOString() // 11:30 p. m. del 24
    t.avanzar(15 * 3_600_000 + 40 * 60_000) // 6:40 a. m. del 25
    const r = luis.mandar(
      pedido,
      'ItemsEnviados',
      { comandas: [{ comanda_id: nuevoId(), estacion_id: t.cocina, item_ids: [items[0]?.id] }] },
      { hora_dispositivo: horaDelEnvio, hora_estimada_hub: horaDelEnvio },
    )
    expect(r.estado).toBe('confirmado')
    expect(r.aceptado?.dia_operativo).toBe('2026-10-24')
    const ultimo = t.trabajos().at(-1)
    expect(t.contenido(ultimo).numero).toBe(2)
    expect(String(ultimo?.creado_en)).toBe(r.aceptado?.recibido_en)
    expect(HORA.exec(String(t.contenido(ultimo).hora))?.slice(1, 5)).toEqual(['6', '40', 'a'])
    // Hoy la cuenta empieza en 1.
    const hoy = t.pedidoCon(ana, [{ nombre: 'Pizza', estacion: t.cocina }])
    t.enviar(ana, hoy.pedido, hoy.items)
    expect(t.contenido(t.trabajos().at(-1)).numero).toBe(1)
  })

  it('sale por la impresora aunque el envío llegue horas después, y solo una vez', async () => {
    const t = montarImpresion()
    const { cocina } = conImpresoras(t)
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    t.avanzar(3 * 3_600_000)
    t.enviar(ana, pedido, items)
    await t.cola.vuelta()
    await t.cola.vuelta()
    expect(cocina.papel.recibidos).toHaveLength(1)
  })
})

describe('reimpresión, anulación y cambio de lo ya enviado', () => {
  async function conPedidoEnviado() {
    const t = montarImpresion()
    const imp = conImpresoras(t)
    const ana = t.equipo('mesero')
    const caja = t.equipo('admin', 'caja')
    const mesa = t.mesa('12')
    const { pedido, items } = t.pedidoCon(
      ana,
      [
        {
          nombre: 'Tagliata',
          estacion: t.cocina,
          opciones: ['Término medio'],
          cantidad: 3,
          comensal: 2,
        },
        { nombre: 'Risotto', estacion: t.cocina, notas: 'sin queso' },
        { nombre: 'Aperol Spritz', estacion: t.barra },
      ],
      mesa,
    )
    const enviado = t.enviar(ana, pedido, items)
    await t.cola.vuelta()
    return { t, imp, ana, caja, pedido, items, enviado, mesa }
  }

  it('ComandaReimpresa saca otra vez la comanda con su número original, marcada como reimpresión', async () => {
    const { t, imp, ana, pedido, enviado } = await conPedidoEnviado()
    const cocina = enviado.comandas.find((c) => c.estacion_id === t.cocina)
    ana.mandar(pedido, 'ComandaReimpresa', { comanda_id: cocina?.comanda_id })
    expect(t.pendientes()).toBe(1)
    await t.cola.vuelta()
    expect(imp.cocina.papel.recibidos).toHaveLength(2)
    const texto = imp.cocina.papel.textos()[1] as string
    expect(texto).toContain('REIMPRESIÓN')
    expect(texto).toMatch(/Mesa 12 +#1/)
    expect(texto).toContain('3 x Tagliata')
    expect(texto).toContain('Risotto')
    // La barra no imprime lo de la cocina.
    expect(imp.barra.papel.recibidos).toHaveLength(1)
  })

  it('reimprimir dos veces saca dos comandas (cada evento es distinto)', async () => {
    const { t, imp, ana, pedido, enviado } = await conPedidoEnviado()
    const barra = enviado.comandas.find((c) => c.estacion_id === t.barra)
    ana.mandar(pedido, 'ComandaReimpresa', { comanda_id: barra?.comanda_id })
    ana.mandar(pedido, 'ComandaReimpresa', { comanda_id: barra?.comanda_id })
    await t.cola.vuelta()
    expect(imp.barra.papel.recibidos).toHaveLength(3)
  })

  it('reimprimir una comanda que no existe, o de otro pedido, no imprime nada y el evento se acepta', async () => {
    const { t, ana, pedido, enviado } = await conPedidoEnviado()
    const otro = t.pedidoCon(ana, [{ nombre: 'Pizza', estacion: t.cocina }])
    const r1 = ana.mandar(pedido, 'ComandaReimpresa', { comanda_id: nuevoId() })
    const r2 = ana.mandar(otro.pedido, 'ComandaReimpresa', {
      comanda_id: enviado.comandas[0]?.comanda_id,
    })
    expect([r1.estado, r2.estado]).toEqual(['confirmado', 'confirmado'])
    expect(t.pendientes()).toBe(0)
    expect(t.fallosGuardar).toEqual([])
  })

  it('la reimpresión no incluye lo anulado y muestra las unidades que quedan', async () => {
    const { t, imp, caja, ana, pedido, items, enviado } = await conPedidoEnviado()
    caja.mandar(pedido, 'ItemAnulado', {
      item_id: items[0]?.id,
      cantidad: 1,
      ya_preparado: false,
      comanda_id: null,
    })
    caja.mandar(pedido, 'ItemAnulado', {
      item_id: items[1]?.id,
      cantidad: 1,
      ya_preparado: false,
      comanda_id: null,
    })
    await t.cola.vuelta()
    const cocina = enviado.comandas.find((c) => c.estacion_id === t.cocina)
    ana.mandar(pedido, 'ComandaReimpresa', { comanda_id: cocina?.comanda_id })
    await t.cola.vuelta()
    const texto = imp.cocina.papel.textos().at(-1) as string
    expect(texto).toContain('REIMPRESIÓN')
    expect(texto).toContain('2 x Tagliata')
    expect(texto).not.toContain('Risotto')
  })

  it('si se anuló todo, la reimpresión no saca una comanda vacía', async () => {
    const { t, caja, ana, pedido, items, enviado } = await conPedidoEnviado()
    for (const i of [items[0], items[1]])
      caja.mandar(pedido, 'ItemAnulado', {
        item_id: i?.id,
        cantidad: i?.nombre === 'Tagliata' ? 3 : 1,
        ya_preparado: false,
        comanda_id: null,
      })
    await t.cola.vuelta()
    const antes = t.trabajos().length
    const cocina = enviado.comandas.find((c) => c.estacion_id === t.cocina)
    ana.mandar(pedido, 'ComandaReimpresa', { comanda_id: cocina?.comanda_id })
    expect(t.trabajos()).toHaveLength(antes)
  })

  it('ItemAnulado de lo que está en cocina saca la comanda de anulación con la cantidad anulada', async () => {
    const { t, imp, caja, pedido, items } = await conPedidoEnviado()
    const r = caja.mandar(pedido, 'ItemAnulado', {
      item_id: items[0]?.id,
      cantidad: 2,
      ya_preparado: false,
      comanda_id: null,
    })
    expect(r.estado).toBe('confirmado')
    await t.cola.vuelta()
    const texto = imp.cocina.papel.textos().at(-1) as string
    expect(texto).toContain('ANULAR')
    expect(texto).toMatch(/Mesa 12 +#1/)
    expect(texto).toContain('-2 x Tagliata')
    expect(texto).toContain('> Término medio')
    expect(texto).not.toContain('Risotto')
    expect(imp.barra.papel.recibidos).toHaveLength(1)
  })

  it.each(['enviado', 'en_preparacion', 'listo'] as const)(
    'ItemAnulado avisa a la cocina si el plato está «%s»',
    async (estado) => {
      const { t, ana, caja, pedido, items } = await conPedidoEnviado()
      const id = items[1]?.id
      if (estado === 'en_preparacion') ana.mandar(pedido, 'ItemEnPreparacion', { item_ids: [id] })
      if (estado === 'listo') ana.mandar(pedido, 'ItemListo', { item_ids: [id] })
      expect(t.hub.pedido(pedido)?.items[id as string]?.estado).toBe(estado)
      const antes = t.trabajos().length
      caja.mandar(pedido, 'ItemAnulado', {
        item_id: id,
        cantidad: 1,
        ya_preparado: estado === 'listo',
        comanda_id: null,
      })
      expect(t.trabajos()).toHaveLength(antes + 1)
    },
  )

  it('ItemAnulado de algo ya entregado no avisa a la cocina', async () => {
    const { t, ana, caja, pedido, items } = await conPedidoEnviado()
    ana.mandar(pedido, 'ItemEntregado', { item_ids: [items[1]?.id] })
    const antes = t.trabajos().length
    const r = caja.mandar(pedido, 'ItemAnulado', {
      item_id: items[1]?.id,
      cantidad: 1,
      ya_preparado: true,
      comanda_id: null,
    })
    expect(r.estado).toBe('confirmado')
    expect(t.trabajos()).toHaveLength(antes)
  })

  it('anular lo que aún no se envió se rechaza y no imprime (se quita, no se anula)', async () => {
    const { t, ana, caja } = await conPedidoEnviado()
    const nuevo = t.pedidoCon(ana, [{ nombre: 'Pizza', estacion: t.cocina }])
    const antes = t.trabajos().length
    const r = caja.mandar(nuevo.pedido, 'ItemAnulado', {
      item_id: nuevo.items[0]?.id,
      cantidad: 1,
      ya_preparado: false,
      comanda_id: null,
    })
    expect(r.estado).toBe('rechazado')
    expect(t.trabajos()).toHaveLength(antes)
  })

  it('anular dos veces el mismo plato (cantidad parcial y luego el resto) saca dos anulaciones', async () => {
    const { t, imp, caja, pedido, items } = await conPedidoEnviado()
    for (const cantidad of [1, 2])
      caja.mandar(pedido, 'ItemAnulado', {
        item_id: items[0]?.id,
        cantidad,
        ya_preparado: false,
        comanda_id: null,
      })
    await t.cola.vuelta()
    const textos = imp.cocina.papel.textos()
    expect(textos.at(-2)).toContain('-1 x Tagliata')
    expect(textos.at(-1)).toContain('-2 x Tagliata')
  })

  it('ItemModificadoTrasEnvio saca la comanda de cambio con las opciones y notas nuevas', async () => {
    const { t, imp, ana, pedido, items, enviado } = await conPedidoEnviado()
    const cocina = enviado.comandas.find((c) => c.estacion_id === t.cocina)
    const r = ana.mandar(pedido, 'ItemModificadoTrasEnvio', {
      item_id: items[1]?.id,
      comanda_id: cocina?.comanda_id,
      notas: 'sin queso y sin sal',
    })
    expect(r.estado).toBe('confirmado')
    await t.cola.vuelta()
    const texto = imp.cocina.papel.textos().at(-1) as string
    expect(texto).toContain('CAMBIO')
    expect(texto).toMatch(/Mesa 12 +#1/)
    expect(texto).toContain('Risotto')
    expect(texto).toContain('NOTA: sin queso y sin sal')
    expect(texto).not.toContain('Tagliata')
  })

  it('un cambio de opciones imprime las nuevas; quitar la nota la deja sin NOTA', async () => {
    const { t, imp, ana, pedido, items, enviado } = await conPedidoEnviado()
    const cocina = enviado.comandas.find((c) => c.estacion_id === t.cocina)
    ana.mandar(pedido, 'ItemModificadoTrasEnvio', {
      item_id: items[1]?.id,
      comanda_id: cocina?.comanda_id,
      notas: null,
      modificadores: [{ modificador_id: nuevoId(), nombre: 'Bien cocido', precio_extra: 0 }],
    })
    await t.cola.vuelta()
    const texto = imp.cocina.papel.textos().at(-1) as string
    expect(texto).toContain('> Bien cocido')
    expect(texto).not.toContain('NOTA')
  })

  it('modificar algo que no se ha enviado se rechaza y no imprime', async () => {
    const { t, ana } = await conPedidoEnviado()
    const nuevo = t.pedidoCon(ana, [{ nombre: 'Pizza', estacion: t.cocina }])
    const antes = t.trabajos().length
    const r = ana.mandar(nuevo.pedido, 'ItemModificadoTrasEnvio', {
      item_id: nuevo.items[0]?.id,
      comanda_id: nuevoId(),
      notas: 'x',
    })
    expect(r.estado).toBe('rechazado')
    expect(t.trabajos()).toHaveLength(antes)
  })

  it('los eventos que no son de comandas (listo, entregado, descuentos…) no crean trabajos', async () => {
    const { t, ana, pedido, items } = await conPedidoEnviado()
    const antes = t.trabajos().length
    ana.mandar(pedido, 'ItemListo', { item_ids: [items[0]?.id] })
    ana.mandar(pedido, 'ItemEntregado', { item_ids: [items[0]?.id] })
    ana.mandar(pedido, 'ItemDevueltoACola', { item_ids: [items[0]?.id] })
    ana.mandar(pedido, 'ComensalesCambiados', { comensales: 5 })
    expect(t.trabajos()).toHaveLength(antes)
  })

  it('anular un plato que se pasó a otro pedido (cambio de mesa de un ítem) avisa a la cocina', async () => {
    // El plato sigue en cocina, pero su comanda quedó en los eventos del pedido de origen.
    const { t, ana, caja, pedido, items } = await conPedidoEnviado()
    const destino = nuevoId()
    ana.mandar(destino, 'PedidoAbierto', { canal: 'salon', mesa_id: null, comensales: 1 })
    const original = t.hub.pedido(pedido)?.items[items[1]?.id as string]
    if (!original) throw new Error('sin ítem')
    const movido = ana.mandar(
      pedido,
      'ItemsMovidos',
      {
        pedido_destino_id: destino,
        items: [
          {
            item: {
              item_id: original.id,
              producto_id: original.productoId,
              variante_id: original.varianteId,
              nombre: original.nombre,
              precio_unitario: original.precioUnitario,
              impuesto_tipo: original.impuestoTipo,
              tarifa: original.tarifa,
              cantidad: original.cantidad,
              comensal: original.comensal,
              curso: original.curso,
              modificadores: original.modificadores.map((m) => ({
                modificador_id: m.modificadorId,
                nombre: m.nombre,
                precio_extra: m.precioExtra,
              })),
              notas: original.notas,
            },
            estado: 'enviado',
            cantidad_anulada: 0,
            agregado_por: original.agregadoPor,
          },
        ],
      },
      { relacionados: [destino] },
    )
    expect(movido.resultado).toMatchObject({ estado: 'confirmado' })
    const antes = t.trabajos().length
    const r = caja.mandar(destino, 'ItemAnulado', {
      item_id: original.id,
      cantidad: 1,
      ya_preparado: false,
      comanda_id: null,
    })
    expect(r.estado).toBe('confirmado')
    expect(t.trabajos()).toHaveLength(antes + 1)
  })
})

describe('datos que lleva la comanda', () => {
  it.each([
    ['salon', 'Mesa'],
    ['para_llevar', 'Para llevar'],
    ['domicilio', 'Domicilio'],
    ['barra', 'Barra'],
  ])('el canal %s sin mesa se anuncia como «%s»', (canal, destino) => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(
      ana,
      [{ nombre: 'Pizza', estacion: t.cocina }],
      null,
      canal,
    )
    t.enviar(ana, pedido, items)
    expect(t.contenido(t.trabajos()[0]).destino).toBe(destino)
  })

  it('con mesa lleva «Mesa N», el mesero, el número de pedido del día y los comensales', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(
      ana,
      [{ nombre: 'Pizza', estacion: t.cocina }],
      t.mesa('7'),
    )
    t.enviar(ana, pedido, items)
    expect(t.contenido(t.trabajos()[0])).toMatchObject({
      tipo: 'nueva',
      estacion: 'Cocina',
      destino: 'Mesa 7',
      mesero: 'Ana',
      pedido: 1,
      comensales: 2,
      numero: 1,
    })
  })

  it('las opciones, notas, comensal y curso de cada plato viajan en el trabajo', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(ana, [
      {
        nombre: 'Tagliata',
        estacion: t.cocina,
        opciones: ['Término medio', 'Sin sal'],
        notas: 'alergia al maní',
        comensal: 3,
        curso: 'fuerte',
        cantidad: 2,
      },
    ])
    t.enviar(ana, pedido, items)
    expect(t.contenido(t.trabajos()[0]).items).toEqual([
      {
        cantidad: 2,
        nombre: 'Tagliata',
        comensal: 3,
        curso: 'fuerte',
        opciones: ['Término medio', 'Sin sal'],
        notas: 'alergia al maní',
      },
    ])
  })

  it('una mesa que ya no existe no rompe la comanda', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Pizza', estacion: t.cocina }], nuevoId())
    t.enviar(ana, pedido, items)
    expect(t.contenido(t.trabajos()[0]).destino).toBe('Mesa')
  })

  it('el nombre de la mesa con caracteres raros se imprime sin órdenes de impresora', async () => {
    const t = montarImpresion()
    const imp = conImpresoras(t)
    const ana = t.equipo('mesero')
    const mesa = t.mesa('\x1bp\x00T\x1dV1')
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Pizza\x1b@', estacion: t.cocina }], mesa)
    t.enviar(ana, pedido, items)
    await t.cola.vuelta()
    const bytes = imp.cocina.papel.recibidos[0] as Uint8Array
    expect(leerEscpos(bytes).cortes).toBe(1)
    expect(leerEscpos(bytes).texto).toContain('Pizza')
  })
})

describe('cursos retenidos', () => {
  it('la comanda avisa los cursos que siguen en espera y deja de avisarlos al marcharlos', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const pedido = t.abrir(ana)
    ana.mandar(pedido, 'CursoRetenido', { curso: 'postre' })
    const fuerte = t.agregar(ana, pedido, {
      nombre: 'Tagliata',
      estacion: t.cocina,
      curso: 'fuerte',
    })
    const postre = t.agregar(ana, pedido, {
      nombre: 'Tiramisú',
      estacion: t.postres,
      curso: 'postre',
    })
    expect(t.hub.pedido(pedido)?.items[postre.id]?.estado).toBe('retenido')
    t.enviar(ana, pedido, [fuerte])
    expect(t.contenido(t.trabajos()[0]).retenidos).toEqual(['postre'])
    // Se marcha el postre: ahora sí se envía y ya no hay nada en espera.
    ana.mandar(pedido, 'CursoMarchado', { curso: 'postre' })
    t.enviar(ana, pedido, [postre])
    expect(t.contenido(t.trabajos().at(-1)).retenidos).toEqual([])
  })

  it('varios cursos retenidos se avisan todos, y solo los que tienen platos', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const pedido = t.abrir(ana)
    ana.mandar(pedido, 'CursoRetenido', { curso: 'fuerte' })
    ana.mandar(pedido, 'CursoRetenido', { curso: 'postre' })
    const entrada = t.agregar(ana, pedido, {
      nombre: 'Burrata',
      estacion: t.cocina,
      curso: 'entrada',
    })
    t.agregar(ana, pedido, { nombre: 'Tagliata', estacion: t.cocina, curso: 'fuerte' })
    t.enviar(ana, pedido, [entrada])
    expect(t.contenido(t.trabajos()[0]).retenidos).toEqual(['fuerte'])
  })

  it('si el curso está retenido pero no hay platos de ese curso, no se avisa en espera', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const pedido = t.abrir(ana)
    ana.mandar(pedido, 'CursoRetenido', { curso: 'postre' })
    const plato = t.agregar(ana, pedido, { nombre: 'Risotto', estacion: t.cocina })
    t.enviar(ana, pedido, [plato])
    expect(t.contenido(t.trabajos().at(-1)).retenidos).toEqual([])
  })

  it('las reimpresiones no llevan el aviso de espera', () => {
    const t = montarImpresion()
    conImpresoras(t)
    const ana = t.equipo('mesero')
    const pedido = t.abrir(ana)
    const plato = t.agregar(ana, pedido, {
      nombre: 'Tagliata',
      estacion: t.cocina,
      curso: 'fuerte',
    })
    t.agregar(ana, pedido, { nombre: 'Tiramisú', estacion: t.postres, curso: 'postre' })
    ana.mandar(pedido, 'CursoRetenido', { curso: 'postre' })
    const r = t.enviar(ana, pedido, [plato])
    expect(t.contenido(t.trabajos()[0]).retenidos).toEqual(['postre'])
    ana.mandar(pedido, 'ComandaReimpresa', { comanda_id: r.comandas[0]?.comanda_id })
    expect(t.contenido(t.trabajos().at(-1))).toMatchObject({ tipo: 'reimpresion', retenidos: [] })
  })
})

describe('estaciones e impresoras', () => {
  it('una estación sin impresora no deja trabajos y el envío no falla', () => {
    const t = montarImpresion()
    t.impresoraNueva('Barra', [t.barra])
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(ana, [
      { nombre: 'Tagliata', estacion: t.cocina },
      { nombre: 'Aperol', estacion: t.barra },
    ])
    const r = t.enviar(ana, pedido, items)
    expect(r.estado).toBe('confirmado')
    expect(t.trabajos().map((f) => t.contenido(f).estacion)).toEqual(['Barra'])
    expect(t.fallosGuardar).toEqual([])
  })

  it('sin ninguna impresora no se crea nada', () => {
    const t = montarImpresion()
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    expect(t.enviar(ana, pedido, items).estado).toBe('confirmado')
    expect(t.trabajos()).toEqual([])
  })

  it('dos impresoras para la misma estación: cada una recibe su copia', async () => {
    const t = montarImpresion()
    const a = t.impresoraNueva('Cocina 1', [t.cocina])
    const b = t.impresoraNueva('Cocina 2', [t.cocina])
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    t.enviar(ana, pedido, items)
    expect(t.trabajos()).toHaveLength(2)
    await t.cola.vuelta()
    expect(a.papel.recibidos).toHaveLength(1)
    expect(b.papel.recibidos).toHaveLength(1)
  })

  it('una impresora de varias estaciones imprime las dos comandas, en orden', async () => {
    const t = montarImpresion()
    const unica = t.impresoraNueva('Todo', [t.cocina, t.barra])
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(ana, [
      { nombre: 'Tagliata', estacion: t.cocina },
      { nombre: 'Aperol', estacion: t.barra },
    ])
    t.enviar(ana, pedido, items)
    await t.cola.vuelta()
    expect(unica.papel.textos().map((x) => (x.includes('COCINA') ? 'cocina' : 'barra'))).toEqual([
      'cocina',
      'barra',
    ])
  })

  it('una impresora archivada no recibe comandas nuevas', () => {
    const t = montarImpresion()
    t.impresoraNueva('Vieja', [t.cocina], { activo: 0 })
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    t.enviar(ana, pedido, items)
    expect(t.trabajos()).toEqual([])
  })

  it('una estación archivada con comandas viejas sigue imprimiendo con su nombre', async () => {
    const t = montarImpresion()
    const imp = t.impresoraNueva('Cocina', [t.cocina])
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    t.enviar(ana, pedido, items)
    t.db.prepare('UPDATE estacion SET activo = 0 WHERE id = ?').run(t.cocina)
    await t.cola.vuelta()
    expect(imp.papel.textos()[0]).toContain('COCINA')
  })

  it('una estación que no existe en la base se imprime como «Estación»', () => {
    const t = montarImpresion()
    const fantasma = nuevoId()
    t.db.exec('PRAGMA foreign_keys = OFF')
    t.impresoraNueva('Fantasma', [fantasma])
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: fantasma }])
    t.enviar(ana, pedido, items)
    expect(t.contenido(t.trabajos()[0]).estacion).toBe('Estación')
  })
})

describe('un fallo al armar la comanda', () => {
  it('no rechaza el evento: el pedido queda enviado y el fallo se avisa', () => {
    const t = montarImpresion()
    t.impresoraNueva('Cocina', [t.cocina])
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    // La tabla de la cola desaparece: insertar en ella revienta.
    t.db.exec('DROP TRIGGER trabajo_impresion_sin_delete')
    t.db.exec('DROP TABLE trabajo_impresion')
    const r = t.enviar(ana, pedido, items)
    expect(r.estado).toBe('confirmado')
    expect(t.hub.pedido(pedido)?.items[items[0]?.id as string]?.estado).toBe('enviado')
    expect(t.fallosGuardar).toHaveLength(1)
    expect(t.fallosGuardar[0]?.id).toBe(r.aceptado?.id)
  })

  it('todo o nada: si falla la comanda de la barra no queda a medias la de la cocina', () => {
    const t = montarImpresion()
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    const barra = t.impresoraNueva('Barra', [t.barra])
    t.db.exec(
      `CREATE TRIGGER falla_barra BEFORE INSERT ON trabajo_impresion
       WHEN NEW.impresora_id = '${barra.id}'
       BEGIN SELECT RAISE(ABORT, 'impresora de la barra rota'); END`,
    )
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(ana, [
      { nombre: 'Tagliata', estacion: t.cocina },
      { nombre: 'Aperol', estacion: t.barra },
    ])
    const r = t.enviar(ana, pedido, items)
    expect(r.estado).toBe('confirmado')
    expect(t.fallosGuardar).toHaveLength(1)
    expect(t.trabajos()).toEqual([])
    void cocina
    // El hub sigue aceptando eventos después.
    expect(ana.mandar(pedido, 'ItemListo', { item_ids: [items[0]?.id] }).estado).toBe('confirmado')
  })

  it('el error de armar una comanda viene con el id del evento para poder reimprimirla', () => {
    const t = montarImpresion()
    t.impresoraNueva('Cocina', [t.cocina])
    t.db.exec('DROP TRIGGER trabajo_impresion_sin_delete')
    t.db.exec('DROP TABLE trabajo_impresion')
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    const r = t.enviar(ana, pedido, items)
    expect(t.fallosGuardar.map((f) => f.id)).toEqual([r.aceptado?.id])
  })
})

describe('varios restaurantes en la misma base', () => {
  function conOtroRestaurante(t: MontajeImpresion) {
    const otro = nuevoId()
    const ahora = t.reloj
    t.db
      .prepare(
        `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
         VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
      )
      .run(otro, otro, '2026-10-24T20:00:00.000Z', '2026-10-24T20:00:00.000Z')
    void ahora
    const estacion = insertarVersionado(
      t.db,
      'estacion',
      otro,
      { nombre: 'Cocina de otro', orden: 1 },
      SISTEMA,
      '2026-10-24T20:00:00.000Z',
    )
    return { otro, estacion }
  }

  it('una impresora de otro restaurante nunca recibe comandas de este, ni siquiera con la misma estación', async () => {
    const t = montarImpresion()
    const mia = t.impresoraNueva('Cocina', [t.cocina])
    const { otro } = conOtroRestaurante(t)
    const ajena = insertarVersionado(
      t.db,
      'impresora',
      otro,
      {
        nombre: 'Ajena',
        conexion: 'red',
        direccion: '10.9.9.9',
        puerto: 9100,
        ancho: 80,
        // Apunta (mal) a la estación de este restaurante.
        estacion_ids: JSON.stringify([t.cocina]),
      },
      SISTEMA,
      '2026-10-24T20:00:00.000Z',
    )
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    t.enviar(ana, pedido, items)
    const filas = t.trabajos()
    expect(filas.map((f) => f.impresora_id)).toEqual([mia.id])
    expect(filas.some((f) => f.impresora_id === ajena)).toBe(false)
  })

  it('la cola de un restaurante no imprime ni cuenta los trabajos del otro', async () => {
    const t = montarImpresion()
    const mia = t.impresoraNueva('Cocina', [t.cocina])
    const { otro } = conOtroRestaurante(t)
    const colaDelOtro = t.crearCola({ restauranteId: otro })
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Tagliata', estacion: t.cocina }])
    t.enviar(ana, pedido, items)
    await colaDelOtro.vuelta()
    expect(mia.papel.recibidos).toHaveLength(0)
    expect(colaDelOtro.estado()).toEqual([])
    expect(t.cola.estado()).toMatchObject([{ id: mia.id, pendientes: 1 }])
    await t.cola.vuelta()
    expect(mia.papel.recibidos).toHaveLength(1)
  })

  it('el mesero, la mesa y la estación se buscan en el restaurante del evento', () => {
    const t = montarImpresion()
    t.impresoraNueva('Cocina', [t.cocina])
    const { otro } = conOtroRestaurante(t)
    // Otro restaurante con un usuario del mismo nombre no cambia el mesero impreso.
    const ana = t.equipo('mesero')
    const { pedido, items } = t.pedidoCon(
      ana,
      [{ nombre: 'Pizza', estacion: t.cocina }],
      t.mesa('3'),
    )
    t.enviar(ana, pedido, items)
    expect(t.contenido(t.trabajos()[0])).toMatchObject({
      mesero: 'Ana',
      destino: 'Mesa 3',
      estacion: 'Cocina',
    })
    void otro
  })
})
