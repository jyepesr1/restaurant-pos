import {
  configCompleta,
  impuestosDelPedido,
  nuevoId,
  propinaDelPedido,
  totalesPedido,
} from '@pos/core'
import { COLUMNAS, type Precuenta } from '@pos/printing'
import { describe, expect, it } from 'vitest'
import { item } from '../acceso/montaje-hub'
import { trabajosDeEvento } from './comandas'
import { type Equipo, type MontajeImpresion, montarImpresion } from './montaje-impresion'

// La precuenta impresa (tarea 1.6): `PrecuentaImpresa` crea un trabajo `precuenta` en la cola con
// los montos que calcula el hub, la cola lo imprime y la lista de pendientes lo nombra.

const turnoYPago = (caja: Equipo, pedido: string, monto: number, extra: object = {}) => {
  const turno = nuevoId()
  const abierto = caja.mandar(
    turno,
    'TurnoAbierto',
    { caja_id: caja.conexion.dispositivoId, base: 0 },
    { agregado_tipo: 'turno_caja' },
  )
  expect(abierto.estado).toBe('confirmado')
  return pago(caja, pedido, turno, monto, extra)
}
const pago = (caja: Equipo, pedido: string, turno: string, monto: number, extra: object = {}) =>
  caja.mandar(pedido, 'PagoRegistrado', {
    pago_id: nuevoId(),
    cuenta_id: null,
    turno_caja_id: turno,
    medio: 'nequi',
    monto,
    propina: 0,
    recibido: null,
    cambio: null,
    ajuste_redondeo: 0,
    redondeo: null,
    datafono: null,
    referencia_cobro: null,
    ...extra,
  })

function mundo(opciones: { ancho?: 58 | 80; conImpresora?: boolean } = {}) {
  const t = montarImpresion()
  const ana = t.equipo('mesero')
  const cajero = t.equipo('cajero', 'caja')
  const admin = t.equipo('admin', 'caja')
  const impresora = t.impresoraNueva('Caja', [], { ancho: opciones.ancho ?? 80 })
  const elegir = (id: string | null) =>
    t.post('/api/caja/precuenta', { ...admin.cuerpoSesion, impresora_id: id }, admin.token)
  if (opciones.conImpresora !== false) {
    t.db
      .prepare('UPDATE restaurante SET config = ? WHERE id = ?')
      .run(JSON.stringify({ impresora_precuenta_id: impresora.id }), t.restauranteId)
  }
  const agregarCon = (pedido: string, precio: number, campos: object = {}) => {
    const it = { ...item(), precio_unitario: precio, ...campos }
    const r = ana.mandar(pedido, 'ItemAgregado', it)
    expect(r.estado).toBe('confirmado')
    return it
  }
  const precuenta = (pedido: string, cuentaId: string | null = null, extra: object = {}) =>
    ana.mandar(pedido, 'PrecuentaImpresa', {
      cuenta_id: cuentaId,
      subtotal: 0,
      propina_sugerida: 0,
      ...extra,
    })
  const guardada = (): Precuenta[] =>
    t.trabajos("WHERE tipo = 'precuenta'").map((f) => t.contenido(f) as Precuenta)
  return { t, ana, cajero, admin, impresora, elegir, agregarCon, precuenta, guardada }
}

describe('trabajoDePrecuenta: cuándo se crea', () => {
  it('sin impresora de precuentas elegida no se crea nada, y el evento se acepta', () => {
    const { t, ana, precuenta, agregarCon } = mundo({ conImpresora: false })
    const pedido = t.abrir(ana)
    agregarCon(pedido, 40_900)
    const r = precuenta(pedido)
    expect(r.estado).toBe('confirmado')
    expect(t.trabajos()).toEqual([])
    expect(t.fallosGuardar).toEqual([])
  })

  it('con una impresora elegida crea un trabajo precuenta para esa impresora, pendiente', () => {
    const { t, ana, precuenta, agregarCon, impresora } = mundo()
    const pedido = t.abrir(ana)
    agregarCon(pedido, 40_900)
    precuenta(pedido)
    const trabajos = t.trabajos()
    expect(trabajos).toHaveLength(1)
    expect(trabajos[0]).toMatchObject({
      tipo: 'precuenta',
      impresora_id: impresora.id,
      estado: 'pendiente',
      intentos: 0,
      comanda_id: 'precuenta',
      restaurante_id: t.restauranteId,
    })
    expect(trabajos[0]?.evento_id).toBeTruthy()
  })

  it('una impresora archivada no recibe precuentas', () => {
    const { t, ana, precuenta, agregarCon, impresora } = mundo()
    t.db.prepare('UPDATE impresora SET activo = 0 WHERE id = ?').run(impresora.id)
    const pedido = t.abrir(ana)
    agregarCon(pedido, 40_900)
    expect(precuenta(pedido).estado).toBe('confirmado')
    expect(t.trabajos()).toEqual([])
  })

  it('si la impresora se vuelve a activar, la siguiente precuenta sí sale', () => {
    const { t, ana, precuenta, agregarCon, impresora } = mundo()
    const pedido = t.abrir(ana)
    agregarCon(pedido, 40_900)
    t.db.prepare('UPDATE impresora SET activo = 0 WHERE id = ?').run(impresora.id)
    precuenta(pedido)
    t.db.prepare('UPDATE impresora SET activo = 1 WHERE id = ?').run(impresora.id)
    precuenta(pedido)
    expect(t.trabajos()).toHaveLength(1)
  })

  it('una impresora de otro restaurante (configuración manipulada) no recibe nada', () => {
    const { t, ana, precuenta, agregarCon } = mundo({ conImpresora: false })
    const otro = nuevoId()
    t.db
      .prepare(
        `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
         VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
      )
      .run(otro, otro, new Date(t.reloj()).toISOString(), new Date(t.reloj()).toISOString())
    const ajena = nuevoId()
    t.db
      .prepare(
        `INSERT INTO impresora (id, restaurante_id, creado_en, actualizado_en, version, nombre, conexion, direccion, puerto, ancho)
         VALUES (?, ?, ?, ?, 1, 'Ajena', 'red', '10.9.9.9', 9100, 80)`,
      )
      .run(ajena, otro, new Date(t.reloj()).toISOString(), new Date(t.reloj()).toISOString())
    t.db
      .prepare('UPDATE restaurante SET config = ? WHERE id = ?')
      .run(JSON.stringify({ impresora_precuenta_id: ajena }), t.restauranteId)
    const pedido = t.abrir(ana)
    agregarCon(pedido, 40_900)
    expect(precuenta(pedido).estado).toBe('confirmado')
    expect(t.trabajos()).toEqual([])
  })

  it('elegirla por la ruta y quitarla por la ruta enciende y apaga la impresión', async () => {
    const { t, ana, precuenta, agregarCon, impresora, elegir } = mundo({ conImpresora: false })
    const pedido = t.abrir(ana)
    agregarCon(pedido, 40_900)
    precuenta(pedido)
    expect(t.trabajos()).toHaveLength(0)
    expect((await elegir(impresora.id)).statusCode).toBe(204)
    precuenta(pedido)
    expect(t.trabajos()).toHaveLength(1)
    expect((await elegir(null)).statusCode).toBe(204)
    precuenta(pedido)
    expect(t.trabajos()).toHaveLength(1)
  })

  it('otros eventos del pedido no crean precuentas', () => {
    const { t, ana, agregarCon } = mundo()
    const pedido = t.abrir(ana)
    agregarCon(pedido, 40_900)
    ana.mandar(pedido, 'ComensalesCambiados', { comensales: 3 })
    expect(t.trabajos("WHERE tipo = 'precuenta'")).toEqual([])
  })
})

describe('trabajoDePrecuenta: los montos cuadran con el pedido', () => {
  it('lleva restaurante, mesa, mesero, número del pedido, comensales y las líneas', () => {
    const { t, ana, agregarCon, precuenta, guardada } = mundo()
    const mesa = t.mesa('5')
    const pedido = t.abrir(ana, mesa)
    agregarCon(pedido, 40_900, { nombre: 'Garden Margarita', cantidad: 2 })
    agregarCon(pedido, 58_900, { nombre: 'Tagliata' })
    precuenta(pedido)
    const [p] = guardada()
    expect(p).toMatchObject({
      destino: 'Mesa 5',
      mesero: 'Ana',
      pedido: 1,
      comensales: 2,
      cuenta: null,
    })
    expect(p?.restaurante).toBeTruthy()
    expect(p?.hora).toMatch(/\d/)
    expect(p?.lineas).toEqual([
      { cantidad: 2, nombre: 'Garden Margarita', opciones: [], valor: 81_800 },
      { cantidad: 1, nombre: 'Tagliata', opciones: [], valor: 58_900 },
    ])
  })

  it('total, subtotal y propina salen del pedido: 140.700 al 10 % da 13.028', () => {
    const { t, ana, agregarCon, precuenta, guardada } = mundo()
    const pedido = t.abrir(ana)
    agregarCon(pedido, 81_800)
    agregarCon(pedido, 58_900)
    precuenta(pedido, null, { propina_sugerida: 13_028 })
    const [p] = guardada()
    const estado = t.hub.pedido(pedido)
    if (!estado) throw new Error('sin pedido')
    expect(p).toMatchObject({ total: 140_700, pagado: 0, subtotal: 140_700, tasaPropina: 1000 })
    expect(p?.propina).toBe(propinaDelPedido(estado, 140_700, configCompleta()))
    expect(p?.propina).toBe(13_028)
  })

  it('lo que se debe lo calcula el hub: el subtotal del evento se ignora', () => {
    const { t, ana, agregarCon, precuenta, guardada } = mundo()
    const pedido = t.abrir(ana)
    agregarCon(pedido, 40_900)
    precuenta(pedido, null, { subtotal: 1, propina_sugerida: 3_787 })
    const [p] = guardada()
    expect(p?.subtotal).toBe(40_900)
    expect(p?.total).toBe(40_900)
  })

  it('la propina es la que se eligió al pedir la precuenta: la sugerida lleva su tasa; otra, no', () => {
    const { t, ana, agregarCon, precuenta, guardada } = mundo()
    const pedido = t.abrir(ana)
    agregarCon(pedido, 40_900)
    precuenta(pedido, null, { propina_sugerida: 3_787 })
    precuenta(pedido, null, { propina_sugerida: 5_000 })
    precuenta(pedido, null, { propina_sugerida: 0 })
    expect(guardada().map((p) => [p.propina, p.tasaPropina])).toEqual([
      [3_787, 1000],
      [5_000, null],
      [0, null],
    ])
    // El saldo y el total no dependen de la propina elegida.
    for (const p of guardada()) expect(p).toMatchObject({ subtotal: 40_900, total: 40_900 })
  })

  it('la suma de las líneas es el total, y base + impuesto de cada grupo suma el total', () => {
    const { t, ana, agregarCon, precuenta, guardada } = mundo()
    const pedido = t.abrir(ana)
    agregarCon(pedido, 12_900, { cantidad: 3 })
    agregarCon(pedido, 16_000)
    agregarCon(pedido, 10_000, { impuesto_tipo: 'iva', tarifa: 1900 })
    agregarCon(pedido, 5_000, { impuesto_tipo: 'exento', tarifa: 0 })
    precuenta(pedido)
    const [p] = guardada()
    expect(p?.lineas.reduce((a, l) => a + l.valor, 0)).toBe(p?.total)
    expect(p?.impuestos?.reduce((a, i) => a + i.base + i.valor, 0)).toBe(p?.total)
    expect(p?.impuestos?.map((i) => i.nombre).sort()).toEqual(['Exento', 'INC 8 %', 'IVA 19 %'])
    expect(p?.impuestos?.find((i) => i.nombre === 'Exento')?.valor).toBe(0)
    const estado = t.hub.pedido(pedido)
    if (!estado) throw new Error('sin pedido')
    expect(p?.impuestos?.map((i) => i.valor).sort()).toEqual(
      impuestosDelPedido(estado, 'mitad_arriba')
        .map((i) => i.impuesto)
        .sort(),
    )
  })

  it('las opciones del plato salen en su línea', () => {
    const { t, ana, agregarCon, precuenta, guardada } = mundo()
    const pedido = t.abrir(ana)
    agregarCon(pedido, 58_900, {
      nombre: 'Tagliata',
      modificadores: [{ modificador_id: nuevoId(), nombre: 'Término medio', precio_extra: 0 }],
    })
    precuenta(pedido)
    expect(guardada()[0]?.lineas[0]?.opciones).toEqual(['Término medio'])
  })

  it('un plato anulado no sale; uno anulado en parte sale con las unidades que quedan', () => {
    const { t, ana, agregarCon, precuenta, guardada } = mundo()
    const pedido = t.abrir(ana)
    const cervezas = agregarCon(pedido, 14_900, { nombre: 'Heineken', cantidad: 3 })
    const plato = agregarCon(pedido, 40_900, { nombre: 'Pizza' })
    t.enviar(ana, pedido, [
      { id: cervezas.item_id, estacion: t.barra },
      { id: plato.item_id, estacion: t.cocina },
    ])
    const anular = (item_id: string, cantidad: number) =>
      ana.mandar(pedido, 'ItemAnulado', {
        item_id,
        cantidad,
        ya_preparado: false,
        comanda_id: null,
      })
    // El mesero no puede anular lo enviado: lo hace quien tiene el permiso.
    const cajero = t.equipo('cajero', 'caja')
    const anulaCajero = (item_id: string, cantidad: number) =>
      cajero.mandar(pedido, 'ItemAnulado', {
        item_id,
        cantidad,
        ya_preparado: false,
        comanda_id: null,
      })
    expect(anular(plato.item_id, 1).estado).toBe('rechazado')
    expect(anulaCajero(cervezas.item_id, 1).estado).toBe('confirmado')
    expect(anulaCajero(plato.item_id, 1).estado).toBe('confirmado')
    precuenta(pedido, null, { propina_sugerida: 2_759 })
    const [p] = guardada()
    expect(p?.lineas).toEqual([{ cantidad: 2, nombre: 'Heineken', opciones: [], valor: 29_800 }])
    expect(p?.total).toBe(29_800)
    expect(p?.subtotal).toBe(29_800)
    expect(p?.propina).toBe(2_759)
  })

  it('un descuento baja el total y la propina', () => {
    const { t, ana, agregarCon, precuenta, guardada } = mundo()
    const cajero = t.equipo('cajero', 'caja')
    const pedido = t.abrir(ana)
    const plato = agregarCon(pedido, 53_800)
    const r = cajero.mandar(
      pedido,
      'DescuentoAplicado',
      {
        descuento_id: nuevoId(),
        alcance: 'pedido',
        regla: 'porcentaje',
        valor: 1000,
        cantidad_unidades: null,
        montos: [{ item_id: plato.item_id, monto: 5_380 }],
      },
      { motivo: 'Cumpleaños' },
    )
    expect(r.estado).toBe('confirmado')
    precuenta(pedido, null, { propina_sugerida: 4_483 })
    const [p] = guardada()
    expect(p).toMatchObject({ total: 48_420, subtotal: 48_420, propina: 4_483, tasaPropina: 1000 })
    expect(p?.lineas).toEqual([expect.objectContaining({ nombre: 'Aperol Spritz', valor: 48_420 })])
  })

  it('con pagos previos: total entero, lo ya pagado, el saldo y la propina del saldo', () => {
    const { t, ana, cajero, agregarCon, precuenta, guardada } = mundo()
    const pedido = t.abrir(ana)
    agregarCon(pedido, 100_000)
    expect(turnoYPago(cajero, pedido, 40_000).estado).toBe('confirmado')
    precuenta(pedido, null, { propina_sugerida: 5_556 })
    const [p] = guardada()
    expect(p).toMatchObject({
      total: 100_000,
      pagado: 40_000,
      subtotal: 60_000,
      propina: 5_556,
      tasaPropina: 1000,
      cuenta: null,
    })
    // Σ líneas = total (la precuenta muestra todo lo que se consumió, no solo el saldo).
    expect(p?.lineas.reduce((a, l) => a + l.valor, 0)).toBe(100_000)
  })

  it('un pago con propina propia no cambia la propina sugerida del saldo', () => {
    const { t, ana, cajero, agregarCon, precuenta, guardada } = mundo()
    const pedido = t.abrir(ana)
    agregarCon(pedido, 100_000)
    turnoYPago(cajero, pedido, 40_000, { propina: 4_000 })
    precuenta(pedido, null, { propina_sugerida: 5_556 })
    expect(guardada()[0]).toMatchObject({
      pagado: 40_000,
      subtotal: 60_000,
      propina: 5_556,
      tasaPropina: 1000,
    })
  })

  it('un pedido pagado por completo: saldo 0 y propina 0', () => {
    const { t, ana, cajero, agregarCon, precuenta, guardada } = mundo()
    const pedido = t.abrir(ana)
    agregarCon(pedido, 40_900)
    turnoYPago(cajero, pedido, 40_900)
    precuenta(pedido)
    expect(guardada()[0]).toMatchObject({ total: 40_900, pagado: 40_900, subtotal: 0, propina: 0 })
  })

  it('una mesa vacía (sin productos) tampoco rompe: todo en cero', () => {
    const { t, ana, precuenta, guardada } = mundo()
    const pedido = t.abrir(ana)
    expect(precuenta(pedido).estado).toBe('confirmado')
    expect(guardada()[0]).toMatchObject({
      lineas: [],
      total: 0,
      subtotal: 0,
      propina: 0,
      impuestos: [],
    })
    expect(t.fallosGuardar).toEqual([])
  })

  it('tasa de propina distinta en el restaurante: la precuenta usa la vigente', () => {
    const { t, ana, agregarCon, precuenta, guardada, impresora } = mundo()
    t.db
      .prepare('UPDATE restaurante SET config = ? WHERE id = ?')
      .run(
        JSON.stringify({ impresora_precuenta_id: impresora.id, propina_sugerida: 500 }),
        t.restauranteId,
      )
    const pedido = t.abrir(ana)
    agregarCon(pedido, 100_000)
    precuenta(pedido, null, { propina_sugerida: 4_630 })
    expect(guardada()[0]).toMatchObject({ tasaPropina: 500, propina: 4_630 })
  })

  it('con propina sugerida en 0 %, la precuenta lleva propina 0', () => {
    const { t, ana, agregarCon, precuenta, guardada, impresora } = mundo()
    t.db
      .prepare('UPDATE restaurante SET config = ? WHERE id = ?')
      .run(
        JSON.stringify({ impresora_precuenta_id: impresora.id, propina_sugerida: 0 }),
        t.restauranteId,
      )
    const pedido = t.abrir(ana)
    agregarCon(pedido, 100_000)
    precuenta(pedido, null, { propina_sugerida: 0 })
    expect(guardada()[0]).toMatchObject({ tasaPropina: 0, propina: 0, subtotal: 100_000 })
  })

  it('el destino sigue al pedido: para llevar, varias mesas unidas', () => {
    const { t, ana, agregarCon, precuenta, guardada } = mundo()
    const llevar = t.abrir(ana, null, 'para_llevar')
    agregarCon(llevar, 10_000)
    precuenta(llevar)
    const m5 = t.mesa('5')
    const m6 = t.mesa('6')
    const grupo = t.abrir(ana, m5)
    agregarCon(grupo, 10_000)
    expect(ana.mandar(grupo, 'MesasUnidas', { mesa_ids: [m6] }).estado).toBe('confirmado')
    precuenta(grupo)
    expect(guardada().map((p) => p.destino)).toEqual(['Para llevar', 'Mesa 5 + 6'])
  })
})

describe('trabajoDePrecuenta: cuenta dividida', () => {
  /** Un pedido de $100.000 dividido en dos cuentas de $50.000 (propinas 4.630 y 4.629). */
  function dividido() {
    const m = mundo()
    const { t, ana, cajero, agregarCon } = m
    const pedido = t.abrir(ana)
    agregarCon(pedido, 100_000)
    const cuentas = [
      {
        cuenta_id: nuevoId(),
        nombre: 'Cuenta 1',
        monto: 50_000,
        propina_sugerida: 4_630,
        items: [],
      },
      {
        cuenta_id: nuevoId(),
        nombre: 'Cuenta 2',
        monto: 50_000,
        propina_sugerida: 4_629,
        items: [],
      },
    ]
    expect(cajero.mandar(pedido, 'CuentaDividida', { cuentas }).estado).toBe('confirmado')
    return { ...m, pedido, cuentas }
  }

  it('la precuenta de una cuenta lleva su nombre, su monto y su propina fijada al dividir', () => {
    const { precuenta, guardada, pedido, cuentas } = dividido()
    precuenta(pedido, cuentas[0]?.cuenta_id, { propina_sugerida: 4_630 })
    precuenta(pedido, cuentas[1]?.cuenta_id, { propina_sugerida: 4_629 })
    const [a, b] = guardada()
    expect(a).toMatchObject({
      cuenta: { nombre: 'Cuenta 1', monto: 50_000 },
      subtotal: 50_000,
      propina: 4_630,
      tasaPropina: 1000,
      total: 100_000,
    })
    expect(b).toMatchObject({
      cuenta: { nombre: 'Cuenta 2', monto: 50_000 },
      subtotal: 50_000,
      propina: 4_629,
      tasaPropina: 1000,
    })
    // Las dos propinas suman la del pedido entero (9.259).
    expect((a?.propina ?? 0) + (b?.propina ?? 0)).toBe(9_259)
  })

  it('la precuenta del pedido dividido sin pedir una cuenta lleva el saldo entero', () => {
    const { precuenta, guardada, pedido } = dividido()
    precuenta(pedido, null, { propina_sugerida: 9_259 })
    expect(guardada()[0]).toMatchObject({ cuenta: null, subtotal: 100_000, propina: 9_259 })
  })

  it('una cuenta con un pago parcial: queda su saldo y la parte proporcional de su propina', () => {
    const { t, cajero, precuenta, guardada, pedido, cuentas } = dividido()
    const cuenta = cuentas[0]?.cuenta_id as string
    const turno = nuevoId()
    cajero.mandar(
      turno,
      'TurnoAbierto',
      { caja_id: cajero.conexion.dispositivoId, base: 0 },
      { agregado_tipo: 'turno_caja' },
    )
    expect(pago(cajero, pedido, turno, 20_000, { cuenta_id: cuenta }).estado).toBe('confirmado')
    precuenta(pedido, cuenta, { propina_sugerida: 2_778 })
    const [p] = guardada()
    // Quedan 30.000 de 50.000: la propina de la cuenta (4.630) repartida entre lo pagado y lo que falta.
    expect(p).toMatchObject({
      cuenta: { nombre: 'Cuenta 1', monto: 30_000 },
      subtotal: 30_000,
      propina: 2_778,
      tasaPropina: 1000,
      pagado: 20_000,
    })
    expect(t.fallosGuardar).toEqual([])
  })

  it('una cuenta pagada del todo imprime saldo 0 y propina 0', () => {
    const { cajero, precuenta, guardada, pedido, cuentas } = dividido()
    const cuenta = cuentas[1]?.cuenta_id as string
    turnoYPago(cajero, pedido, 50_000, { cuenta_id: cuenta })
    precuenta(pedido, cuenta)
    expect(guardada()[0]).toMatchObject({ subtotal: 0, propina: 0, cuenta: { monto: 0 } })
  })

  it('una cuenta que ya no existe (se deshizo la división) imprime el saldo del pedido', () => {
    const { cajero, precuenta, guardada, pedido, cuentas } = dividido()
    expect(cajero.mandar(pedido, 'DivisionDeshecha', {}).estado).toBe('confirmado')
    precuenta(pedido, cuentas[0]?.cuenta_id, { propina_sugerida: 9_259 })
    expect(guardada()[0]).toMatchObject({ cuenta: null, subtotal: 100_000, propina: 9_259 })
  })

  it('con pagos previos en la cuenta general, la cuenta dividida sigue en lo que se dividió', () => {
    const m = mundo()
    const { t, ana, cajero, agregarCon, precuenta, guardada } = m
    const pedido = t.abrir(ana)
    agregarCon(pedido, 100_000)
    turnoYPago(cajero, pedido, 40_000)
    const cuentas = [
      {
        cuenta_id: nuevoId(),
        nombre: 'Cuenta 1',
        monto: 30_000,
        propina_sugerida: 2_778,
        items: [],
      },
      {
        cuenta_id: nuevoId(),
        nombre: 'Cuenta 2',
        monto: 30_000,
        propina_sugerida: 2_778,
        items: [],
      },
    ]
    expect(cajero.mandar(pedido, 'CuentaDividida', { cuentas }).estado).toBe('confirmado')
    precuenta(pedido, cuentas[0]?.cuenta_id, { propina_sugerida: 2_778 })
    expect(guardada()[0]).toMatchObject({
      total: 100_000,
      pagado: 40_000,
      subtotal: 30_000,
      propina: 2_778,
      cuenta: { nombre: 'Cuenta 1', monto: 30_000 },
    })
  })
})

describe('trabajoDePrecuenta: sin repetirse', () => {
  it('el mismo evento reenviado por el equipo no crea otro trabajo', () => {
    const { t, ana, agregarCon } = mundo()
    const pedido = t.abrir(ana)
    agregarCon(pedido, 40_900)
    const evento = t.equipo('mesero')
    const datos = { cuenta_id: null, subtotal: 0, propina_sugerida: 0 }
    const crudo = t.evento(evento.conexion, evento.sesion, 'PrecuentaImpresa', datos, {
      agregado_id: pedido,
      secuencia_base: Number(t.db.prepare('SELECT max(secuencia) AS s FROM evento').get()?.s ?? 0),
    } as never)
    const a = t.hub.recibirLote(evento.conexion, [crudo])
    const b = t.hub.recibirLote(evento.conexion, [crudo])
    expect(a.resultados[0]?.estado).toBe('confirmado')
    expect(b.resultados[0]?.estado).toBe('confirmado')
    expect(b.aceptados).toEqual([])
    expect(t.trabajos("WHERE tipo = 'precuenta'")).toHaveLength(1)
  })

  it('volver a procesar el mismo evento aceptado (reintento del gancho) no duplica el trabajo', () => {
    const { t, ana, agregarCon, precuenta } = mundo()
    const pedido = t.abrir(ana)
    agregarCon(pedido, 40_900)
    const r = precuenta(pedido)
    const despues = t.hub.pedido(pedido)
    expect(r.aceptado && despues).toBeTruthy()
    trabajosDeEvento(t.opcionesComandas, r.aceptado as never, [{ antes: despues, despues }])
    trabajosDeEvento(t.opcionesComandas, r.aceptado as never, [{ antes: despues, despues }])
    expect(t.trabajos("WHERE tipo = 'precuenta'")).toHaveLength(1)
  })

  it('pedir la precuenta dos veces son dos eventos: dos trabajos (se puede reimprimir)', () => {
    const { t, ana, agregarCon, precuenta } = mundo()
    const pedido = t.abrir(ana)
    agregarCon(pedido, 40_900)
    precuenta(pedido)
    precuenta(pedido)
    expect(t.trabajos("WHERE tipo = 'precuenta'")).toHaveLength(2)
  })

  it('una precuenta no mezcla con las comandas: enviar a cocina no crea precuentas', () => {
    const { t, ana, agregarCon } = mundo()
    t.impresoraNueva('Cocina', [t.cocina])
    const pedido = t.abrir(ana)
    const plato = agregarCon(pedido, 40_900)
    t.enviar(ana, pedido, [{ id: plato.item_id, estacion: t.cocina }])
    expect(t.trabajos("WHERE tipo = 'precuenta'")).toEqual([])
    expect(t.trabajos("WHERE tipo = 'comanda'")).toHaveLength(1)
  })
})

describe('la cola imprime la precuenta', () => {
  it('sale en el papel de la impresora de precuentas con los montos y se marca impresa', async () => {
    const { t, ana, agregarCon, precuenta, impresora } = mundo()
    const pedido = t.abrir(ana, t.mesa('5'))
    agregarCon(pedido, 40_900, { nombre: 'Garden Margarita', cantidad: 2 })
    precuenta(pedido, null, { propina_sugerida: 7_574 })
    await t.cola.vuelta()
    const [papel] = impresora.papel.textos()
    expect(papel).toContain('PRECUENTA')
    expect(papel).toContain('Mesa 5')
    expect(papel).toContain('2 x Garden Margarita')
    expect(papel).toContain('$81.800')
    expect(papel).toContain('Propina sugerida (10 %)')
    expect(papel).toContain('$7.574')
    expect(papel).toContain('$89.374')
    expect(t.pendientes()).toBe(0)
    expect(t.trabajos("WHERE tipo = 'precuenta'")[0]).toMatchObject({
      estado: 'impreso',
      intentos: 1,
      impreso_en_id: impresora.id,
    })
    expect(impresora.papel.recibidos).toHaveLength(1)
  })

  it('si el cliente pidió otra propina, el papel dice «Propina» (no «sugerida») y suma esa', async () => {
    const { t, ana, agregarCon, precuenta, impresora } = mundo()
    const pedido = t.abrir(ana, t.mesa('5'))
    agregarCon(pedido, 40_900)
    precuenta(pedido, null, { propina_sugerida: 5_000 })
    await t.cola.vuelta()
    const papel = (impresora.papel.textos()[0] ?? '').replace(/[ ]+/g, ' ')
    expect(papel).toContain('Propina $5.000')
    expect(papel).not.toContain('Propina sugerida')
    expect(papel).toContain('$45.900')
  })

  it('sin propina el papel dice «A pagar» con el saldo', async () => {
    const { t, ana, agregarCon, precuenta, impresora } = mundo()
    const pedido = t.abrir(ana, t.mesa('5'))
    agregarCon(pedido, 40_900)
    precuenta(pedido, null, { propina_sugerida: 0 })
    await t.cola.vuelta()
    const papel = (impresora.papel.textos()[0] ?? '').replace(/[ ]+/g, ' ')
    expect(papel).toContain('A pagar $40.900')
    expect(papel).not.toContain('Propina')
  })

  it('en una impresora de 58 mm las líneas caben en 32 columnas', async () => {
    const { t, ana, agregarCon, precuenta, impresora } = mundo({ ancho: 58 })
    const pedido = t.abrir(ana, t.mesa('5'))
    agregarCon(pedido, 40_900, { nombre: 'Garden Margarita con nombre bien largo', cantidad: 2 })
    precuenta(pedido)
    await t.cola.vuelta()
    const texto = impresora.papel.textos()[0] ?? ''
    expect(texto).toContain('$81.800')
    for (const linea of texto.split('\n'))
      expect(linea.length, linea).toBeLessThanOrEqual(COLUMNAS[58])
  })

  it('imprime una sola vez aunque la cola dé más vueltas, y corta el papel una vez', async () => {
    const { t, ana, agregarCon, precuenta, impresora } = mundo()
    const pedido = t.abrir(ana)
    agregarCon(pedido, 40_900)
    precuenta(pedido)
    await t.cola.vuelta()
    await t.cola.vuelta()
    t.avanzar(60_000)
    await t.cola.vuelta()
    expect(impresora.papel.recibidos).toHaveLength(1)
  })

  it('con la impresora apagada se queda pendiente y sale cuando vuelve, con los mismos montos', async () => {
    const { t, ana, agregarCon, precuenta, impresora } = mundo()
    const pedido = t.abrir(ana)
    agregarCon(pedido, 40_900)
    impresora.papel.apagada = true
    precuenta(pedido)
    await t.cola.vuelta()
    expect(t.pendientes()).toBe(1)
    expect(t.trabajos()[0]).toMatchObject({ intentos: 1 })
    // El pedido cambia mientras tanto: la precuenta ya quedó fijada con lo de ese momento.
    agregarCon(pedido, 10_000)
    impresora.papel.apagada = false
    t.avanzar(5_000)
    await t.cola.vuelta()
    expect(t.pendientes()).toBe(0)
    const texto = impresora.papel.textos()[0] ?? ''
    expect(texto).toContain('$40.900')
    expect(texto).not.toContain('$50.900')
  })

  it('la precuenta pasa a la impresora de respaldo si la principal sigue caída', async () => {
    const { t, ana, agregarCon, precuenta, impresora } = mundo()
    const respaldo = t.impresoraNueva('Barra', [])
    t.db.prepare('UPDATE impresora SET respaldo_id = ? WHERE id = ?').run(respaldo.id, impresora.id)
    impresora.papel.apagada = true
    const pedido = t.abrir(ana)
    agregarCon(pedido, 40_900)
    precuenta(pedido)
    // Tres fallos seguidos; justo después, con la espera de la principal sin vencer, sale por el respaldo.
    for (let i = 0; i < 3; i++) {
      await t.cola.vuelta()
      t.avanzar(60_000)
    }
    t.avanzar(-60_000 + 1)
    await t.cola.vuelta()
    expect(respaldo.papel.textos()[0]).toContain('PRECUENTA')
    expect(t.trabajos("WHERE tipo = 'precuenta'")[0]).toMatchObject({
      estado: 'impreso',
      impreso_en_id: respaldo.id,
    })
  })

  it('un contenido que no se entiende no frena a las comandas de detrás', async () => {
    const { t, ana, impresora } = mundo()
    t.impresoraNueva('Cocina', [t.cocina])
    const rota = nuevoId()
    t.db
      .prepare(
        `INSERT INTO trabajo_impresion (id, restaurante_id, impresora_id, tipo, evento_id, comanda_id, contenido, creado_en)
         VALUES (?, ?, ?, 'precuenta', ?, 'precuenta', '{"lineas":"no es lista"}', ?)`,
      )
      .run(rota, t.restauranteId, impresora.id, nuevoId(), new Date(t.reloj()).toISOString())
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Pizza', estacion: t.cocina }])
    t.enviar(ana, pedido, items)
    await t.cola.vuelta()
    await t.cola.vuelta()
    expect(t.trabajos("WHERE tipo = 'comanda'")[0]).toMatchObject({ estado: 'impreso' })
  })
})

describe('«Pedidos que no han salido»: la precuenta se nombra', () => {
  const pendientes = async (t: MontajeImpresion, e: Equipo) =>
    (await t.post('/api/impresion/pendientes', e.cuerpoSesion, e.token)).json() as {
      id: string
      impresora: string
      que: string
      intentos: number
      error: string | null
    }[]

  it('«Precuenta · Mesa 5», con la impresora y el error', async () => {
    const { t, ana, admin, agregarCon, precuenta, impresora } = mundo()
    impresora.papel.apagada = true
    const pedido = t.abrir(ana, t.mesa('5'))
    agregarCon(pedido, 40_900)
    precuenta(pedido)
    await t.cola.vuelta()
    const lista = await pendientes(t, admin)
    expect(lista).toHaveLength(1)
    expect(lista[0]).toMatchObject({ que: 'Precuenta · Mesa 5', impresora: 'Caja', intentos: 1 })
    expect(lista[0]?.error).toContain('rechazó la conexión')
  })

  it('para llevar: «Precuenta · Para llevar»; el cajero con registrar_pago también la ve', async () => {
    const { t, ana, cajero, agregarCon, precuenta, impresora } = mundo()
    impresora.papel.apagada = true
    const pedido = t.abrir(ana, null, 'para_llevar')
    agregarCon(pedido, 40_900)
    precuenta(pedido)
    const lista = await pendientes(t, cajero)
    expect(lista.map((x) => x.que)).toEqual(['Precuenta · Para llevar'])
  })

  it('se puede descartar una precuenta que ya no sirve', async () => {
    const { t, ana, admin, agregarCon, precuenta, impresora } = mundo()
    impresora.papel.apagada = true
    const pedido = t.abrir(ana, t.mesa('5'))
    agregarCon(pedido, 40_900)
    precuenta(pedido)
    const [trabajo] = await pendientes(t, admin)
    const r = await t.post(
      '/api/impresion/descartar',
      { ...admin.cuerpoSesion, trabajo_id: trabajo?.id },
      admin.token,
    )
    expect(r.statusCode).toBe(204)
    expect(await pendientes(t, admin)).toEqual([])
    expect(t.trabajos("WHERE tipo = 'precuenta'")[0]).toMatchObject({ estado: 'descartado' })
  })

  it('comandas y precuentas conviven en la misma lista, cada una con su nombre', async () => {
    const { t, ana, admin, agregarCon, precuenta, impresora } = mundo()
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    cocina.papel.apagada = true
    impresora.papel.apagada = true
    const mesa = t.mesa('7')
    const pedido = t.abrir(ana, mesa)
    const plato = agregarCon(pedido, 40_900, { nombre: 'Pizza' })
    t.enviar(ana, pedido, [{ id: plato.item_id, estacion: t.cocina }])
    t.avanzar(1_000)
    precuenta(pedido)
    const lista = (await pendientes(t, admin)).map((x) => x.que)
    expect(lista).toHaveLength(2)
    expect(lista[0]).toMatch(/^Cocina · Mesa 7/)
    expect(lista[1]).toBe('Precuenta · Mesa 7')
  })

  it('una Precuenta con un destino vacío no deja «Precuenta · » colgando', async () => {
    const { t, admin, impresora } = mundo()
    impresora.papel.apagada = true
    t.db
      .prepare(
        `INSERT INTO trabajo_impresion (id, restaurante_id, impresora_id, tipo, contenido, creado_en)
         VALUES (?, ?, ?, 'precuenta', '{}', ?)`,
      )
      .run(nuevoId(), t.restauranteId, impresora.id, new Date(t.reloj()).toISOString())
    const lista = await pendientes(t, admin)
    expect(lista[0]?.que).toBe('Precuenta')
  })

  it('totalesPedido del hub y la precuenta impresa coinciden en el saldo', () => {
    const { t, ana, cajero, agregarCon, precuenta, guardada } = mundo()
    const pedido = t.abrir(ana)
    agregarCon(pedido, 73_400)
    turnoYPago(cajero, pedido, 13_400)
    precuenta(pedido)
    const estado = t.hub.pedido(pedido)
    if (!estado) throw new Error('sin pedido')
    expect(guardada()[0]?.subtotal).toBe(totalesPedido(estado).saldo)
  })
})
