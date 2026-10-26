import { type EventoPedido, nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { AlmacenMemoria } from './hub/almacen'
import { AlmacenSqlite } from './hub/almacen-sqlite'
import { type Conexion, HubSync } from './hub/hub'
import { SalaSync } from './hub/sala'
import { accesoLibre } from './pruebas/acceso'
import { AHORA, baseSqlite, item, type Montaje, montar } from './pruebas/montaje'
import type { Nodo } from './pruebas/red'

// Tarea 1.5 en el hub: no se ocupa una mesa que otro pedido ya ocupa (también como mesa unida),
// ni al abrir, ni al cambiarse, ni al unir; mover productos exige estar en línea; y todo es por
// restaurante. Se prueba con eventos reales contra el hub, sin pasar por el cliente.

const conexionDe = (m: Montaje, nodo: Nodo) => {
  const conexion = m.red.tokens.get(`token-${nodo.nombre}`)
  if (!conexion) throw new Error(`Sin token para ${nodo.nombre}`)
  return conexion
}

const CON_MOTIVO = new Set(['PedidoCancelado', 'PedidoReabierto', 'ItemAnulado'])

function equipo() {
  const m = montar()
  const ana = m.red.dispositivo('ana')
  const beto = m.red.dispositivo('beto')
  /** `conoce: false` manda `secuencia_base: 0`: el equipo estaba sin conexión. */
  const mandar = (
    quien: Nodo,
    pedido: string,
    tipo: string,
    datos: unknown,
    extras: Partial<Record<keyof EventoPedido, unknown>> & { conoce?: boolean } = {},
  ) => {
    const { conoce = true, ...resto } = extras
    const r = m.hub().recibirLote(conexionDe(m, quien), [
      {
        id: nuevoId(),
        tipo,
        version_esquema: 1,
        agregado_tipo: 'pedido',
        agregado_id: pedido,
        relacionados: [],
        datos,
        sesion_id: null,
        usuario_id: quien.usuarioId,
        dispositivo_id: quien.dispositivoId,
        autorizacion_id: null,
        motivo: CON_MOTIVO.has(tipo) ? 'Prueba' : null,
        hora_dispositivo: AHORA,
        hora_estimada_hub: AHORA,
        secuencia_base: conoce ? m.almacen.maxSecuencia() : 0,
        ...resto,
      },
    ])
    return r.resultados[0]
  }
  const abrir = (quien: Nodo, mesa: string | null, extras = {}) => {
    const pedido = nuevoId()
    const resultado = mandar(
      quien,
      pedido,
      'PedidoAbierto',
      { canal: 'salon', mesa_id: mesa, comensales: 2 },
      extras,
    )
    return { pedido, resultado }
  }
  const unir = (quien: Nodo, pedido: string, mesas: string[], extras = {}) =>
    mandar(quien, pedido, 'MesasUnidas', { mesa_ids: mesas }, extras)
  const separar = (quien: Nodo, pedido: string, mesas: string[], extras = {}) =>
    mandar(quien, pedido, 'MesasSeparadas', { mesa_ids: mesas }, extras)
  const pasar = (quien: Nodo, pedido: string, mesa: string, extras = {}) =>
    mandar(quien, pedido, 'PedidoMovidoDeMesa', { mesa_destino_id: mesa }, extras)
  return { m, ana, beto, mandar, abrir, unir, separar, pasar }
}

describe('unir mesas en el hub', () => {
  it('unir una mesa libre se acepta y la mesa queda ocupada hasta separarla', () => {
    const { m, ana, abrir, unir, separar } = equipo()
    const [m1, m2] = [nuevoId(), nuevoId()]
    const { pedido } = abrir(ana, m1)
    expect(m.hub().tienePedidoAbierto(m2)).toBe(false)
    expect(unir(ana, pedido, [m2])).toMatchObject({ estado: 'confirmado', conflicto: null })
    expect(m.hub().tienePedidoAbierto(m2)).toBe(true)
    expect(m.hub().tienePedidoAbierto(m1)).toBe(true)
    expect(m.hub().pedido(pedido)?.mesasUnidas).toEqual([m2])
    expect(separar(ana, pedido, [m2])?.estado).toBe('confirmado')
    expect(m.hub().tienePedidoAbierto(m2)).toBe(false)
    expect(m.hub().tienePedidoAbierto(m1)).toBe(true)
  })

  it('una mesa unida se libera al cerrar o cancelar el pedido y vuelve a ocuparse al reabrirlo', () => {
    const { m, ana, abrir, unir, mandar } = equipo()
    const [m1, m2, m3, m4] = [nuevoId(), nuevoId(), nuevoId(), nuevoId()]
    const a = abrir(ana, m1).pedido
    unir(ana, a, [m2])
    expect(mandar(ana, a, 'PedidoCerrado', {})?.estado).toBe('confirmado')
    expect(m.hub().tienePedidoAbierto(m2)).toBe(false)
    expect(mandar(ana, a, 'PedidoReabierto', {})?.estado).toBe('confirmado')
    expect(m.hub().tienePedidoAbierto(m2)).toBe(true)

    const b = abrir(ana, m3).pedido
    unir(ana, b, [m4])
    expect(mandar(ana, b, 'PedidoCancelado', {})?.estado).toBe('confirmado')
    expect(m.hub().tienePedidoAbierto(m4)).toBe(false)
    expect(m.hub().tienePedidoAbierto(m3)).toBe(false)
  })

  it('unir a un pedido sin mesa se rechaza por el reductor (sin_mesa), no por la mesa', () => {
    const { ana, abrir, unir } = equipo()
    const { pedido } = abrir(ana, null)
    expect(unir(ana, pedido, [nuevoId()])).toMatchObject({
      estado: 'rechazado',
      motivo: 'sin_mesa',
    })
  })

  it('separar lo que no está unido se rechaza (mesas_no_unidas) y repetir la unión también', () => {
    const { ana, abrir, unir, separar } = equipo()
    const [m1, m2] = [nuevoId(), nuevoId()]
    const { pedido } = abrir(ana, m1)
    expect(separar(ana, pedido, [m2])).toMatchObject({
      estado: 'rechazado',
      motivo: 'mesas_no_unidas',
    })
    unir(ana, pedido, [m2])
    expect(unir(ana, pedido, [m2])).toMatchObject({
      estado: 'rechazado',
      motivo: 'mesas_ya_unidas',
    })
  })

  it('la mesa unida de un pedido no deja unirla a otro: mesa_ocupada, sin importar lo que conozca', () => {
    const { ana, beto, abrir, unir } = equipo()
    const [m1, m2, m3] = [nuevoId(), nuevoId(), nuevoId()]
    const uno = abrir(ana, m1).pedido
    unir(ana, uno, [m2])
    const dos = abrir(beto, m3).pedido
    // Beto conoce todo: se rechaza.
    expect(unir(beto, dos, [m2])).toMatchObject({ estado: 'rechazado', motivo: 'mesa_ocupada' })
    // Beto estaba sin conexión: unir exige estar al día, también se rechaza.
    expect(unir(beto, dos, [m2], { conoce: false })).toMatchObject({
      estado: 'rechazado',
      motivo: 'mesa_ocupada',
    })
  })

  it('unir la mesa principal de otro pedido también se rechaza', () => {
    const { ana, beto, abrir, unir } = equipo()
    const [m1, m3] = [nuevoId(), nuevoId()]
    abrir(ana, m1)
    const dos = abrir(beto, m3).pedido
    expect(unir(beto, dos, [m1])).toMatchObject({ estado: 'rechazado', motivo: 'mesa_ocupada' })
    expect(unir(beto, dos, [m1], { conoce: false })).toMatchObject({
      estado: 'rechazado',
      motivo: 'mesa_ocupada',
    })
  })

  it('una lista donde solo una mesa está ocupada se rechaza entera y no deja unida ninguna', () => {
    const { m, ana, beto, abrir, unir } = equipo()
    const [m1, libre, ocupada] = [nuevoId(), nuevoId(), nuevoId()]
    abrir(ana, ocupada)
    const dos = abrir(beto, m1).pedido
    expect(unir(beto, dos, [libre, ocupada])).toMatchObject({ estado: 'rechazado' })
    expect(m.hub().pedido(dos)?.mesasUnidas).toEqual([])
    expect(m.hub().tienePedidoAbierto(libre)).toBe(false)
  })

  it('un pedido cerrado no ocupa nada: su mesa y sus unidas se pueden unir a otro', () => {
    const { ana, beto, abrir, unir, mandar } = equipo()
    const [m1, m2, m3] = [nuevoId(), nuevoId(), nuevoId()]
    const uno = abrir(ana, m1).pedido
    unir(ana, uno, [m2])
    mandar(ana, uno, 'PedidoCerrado', {})
    const dos = abrir(beto, m3).pedido
    expect(unir(beto, dos, [m1, m2])?.estado).toBe('confirmado')
  })

  it('el rechazo es idempotente: reenviar el mismo evento da el mismo motivo', () => {
    const { m, ana, beto, abrir } = equipo()
    const [m1, m2] = [nuevoId(), nuevoId()]
    abrir(ana, m1)
    const dos = abrir(beto, m2).pedido
    const evento = {
      id: nuevoId(),
      tipo: 'MesasUnidas',
      version_esquema: 1,
      agregado_tipo: 'pedido',
      agregado_id: dos,
      relacionados: [],
      datos: { mesa_ids: [m1] },
      sesion_id: null,
      usuario_id: beto.usuarioId,
      dispositivo_id: beto.dispositivoId,
      autorizacion_id: null,
      motivo: null,
      hora_dispositivo: AHORA,
      hora_estimada_hub: AHORA,
      secuencia_base: m.almacen.maxSecuencia(),
    }
    const conexion = conexionDe(m, beto)
    const a = m.hub().recibirLote(conexion, [evento]).resultados[0]
    const b = m.hub().recibirLote(conexion, [evento]).resultados[0]
    expect(a).toMatchObject({ estado: 'rechazado', motivo: 'mesa_ocupada' })
    expect(b).toEqual(a)
  })
})

describe('abrir una mesa que otro pedido ocupa como unida', () => {
  it('si el equipo conocía el pedido, se rechaza como mesa_ocupada', () => {
    const { ana, beto, abrir, unir } = equipo()
    const [m1, m2] = [nuevoId(), nuevoId()]
    const uno = abrir(ana, m1).pedido
    unir(ana, uno, [m2])
    expect(abrir(beto, m2).resultado).toMatchObject({ estado: 'rechazado', motivo: 'mesa_ocupada' })
  })

  it('si no lo conocía (sin conexión), se acepta y se avisa mesa_duplicada en caja', () => {
    const { m, ana, beto, abrir, unir } = equipo()
    const [m1, m2] = [nuevoId(), nuevoId()]
    const uno = abrir(ana, m1).pedido
    unir(ana, uno, [m2])
    const { resultado } = abrir(beto, m2, { conoce: false })
    expect(resultado).toMatchObject({ estado: 'confirmado', conflicto: 'mesa_duplicada' })
    expect(
      m
        .hub()
        .conflictos()
        .map((c) => c.tipo),
    ).toEqual(['mesa_duplicada'])
  })

  it('abrir en una mesa que dejó de estar unida es normal', () => {
    const { ana, beto, abrir, unir, separar } = equipo()
    const [m1, m2] = [nuevoId(), nuevoId()]
    const uno = abrir(ana, m1).pedido
    unir(ana, uno, [m2])
    separar(ana, uno, [m2])
    expect(abrir(beto, m2).resultado).toMatchObject({ estado: 'confirmado', conflicto: null })
  })
})

describe('cambiarse de mesa', () => {
  it('a una mesa libre se acepta: libera la de antes y ocupa la nueva', () => {
    const { m, ana, abrir, pasar } = equipo()
    const [m1, m2] = [nuevoId(), nuevoId()]
    const { pedido } = abrir(ana, m1)
    expect(pasar(ana, pedido, m2)?.estado).toBe('confirmado')
    expect(m.hub().tienePedidoAbierto(m1)).toBe(false)
    expect(m.hub().tienePedidoAbierto(m2)).toBe(true)
  })

  it('a una mesa ocupada se rechaza si el equipo conocía el otro pedido', () => {
    const { m, ana, beto, abrir, pasar } = equipo()
    const [m1, m2] = [nuevoId(), nuevoId()]
    const { pedido } = abrir(ana, m1)
    abrir(beto, m2)
    expect(pasar(ana, pedido, m2)).toMatchObject({ estado: 'rechazado', motivo: 'mesa_ocupada' })
    expect(m.hub().pedido(pedido)?.mesaId).toBe(m1)
  })

  it('a una mesa ocupada se rechaza también si el equipo no lo conocía: no es conflicto', () => {
    const { m, ana, beto, abrir, pasar } = equipo()
    const [m1, m2] = [nuevoId(), nuevoId()]
    const { pedido } = abrir(ana, m1)
    abrir(beto, m2)
    expect(pasar(ana, pedido, m2, { conoce: false })).toMatchObject({
      estado: 'rechazado',
      motivo: 'mesa_ocupada',
    })
    expect(m.hub().conflictos()).toEqual([])
  })

  it('a una mesa unida de otro pedido se rechaza', () => {
    const { ana, beto, abrir, unir, pasar } = equipo()
    const [m1, m2, m3] = [nuevoId(), nuevoId(), nuevoId()]
    const { pedido } = abrir(ana, m1)
    const otro = abrir(beto, m2).pedido
    unir(beto, otro, [m3])
    expect(pasar(ana, pedido, m3)).toMatchObject({ estado: 'rechazado', motivo: 'mesa_ocupada' })
    expect(pasar(ana, pedido, m3, { conoce: false })).toMatchObject({
      estado: 'rechazado',
      motivo: 'mesa_ocupada',
    })
  })

  it('a una de sus propias mesas unidas se acepta: la de antes queda libre', () => {
    const { m, ana, abrir, unir, pasar } = equipo()
    const [m1, m2] = [nuevoId(), nuevoId()]
    const { pedido } = abrir(ana, m1)
    unir(ana, pedido, [m2])
    expect(pasar(ana, pedido, m2)?.estado).toBe('confirmado')
    expect(m.hub().pedido(pedido)).toMatchObject({ mesaId: m2, mesasUnidas: [] })
    expect(m.hub().tienePedidoAbierto(m1)).toBe(false)
    expect(m.hub().tienePedidoAbierto(m2)).toBe(true)
  })

  it('a la mesa en la que ya está se acepta (no se choca consigo mismo)', () => {
    const { ana, abrir, pasar } = equipo()
    const m1 = nuevoId()
    const { pedido } = abrir(ana, m1)
    expect(pasar(ana, pedido, m1)?.estado).toBe('confirmado')
  })

  it('a la mesa de un pedido ya cerrado se acepta', () => {
    const { ana, beto, abrir, pasar, mandar } = equipo()
    const [m1, m2] = [nuevoId(), nuevoId()]
    const { pedido } = abrir(ana, m1)
    const otro = abrir(beto, m2).pedido
    mandar(beto, otro, 'PedidoCerrado', {})
    expect(pasar(ana, pedido, m2)?.estado).toBe('confirmado')
  })

  it('dos equipos que quieren la misma mesa libre: gana el primero y el segundo se rechaza', () => {
    const { m, ana, beto, abrir, pasar } = equipo()
    const [m1, m2, libre] = [nuevoId(), nuevoId(), nuevoId()]
    const a = abrir(ana, m1).pedido
    const b = abrir(beto, m2).pedido
    expect(pasar(ana, a, libre)?.estado).toBe('confirmado')
    expect(pasar(beto, b, libre, { conoce: false })).toMatchObject({
      estado: 'rechazado',
      motivo: 'mesa_ocupada',
    })
    expect(m.hub().pedido(b)?.mesaId).toBe(m2)
  })

  it('dos pedidos que se unen a la misma libre: solo el primero queda con ella', () => {
    const { m, ana, beto, abrir, unir } = equipo()
    const [m1, m2, libre] = [nuevoId(), nuevoId(), nuevoId()]
    const a = abrir(ana, m1).pedido
    const b = abrir(beto, m2).pedido
    expect(unir(ana, a, [libre])?.estado).toBe('confirmado')
    expect(unir(beto, b, [libre], { conoce: false })).toMatchObject({
      estado: 'rechazado',
      motivo: 'mesa_ocupada',
    })
    expect(m.hub().pedido(b)?.mesasUnidas).toEqual([])
  })
})

describe('un pedido vacío después de tener productos ya no ocupa su mesa', () => {
  const copia = (i: ReturnType<typeof item>) => {
    const { catalogo_version: _v, precio_canal_id: _c, ...resto } = i
    return resto
  }

  it('uno recién abierto, sin productos, sí la ocupa (y sus unidas también)', () => {
    const { m, ana, beto, abrir, unir } = equipo()
    const [m1, m2] = [nuevoId(), nuevoId()]
    const { pedido } = abrir(ana, m1)
    unir(ana, pedido, [m2])
    expect(m.hub().tienePedidoAbierto(m1)).toBe(true)
    expect(m.hub().tienePedidoAbierto(m2)).toBe(true)
    expect(abrir(beto, m1).resultado).toMatchObject({ estado: 'rechazado', motivo: 'mesa_ocupada' })
  })

  it('al mover todos sus productos a otro pedido, su mesa y sus unidas quedan libres', () => {
    const { m, ana, beto, abrir, unir, mandar } = equipo()
    const [m1, m2, m3] = [nuevoId(), nuevoId(), nuevoId()]
    const { pedido: origen } = abrir(ana, m1)
    unir(ana, origen, [m2])
    const it = item(12_900)
    mandar(ana, origen, 'ItemAgregado', it)
    mandar(ana, origen, 'ItemsEnviados', {
      comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [it.item_id] }],
    })
    expect(m.hub().tienePedidoAbierto(m1)).toBe(true)
    const destino = abrir(ana, m3).pedido
    const r = mandar(
      ana,
      origen,
      'ItemsMovidos',
      {
        pedido_destino_id: destino,
        items: [
          { item: copia(it), estado: 'enviado', cantidad_anulada: 0, agregado_por: ana.usuarioId },
        ],
      },
      { relacionados: [destino] },
    )
    expect(r?.estado).toBe('confirmado')
    // El origen sigue abierto pero vacío: ya no ocupa nada.
    expect(m.hub().pedido(origen)?.estado).toBe('abierto')
    expect(m.hub().tienePedidoAbierto(m1)).toBe(false)
    expect(m.hub().tienePedidoAbierto(m2)).toBe(false)
    expect(m.hub().tienePedidoAbierto(m3)).toBe(true)
    // Otro equipo puede abrir esas mesas, y cambiarse o unir a ellas.
    expect(abrir(beto, m1).resultado).toMatchObject({ estado: 'confirmado', conflicto: null })
    const otro = abrir(beto, nuevoId()).pedido
    expect(unir(beto, otro, [m2])?.estado).toBe('confirmado')
  })

  it('al anular todo lo que tenía, también se libera; con una unidad viva, no', () => {
    const { m, ana, abrir, mandar } = equipo()
    const m1 = nuevoId()
    const { pedido } = abrir(ana, m1)
    const it = item(12_900, { cantidad: 2 })
    mandar(ana, pedido, 'ItemAgregado', it)
    mandar(ana, pedido, 'ItemsEnviados', {
      comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [it.item_id] }],
    })
    const anular = (cantidad: number) =>
      mandar(ana, pedido, 'ItemAnulado', {
        item_id: it.item_id,
        cantidad,
        ya_preparado: false,
        comanda_id: null,
      })
    expect(anular(1)?.estado).toBe('confirmado')
    expect(m.hub().tienePedidoAbierto(m1)).toBe(true)
    expect(anular(1)?.estado).toBe('confirmado')
    expect(m.hub().tienePedidoAbierto(m1)).toBe(false)
  })

  it('un pedido solo con lo ya entregado sigue ocupando la mesa (la cuenta no está cerrada)', () => {
    const { m, ana, abrir, mandar } = equipo()
    const m1 = nuevoId()
    const { pedido } = abrir(ana, m1)
    const it = item()
    mandar(ana, pedido, 'ItemAgregado', it)
    mandar(ana, pedido, 'ItemsEnviados', {
      comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [it.item_id] }],
    })
    mandar(ana, pedido, 'ItemEntregado', { item_ids: [it.item_id] })
    expect(m.hub().tienePedidoAbierto(m1)).toBe(true)
  })

  it('cambiarse a la mesa de un pedido vaciado se acepta', () => {
    const { ana, beto, abrir, mandar, pasar } = equipo()
    const [m1, m2] = [nuevoId(), nuevoId()]
    const vacio = abrir(ana, m1).pedido
    const it = item()
    mandar(ana, vacio, 'ItemAgregado', it)
    mandar(ana, vacio, 'ItemsEnviados', {
      comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [it.item_id] }],
    })
    mandar(ana, vacio, 'ItemAnulado', {
      item_id: it.item_id,
      cantidad: 1,
      ya_preparado: false,
      comanda_id: null,
    })
    const otro = abrir(beto, m2).pedido
    expect(pasar(beto, otro, m1)?.estado).toBe('confirmado')
  })

  // Un pedido vaciado suelta su mesa pero conserva `mesaId`: si otro la toma y el vaciado recibe un
  // producto, volvería a ocuparla; el hub lo revisa como al abrir (`mesasQueToma`).
  it('agregar un producto a un pedido vaciado cuya mesa tomó otro se rechaza o se avisa', () => {
    const { ana, beto, abrir, mandar } = equipo()
    const m1 = nuevoId()
    const { pedido } = abrir(ana, m1)
    const it = item()
    mandar(ana, pedido, 'ItemAgregado', it)
    mandar(ana, pedido, 'ItemsEnviados', {
      comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [it.item_id] }],
    })
    mandar(ana, pedido, 'ItemAnulado', {
      item_id: it.item_id,
      cantidad: 1,
      ya_preparado: false,
      comanda_id: null,
    })
    expect(abrir(beto, m1).resultado?.estado).toBe('confirmado')
    const r = mandar(ana, pedido, 'ItemAgregado', item())
    expect(r?.estado === 'rechazado' || (r?.estado === 'confirmado' && r.conflicto !== null)).toBe(
      true,
    )
  })

  it('quitar lo que aún no se enviaba no suelta la mesa: otro mesero no puede abrirla', () => {
    const { ana, beto, abrir, mandar } = equipo()
    const m1 = nuevoId()
    const { pedido } = abrir(ana, m1)
    const it = item()
    mandar(ana, pedido, 'ItemAgregado', it)
    mandar(ana, pedido, 'ItemQuitado', { item_id: it.item_id })
    expect(abrir(beto, m1).resultado?.estado).toBe('rechazado')
  })

  // Reabrir una cuenta cuya mesa ya tomó otro pedido no deja dos pedidos abiertos en la mesa.
  it('reabrir una cuenta cuya mesa otro pedido ya tomó se rechaza o se avisa', () => {
    const { ana, beto, abrir, mandar } = equipo()
    const m1 = nuevoId()
    const { pedido } = abrir(ana, m1)
    mandar(ana, pedido, 'PedidoCerrado', {})
    abrir(beto, m1)
    const r = mandar(ana, pedido, 'PedidoReabierto', {})
    expect(r?.estado === 'rechazado' || (r?.estado === 'confirmado' && r.conflicto !== null)).toBe(
      true,
    )
  })
})

describe('tienePedidoAbierto con mesas unidas', () => {
  it('cuenta las unidas, también tras reiniciar el hub y desde SalaSync', () => {
    const { m, ana, abrir, unir } = equipo()
    const [m1, m2, otra] = [nuevoId(), nuevoId(), nuevoId()]
    const { pedido } = abrir(ana, m1)
    unir(ana, pedido, [m2])
    expect(m.red.sala.tienePedidoAbierto(m2)).toBe(true)
    m.red.caerHub()
    expect(m.hub().tienePedidoAbierto(m2)).toBe(true)
    expect(m.hub().tienePedidoAbierto(otra)).toBe(false)
    expect(m.red.sala.tienePedidoAbierto(m2)).toBe(true)
  })

  it('con el hub en memoria (sin SQLite) responde igual', () => {
    const hub = new HubSync(new AlmacenMemoria(), {
      restauranteId: '',
      zonaHoraria: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      instancia: 'hub-1',
      reloj: () => AHORA,
      acceso: accesoLibre,
    })
    const con: Conexion = { dispositivoId: nuevoId(), tipo: 'mesero', revocadoEn: null }
    const usuario = nuevoId()
    const [m1, m2] = [nuevoId(), nuevoId()]
    const pedido = nuevoId()
    const base = (tipo: string, datos: unknown, secuencia_base: number) => ({
      id: nuevoId(),
      tipo,
      version_esquema: 1,
      agregado_tipo: 'pedido',
      agregado_id: pedido,
      relacionados: [],
      datos,
      sesion_id: null,
      usuario_id: usuario,
      dispositivo_id: con.dispositivoId,
      autorizacion_id: null,
      motivo: null,
      hora_dispositivo: AHORA,
      hora_estimada_hub: AHORA,
      secuencia_base,
    })
    const r = hub.recibirLote(con, [
      base('PedidoAbierto', { canal: 'salon', mesa_id: m1, comensales: 2 }, 0),
      base('MesasUnidas', { mesa_ids: [m2] }, 1),
    ])
    expect(r.resultados.map((x) => x.estado)).toEqual(['confirmado', 'confirmado'])
    expect(hub.tienePedidoAbierto(m2)).toBe(true)
  })

  it('una mesa unida a un pedido con otras unidas: solo esas cuentan', () => {
    const { m, ana, abrir, unir, separar } = equipo()
    const mesas = Array.from({ length: 5 }, () => nuevoId())
    const { pedido } = abrir(ana, mesas[0] as string)
    unir(ana, pedido, mesas.slice(1, 4))
    separar(ana, pedido, [mesas[2] as string])
    expect(mesas.map((x) => m.hub().tienePedidoAbierto(x))).toEqual([
      true,
      true,
      false,
      true,
      false,
    ])
  })
})

describe('mover productos a otra mesa', () => {
  const copia = (i: ReturnType<typeof item>) => {
    const { catalogo_version: _v, precio_canal_id: _c, ...resto } = i
    return resto
  }

  function conPlatoEnviado() {
    const e = equipo()
    const m1 = nuevoId()
    const origen = e.abrir(e.ana, m1).pedido
    const it = item(12_900, { cantidad: 2 })
    e.mandar(e.ana, origen, 'ItemAgregado', it)
    e.mandar(e.ana, origen, 'ItemsEnviados', {
      comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [it.item_id] }],
    })
    const movimiento = (destino: string, extras = {}) => ({
      pedido: origen,
      tipo: 'ItemsMovidos',
      datos: {
        pedido_destino_id: destino,
        items: [
          {
            item: copia(it),
            estado: 'enviado',
            cantidad_anulada: 0,
            agregado_por: e.ana.usuarioId,
          },
        ],
      },
      extras: { relacionados: [destino], ...extras },
    })
    return { ...e, origen, it, movimiento }
  }

  it('a una mesa libre, en un lote: se abre el pedido y se mueve, todo o nada', () => {
    const e = conPlatoEnviado()
    const destino = nuevoId()
    const libre = nuevoId()
    const hub = e.m.hub()
    const conexion = conexionDe(e.m, e.ana)
    const base = e.m.almacen.maxSecuencia()
    const mov = e.movimiento(destino)
    const sobre = (tipo: string, pedido: string, datos: unknown, extras = {}) => ({
      id: nuevoId(),
      tipo,
      version_esquema: 1,
      agregado_tipo: 'pedido',
      agregado_id: pedido,
      relacionados: [],
      datos,
      sesion_id: null,
      usuario_id: e.ana.usuarioId,
      dispositivo_id: e.ana.dispositivoId,
      autorizacion_id: null,
      motivo: null,
      hora_dispositivo: AHORA,
      hora_estimada_hub: AHORA,
      secuencia_base: base,
      ...extras,
    })
    const r = hub.recibirLote(conexion, [
      sobre('PedidoAbierto', destino, { canal: 'salon', mesa_id: libre, comensales: 1 }),
      sobre('ItemsMovidos', mov.pedido, mov.datos, mov.extras),
    ])
    expect(r.resultados.map((x) => x.estado)).toEqual(['confirmado', 'confirmado'])
    expect(hub.pedido(destino)?.items[e.it.item_id]).toMatchObject({
      estado: 'enviado',
      cantidad: 2,
    })
    expect(hub.pedido(e.origen)?.items).toEqual({})
    expect(hub.tienePedidoAbierto(libre)).toBe(true)
  })

  it('si la mesa del pedido nuevo está ocupada, se rechaza la apertura y también el movimiento', () => {
    const e = conPlatoEnviado()
    const ocupada = nuevoId()
    e.abrir(e.beto, ocupada)
    const destino = nuevoId()
    const mov = e.movimiento(destino)
    const base = e.m.almacen.maxSecuencia()
    const sobre = (tipo: string, pedido: string, datos: unknown, extras = {}) => ({
      id: nuevoId(),
      tipo,
      version_esquema: 1,
      agregado_tipo: 'pedido',
      agregado_id: pedido,
      relacionados: [],
      datos,
      sesion_id: null,
      usuario_id: e.ana.usuarioId,
      dispositivo_id: e.ana.dispositivoId,
      autorizacion_id: null,
      motivo: null,
      hora_dispositivo: AHORA,
      hora_estimada_hub: AHORA,
      secuencia_base: base,
      ...extras,
    })
    const r = e.m
      .hub()
      .recibirLote(conexionDe(e.m, e.ana), [
        sobre('PedidoAbierto', destino, { canal: 'salon', mesa_id: ocupada, comensales: 1 }),
        sobre('ItemsMovidos', mov.pedido, mov.datos, mov.extras),
      ])
    expect(r.resultados[0]).toMatchObject({ estado: 'rechazado', motivo: 'mesa_ocupada' })
    expect(r.resultados[1]).toMatchObject({ estado: 'rechazado', motivo: 'depende_de_rechazado' })
    // El plato sigue donde estaba.
    expect(e.m.hub().pedido(e.origen)?.items[e.it.item_id]?.estado).toBe('enviado')
  })

  it('a un pedido que ya existe con otro equipo al día se acepta sin conflicto', () => {
    const e = conPlatoEnviado()
    const destino = e.abrir(e.beto, nuevoId()).pedido
    const mov = e.movimiento(destino)
    const r = e.mandar(e.ana, mov.pedido, mov.tipo, mov.datos, mov.extras)
    expect(r).toMatchObject({ estado: 'confirmado', conflicto: null })
  })

  it('sin estar al día y con el plato ya anulado por otro equipo: se rechaza, no es conflicto', () => {
    const e = conPlatoEnviado()
    const destino = e.abrir(e.ana, nuevoId()).pedido
    const baseDeAna = e.m.almacen.maxSecuencia()
    // Beto anula todo el plato mientras Ana no se entera.
    expect(
      e.mandar(e.beto, e.origen, 'ItemAnulado', {
        item_id: e.it.item_id,
        cantidad: 2,
        ya_preparado: false,
        comanda_id: null,
      })?.estado,
    ).toBe('confirmado')
    const mov = e.movimiento(destino)
    const r = e.mandar(e.ana, mov.pedido, mov.tipo, mov.datos, {
      ...mov.extras,
      secuencia_base: baseDeAna,
    })
    expect(r).toMatchObject({ estado: 'rechazado' })
    expect(e.m.hub().conflictos()).toEqual([])
    expect(e.m.hub().pedido(destino)?.items).toEqual({})
  })

  it('en contraste, anular sin estar al día lo que otro ya anuló sí se acepta como conflicto', () => {
    const e = conPlatoEnviado()
    const baseDeAna = e.m.almacen.maxSecuencia()
    const anular = (quien: Nodo, extras = {}) =>
      e.mandar(
        quien,
        e.origen,
        'ItemAnulado',
        { item_id: e.it.item_id, cantidad: 2, ya_preparado: false, comanda_id: null },
        extras,
      )
    anular(e.beto)
    expect(anular(e.ana, { secuencia_base: baseDeAna })).toMatchObject({
      estado: 'confirmado',
      conflicto: 'item_ya_anulado',
    })
  })

  it('sin estar al día, con la copia desfasada (otro anuló una unidad): copia_distinta, rechazado', () => {
    const e = conPlatoEnviado()
    const destino = e.abrir(e.ana, nuevoId()).pedido
    const baseDeAna = e.m.almacen.maxSecuencia()
    e.mandar(e.beto, e.origen, 'ItemAnulado', {
      item_id: e.it.item_id,
      cantidad: 1,
      ya_preparado: false,
      comanda_id: null,
    })
    const mov = e.movimiento(destino)
    expect(
      e.mandar(e.ana, mov.pedido, mov.tipo, mov.datos, {
        ...mov.extras,
        secuencia_base: baseDeAna,
      }),
    ).toMatchObject({ estado: 'rechazado', motivo: 'copia_distinta' })
  })

  it('al día y con un plato que ya no está en el origen: rechazado (item_inexistente)', () => {
    const e = conPlatoEnviado()
    const destino = e.abrir(e.ana, nuevoId()).pedido
    const mov = e.movimiento(destino)
    expect(e.mandar(e.ana, mov.pedido, mov.tipo, mov.datos, mov.extras)?.estado).toBe('confirmado')
    // Moverlo otra vez desde el origen: ya no está.
    expect(e.mandar(e.ana, mov.pedido, mov.tipo, mov.datos, mov.extras)).toMatchObject({
      estado: 'rechazado',
      motivo: 'item_inexistente',
    })
  })

  it('el mismo movimiento reenviado (respuesta perdida) da la misma respuesta y no mueve dos veces', () => {
    const e = conPlatoEnviado()
    const destino = e.abrir(e.ana, nuevoId()).pedido
    const mov = e.movimiento(destino)
    const evento = {
      id: nuevoId(),
      tipo: mov.tipo,
      version_esquema: 1,
      agregado_tipo: 'pedido',
      agregado_id: mov.pedido,
      relacionados: [destino],
      datos: mov.datos,
      sesion_id: null,
      usuario_id: e.ana.usuarioId,
      dispositivo_id: e.ana.dispositivoId,
      autorizacion_id: null,
      motivo: null,
      hora_dispositivo: AHORA,
      hora_estimada_hub: AHORA,
      secuencia_base: e.m.almacen.maxSecuencia(),
    }
    const conexion = conexionDe(e.m, e.ana)
    const a = e.m.hub().recibirLote(conexion, [evento])
    const b = e.m.hub().recibirLote(conexion, [evento])
    expect(a.resultados[0]?.estado).toBe('confirmado')
    expect(b.resultados).toEqual(a.resultados)
    expect(b.aceptados).toEqual([])
    expect(Object.keys(e.m.hub().pedido(destino)?.items ?? {})).toEqual([e.it.item_id])
  })

  it('el evento llega a los dos pedidos: el hub lo cuenta en el origen y en el destino', () => {
    const e = conPlatoEnviado()
    const destino = e.abrir(e.ana, nuevoId()).pedido
    const mov = e.movimiento(destino)
    e.mandar(e.ana, mov.pedido, mov.tipo, mov.datos, mov.extras)
    const dedestino = e.m.almacen.eventosDeAgregado(destino).map((x) => x.tipo)
    expect(dedestino).toEqual(['PedidoAbierto', 'ItemsMovidos'])
  })
})

describe('varios restaurantes en la misma base', () => {
  function dosHubs() {
    const { db, restauranteId } = baseSqlite()
    const otro = nuevoId()
    db.prepare(
      `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
       VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
    ).run(otro, otro, AHORA, AHORA)
    const crear = (id: string) =>
      new HubSync(new AlmacenSqlite(db, id), {
        restauranteId: id,
        zonaHoraria: 'America/Bogota',
        inicioDiaOperativo: '06:00',
        instancia: `hub-${id}`,
        reloj: () => AHORA,
        acceso: accesoLibre,
      })
    return { db, uno: crear(restauranteId), dos: crear(otro), restauranteId, otro }
  }
  const dispositivo = (): Conexion => ({
    dispositivoId: nuevoId(),
    tipo: 'mesero',
    revocadoEn: null,
  })
  const sobre = (
    con: Conexion,
    pedido: string,
    tipo: string,
    datos: unknown,
    secuencia_base = 0,
  ) => ({
    id: nuevoId(),
    tipo,
    version_esquema: 1,
    agregado_tipo: 'pedido',
    agregado_id: pedido,
    relacionados: [],
    datos,
    sesion_id: null,
    usuario_id: nuevoId(),
    dispositivo_id: con.dispositivoId,
    autorizacion_id: null,
    motivo: null,
    hora_dispositivo: AHORA,
    hora_estimada_hub: AHORA,
    secuencia_base,
  })

  it('la misma mesa en dos restaurantes no choca: ni al abrir, ni al unir, ni al cambiarse', () => {
    const { uno, dos } = dosHubs()
    const [cUno, cDos] = [dispositivo(), dispositivo()]
    const [mesa, otra] = [nuevoId(), nuevoId()]
    const a = nuevoId()
    const b = nuevoId()
    expect(
      uno.recibirLote(cUno, [
        sobre(cUno, a, 'PedidoAbierto', { canal: 'salon', mesa_id: mesa, comensales: 1 }),
      ]).resultados[0]?.estado,
    ).toBe('confirmado')
    expect(
      dos.recibirLote(cDos, [
        sobre(cDos, b, 'PedidoAbierto', { canal: 'salon', mesa_id: mesa, comensales: 1 }),
      ]).resultados[0],
    ).toMatchObject({ estado: 'confirmado', conflicto: null })
    // Unirla en uno no la ocupa en el otro.
    uno.recibirLote(cUno, [sobre(cUno, a, 'MesasUnidas', { mesa_ids: [otra] }, 1)])
    expect(uno.tienePedidoAbierto(otra)).toBe(true)
    expect(dos.tienePedidoAbierto(otra)).toBe(false)
    expect(
      dos.recibirLote(cDos, [sobre(cDos, b, 'PedidoMovidoDeMesa', { mesa_destino_id: otra }, 1)])
        .resultados[0]?.estado,
    ).toBe('confirmado')
  })

  it('cada hub solo ve y numera lo suyo', () => {
    const { uno, dos, db, restauranteId, otro } = dosHubs()
    const [cUno, cDos] = [dispositivo(), dispositivo()]
    const mesa = nuevoId()
    uno.recibirLote(cUno, [
      sobre(cUno, nuevoId(), 'PedidoAbierto', { canal: 'salon', mesa_id: mesa, comensales: 1 }),
    ])
    expect(dos.tienePedidoAbierto(mesa)).toBe(false)
    dos.recibirLote(cDos, [
      sobre(cDos, nuevoId(), 'PedidoAbierto', { canal: 'salon', mesa_id: mesa, comensales: 1 }),
    ])
    const cuenta = (r: string) =>
      db.prepare('SELECT count(*) AS n FROM evento WHERE restaurante_id = ?').get(r)?.n
    expect([cuenta(restauranteId), cuenta(otro)]).toEqual([1, 1])
    // Un hub nuevo sobre la misma base reconstruye solo lo de su restaurante.
    const reiniciado = new HubSync(new AlmacenSqlite(db, restauranteId), {
      restauranteId,
      zonaHoraria: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      instancia: 'hub-nuevo',
      reloj: () => AHORA,
      acceso: accesoLibre,
    })
    expect(reiniciado.tienePedidoAbierto(mesa)).toBe(true)
    expect(new SalaSync(reiniciado, () => null).tienePedidoAbierto(mesa)).toBe(true)
  })
})
