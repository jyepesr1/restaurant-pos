import { agregadoDe, cuadreDeOtrosMedios, nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { AlmacenSqlite } from './hub/almacen-sqlite'
import { HubSync } from './hub/hub'
import { TAMANO_PAGINA } from './protocolo'
import { accesoLibre } from './pruebas/acceso'
import { AHORA, AlmacenQueSeCae, eventosDe, item, type Montaje, montar } from './pruebas/montaje'
import type { Nodo } from './pruebas/red'

// Movimientos, arqueo y cierre de caja en el hub (tarea 1.7, `problemaDeCaja` y `HubSync.cuadre`):
// sin turno o en el de otra caja, los cuatro rechazos del cierre, lo que pasa después de cerrar, el
// reinicio con un turno a medias y el multirestaurante.

const SODEXO = nuevoId()
const DATAFONO = nuevoId()
const REGLAS = {
  multiplo: 100,
  modo: 'cercano_mitad_abajo',
  medios: ['efectivo', 'tarjeta', 'nequi', 'daviplata', 'breb', 'transferencia'],
  mediosPropios: [SODEXO],
  datafonos: [DATAFONO],
}

const conexionDe = (m: Montaje, nodo: Nodo) => {
  const conexion = m.red.tokens.get(`token-${nodo.nombre}`)
  if (!conexion) throw new Error(`Sin token para ${nodo.nombre}`)
  return conexion
}

const motivo = (r: unknown) => {
  const x = r as { estado: string; motivo?: string }
  return x.estado === 'rechazado' ? x.motivo : x.estado
}

function entorno(opciones: { umbral?: number } = {}) {
  const m = montar()
  const caja = m.red.dispositivo('caja')
  const caja2 = m.red.dispositivo('caja2')
  const ana = m.red.dispositivo('ana')
  const cfg = { umbral: opciones.umbral ?? 1000 }
  const nuevoHub = () =>
    new HubSync(m.almacen, {
      restauranteId: m.restauranteId,
      zonaHoraria: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      acceso: accesoLibre,
      instancia: 'hub-1',
      reloj: m.red.horaIso,
      reglasCobro: () => ({ ...REGLAS, umbralDiferencia: cfg.umbral }),
    })
  const estado = { hub: nuevoHub() }

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
    agregado_tipo: agregadoDe(tipo as never),
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
  const enviar = (nodo: Nodo, eventos: Record<string, unknown>[], hub = estado.hub) =>
    hub.recibirLote(conexionDe(m, nodo), eventos)
  const uno = (nodo: Nodo, evento: Record<string, unknown>, hub = estado.hub) =>
    enviar(nodo, [evento], hub).resultados[0]

  const abrirTurno = (nodo: Nodo, base = 100_000, turno = nuevoId()) => {
    const resultado = uno(
      nodo,
      crudo(nodo, 'TurnoAbierto', turno, { caja_id: nodo.dispositivoId, base }),
    )
    expect(motivo(resultado)).toBe('confirmado')
    return turno
  }
  const abrirPedido = (nodo: Nodo, precio = 40_900) => {
    const pedido = nuevoId()
    uno(
      nodo,
      crudo(nodo, 'PedidoAbierto', pedido, { canal: 'salon', mesa_id: null, comensales: 2 }),
    )
    uno(nodo, crudo(nodo, 'ItemAgregado', pedido, item(precio)))
    return pedido
  }
  /** Efectivo parcial (el saldo no queda en 0): sin ajuste de redondeo. */
  const pagoEf = (turno: string, monto: number, propina = 0) => ({
    pago_id: nuevoId(),
    cuenta_id: null,
    turno_caja_id: turno,
    medio: 'efectivo',
    monto,
    propina,
    recibido: monto + propina,
    cambio: 0,
    ajuste_redondeo: 0,
    redondeo: null,
    datafono: null,
    referencia_cobro: null,
  })
  const pagoNequi = (turno: string, monto: number, propina = 0) => ({
    ...pagoEf(turno, monto, propina),
    medio: 'nequi',
    recibido: null,
    cambio: null,
  })
  const pagoPropio = (turno: string, monto: number) => ({
    ...pagoNequi(turno, monto),
    medio: 'otro',
    medio_propio_id: SODEXO,
  })
  const cobrar = (nodo: Nodo, pedido: string, datos: { pago_id: string }) => {
    const r = uno(nodo, crudo(nodo, 'PagoRegistrado', pedido, datos))
    expect(motivo(r)).toBe('confirmado')
    return datos.pago_id
  }
  const movimiento = (
    nodo: Nodo,
    turno: string,
    tipo: 'entrada' | 'salida' | 'pago_propinas',
    monto: number,
  ) =>
    uno(
      nodo,
      crudo(nodo, 'MovimientoCajaRegistrado', turno, {
        movimiento_id: nuevoId(),
        tipo,
        monto,
        descripcion: `Prueba ${tipo}`,
        a_quien: tipo === 'pago_propinas' ? 'Equipo' : null,
        dias: tipo === 'pago_propinas' ? ['2026-10-24'] : [],
      }),
    )
  /** El conteo de `contado` pesos: billetes de $1.000 y, si sobra, monedas de $1 (cualquier monto). */
  const conteoDe = (contado: number) =>
    [
      { valor: 1_000, cantidad: Math.floor(contado / 1_000) },
      { valor: 1, cantidad: contado % 1_000 },
    ].filter((c) => c.cantidad > 0)
  /** Registra un conteo que suma `contado`. */
  const contar = (nodo: Nodo, turno: string, contado: number) => {
    const arqueo = nuevoId()
    const r = uno(
      nodo,
      crudo(nodo, 'ArqueoRegistrado', turno, {
        arqueo_id: arqueo,
        conteo: conteoDe(contado),
        contado_efectivo: contado,
      }),
    )
    return { arqueo, resultado: r }
  }
  const datosCierre = (
    arqueo: string,
    esperado: number,
    contado: number,
    justificacion: string | null = null,
  ) => ({
    arqueo_id: arqueo,
    esperado_efectivo: esperado,
    contado_efectivo: contado,
    diferencia: contado - esperado,
    justificacion,
  })
  // Desde la 1.8 el cierre trae los demás medios tal como los calcula el hub con el conteo.
  const otrosDe = (turno: string, arqueo: string) => {
    const cuadre = estado.hub.cuadre(turno)
    const conteo = cuadre?.arqueos.find((a) => a.id === arqueo)
    return cuadre && conteo
      ? cuadreDeOtrosMedios(cuadre, conteo).map((o) => ({
          medio: o.medio,
          medio_propio_id: o.medioPropioId,
          esperado: o.esperado,
          reportado: o.reportado,
          diferencia: o.diferencia,
        }))
      : []
  }
  const cerrar = (
    nodo: Nodo,
    turno: string,
    arqueo: string,
    esperado: number,
    contado: number,
    justificacion: string | null = null,
  ) =>
    uno(
      nodo,
      crudo(nodo, 'TurnoCerrado', turno, {
        ...datosCierre(arqueo, esperado, contado, justificacion),
        otros_medios: otrosDe(turno, arqueo),
      }),
    )
  const anular = (nodo: Nodo, pedido: string, pagoId: string, turno: string) =>
    uno(nodo, crudo(nodo, 'PagoAnulado', pedido, { pago_id: pagoId, turno_caja_id: turno }))

  return {
    m,
    caja,
    caja2,
    ana,
    cfg,
    estado,
    nuevoHub,
    crudo,
    enviar,
    uno,
    abrirTurno,
    abrirPedido,
    pagoEf,
    pagoNequi,
    pagoPropio,
    cobrar,
    movimiento,
    contar,
    conteoDe,
    cerrar,
    anular,
    datosCierre,
  }
}

describe('movimiento, arqueo y cierre: turno y caja', () => {
  const tres = (e: ReturnType<typeof entorno>, nodo: Nodo, turno: string) => ({
    movimiento: e.movimiento(nodo, turno, 'entrada', 1_000),
    arqueo: e.contar(nodo, turno, 1_000).resultado,
    cierre: e.cerrar(nodo, turno, nuevoId(), 1_000, 1_000),
  })

  it('sin turno (id inventado): los tres se rechazan con sin_turno y no dejan huella', () => {
    const e = entorno()
    const antes = e.m.almacen.maxSecuencia()
    const r = tres(e, e.caja, nuevoId())
    expect(motivo(r.movimiento)).toBe('sin_turno')
    expect(motivo(r.arqueo)).toBe('sin_turno')
    expect(motivo(r.cierre)).toBe('sin_turno')
    expect(e.m.almacen.maxSecuencia()).toBe(antes)
  })

  it('el id de un pedido tampoco es un turno: sin_turno', () => {
    const e = entorno()
    e.abrirTurno(e.caja)
    const pedido = e.abrirPedido(e.caja)
    expect(motivo(e.movimiento(e.caja, pedido, 'entrada', 1_000))).toBe('sin_turno')
  })

  it('el turno de OTRA caja: turno_de_otra_caja en los tres, y el turno sigue intacto', () => {
    const e = entorno()
    const turno = e.abrirTurno(e.caja, 50_000)
    e.abrirTurno(e.caja2, 7_000)
    const antes = e.m.almacen.maxSecuencia()
    const r = tres(e, e.caja2, turno)
    expect(motivo(r.movimiento)).toBe('turno_de_otra_caja')
    expect(motivo(r.arqueo)).toBe('turno_de_otra_caja')
    expect(motivo(r.cierre)).toBe('turno_de_otra_caja')
    expect(e.m.almacen.maxSecuencia()).toBe(antes)
    expect(e.estado.hub.turnoAbierto(e.caja.dispositivoId)?.id).toBe(turno)
    expect(e.estado.hub.cuadre(turno)?.efectivo.esperado).toBe(50_000)
  })

  it('un equipo sin turno propio (el mesero) tampoco mueve ni cierra el turno de la caja', () => {
    const e = entorno()
    const turno = e.abrirTurno(e.caja)
    const r = tres(e, e.ana, turno)
    expect(Object.values(r).map(motivo)).toEqual([
      'turno_de_otra_caja',
      'turno_de_otra_caja',
      'turno_de_otra_caja',
    ])
  })

  it('el rechazo se repite igual si se reenvía el mismo evento', () => {
    const e = entorno()
    const turno = e.abrirTurno(e.caja)
    const mov = e.crudo(e.caja2, 'MovimientoCajaRegistrado', turno, {
      movimiento_id: nuevoId(),
      tipo: 'entrada',
      monto: 5,
      descripcion: 'x',
      a_quien: null,
      dias: [],
    })
    const a = e.uno(e.caja2, mov)
    const b = e.uno(e.caja2, mov)
    expect(motivo(a)).toBe('turno_de_otra_caja')
    expect(b).toEqual(a)
  })

  it('movimientos y arqueos del turno propio se aceptan y el cuadre los refleja', () => {
    const e = entorno()
    const turno = e.abrirTurno(e.caja, 100_000)
    expect(motivo(e.movimiento(e.caja, turno, 'entrada', 20_000))).toBe('confirmado')
    expect(motivo(e.movimiento(e.caja, turno, 'salida', 5_000))).toBe('confirmado')
    expect(motivo(e.movimiento(e.caja, turno, 'pago_propinas', 3_000))).toBe('confirmado')
    const primero = e.contar(e.caja, turno, 110_000)
    const segundo = e.contar(e.caja, turno, 112_000)
    expect(motivo(primero.resultado)).toBe('confirmado')
    expect(motivo(segundo.resultado)).toBe('confirmado')
    const c = e.estado.hub.cuadre(turno)
    expect(c?.efectivo).toMatchObject({
      entradas: 20_000,
      salidas: 5_000,
      pagosPropinas: 3_000,
      esperado: 112_000,
    })
    expect(c?.arqueos.map((a) => a.contado)).toEqual([110_000, 112_000])
    expect(c?.movimientos.map((x) => x.tipo)).toEqual(['entrada', 'salida', 'pago_propinas'])
  })

  it('la hora del cuadre es la del hub, no la del reloj del dispositivo', () => {
    const e = entorno()
    e.caja.desfaseMs = -3 * 60 * 60 * 1000
    const turno = e.abrirTurno(e.caja)
    e.movimiento(e.caja, turno, 'entrada', 1_000)
    const guardado = eventosDe(e.m).find((x) => x.tipo === 'MovimientoCajaRegistrado')
    const c = e.estado.hub.cuadre(turno)
    expect(c?.movimientos[0]?.hora).toBe(guardado?.recibido_en)
    expect(c?.abiertoEn).toBe(eventosDe(e.m)[0]?.recibido_en)
  })

  it('un movimiento con el esquema roto (salida con a_quien) se rechaza antes de tocar el turno', () => {
    const e = entorno()
    const turno = e.abrirTurno(e.caja)
    const r = e.uno(
      e.caja,
      e.crudo(e.caja, 'MovimientoCajaRegistrado', turno, {
        movimiento_id: nuevoId(),
        tipo: 'salida',
        monto: 100,
        descripcion: 'x',
        a_quien: 'Ana',
        dias: [],
      }),
    )
    expect(motivo(r)).toMatch(/^esquema:/)
    expect(e.estado.hub.cuadre(turno)?.movimientos).toEqual([])
  })

  it('cuadre de un turno que no existe o ya cerrado: null', () => {
    const e = entorno()
    expect(e.estado.hub.cuadre(nuevoId())).toBeNull()
  })
})

describe('cierre de caja: las cuatro reglas y el cierre correcto', () => {
  /** Base 100.000, cobro en efectivo de 30.000 con 2.000 de propina y un conteo de 132.000. */
  function turnoCobrado(umbral = 1000) {
    const e = entorno({ umbral })
    const turno = e.abrirTurno(e.caja, 100_000)
    const pedido = e.abrirPedido(e.caja)
    e.cobrar(e.caja, pedido, e.pagoEf(turno, 30_000, 2_000))
    return { ...e, turno, pedido, esperado: 132_000 }
  }

  it('arqueo_inexistente: cierra sin haber contado', () => {
    const t = turnoCobrado()
    expect(motivo(t.cerrar(t.caja, t.turno, nuevoId(), t.esperado, t.esperado))).toBe(
      'arqueo_inexistente',
    )
    expect(t.estado.hub.turnoAbierto(t.caja.dispositivoId)).not.toBeNull()
  })

  it('arqueo_inexistente: el conteo es de otro turno (otra caja)', () => {
    const t = turnoCobrado()
    const turno2 = t.abrirTurno(t.caja2, 0)
    const ajeno = t.contar(t.caja2, turno2, 132_000)
    expect(motivo(ajeno.resultado)).toBe('confirmado')
    expect(motivo(t.cerrar(t.caja, t.turno, ajeno.arqueo, t.esperado, 132_000))).toBe(
      'arqueo_inexistente',
    )
  })

  it('arqueo_inexistente: el id del arqueo es el de un movimiento', () => {
    const t = turnoCobrado()
    const mov = t.crudo(t.caja, 'MovimientoCajaRegistrado', t.turno, {
      movimiento_id: nuevoId(),
      tipo: 'entrada',
      monto: 1_000,
      descripcion: 'x',
      a_quien: null,
      dias: [],
    })
    t.uno(t.caja, mov)
    const id = (mov.datos as { movimiento_id: string }).movimiento_id
    expect(motivo(t.cerrar(t.caja, t.turno, id, 133_000, 1_000))).toBe('arqueo_inexistente')
  })

  it('contado_distinto: el cierre dice otro contado que el del arqueo (aunque la diferencia sea consecuente)', () => {
    const t = turnoCobrado()
    const { arqueo } = t.contar(t.caja, t.turno, 132_000)
    expect(motivo(t.cerrar(t.caja, t.turno, arqueo, t.esperado, 131_000, 'Faltó'))).toBe(
      'contado_distinto',
    )
    expect(motivo(t.cerrar(t.caja, t.turno, arqueo, t.esperado, 133_000, 'Sobró'))).toBe(
      'contado_distinto',
    )
  })

  it('esperado_distinto: el cierre dice otro esperado que el del hub', () => {
    const t = turnoCobrado()
    const { arqueo } = t.contar(t.caja, t.turno, 132_000)
    // Un esperado viejo (sin la propina) y uno inventado.
    expect(motivo(t.cerrar(t.caja, t.turno, arqueo, 130_000, 132_000, 'x'))).toBe(
      'esperado_distinto',
    )
    expect(motivo(t.cerrar(t.caja, t.turno, arqueo, 0, 132_000, 'x'))).toBe('esperado_distinto')
  })

  describe('arqueo_desactualizado: hubo dinero después del último conteo', () => {
    it('un movimiento (entrada, salida o pago de propinas) después de contar', () => {
      for (const tipo of ['entrada', 'salida', 'pago_propinas'] as const) {
        const t = turnoCobrado()
        const { arqueo } = t.contar(t.caja, t.turno, 132_000)
        t.movimiento(t.caja, t.turno, tipo, 1_000)
        const nuevoEsperado = tipo === 'entrada' ? 133_000 : 131_000
        expect(motivo(t.cerrar(t.caja, t.turno, arqueo, nuevoEsperado, 132_000, 'x')), tipo).toBe(
          'arqueo_desactualizado',
        )
        expect(t.estado.hub.turnoAbierto(t.caja.dispositivoId), tipo).not.toBeNull()
      }
    })

    it('un pago, aunque sea de otro medio, después de contar', () => {
      const t = turnoCobrado()
      const { arqueo } = t.contar(t.caja, t.turno, 132_000)
      t.cobrar(t.caja, t.pedido, t.pagoNequi(t.turno, 500))
      expect(motivo(t.cerrar(t.caja, t.turno, arqueo, 132_000, 132_000))).toBe(
        'arqueo_desactualizado',
      )
    })

    it('una anulación y un reembolso después de contar', () => {
      const t = turnoCobrado()
      const otro = t.cobrar(t.caja, t.pedido, t.pagoNequi(t.turno, 500))
      const { arqueo } = t.contar(t.caja, t.turno, 132_000)
      t.anular(t.caja, t.pedido, otro, t.turno)
      expect(motivo(t.cerrar(t.caja, t.turno, arqueo, 132_000, 132_000))).toBe(
        'arqueo_desactualizado',
      )
      const t2 = turnoCobrado()
      const pago = t2.cobrar(t2.caja, t2.pedido, t2.pagoNequi(t2.turno, 500))
      const a2 = t2.contar(t2.caja, t2.turno, 132_000)
      const r = t2.uno(
        t2.caja,
        t2.crudo(t2.caja, 'ReembolsoRegistrado', t2.pedido, {
          pago_id: pago,
          reembolso_id: nuevoId(),
          monto_venta: 100,
          monto_propina: 0,
          medio: 'nequi',
          turno_caja_id: t2.turno,
        }),
      )
      expect(motivo(r)).toBe('confirmado')
      expect(motivo(t2.cerrar(t2.caja, t2.turno, a2.arqueo, 132_000, 132_000))).toBe(
        'arqueo_desactualizado',
      )
    })

    it('anular después de contar un pago de un turno anterior también desactualiza el conteo', () => {
      const e = entorno()
      const t1 = e.abrirTurno(e.caja, 0)
      const pedido = e.abrirPedido(e.caja)
      const pago = e.cobrar(e.caja, pedido, e.pagoEf(t1, 10_000))
      const a1 = e.contar(e.caja, t1, 10_000)
      e.cerrar(e.caja, t1, a1.arqueo, 10_000, 10_000)
      const t2 = e.abrirTurno(e.caja, 50_000)
      const { arqueo } = e.contar(e.caja, t2, 50_000)
      e.anular(e.caja, pedido, pago, t2)
      expect(motivo(e.cerrar(e.caja, t2, arqueo, 40_000, 50_000, 'x'))).toBe(
        'arqueo_desactualizado',
      )
    })

    it('volver a contar lo arregla: el conteo nuevo es el último y el esperado es el nuevo', () => {
      const t = turnoCobrado()
      const viejo = t.contar(t.caja, t.turno, 132_000)
      t.movimiento(t.caja, t.turno, 'salida', 12_000)
      const nuevo = t.contar(t.caja, t.turno, 120_000)
      expect(motivo(t.cerrar(t.caja, t.turno, viejo.arqueo, 120_000, 132_000, 'x'))).toBe(
        'arqueo_no_es_el_ultimo',
      )
      expect(motivo(t.cerrar(t.caja, t.turno, nuevo.arqueo, 120_000, 120_000))).toBe('confirmado')
    })

    it('un movimiento rechazado (de otra caja) o un pago del turno de otra caja no desactualizan', () => {
      const t = turnoCobrado()
      t.abrirTurno(t.caja2, 0)
      const { arqueo } = t.contar(t.caja, t.turno, 132_000)
      expect(motivo(t.movimiento(t.caja2, t.turno, 'entrada', 1_000))).toBe('turno_de_otra_caja')
      const otroPedido = t.abrirPedido(t.caja2)
      t.cobrar(
        t.caja2,
        otroPedido,
        t.pagoNequi(t.estado.hub.turnoAbierto(t.caja2.dispositivoId)?.id ?? '', 500),
      )
      expect(motivo(t.cerrar(t.caja, t.turno, arqueo, 132_000, 132_000))).toBe('confirmado')
    })

    it('tras reiniciar el hub, el conteo sigue desactualizado', () => {
      const t = turnoCobrado()
      const { arqueo } = t.contar(t.caja, t.turno, 132_000)
      t.movimiento(t.caja, t.turno, 'entrada', 1_000)
      t.estado.hub = t.nuevoHub()
      expect(motivo(t.cerrar(t.caja, t.turno, arqueo, 133_000, 132_000, 'x'))).toBe(
        'arqueo_desactualizado',
      )
    })
  })

  describe('arqueo_no_es_el_ultimo', () => {
    it('cerrar con el primero de dos conteos se rechaza; con el último se acepta', () => {
      const t = turnoCobrado()
      const a1 = t.contar(t.caja, t.turno, 130_000)
      const a2 = t.contar(t.caja, t.turno, 132_000)
      expect(motivo(t.cerrar(t.caja, t.turno, a1.arqueo, t.esperado, 130_000, 'Faltó'))).toBe(
        'arqueo_no_es_el_ultimo',
      )
      expect(t.estado.hub.turnoAbierto(t.caja.dispositivoId)).not.toBeNull()
      expect(motivo(t.cerrar(t.caja, t.turno, a2.arqueo, t.esperado, 132_000))).toBe('confirmado')
    })

    it('con tres conteos solo vale el tercero', () => {
      const t = turnoCobrado()
      const a = [130_000, 131_000, 132_000].map((c) => t.contar(t.caja, t.turno, c).arqueo)
      expect(motivo(t.cerrar(t.caja, t.turno, a[0] ?? '', t.esperado, 130_000, 'x'))).toBe(
        'arqueo_no_es_el_ultimo',
      )
      expect(motivo(t.cerrar(t.caja, t.turno, a[1] ?? '', t.esperado, 131_000, 'x'))).toBe(
        'arqueo_no_es_el_ultimo',
      )
      expect(motivo(t.cerrar(t.caja, t.turno, a[2] ?? '', t.esperado, 132_000))).toBe('confirmado')
    })

    it('un conteo repetido con el mismo contado no engaña: se compara el id, no el monto', () => {
      const t = turnoCobrado()
      const a1 = t.contar(t.caja, t.turno, 132_000)
      t.contar(t.caja, t.turno, 132_000)
      expect(motivo(t.cerrar(t.caja, t.turno, a1.arqueo, t.esperado, 132_000))).toBe(
        'arqueo_no_es_el_ultimo',
      )
    })
  })

  it('el orden de las reglas: inexistente, no es el último, desactualizado, contado, esperado, justificación', () => {
    const t = turnoCobrado(0)
    const a1 = t.contar(t.caja, t.turno, 131_000)
    const a2 = t.contar(t.caja, t.turno, 132_000)
    // Todo mal a la vez, y sin justificación.
    expect(motivo(t.cerrar(t.caja, t.turno, nuevoId(), 1, 2))).toBe('arqueo_inexistente')
    expect(motivo(t.cerrar(t.caja, t.turno, a1.arqueo, 1, 2))).toBe('arqueo_no_es_el_ultimo')
    t.movimiento(t.caja, t.turno, 'entrada', 1_000)
    expect(motivo(t.cerrar(t.caja, t.turno, a2.arqueo, 1, 2))).toBe('arqueo_desactualizado')
    const a3 = t.contar(t.caja, t.turno, 133_000)
    expect(motivo(t.cerrar(t.caja, t.turno, a3.arqueo, 1, 2))).toBe('contado_distinto')
    expect(motivo(t.cerrar(t.caja, t.turno, a3.arqueo, 1, 133_000))).toBe('esperado_distinto')
    expect(motivo(t.cerrar(t.caja, t.turno, a3.arqueo, 133_000, 133_000))).toBe('confirmado')
  })

  describe('falta_justificacion', () => {
    /** Un turno de base 100.000 sin cobros; cuenta `contado` y cierra con `justificacion`. */
    function cierraCon(umbral: number, contado: number, justificacion: string | null) {
      const e = entorno({ umbral })
      const turno = e.abrirTurno(e.caja, 100_000)
      const { arqueo } = e.contar(e.caja, turno, contado)
      return motivo(e.cerrar(e.caja, turno, arqueo, 100_000, contado, justificacion))
    }

    it('umbral 0: cualquier diferencia pide justificación; sin diferencia, no', () => {
      expect(cierraCon(0, 100_000, null)).toBe('confirmado')
      expect(cierraCon(0, 99_999, null)).toBe('falta_justificacion')
      expect(cierraCon(0, 100_001, null)).toBe('falta_justificacion')
      expect(cierraCon(0, 99_000, null)).toBe('falta_justificacion')
      expect(cierraCon(0, 101_000, null)).toBe('falta_justificacion')
      expect(cierraCon(0, 99_000, 'Falta un billete')).toBe('confirmado')
    })

    it('umbral 1.000: por debajo se cierra sin más; desde 1.000 (faltante o sobrante) pide justificación', () => {
      expect(cierraCon(1000, 100_000, null)).toBe('confirmado')
      expect(cierraCon(1000, 99_999, null)).toBe('confirmado')
      expect(cierraCon(1000, 100_001, null)).toBe('confirmado')
      expect(cierraCon(1000, 99_001, null)).toBe('confirmado')
      expect(cierraCon(1000, 100_999, null)).toBe('confirmado')
      expect(cierraCon(1000, 99_000, null)).toBe('falta_justificacion')
      expect(cierraCon(1000, 101_000, null)).toBe('falta_justificacion')
      expect(cierraCon(1000, 98_999, null)).toBe('falta_justificacion')
      expect(cierraCon(1000, 99_000, null)).toBe('falta_justificacion')
      expect(cierraCon(1000, 101_000, null)).toBe('falta_justificacion')
      expect(cierraCon(1000, 98_000, null)).toBe('falta_justificacion')
      expect(cierraCon(1000, 99_000, 'Propina de la mesa 4')).toBe('confirmado')
    })

    it('umbral 2.000: una diferencia de 1.000 no pide justificación; de 2.000 sí (el borde es inclusivo)', () => {
      expect(cierraCon(2000, 99_000, null)).toBe('confirmado')
      expect(cierraCon(2000, 101_000, null)).toBe('confirmado')
      expect(cierraCon(2000, 98_000, null)).toBe('falta_justificacion')
      expect(cierraCon(2000, 102_000, null)).toBe('falta_justificacion')
    })

    it('una justificación presente se acepta aunque no hiciera falta', () => {
      expect(cierraCon(1000, 100_000, 'Todo bien')).toBe('confirmado')
    })

    it('una justificación vacía o de espacios no llega: el esquema la rechaza', () => {
      for (const j of ['', '   ']) expect(cierraCon(0, 99_000, j)).toMatch(/^esquema:/)
    })

    it('el umbral que vale es el vigente al cerrar: si el administrador lo cambia con el hub andando', () => {
      const e = entorno({ umbral: 5_000 })
      const turno = e.abrirTurno(e.caja, 100_000)
      const { arqueo } = e.contar(e.caja, turno, 99_000)
      e.cfg.umbral = 1_000
      expect(motivo(e.cerrar(e.caja, turno, arqueo, 100_000, 99_000))).toBe('falta_justificacion')
      e.cfg.umbral = 5_000
      expect(motivo(e.cerrar(e.caja, turno, arqueo, 100_000, 99_000))).toBe('confirmado')
    })

    it('un hub sin reglas de cobro usa el umbral de fábrica ($1.000)', () => {
      const e = entorno()
      const sinReglas = e.m.hub()
      const turno = nuevoId()
      const conexion = conexionDe(e.m, e.caja)
      sinReglas.recibirLote(conexion, [
        e.crudo(e.caja, 'TurnoAbierto', turno, { caja_id: e.caja.dispositivoId, base: 10_000 }),
      ])
      const intentar = (contado: number, justificacion: string | null = null) => {
        const arqueo = nuevoId()
        sinReglas.recibirLote(conexion, [
          e.crudo(e.caja, 'ArqueoRegistrado', turno, {
            arqueo_id: arqueo,
            conteo: e.conteoDe(contado),
            contado_efectivo: contado,
          }),
        ])
        return motivo(
          sinReglas.recibirLote(conexion, [
            e.crudo(
              e.caja,
              'TurnoCerrado',
              turno,
              e.datosCierre(arqueo, 10_000, contado, justificacion),
            ),
          ]).resultados[0],
        )
      }
      expect(intentar(9_000)).toBe('falta_justificacion')
      expect(intentar(9_001)).toBe('confirmado')
    })
  })

  it('el cierre correcto: se confirma, el turno ya no está abierto y el cuadre queda cerrado', () => {
    const t = turnoCobrado()
    const { arqueo } = t.contar(t.caja, t.turno, t.esperado)
    const r = t.cerrar(t.caja, t.turno, arqueo, t.esperado, t.esperado)
    expect(motivo(r)).toBe('confirmado')
    expect(t.estado.hub.turnoAbierto(t.caja.dispositivoId)).toBeNull()
    expect(t.estado.hub.cuadre(t.turno)?.cerrado).not.toBeNull()
    const cierre = eventosDe(t.m).find((x) => x.tipo === 'TurnoCerrado')
    expect(cierre?.agregado_id).toBe(t.turno)
    expect(cierre?.datos).toMatchObject({ esperado_efectivo: 132_000, diferencia: 0 })
  })

  it('con varios conteos, cada uno queda guardado', () => {
    const t = turnoCobrado()
    t.contar(t.caja, t.turno, 130_000)
    t.contar(t.caja, t.turno, 132_000)
    expect(t.estado.hub.cuadre(t.turno)?.arqueos.map((a) => a.contado)).toEqual([130_000, 132_000])
    expect(eventosDe(t.m).filter((x) => x.tipo === 'ArqueoRegistrado')).toHaveLength(2)
  })

  it('un faltante con la diferencia y la justificación queda guardado tal cual', () => {
    const t = turnoCobrado(0)
    const { arqueo } = t.contar(t.caja, t.turno, 130_000)
    expect(motivo(t.cerrar(t.caja, t.turno, arqueo, t.esperado, 130_000, 'Falta un vale'))).toBe(
      'confirmado',
    )
    const cierre = eventosDe(t.m).find((x) => x.tipo === 'TurnoCerrado')
    expect(cierre?.datos).toMatchObject({ diferencia: -2_000, justificacion: 'Falta un vale' })
  })

  it('reenviar el mismo cierre confirmado es idempotente; un segundo cierre con otro id, sin_turno', () => {
    const t = turnoCobrado()
    const { arqueo } = t.contar(t.caja, t.turno, t.esperado)
    const cierre = t.crudo(
      t.caja,
      'TurnoCerrado',
      t.turno,
      t.datosCierre(arqueo, t.esperado, t.esperado),
    )
    const a = t.uno(t.caja, cierre)
    const b = t.uno(t.caja, cierre)
    expect(motivo(a)).toBe('confirmado')
    expect(motivo(b)).toBe('confirmado')
    expect(eventosDe(t.m).filter((x) => x.tipo === 'TurnoCerrado')).toHaveLength(1)
    expect(motivo(t.cerrar(t.caja, t.turno, arqueo, t.esperado, t.esperado))).toBe('sin_turno')
  })

  it('un cierre rechazado se rechaza igual al reenviarlo; con el esperado corregido y otro id se acepta', () => {
    const t = turnoCobrado()
    const { arqueo } = t.contar(t.caja, t.turno, t.esperado)
    const viejo = t.crudo(
      t.caja,
      'TurnoCerrado',
      t.turno,
      t.datosCierre(arqueo, 130_000, 132_000, 'x'),
    )
    expect(motivo(t.uno(t.caja, viejo))).toBe('esperado_distinto')
    expect(motivo(t.uno(t.caja, viejo))).toBe('esperado_distinto')
    expect(motivo(t.cerrar(t.caja, t.turno, arqueo, t.esperado, t.esperado))).toBe('confirmado')
  })

  it('en un lote: el cierre antes de su arqueo se rechaza y lo que sigue del turno depende de él (depende_de_rechazado)', () => {
    const e = entorno()
    const turno = e.abrirTurno(e.caja, 10_000)
    const arqueo = nuevoId()
    const r = e.enviar(e.caja, [
      e.crudo(e.caja, 'TurnoCerrado', turno, e.datosCierre(arqueo, 10_000, 10_000)),
      e.crudo(e.caja, 'ArqueoRegistrado', turno, {
        arqueo_id: arqueo,
        conteo: [{ valor: 1_000, cantidad: 10 }],
        contado_efectivo: 10_000,
      }),
    ])
    expect(r.resultados.map(motivo)).toEqual(['arqueo_inexistente', 'depende_de_rechazado'])
    expect(e.estado.hub.turnoAbierto(e.caja.dispositivoId)).not.toBeNull()
  })

  it('en un lote: arqueo y cierre en orden se confirman juntos', () => {
    const e = entorno()
    const turno = e.abrirTurno(e.caja, 10_000)
    const arqueo = nuevoId()
    const r = e.enviar(e.caja, [
      e.crudo(e.caja, 'ArqueoRegistrado', turno, {
        arqueo_id: arqueo,
        conteo: [{ valor: 1_000, cantidad: 10 }],
        contado_efectivo: 10_000,
      }),
      e.crudo(e.caja, 'TurnoCerrado', turno, e.datosCierre(arqueo, 10_000, 10_000)),
    ])
    expect(r.resultados.map(motivo)).toEqual(['confirmado', 'confirmado'])
    expect(e.estado.hub.turnoAbierto(e.caja.dispositivoId)).toBeNull()
  })

  it('el cierre no toca a los demás turnos abiertos', () => {
    const t = turnoCobrado()
    const otro = t.abrirTurno(t.caja2, 5_000)
    const { arqueo } = t.contar(t.caja, t.turno, t.esperado)
    t.cerrar(t.caja, t.turno, arqueo, t.esperado, t.esperado)
    expect(t.estado.hub.turnoAbierto(t.caja2.dispositivoId)?.id).toBe(otro)
    expect(t.estado.hub.cuadre(otro)?.efectivo.esperado).toBe(5_000)
  })
})

describe('después del cierre', () => {
  function cerrado() {
    const e = entorno()
    const turno = e.abrirTurno(e.caja, 100_000)
    const pedido = e.abrirPedido(e.caja)
    const pago = e.cobrar(e.caja, pedido, e.pagoEf(turno, 10_000))
    const { arqueo } = e.contar(e.caja, turno, 110_000)
    expect(motivo(e.cerrar(e.caja, turno, arqueo, 110_000, 110_000))).toBe('confirmado')
    return { ...e, turno, pedido, pago }
  }

  it('un pago, una anulación y un reembolso a ese turno se rechazan con sin_turno', () => {
    const c = cerrado()
    const antes = c.m.almacen.maxSecuencia()
    const pago = c.uno(
      c.caja,
      c.crudo(c.caja, 'PagoRegistrado', c.pedido, c.pagoEf(c.turno, 5_000)),
    )
    expect(motivo(pago)).toBe('sin_turno')
    expect(motivo(c.anular(c.caja, c.pedido, c.pago, c.turno))).toBe('sin_turno')
    const reembolso = c.uno(
      c.caja,
      c.crudo(c.caja, 'ReembolsoRegistrado', c.pedido, {
        pago_id: c.pago,
        reembolso_id: nuevoId(),
        monto_venta: 1_000,
        monto_propina: 0,
        medio: 'efectivo',
        turno_caja_id: c.turno,
      }),
    )
    expect(motivo(reembolso)).toBe('sin_turno')
    expect(c.m.almacen.maxSecuencia()).toBe(antes)
    expect(Object.keys(c.estado.hub.pedido(c.pedido)?.pagos ?? {})).toHaveLength(1)
  })

  it('un movimiento, otro arqueo y otro cierre al turno cerrado: sin_turno', () => {
    const c = cerrado()
    expect(motivo(c.movimiento(c.caja, c.turno, 'entrada', 1_000))).toBe('sin_turno')
    expect(motivo(c.contar(c.caja, c.turno, 1_000).resultado)).toBe('sin_turno')
    expect(motivo(c.cerrar(c.caja, c.turno, nuevoId(), 0, 0))).toBe('sin_turno')
  })

  it('el id del turno cerrado no se puede reabrir (turno_ya_existe)', () => {
    const c = cerrado()
    const r = c.uno(
      c.caja,
      c.crudo(c.caja, 'TurnoAbierto', c.turno, { caja_id: c.caja.dispositivoId, base: 1 }),
    )
    expect(motivo(r)).toBe('turno_ya_existe')
  })

  it('la misma caja abre otro turno, con su propia base, y el cuadre del nuevo no hereda nada', () => {
    const c = cerrado()
    const nuevo = c.abrirTurno(c.caja, 30_000)
    expect(nuevo).not.toBe(c.turno)
    expect(c.estado.hub.turnoAbierto(c.caja.dispositivoId)).toMatchObject({
      id: nuevo,
      base: 30_000,
    })
    expect(c.estado.hub.cuadre(nuevo)?.efectivo).toMatchObject({
      cobrado: 0,
      entradas: 0,
      esperado: 30_000,
    })
    expect(c.estado.hub.cuadre(nuevo)?.porMedio).toEqual([])
  })

  it('en el turno nuevo se cobra con normalidad y el cierre cuadra solo con lo suyo', () => {
    const c = cerrado()
    const nuevo = c.abrirTurno(c.caja, 30_000)
    c.cobrar(c.caja, c.pedido, c.pagoEf(nuevo, 8_000, 500))
    // Lo del turno anterior (110.000) no cuenta: el esperado es 30.000 + 8.500.
    expect(c.estado.hub.cuadre(nuevo)?.efectivo.esperado).toBe(38_500)
    const { arqueo } = c.contar(c.caja, nuevo, 38_500)
    expect(motivo(c.cerrar(c.caja, nuevo, arqueo, 38_500, 38_500))).toBe('confirmado')
    expect(c.estado.hub.turnoAbierto(c.caja.dispositivoId)).toBeNull()
  })
})

describe('anular, en este turno, el pago de un turno anterior', () => {
  /** Turno 1 con un pago de 30.000 (+2.000 de propina) ya cerrado; turno 2 abierto con base 100.000. */
  function dosTurnos() {
    const e = entorno()
    const t1 = e.abrirTurno(e.caja, 0)
    const pedido = e.abrirPedido(e.caja)
    const pago = e.cobrar(e.caja, pedido, e.pagoEf(t1, 30_000, 2_000))
    const { arqueo } = e.contar(e.caja, t1, 32_000)
    expect(motivo(e.cerrar(e.caja, t1, arqueo, 32_000, 32_000))).toBe('confirmado')
    const t2 = e.abrirTurno(e.caja, 100_000)
    return { ...e, t1, t2, pedido, pago }
  }

  it('la anulación cae en el turno 2: devuelve lo cobrado (monto + propina) y el esperado baja', () => {
    const d = dosTurnos()
    expect(motivo(d.anular(d.caja, d.pedido, d.pago, d.t2))).toBe('confirmado')
    const c = d.estado.hub.cuadre(d.t2)
    expect(c?.efectivo).toMatchObject({ cobrado: 0, devoluciones: 32_000, esperado: 68_000 })
    expect(c?.porMedio).toEqual([
      { medio: 'efectivo', medioPropioId: null, venta: -30_000, propina: -2_000, pagos: -1 },
    ])
  })

  it('el cierre del turno 2 debe traer ese esperado: con el de antes de anular, esperado_distinto', () => {
    const d = dosTurnos()
    d.anular(d.caja, d.pedido, d.pago, d.t2)
    const { arqueo } = d.contar(d.caja, d.t2, 68_000)
    expect(motivo(d.cerrar(d.caja, d.t2, arqueo, 100_000, 68_000, 'x'))).toBe('esperado_distinto')
    expect(motivo(d.cerrar(d.caja, d.t2, arqueo, 68_000, 68_000))).toBe('confirmado')
  })

  it('con otros movimientos del turno 2 todo suma: base + entrada + cobro − reversa − salida', () => {
    const d = dosTurnos()
    d.movimiento(d.caja, d.t2, 'entrada', 5_000)
    d.cobrar(d.caja, d.pedido, d.pagoEf(d.t2, 10_000))
    d.anular(d.caja, d.pedido, d.pago, d.t2)
    d.movimiento(d.caja, d.t2, 'salida', 1_000)
    expect(d.estado.hub.cuadre(d.t2)?.efectivo.esperado).toBe(
      100_000 + 5_000 + 10_000 - 32_000 - 1_000,
    )
  })

  it('anular un pago de OTRA caja en este turno es turno_de_otra_caja solo si el turno no es de esta caja', () => {
    const d = dosTurnos()
    const turno2Ajeno = d.abrirTurno(d.caja2, 0)
    // La caja 2 anula, en su propio turno, un pago que cobró la caja 1 en su turno 1 ya cerrado.
    expect(motivo(d.anular(d.caja2, d.pedido, d.pago, turno2Ajeno))).toBe('confirmado')
    expect(d.estado.hub.cuadre(turno2Ajeno)?.efectivo).toMatchObject({ devoluciones: 32_000 })
    // La caja 1 no puede anularlo en el turno de la caja 2.
    expect(motivo(d.anular(d.caja, d.pedido, nuevoId(), turno2Ajeno))).toBe('turno_de_otra_caja')
  })

  it('un reembolso en efectivo en el turno 2 de un pago del turno 1 resta del cajón del turno 2', () => {
    const d = dosTurnos()
    const r = d.uno(
      d.caja,
      d.crudo(d.caja, 'ReembolsoRegistrado', d.pedido, {
        pago_id: d.pago,
        reembolso_id: nuevoId(),
        monto_venta: 4_000,
        monto_propina: 500,
        medio: 'efectivo',
        turno_caja_id: d.t2,
      }),
    )
    expect(motivo(r)).toBe('confirmado')
    expect(d.estado.hub.cuadre(d.t2)?.efectivo).toMatchObject({
      devoluciones: 4_500,
      esperado: 95_500,
    })
  })

  // El reembolso trae al turno el pago original (como la anulación), así que no se pierde el medio propio.
  it('un reembolso de un pago de medio propio de otro turno queda en el renglón de ese medio propio', () => {
    const e = entorno()
    const t1 = e.abrirTurno(e.caja, 0)
    const pedido = e.abrirPedido(e.caja)
    const pago = e.cobrar(e.caja, pedido, e.pagoPropio(t1, 20_000))
    const { arqueo } = e.contar(e.caja, t1, 0)
    // El Sodexo no se reportó en el conteo (1.8): el cierre lo marca y pide justificarlo.
    e.cerrar(e.caja, t1, arqueo, 0, 0, 'Sodexo sin reporte')
    const t2 = e.abrirTurno(e.caja, 0)
    const r = e.uno(
      e.caja,
      e.crudo(e.caja, 'ReembolsoRegistrado', pedido, {
        pago_id: pago,
        reembolso_id: nuevoId(),
        monto_venta: 5_000,
        monto_propina: 0,
        medio: 'otro',
        turno_caja_id: t2,
      }),
    )
    expect(motivo(r)).toBe('confirmado')
    expect(e.estado.hub.cuadre(t2)?.porMedio).toEqual([
      { medio: 'otro', medioPropioId: SODEXO, venta: -5_000, propina: 0, pagos: 0 },
    ])
  })
})

describe('reinicio del hub con un turno a medias', () => {
  /** Turno 1 cerrado y turno 2 con cobro, entrada, salida, anulación del pago del turno 1 y un conteo. */
  function aMedias() {
    const e = entorno()
    const t1 = e.abrirTurno(e.caja, 0)
    const pedido = e.abrirPedido(e.caja)
    const pago1 = e.cobrar(e.caja, pedido, e.pagoEf(t1, 30_000, 2_000))
    const a1 = e.contar(e.caja, t1, 32_000)
    e.cerrar(e.caja, t1, a1.arqueo, 32_000, 32_000)
    const t2 = e.abrirTurno(e.caja, 100_000)
    e.movimiento(e.caja, t2, 'entrada', 5_000)
    e.cobrar(e.caja, pedido, e.pagoEf(t2, 10_000))
    e.cobrar(e.caja, pedido, e.pagoNequi(t2, 800, 100))
    e.anular(e.caja, pedido, pago1, t2)
    e.movimiento(e.caja, t2, 'salida', 1_000)
    e.contar(e.caja, t2, 82_000)
    return { ...e, t1, t2, pedido, pago1 }
  }
  const ESPERADO = 100_000 + 5_000 + 10_000 - 32_000 - 1_000

  it('el cuadre se reconstruye idéntico: lo cobrado, las devoluciones, los movimientos y los conteos', () => {
    const a = aMedias()
    const antes = a.estado.hub.cuadre(a.t2)
    expect(antes?.efectivo.esperado).toBe(ESPERADO)
    const reiniciado = a.nuevoHub()
    expect(reiniciado.cuadre(a.t2)).toEqual(antes)
    expect(reiniciado.turnoAbierto(a.caja.dispositivoId)?.id).toBe(a.t2)
    // El turno cerrado no reaparece.
    expect(reiniciado.cuadre(a.t1)?.cerrado).not.toBeNull()
  })

  it('tras el reinicio el cierre se acepta con el esperado reconstruido y se rechaza con otro', () => {
    const a = aMedias()
    a.estado.hub = a.nuevoHub()
    const arqueo = a.estado.hub.cuadre(a.t2)?.arqueos[0]?.id ?? ''
    expect(motivo(a.cerrar(a.caja, a.t2, arqueo, ESPERADO + 1_000, 82_000, 'x'))).toBe(
      'esperado_distinto',
    )
    expect(motivo(a.cerrar(a.caja, a.t2, arqueo, ESPERADO, 82_000))).toBe('confirmado')
  })

  it('un turno cerrado sigue cerrado tras el reinicio: nada se le puede agregar y la caja abre otro', () => {
    const a = aMedias()
    const arqueo = a.estado.hub.cuadre(a.t2)?.arqueos[0]?.id ?? ''
    a.cerrar(a.caja, a.t2, arqueo, ESPERADO, 82_000)
    a.estado.hub = a.nuevoHub()
    expect(a.estado.hub.turnoAbierto(a.caja.dispositivoId)).toBeNull()
    expect(a.estado.hub.cuadre(a.t2)?.cerrado).not.toBeNull()
    expect(motivo(a.movimiento(a.caja, a.t2, 'entrada', 1_000))).toBe('sin_turno')
    expect(motivo(a.contar(a.caja, a.t2, 1_000).resultado)).toBe('sin_turno')
    const siguiente = a.abrirTurno(a.caja, 5_000)
    expect(a.estado.hub.cuadre(siguiente)?.efectivo.esperado).toBe(5_000)
  })

  it('los conteos o movimientos rechazados no reaparecen tras el reinicio', () => {
    const a = aMedias()
    a.movimiento(a.caja2, a.t2, 'entrada', 99_000) // de otra caja: rechazado
    a.cerrar(a.caja, a.t2, nuevoId(), 0, 0) // sin conteo: rechazado
    const reiniciado = a.nuevoHub()
    expect(reiniciado.cuadre(a.t2)?.efectivo.entradas).toBe(5_000)
    expect(reiniciado.cuadre(a.t2)?.efectivo.esperado).toBe(ESPERADO)
  })

  it('con eventos de más de una página entre medias, el turno se reconstruye completo', () => {
    const e = entorno()
    const turno = e.abrirTurno(e.caja, 1_000)
    const pedido = e.abrirPedido(e.caja, 1_000_000)
    e.cobrar(e.caja, pedido, e.pagoEf(turno, 20_000))
    // Más de una página de eventos de pedidos ajenos al turno, en un solo lote.
    const relleno: Record<string, unknown>[] = []
    for (let i = 0; i < TAMANO_PAGINA + 20; i++) {
      const p = nuevoId()
      relleno.push(
        e.crudo(e.ana, 'PedidoAbierto', p, { canal: 'salon', mesa_id: null, comensales: 1 }),
      )
    }
    for (let i = 0; i < relleno.length; i += 100) e.enviar(e.ana, relleno.slice(i, i + 100))
    e.movimiento(e.caja, turno, 'entrada', 2_000)
    e.estado.hub = e.nuevoHub()
    expect(eventosDe(e.m).length).toBeGreaterThan(TAMANO_PAGINA)
    expect(e.estado.hub.cuadre(turno)?.efectivo).toMatchObject({
      cobrado: 20_000,
      entradas: 2_000,
      esperado: 23_000,
    })
  })

  it('el hub se cae al guardar el cierre: al volver sigue a medias, y el cierre reenviado se acepta una vez', () => {
    const e = entorno()
    const turno = e.abrirTurno(e.caja, 10_000)
    const { arqueo } = e.contar(e.caja, turno, 10_000)
    const cierre = e.crudo(e.caja, 'TurnoCerrado', turno, e.datosCierre(arqueo, 10_000, 10_000))
    const almacen = e.m.almacen as AlmacenQueSeCae
    almacen.caerEn = 1
    expect(() => e.uno(e.caja, cierre)).toThrow('apag')
    expect(almacen.caido).toBe(true)
    almacen.caido = false
    e.estado.hub = e.nuevoHub()
    expect(e.estado.hub.turnoAbierto(e.caja.dispositivoId)?.id).toBe(turno)
    expect(eventosDe(e.m).filter((x) => x.tipo === 'TurnoCerrado')).toHaveLength(0)
    expect(motivo(e.uno(e.caja, cierre))).toBe('confirmado')
    expect(motivo(e.uno(e.caja, cierre))).toBe('confirmado')
    expect(eventosDe(e.m).filter((x) => x.tipo === 'TurnoCerrado')).toHaveLength(1)
  })
})

describe('multirestaurante: el cuadre es de cada restaurante', () => {
  function dos() {
    const e = entorno()
    const otroId = nuevoId()
    e.m.db
      .prepare(
        `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
         VALUES (?, ?, ?, ?, 1, 'Otro restaurante', '{}')`,
      )
      .run(otroId, otroId, AHORA, AHORA)
    const nuevoHubB = () =>
      new HubSync(new AlmacenSqlite(e.m.db, otroId), {
        restauranteId: otroId,
        zonaHoraria: 'America/Bogota',
        inicioDiaOperativo: '06:00',
        acceso: accesoLibre,
        instancia: 'hub-b',
        reloj: e.m.red.horaIso,
        reglasCobro: () => ({ ...REGLAS, umbralDiferencia: 0 }),
      })
    return { ...e, otroId, hubB: nuevoHubB(), nuevoHubB }
  }

  it('el movimiento, el arqueo y el cierre del turno de A no existen en B (sin_turno)', () => {
    const d = dos()
    const turno = d.abrirTurno(d.caja, 50_000)
    const enB = (tipo: string, datos: unknown) =>
      motivo(
        d.enviar(d.caja, [d.crudo(d.caja, tipo, turno, datos, { secuencia_base: 0 })], d.hubB)
          .resultados[0],
      )
    expect(
      enB('MovimientoCajaRegistrado', {
        movimiento_id: nuevoId(),
        tipo: 'entrada',
        monto: 1_000,
        descripcion: 'x',
        a_quien: null,
        dias: [],
      }),
    ).toBe('sin_turno')
    expect(enB('ArqueoRegistrado', { arqueo_id: nuevoId(), conteo: [], contado_efectivo: 0 })).toBe(
      'sin_turno',
    )
    expect(enB('TurnoCerrado', d.datosCierre(nuevoId(), 0, 0))).toBe('sin_turno')
    expect(d.hubB.cuadre(turno)).toBeNull()
    expect(d.estado.hub.cuadre(turno)?.efectivo.esperado).toBe(50_000)
  })

  it('cada restaurante tiene su turno y su cuadre aunque sea la misma caja y haya cierres en uno', () => {
    const d = dos()
    const turnoA = d.abrirTurno(d.caja, 10_000)
    const turnoB = nuevoId()
    const rB = d.enviar(
      d.caja,
      [
        d.crudo(
          d.caja,
          'TurnoAbierto',
          turnoB,
          { caja_id: d.caja.dispositivoId, base: 20_000 },
          { secuencia_base: 0 },
        ),
        d.crudo(
          d.caja,
          'MovimientoCajaRegistrado',
          turnoB,
          {
            movimiento_id: nuevoId(),
            tipo: 'entrada',
            monto: 3_000,
            descripcion: 'x',
            a_quien: null,
            dias: [],
          },
          { secuencia_base: 0 },
        ),
      ],
      d.hubB,
    )
    expect(rB.resultados.map(motivo)).toEqual(['confirmado', 'confirmado'])
    d.movimiento(d.caja, turnoA, 'salida', 4_000)
    expect(d.estado.hub.cuadre(turnoA)?.efectivo.esperado).toBe(6_000)
    expect(d.hubB.cuadre(turnoB)?.efectivo.esperado).toBe(23_000)

    // Cerrar el de A no cierra el de B.
    const { arqueo } = d.contar(d.caja, turnoA, 6_000)
    expect(motivo(d.cerrar(d.caja, turnoA, arqueo, 6_000, 6_000))).toBe('confirmado')
    expect(d.estado.hub.turnoAbierto(d.caja.dispositivoId)).toBeNull()
    expect(d.hubB.turnoAbierto(d.caja.dispositivoId)?.id).toBe(turnoB)

    // Reiniciar cada hub reconstruye solo lo suyo.
    expect(d.nuevoHub().turnoAbierto(d.caja.dispositivoId)).toBeNull()
    const reiniciadoB = d.nuevoHubB()
    expect(reiniciadoB.cuadre(turnoB)?.efectivo).toMatchObject({
      entradas: 3_000,
      esperado: 23_000,
    })
    expect(reiniciadoB.cuadre(turnoA)).toBeNull()
  })

  it('el umbral es de cada restaurante: un faltante de $500 se cierra solo en A (umbral 1.000), no en B (umbral 0)', () => {
    const d = dos()
    const enB = (evento: Record<string, unknown>) =>
      motivo(d.enviar(d.caja, [evento], d.hubB).resultados[0])
    const turnoB = nuevoId()
    expect(
      enB(
        d.crudo(
          d.caja,
          'TurnoAbierto',
          turnoB,
          { caja_id: d.caja.dispositivoId, base: 10_000 },
          { secuencia_base: 0 },
        ),
      ),
    ).toBe('confirmado')
    const arqueoB = nuevoId()
    enB(
      d.crudo(
        d.caja,
        'ArqueoRegistrado',
        turnoB,
        { arqueo_id: arqueoB, conteo: d.conteoDe(9_500), contado_efectivo: 9_500 },
        { secuencia_base: 0 },
      ),
    )
    expect(
      enB(
        d.crudo(d.caja, 'TurnoCerrado', turnoB, d.datosCierre(arqueoB, 10_000, 9_500), {
          secuencia_base: 0,
        }),
      ),
    ).toBe('falta_justificacion')

    const turnoA = d.abrirTurno(d.caja, 10_000)
    const { arqueo } = d.contar(d.caja, turnoA, 9_500)
    expect(motivo(d.cerrar(d.caja, turnoA, arqueo, 10_000, 9_500))).toBe('confirmado')
  })
})

describe('con la red simulada: la caja cierra sin conexión, el hub se apaga y llegan duplicados', () => {
  /** La caja abre turno, mueve efectivo, cuenta y cierra; cada evento se guarda en el dispositivo. */
  async function cajaCierra(caja: Nodo, base = 100_000) {
    const turno = nuevoId()
    const arqueo = nuevoId()
    const turnoCaja = { agregado_tipo: 'turno_caja' } as never
    await caja.crear(turno, 'TurnoAbierto', { caja_id: caja.dispositivoId, base }, turnoCaja)
    await caja.crear(
      turno,
      'MovimientoCajaRegistrado',
      {
        movimiento_id: nuevoId(),
        tipo: 'entrada',
        monto: 20_000,
        descripcion: 'Cambio',
        a_quien: null,
        dias: [],
      },
      turnoCaja,
    )
    await caja.crear(
      turno,
      'ArqueoRegistrado',
      { arqueo_id: arqueo, conteo: [{ valor: 20_000, cantidad: 6 }], contado_efectivo: 120_000 },
      turnoCaja,
    )
    await caja.crear(
      turno,
      'TurnoCerrado',
      {
        arqueo_id: arqueo,
        esperado_efectivo: base + 20_000,
        contado_efectivo: 120_000,
        diferencia: 120_000 - (base + 20_000),
        justificacion: 'Se pagó un domicilio',
      },
      turnoCaja,
    )
    return turno
  }
  const tipos = (m: Montaje) => eventosDe(m).map((x) => x.tipo)
  const CUATRO = ['TurnoAbierto', 'MovimientoCajaRegistrado', 'ArqueoRegistrado', 'TurnoCerrado']

  it('todo sin conexión: al reconectar los cuatro se confirman en orden y el turno queda cerrado', async () => {
    const m = montar()
    const caja = m.red.dispositivo('caja')
    const ana = m.red.dispositivo('ana')
    const turno = await cajaCierra(caja)
    expect(await caja.cliente.pendientes()).toBe(4)
    await m.red.conectarTodos()
    expect(tipos(m)).toEqual(CUATRO)
    expect(m.hub().turnoAbierto(caja.dispositivoId)).toBeNull()
    expect(m.hub().cuadre(turno)?.cerrado).not.toBeNull()
    expect(await caja.cliente.pendientes()).toBe(0)
    expect((await ana.cliente.locales()).map((l) => l.evento.tipo)).toEqual(CUATRO)
  })

  it('un lote duplicado por la red no repite movimientos ni cierres', async () => {
    const m = montar()
    const caja = m.red.dispositivo('caja')
    await m.red.conectarTodos()
    caja.regla('al_hub', 'empujar', 'duplicar', 4)
    await cajaCierra(caja)
    await m.red.estabilizar()
    expect(tipos(m)).toEqual(CUATRO)
    expect(await caja.cliente.pendientes()).toBe(0)
  })

  it('el hub se apaga justo al guardar el conteo: al volver, el arqueo y el cierre se completan sin duplicar', async () => {
    const m = montar()
    const caja = m.red.dispositivo('caja')
    await m.red.conectarTodos()
    if (m.almacen instanceof AlmacenQueSeCae) m.almacen.caerEn = 3
    const turno = await cajaCierra(caja)
    await m.red.estabilizar()
    await m.red.conectarTodos()
    await m.red.estabilizar()
    expect(tipos(m)).toEqual(CUATRO)
    expect(m.hub().turnoAbierto(caja.dispositivoId)).toBeNull()
    expect(eventosDe(m).every((x) => x.agregado_id === turno)).toBe(true)
  })

  it('el hub se apaga justo al guardar el cierre: el turno vuelve abierto y el cierre llega una sola vez', async () => {
    const m = montar()
    const caja = m.red.dispositivo('caja')
    await m.red.conectarTodos()
    if (m.almacen instanceof AlmacenQueSeCae) m.almacen.caerEn = 4
    await cajaCierra(caja)
    await m.red.estabilizar()
    await m.red.conectarTodos()
    await m.red.estabilizar()
    expect(tipos(m).filter((x) => x === 'TurnoCerrado')).toHaveLength(1)
    expect(m.hub().turnoAbierto(caja.dispositivoId)).toBeNull()
  })

  it('con el reloj de la caja 3 horas atrasado el cierre se acepta igual', async () => {
    const m = montar()
    const caja = m.red.dispositivo('caja')
    caja.desfaseMs = -3 * 60 * 60 * 1000
    await m.red.conectarTodos()
    await cajaCierra(caja)
    await m.red.estabilizar()
    expect(tipos(m)).toEqual(CUATRO)
  })

  it('con el reloj adelantado un día, también', async () => {
    const m = montar()
    const caja = m.red.dispositivo('caja')
    caja.desfaseMs = 24 * 60 * 60 * 1000
    await m.red.conectarTodos()
    await cajaCierra(caja)
    await m.red.estabilizar()
    expect(tipos(m)).toEqual(CUATRO)
    expect(m.hub().turnoAbierto(caja.dispositivoId)).toBeNull()
  })
})

describe('informe del hub (tarea 1.9): datosDeInforme y cierreDeTurno', () => {
  const DIA = '2026-10-24'

  it('junta los pedidos cerrados, los pagos del día y el cierre del turno con su cuadre', () => {
    const e = entorno()
    const turno = e.abrirTurno(e.caja, 50_000)
    const cerrado = e.abrirPedido(e.caja, 30_000)
    e.cobrar(e.caja, cerrado, e.pagoEf(turno, 30_000, 3_000))
    expect(motivo(e.uno(e.caja, e.crudo(e.caja, 'PedidoCerrado', cerrado, {})))).toBe('confirmado')
    // Un abono de una mesa que sigue abierta: cuenta por medio, no en ventas.
    const abierto = e.abrirPedido(e.caja, 20_000)
    const abono = e.cobrar(e.caja, abierto, e.pagoNequi(turno, 5_000))
    e.anular(e.caja, abierto, abono, turno)
    e.movimiento(e.caja, turno, 'pago_propinas', 1_000)
    const { arqueo } = e.contar(e.caja, turno, 82_000)
    expect(motivo(e.cerrar(e.caja, turno, arqueo, 82_000, 82_000))).toBe('confirmado')

    const datos = e.estado.hub.datosDeInforme(DIA, DIA)
    expect(datos.cierres?.map((c) => [c.antes, c.despues.id])).toEqual([[null, cerrado]])
    // El pago de Nequi se anuló el mismo día: aparece con su anulación.
    expect(datos.eventos.map((x) => x.tipo)).toEqual([
      'PagoRegistrado',
      'PagoRegistrado',
      'PagoAnulado',
      'MovimientoCajaRegistrado',
    ])
    expect(datos.cierresDeCaja).toHaveLength(1)
    expect(datos.cierresDeCaja[0]).toMatchObject({
      diaOperativo: DIA,
      abiertoPor: e.caja.usuarioId,
      cerradoPor: e.caja.usuarioId,
    })
    expect(datos.cierresDeCaja[0]?.cuadre.cerrado).toMatchObject({
      esperado: 82_000,
      diferencia: 0,
    })
    // Ya cerrado, el cuadre sale de la base y es el mismo que vio la caja al cerrar.
    expect(e.estado.hub.cuadre(turno)?.efectivo.esperado).toBe(82_000)
    expect(e.estado.hub.datosDeInforme('2026-10-25', '2026-10-25')).toMatchObject({
      cierres: [],
      eventos: [],
      cierresDeCaja: [],
    })
  })

  it('una anulación de hoy trae el pago original de otro día, y un reinicio da lo mismo', () => {
    const e = entorno()
    const turno = e.abrirTurno(e.caja)
    const pedido = e.abrirPedido(e.caja, 30_000)
    const pago = e.cobrar(e.caja, pedido, e.pagoNequi(turno, 10_000))
    // Al otro día operativo (después de las 6:00 a. m.).
    e.m.red.avanzar(24 * 60 * 60 * 1000)
    e.anular(e.caja, pedido, pago, turno)
    const hoy = e.estado.hub.datosDeInforme('2026-10-25', '2026-10-25')
    expect(hoy.eventos.map((x) => `${x.tipo}:${x.dia_operativo}`)).toEqual([
      `PagoRegistrado:${DIA}`,
      'PagoAnulado:2026-10-25',
    ])
    expect(e.nuevoHub().datosDeInforme('2026-10-25', '2026-10-25')).toEqual(hoy)
    expect(e.estado.hub.cierreDeTurno(turno)).toBeNull()
  })
})
