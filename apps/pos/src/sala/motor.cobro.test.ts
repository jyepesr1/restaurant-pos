import 'fake-indexeddb/auto'
import { firmarEvento, nuevoId, totalesPedido } from '@pos/core'
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
  enPartesIguales,
  pagoEnEfectivo,
  type ReglasCobro,
  resumenTurno,
  turnoDeCaja,
} from './cuentas'
import { type Equipo, Sala, type Sesion } from './motor'
import { pedidosAbiertos } from './proyeccion'
import { catalogoDePrueba, datosItem } from './pruebas'

// De punta a punta, en memoria: la caja (motor + IndexedDB) habla con un hub de memoria con las
// reglas de cobro. Abrir turno → dividir → dos pagos (efectivo y tarjeta) → cerrar el pedido. Los
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
  const db = new BaseDispositivo(`cobro-${nuevoId()}`)
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
const estadoDe = async (s: Sala, id: string) =>
  pedidosAbiertos(await locales(s)).find((p) => p.estado.id === id)?.estado ?? null
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

describe('de punta a punta: abrir turno → dividir → efectivo y tarjeta → cerrar', () => {
  it('todo se confirma, el pedido queda cerrado y el resumen del turno cuadra', async () => {
    const h = montarHub()
    const { sala, e } = await caja(h)
    const turno = await sala.abrirTurno(200_000)
    await hasta(() => sinPendientes(sala))
    expect(h.hub.turnoAbierto(e.dispositivoId)).toMatchObject({ id: turno, base: 200_000 })

    const pedido = await pedidoDeCien(sala)
    const estado = await estadoDe(sala, pedido)
    if (!estado) throw new Error('sin pedido')
    const cuentas = enPartesIguales(estado, 2, REGLAS, nuevoId)
    expect(cuentas.map((c) => c.monto)).toEqual([50_025, 50_025])
    await sala.registrar('CuentaDividida', pedido, { cuentas })
    await hasta(() => sinPendientes(sala))

    // Cuenta 1 en efectivo: 50.025 se cobra a 50.000 (−25) con la propina redondeada.
    const p1 = datosPago(turno, cuentas[0]?.cuenta_id as string, 'efectivo', 50_025, 4_600, 60_000)
    expect(p1).toMatchObject({ ajuste_redondeo: -25, cambio: 5_400 })
    const r1 = await resolver(sala.registrarConfirmado('PagoRegistrado', pedido, p1))
    expect(r1.ok).toBe(true)

    // Cuenta 2 con tarjeta.
    const p2 = datosPago(turno, cuentas[1]?.cuenta_id as string, 'tarjeta', 50_025, 4_629)
    const r2 = await resolver(sala.registrarConfirmado('PagoRegistrado', pedido, p2))
    expect(r2.ok).toBe(true)

    const cierre = await resolver(sala.registrarConfirmado('PedidoCerrado', pedido, {}))
    expect(cierre.ok).toBe(true)
    await hasta(() => sinPendientes(sala))

    const cerrado = h.hub.pedido(pedido)
    expect(cerrado?.estado).toBe('cerrado')
    expect(totalesPedido(cerrado as never)).toMatchObject({
      saldo: 0,
      pagado: 100_050,
      ajustes: -25,
      propinas: 9_229,
    })
    // El pedido ya no está abierto en la caja y todo lo guardado aquí está confirmado.
    expect(await estadoDe(sala, pedido)).toBeNull()
    const guardados = await locales(sala)
    expect(guardados.every((l) => l.estado === 'confirmado')).toBe(true)
    expect(guardados.map((l) => l.evento.tipo)).toEqual([
      'TurnoAbierto',
      'PedidoAbierto',
      'ItemAgregado',
      'ItemAgregado',
      'CuentaDividida',
      'PagoRegistrado',
      'PagoRegistrado',
      'PedidoCerrado',
    ])
    const resumen = resumenTurno(guardados, turno)
    expect(resumen.pagos).toBe(2)
    expect(resumen.porMedio).toEqual([
      { medio: 'efectivo', medioPropioId: null, venta: 50_000, propina: 4_600, pagos: 1 },
      { medio: 'tarjeta', medioPropioId: null, venta: 50_025, propina: 4_629, pagos: 1 },
    ])
    expect(turnoDeCaja(guardados, e.dispositivoId)).toMatchObject({
      id: turno,
      porConfirmar: false,
    })
  })

  it('cerrar con saldo pendiente: el hub lo rechaza y registrarConfirmado lanza el motivo en palabras', async () => {
    const h = montarHub()
    const { sala } = await caja(h)
    const turno = await sala.abrirTurno(0)
    const pedido = await pedidoDeCien(sala)
    const parcial = datosPago(turno, null, 'nequi', 100_050, 0)
    const r = await resolver(
      sala.registrarConfirmado('PagoRegistrado', pedido, { ...parcial, monto: 50_000 }),
    )
    expect(r.ok).toBe(true)
    const cierre = await resolver(sala.registrarConfirmado('PedidoCerrado', pedido, {}))
    expect(cierre).toMatchObject({ ok: false })
    expect((cierre as { error: Error }).error.message).toBe(
      'Todavía queda saldo: alguien agregó algo mientras cobrabas.',
    )
    expect(h.hub.pedido(pedido)?.estado).toBe('abierto')
  })

  it('cobrar sin turno abierto: el hub lo rechaza con «sin_turno» dicho en palabras y el pago desaparece', async () => {
    const h = montarHub()
    const { sala } = await caja(h)
    const pedido = await pedidoDeCien(sala)
    const falso = nuevoId()
    const r = await resolver(
      sala.registrarConfirmado(
        'PagoRegistrado',
        pedido,
        datosPago(falso, null, 'nequi', 100_050, 0),
      ),
    )
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: Error }).error.message).toBe(
      'La caja no tiene turno abierto: ábrela en «Caja».',
    )
    expect(Object.keys((await estadoDe(sala, pedido))?.pagos ?? {})).toEqual([])
  })

  it('un segundo turno de la misma caja se rechaza (turno_ya_abierto) y el primero sigue', async () => {
    const h = montarHub()
    const { sala, e } = await caja(h)
    const primero = await sala.abrirTurno(100)
    await hasta(() => sinPendientes(sala))
    await sala.abrirTurno(999)
    await hasta(() => sinPendientes(sala))
    expect(h.hub.turnoAbierto(e.dispositivoId)).toMatchObject({ id: primero, base: 100 })
    const rechazados = (await locales(sala)).filter((l) => l.estado === 'rechazado')
    expect(rechazados).toHaveLength(1)
    expect(rechazados[0]?.motivo).toBe('turno_ya_abierto')
    expect(turnoDeCaja(await locales(sala), e.dispositivoId)?.id).toBe(primero)
  })

  it('una tarjeta con un datáfono que ya no existe se rechaza con su mensaje', async () => {
    const h = montarHub()
    const { sala } = await caja(h)
    const turno = await sala.abrirTurno(0)
    const pedido = await pedidoDeCien(sala)
    const pago = datosPago(turno, null, 'tarjeta', 100_050, 0)
    const r = await resolver(
      sala.registrarConfirmado('PagoRegistrado', pedido, {
        ...pago,
        datafono: { ...(pago.datafono as object), datafono_id: nuevoId() } as never,
      }),
    )
    expect((r as { error: Error }).error.message).toBe('Ese datáfono ya no está: elige otro.')
  })

  it('el mismo pago reenviado (mismo pago_id) no se cobra dos veces', async () => {
    const h = montarHub()
    const { sala } = await caja(h)
    const turno = await sala.abrirTurno(0)
    const pedido = await pedidoDeCien(sala)
    const parcial = { ...datosPago(turno, null, 'nequi', 100_050, 0), monto: 30_000 }
    await resolver(sala.registrarConfirmado('PagoRegistrado', pedido, parcial))
    const otra = await resolver(sala.registrarConfirmado('PagoRegistrado', pedido, parcial))
    expect(otra).toMatchObject({ ok: false })
    expect(Object.keys(h.hub.pedido(pedido)?.pagos ?? {})).toHaveLength(1)
    expect(totalesPedido(h.hub.pedido(pedido) as never).pagado).toBe(30_000)
  })

  it('sin que el hub conteste, registrarConfirmado falla diciendo que quedó pendiente (no cobrar otra vez)', async () => {
    const h = montarHub()
    const { sala } = await caja(h)
    const turno = await sala.abrirTurno(0)
    const pedido = await pedidoDeCien(sala)
    sala.simularSinConexion(true)
    const r = await resolver(
      sala.registrarConfirmado(
        'PagoRegistrado',
        pedido,
        datosPago(turno, null, 'nequi', 100_050, 0),
      ),
    )
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: Error }).error.message).toMatch(/Quedó pendiente/)
    // Se guardó aquí: al volver la conexión llega al hub una sola vez.
    sala.simularSinConexion(false)
    await hasta(() => sinPendientes(sala))
    expect(Object.keys(h.hub.pedido(pedido)?.pagos ?? {})).toHaveLength(1)
  })
})
