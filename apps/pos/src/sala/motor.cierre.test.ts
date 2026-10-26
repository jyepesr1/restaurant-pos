import 'fake-indexeddb/auto'
import { firmarEvento, nuevoId } from '@pos/core'
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
import {
  cuadreDeCaja,
  pagoEnEfectivo,
  type ReglasCobro,
  resumenTurno,
  turnoDeCaja,
} from './cuentas'
import { type Equipo, Sala, type Sesion } from './motor'
import { catalogoDePrueba, datosItem } from './pruebas'

// De punta a punta, en memoria (tarea 1.7): la caja (motor + IndexedDB) habla con un hub de memoria
// con las reglas de cobro. Abrir turno → cobro en efectivo → entrada → pago de propinas → arqueo →
// cierre confirmado → turno nuevo; y los cierres que el hub rechaza, dichos en palabras. Los
// temporizadores son falsos: nada espera de verdad.

const T0 = new Date('2026-10-26T15:00:00.000Z')
const REGLAS: ReglasCobro = {
  mediosPago: ['efectivo', 'tarjeta', 'nequi'],
  propinaSugerida: 1000,
  redondeoModo: 'mitad_arriba',
  redondeoEfectivo: 100,
  redondeoEfectivoModo: 'cercano_mitad_abajo',
  imprimePrecuenta: false,
}
const DATAFONO = nuevoId()

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
  await db.guardarAjuste('catalogo', catalogoDePrueba())
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

const datosPago = (
  turno: string,
  cuentaId: string | null,
  medio: 'efectivo' | 'tarjeta' | 'nequi',
  saldo: number,
  propina: number,
  recibido = 0,
) => {
  const c = pagoEnEfectivo({ saldo, monto: saldo, propina, recibido }, REGLAS)
  const entregado = recibido || c.aEntregar
  const f = pagoEnEfectivo({ saldo, monto: saldo, propina, recibido: entregado }, REGLAS)
  return {
    pago_id: nuevoId(),
    cuenta_id: cuentaId,
    turno_caja_id: turno,
    medio,
    monto: saldo,
    propina,
    recibido: medio === 'efectivo' ? entregado : null,
    cambio: medio === 'efectivo' ? f.cambio : null,
    ajuste_redondeo: medio === 'efectivo' ? f.ajuste : 0,
    redondeo: medio === 'efectivo' ? f.redondeo : null,
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
  }
}

const HOY = '2026-10-26'

/** Un cobro en efectivo del pedido de $100.050: se cobran 100.000 (−50) y 5.000 de propina. */
const cobroEfectivo = (turno: string) => datosPago(turno, null, 'efectivo', 100_050, 5_000, 105_000)

const conteoDe = (contado: number) =>
  [
    { valor: 100_000, cantidad: Math.floor(contado / 100_000) },
    { valor: 50, cantidad: (contado % 100_000) / 50 },
  ].filter((c) => c.cantidad > 0)

async function contar(sala: Sala, turno: string, contado: number) {
  const arqueo = nuevoId()
  const r = await resolver(
    sala.registrarConfirmado('ArqueoRegistrado', turno, {
      arqueo_id: arqueo,
      conteo: conteoDe(contado),
      contado_efectivo: contado,
    }),
  )
  return { arqueo, r }
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

const mensaje = (r: { ok: boolean }) => (r as unknown as { error: Error }).error.message

describe('de punta a punta: abrir turno → cobro → entrada → propinas → arqueo → cierre → turno nuevo', () => {
  it('todo se confirma, el turno se cierra con diferencia 0 y la caja abre otro', async () => {
    const h = montarHub()
    const { sala, e } = await caja(h)
    const turno = await sala.abrirTurno(200_000)
    await hasta(() => sinPendientes(sala))

    const pedido = await pedidoDeCien(sala)
    const pago = cobroEfectivo(turno)
    expect(pago).toMatchObject({ ajuste_redondeo: -50, cambio: 0, recibido: 105_000 })
    expect((await resolver(sala.registrarConfirmado('PagoRegistrado', pedido, pago))).ok).toBe(true)
    expect((await resolver(sala.registrarConfirmado('PedidoCerrado', pedido, {}))).ok).toBe(true)

    const entrada = await resolver(
      sala.registrarConfirmado('MovimientoCajaRegistrado', turno, {
        movimiento_id: nuevoId(),
        tipo: 'entrada',
        monto: 20_000,
        descripcion: 'Cambio para el turno',
        a_quien: null,
        dias: [],
      }),
    )
    expect(entrada.ok).toBe(true)
    const propinas = await resolver(
      sala.registrarConfirmado('MovimientoCajaRegistrado', turno, {
        movimiento_id: nuevoId(),
        tipo: 'pago_propinas',
        monto: 5_000,
        descripcion: 'Propinas de hoy',
        a_quien: 'Equipo de sala',
        dias: [HOY],
      }),
    )
    expect(propinas.ok).toBe(true)

    // 200.000 + (100.000 + 5.000) + 20.000 − 5.000 = 320.000, en la caja y en el hub.
    const antes = cuadreDeCaja(await locales(sala), turno)
    expect(antes?.efectivo).toMatchObject({
      cobrado: 105_000,
      entradas: 20_000,
      pagosPropinas: 5_000,
      esperado: 320_000,
    })
    expect(h.hub.cuadre(turno)).toEqual(antes)

    const { arqueo, r: conteo } = await contar(sala, turno, 320_000)
    expect(conteo.ok).toBe(true)
    const cierre = await resolver(
      sala.registrarConfirmado('TurnoCerrado', turno, datosCierre(arqueo, 320_000, 320_000)),
    )
    expect(cierre.ok).toBe(true)
    await hasta(() => sinPendientes(sala))

    // Cerrado en el hub y en la caja; lo guardado aquí está confirmado.
    expect(h.hub.turnoAbierto(e.dispositivoId)).toBeNull()
    const guardados = await locales(sala)
    expect(guardados.every((l) => l.estado === 'confirmado')).toBe(true)
    expect(turnoDeCaja(guardados, e.dispositivoId)).toBeNull()
    expect(cuadreDeCaja(guardados, turno)?.cerrado).toMatchObject({
      esperado: 320_000,
      contado: 320_000,
      diferencia: 0,
    })
    expect(resumenTurno(guardados, turno).porMedio).toEqual([
      { medio: 'efectivo', medioPropioId: null, venta: 100_000, propina: 5_000, pagos: 1 },
    ])

    // Un pago más a ese turno ya no entra, y se dice en palabras.
    const otroPedido = await pedidoDeCien(sala)
    const tarde = await resolver(
      sala.registrarConfirmado(
        'PagoRegistrado',
        otroPedido,
        datosPago(turno, null, 'nequi', 100_050, 0),
      ),
    )
    expect(mensaje(tarde)).toBe('La caja no tiene turno abierto: ábrela en «Caja».')

    // El turno nuevo empieza de cero.
    const nuevo = await sala.abrirTurno(50_000)
    await hasta(() => sinPendientes(sala))
    expect(h.hub.turnoAbierto(e.dispositivoId)).toMatchObject({ id: nuevo, base: 50_000 })
    const despues = await locales(sala)
    expect(turnoDeCaja(despues, e.dispositivoId)).toMatchObject({ id: nuevo, base: 50_000 })
    expect(cuadreDeCaja(despues, nuevo)).toMatchObject({
      efectivo: { cobrado: 0, entradas: 0, esperado: 50_000 },
      porMedio: [],
      arqueos: [],
      cerrado: null,
    })
  })

  it('un faltante de $1.000 o más sin justificación lo rechaza el hub y con ella se cierra', async () => {
    const h = montarHub()
    const { sala, e } = await caja(h)
    const turno = await sala.abrirTurno(100_000)
    const { arqueo } = await contar(sala, turno, 98_000)
    const sin = await resolver(
      sala.registrarConfirmado('TurnoCerrado', turno, datosCierre(arqueo, 100_000, 98_000)),
    )
    expect(mensaje(sin)).toBe('Escribe por qué no cuadra la caja.')
    // El turno sigue abierto aquí y en el hub, y el cierre rechazado queda a la vista.
    expect(h.hub.turnoAbierto(e.dispositivoId)).not.toBeNull()
    const guardados = await locales(sala)
    expect(turnoDeCaja(guardados, e.dispositivoId)?.id).toBe(turno)
    expect(guardados.filter((l) => l.estado === 'rechazado').map((l) => l.motivo)).toEqual([
      'falta_justificacion',
    ])
    const con = await resolver(
      sala.registrarConfirmado(
        'TurnoCerrado',
        turno,
        datosCierre(arqueo, 100_000, 98_000, 'Se pagó un domicilio'),
      ),
    )
    expect(con.ok).toBe(true)
    expect(turnoDeCaja(await locales(sala), e.dispositivoId)).toBeNull()
  })

  it('un faltante por debajo del umbral ($999) se cierra sin justificación', async () => {
    const h = montarHub()
    const { sala, e } = await caja(h)
    const turno = await sala.abrirTurno(100_000)
    const { arqueo } = await contar(sala, turno, 99_050)
    const r = await resolver(
      sala.registrarConfirmado('TurnoCerrado', turno, datosCierre(arqueo, 100_000, 99_050)),
    )
    expect(r.ok).toBe(true)
    expect(h.hub.turnoAbierto(e.dispositivoId)).toBeNull()
  })
})

describe('el cierre rechazado, con el motivo en palabras', () => {
  /** Turno con un cobro en efectivo (esperado 305.000: base 200.000 + 105.000) y un conteo. */
  async function listo() {
    const h = montarHub()
    const { sala, e } = await caja(h)
    const turno = await sala.abrirTurno(200_000)
    const pedido = await pedidoDeCien(sala)
    await resolver(sala.registrarConfirmado('PagoRegistrado', pedido, cobroEfectivo(turno)))
    const { arqueo } = await contar(sala, turno, 305_000)
    return { h, sala, e, turno, arqueo }
  }

  it('con un esperado viejo (sin la propina): esperado_distinto', async () => {
    const t = await listo()
    const r = await resolver(
      t.sala.registrarConfirmado(
        'TurnoCerrado',
        t.turno,
        datosCierre(t.arqueo, 300_000, 305_000, 'x'),
      ),
    )
    expect(mensaje(r)).toBe(
      'La caja registró algo que este equipo aún no tenía: espera un momento y vuelve a contar.',
    )
    expect(t.h.hub.turnoAbierto(t.e.dispositivoId)).not.toBeNull()
    expect(turnoDeCaja(await locales(t.sala), t.e.dispositivoId)?.id).toBe(t.turno)
  })

  it('con un conteo que no existe: arqueo_inexistente', async () => {
    const t = await listo()
    const r = await resolver(
      t.sala.registrarConfirmado('TurnoCerrado', t.turno, datosCierre(nuevoId(), 305_000, 305_000)),
    )
    expect(mensaje(r)).toBe('La caja no tiene ese conteo: vuelve a contar.')
  })

  it('con un contado distinto del conteo: contado_distinto', async () => {
    const t = await listo()
    const r = await resolver(
      t.sala.registrarConfirmado(
        'TurnoCerrado',
        t.turno,
        datosCierre(t.arqueo, 305_000, 300_000, 'x'),
      ),
    )
    expect(mensaje(r)).toBe('Lo contado no coincide con el conteo guardado: vuelve a contar.')
  })

  it('con un conteo que no es el último: arqueo_no_es_el_ultimo', async () => {
    const t = await listo()
    await contar(t.sala, t.turno, 305_000)
    const r = await resolver(
      t.sala.registrarConfirmado('TurnoCerrado', t.turno, datosCierre(t.arqueo, 305_000, 305_000)),
    )
    expect(mensaje(r)).toBe('La caja se cierra con el último conteo: vuelve a contar.')
  })

  it('con dinero movido después del conteo: arqueo_desactualizado', async () => {
    const t = await listo()
    await resolver(
      t.sala.registrarConfirmado('MovimientoCajaRegistrado', t.turno, {
        movimiento_id: nuevoId(),
        tipo: 'salida',
        monto: 5_000,
        descripcion: 'Hielo',
        a_quien: null,
        dias: [],
      }),
    )
    const r = await resolver(
      t.sala.registrarConfirmado(
        'TurnoCerrado',
        t.turno,
        datosCierre(t.arqueo, 300_000, 305_000, 'x'),
      ),
    )
    expect(mensaje(r)).toBe('Hubo pagos o movimientos después del conteo: vuelve a contar.')
    // Volviendo a contar, cierra.
    const nuevo = await contar(t.sala, t.turno, 300_000)
    const ok = await resolver(
      t.sala.registrarConfirmado(
        'TurnoCerrado',
        t.turno,
        datosCierre(nuevo.arqueo, 300_000, 300_000),
      ),
    )
    expect(ok.ok).toBe(true)
  })

  it('un movimiento o un conteo sin turno abierto: sin_turno', async () => {
    const h = montarHub()
    const { sala } = await caja(h)
    const turno = nuevoId()
    const m = await resolver(
      sala.registrarConfirmado('MovimientoCajaRegistrado', turno, {
        movimiento_id: nuevoId(),
        tipo: 'entrada',
        monto: 1_000,
        descripcion: 'x',
        a_quien: null,
        dias: [],
      }),
    )
    expect(mensaje(m)).toBe('La caja no tiene turno abierto: ábrela en «Caja».')
    expect(mensaje((await contar(sala, turno, 1_000)).r)).toBe(
      'La caja no tiene turno abierto: ábrela en «Caja».',
    )
  })

  it('el movimiento rechazado desaparece del cuadre de la caja', async () => {
    const t = await listo()
    const otra = await caja(t.h, 'Caja 2')
    // La otra caja intenta mover efectivo en el turno de esta.
    const r = await resolver(
      otra.sala.registrarConfirmado('MovimientoCajaRegistrado', t.turno, {
        movimiento_id: nuevoId(),
        tipo: 'entrada',
        monto: 1_000,
        descripcion: 'x',
        a_quien: null,
        dias: [],
      }),
    )
    expect(mensaje(r)).toBe('Ese turno es de otra caja: cobra desde la caja donde se abrió.')
    expect(t.h.hub.cuadre(t.turno)?.efectivo.entradas).toBe(0)
  })
})

describe('sin conexión', () => {
  it('el cierre queda pendiente: el turno sigue abierto aquí hasta que el hub lo acepta', async () => {
    const h = montarHub()
    const { sala, e } = await caja(h)
    const turno = await sala.abrirTurno(10_000)
    await hasta(() => sinPendientes(sala))
    const { arqueo } = await contar(sala, turno, 10_000)

    sala.simularSinConexion(true)
    const r = await resolver(
      sala.registrarConfirmado('TurnoCerrado', turno, datosCierre(arqueo, 10_000, 10_000)),
    )
    expect(mensaje(r)).toMatch(/Quedó pendiente/)
    const pendiente = await locales(sala)
    expect(pendiente.at(-1)).toMatchObject({ estado: 'pendiente' })
    expect(turnoDeCaja(pendiente, e.dispositivoId)?.id).toBe(turno)
    expect(h.hub.turnoAbierto(e.dispositivoId)).not.toBeNull()

    sala.simularSinConexion(false)
    await hasta(() => sinPendientes(sala))
    expect(h.hub.turnoAbierto(e.dispositivoId)).toBeNull()
    expect(turnoDeCaja(await locales(sala), e.dispositivoId)).toBeNull()
    // Llegó una sola vez.
    const cierres = (await locales(sala)).filter((l) => l.evento.tipo === 'TurnoCerrado')
    expect(cierres).toHaveLength(1)
  })

  it('un movimiento hecho sin conexión suma al cuadre local al guardarse y se confirma al volver', async () => {
    const h = montarHub()
    const { sala } = await caja(h)
    const turno = await sala.abrirTurno(10_000)
    await hasta(() => sinPendientes(sala))
    sala.simularSinConexion(true)
    await sala.registrar('MovimientoCajaRegistrado', turno, {
      movimiento_id: nuevoId(),
      tipo: 'salida',
      monto: 3_000,
      descripcion: 'Taxi',
      a_quien: null,
      dias: [],
    })
    expect(cuadreDeCaja(await locales(sala), turno)?.efectivo.esperado).toBe(7_000)
    expect(h.hub.cuadre(turno)?.efectivo.esperado).toBe(10_000)
    sala.simularSinConexion(false)
    await hasta(() => sinPendientes(sala))
    expect(h.hub.cuadre(turno)?.efectivo.esperado).toBe(7_000)
  })
})
