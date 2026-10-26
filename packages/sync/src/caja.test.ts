import { type EventoPedido, nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { AlmacenSqlite } from './hub/almacen-sqlite'
import { HubSync } from './hub/hub'
import { accesoLibre } from './pruebas/acceso'
import { AHORA, AlmacenQueSeCae, item, type Montaje, montar, venLoMismo } from './pruebas/montaje'
import type { Nodo } from './pruebas/red'

// Reglas de la caja en el hub (tarea 1.6, `problemaDeCaja`): un turno abierto por caja, pagos,
// anulaciones y reembolsos dentro del turno de la caja que los registra, y el redondeo del efectivo
// del restaurante. El turno vive en memoria y se reconstruye de los eventos al reiniciar.

const REDONDEO = { multiplo: 100, modo: 'cercano_mitad_abajo' }
/** El datáfono activo del restaurante en estas pruebas. */
const DATAFONO = nuevoId()
const REGLAS = {
  ...REDONDEO,
  medios: ['efectivo', 'tarjeta', 'nequi', 'daviplata', 'breb', 'transferencia'],
  datafonos: [DATAFONO],
}
type Reglas = {
  multiplo: number
  modo: string
  medios: string[]
  mediosPropios?: string[]
  datafonos: string[]
}

const conexionDe = (m: Montaje, nodo: Nodo) => {
  const conexion = m.red.tokens.get(`token-${nodo.nombre}`)
  if (!conexion) throw new Error(`Sin token para ${nodo.nombre}`)
  return conexion
}

/** Un hub con las reglas de cobro del restaurante sobre el almacén del montaje. */
function hubConReglas(m: Montaje, reglas: () => Reglas = () => REGLAS) {
  return new HubSync(m.almacen, {
    restauranteId: m.restauranteId,
    zonaHoraria: 'America/Bogota',
    inicioDiaOperativo: '06:00',
    acceso: accesoLibre,
    instancia: 'hub-1',
    reloj: m.red.horaIso,
    reglasCobro: reglas,
  })
}

function equipo(opciones: { reglas?: boolean } = {}) {
  const m = montar()
  const caja = m.red.dispositivo('caja')
  const caja2 = m.red.dispositivo('caja2')
  const ana = m.red.dispositivo('ana')
  const estado: { hub: HubSync } = {
    hub: opciones.reglas === false ? m.hub() : hubConReglas(m),
  }

  const crudo = (
    nodo: Nodo,
    tipo: string,
    agregado: string,
    datos: unknown,
    extras: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id: nuevoId(),
    tipo,
    version_esquema: 1,
    agregado_tipo: tipo === 'TurnoAbierto' ? 'turno_caja' : 'pedido',
    agregado_id: agregado,
    relacionados: [],
    datos,
    sesion_id: null,
    usuario_id: nodo.usuarioId,
    dispositivo_id: nodo.dispositivoId,
    autorizacion_id: null,
    motivo: tipo === 'PagoAnulado' || tipo === 'ReembolsoRegistrado' ? 'Prueba' : null,
    hora_dispositivo: AHORA,
    hora_estimada_hub: AHORA,
    secuencia_base: m.almacen.maxSecuencia(),
    ...extras,
  })
  const enviar = (nodo: Nodo, eventos: Record<string, unknown>[]) =>
    estado.hub.recibirLote(conexionDe(m, nodo), eventos)
  const uno = (nodo: Nodo, evento: Record<string, unknown>) => enviar(nodo, [evento]).resultados[0]

  const abrirTurno = (nodo: Nodo, base = 200_000, turno = nuevoId()) => {
    const r = uno(nodo, crudo(nodo, 'TurnoAbierto', turno, { caja_id: nodo.dispositivoId, base }))
    return { turno, resultado: r }
  }
  const abrirPedido = (nodo: Nodo, precio: number) => {
    const pedido = nuevoId()
    uno(
      nodo,
      crudo(nodo, 'PedidoAbierto', pedido, { canal: 'salon', mesa_id: null, comensales: 2 }),
    )
    uno(nodo, crudo(nodo, 'ItemAgregado', pedido, item(precio)))
    return pedido
  }
  const pagoTarjeta = (turno: string, monto: number, campos: object = {}) => ({
    pago_id: nuevoId(),
    cuenta_id: null,
    turno_caja_id: turno,
    medio: 'tarjeta',
    monto,
    propina: 0,
    recibido: null,
    cambio: null,
    ajuste_redondeo: 0,
    redondeo: null,
    datafono: {
      datafono_id: DATAFONO,
      franquicia: 'Visa',
      ultimos4: '4242',
      aprobacion: null,
      recibo: null,
    },
    referencia_cobro: null,
    ...campos,
  })
  /** Efectivo que cancela el saldo `monto`, con el ajuste que da la regla del restaurante. */
  const pagoEfectivo = (turno: string, monto: number, ajuste: number, redondeo: object | null) => ({
    pago_id: nuevoId(),
    cuenta_id: null,
    turno_caja_id: turno,
    medio: 'efectivo',
    monto,
    propina: 0,
    recibido: monto + ajuste,
    cambio: 0,
    ajuste_redondeo: ajuste,
    redondeo,
    datafono: null,
    referencia_cobro: null,
  })
  return {
    m,
    caja,
    caja2,
    ana,
    estado,
    crudo,
    enviar,
    uno,
    abrirTurno,
    abrirPedido,
    pagoTarjeta,
    pagoEfectivo,
  }
}

const motivo = (r: unknown) => (r as { estado: string; motivo?: string }).motivo
const estadoDe = (r: unknown) => (r as { estado: string }).estado

describe('turno de caja: uno por caja', () => {
  it('abre el turno: confirmado, y el hub lo recuerda con su base, quién y cuándo', () => {
    const { caja, estado, abrirTurno } = equipo()
    const { turno, resultado } = abrirTurno(caja, 150_000)
    expect(resultado).toMatchObject({ estado: 'confirmado' })
    expect(estado.hub.turnoAbierto(caja.dispositivoId)).toEqual({
      id: turno,
      cajaId: caja.dispositivoId,
      base: 150_000,
      abiertoEn: expect.any(String),
      usuarioId: caja.usuarioId,
    })
  })

  it('una caja sin turno no tiene turno abierto', () => {
    const { caja, ana, estado } = equipo()
    expect(estado.hub.turnoAbierto(caja.dispositivoId)).toBeNull()
    expect(estado.hub.turnoAbierto(ana.dispositivoId)).toBeNull()
    expect(estado.hub.turnoAbierto(nuevoId())).toBeNull()
  })

  it('el segundo turno de la misma caja se rechaza con turno_ya_abierto y el primero sigue', () => {
    const { m, caja, estado, abrirTurno } = equipo()
    const primero = abrirTurno(caja)
    const antes = m.almacen.maxSecuencia()
    const segundo = abrirTurno(caja, 50_000)
    expect(segundo.resultado).toMatchObject({ estado: 'rechazado', motivo: 'turno_ya_abierto' })
    expect(estado.hub.turnoAbierto(caja.dispositivoId)?.id).toBe(primero.turno)
    expect(estado.hub.turnoAbierto(caja.dispositivoId)?.base).toBe(200_000)
    expect(m.almacen.maxSecuencia()).toBe(antes)
  })

  it('el rechazo se repite igual si la caja reenvía el mismo evento', () => {
    const { caja, estado, crudo, enviar, abrirTurno } = equipo()
    abrirTurno(caja)
    const turno2 = crudo(caja, 'TurnoAbierto', nuevoId(), { caja_id: caja.dispositivoId, base: 1 })
    const a = enviar(caja, [turno2]).resultados[0]
    const b = enviar(caja, [turno2]).resultados[0]
    expect(a).toMatchObject({ estado: 'rechazado', motivo: 'turno_ya_abierto' })
    expect(b).toEqual(a)
    expect(estado.hub.turnoAbierto(caja.dispositivoId)?.base).toBe(200_000)
  })

  it('reenviar el mismo TurnoAbierto confirmado es idempotente: no es un segundo turno', () => {
    const { m, caja, crudo, enviar } = equipo()
    const turno = crudo(caja, 'TurnoAbierto', nuevoId(), { caja_id: caja.dispositivoId, base: 10 })
    const a = enviar(caja, [turno]).resultados[0]
    const b = enviar(caja, [turno]).resultados[0]
    expect(estadoDe(a)).toBe('confirmado')
    expect(b).toEqual(a)
    expect(m.almacen.maxSecuencia()).toBe(1)
  })

  it('dos cajas distintas pueden tener su turno abierto al mismo tiempo', () => {
    const { caja, caja2, estado, abrirTurno } = equipo()
    const a = abrirTurno(caja)
    const b = abrirTurno(caja2, 0)
    expect(estadoDe(b.resultado)).toBe('confirmado')
    expect(estado.hub.turnoAbierto(caja.dispositivoId)?.id).toBe(a.turno)
    expect(estado.hub.turnoAbierto(caja2.dispositivoId)?.id).toBe(b.turno)
  })

  it('el id del turno de otra caja no se puede reusar (turno_ya_existe)', () => {
    const { caja, caja2, estado, abrirTurno } = equipo()
    const a = abrirTurno(caja)
    const reuso = abrirTurno(caja2, 0, a.turno)
    expect(reuso.resultado).toMatchObject({ estado: 'rechazado', motivo: 'turno_ya_existe' })
    expect(estado.hub.turnoAbierto(caja2.dispositivoId)).toBeNull()
  })

  it('caja_distinta: una caja no abre el turno de otra', () => {
    const { caja, caja2, estado, uno, crudo } = equipo()
    const r = uno(
      caja,
      crudo(caja, 'TurnoAbierto', nuevoId(), { caja_id: caja2.dispositivoId, base: 0 }),
    )
    expect(r).toMatchObject({ estado: 'rechazado', motivo: 'caja_distinta' })
    expect(estado.hub.turnoAbierto(caja2.dispositivoId)).toBeNull()
    expect(estado.hub.turnoAbierto(caja.dispositivoId)).toBeNull()
  })

  it('caja_distinta también si el caja_id es de un equipo que no existe', () => {
    const { caja, uno, crudo } = equipo()
    const r = uno(caja, crudo(caja, 'TurnoAbierto', nuevoId(), { caja_id: nuevoId(), base: 0 }))
    expect(motivo(r)).toBe('caja_distinta')
  })

  it('un TurnoAbierto con formato inválido (base negativa) se rechaza por esquema', () => {
    const { caja, estado, uno, crudo } = equipo()
    const r = uno(
      caja,
      crudo(caja, 'TurnoAbierto', nuevoId(), { caja_id: caja.dispositivoId, base: -5 }),
    )
    expect(motivo(r)).toMatch(/^esquema/)
    expect(estado.hub.turnoAbierto(caja.dispositivoId)).toBeNull()
  })

  it('un TurnoAbierto firmado como evento de pedido se rechaza por esquema', () => {
    const { caja, uno, crudo } = equipo()
    const r = uno(
      caja,
      crudo(
        caja,
        'TurnoAbierto',
        nuevoId(),
        { caja_id: caja.dispositivoId, base: 0 },
        { agregado_tipo: 'pedido' },
      ),
    )
    expect(motivo(r)).toMatch(/^esquema/)
  })

  it('un TurnoAbierto no toca ningún pedido: el pedido abierto queda como estaba', () => {
    const { caja, ana, estado, abrirPedido, abrirTurno } = equipo()
    const pedido = abrirPedido(ana, 40_900)
    const antes = estado.hub.pedido(pedido)
    abrirTurno(caja)
    expect(estado.hub.pedido(pedido)).toEqual(antes)
  })
})

describe('TurnoAbierto: no se mezcla con el pedido', () => {
  // BUG: el hub guarda un TurnoAbierto que nombra un pedido en `relacionados` como evento de ese
  // pedido (packages/sync/src/hub/hub.ts: `agregados = pedidosDe(evento)` en `procesar`, que toma
  // `relacionados` sin mirar el agregado_tipo). La causa de fondo es el esquema, ver
  // packages/core/src/eventos/pedido.ts (falta la guarda que sí tiene ProductoAgotado).
  it('un TurnoAbierto con un pedido en relacionados no queda en la historia del pedido', () => {
    const { caja, ana, m, uno, crudo, abrirPedido } = equipo()
    const pedido = abrirPedido(ana, 40_900)
    uno(
      caja,
      crudo(
        caja,
        'TurnoAbierto',
        nuevoId(),
        { caja_id: caja.dispositivoId, base: 0 },
        { relacionados: [pedido] },
      ),
    )
    expect(m.almacen.eventosDeAgregado(pedido).map((e) => e.tipo)).not.toContain('TurnoAbierto')
  })
})

describe('pagos, anulaciones y reembolsos: turno y caja', () => {
  const anulacion = (pagoId: string, turno: string) => ({ pago_id: pagoId, turno_caja_id: turno })
  const reembolso = (pagoId: string, turno: string) => ({
    pago_id: pagoId,
    reembolso_id: nuevoId(),
    monto_venta: 1_000,
    monto_propina: 0,
    medio: 'tarjeta',
    turno_caja_id: turno,
  })

  it('un pago sin turno se rechaza con sin_turno y no queda en el pedido', () => {
    const { caja, estado, uno, crudo, abrirPedido, pagoTarjeta } = equipo()
    const pedido = abrirPedido(caja, 40_900)
    const r = uno(caja, crudo(caja, 'PagoRegistrado', pedido, pagoTarjeta(nuevoId(), 40_900)))
    expect(r).toMatchObject({ estado: 'rechazado', motivo: 'sin_turno' })
    expect(Object.keys(estado.hub.pedido(pedido)?.pagos ?? {})).toEqual([])
  })

  it('un pago con el turno abierto se acepta', () => {
    const { caja, estado, uno, crudo, abrirPedido, abrirTurno, pagoTarjeta } = equipo()
    const pedido = abrirPedido(caja, 40_900)
    const { turno } = abrirTurno(caja)
    const r = uno(caja, crudo(caja, 'PagoRegistrado', pedido, pagoTarjeta(turno, 40_900)))
    expect(estadoDe(r)).toBe('confirmado')
    expect(Object.values(estado.hub.pedido(pedido)?.pagos ?? {})[0]).toMatchObject({
      turnoCajaId: turno,
      monto: 40_900,
    })
  })

  it('turno_de_otra_caja: la caja 2 no cobra en el turno de la caja 1', () => {
    const { caja, caja2, uno, crudo, abrirPedido, abrirTurno, pagoTarjeta } = equipo()
    const pedido = abrirPedido(caja, 40_900)
    const { turno } = abrirTurno(caja)
    abrirTurno(caja2)
    const r = uno(caja2, crudo(caja2, 'PagoRegistrado', pedido, pagoTarjeta(turno, 40_900)))
    expect(r).toMatchObject({ estado: 'rechazado', motivo: 'turno_de_otra_caja' })
  })

  it('un equipo que no es caja (sin turno propio) tampoco cobra en el turno ajeno', () => {
    const { caja, ana, uno, crudo, abrirPedido, abrirTurno, pagoTarjeta } = equipo()
    const pedido = abrirPedido(ana, 40_900)
    const { turno } = abrirTurno(caja)
    const r = uno(ana, crudo(ana, 'PagoRegistrado', pedido, pagoTarjeta(turno, 40_900)))
    expect(motivo(r)).toBe('turno_de_otra_caja')
  })

  it('un id de turno que es de un pedido o inventado no sirve: sin_turno', () => {
    const { caja, uno, crudo, abrirPedido, abrirTurno, pagoTarjeta } = equipo()
    const pedido = abrirPedido(caja, 40_900)
    abrirTurno(caja)
    expect(
      motivo(uno(caja, crudo(caja, 'PagoRegistrado', pedido, pagoTarjeta(pedido, 1_000)))),
    ).toBe('sin_turno')
    expect(
      motivo(uno(caja, crudo(caja, 'PagoRegistrado', pedido, pagoTarjeta(nuevoId(), 1_000)))),
    ).toBe('sin_turno')
  })

  it('PagoAnulado: sin_turno, turno_de_otra_caja y, con el turno propio, se acepta', () => {
    const { caja, caja2, estado, uno, crudo, abrirPedido, abrirTurno, pagoTarjeta } = equipo()
    const pedido = abrirPedido(caja, 40_900)
    const { turno } = abrirTurno(caja)
    const { turno: turno2 } = abrirTurno(caja2)
    const pago = pagoTarjeta(turno, 40_900)
    expect(estadoDe(uno(caja, crudo(caja, 'PagoRegistrado', pedido, pago)))).toBe('confirmado')

    expect(
      motivo(uno(caja, crudo(caja, 'PagoAnulado', pedido, anulacion(pago.pago_id, nuevoId())))),
    ).toBe('sin_turno')
    expect(
      motivo(uno(caja2, crudo(caja2, 'PagoAnulado', pedido, anulacion(pago.pago_id, turno)))),
    ).toBe('turno_de_otra_caja')
    // La caja 2 con su propio turno sí puede anular: el pago cae en el turno en que se anula.
    expect(
      estadoDe(uno(caja, crudo(caja, 'PagoAnulado', pedido, anulacion(pago.pago_id, turno)))),
    ).toBe('confirmado')
    expect(estado.hub.pedido(pedido)?.pagos[pago.pago_id]?.anulado).toBe(true)
    expect(turno2).toBeTruthy()
  })

  it('ReembolsoRegistrado: sin_turno, turno_de_otra_caja y, con el turno propio, se acepta', () => {
    const { caja, caja2, estado, uno, crudo, abrirPedido, abrirTurno, pagoTarjeta } = equipo()
    const pedido = abrirPedido(caja, 40_900)
    const { turno } = abrirTurno(caja)
    abrirTurno(caja2)
    const pago = pagoTarjeta(turno, 40_900)
    uno(caja, crudo(caja, 'PagoRegistrado', pedido, pago))

    expect(
      motivo(
        uno(caja, crudo(caja, 'ReembolsoRegistrado', pedido, reembolso(pago.pago_id, nuevoId()))),
      ),
    ).toBe('sin_turno')
    expect(
      motivo(
        uno(caja2, crudo(caja2, 'ReembolsoRegistrado', pedido, reembolso(pago.pago_id, turno))),
      ),
    ).toBe('turno_de_otra_caja')
    expect(
      estadoDe(
        uno(caja, crudo(caja, 'ReembolsoRegistrado', pedido, reembolso(pago.pago_id, turno))),
      ),
    ).toBe('confirmado')
    expect(estado.hub.pedido(pedido)?.pagos[pago.pago_id]?.reembolsadoVenta).toBe(1_000)
  })

  it('un rechazo por turno no deja huella en el pedido ni hueco en las secuencias', () => {
    const { m, caja, uno, crudo, abrirPedido, pagoTarjeta } = equipo()
    const pedido = abrirPedido(caja, 40_900)
    const antes = m.almacen.maxSecuencia()
    uno(caja, crudo(caja, 'PagoRegistrado', pedido, pagoTarjeta(nuevoId(), 40_900)))
    expect(m.almacen.maxSecuencia()).toBe(antes)
    expect(m.hub().conflictos()).toEqual([])
  })

  it('sin turno ni siquiera se puede cerrar: el pedido queda con saldo pendiente', () => {
    const { caja, uno, crudo, abrirPedido, pagoTarjeta } = equipo()
    const pedido = abrirPedido(caja, 40_900)
    uno(caja, crudo(caja, 'PagoRegistrado', pedido, pagoTarjeta(nuevoId(), 40_900)))
    expect(motivo(uno(caja, crudo(caja, 'PedidoCerrado', pedido, {})))).toBe('saldo_pendiente')
  })
})

describe('redondeo del efectivo: el del restaurante', () => {
  // Pedido de $36.810: el efectivo que lo cancela se cobra a $36.800 (ajuste −10).
  const cobrar = (redondeo: object | null, opciones: { reglas?: boolean } = {}) => {
    const e = equipo(opciones)
    const pedido = e.abrirPedido(e.caja, 36_810)
    const { turno } = e.abrirTurno(e.caja)
    const r = e.uno(
      e.caja,
      e.crudo(e.caja, 'PagoRegistrado', pedido, e.pagoEfectivo(turno, 36_810, -10, redondeo)),
    )
    return { ...e, pedido, turno, r }
  }

  it('con la regla del restaurante, el pago en efectivo se acepta', () => {
    const { r, estado, pedido } = cobrar(REDONDEO)
    expect(estadoDe(r)).toBe('confirmado')
    expect(estado.hub.pedido(pedido)?.pagos).toBeDefined()
  })

  it('redondeo_distinto: otro múltiplo', () => {
    expect(cobrar({ multiplo: 50, modo: 'cercano_mitad_abajo' }).r).toMatchObject({
      estado: 'rechazado',
      motivo: 'redondeo_distinto',
    })
  })

  it('redondeo_distinto: otro modo', () => {
    expect(motivo(cobrar({ multiplo: 100, modo: 'arriba' }).r)).toBe('redondeo_distinto')
    expect(motivo(cobrar({ multiplo: 100, modo: 'cercano_mitad_arriba' }).r)).toBe(
      'redondeo_distinto',
    )
  })

  it('si el restaurante cambia la regla, el hub usa la vigente en cada pago', () => {
    const e = equipo({ reglas: false })
    let regla: Reglas = { ...REGLAS }
    e.estado.hub = hubConReglas(e.m, () => regla)
    const pedido = e.abrirPedido(e.caja, 36_810)
    const { turno } = e.abrirTurno(e.caja)
    regla = { ...REGLAS, multiplo: 50 }
    const viejo = e.uno(
      e.caja,
      e.crudo(e.caja, 'PagoRegistrado', pedido, e.pagoEfectivo(turno, 36_810, -10, REDONDEO)),
    )
    expect(motivo(viejo)).toBe('redondeo_distinto')
  })

  it('un pago sin redondeo (parcial o saldo ya redondo) no se compara', () => {
    const e = equipo()
    const pedido = e.abrirPedido(e.caja, 36_800)
    const { turno } = e.abrirTurno(e.caja)
    const r = e.uno(
      e.caja,
      e.crudo(e.caja, 'PagoRegistrado', pedido, e.pagoEfectivo(turno, 36_800, 0, null)),
    )
    expect(estadoDe(r)).toBe('confirmado')
  })

  it('un pago con tarjeta no tiene redondeo y no se ve afectado por la regla', () => {
    const e = equipo()
    const pedido = e.abrirPedido(e.caja, 36_810)
    const { turno } = e.abrirTurno(e.caja)
    const r = e.uno(e.caja, e.crudo(e.caja, 'PagoRegistrado', pedido, e.pagoTarjeta(turno, 36_810)))
    expect(estadoDe(r)).toBe('confirmado')
  })

  it('un hub sin la regla configurada no compara el redondeo', () => {
    const { r } = cobrar({ multiplo: 50, modo: 'abajo' }, { reglas: false })
    // 50 con modo "abajo" da otro ajuste: el reductor lo rechaza, pero no por redondeo_distinto.
    expect(motivo(r)).not.toBe('redondeo_distinto')
  })

  it('el rechazo por redondeo no crea el pago ni ocupa una secuencia', () => {
    const e = cobrar({ multiplo: 1000, modo: 'arriba' })
    expect(Object.keys(e.estado.hub.pedido(e.pedido)?.pagos ?? {})).toEqual([])
  })
})

describe('medio y datáfono: los del restaurante', () => {
  const pagoNequi = (turno: string, monto: number) => ({
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
  })

  it('medio_no_habilitado: un medio que el restaurante no recibe se rechaza', () => {
    const e = equipo()
    const pedido = e.abrirPedido(e.caja, 10_000)
    const { turno } = e.abrirTurno(e.caja)
    e.estado.hub = hubConReglas(e.m, () => ({ ...REGLAS, medios: ['efectivo', 'tarjeta'] }))
    const r = e.uno(e.caja, e.crudo(e.caja, 'PagoRegistrado', pedido, pagoNequi(turno, 10_000)))
    expect(r).toMatchObject({ estado: 'rechazado', motivo: 'medio_no_habilitado' })
    expect(Object.keys(e.estado.hub.pedido(pedido)?.pagos ?? {})).toEqual([])
  })

  it('un medio habilitado se acepta, y el bono solo si el restaurante lo incluye', () => {
    const e = equipo()
    const pedido = e.abrirPedido(e.caja, 20_000)
    const { turno } = e.abrirTurno(e.caja)
    expect(
      estadoDe(e.uno(e.caja, e.crudo(e.caja, 'PagoRegistrado', pedido, pagoNequi(turno, 10_000)))),
    ).toBe('confirmado')
    const bono = { ...pagoNequi(turno, 10_000), medio: 'bono' }
    expect(motivo(e.uno(e.caja, e.crudo(e.caja, 'PagoRegistrado', pedido, bono)))).toBe(
      'medio_no_habilitado',
    )
    e.estado.hub = hubConReglas(e.m, () => ({ ...REGLAS, medios: [...REGLAS.medios, 'bono'] }))
    expect(estadoDe(e.uno(e.caja, e.crudo(e.caja, 'PagoRegistrado', pedido, bono)))).toBe(
      'confirmado',
    )
  })

  it('si el administrador quita un medio con el hub andando, el siguiente pago ya no pasa', () => {
    const e = equipo()
    const pedido = e.abrirPedido(e.caja, 20_000)
    const { turno } = e.abrirTurno(e.caja)
    let medios = [...REGLAS.medios]
    e.estado.hub = hubConReglas(e.m, () => ({ ...REGLAS, medios }))
    expect(
      estadoDe(e.uno(e.caja, e.crudo(e.caja, 'PagoRegistrado', pedido, pagoNequi(turno, 5_000)))),
    ).toBe('confirmado')
    medios = medios.filter((x) => x !== 'nequi')
    expect(
      motivo(e.uno(e.caja, e.crudo(e.caja, 'PagoRegistrado', pedido, pagoNequi(turno, 5_000)))),
    ).toBe('medio_no_habilitado')
  })

  it('datafono_desconocido: la tarjeta nombra un datáfono que no está activo', () => {
    const e = equipo()
    const pedido = e.abrirPedido(e.caja, 10_000)
    const { turno } = e.abrirTurno(e.caja)
    const ajeno = e.pagoTarjeta(turno, 10_000, {
      datafono: {
        datafono_id: nuevoId(),
        franquicia: null,
        ultimos4: null,
        aprobacion: null,
        recibo: null,
      },
    })
    const r = e.uno(e.caja, e.crudo(e.caja, 'PagoRegistrado', pedido, ajeno))
    expect(r).toMatchObject({ estado: 'rechazado', motivo: 'datafono_desconocido' })
  })

  it('un datáfono archivado deja de valer aunque el celular siga mostrándolo', () => {
    const e = equipo()
    const pedido = e.abrirPedido(e.caja, 10_000)
    const { turno } = e.abrirTurno(e.caja)
    e.estado.hub = hubConReglas(e.m, () => ({ ...REGLAS, datafonos: [] }))
    const r = e.uno(e.caja, e.crudo(e.caja, 'PagoRegistrado', pedido, e.pagoTarjeta(turno, 10_000)))
    expect(motivo(r)).toBe('datafono_desconocido')
  })

  it('una tarjeta sin número de aprobación (solo el monto) se acepta con un datáfono activo', () => {
    const e = equipo()
    const pedido = e.abrirPedido(e.caja, 10_000)
    const { turno } = e.abrirTurno(e.caja)
    const r = e.uno(e.caja, e.crudo(e.caja, 'PagoRegistrado', pedido, e.pagoTarjeta(turno, 10_000)))
    expect(estadoDe(r)).toBe('confirmado')
  })

  it('el efectivo no necesita datáfono y no se afecta por la lista de datáfonos', () => {
    const e = equipo()
    const pedido = e.abrirPedido(e.caja, 36_800)
    const { turno } = e.abrirTurno(e.caja)
    e.estado.hub = hubConReglas(e.m, () => ({ ...REGLAS, datafonos: [] }))
    const r = e.uno(
      e.caja,
      e.crudo(e.caja, 'PagoRegistrado', pedido, e.pagoEfectivo(turno, 36_800, 0, null)),
    )
    expect(estadoDe(r)).toBe('confirmado')
  })

  it('el orden de las reglas: sin turno gana a medio no habilitado', () => {
    const e = equipo()
    const pedido = e.abrirPedido(e.caja, 10_000)
    e.estado.hub = hubConReglas(e.m, () => ({ ...REGLAS, medios: ['efectivo'] }))
    const r = e.uno(e.caja, e.crudo(e.caja, 'PagoRegistrado', pedido, pagoNequi(nuevoId(), 10_000)))
    expect(motivo(r)).toBe('sin_turno')
  })

  it('anular y reembolsar no revisan el medio: se puede devolver lo cobrado por un medio que ya no se recibe', () => {
    const e = equipo()
    const pedido = e.abrirPedido(e.caja, 10_000)
    const { turno } = e.abrirTurno(e.caja)
    const pago = pagoNequi(turno, 10_000)
    e.uno(e.caja, e.crudo(e.caja, 'PagoRegistrado', pedido, pago))
    e.estado.hub = hubConReglas(e.m, () => ({ ...REGLAS, medios: ['efectivo'] }))
    const r = e.uno(
      e.caja,
      e.crudo(e.caja, 'PagoAnulado', pedido, { pago_id: pago.pago_id, turno_caja_id: turno }),
    )
    expect(estadoDe(r)).toBe('confirmado')
  })
})

describe('medios propios del restaurante', () => {
  const SODEXO = nuevoId()
  const propio = (turno: string, id: string | null, monto: number, medio = 'otro') => ({
    pago_id: nuevoId(),
    cuenta_id: null,
    turno_caja_id: turno,
    medio,
    ...(id ? { medio_propio_id: id } : {}),
    monto,
    propina: 0,
    recibido: null,
    cambio: null,
    ajuste_redondeo: 0,
    redondeo: null,
    datafono: null,
    referencia_cobro: null,
  })
  const montar = (activos: string[]) => {
    const e = equipo()
    e.estado.hub = hubConReglas(e.m, () => ({ ...REGLAS, mediosPropios: activos }))
    const pedido = e.abrirPedido(e.caja, 30_000)
    const { turno } = e.abrirTurno(e.caja)
    return { ...e, pedido, turno }
  }

  it('un medio propio activo se acepta y queda en el pago', () => {
    const e = montar([SODEXO])
    const r = e.uno(
      e.caja,
      e.crudo(e.caja, 'PagoRegistrado', e.pedido, propio(e.turno, SODEXO, 10_000)),
    )
    expect(estadoDe(r)).toBe('confirmado')
    expect(Object.values(e.estado.hub.pedido(e.pedido)?.pagos ?? {})[0]).toMatchObject({
      medio: 'otro',
      medioPropioId: SODEXO,
    })
  })

  it('uno desconocido o archivado (fuera de la lista de activos) se rechaza con medio_no_habilitado', () => {
    const e = montar([SODEXO])
    const ajeno = e.uno(
      e.caja,
      e.crudo(e.caja, 'PagoRegistrado', e.pedido, propio(e.turno, nuevoId(), 1_000)),
    )
    expect(ajeno).toMatchObject({ estado: 'rechazado', motivo: 'medio_no_habilitado' })
    const archivado = montar([])
    const r = archivado.uno(
      archivado.caja,
      archivado.crudo(
        archivado.caja,
        'PagoRegistrado',
        archivado.pedido,
        propio(archivado.turno, SODEXO, 1_000),
      ),
    )
    expect(motivo(r)).toBe('medio_no_habilitado')
  })

  it('un hub sin la lista de medios propios (undefined) rechaza cualquier medio propio', () => {
    const e = equipo()
    e.estado.hub = hubConReglas(e.m, () => ({ ...REGLAS }))
    const pedido = e.abrirPedido(e.caja, 10_000)
    const { turno } = e.abrirTurno(e.caja)
    const r = e.uno(e.caja, e.crudo(e.caja, 'PagoRegistrado', pedido, propio(turno, SODEXO, 1_000)))
    expect(motivo(r)).toBe('medio_no_habilitado')
  })

  it('«otro» sin id, o un id con otro medio, se rechaza por esquema', () => {
    const e = montar([SODEXO])
    expect(
      motivo(
        e.uno(e.caja, e.crudo(e.caja, 'PagoRegistrado', e.pedido, propio(e.turno, null, 1_000))),
      ),
    ).toMatch(/^esquema/)
    expect(
      motivo(
        e.uno(
          e.caja,
          e.crudo(e.caja, 'PagoRegistrado', e.pedido, propio(e.turno, SODEXO, 1_000, 'nequi')),
        ),
      ),
    ).toMatch(/^esquema/)
  })

  it('anular el pago de un medio propio archivado después sigue permitido', () => {
    const e = montar([SODEXO])
    const pago = propio(e.turno, SODEXO, 10_000)
    e.uno(e.caja, e.crudo(e.caja, 'PagoRegistrado', e.pedido, pago))
    e.estado.hub = hubConReglas(e.m, () => ({ ...REGLAS, mediosPropios: [] }))
    const r = e.uno(
      e.caja,
      e.crudo(e.caja, 'PagoAnulado', e.pedido, { pago_id: pago.pago_id, turno_caja_id: e.turno }),
    )
    expect(estadoDe(r)).toBe('confirmado')
  })
})

describe('el turno sobrevive al reinicio del hub', () => {
  it('un hub nuevo sobre la misma base conoce el turno abierto y su base', () => {
    const e = equipo()
    const { turno } = e.abrirTurno(e.caja, 120_000)
    const reiniciado = hubConReglas(e.m)
    expect(reiniciado.turnoAbierto(e.caja.dispositivoId)).toMatchObject({
      id: turno,
      base: 120_000,
      usuarioId: e.caja.usuarioId,
    })
  })

  it('tras el reinicio sigue rechazando el segundo turno y aceptando pagos en el turno', () => {
    const e = equipo()
    const pedido = e.abrirPedido(e.caja, 40_900)
    const { turno } = e.abrirTurno(e.caja)
    e.estado.hub = hubConReglas(e.m)
    expect(motivo(e.abrirTurno(e.caja).resultado)).toBe('turno_ya_abierto')
    const r = e.uno(e.caja, e.crudo(e.caja, 'PagoRegistrado', pedido, e.pagoTarjeta(turno, 40_900)))
    expect(estadoDe(r)).toBe('confirmado')
  })

  it('el turno rechazado no reaparece tras el reinicio, y el abierto conserva su base', () => {
    const e = equipo()
    const primero = e.abrirTurno(e.caja, 100)
    e.abrirTurno(e.caja, 999)
    const reiniciado = hubConReglas(e.m)
    expect(reiniciado.turnoAbierto(e.caja.dispositivoId)?.id).toBe(primero.turno)
    expect(reiniciado.turnoAbierto(e.caja.dispositivoId)?.base).toBe(100)
  })

  it('con varias páginas de eventos de pedido, el turno sigue ahí', () => {
    const e = equipo()
    const { turno } = e.abrirTurno(e.caja)
    // Más eventos que una página de reconstrucción.
    for (let i = 0; i < 12; i++) e.abrirPedido(e.ana, 1_000 + i)
    const reiniciado = hubConReglas(e.m)
    expect(reiniciado.turnoAbierto(e.caja.dispositivoId)?.id).toBe(turno)
  })

  it('un hub que reinicia sin conservar la base no inventa turnos', () => {
    const e = equipo()
    e.abrirTurno(e.caja)
    const otraBase = montar()
    const vacio = new HubSync(otraBase.almacen, {
      restauranteId: otraBase.restauranteId,
      zonaHoraria: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      acceso: accesoLibre,
      instancia: 'hub-2',
      reloj: otraBase.red.horaIso,
    })
    expect(vacio.turnoAbierto(e.caja.dispositivoId)).toBeNull()
  })
})

describe('un lote: abrir turno, pagar y cerrar el pedido', () => {
  it('todo en un solo lote queda confirmado y el pedido se cierra', () => {
    const e = equipo()
    const pedido = nuevoId()
    const turno = nuevoId()
    const pago = e.pagoEfectivo(turno, 36_810, -10, REDONDEO)
    const base = e.m.almacen.maxSecuencia()
    const r = e.enviar(e.caja, [
      e.crudo(
        e.caja,
        'PedidoAbierto',
        pedido,
        { canal: 'salon', mesa_id: null, comensales: 2 },
        { secuencia_base: base },
      ),
      e.crudo(e.caja, 'ItemAgregado', pedido, item(36_810), { secuencia_base: base }),
      e.crudo(
        e.caja,
        'TurnoAbierto',
        turno,
        { caja_id: e.caja.dispositivoId, base: 200_000 },
        { secuencia_base: base },
      ),
      e.crudo(e.caja, 'PagoRegistrado', pedido, pago, { secuencia_base: base }),
      e.crudo(e.caja, 'PedidoCerrado', pedido, {}, { secuencia_base: base }),
    ])
    expect(r.resultados.map(estadoDe)).toEqual(Array(5).fill('confirmado'))
    expect(r.aceptados.map((x: EventoPedido) => x.secuencia)).toEqual([1, 2, 3, 4, 5])
    expect(e.estado.hub.pedido(pedido)).toMatchObject({ estado: 'cerrado' })
    expect(e.estado.hub.turnoAbierto(e.caja.dispositivoId)?.id).toBe(turno)
  })

  it('el pago antes del turno en el mismo lote se rechaza con sin_turno y el cierre no pasa', () => {
    const e = equipo()
    const pedido = e.abrirPedido(e.caja, 40_900)
    const turno = nuevoId()
    const r = e.enviar(e.caja, [
      e.crudo(e.caja, 'PagoRegistrado', pedido, e.pagoTarjeta(turno, 40_900)),
      e.crudo(e.caja, 'TurnoAbierto', turno, { caja_id: e.caja.dispositivoId, base: 0 }),
      e.crudo(e.caja, 'PedidoCerrado', pedido, {}),
    ])
    expect(r.resultados.map((x) => (x.estado === 'rechazado' ? x.motivo : x.estado))).toEqual([
      'sin_turno',
      'confirmado',
      'depende_de_rechazado',
    ])
    expect(e.estado.hub.pedido(pedido)?.estado).toBe('abierto')
  })

  it('si el turno del lote se rechaza (ya hay uno), el pago de ese turno falla y lo demás sigue', () => {
    const e = equipo()
    const pedido = e.abrirPedido(e.caja, 40_900)
    e.abrirTurno(e.caja)
    const turno2 = nuevoId()
    const r = e.enviar(e.caja, [
      e.crudo(e.caja, 'TurnoAbierto', turno2, { caja_id: e.caja.dispositivoId, base: 0 }),
      e.crudo(e.caja, 'PagoRegistrado', pedido, e.pagoTarjeta(turno2, 40_900)),
    ])
    expect(r.resultados.map((x) => (x.estado === 'rechazado' ? x.motivo : x.estado))).toEqual([
      'turno_ya_abierto',
      'sin_turno',
    ])
  })
})

describe('multirestaurante: el turno es de cada restaurante', () => {
  function dosRestaurantes() {
    const a = equipo()
    // Segundo restaurante en la misma base, con su propio hub y almacén.
    const otroId = nuevoId()
    a.m.db
      .prepare(
        `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
         VALUES (?, ?, ?, ?, 1, 'Otro restaurante', '{}')`,
      )
      .run(otroId, otroId, AHORA, AHORA)
    const hubB = new HubSync(new AlmacenSqlite(a.m.db, otroId), {
      restauranteId: otroId,
      zonaHoraria: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      acceso: accesoLibre,
      instancia: 'hub-b',
      reloj: a.m.red.horaIso,
      reglasCobro: () => REGLAS,
    })
    return { ...a, hubB, otroId }
  }

  it('el turno abierto en un restaurante no existe en el otro', () => {
    const e = dosRestaurantes()
    e.abrirTurno(e.caja)
    expect(e.estado.hub.turnoAbierto(e.caja.dispositivoId)).not.toBeNull()
    expect(e.hubB.turnoAbierto(e.caja.dispositivoId)).toBeNull()
  })

  it('un pago en el restaurante B con el turno del A se rechaza con sin_turno', () => {
    const e = dosRestaurantes()
    const { turno } = e.abrirTurno(e.caja)
    const pedido = nuevoId()
    const conexion = conexionDe(e.m, e.caja)
    const rB = e.hubB.recibirLote(conexion, [
      e.crudo(
        e.caja,
        'PedidoAbierto',
        pedido,
        { canal: 'salon', mesa_id: null, comensales: 1 },
        { secuencia_base: 0 },
      ),
      e.crudo(e.caja, 'ItemAgregado', pedido, item(10_000), { secuencia_base: 0 }),
      e.crudo(e.caja, 'PagoRegistrado', pedido, e.pagoTarjeta(turno, 10_000), {
        secuencia_base: 0,
      }),
    ])
    expect(rB.resultados.map((x) => (x.estado === 'rechazado' ? x.motivo : x.estado))).toEqual([
      'confirmado',
      'confirmado',
      'sin_turno',
    ])
  })

  it('cada restaurante abre su turno aunque sea el mismo equipo de caja, y cada hub reinicia con el suyo', () => {
    const e = dosRestaurantes()
    const a = e.abrirTurno(e.caja, 1_000)
    const conexion = conexionDe(e.m, e.caja)
    const turnoB = nuevoId()
    const rB = e.hubB.recibirLote(conexion, [
      e.crudo(
        e.caja,
        'TurnoAbierto',
        turnoB,
        { caja_id: e.caja.dispositivoId, base: 2_000 },
        { secuencia_base: 0 },
      ),
    ]).resultados[0]
    expect(estadoDe(rB)).toBe('confirmado')
    expect(e.hubB.turnoAbierto(e.caja.dispositivoId)).toMatchObject({ id: turnoB, base: 2_000 })
    expect(e.estado.hub.turnoAbierto(e.caja.dispositivoId)).toMatchObject({
      id: a.turno,
      base: 1_000,
    })

    const reiniciadoB = new HubSync(new AlmacenSqlite(e.m.db, e.otroId), {
      restauranteId: e.otroId,
      zonaHoraria: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      acceso: accesoLibre,
      instancia: 'hub-b2',
      reloj: e.m.red.horaIso,
    })
    expect(reiniciadoB.turnoAbierto(e.caja.dispositivoId)?.id).toBe(turnoB)
    expect(hubConReglas(e.m).turnoAbierto(e.caja.dispositivoId)?.id).toBe(a.turno)
  })
})

describe('con la red simulada: caja sin conexión, hub apagado y mensajes duplicados', () => {
  /** La caja abre turno, cobra y cierra su pedido; devuelve lo necesario para revisar. */
  async function cajaCobra(m: Montaje, caja: Nodo, precio = 40_900) {
    const pedido = nuevoId()
    const turno = nuevoId()
    await caja.crear(pedido, 'PedidoAbierto', { canal: 'salon', mesa_id: nuevoId(), comensales: 2 })
    await caja.crear(pedido, 'ItemAgregado', item(precio))
    await caja.crear(
      turno,
      'TurnoAbierto',
      { caja_id: caja.dispositivoId, base: 100_000 },
      { agregado_tipo: 'turno_caja' },
    )
    await caja.crear(pedido, 'PagoRegistrado', {
      pago_id: nuevoId(),
      cuenta_id: null,
      turno_caja_id: turno,
      medio: 'tarjeta',
      monto: precio,
      propina: 0,
      recibido: null,
      cambio: null,
      ajuste_redondeo: 0,
      redondeo: null,
      datafono: {
        datafono_id: nuevoId(),
        franquicia: null,
        ultimos4: null,
        aprobacion: null,
        recibo: null,
      },
      referencia_cobro: null,
    })
    await caja.crear(pedido, 'PedidoCerrado', {})
    expect(m).toBeTruthy()
    return { pedido, turno }
  }

  it('la caja abre turno, cobra y cierra sin conexión; al reconectar todo se confirma y todos ven lo mismo', async () => {
    const m = montar()
    const caja = m.red.dispositivo('caja')
    const ana = m.red.dispositivo('ana')
    const { pedido } = await cajaCobra(m, caja)
    expect(await caja.cliente.pendientes()).toBe(5)

    await m.red.conectarTodos()
    expect(m.hub().pedido(pedido)?.estado).toBe('cerrado')
    expect(m.hub().turnoAbierto(caja.dispositivoId)).not.toBeNull()
    await venLoMismo(m.hub(), m.almacen.eventosDesde(0, 1_000), [caja, ana], [pedido])
  })

  it('un lote duplicado por la red no abre dos turnos ni cobra dos veces', async () => {
    const m = montar()
    const caja = m.red.dispositivo('caja')
    const ana = m.red.dispositivo('ana')
    await m.red.conectarTodos()
    caja.regla('al_hub', 'empujar', 'duplicar', 3)
    const { pedido } = await cajaCobra(m, caja)
    await m.red.estabilizar()
    const eventos = m.almacen.eventosDesde(0, 1_000)
    expect(eventos.filter((x) => x.tipo === 'TurnoAbierto')).toHaveLength(1)
    expect(eventos.filter((x) => x.tipo === 'PagoRegistrado')).toHaveLength(1)
    await venLoMismo(m.hub(), eventos, [caja, ana], [pedido])
  })

  it('el hub se apaga justo al guardar el pago: al volver, el turno sigue y el cobro se completa sin duplicar', async () => {
    const m = montar()
    const caja = m.red.dispositivo('caja')
    const ana = m.red.dispositivo('ana')
    await m.red.conectarTodos()
    // Eventos: 1 PedidoAbierto, 2 ItemAgregado, 3 TurnoAbierto, 4 PagoRegistrado (cae), 5 Cerrado.
    if (m.almacen instanceof AlmacenQueSeCae) m.almacen.caerEn = 4
    const { pedido, turno } = await cajaCobra(m, caja)
    await m.red.estabilizar()
    await m.red.conectarTodos()
    await m.red.estabilizar()

    expect(m.hub().turnoAbierto(caja.dispositivoId)?.id).toBe(turno)
    const eventos = m.almacen.eventosDesde(0, 1_000)
    expect(eventos.filter((x) => x.tipo === 'PagoRegistrado')).toHaveLength(1)
    expect(m.hub().pedido(pedido)?.estado).toBe('cerrado')
    await venLoMismo(m.hub(), eventos, [caja, ana], [pedido])
  })

  it('el reloj de la caja desfasado no cambia el turno: se acepta y el pedido cierra', async () => {
    const m = montar()
    const caja = m.red.dispositivo('caja')
    const ana = m.red.dispositivo('ana')
    caja.desfaseMs = -3 * 60 * 60 * 1000
    await m.red.conectarTodos()
    const { pedido, turno } = await cajaCobra(m, caja)
    await m.red.estabilizar()
    expect(m.hub().turnoAbierto(caja.dispositivoId)?.id).toBe(turno)
    await venLoMismo(m.hub(), m.almacen.eventosDesde(0, 1_000), [caja, ana], [pedido])
  })

  it('el hub reinicia entre abrir el turno y cobrar: el cobro posterior sigue valiendo', async () => {
    const m = montar()
    const caja = m.red.dispositivo('caja')
    await m.red.conectarTodos()
    const turno = nuevoId()
    await caja.crear(
      turno,
      'TurnoAbierto',
      { caja_id: caja.dispositivoId, base: 0 },
      { agregado_tipo: 'turno_caja' },
    )
    await m.red.estabilizar()
    m.red.caerHub()
    await m.red.conectarTodos()
    expect(m.hub().turnoAbierto(caja.dispositivoId)?.id).toBe(turno)
    const pedido = nuevoId()
    await caja.crear(pedido, 'PedidoAbierto', { canal: 'salon', mesa_id: null, comensales: 1 })
    await caja.crear(pedido, 'ItemAgregado', item(10_000))
    await caja.crear(pedido, 'PagoRegistrado', {
      pago_id: nuevoId(),
      cuenta_id: null,
      turno_caja_id: turno,
      medio: 'nequi',
      monto: 10_000,
      propina: 0,
      recibido: null,
      cambio: null,
      ajuste_redondeo: 0,
      redondeo: null,
      datafono: null,
      referencia_cobro: null,
    })
    await m.red.estabilizar()
    expect(Object.keys(m.hub().pedido(pedido)?.pagos ?? {})).toHaveLength(1)
  })
})
