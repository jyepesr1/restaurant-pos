import { nuevoId } from '@pos/core'
import type { CierreZ } from '@pos/printing'
import { describe, expect, it } from 'vitest'
import { item } from '../acceso/montaje-hub'
import { type Equipo, montarImpresion } from '../impresion/montaje-impresion'

// Reportes (tarea 1.9): el cierre Z sale solo al cerrar la caja, se reimprime desde Reportes y la
// ruta del informe pide «Ver todos los reportes».

function mundo(opciones: { conImpresora?: boolean } = {}) {
  const t = montarImpresion()
  const ana = t.equipo('mesero')
  const admin = t.equipo('admin', 'caja')
  const cajero = t.equipo('cajero', 'caja')
  const impresora = t.impresoraNueva('Caja', [])
  if (opciones.conImpresora !== false)
    t.db
      .prepare('UPDATE restaurante SET config = ? WHERE id = ?')
      .run(JSON.stringify({ impresora_precuenta_id: impresora.id }), t.restauranteId)

  /** Abre un turno en la caja, cobra un pedido de `precio` en efectivo y cierra el turno cuadrado. */
  const dia = (caja: Equipo, precio = 40_000, propina = 4_000) => {
    const turno = nuevoId()
    expect(
      caja.mandar(
        turno,
        'TurnoAbierto',
        { caja_id: caja.conexion.dispositivoId, base: 100_000 },
        { agregado_tipo: 'turno_caja' },
      ).estado,
    ).toBe('confirmado')
    const pedido = t.abrir(ana)
    expect(ana.mandar(pedido, 'ItemAgregado', { ...item(), precio_unitario: precio }).estado).toBe(
      'confirmado',
    )
    expect(
      caja.mandar(pedido, 'PagoRegistrado', {
        pago_id: nuevoId(),
        cuenta_id: null,
        turno_caja_id: turno,
        medio: 'efectivo',
        monto: precio,
        propina,
        recibido: precio + propina,
        cambio: 0,
        ajuste_redondeo: 0,
        redondeo: { multiplo: 100, modo: 'cercano_mitad_abajo' },
        datafono: null,
        referencia_cobro: null,
      }).estado,
    ).toBe('confirmado')
    expect(caja.mandar(pedido, 'PedidoCerrado', {}).estado).toBe('confirmado')
    const contado = 100_000 + precio + propina
    const arqueo = nuevoId()
    caja.mandar(
      turno,
      'ArqueoRegistrado',
      {
        arqueo_id: arqueo,
        conteo: [{ valor: 1_000, cantidad: contado / 1_000 }],
        contado_efectivo: contado,
      },
      { agregado_tipo: 'turno_caja' },
    )
    const cierre = caja.mandar(
      turno,
      'TurnoCerrado',
      {
        arqueo_id: arqueo,
        esperado_efectivo: contado,
        contado_efectivo: contado,
        diferencia: 0,
        justificacion: null,
        otros_medios: [],
      },
      { agregado_tipo: 'turno_caja' },
    )
    return { turno, pedido, cierre }
  }
  const cierresZ = () => t.trabajos("WHERE tipo = 'informe'").map((f) => t.contenido(f) as CierreZ)
  return { t, ana, admin, cajero, impresora, dia, cierresZ }
}

describe('cierre Z al cerrar la caja', () => {
  it('cerrar el turno pone el cierre Z en la impresora de precuentas, y se imprime', async () => {
    const { t, admin, impresora, dia, cierresZ } = mundo()
    const { cierre } = dia(admin)
    expect(cierre.estado).toBe('confirmado')
    const [z] = cierresZ()
    expect(z).toMatchObject({
      reimpreso: null,
      efectivo: { base: 100_000, cobrado: 44_000, esperado: 144_000, diferencia: 0 },
      cobrado: [{ nombre: 'Efectivo', venta: 40_000, propina: 4_000 }],
      ventas: { neto: 40_000, propinas: 4_000, cuentas: 1 },
    })
    await t.cola.vuelta()
    const [papel] = impresora.papel.textos()
    expect(papel).toContain('CIERRE DE CAJA')
    expect(papel).toContain('$144.000')
  })

  it('sin impresora de precuentas no se crea nada y el cierre se acepta igual', () => {
    const { t, admin, dia, cierresZ } = mundo({ conImpresora: false })
    expect(dia(admin).cierre.estado).toBe('confirmado')
    expect(cierresZ()).toEqual([])
    expect(t.fallosGuardar).toEqual([])
  })
})

describe('rutas de reportes', () => {
  it('el informe de hoy, con los cierres y los nombres; el cajero sin el permiso no lo ve', async () => {
    const { t, admin, cajero, dia } = mundo()
    const { turno } = dia(admin)
    const r = await t.post('/api/reportes', { ...admin.cuerpoSesion }, admin.token)
    expect(r.statusCode).toBe(200)
    const cuerpo = r.json()
    expect(cuerpo.informe.ventas).toMatchObject({ neto: 40_000, cuentas: 1 })
    expect(cuerpo.cierres).toEqual([
      expect.objectContaining({
        turnoId: turno,
        cerrado: expect.objectContaining({ diferencia: 0 }),
      }),
    ])
    expect(Object.values(cuerpo.usuarios)).toContain('Ana')
    expect(cuerpo.impresora).toBe(true)

    const sinPermiso = await t.post('/api/reportes', { ...cajero.cuerpoSesion }, cajero.token)
    expect(sinPermiso.statusCode).toBe(403)
    expect((await t.post('/api/reportes', { ...admin.cuerpoSesion })).statusCode).toBe(401)
  })

  it('rechaza fechas al revés, inválidas o un período de más de 62 días', async () => {
    const { t, admin } = mundo()
    const pedir = (desde: string, hasta: string) =>
      t.post('/api/reportes', { ...admin.cuerpoSesion, desde, hasta }, admin.token)
    expect((await pedir('2026-10-24', '2026-10-23')).statusCode).toBe(400)
    expect((await pedir('2026-02-30', '2026-03-01')).statusCode).toBe(400)
    expect((await pedir('2026-01-01', '2026-03-04')).statusCode).toBe(400)
    expect((await pedir('2026-01-01', '2026-03-03')).statusCode).toBe(200)
  })

  it('reimprime el cierre Z de un turno cerrado; uno abierto o inexistente da 404', async () => {
    const { t, admin, dia, cierresZ } = mundo()
    const { turno } = dia(admin)
    const pedir = (turno_id: string) =>
      t.post('/api/reportes/cierre-z', { ...admin.cuerpoSesion, turno_id }, admin.token)
    expect((await pedir(turno)).statusCode).toBe(204)
    expect(cierresZ()).toHaveLength(2)
    expect(cierresZ()[1]?.reimpreso).not.toBeNull()
    expect((await pedir(nuevoId())).statusCode).toBe(404)
  })

  it('sin impresora de precuentas, la reimpresión lo dice', async () => {
    const { t, admin, dia } = mundo({ conImpresora: false })
    const { turno } = dia(admin)
    const r = await t.post(
      '/api/reportes/cierre-z',
      { ...admin.cuerpoSesion, turno_id: turno },
      admin.token,
    )
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toBe('sin_impresora')
  })
})
