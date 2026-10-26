import 'fake-indexeddb/auto'
import { cuadreDeOtrosMedios, firmarEvento, nuevoId } from '@pos/core'
import {
  AlmacenMemoria,
  type Canal,
  type ControlAcceso,
  HubSync,
  type Manejadores,
  type MensajeDispositivo,
  SalaSync,
} from '@pos/sync'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import { conSigno, mediosDelCierre } from './Caja'
import { cuadreDeCaja, type ReglasCobro, resumenTurno, turnoDeCaja } from './cuentas'
import { type Equipo, Sala, type Sesion } from './motor'
import { catalogoDePrueba, datosItem } from './pruebas'

// De punta a punta, en memoria (tarea 1.8): la caja (motor + IndexedDB) habla con un hub de memoria
// con las reglas de cobro. Abrir turno → cobro con tarjeta y Nequi → conteo con los cierres del
// datáfono y de la app → cierre confirmado; y con un reporte distinto, que pide justificación. El
// cierre se arma como lo hace la pantalla de la caja (`mediosDelCierre`, `conSigno`,
// `cuadreDeOtrosMedios`). Los temporizadores son falsos: nada espera de verdad.

const T0 = new Date('2026-10-26T15:00:00.000Z')
const SODEXO = nuevoId()
const REGLAS: ReglasCobro = {
  mediosPago: ['efectivo', 'tarjeta', 'nequi'],
  mediosPropios: [{ id: SODEXO, nombre: 'Sodexo' }],
  propinaSugerida: 1000,
  redondeoModo: 'mitad_arriba',
  redondeoEfectivo: 100,
  redondeoEfectivoModo: 'cercano_mitad_abajo',
  imprimePrecuenta: false,
}
const DATAFONO = nuevoId()
const CATALOGO = catalogoDePrueba({
  datafonos: [{ id: DATAFONO, nombre: 'Datáfono 1', proveedor: 'bold' }],
})

const accesoConFirma: ControlAcceso = {
  verificar: (_c, evento) =>
    evento.sesion_id && evento.firma === firmarEvento(evento, `secreto-${evento.sesion_id}`)
      ? { ok: true, autorizadoPorId: null, autorizacionId: null }
      : { ok: false, motivo: 'firma_invalida' },
  registrarUso: () => {},
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    now: T0,
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  )
})

async function asentar(vueltas = 4) {
  for (let i = 0; i < vueltas; i++) await new Promise((r) => setImmediate(r))
}
async function avanzar(ms: number) {
  for (let t = 0; t < ms; t += 100) {
    await vi.advanceTimersByTimeAsync(Math.min(100, ms - t))
    await asentar(3)
  }
}
async function hasta(condicion: () => Promise<boolean> | boolean, maxMs = 20_000) {
  for (let t = 0; t <= maxMs; t += 100) {
    if (await condicion()) return
    await avanzar(100)
  }
  throw new Error('No se cumplió en el tiempo simulado')
}
/** Deja correr el reloj simulado hasta que la promesa termine (bien o mal). */
async function resolver<T>(
  promesa: Promise<T>,
): Promise<{ ok: true; valor: T } | { ok: false; error: Error }> {
  let r: { ok: true; valor: T } | { ok: false; error: Error } | null = null
  promesa.then(
    (valor) => {
      r = { ok: true, valor }
    },
    (error) => {
      r = { ok: false, error }
    },
  )
  await hasta(() => r !== null)
  return r as never
}

function montarHub() {
  const tokens = new Map<string, Equipo>()
  const hub = new HubSync(new AlmacenMemoria(), {
    restauranteId: nuevoId(),
    zonaHoraria: 'America/Bogota',
    inicioDiaOperativo: '06:00',
    instancia: 'hub-prueba',
    reloj: () => new Date(Date.now()).toISOString(),
    acceso: accesoConFirma,
    reglasCobro: () => ({
      multiplo: 100,
      modo: 'cercano_mitad_abajo',
      medios: REGLAS.mediosPago,
      mediosPropios: [SODEXO],
      datafonos: [DATAFONO],
      umbralDiferencia: 1000,
    }),
  })
  const salaHub = new SalaSync(hub, (token) => {
    const e = tokens.get(token)
    return e ? { dispositivoId: e.dispositivoId, tipo: e.tipo, revocadoEn: null } : null
  })
  const h = {
    hub,
    tokens,
    recibidos: [] as MensajeDispositivo[],
    abrir(m: Manejadores): Canal {
      let enlace: ReturnType<SalaSync['conectar']> | null = null
      let cerrado = false
      setTimeout(() => {
        if (cerrado) return
        enlace = salaHub.conectar((msg) => {
          const copia = JSON.parse(JSON.stringify(msg))
          setTimeout(() => {
            if (!cerrado) m.alMensaje(copia)
          })
        })
        m.alAbrir()
      })
      return {
        enviar: (msg) => {
          if (!enlace || cerrado) return
          const copia = JSON.parse(JSON.stringify(msg)) as MensajeDispositivo
          h.recibidos.push(copia)
          enlace.recibir(copia)
        },
        cerrar: () => {
          cerrado = true
          enlace?.cerrar()
          enlace = null
        },
      }
    },
  }
  return h
}
type Hub = ReturnType<typeof montarHub>

const salas: Sala[] = []
const bases: BaseDispositivo[] = []
afterEach(async () => {
  for (const s of salas.splice(0)) s.simularSinConexion(true)
  await asentar(10)
  vi.useRealTimers()
  await asentar(10)
  for (const b of bases.splice(0)) await b.delete()
  vi.unstubAllGlobals()
})

async function caja(h: Hub, nombre = 'Caja 1') {
  const db = new BaseDispositivo(`cierre-${nuevoId()}`)
  bases.push(db)
  const e: Equipo = { dispositivoId: nuevoId(), token: nuevoId(), nombre, tipo: 'caja' }
  h.tokens.set(e.token, e)
  const sesionId = nuevoId()
  const sesion: Sesion = {
    sesionId,
    secreto: `secreto-${sesionId}`,
    usuario: { id: nuevoId(), nombre: 'Carlos', rol: 'Cajero' },
    permisos: [
      'tomar_pedido',
      'registrar_pago',
      'cerrar_mesa',
      'dividir_cuenta',
      'abrir_turno_caja',
      'movimiento_caja',
      'cerrar_turno_caja',
    ],
    ultimoUso: Date.now(),
  }
  await db.guardarAjuste('equipo', e)
  await db.guardarAjuste('sesion', sesion)
  await db.guardarAjuste('catalogo', CATALOGO)
  const sala = new Sala({ db, abrir: (m) => h.abrir(m) })
  salas.push(sala)
  await sala.cargar()
  await hasta(() => sala.instantanea().conexion === 'conectado')
  return { sala, e }
}

const locales = async (s: Sala) => (await s.sync?.locales()) ?? []
const sinPendientes = (s: Sala) => s.instantanea().pendientes === 0

/** Un pedido de dos productos que suma $100.050, ya en el hub. */
async function pedidoDeCien(sala: Sala) {
  const pedido = nuevoId()
  await sala.registrar('PedidoAbierto', pedido, { canal: 'salon', mesa_id: null, comensales: 2 })
  await sala.registrar(
    'ItemAgregado',
    pedido,
    datosItem({ precio_unitario: 60_050, nombre: 'Tagliata' }),
  )
  await sala.registrar(
    'ItemAgregado',
    pedido,
    datosItem({ precio_unitario: 40_000, nombre: 'Pizza' }),
  )
  await hasta(() => sinPendientes(sala))
  return pedido
}

const conteoDe = (contado: number) =>
  [
    { valor: 100_000, cantidad: Math.floor(contado / 100_000) },
    { valor: 50, cantidad: (contado % 100_000) / 50 },
  ].filter((c) => c.cantidad > 0)

const mensaje = (r: { ok: boolean }) => (r as unknown as { error: Error }).error.message

/** Un pago parcial de `monto` con el medio dado, sin redondeo: tarjeta (con datáfono), Nequi o Sodexo. */
const pago = (
  turno: string,
  medio: 'tarjeta' | 'nequi' | 'propio',
  monto: number,
  propina = 0,
) => ({
  pago_id: nuevoId(),
  cuenta_id: null,
  turno_caja_id: turno,
  medio: medio === 'propio' ? ('otro' as const) : medio,
  ...(medio === 'propio' ? { medio_propio_id: SODEXO } : {}),
  monto,
  propina,
  recibido: null,
  cambio: null,
  ajuste_redondeo: 0,
  redondeo: null,
  datafono:
    medio === 'tarjeta'
      ? {
          datafono_id: DATAFONO,
          franquicia: null,
          ultimos4: null,
          aprobacion: null,
          recibo: null,
          tipo_tarjeta: 'credito' as const,
        }
      : null,
  referencia_cobro: null,
})

/** Un turno con $50.000 de base y un pedido de $100.050 cobrado con tarjeta (60.050 + 6.000) y Nequi. */
async function turnoCobrado(h: Hub) {
  const { sala, e } = await caja(h)
  const turno = await sala.abrirTurno(50_000)
  const pedido = await pedidoDeCien(sala)
  expect(
    (
      await resolver(
        sala.registrarConfirmado('PagoRegistrado', pedido, pago(turno, 'tarjeta', 60_050, 6_000)),
      )
    ).ok,
  ).toBe(true)
  expect(
    (
      await resolver(
        sala.registrarConfirmado('PagoRegistrado', pedido, pago(turno, 'nequi', 40_000)),
      )
    ).ok,
  ).toBe(true)
  await hasta(() => sinPendientes(sala))
  return { sala, e, turno, pedido }
}

/**
 * Lo que hace la pantalla del cierre: arma los medios, lee lo escrito, guarda el conteo y cierra
 * con las líneas que salen del conteo. Devuelve el resultado de cada paso.
 */
async function cerrarComoCaja(
  sala: Sala,
  turno: string,
  contado: number,
  escrito: Record<string, string>,
  justificacion: string | null = null,
) {
  const guardados = await locales(sala)
  const cuadre = cuadreDeCaja(guardados, turno)
  if (!cuadre) throw new Error('Sin cuadre')
  const medios = mediosDelCierre(REGLAS, cuadre, CATALOGO)
  const reportados = medios.map((m) => ({
    medio: m.medio,
    medio_propio_id: m.medioPropioId,
    reportado: conSigno(escrito[m.clave] ?? ''),
  }))
  const arqueo = nuevoId()
  const conteo = await resolver(
    sala.registrarConfirmado('ArqueoRegistrado', turno, {
      arqueo_id: arqueo,
      conteo: conteoDe(contado),
      contado_efectivo: contado,
      otros: reportados,
    }),
  )
  const otros = cuadreDeOtrosMedios(cuadre, {
    id: arqueo,
    conteo: [],
    contado,
    otros: reportados.map((r) => ({
      medio: r.medio,
      medioPropioId: r.medio_propio_id,
      reportado: r.reportado,
    })),
    hora: '',
  })
  const cierre = await resolver(
    sala.registrarConfirmado('TurnoCerrado', turno, {
      arqueo_id: arqueo,
      esperado_efectivo: cuadre.efectivo.esperado,
      contado_efectivo: contado,
      diferencia: contado - cuadre.efectivo.esperado,
      justificacion,
      otros_medios: otros.map((o) => ({
        medio: o.medio,
        medio_propio_id: o.medioPropioId,
        esperado: o.esperado,
        reportado: o.reportado,
        diferencia: o.diferencia,
      })),
    }),
  )
  return { conteo, cierre, otros, arqueo, medios, cuadre }
}

describe('de punta a punta (1.8): abrir turno → cobro con tarjeta y Nequi → conteo con los cierres → cierre', () => {
  it('con los cierres que coinciden: se confirma, queda guardado y el turno se cierra', async () => {
    const h = montarHub()
    const { sala, e, turno } = await turnoCobrado(h)

    // La caja y el hub ven lo mismo antes de cerrar.
    const antes = cuadreDeCaja(await locales(sala), turno)
    expect(antes?.porMedio).toEqual([
      { medio: 'tarjeta', medioPropioId: null, venta: 60_050, propina: 6_000, pagos: 1 },
      { medio: 'nequi', medioPropioId: null, venta: 40_000, propina: 0, pagos: 1 },
    ])
    expect(h.hub.cuadre(turno)).toEqual(antes)

    const r = await cerrarComoCaja(sala, turno, 50_000, {
      'tarjeta:': '66.050',
      'nequi:': '40.000',
    })
    expect(r.medios.map((m) => m.clave)).toEqual(['tarjeta:', 'nequi:', `otro:${SODEXO}`])
    expect(r.conteo.ok).toBe(true)
    expect(r.cierre.ok).toBe(true)
    expect(r.otros).toEqual([
      { medio: 'tarjeta', medioPropioId: null, esperado: 66_050, reportado: 66_050, diferencia: 0 },
      { medio: 'nequi', medioPropioId: null, esperado: 40_000, reportado: 40_000, diferencia: 0 },
    ])
    await hasta(() => sinPendientes(sala))

    expect(h.hub.turnoAbierto(e.dispositivoId)).toBeNull()
    const guardados = await locales(sala)
    expect(guardados.every((l) => l.estado === 'confirmado')).toBe(true)
    expect(turnoDeCaja(guardados, e.dispositivoId)).toBeNull()
    expect(cuadreDeCaja(guardados, turno)?.cerrado).toMatchObject({
      esperado: 50_000,
      contado: 50_000,
      diferencia: 0,
      otrosMedios: r.otros,
    })
    expect(
      resumenTurno(guardados, turno).porMedio.map((m) => [m.medio, m.venta + m.propina]),
    ).toEqual([
      ['tarjeta', 66_050],
      ['nequi', 40_000],
    ])
  })

  it('el Sodexo sin cobros y sin escribir no cuenta: el cierre lo omite', async () => {
    const h = montarHub()
    const { sala, turno } = await turnoCobrado(h)
    const r = await cerrarComoCaja(sala, turno, 50_000, {
      'tarjeta:': '66.050',
      'nequi:': '40.000',
    })
    expect(r.otros.map((o) => o.medio)).toEqual(['tarjeta', 'nequi'])
    expect(r.cierre.ok).toBe(true)
  })

  it('con un reporte distinto: el hub pide justificación y con ella cierra', async () => {
    const h = montarHub()
    const { sala, e, turno } = await turnoCobrado(h)
    const sin = await cerrarComoCaja(sala, turno, 50_000, {
      'tarjeta:': '66.050',
      'nequi:': '35.000',
    })
    expect(sin.otros.find((o) => o.medio === 'nequi')).toMatchObject({
      esperado: 40_000,
      reportado: 35_000,
      diferencia: -5_000,
    })
    expect(sin.cierre.ok).toBe(false)
    expect(mensaje(sin.cierre)).toBe('Escribe por qué no cuadra la caja.')
    // El turno sigue abierto aquí y en el hub; el cierre rechazado queda a la vista.
    expect(h.hub.turnoAbierto(e.dispositivoId)).not.toBeNull()
    let guardados = await locales(sala)
    expect(turnoDeCaja(guardados, e.dispositivoId)?.id).toBe(turno)
    expect(guardados.filter((l) => l.estado === 'rechazado').map((l) => l.motivo)).toEqual([
      'falta_justificacion',
    ])

    // Con el mismo conteo y una justificación.
    const arqueo = sin.arqueo
    const con = await resolver(
      sala.registrarConfirmado('TurnoCerrado', turno, {
        arqueo_id: arqueo,
        esperado_efectivo: 50_000,
        contado_efectivo: 50_000,
        diferencia: 0,
        justificacion: 'Nequi no mostró un pago de $5.000',
        otros_medios: sin.otros.map((o) => ({
          medio: o.medio,
          medio_propio_id: o.medioPropioId,
          esperado: o.esperado,
          reportado: o.reportado,
          diferencia: o.diferencia,
        })),
      }),
    )
    expect(con.ok).toBe(true)
    await hasta(() => sinPendientes(sala))
    guardados = await locales(sala)
    expect(turnoDeCaja(guardados, e.dispositivoId)).toBeNull()
    expect(cuadreDeCaja(guardados, turno)?.cerrado).toMatchObject({
      justificacion: 'Nequi no mostró un pago de $5.000',
      otrosMedios: [
        { medio: 'tarjeta', diferencia: 0 },
        { medio: 'nequi', esperado: 40_000, reportado: 35_000, diferencia: -5_000 },
      ],
    })
  })

  it('por debajo del umbral ($999 de diferencia en la tarjeta) se cierra sin justificación', async () => {
    const h = montarHub()
    const { sala, e, turno } = await turnoCobrado(h)
    const r = await cerrarComoCaja(sala, turno, 50_000, {
      'tarjeta:': '65.051',
      'nequi:': '40.000',
    })
    expect(r.cierre.ok).toBe(true)
    expect(h.hub.turnoAbierto(e.dispositivoId)).toBeNull()
  })

  it('un medio propio (Sodexo) con cobro y con lo escrito distinto', async () => {
    const h = montarHub()
    const { sala, e } = await caja(h)
    const turno = await sala.abrirTurno(0)
    const pedido = await pedidoDeCien(sala)
    expect(
      (
        await resolver(
          sala.registrarConfirmado('PagoRegistrado', pedido, pago(turno, 'propio', 30_000)),
        )
      ).ok,
    ).toBe(true)
    const r = await cerrarComoCaja(sala, turno, 0, { [`otro:${SODEXO}`]: '30.000' })
    expect(r.cierre.ok).toBe(true)
    expect(r.otros).toEqual([
      { medio: 'otro', medioPropioId: SODEXO, esperado: 30_000, reportado: 30_000, diferencia: 0 },
    ])
    expect(h.hub.turnoAbierto(e.dispositivoId)).toBeNull()
  })

  it('un reporte escrito para un medio sin cobros (un cobro que no se registró): sobrante que pide justificación', async () => {
    const h = montarHub()
    const { sala, turno } = await turnoCobrado(h)
    const r = await cerrarComoCaja(sala, turno, 50_000, {
      'tarjeta:': '66.050',
      'nequi:': '40.000',
      [`otro:${SODEXO}`]: '12.000',
    })
    expect(r.otros.at(-1)).toMatchObject({
      medio: 'otro',
      esperado: 0,
      reportado: 12_000,
      diferencia: 12_000,
    })
    expect(mensaje(r.cierre)).toBe('Escribe por qué no cuadra la caja.')
  })

  it('un cierre con las líneas de otro conteo (desactualizadas): otros_medios_distintos, dicho en palabras', async () => {
    const h = montarHub()
    const { sala, e, turno } = await turnoCobrado(h)
    const arqueo = nuevoId()
    await resolver(
      sala.registrarConfirmado('ArqueoRegistrado', turno, {
        arqueo_id: arqueo,
        conteo: conteoDe(50_000),
        contado_efectivo: 50_000,
        otros: [
          { medio: 'tarjeta', medio_propio_id: null, reportado: 66_050 },
          { medio: 'nequi', medio_propio_id: null, reportado: 40_000 },
        ],
      }),
    )
    const r = await resolver(
      sala.registrarConfirmado('TurnoCerrado', turno, {
        arqueo_id: arqueo,
        esperado_efectivo: 50_000,
        contado_efectivo: 50_000,
        diferencia: 0,
        justificacion: null,
        otros_medios: [],
      }),
    )
    expect(mensaje(r)).toBe(
      'Los demás medios no coinciden con lo que registró la caja: recarga la app (puede estar desactualizada) y vuelve a contar.',
    )
    expect(h.hub.turnoAbierto(e.dispositivoId)).not.toBeNull()
  })

  it('un cobro con Nequi después del conteo desactualiza el cierre: se dice en palabras y, al volver a contar, cierra', async () => {
    const h = montarHub()
    const { sala, e, turno } = await turnoCobrado(h)
    const viejo = await cerrarComoCaja(
      sala,
      turno,
      50_000,
      { 'tarjeta:': '66.050', 'nequi:': '40.000' },
      null,
    )
    // Ese cierre se aceptó; para probar el desfase se arma otro turno.
    expect(viejo.cierre.ok).toBe(true)

    const t2 = await sala.abrirTurno(0)
    const pedido = await pedidoDeCien(sala)
    expect(
      (
        await resolver(
          sala.registrarConfirmado('PagoRegistrado', pedido, pago(t2, 'nequi', 10_000)),
        )
      ).ok,
    ).toBe(true)
    const arqueo = nuevoId()
    await resolver(
      sala.registrarConfirmado('ArqueoRegistrado', t2, {
        arqueo_id: arqueo,
        conteo: [],
        contado_efectivo: 0,
        otros: [{ medio: 'nequi', medio_propio_id: null, reportado: 10_000 }],
      }),
    )
    expect(
      (await resolver(sala.registrarConfirmado('PagoRegistrado', pedido, pago(t2, 'nequi', 5_000))))
        .ok,
    ).toBe(true)
    const tarde = await resolver(
      sala.registrarConfirmado('TurnoCerrado', t2, {
        arqueo_id: arqueo,
        esperado_efectivo: 0,
        contado_efectivo: 0,
        diferencia: 0,
        justificacion: null,
        otros_medios: [
          {
            medio: 'nequi',
            medio_propio_id: null,
            esperado: 10_000,
            reportado: 10_000,
            diferencia: 0,
          },
        ],
      }),
    )
    expect(mensaje(tarde)).toBe('Hubo pagos o movimientos después del conteo: vuelve a contar.')
    expect(h.hub.turnoAbierto(e.dispositivoId)?.id).toBe(t2)
    const otra = await cerrarComoCaja(sala, t2, 0, { 'nequi:': '15.000', 'tarjeta:': '' })
    expect(otra.cierre.ok).toBe(true)
    expect(h.hub.turnoAbierto(e.dispositivoId)).toBeNull()
  })
})
