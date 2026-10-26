import { agregadoDe, cuadreDeOtrosMedios, nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { AlmacenSqlite } from './hub/almacen-sqlite'
import { HubSync } from './hub/hub'
import { accesoLibre } from './pruebas/acceso'
import { AHORA, AlmacenQueSeCae, eventosDe, item, type Montaje, montar } from './pruebas/montaje'
import type { Nodo } from './pruebas/red'

// El cierre de caja con los demás medios en el hub (tarea 1.8): `otros_medios_distintos`, la
// justificación por un medio que no es efectivo, el cierre correcto con tarjeta y Nequi, la
// compatibilidad con la 1.7, el reinicio del hub, la red simulada y el multirestaurante.

const SODEXO = nuevoId()
const QR = nuevoId()
const DATAFONO = nuevoId()
const REGLAS = {
  multiplo: 100,
  modo: 'cercano_mitad_abajo',
  medios: ['efectivo', 'tarjeta', 'nequi', 'daviplata', 'breb', 'transferencia'],
  mediosPropios: [SODEXO, QR],
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

type Reporte = { medio: string; medio_propio_id: string | null; reportado: number }
type Linea = Reporte & { esperado: number; diferencia: number }
const rep = (medio: string, reportado: number, propio: string | null = null): Reporte => ({
  medio,
  medio_propio_id: propio,
  reportado,
})
const lin = (
  medio: string,
  esperado: number,
  reportado: number,
  propio: string | null = null,
): Linea => ({
  ...rep(medio, reportado, propio),
  esperado,
  diferencia: reportado - esperado,
})

function entorno(opciones: { umbral?: number } = {}) {
  const m = montar()
  const caja = m.red.dispositivo('caja')
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
  /** En otro hub (otro restaurante) la secuencia base de A no vale: se parte de 0. */
  const deHub = (hub: HubSync): Record<string, unknown> =>
    hub === estado.hub ? {} : { secuencia_base: 0 }
  const enviar = (nodo: Nodo, eventos: Record<string, unknown>[], hub = estado.hub) =>
    hub.recibirLote(conexionDe(m, nodo), eventos)
  const uno = (nodo: Nodo, evento: Record<string, unknown>, hub = estado.hub) =>
    enviar(nodo, [evento], hub).resultados[0]

  const abrirTurno = (nodo: Nodo, base = 100_000, turno = nuevoId()) => {
    expect(
      motivo(uno(nodo, crudo(nodo, 'TurnoAbierto', turno, { caja_id: nodo.dispositivoId, base }))),
    ).toBe('confirmado')
    return turno
  }
  const abrirPedido = (nodo: Nodo, precio = 1_000_000, hub = estado.hub) => {
    const pedido = nuevoId()
    uno(
      nodo,
      crudo(
        nodo,
        'PedidoAbierto',
        pedido,
        { canal: 'salon', mesa_id: null, comensales: 2 },
        deHub(hub),
      ),
      hub,
    )
    uno(nodo, crudo(nodo, 'ItemAgregado', pedido, item(precio), deHub(hub)), hub)
    return pedido
  }
  const base = (turno: string, monto: number, propina: number) => ({
    pago_id: nuevoId(),
    cuenta_id: null,
    turno_caja_id: turno,
    monto,
    propina,
    recibido: null,
    cambio: null,
    ajuste_redondeo: 0,
    redondeo: null,
    datafono: null,
    referencia_cobro: null,
  })
  const pagoEf = (turno: string, monto: number, propina = 0) => ({
    ...base(turno, monto, propina),
    medio: 'efectivo',
    recibido: monto + propina,
    cambio: 0,
  })
  const pagoTarjeta = (turno: string, monto: number, propina = 0) => ({
    ...base(turno, monto, propina),
    medio: 'tarjeta',
    datafono: {
      datafono_id: DATAFONO,
      franquicia: null,
      ultimos4: null,
      aprobacion: null,
      recibo: null,
      tipo_tarjeta: 'credito',
    },
  })
  const pagoNequi = (turno: string, monto: number, propina = 0) => ({
    ...base(turno, monto, propina),
    medio: 'nequi',
  })
  const pagoPropio = (turno: string, id: string, monto: number, propina = 0) => ({
    ...base(turno, monto, propina),
    medio: 'otro',
    medio_propio_id: id,
  })
  const cobrar = (nodo: Nodo, pedido: string, datos: { pago_id: string }, hub = estado.hub) => {
    expect(motivo(uno(nodo, crudo(nodo, 'PagoRegistrado', pedido, datos, deHub(hub)), hub))).toBe(
      'confirmado',
    )
    return datos.pago_id
  }
  const anular = (nodo: Nodo, pedido: string, pagoId: string, turno: string) =>
    uno(nodo, crudo(nodo, 'PagoAnulado', pedido, { pago_id: pagoId, turno_caja_id: turno }))
  const conteoDe = (contado: number) =>
    [
      { valor: 1_000, cantidad: Math.floor(contado / 1_000) },
      { valor: 1, cantidad: contado % 1_000 },
    ].filter((c) => c.cantidad > 0)
  /** Un conteo de `contado` pesos en efectivo y los reportes de los demás medios (si se dan). */
  const contar = (
    nodo: Nodo,
    turno: string,
    contado: number,
    otros?: Reporte[],
    hub = estado.hub,
  ) => {
    const arqueo = nuevoId()
    const resultado = uno(
      nodo,
      crudo(
        nodo,
        'ArqueoRegistrado',
        turno,
        {
          arqueo_id: arqueo,
          conteo: conteoDe(contado),
          contado_efectivo: contado,
          ...(otros ? { otros } : {}),
        },
        deHub(hub),
      ),
      hub,
    )
    return { arqueo, resultado }
  }
  /** Las líneas que debe traer el cierre: las que calcula el hub con el conteo. */
  const lineasDe = (turno: string, arqueo: string, hub = estado.hub): Linea[] => {
    const cuadre = hub.cuadre(turno)
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
  /** Cierra con lo que se pida; sin `otros_medios` se manda el cierre tal cual lo calcula el hub. */
  const cerrar = (
    nodo: Nodo,
    turno: string,
    arqueo: string,
    esperado: number,
    contado: number,
    opciones: {
      justificacion?: string | null
      otros_medios?: unknown
      sinCampo?: boolean
      hub?: HubSync
    } = {},
  ) => {
    const hub = opciones.hub ?? estado.hub
    const datos: Record<string, unknown> = {
      arqueo_id: arqueo,
      esperado_efectivo: esperado,
      contado_efectivo: contado,
      diferencia: contado - esperado,
      justificacion: opciones.justificacion ?? null,
    }
    if (!opciones.sinCampo)
      datos.otros_medios = opciones.otros_medios ?? lineasDe(turno, arqueo, hub)
    return uno(nodo, crudo(nodo, 'TurnoCerrado', turno, datos, deHub(hub)), hub)
  }

  return {
    m,
    caja,
    ana,
    cfg,
    deHub,
    estado,
    nuevoHub,
    crudo,
    enviar,
    uno,
    abrirTurno,
    abrirPedido,
    pagoEf,
    pagoTarjeta,
    pagoNequi,
    pagoPropio,
    cobrar,
    anular,
    contar,
    conteoDe,
    cerrar,
    lineasDe,
  }
}

/** Base 100.000, tarjeta 100.000 + 10.000 de propina y Nequi 30.000; efectivo contado 100.000. */
function conTarjetaYNequi(umbral = 1000) {
  const e = entorno({ umbral })
  const turno = e.abrirTurno(e.caja, 100_000)
  const pedido = e.abrirPedido(e.caja)
  e.cobrar(e.caja, pedido, e.pagoTarjeta(turno, 100_000, 10_000))
  e.cobrar(e.caja, pedido, e.pagoNequi(turno, 30_000))
  return { ...e, turno, pedido, ESPERADO_TARJETA: 110_000, ESPERADO_NEQUI: 30_000 }
}

describe('cierre con tarjeta y Nequi', () => {
  it('el cierre correcto: cada medio reportado igual a lo registrado, se confirma y queda guardado', () => {
    const t = conTarjetaYNequi()
    const { arqueo, resultado } = t.contar(t.caja, t.turno, 100_000, [
      rep('tarjeta', 110_000),
      rep('nequi', 30_000),
    ])
    expect(motivo(resultado)).toBe('confirmado')
    const cierre = t.cerrar(t.caja, t.turno, arqueo, 100_000, 100_000)
    expect(motivo(cierre)).toBe('confirmado')
    expect(t.estado.hub.turnoAbierto(t.caja.dispositivoId)).toBeNull()
    const guardado = eventosDe(t.m).find((x) => x.tipo === 'TurnoCerrado')
    expect(guardado?.tipo === 'TurnoCerrado' && guardado.datos.otros_medios).toEqual([
      lin('tarjeta', 110_000, 110_000),
      lin('nequi', 30_000, 30_000),
    ])
  })

  it('con diferencia en un medio pero justificada: se confirma y la diferencia queda guardada con su signo', () => {
    const t = conTarjetaYNequi()
    const { arqueo } = t.contar(t.caja, t.turno, 100_000, [
      rep('tarjeta', 105_000),
      rep('nequi', 31_500),
    ])
    expect(motivo(t.cerrar(t.caja, t.turno, arqueo, 100_000, 100_000))).toBe('falta_justificacion')
    expect(
      motivo(
        t.cerrar(t.caja, t.turno, arqueo, 100_000, 100_000, {
          justificacion: 'El datáfono se reinició',
        }),
      ),
    ).toBe('confirmado')
    const guardado = eventosDe(t.m).find((x) => x.tipo === 'TurnoCerrado')
    expect(guardado?.tipo === 'TurnoCerrado' && guardado.datos.otros_medios).toEqual([
      lin('tarjeta', 110_000, 105_000),
      lin('nequi', 30_000, 31_500),
    ])
  })

  it('con un medio propio y otro reportado sin pagos (un cobro que no se registró)', () => {
    const e = entorno()
    const turno = e.abrirTurno(e.caja, 0)
    const pedido = e.abrirPedido(e.caja)
    e.cobrar(e.caja, pedido, e.pagoPropio(turno, SODEXO, 20_000))
    const { arqueo } = e.contar(e.caja, turno, 0, [
      rep('otro', 20_000, SODEXO),
      rep('daviplata', 5_000),
    ])
    expect(e.lineasDe(turno, arqueo)).toEqual([
      lin('otro', 20_000, 20_000, SODEXO),
      lin('daviplata', 0, 5_000),
    ])
    expect(motivo(e.cerrar(e.caja, turno, arqueo, 0, 0))).toBe('falta_justificacion')
    expect(
      motivo(
        e.cerrar(e.caja, turno, arqueo, 0, 0, {
          justificacion: 'Un cobro por Daviplata sin registrar',
        }),
      ),
    ).toBe('confirmado')
  })

  it('el orden de las líneas del cierre no importa', () => {
    const t = conTarjetaYNequi()
    const { arqueo } = t.contar(t.caja, t.turno, 100_000, [
      rep('tarjeta', 110_000),
      rep('nequi', 30_000),
    ])
    expect(
      motivo(
        t.cerrar(t.caja, t.turno, arqueo, 100_000, 100_000, {
          otros_medios: [lin('nequi', 30_000, 30_000), lin('tarjeta', 110_000, 110_000)],
        }),
      ),
    ).toBe('confirmado')
  })

  it('un reembolso o una anulación bajan lo esperado: el cierre debe traer lo neto', () => {
    const t = conTarjetaYNequi()
    const pago = t.cobrar(t.caja, t.pedido, t.pagoNequi(t.turno, 10_000))
    t.anular(t.caja, t.pedido, pago, t.turno)
    const { arqueo } = t.contar(t.caja, t.turno, 100_000, [
      rep('tarjeta', 110_000),
      rep('nequi', 30_000),
    ])
    expect(t.lineasDe(t.turno, arqueo)).toEqual([
      lin('tarjeta', 110_000, 110_000),
      lin('nequi', 30_000, 30_000),
    ])
    expect(motivo(t.cerrar(t.caja, t.turno, arqueo, 100_000, 100_000))).toBe('confirmado')
  })
})

describe('otros_medios_distintos', () => {
  function listo() {
    const t = conTarjetaYNequi()
    const { arqueo } = t.contar(t.caja, t.turno, 100_000, [
      rep('tarjeta', 110_000),
      rep('nequi', 30_000),
    ])
    const cerrarCon = (otros_medios: unknown) =>
      motivo(t.cerrar(t.caja, t.turno, arqueo, 100_000, 100_000, { otros_medios }))
    return { ...t, arqueo, cerrarCon }
  }

  it('falta un medio: el cierre no trae el Nequi', () => {
    expect(listo().cerrarCon([lin('tarjeta', 110_000, 110_000)])).toBe('otros_medios_distintos')
  })

  it('falta todo: una lista vacía con pagos digitales', () => {
    expect(listo().cerrarCon([])).toBe('otros_medios_distintos')
  })

  it('sin el campo `otros_medios` (un cliente de la 1.7) con pagos digitales', () => {
    const t = conTarjetaYNequi()
    const { arqueo } = t.contar(t.caja, t.turno, 100_000, [
      rep('tarjeta', 110_000),
      rep('nequi', 30_000),
    ])
    expect(motivo(t.cerrar(t.caja, t.turno, arqueo, 100_000, 100_000, { sinCampo: true }))).toBe(
      'otros_medios_distintos',
    )
  })

  it('sobra un medio: una línea con reportado que el conteo no tiene', () => {
    expect(
      listo().cerrarCon([
        lin('tarjeta', 110_000, 110_000),
        lin('nequi', 30_000, 30_000),
        lin('daviplata', 0, 5_000),
      ]),
    ).toBe('otros_medios_distintos')
  })

  it('sobra un medio en 0 y 0: el hub no lo lista, así que el cierre con él es distinto', () => {
    expect(
      listo().cerrarCon([
        lin('tarjeta', 110_000, 110_000),
        lin('nequi', 30_000, 30_000),
        lin('daviplata', 0, 0),
      ]),
    ).toBe('otros_medios_distintos')
  })

  // El esquema ya rechaza la línea repetida y el medio propio sin id, antes de comparar con el hub.
  it('una línea repetida: el esquema la rechaza', () => {
    expect(
      listo().cerrarCon([
        lin('tarjeta', 110_000, 110_000),
        lin('tarjeta', 110_000, 110_000),
        lin('nequi', 30_000, 30_000),
      ]),
    ).toMatch(/^esquema: .*Un medio aparece dos veces/)
  })

  it('otro esperado: dice $1 menos o más de lo que registró el hub', () => {
    expect(
      listo().cerrarCon([lin('tarjeta', 109_999, 110_000), lin('nequi', 30_000, 30_000)]),
    ).toBe('otros_medios_distintos')
    expect(
      listo().cerrarCon([lin('tarjeta', 110_001, 110_000), lin('nequi', 30_000, 30_000)]),
    ).toBe('otros_medios_distintos')
  })

  it('otro reportado: dice otro valor que el conteo, aunque la diferencia sea consecuente', () => {
    expect(
      listo().cerrarCon([lin('tarjeta', 110_000, 100_000), lin('nequi', 30_000, 30_000)]),
    ).toBe('otros_medios_distintos')
    expect(
      listo().cerrarCon([lin('tarjeta', 110_000, 110_000), lin('nequi', 30_000, 30_001)]),
    ).toBe('otros_medios_distintos')
  })

  it('una línea con la diferencia mal calculada no llega: el esquema la rechaza', () => {
    const r = listo().cerrarCon([
      { ...lin('tarjeta', 110_000, 110_000), diferencia: 5 },
      lin('nequi', 30_000, 30_000),
    ])
    expect(r).toMatch(/^esquema:/)
  })

  it('el efectivo entre los demás medios: el esquema lo rechaza', () => {
    const r = listo().cerrarCon([
      lin('efectivo', 0, 0),
      lin('tarjeta', 110_000, 110_000),
      lin('nequi', 30_000, 30_000),
    ])
    expect(r).toMatch(/^esquema:/)
  })

  it('un medio cambiado por otro (Nequi dicho como Daviplata)', () => {
    expect(
      listo().cerrarCon([lin('tarjeta', 110_000, 110_000), lin('daviplata', 30_000, 30_000)]),
    ).toBe('otros_medios_distintos')
  })

  it('un medio propio con otro id: distinto', () => {
    const e = entorno()
    const turno = e.abrirTurno(e.caja, 0)
    const pedido = e.abrirPedido(e.caja)
    e.cobrar(e.caja, pedido, e.pagoPropio(turno, SODEXO, 20_000))
    const { arqueo } = e.contar(e.caja, turno, 0, [rep('otro', 20_000, SODEXO)])
    expect(
      motivo(
        e.cerrar(e.caja, turno, arqueo, 0, 0, { otros_medios: [lin('otro', 20_000, 20_000, QR)] }),
      ),
    ).toBe('otros_medios_distintos')
    expect(
      motivo(
        e.cerrar(e.caja, turno, arqueo, 0, 0, {
          otros_medios: [lin('otro', 20_000, 20_000, SODEXO)],
        }),
      ),
    ).toBe('confirmado')
  })

  it('un medio propio sin id en el cierre: el esquema lo rechaza', () => {
    const e = entorno()
    const turno = e.abrirTurno(e.caja, 0)
    const pedido = e.abrirPedido(e.caja)
    e.cobrar(e.caja, pedido, e.pagoPropio(turno, SODEXO, 20_000))
    const { arqueo } = e.contar(e.caja, turno, 0, [rep('otro', 20_000, SODEXO)])
    expect(
      motivo(
        e.cerrar(e.caja, turno, arqueo, 0, 0, {
          otros_medios: [lin('otro', 20_000, 20_000, null)],
        }),
      ),
    ).toMatch(/^esquema: .*Un medio propio dice cuál es/)
  })

  it('un rechazo no cierra el turno ni deja huella; con las líneas correctas se acepta', () => {
    const t = listo()
    const antes = t.m.almacen.maxSecuencia()
    expect(t.cerrarCon([])).toBe('otros_medios_distintos')
    expect(t.m.almacen.maxSecuencia()).toBe(antes)
    expect(t.estado.hub.turnoAbierto(t.caja.dispositivoId)?.id).toBe(t.turno)
    expect(t.cerrarCon(t.lineasDe(t.turno, t.arqueo))).toBe('confirmado')
  })

  it('el rechazo se repite igual si se reenvía', () => {
    const t = listo()
    const datos = {
      arqueo_id: t.arqueo,
      esperado_efectivo: 100_000,
      contado_efectivo: 100_000,
      diferencia: 0,
      justificacion: null,
      otros_medios: [],
    }
    const evento = t.crudo(t.caja, 'TurnoCerrado', t.turno, datos)
    expect(motivo(t.uno(t.caja, evento))).toBe('otros_medios_distintos')
    expect(motivo(t.uno(t.caja, evento))).toBe('otros_medios_distintos')
  })

  it('el orden de las reglas: el esperado en efectivo va antes que los demás medios, y estos antes que la justificación', () => {
    const t = conTarjetaYNequi(0)
    const { arqueo } = t.contar(t.caja, t.turno, 99_000, [rep('tarjeta', 1), rep('nequi', 30_000)])
    // Todo mal a la vez: el esperado en efectivo (1) y las líneas (vacías), sin justificación.
    expect(motivo(t.cerrar(t.caja, t.turno, arqueo, 1, 99_000, { otros_medios: [] }))).toBe(
      'esperado_distinto',
    )
    expect(motivo(t.cerrar(t.caja, t.turno, arqueo, 100_000, 99_000, { otros_medios: [] }))).toBe(
      'otros_medios_distintos',
    )
    expect(motivo(t.cerrar(t.caja, t.turno, arqueo, 100_000, 99_000))).toBe('falta_justificacion')
  })

  it('un pago digital después del conteo: el conteo queda desactualizado, y con uno nuevo se cierra', () => {
    const t = conTarjetaYNequi()
    const { arqueo } = t.contar(t.caja, t.turno, 100_000, [
      rep('tarjeta', 110_000),
      rep('nequi', 30_000),
    ])
    t.cobrar(t.caja, t.pedido, t.pagoNequi(t.turno, 5_000))
    expect(motivo(t.cerrar(t.caja, t.turno, arqueo, 100_000, 100_000))).toBe(
      'arqueo_desactualizado',
    )
    const otro = t.contar(t.caja, t.turno, 100_000, [rep('tarjeta', 110_000), rep('nequi', 35_000)])
    expect(motivo(t.cerrar(t.caja, t.turno, otro.arqueo, 100_000, 100_000))).toBe('confirmado')
  })

  it('con varios conteos solo vale el reporte del último', () => {
    const t = conTarjetaYNequi()
    const primero = t.contar(t.caja, t.turno, 100_000, [rep('tarjeta', 1), rep('nequi', 1)])
    const ultimo = t.contar(t.caja, t.turno, 100_000, [
      rep('tarjeta', 110_000),
      rep('nequi', 30_000),
    ])
    expect(motivo(t.cerrar(t.caja, t.turno, primero.arqueo, 100_000, 100_000))).toBe(
      'arqueo_no_es_el_ultimo',
    )
    expect(motivo(t.cerrar(t.caja, t.turno, ultimo.arqueo, 100_000, 100_000))).toBe('confirmado')
  })

  it('los reportes del arqueo con el esquema roto (efectivo, repetidos, medio propio sin id) se rechazan', () => {
    const t = conTarjetaYNequi()
    const malos: Reporte[][] = [
      [rep('efectivo', 1)],
      [rep('tarjeta', 1), rep('tarjeta', 2)],
      [rep('otro', 1, null)],
      [rep('tarjeta', 1, SODEXO)],
    ]
    for (const otros of malos)
      expect(motivo(t.contar(t.caja, t.turno, 100_000, otros).resultado)).toMatch(/^esquema:/)
  })
})

describe('falta_justificacion por un medio que no es efectivo', () => {
  /** Cuenta con `reportado` en la tarjeta (esperado 10.000) y cierra con `justificacion`. */
  function cierraCon(umbral: number, reportado: number, justificacion: string | null = null) {
    const e = entorno({ umbral })
    const turno = e.abrirTurno(e.caja, 0)
    e.cobrar(e.caja, e.abrirPedido(e.caja), e.pagoTarjeta(turno, 10_000))
    const { arqueo } = e.contar(e.caja, turno, 0, [rep('tarjeta', reportado)])
    return motivo(e.cerrar(e.caja, turno, arqueo, 0, 0, { justificacion }))
  }

  it('umbral 1.000: por debajo se cierra; desde 1.000 de faltante o de sobrante pide justificación', () => {
    expect(cierraCon(1000, 10_000)).toBe('confirmado')
    expect(cierraCon(1000, 9_999)).toBe('confirmado')
    expect(cierraCon(1000, 10_001)).toBe('confirmado')
    expect(cierraCon(1000, 9_001)).toBe('confirmado')
    expect(cierraCon(1000, 10_999)).toBe('confirmado')
    expect(cierraCon(1000, 9_000)).toBe('falta_justificacion')
    expect(cierraCon(1000, 11_000)).toBe('falta_justificacion')
    expect(cierraCon(1000, 8_999)).toBe('falta_justificacion')
    expect(cierraCon(1000, 11_001)).toBe('falta_justificacion')
    expect(cierraCon(1000, 0)).toBe('falta_justificacion')
  })

  it('con justificación se acepta aunque la diferencia sea grande', () => {
    expect(cierraCon(1000, 0, 'No llegó el cierre del datáfono')).toBe('confirmado')
    expect(cierraCon(1000, 20_000, 'Cobros de otro turno')).toBe('confirmado')
  })

  it('umbral 0: cualquier diferencia de $1 pide justificación; sin diferencia, no', () => {
    expect(cierraCon(0, 10_000)).toBe('confirmado')
    expect(cierraCon(0, 9_999)).toBe('falta_justificacion')
    expect(cierraCon(0, 10_001)).toBe('falta_justificacion')
  })

  it('umbral 2.000: el borde es inclusivo', () => {
    expect(cierraCon(2000, 8_001)).toBe('confirmado')
    expect(cierraCon(2000, 12_000)).toBe('falta_justificacion')
    expect(cierraCon(2000, 8_000)).toBe('falta_justificacion')
    expect(cierraCon(2000, 11_999)).toBe('confirmado')
  })

  it('el efectivo cuadra y la tarjeta no: igual se pide justificación', () => {
    expect(cierraCon(1000, 5_000)).toBe('falta_justificacion')
  })

  it('la tarjeta cuadra y el efectivo no cuadra por poco: por debajo del umbral no se pide', () => {
    const e = entorno()
    const turno = e.abrirTurno(e.caja, 10_000)
    e.cobrar(e.caja, e.abrirPedido(e.caja), e.pagoTarjeta(turno, 10_000))
    const { arqueo } = e.contar(e.caja, turno, 9_500, [rep('tarjeta', 10_000)])
    expect(motivo(e.cerrar(e.caja, turno, arqueo, 10_000, 9_500))).toBe('confirmado')
  })

  it('cada medio se mide aparte: dos diferencias de $600 (efectivo y tarjeta) con umbral 1.000 no piden justificación', () => {
    const e = entorno()
    const turno = e.abrirTurno(e.caja, 10_000)
    e.cobrar(e.caja, e.abrirPedido(e.caja), e.pagoTarjeta(turno, 10_000))
    const { arqueo } = e.contar(e.caja, turno, 9_400, [rep('tarjeta', 9_400)])
    expect(motivo(e.cerrar(e.caja, turno, arqueo, 10_000, 9_400))).toBe('confirmado')
  })

  it('uno de varios medios con la diferencia grande basta; un sobrante de un medio reportado sin pagos también', () => {
    const e = entorno()
    const turno = e.abrirTurno(e.caja, 0)
    e.cobrar(e.caja, e.abrirPedido(e.caja), e.pagoTarjeta(turno, 10_000))
    const { arqueo } = e.contar(e.caja, turno, 0, [rep('tarjeta', 10_000), rep('breb', 1_000)])
    expect(motivo(e.cerrar(e.caja, turno, arqueo, 0, 0))).toBe('falta_justificacion')
    const dos = e.contar(e.caja, turno, 0, [rep('tarjeta', 10_000), rep('breb', 999)])
    expect(motivo(e.cerrar(e.caja, turno, dos.arqueo, 0, 0))).toBe('confirmado')
  })

  it('lo esperado negativo (se anuló un pago de un turno anterior) y nada reportado: la diferencia es el sobrante', () => {
    const e = entorno()
    const t1 = e.abrirTurno(e.caja, 0)
    const pedido = e.abrirPedido(e.caja)
    const pago = e.cobrar(e.caja, pedido, e.pagoTarjeta(t1, 5_000))
    const a1 = e.contar(e.caja, t1, 0, [rep('tarjeta', 5_000)])
    expect(motivo(e.cerrar(e.caja, t1, a1.arqueo, 0, 0))).toBe('confirmado')
    const t2 = e.abrirTurno(e.caja, 0)
    e.anular(e.caja, pedido, pago, t2)
    const a2 = e.contar(e.caja, t2, 0, [])
    expect(e.lineasDe(t2, a2.arqueo)).toEqual([lin('tarjeta', -5_000, 0)])
    expect(motivo(e.cerrar(e.caja, t2, a2.arqueo, 0, 0))).toBe('falta_justificacion')
    expect(
      motivo(e.cerrar(e.caja, t2, a2.arqueo, 0, 0, { justificacion: 'Devolución de ayer' })),
    ).toBe('confirmado')
  })

  it('un día de solo devoluciones: el cierre dice el neto en negativo y cuadra sin justificación', () => {
    const e = entorno()
    const t1 = e.abrirTurno(e.caja, 0)
    const pedido = e.abrirPedido(e.caja)
    const pago = e.cobrar(e.caja, pedido, e.pagoTarjeta(t1, 5_000))
    const a1 = e.contar(e.caja, t1, 0, [rep('tarjeta', 5_000)])
    expect(motivo(e.cerrar(e.caja, t1, a1.arqueo, 0, 0))).toBe('confirmado')
    const t2 = e.abrirTurno(e.caja, 0)
    e.anular(e.caja, pedido, pago, t2)
    const a2 = e.contar(e.caja, t2, 0, [rep('tarjeta', -5_000)])
    expect(e.lineasDe(t2, a2.arqueo)).toEqual([lin('tarjeta', -5_000, -5_000)])
    expect(motivo(e.cerrar(e.caja, t2, a2.arqueo, 0, 0))).toBe('confirmado')
    const guardado = eventosDe(e.m)
      .filter((x) => x.tipo === 'TurnoCerrado')
      .at(-1)
    expect(guardado?.tipo === 'TurnoCerrado' && guardado.datos.otros_medios).toEqual([
      lin('tarjeta', -5_000, -5_000),
    ])
  })

  it('reportar en negativo cuando lo esperado es positivo es una diferencia grande', () => {
    expect(cierraCon(1000, -1)).toBe('falta_justificacion')
  })

  it('el umbral que vale es el vigente al cerrar', () => {
    const e = entorno({ umbral: 5_000 })
    const turno = e.abrirTurno(e.caja, 0)
    e.cobrar(e.caja, e.abrirPedido(e.caja), e.pagoTarjeta(turno, 10_000))
    const { arqueo } = e.contar(e.caja, turno, 0, [rep('tarjeta', 8_000)])
    e.cfg.umbral = 1_000
    expect(motivo(e.cerrar(e.caja, turno, arqueo, 0, 0))).toBe('falta_justificacion')
    e.cfg.umbral = 5_000
    expect(motivo(e.cerrar(e.caja, turno, arqueo, 0, 0))).toBe('confirmado')
  })

  it('un hub sin reglas de cobro usa el umbral de fábrica ($1.000) también para los demás medios', () => {
    const e = entorno()
    const sinReglas = e.m.hub()
    const conexion = conexionDe(e.m, e.caja)
    const turno = nuevoId()
    sinReglas.recibirLote(conexion, [
      e.crudo(e.caja, 'TurnoAbierto', turno, { caja_id: e.caja.dispositivoId, base: 0 }),
    ])
    const pedido = nuevoId()
    sinReglas.recibirLote(conexion, [
      e.crudo(e.caja, 'PedidoAbierto', pedido, { canal: 'salon', mesa_id: null, comensales: 1 }),
      e.crudo(e.caja, 'ItemAgregado', pedido, item(100_000)),
    ])
    expect(
      motivo(
        sinReglas.recibirLote(conexion, [
          e.crudo(e.caja, 'PagoRegistrado', pedido, e.pagoNequi(turno, 10_000)),
        ]).resultados[0],
      ),
    ).toBe('confirmado')
    const intentar = (reportado: number) => {
      const arqueo = nuevoId()
      sinReglas.recibirLote(conexion, [
        e.crudo(e.caja, 'ArqueoRegistrado', turno, {
          arqueo_id: arqueo,
          conteo: [],
          contado_efectivo: 0,
          otros: [rep('nequi', reportado)],
        }),
      ])
      return motivo(
        sinReglas.recibirLote(conexion, [
          e.crudo(e.caja, 'TurnoCerrado', turno, {
            arqueo_id: arqueo,
            esperado_efectivo: 0,
            contado_efectivo: 0,
            diferencia: 0,
            justificacion: null,
            otros_medios: [lin('nequi', 10_000, reportado)],
          }),
        ]).resultados[0],
      )
    }
    expect(intentar(9_000)).toBe('falta_justificacion')
    expect(intentar(9_001)).toBe('confirmado')
  })
})

describe('compatibilidad con la 1.7: sin pagos digitales', () => {
  it('un turno solo con efectivo se cierra sin el campo `otros_medios` y con el conteo sin `otros`', () => {
    const e = entorno()
    const turno = e.abrirTurno(e.caja, 100_000)
    e.cobrar(e.caja, e.abrirPedido(e.caja), e.pagoEf(turno, 30_000, 2_000))
    const { arqueo, resultado } = e.contar(e.caja, turno, 132_000)
    expect(motivo(resultado)).toBe('confirmado')
    expect(motivo(e.cerrar(e.caja, turno, arqueo, 132_000, 132_000, { sinCampo: true }))).toBe(
      'confirmado',
    )
    const guardado = eventosDe(e.m).find((x) => x.tipo === 'TurnoCerrado')
    expect(guardado?.tipo === 'TurnoCerrado' && guardado.datos.otros_medios).toBeUndefined()
  })

  it('un turno sin ningún pago, con `otros_medios: []` o sin el campo', () => {
    for (const sinCampo of [true, false]) {
      const e = entorno()
      const turno = e.abrirTurno(e.caja, 5_000)
      const { arqueo } = e.contar(e.caja, turno, 5_000)
      expect(motivo(e.cerrar(e.caja, turno, arqueo, 5_000, 5_000, { sinCampo }))).toBe('confirmado')
    }
  })

  it('un conteo con reportes en 0 de medios sin pagos se cierra sin el campo (todo en 0 no sale)', () => {
    const e = entorno()
    const turno = e.abrirTurno(e.caja, 0)
    const { arqueo } = e.contar(e.caja, turno, 0, [
      rep('tarjeta', 0),
      rep('nequi', 0),
      rep('otro', 0, SODEXO),
    ])
    expect(motivo(e.cerrar(e.caja, turno, arqueo, 0, 0, { sinCampo: true }))).toBe('confirmado')
  })

  it('un turno con pagos digitales anulados por completo (neto 0) se cierra sin `otros_medios`', () => {
    const e = entorno()
    const turno = e.abrirTurno(e.caja, 0)
    const pedido = e.abrirPedido(e.caja)
    const pago = e.cobrar(e.caja, pedido, e.pagoNequi(turno, 8_000, 800))
    e.anular(e.caja, pedido, pago, turno)
    const { arqueo } = e.contar(e.caja, turno, 0)
    expect(motivo(e.cerrar(e.caja, turno, arqueo, 0, 0, { sinCampo: true }))).toBe('confirmado')
  })

  it('un turno con pagos digitales y un conteo de la 1.7 (sin `otros`) no se puede cerrar sin decirlo: la diferencia es el total', () => {
    const e = entorno()
    const turno = e.abrirTurno(e.caja, 0)
    e.cobrar(e.caja, e.abrirPedido(e.caja), e.pagoNequi(turno, 8_000))
    const { arqueo } = e.contar(e.caja, turno, 0)
    expect(motivo(e.cerrar(e.caja, turno, arqueo, 0, 0, { sinCampo: true }))).toBe(
      'otros_medios_distintos',
    )
    expect(e.lineasDe(turno, arqueo)).toEqual([lin('nequi', 8_000, 0)])
    expect(motivo(e.cerrar(e.caja, turno, arqueo, 0, 0))).toBe('falta_justificacion')
    expect(
      motivo(e.cerrar(e.caja, turno, arqueo, 0, 0, { justificacion: 'Sin cierre de la app' })),
    ).toBe('confirmado')
  })
})

describe('reinicio del hub con tarjeta y Nequi a medias', () => {
  function aMedias() {
    const e = entorno()
    const turno = e.abrirTurno(e.caja, 100_000)
    const pedido = e.abrirPedido(e.caja)
    e.cobrar(e.caja, pedido, e.pagoTarjeta(turno, 100_000, 10_000))
    e.cobrar(e.caja, pedido, e.pagoNequi(turno, 30_000))
    e.cobrar(e.caja, pedido, e.pagoPropio(turno, SODEXO, 20_000))
    const { arqueo } = e.contar(e.caja, turno, 100_000, [
      rep('tarjeta', 108_000),
      rep('nequi', 30_000),
      rep('otro', 20_000, SODEXO),
    ])
    return { ...e, turno, pedido, arqueo }
  }

  it('el conteo conserva lo reportado por cada medio', () => {
    const t = aMedias()
    const antes = t.estado.hub.cuadre(t.turno)
    const despues = t.nuevoHub().cuadre(t.turno)
    expect(despues).toEqual(antes)
    expect(despues?.arqueos[0]?.otros).toEqual([
      { medio: 'tarjeta', medioPropioId: null, reportado: 108_000 },
      { medio: 'nequi', medioPropioId: null, reportado: 30_000 },
      { medio: 'otro', medioPropioId: SODEXO, reportado: 20_000 },
    ])
  })

  it('tras el reinicio, el cierre con las líneas reconstruidas se acepta y con otras se rechaza', () => {
    const t = aMedias()
    const reiniciado = t.nuevoHub()
    const lineas = t.lineasDe(t.turno, t.arqueo, reiniciado)
    expect(lineas).toEqual([
      lin('tarjeta', 110_000, 108_000),
      lin('nequi', 30_000, 30_000),
      lin('otro', 20_000, 20_000, SODEXO),
    ])
    expect(
      motivo(
        t.cerrar(t.caja, t.turno, t.arqueo, 100_000, 100_000, {
          hub: reiniciado,
          otros_medios: lineas.slice(1),
        }),
      ),
    ).toBe('otros_medios_distintos')
    expect(
      motivo(
        t.cerrar(t.caja, t.turno, t.arqueo, 100_000, 100_000, {
          hub: reiniciado,
          otros_medios: lineas,
        }),
      ),
    ).toBe('falta_justificacion')
    expect(
      motivo(
        t.cerrar(t.caja, t.turno, t.arqueo, 100_000, 100_000, {
          hub: reiniciado,
          otros_medios: lineas,
          justificacion: 'Propinas del cierre',
        }),
      ),
    ).toBe('confirmado')
    expect(reiniciado.turnoAbierto(t.caja.dispositivoId)).toBeNull()
  })

  it('un turno cerrado con otros medios sigue cerrado tras el reinicio', () => {
    const t = aMedias()
    t.cerrar(t.caja, t.turno, t.arqueo, 100_000, 100_000, { justificacion: 'Propinas del cierre' })
    const reiniciado = t.nuevoHub()
    expect(reiniciado.turnoAbierto(t.caja.dispositivoId)).toBeNull()
    expect(reiniciado.cuadre(t.turno)?.cerrado).not.toBeNull()
    expect(
      motivo(
        t.uno(
          t.caja,
          t.crudo(t.caja, 'ArqueoRegistrado', t.turno, {
            arqueo_id: nuevoId(),
            conteo: [],
            contado_efectivo: 0,
            otros: [],
          }),
          reiniciado,
        ),
      ),
    ).toBe('sin_turno')
  })

  it('un pago digital después del conteo sigue desactualizando el conteo tras el reinicio', () => {
    const t = aMedias()
    t.cobrar(t.caja, t.pedido, t.pagoNequi(t.turno, 1_000))
    const reiniciado = t.nuevoHub()
    expect(motivo(t.cerrar(t.caja, t.turno, t.arqueo, 100_000, 100_000, { hub: reiniciado }))).toBe(
      'arqueo_desactualizado',
    )
  })
})

describe('multirestaurante: los demás medios son de cada restaurante', () => {
  function dos(umbralB = 0) {
    const e = entorno()
    const otroId = nuevoId()
    e.m.db
      .prepare(
        `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
         VALUES (?, ?, ?, ?, 1, 'Otro restaurante', '{}')`,
      )
      .run(otroId, otroId, AHORA, AHORA)
    const hubB = new HubSync(new AlmacenSqlite(e.m.db, otroId), {
      restauranteId: otroId,
      zonaHoraria: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      acceso: accesoLibre,
      instancia: 'hub-b',
      reloj: e.m.red.horaIso,
      reglasCobro: () => ({ ...REGLAS, umbralDiferencia: umbralB }),
    })
    return { ...e, hubB }
  }
  const enB = (d: ReturnType<typeof dos>, tipo: string, agregado: string, datos: unknown) =>
    motivo(d.uno(d.caja, d.crudo(d.caja, tipo, agregado, datos, { secuencia_base: 0 }), d.hubB))

  it('los pagos digitales de A no cuentan en B: el mismo turno de B se cierra sin `otros_medios`', () => {
    const d = dos()
    const turnoA = d.abrirTurno(d.caja, 0)
    d.cobrar(d.caja, d.abrirPedido(d.caja), d.pagoTarjeta(turnoA, 50_000))
    const turnoB = nuevoId()
    expect(enB(d, 'TurnoAbierto', turnoB, { caja_id: d.caja.dispositivoId, base: 0 })).toBe(
      'confirmado',
    )
    const arqueoB = nuevoId()
    expect(
      enB(d, 'ArqueoRegistrado', turnoB, {
        arqueo_id: arqueoB,
        conteo: [],
        contado_efectivo: 0,
        otros: [],
      }),
    ).toBe('confirmado')
    expect(
      enB(d, 'TurnoCerrado', turnoB, {
        arqueo_id: arqueoB,
        esperado_efectivo: 0,
        contado_efectivo: 0,
        diferencia: 0,
        justificacion: null,
        otros_medios: [],
      }),
    ).toBe('confirmado')
    // El turno de A sigue abierto y su tarjeta, esperada.
    expect(d.estado.hub.turnoAbierto(d.caja.dispositivoId)?.id).toBe(turnoA)
    expect(d.estado.hub.cuadre(turnoA)?.porMedio).toMatchObject([
      { medio: 'tarjeta', venta: 50_000 },
    ])
  })

  it('el cierre de A con sus líneas no sirve en B (sin_turno) y cada uno cuadra con lo suyo', () => {
    const d = dos(1000)
    const turnoA = d.abrirTurno(d.caja, 0)
    d.cobrar(d.caja, d.abrirPedido(d.caja), d.pagoTarjeta(turnoA, 50_000))
    const a = d.contar(d.caja, turnoA, 0, [rep('tarjeta', 50_000)])
    expect(
      enB(d, 'TurnoCerrado', turnoA, {
        arqueo_id: a.arqueo,
        esperado_efectivo: 0,
        contado_efectivo: 0,
        diferencia: 0,
        justificacion: null,
        otros_medios: d.lineasDe(turnoA, a.arqueo),
      }),
    ).toBe('sin_turno')

    const turnoB = nuevoId()
    enB(d, 'TurnoAbierto', turnoB, { caja_id: d.caja.dispositivoId, base: 0 })
    const pedidoB = d.abrirPedido(d.caja, 1_000_000, d.hubB)
    d.cobrar(d.caja, pedidoB, d.pagoNequi(turnoB, 7_000), d.hubB)
    const arqueoB = nuevoId()
    enB(d, 'ArqueoRegistrado', turnoB, {
      arqueo_id: arqueoB,
      conteo: [],
      contado_efectivo: 0,
      otros: [rep('nequi', 7_000)],
    })
    expect(d.lineasDe(turnoB, arqueoB, d.hubB)).toEqual([lin('nequi', 7_000, 7_000)])
    expect(motivo(d.cerrar(d.caja, turnoA, a.arqueo, 0, 0))).toBe('confirmado')
    expect(d.estado.hub.turnoAbierto(d.caja.dispositivoId)).toBeNull()
    // El de B sigue abierto hasta que se cierra con lo suyo.
    expect(d.hubB.turnoAbierto(d.caja.dispositivoId)?.id).toBe(turnoB)
    expect(motivo(d.cerrar(d.caja, turnoB, arqueoB, 0, 0, { hub: d.hubB }))).toBe('confirmado')
  })

  it('el umbral es de cada restaurante: una diferencia de $500 en la tarjeta se cierra en A (1.000) y no en B (0)', () => {
    const d = dos(0)
    const turnoA = d.abrirTurno(d.caja, 0)
    d.cobrar(d.caja, d.abrirPedido(d.caja), d.pagoTarjeta(turnoA, 10_000))
    const a = d.contar(d.caja, turnoA, 0, [rep('tarjeta', 9_500)])
    expect(motivo(d.cerrar(d.caja, turnoA, a.arqueo, 0, 0))).toBe('confirmado')

    const turnoB = nuevoId()
    enB(d, 'TurnoAbierto', turnoB, { caja_id: d.caja.dispositivoId, base: 0 })
    const pedidoB = d.abrirPedido(d.caja, 1_000_000, d.hubB)
    d.cobrar(d.caja, pedidoB, d.pagoTarjeta(turnoB, 10_000), d.hubB)
    const b = d.contar(d.caja, turnoB, 0, [rep('tarjeta', 9_500)], d.hubB)
    expect(motivo(d.cerrar(d.caja, turnoB, b.arqueo, 0, 0, { hub: d.hubB }))).toBe(
      'falta_justificacion',
    )
  })
})

describe('con la red simulada: la caja cierra con tarjeta y Nequi sin conexión', () => {
  /** La caja cobra, cuenta con los reportes y cierra, todo guardado en el dispositivo. */
  async function cajaCierra(caja: Nodo, m: Montaje, opciones: { reportadoTarjeta?: number } = {}) {
    const turno = nuevoId()
    const pedido = nuevoId()
    const arqueo = nuevoId()
    const turnoCaja = { agregado_tipo: 'turno_caja' } as never
    const pago = (medio: 'tarjeta' | 'nequi', monto: number, propina = 0) => ({
      pago_id: nuevoId(),
      cuenta_id: null,
      turno_caja_id: turno,
      medio,
      monto,
      propina,
      recibido: null,
      cambio: null,
      ajuste_redondeo: 0,
      redondeo: null,
      datafono: null,
      referencia_cobro: null,
    })
    await caja.crear(
      turno,
      'TurnoAbierto',
      { caja_id: caja.dispositivoId, base: 10_000 },
      turnoCaja,
    )
    await caja.crear(pedido, 'PedidoAbierto', { canal: 'salon', mesa_id: null, comensales: 2 })
    await caja.crear(pedido, 'ItemAgregado', item(1_000_000))
    await caja.crear(pedido, 'PagoRegistrado', pago('nequi', 30_000, 3_000))
    const reportado = opciones.reportadoTarjeta ?? 33_000
    await caja.crear(
      turno,
      'ArqueoRegistrado',
      {
        arqueo_id: arqueo,
        conteo: [{ valor: 10_000, cantidad: 1 }],
        contado_efectivo: 10_000,
        otros: [{ medio: 'nequi', medio_propio_id: null, reportado }],
      },
      turnoCaja,
    )
    await caja.crear(
      turno,
      'TurnoCerrado',
      {
        arqueo_id: arqueo,
        esperado_efectivo: 10_000,
        contado_efectivo: 10_000,
        diferencia: 0,
        justificacion: reportado === 33_000 ? null : 'No cuadró Nequi',
        otros_medios: [
          {
            medio: 'nequi',
            medio_propio_id: null,
            esperado: 33_000,
            reportado,
            diferencia: reportado - 33_000,
          },
        ],
      },
      turnoCaja,
    )
    expect(m).toBeDefined()
    return turno
  }
  const tipos = (m: Montaje) => eventosDe(m).map((x) => x.tipo)
  const SEIS = [
    'TurnoAbierto',
    'PedidoAbierto',
    'ItemAgregado',
    'PagoRegistrado',
    'ArqueoRegistrado',
    'TurnoCerrado',
  ]

  it('todo sin conexión: al reconectar se confirman en orden y el turno queda cerrado', async () => {
    const m = montar()
    const caja = m.red.dispositivo('caja')
    await cajaCierra(caja, m)
    expect(await caja.cliente.pendientes()).toBe(6)
    await m.red.conectarTodos()
    expect(tipos(m)).toEqual(SEIS)
    expect(m.hub().turnoAbierto(caja.dispositivoId)).toBeNull()
    expect(await caja.cliente.pendientes()).toBe(0)
  })

  it('un lote duplicado por la red no repite el cierre', async () => {
    const m = montar()
    const caja = m.red.dispositivo('caja')
    await m.red.conectarTodos()
    caja.regla('al_hub', 'empujar', 'duplicar', 6)
    await cajaCierra(caja, m)
    await m.red.estabilizar()
    expect(tipos(m)).toEqual(SEIS)
  })

  it('el hub se apaga justo al guardar el cierre: el turno vuelve abierto y el cierre llega una sola vez', async () => {
    const m = montar()
    const caja = m.red.dispositivo('caja')
    await m.red.conectarTodos()
    if (m.almacen instanceof AlmacenQueSeCae) m.almacen.caerEn = 6
    await cajaCierra(caja, m)
    await m.red.estabilizar()
    await m.red.conectarTodos()
    await m.red.estabilizar()
    expect(tipos(m).filter((x) => x === 'TurnoCerrado')).toHaveLength(1)
    expect(m.hub().turnoAbierto(caja.dispositivoId)).toBeNull()
  })

  it('el hub se apaga al guardar el conteo con los reportes: al volver, el arqueo y el cierre se completan', async () => {
    const m = montar()
    const caja = m.red.dispositivo('caja')
    await m.red.conectarTodos()
    if (m.almacen instanceof AlmacenQueSeCae) m.almacen.caerEn = 5
    await cajaCierra(caja, m)
    await m.red.estabilizar()
    await m.red.conectarTodos()
    await m.red.estabilizar()
    expect(tipos(m)).toEqual(SEIS)
  })

  it('con el reloj de la caja 3 horas atrasado o un día adelantado el cierre se acepta igual', async () => {
    for (const desfase of [-3 * 60 * 60 * 1000, 24 * 60 * 60 * 1000]) {
      const m = montar()
      const caja = m.red.dispositivo('caja')
      caja.desfaseMs = desfase
      await m.red.conectarTodos()
      await cajaCierra(caja, m)
      await m.red.estabilizar()
      expect(tipos(m)).toEqual(SEIS)
      expect(m.hub().turnoAbierto(caja.dispositivoId)).toBeNull()
    }
  })

  it('un cierre con un reporte distinto y justificación, offline, se acepta al reconectar', async () => {
    const m = montar()
    const caja = m.red.dispositivo('caja')
    await cajaCierra(caja, m, { reportadoTarjeta: 20_000 })
    await m.red.conectarTodos()
    expect(tipos(m)).toEqual(SEIS)
  })
})
