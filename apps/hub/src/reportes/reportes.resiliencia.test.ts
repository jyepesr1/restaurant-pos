import { type EventoPedido, nuevoId } from '@pos/core'
import type { CierreZ } from '@pos/printing'
import { AlmacenSqlite } from '@pos/sync/sqlite'
import { describe, expect, it, vi } from 'vitest'
import { copiaItem, evento, pagoEfectivo } from '../../../../packages/core/src/pruebas/fabrica'
import { INICIO } from '../acceso/montaje'
import { item } from '../acceso/montaje-hub'
import { trabajosDeEvento } from '../impresion/comandas'
import { type Equipo, montarImpresion } from '../impresion/montaje-impresion'

// El cierre Z y las rutas de reportes cuando algo sale mal (tarea 1.9): el mismo cierre reenviado,
// el hub que se reinicia, sin impresora o con una que no sirve, otro restaurante en la misma base,
// los dos anchos de papel, los permisos y las fechas que no son fechas.

function mundo(opciones: { ancho?: 58 | 80; conImpresora?: boolean } = {}) {
  const t = montarImpresion()
  const ana = t.equipo('mesero')
  const admin = t.equipo('admin', 'caja')
  const cajero = t.equipo('cajero', 'caja')
  const impresora = t.impresoraNueva('Caja', [], opciones.ancho ? { ancho: opciones.ancho } : {})
  const elegir = (id: string | null) =>
    t.db
      .prepare('UPDATE restaurante SET config = ? WHERE id = ?')
      .run(JSON.stringify(id ? { impresora_precuenta_id: id } : {}), t.restauranteId)
  if (opciones.conImpresora !== false) elegir(impresora.id)

  /** Abre un turno, cobra un pedido y deja el turno listo para cerrar (sin cerrarlo). */
  const turnoCobrado = (caja: Equipo, precio = 40_000, propina = 4_000, base = 100_000) => {
    const turno = nuevoId()
    caja.mandar(
      turno,
      'TurnoAbierto',
      { caja_id: caja.conexion.dispositivoId, base },
      { agregado_tipo: 'turno_caja' },
    )
    const vender = (monto: number, tip: number) => {
      const pedido = t.abrir(ana)
      ana.mandar(pedido, 'ItemAgregado', { ...item(), precio_unitario: monto })
      const pago = {
        pago_id: nuevoId(),
        cuenta_id: null,
        turno_caja_id: turno,
        medio: 'efectivo',
        monto,
        propina: tip,
        recibido: monto + tip,
        cambio: 0,
        ajuste_redondeo: 0,
        redondeo: { multiplo: 100, modo: 'cercano_mitad_abajo' },
        datafono: null,
        referencia_cobro: null,
      }
      expect(caja.mandar(pedido, 'PagoRegistrado', pago).estado).toBe('confirmado')
      expect(caja.mandar(pedido, 'PedidoCerrado', {}).estado).toBe('confirmado')
      return pedido
    }
    vender(precio, propina)
    return { turno, vender, esperado: base + precio + propina }
  }

  /** Cierra el turno enviando el evento a mano (así se puede reenviar tal cual). */
  const cerrarConEvento = (caja: Equipo, turno: string, esperado: number) => {
    const arqueo = nuevoId()
    caja.mandar(
      turno,
      'ArqueoRegistrado',
      {
        arqueo_id: arqueo,
        conteo: [{ valor: 1_000, cantidad: esperado / 1_000 }],
        contado_efectivo: esperado,
      },
      { agregado_tipo: 'turno_caja' },
    )
    const crudo = t.evento(
      caja.conexion,
      caja.sesion,
      'TurnoCerrado',
      {
        arqueo_id: arqueo,
        esperado_efectivo: esperado,
        contado_efectivo: esperado,
        diferencia: 0,
        justificacion: null,
        otros_medios: [],
      },
      { agregado_id: turno, agregado_tipo: 'turno_caja', secuencia_base: 0 } as never,
    )
    return crudo
  }

  const cierresZ = () => t.trabajos("WHERE tipo = 'informe'").map((f) => t.contenido(f) as CierreZ)
  return { t, ana, admin, cajero, impresora, elegir, turnoCobrado, cerrarConEvento, cierresZ }
}

const maxSecuencia = (t: ReturnType<typeof montarImpresion>) =>
  Number(
    t.db
      .prepare('SELECT coalesce(max(secuencia), 0) AS s FROM evento WHERE restaurante_id = ?')
      .get(t.restauranteId)?.s,
  )

describe('cierre Z: una sola vez', () => {
  it('el TurnoCerrado reenviado (mismo evento) no crea otro cierre Z', () => {
    const { t, admin, turnoCobrado, cerrarConEvento, cierresZ } = mundo()
    const x = turnoCobrado(admin)
    const crudo = {
      ...cerrarConEvento(admin, x.turno, x.esperado),
      secuencia_base: maxSecuencia(t),
    }
    const primero = t.hub.recibirLote(admin.conexion, [crudo as never])
    expect(primero.resultados[0]?.estado).toBe('confirmado')
    expect(cierresZ()).toHaveLength(1)
    const otra = t.hub.recibirLote(admin.conexion, [crudo as never])
    // El reenvío no es un evento nuevo: no se guarda otra vez ni dispara el gancho.
    expect(otra.aceptados).toEqual([])
    expect(cierresZ()).toHaveLength(1)
    expect(t.fallosGuardar).toEqual([])
  })

  it('entregar el mismo evento al gancho dos veces, o desde un hub reiniciado, deja un solo trabajo', () => {
    const { t, admin, turnoCobrado, cerrarConEvento, cierresZ } = mundo()
    const x = turnoCobrado(admin)
    const crudo = {
      ...cerrarConEvento(admin, x.turno, x.esperado),
      secuencia_base: maxSecuencia(t),
    }
    const r = t.hub.recibirLote(admin.conexion, [crudo as never])
    const aceptado = r.aceptados[0] as EventoPedido
    expect(trabajosDeEvento(t.opcionesComandas, aceptado, [])).toBe(1)
    expect(trabajosDeEvento(t.opcionesComandas, aceptado, [])).toBe(1)
    const reiniciado = t.crearHub()
    reiniciado.recibirLote(admin.conexion, [crudo as never])
    expect(trabajosDeEvento(t.opcionesComandas, aceptado, [])).toBe(1)
    expect(cierresZ()).toHaveLength(1)
    expect(t.trabajos("WHERE tipo = 'informe'")).toHaveLength(1)
  })

  it('con dos turnos cerrados salen dos cierres Z, cada uno con lo suyo', () => {
    const { t, admin, turnoCobrado, cerrarConEvento, cierresZ } = mundo()
    const a = turnoCobrado(admin, 40_000, 4_000)
    const ca = { ...cerrarConEvento(admin, a.turno, a.esperado), secuencia_base: maxSecuencia(t) }
    expect(t.hub.recibirLote(admin.conexion, [ca as never]).resultados[0]?.estado).toBe(
      'confirmado',
    )
    const b = turnoCobrado(admin, 10_000, 0, 20_000)
    const cb = { ...cerrarConEvento(admin, b.turno, b.esperado), secuencia_base: maxSecuencia(t) }
    expect(t.hub.recibirLote(admin.conexion, [cb as never]).resultados[0]?.estado).toBe(
      'confirmado',
    )
    const z = cierresZ()
    expect(z).toHaveLength(2)
    expect(z.map((x) => x.efectivo.base)).toEqual([100_000, 20_000])
    expect(z.map((x) => x.efectivo.esperado)).toEqual([a.esperado, b.esperado])
  })
})

describe('cierre Z: sin impresora o con una que no sirve', () => {
  const cerrar = (m: ReturnType<typeof mundo>) => {
    const x = m.turnoCobrado(m.admin)
    const crudo = {
      ...m.cerrarConEvento(m.admin, x.turno, x.esperado),
      secuencia_base: maxSecuencia(m.t),
    }
    return { x, r: m.t.hub.recibirLote(m.admin.conexion, [crudo as never]) }
  }

  it('sin impresora elegida no se crea nada y el cierre se acepta; la reimpresión pide elegirla', async () => {
    const m = mundo({ conImpresora: false })
    const { x, r } = cerrar(m)
    expect(r.resultados[0]?.estado).toBe('confirmado')
    expect(m.cierresZ()).toEqual([])
    expect(m.t.fallosGuardar).toEqual([])
    const rep = await m.t.post(
      '/api/reportes/cierre-z',
      { ...m.admin.cuerpoSesion, turno_id: x.turno },
      m.admin.token,
    )
    expect(rep.statusCode).toBe(409)
    expect(m.cierresZ()).toEqual([])
    // Elegida la impresora después, ya se puede reimprimir.
    m.elegir(m.impresora.id)
    const otra = await m.t.post(
      '/api/reportes/cierre-z',
      { ...m.admin.cuerpoSesion, turno_id: x.turno },
      m.admin.token,
    )
    expect(otra.statusCode).toBe(204)
    expect(m.cierresZ()).toHaveLength(1)
  })

  it('con una impresora archivada o que no existe tampoco se crea nada, y el cierre se acepta', () => {
    const archivada = mundo()
    archivada.t.db
      .prepare('UPDATE impresora SET activo = 0 WHERE id = ?')
      .run(archivada.impresora.id)
    expect(cerrar(archivada).r.resultados[0]?.estado).toBe('confirmado')
    expect(archivada.cierresZ()).toEqual([])

    const fantasma = mundo()
    fantasma.elegir(nuevoId())
    expect(cerrar(fantasma).r.resultados[0]?.estado).toBe('confirmado')
    expect(fantasma.cierresZ()).toEqual([])
  })

  it('si armar el cierre falla, el cierre de caja se acepta igual y el error se registra', () => {
    const m = mundo()
    // Una configuración que no se puede leer: el cierre de caja nunca debe quedar a medias por esto.
    m.t.db.prepare('UPDATE restaurante SET config = ? WHERE id = ?').run('[1,2]', m.t.restauranteId)
    const registro = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { r } = cerrar(m)
      expect(r.resultados[0]?.estado).toBe('confirmado')
      expect(m.cierresZ()).toEqual([])
    } finally {
      registro.mockRestore()
    }
    // El turno quedó cerrado de verdad.
    expect(m.t.hub.turnoAbierto(m.admin.conexion.dispositivoId)).toBeNull()
  })

  it('la impresora apagada deja el cierre Z pendiente, con su nombre, y sale al volver', async () => {
    const m = mundo()
    m.impresora.papel.apagada = true
    const { x } = cerrar(m)
    await m.t.cola.vuelta()
    expect(m.impresora.papel.recibidos).toHaveLength(0)
    const lista = await m.t.post(
      '/api/impresion/pendientes',
      { ...m.admin.cuerpoSesion },
      m.admin.token,
    )
    expect(lista.json().map((p: { que: string }) => p.que)).toEqual(['Cierre de caja'])
    // Una reimpresión mientras sigue apagada.
    await m.t.post(
      '/api/reportes/cierre-z',
      { ...m.admin.cuerpoSesion, turno_id: x.turno },
      m.admin.token,
    )
    await m.t.cola.listo()
    const dos = await m.t.post(
      '/api/impresion/pendientes',
      { ...m.admin.cuerpoSesion },
      m.admin.token,
    )
    expect(dos.json().map((p: { que: string }) => p.que)).toEqual([
      'Cierre de caja',
      'Cierre de caja (reimpresión)',
    ])
    m.impresora.papel.apagada = false
    m.t.avanzar(60 * 60 * 1000)
    m.t.cola.despertar()
    await m.t.cola.listo()
    expect(m.impresora.papel.textos()).toHaveLength(2)
    expect(m.t.pendientes()).toBe(0)
  })
})

describe('reimpresión del cierre Z', () => {
  it('cada reimpresión es un trabajo nuevo marcado, con las mismas cifras que el original', async () => {
    const m = mundo()
    const x = m.turnoCobrado(m.admin, 55_000, 5_000)
    const crudo = {
      ...m.cerrarConEvento(m.admin, x.turno, x.esperado),
      secuencia_base: maxSecuencia(m.t),
    }
    m.t.hub.recibirLote(m.admin.conexion, [crudo as never])
    for (let i = 0; i < 3; i++) {
      const r = await m.t.post(
        '/api/reportes/cierre-z',
        { ...m.admin.cuerpoSesion, turno_id: x.turno },
        m.admin.token,
      )
      expect(r.statusCode).toBe(204)
    }
    const z = m.cierresZ()
    expect(z).toHaveLength(4)
    expect(z.filter((c) => c.reimpreso === null)).toHaveLength(1)
    expect(z.filter((c) => c.reimpreso !== null)).toHaveLength(3)
    const { reimpreso: _a, ...original } = z.find((c) => c.reimpreso === null) as CierreZ
    for (const c of z.filter((c) => c.reimpreso !== null)) {
      const { reimpreso: _b, ...resto } = c
      expect(resto).toEqual(original)
    }
    await m.t.cola.vuelta()
    const papel = m.impresora.papel.textos()
    expect(papel).toHaveLength(4)
    expect(papel.filter((p) => p.includes('Reimpresión'))).toHaveLength(3)
    // La reimpresión del turno de otro día no cambia al agregar ventas después.
    expect(papel.every((p) => p.includes('CIERRE DE CAJA'))).toBe(true)
  })

  it('un turno abierto da 404 y no deja nada en la cola', async () => {
    const m = mundo()
    const caja = m.admin
    const turno = nuevoId()
    caja.mandar(
      turno,
      'TurnoAbierto',
      { caja_id: caja.conexion.dispositivoId, base: 1_000 },
      { agregado_tipo: 'turno_caja' },
    )
    const r = await m.t.post(
      '/api/reportes/cierre-z',
      { ...caja.cuerpoSesion, turno_id: turno },
      caja.token,
    )
    expect(r.statusCode).toBe(404)
    expect(m.cierresZ()).toEqual([])
  })
})

describe('papel de 58 y de 80 mm', () => {
  it.each([58, 80] as const)('el cierre Z en %i mm sale sin líneas que se pasen', async (ancho) => {
    const m = mundo({ ancho })
    const x = m.turnoCobrado(m.admin, 5_000_000, 500_000, 9_999_000)
    // Tanto dinero cabe: el contado se cuadra con el esperado.
    const crudo = {
      ...m.cerrarConEvento(m.admin, x.turno, x.esperado),
      secuencia_base: maxSecuencia(m.t),
    }
    expect(m.t.hub.recibirLote(m.admin.conexion, [crudo as never]).resultados[0]?.estado).toBe(
      'confirmado',
    )
    await m.t.cola.vuelta()
    const [papel] = m.impresora.papel.textos()
    expect(papel).toContain('CIERRE DE CAJA')
    const columnas = ancho === 58 ? 32 : 48
    for (const linea of (papel ?? '').split('\n'))
      expect(linea.length).toBeLessThanOrEqual(columnas)
  })
})

describe('otro restaurante en la misma base', () => {
  /** Un segundo restaurante con un turno ya cerrado y una venta, el mismo día operativo. */
  function otroRestaurante(t: ReturnType<typeof montarImpresion>) {
    const otro = nuevoId()
    const ahora = '2026-10-24T20:00:00.000Z'
    t.db
      .prepare(
        `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
         VALUES (?, ?, ?, ?, 1, 'Otro restaurante', '{}')`,
      )
      .run(otro, otro, ahora, ahora)
    const almacen = new AlmacenSqlite(t.db, otro)
    const turno = nuevoId()
    const pedido = nuevoId()
    const crudo = (tipo: string, agregado: string, tipoAgregado: string, datos: unknown) => ({
      id: nuevoId(),
      tipo,
      version_esquema: 1,
      agregado_tipo: tipoAgregado,
      agregado_id: agregado,
      relacionados: [],
      datos,
      sesion_id: null,
      usuario_id: nuevoId(),
      dispositivo_id: nuevoId(),
      autorizacion_id: null,
      motivo: null,
      hora_dispositivo: ahora,
      hora_estimada_hub: ahora,
      secuencia_base: 0,
      recibido_en: ahora,
      dia_operativo: '2026-10-24',
      asignaciones: {},
      afecta: [],
      autorizado_por_id: null,
    })
    const arqueo = nuevoId()
    const it = copiaItem({ precio_unitario: 99_000 })
    const pago = pagoEfectivo(99_000, { turno_caja_id: turno })
    const base = [
      crudo('TurnoAbierto', turno, 'turno_caja', { caja_id: nuevoId(), base: 1 }),
      evento(pedido, 'PedidoAbierto', { canal: 'salon', mesa_id: nuevoId(), comensales: 9 }),
      evento(pedido, 'ItemAgregado', it),
      evento(pedido, 'PagoRegistrado', pago),
      evento(pedido, 'PedidoCerrado', {}, { dia_operativo: '2026-10-24' }),
      crudo('ArqueoRegistrado', turno, 'turno_caja', {
        arqueo_id: arqueo,
        conteo: [{ valor: 1_000, cantidad: 99 }],
        contado_efectivo: 99_000,
      }),
      crudo('TurnoCerrado', turno, 'turno_caja', {
        arqueo_id: arqueo,
        esperado_efectivo: 99_001,
        contado_efectivo: 99_000,
        diferencia: -1,
        justificacion: 'Del otro restaurante',
        otros_medios: [],
      }),
    ]
    for (const [i, e] of base.entries())
      almacen.guardarEvento(
        { ...e, secuencia: i + 1, recibido_en: ahora } as unknown as EventoPedido,
        `h${i}`,
        [e.agregado_id],
      )
    return { otro, turno, pedido }
  }

  it('el informe no suma ventas ni cierres de otro restaurante, y su cierre Z no se reimprime', async () => {
    const m = mundo()
    const propio = m.turnoCobrado(m.admin)
    const crudo = {
      ...m.cerrarConEvento(m.admin, propio.turno, propio.esperado),
      secuencia_base: maxSecuencia(m.t),
    }
    m.t.hub.recibirLote(m.admin.conexion, [crudo as never])
    const otro = otroRestaurante(m.t)
    const r = await m.t.post(
      '/api/reportes',
      { ...m.admin.cuerpoSesion, desde: '2026-10-24', hasta: '2026-10-24' },
      m.admin.token,
    )
    const cuerpo = r.json()
    expect(cuerpo.informe.ventas).toMatchObject({ neto: 40_000, cuentas: 1, comensales: 2 })
    expect(cuerpo.cierres.map((c: { turnoId: string }) => c.turnoId)).toEqual([propio.turno])
    expect(JSON.stringify(cuerpo)).not.toContain('Del otro restaurante')
    // Reimprimir el turno de otro restaurante es como si no existiera.
    const rep = await m.t.post(
      '/api/reportes/cierre-z',
      { ...m.admin.cuerpoSesion, turno_id: otro.turno },
      m.admin.token,
    )
    expect(rep.statusCode).toBe(404)
    expect(m.cierresZ()).toHaveLength(1)
  })
})

describe('cierre Z: el día de las ventas es el de la apertura del turno', () => {
  it('un turno que abre un día y cierra al siguiente imprime las ventas del día que abrió', () => {
    const m = mundo()
    const caja = m.admin
    const turno = nuevoId()
    caja.mandar(
      turno,
      'TurnoAbierto',
      { caja_id: caja.conexion.dispositivoId, base: 100_000 },
      { agregado_tipo: 'turno_caja' },
    )
    const vender = (monto: number) => {
      const pedido = m.t.abrir(m.ana)
      m.ana.mandar(pedido, 'ItemAgregado', { ...item(), precio_unitario: monto })
      caja.mandar(pedido, 'PagoRegistrado', {
        pago_id: nuevoId(),
        cuenta_id: null,
        turno_caja_id: turno,
        medio: 'efectivo',
        monto,
        propina: 0,
        recibido: monto,
        cambio: 0,
        ajuste_redondeo: 0,
        redondeo: { multiplo: 100, modo: 'cercano_mitad_abajo' },
        datafono: null,
        referencia_cobro: null,
      })
      expect(caja.mandar(pedido, 'PedidoCerrado', {}).estado).toBe('confirmado')
    }
    vender(40_000)
    // Pasa la madrugada: son las 6:30 a. m. del 25.
    m.t.avanzar(Date.parse('2026-10-25T11:30:00.000Z') - INICIO)
    vender(25_000)
    const { cerrarConEvento } = m
    const crudo = { ...cerrarConEvento(caja, turno, 165_000), secuencia_base: maxSecuencia(m.t) }
    expect(m.t.hub.recibirLote(caja.conexion, [crudo as never]).resultados[0]?.estado).toBe(
      'confirmado',
    )
    const [z] = m.cierresZ()
    expect(z?.ventas.neto).toBe(40_000)
    expect(z?.efectivo.cobrado).toBe(65_000)
  })
})

describe('rutas de reportes: permisos, cuerpos y fechas', () => {
  const informe = (
    m: ReturnType<typeof mundo>,
    cuerpo: Record<string, unknown>,
    token = m.admin.token,
  ) => m.t.post('/api/reportes', { ...m.admin.cuerpoSesion, ...cuerpo }, token)

  it('sin token 401, el cajero sin el permiso 403, y también para reimprimir', async () => {
    const m = mundo()
    const x = m.turnoCobrado(m.admin)
    const crudo = {
      ...m.cerrarConEvento(m.admin, x.turno, x.esperado),
      secuencia_base: maxSecuencia(m.t),
    }
    m.t.hub.recibirLote(m.admin.conexion, [crudo as never])
    const antes = m.cierresZ().length
    expect((await m.t.post('/api/reportes', { ...m.admin.cuerpoSesion })).statusCode).toBe(401)
    expect(
      (await m.t.post('/api/reportes', { ...m.admin.cuerpoSesion }, 'token-falso')).statusCode,
    ).toBe(401)
    expect(
      (await m.t.post('/api/reportes/cierre-z', { ...m.admin.cuerpoSesion, turno_id: x.turno }))
        .statusCode,
    ).toBe(401)
    expect(
      (await m.t.post('/api/reportes', { ...m.cajero.cuerpoSesion }, m.cajero.token)).statusCode,
    ).toBe(403)
    expect(
      (
        await m.t.post(
          '/api/reportes/cierre-z',
          { ...m.cajero.cuerpoSesion, turno_id: x.turno },
          m.cajero.token,
        )
      ).statusCode,
    ).toBe(403)
    // El mesero tampoco.
    expect(
      (await m.t.post('/api/reportes', { ...m.ana.cuerpoSesion }, m.ana.token)).statusCode,
    ).toBe(403)
    expect(m.cierresZ()).toHaveLength(antes)
  })

  it('una sesión de otro equipo, o con el secreto equivocado, no sirve', async () => {
    const m = mundo()
    expect((await informe(m, {}, m.cajero.token)).statusCode).toBeGreaterThanOrEqual(401)
    expect((await informe(m, {}, m.cajero.token)).statusCode).not.toBe(200)
    expect((await informe(m, { secreto: 'otro-secreto' })).statusCode).toBe(401)
    expect((await informe(m, { sesion_id: nuevoId() })).statusCode).toBe(401)
  })

  it('cuerpos mal formados dan 400, no 500', async () => {
    const m = mundo()
    const crudos = [
      { sesion_id: m.admin.cuerpoSesion.sesion_id },
      { ...m.admin.cuerpoSesion, extra: 1 },
      { ...m.admin.cuerpoSesion, desde: 5 },
      { ...m.admin.cuerpoSesion, desde: null },
      { ...m.admin.cuerpoSesion, hasta: ['2026-10-24'] },
      { sesion_id: 5, secreto: 6 },
      {},
    ]
    for (const c of crudos)
      expect((await m.t.post('/api/reportes', c, m.admin.token)).statusCode).toBe(400)
    for (const c of [
      { ...m.admin.cuerpoSesion },
      { ...m.admin.cuerpoSesion, turno_id: 'corto' },
      { ...m.admin.cuerpoSesion, turno_id: nuevoId(), extra: 1 },
      { ...m.admin.cuerpoSesion, turno_id: 7 },
    ])
      expect((await m.t.post('/api/reportes/cierre-z', c, m.admin.token)).statusCode).toBe(400)
  })

  it('las fechas que no son fechas dan 400 y las bisiestas y de borde dan 200', async () => {
    const m = mundo()
    for (const mala of ['2026-02-29', '2026-04-31', '2026-06-31', '2027-02-29'])
      expect((await informe(m, { desde: mala })).statusCode, JSON.stringify(mala)).toBe(400)
    expect((await informe(m, { desde: '2026-10-24', hasta: '2026-02-29' })).statusCode).toBe(400)
    for (const buena of ['2028-02-29', '2026-12-31', '2027-01-01', '2026-01-01', '2036-12-31']) {
      const r = await informe(m, { desde: buena })
      expect(r.statusCode, buena).toBe(200)
      expect(r.json().informe).toMatchObject({ desde: buena, hasta: buena })
    }
  })

  // Hallazgo de la tarea 1.9: `Dia` en rutas.ts llama a `toISOString()` dentro del `refine`, que
  // también corre cuando el texto no cumple el formato (zod 4 no corta en el primer fallo): con un
  // texto que no es fecha (mes 13, «hoy», «2026-2-3») `toISOString()` lanza RangeError y la ruta
  // da 500 en vez de 400.
  it('un texto que no es fecha da 400, no 500', async () => {
    const m = mundo()
    for (const mala of [
      '2026-13-01',
      '2026-00-10',
      '2026-10-32',
      '2026-2-3',
      'hoy',
      '',
      ' 2026-10-24',
      '2026-10-24\n',
      '2026-10-24T00:00:00Z',
      '2026/10/24',
    ])
      expect((await informe(m, { desde: mala })).statusCode, JSON.stringify(mala)).toBe(400)
  })

  it('al revés da 400; solo "hasta" cuenta desde hoy; solo "desde" es un solo día', async () => {
    const m = mundo()
    expect((await informe(m, { desde: '2026-10-25', hasta: '2026-10-24' })).statusCode).toBe(400)
    // hoy es el 24: hasta antes de hoy queda al revés.
    expect((await informe(m, { hasta: '2026-10-23' })).statusCode).toBe(400)
    const hastaFuturo = await informe(m, { hasta: '2026-10-26' })
    expect(hastaFuturo.json().informe).toMatchObject({ desde: '2026-10-24', hasta: '2026-10-26' })
    expect((await informe(m, { desde: '2026-10-20' })).json().informe).toMatchObject({
      desde: '2026-10-20',
      hasta: '2026-10-20',
    })
    expect((await informe(m, { desde: '2026-10-24', hasta: '2026-10-24' })).statusCode).toBe(200)
  })

  it('el período máximo son 62 días: 62 pasa, 63 no, también cruzando año', async () => {
    const m = mundo()
    expect((await informe(m, { desde: '2026-09-01', hasta: '2026-11-01' })).statusCode).toBe(200) // 62 días
    expect((await informe(m, { desde: '2026-09-01', hasta: '2026-11-02' })).statusCode).toBe(400) // 63
    expect((await informe(m, { desde: '2026-12-01', hasta: '2027-01-31' })).statusCode).toBe(200) // 62
    expect((await informe(m, { desde: '2026-12-01', hasta: '2027-02-01' })).statusCode).toBe(400) // 63
    // En un año bisiesto febrero tiene un día más.
    expect((await informe(m, { desde: '2028-01-15', hasta: '2028-03-15' })).statusCode).toBe(200) // 61
    expect((await informe(m, { desde: '2028-01-15', hasta: '2028-03-17' })).statusCode).toBe(400) // 63
    expect((await informe(m, { desde: '2000-01-01', hasta: '2026-10-24' })).statusCode).toBe(400)
  })

  it('"hoy" cambia a las 6:00 a. m. de Bogotá, no a medianoche', async () => {
    const m = mundo()
    const hoy = async () => (await informe(m, {})).json().hoy
    m.t.avanzar(Date.parse('2026-10-25T04:59:00.000Z') - INICIO) // 11:59 p. m. del 24
    expect(await hoy()).toBe('2026-10-24')
    m.t.avanzar(Date.parse('2026-10-25T10:59:00.000Z') - Date.parse('2026-10-25T04:59:00.000Z')) // 5:59 a. m.
    expect(await hoy()).toBe('2026-10-24')
    m.t.avanzar(60_000) // 6:00 a. m. del 25
    expect(await hoy()).toBe('2026-10-25')
    expect((await informe(m, {})).json().informe).toMatchObject({
      desde: '2026-10-25',
      hasta: '2026-10-25',
    })
  })

  it('un día sin movimiento da un informe en ceros y sin cierres', async () => {
    const m = mundo()
    const r = (await informe(m, { desde: '2026-10-01' })).json()
    expect(r.informe.ventas).toMatchObject({
      neto: 0,
      cuentas: 0,
      comensales: 0,
      ticketPromedio: 0,
    })
    expect(r.informe.porMedio).toEqual([])
    expect(r.cierres).toEqual([])
    expect(r.impresora).toBe(true)
  })
})
