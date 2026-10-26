import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nuevoId } from '@pos/core'
import type { MensajeHub } from '@pos/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { montarAcceso } from './acceso/montaje'
import { ABRIR, item } from './acceso/montaje-hub'
import { insertarVersionado, SISTEMA } from './acceso/registros'
import { prepararSincronizacion } from './arranque'

// `prepararSincronizacion` (lo que corre en el hub real): las reglas de cobro se leen de la base en
// cada pago, así que lo que el administrador cambie con el hub andando vale desde el siguiente
// pago: medios, datáfonos activos y la regla de redondeo del efectivo.

const carpetas: string[] = []
afterEach(() => {
  for (const c of carpetas.splice(0)) rmSync(c, { recursive: true, force: true })
})

function mundo() {
  const m = montarAcceso()
  const dir = mkdtempSync(join(tmpdir(), 'hub-cobro-'))
  carpetas.push(dir)
  const sala = prepararSincronizacion(m.db, dir, m.restauranteId, m.acceso)
  const caja = m.emparejar('caja')
  const sesion = m.entrar(caja.conexion, 'cajero')
  const recibidos: MensajeHub[] = []
  const enlace = sala.conectar((mensaje) => recibidos.push(mensaje))
  enlace.recibir({
    tipo: 'hola',
    token: caja.token,
    hub_instancia: null,
    hasta: 0,
    version_app: 'pruebas',
  })
  let lote = 0
  const maxSecuencia = () =>
    Number(
      m.db
        .prepare('SELECT coalesce(max(secuencia), 0) AS s FROM evento WHERE restaurante_id = ?')
        .get(m.restauranteId)?.s,
    )
  /** Manda eventos al hub real y devuelve cómo le fue a cada uno. */
  const mandar = (
    eventos: { tipo: string; agregado: string; datos: unknown; extras?: object }[],
  ): string[] => {
    lote += 1
    enlace.recibir({
      tipo: 'empujar',
      lote_id: `lote-${lote}`,
      eventos: eventos.map((e) =>
        m.evento(caja.conexion, sesion, e.tipo, e.datos, {
          agregado_id: e.agregado,
          secuencia_base: maxSecuencia(),
          ...(e.extras ?? {}),
        } as never),
      ),
    })
    const ultimo = recibidos.filter((x) => x.tipo === 'resultado').at(-1)
    if (ultimo?.tipo !== 'resultado') throw new Error('Sin resultado')
    return ultimo.resultados.map((r) => (r.estado === 'rechazado' ? r.motivo : r.estado))
  }

  const turno = nuevoId()
  expect(
    mandar([
      {
        tipo: 'TurnoAbierto',
        agregado: turno,
        datos: { caja_id: caja.conexion.dispositivoId, base: 100_000 },
        extras: { agregado_tipo: 'turno_caja' },
      },
    ]),
  ).toEqual(['confirmado'])

  const pedidoCon = (precio: number) => {
    const pedido = nuevoId()
    expect(
      mandar([
        { tipo: 'PedidoAbierto', agregado: pedido, datos: ABRIR },
        { tipo: 'ItemAgregado', agregado: pedido, datos: { ...item(), precio_unitario: precio } },
      ]),
    ).toEqual(['confirmado', 'confirmado'])
    return pedido
  }
  const datafono = (nombre = 'Bold 1', extra: Record<string, string | number> = {}) =>
    insertarVersionado(
      m.db,
      'datafono',
      m.restauranteId,
      { nombre, proveedor: 'bold', ...extra },
      SISTEMA,
      m.reloj(),
    )
  const ponerConfig = (config: object) =>
    m.db
      .prepare('UPDATE restaurante SET config = ? WHERE id = ?')
      .run(JSON.stringify(config), m.restauranteId)

  const base = {
    cuenta_id: null,
    turno_caja_id: turno,
    propina: 0,
    referencia_cobro: null,
  }
  const nequi = (monto: number) => ({
    ...base,
    pago_id: nuevoId(),
    medio: 'nequi',
    monto,
    recibido: null,
    cambio: null,
    ajuste_redondeo: 0,
    redondeo: null,
    datafono: null,
  })
  const tarjeta = (monto: number, datafonoId: string, aprobacion: string | null = null) => ({
    ...base,
    pago_id: nuevoId(),
    medio: 'tarjeta',
    monto,
    recibido: null,
    cambio: null,
    ajuste_redondeo: 0,
    redondeo: null,
    datafono: {
      datafono_id: datafonoId,
      franquicia: null,
      ultimos4: null,
      aprobacion,
      recibo: null,
    },
  })
  /** Efectivo que cancela el saldo de $36.810: se cobra $36.800 (−10) con la regla que se diga. */
  const efectivo = (redondeo: { multiplo: number; modo: string } | null, monto = 36_810) => ({
    ...base,
    pago_id: nuevoId(),
    medio: 'efectivo',
    monto,
    recibido: monto - 10,
    cambio: 0,
    ajuste_redondeo: -10,
    redondeo,
    datafono: null,
  })
  const pagar = (pedido: string, datos: unknown) =>
    mandar([{ tipo: 'PagoRegistrado', agregado: pedido, datos }])[0]
  return { m, mandar, pedidoCon, datafono, ponerConfig, nequi, tarjeta, efectivo, pagar, turno }
}

describe('reglas de cobro del hub real', () => {
  it('de fábrica acepta Nequi y el efectivo con la regla del restaurante (100, mitad abajo)', () => {
    const { pedidoCon, pagar, nequi, efectivo } = mundo()
    expect(pagar(pedidoCon(10_000), nequi(10_000))).toBe('confirmado')
    expect(pagar(pedidoCon(36_810), efectivo({ multiplo: 100, modo: 'cercano_mitad_abajo' }))).toBe(
      'confirmado',
    )
  })

  it('el administrador quita Nequi con el hub andando: el siguiente pago ya no pasa', () => {
    const { pedidoCon, pagar, nequi, ponerConfig } = mundo()
    const pedido = pedidoCon(20_000)
    expect(pagar(pedido, nequi(5_000))).toBe('confirmado')
    ponerConfig({ medios_pago: ['efectivo', 'tarjeta'] })
    expect(pagar(pedido, nequi(5_000))).toBe('medio_no_habilitado')
    ponerConfig({ medios_pago: ['efectivo', 'tarjeta', 'nequi'] })
    expect(pagar(pedido, nequi(5_000))).toBe('confirmado')
  })

  it('el bono solo se acepta si el restaurante lo incluye', () => {
    const { pedidoCon, pagar, nequi, ponerConfig } = mundo()
    const pedido = pedidoCon(20_000)
    const bono = { ...nequi(5_000), medio: 'bono' }
    expect(pagar(pedido, bono)).toBe('medio_no_habilitado')
    ponerConfig({ medios_pago: ['efectivo', 'bono'] })
    expect(pagar(pedido, bono)).toBe('confirmado')
  })

  it('tarjeta con un datáfono activo del restaurante, sin número de aprobación: se acepta', () => {
    const { pedidoCon, pagar, tarjeta, datafono } = mundo()
    const bold = datafono()
    expect(pagar(pedidoCon(10_000), tarjeta(10_000, bold))).toBe('confirmado')
    expect(pagar(pedidoCon(10_000), tarjeta(10_000, bold, '123456'))).toBe('confirmado')
  })

  it('tarjeta con un datáfono que no existe: datafono_desconocido', () => {
    const { pedidoCon, pagar, tarjeta, datafono } = mundo()
    datafono()
    expect(pagar(pedidoCon(10_000), tarjeta(10_000, nuevoId()))).toBe('datafono_desconocido')
  })

  it('tarjeta sin ningún datáfono registrado: datafono_desconocido', () => {
    const { pedidoCon, pagar, tarjeta } = mundo()
    expect(pagar(pedidoCon(10_000), tarjeta(10_000, nuevoId()))).toBe('datafono_desconocido')
  })

  it('un datáfono archivado ya no sirve, y vuelve a servir al reactivarlo', () => {
    const { m, pedidoCon, pagar, tarjeta, datafono } = mundo()
    const bold = datafono()
    const pedido = pedidoCon(20_000)
    m.db.prepare('UPDATE datafono SET activo = 0 WHERE id = ?').run(bold)
    expect(pagar(pedido, tarjeta(5_000, bold))).toBe('datafono_desconocido')
    m.db.prepare('UPDATE datafono SET activo = 1 WHERE id = ?').run(bold)
    expect(pagar(pedido, tarjeta(5_000, bold))).toBe('confirmado')
  })

  it('el datáfono de otro restaurante no sirve en este', () => {
    const { m, pedidoCon, pagar, tarjeta } = mundo()
    const otro = nuevoId()
    m.db
      .prepare(
        `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
         VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
      )
      .run(otro, otro, m.reloj(), m.reloj())
    const ajeno = nuevoId()
    m.db
      .prepare(
        `INSERT INTO datafono (id, restaurante_id, creado_en, actualizado_en, version, nombre, proveedor)
         VALUES (?, ?, ?, ?, 1, 'Bold ajeno', 'bold')`,
      )
      .run(ajeno, otro, m.reloj(), m.reloj())
    expect(pagar(pedidoCon(10_000), tarjeta(10_000, ajeno))).toBe('datafono_desconocido')
  })

  it('la regla de redondeo viene de la configuración: otro múltiplo, redondeo_distinto', () => {
    const { pedidoCon, pagar, efectivo } = mundo()
    expect(pagar(pedidoCon(36_810), efectivo({ multiplo: 50, modo: 'cercano_mitad_abajo' }))).toBe(
      'redondeo_distinto',
    )
    expect(pagar(pedidoCon(36_810), efectivo({ multiplo: 100, modo: 'arriba' }))).toBe(
      'redondeo_distinto',
    )
  })

  it('si el restaurante cambia el múltiplo a 50, la regla de 100 deja de valer y la de 50 vale', () => {
    const { pedidoCon, pagar, efectivo, ponerConfig } = mundo()
    ponerConfig({ redondeo_efectivo: 50 })
    expect(pagar(pedidoCon(36_810), efectivo({ multiplo: 100, modo: 'cercano_mitad_abajo' }))).toBe(
      'redondeo_distinto',
    )
    // Con múltiplo 50, $36.810 se cobra a $36.800 (−10) igual: la regla nueva se acepta.
    expect(pagar(pedidoCon(36_810), efectivo({ multiplo: 50, modo: 'cercano_mitad_abajo' }))).toBe(
      'confirmado',
    )
  })

  it('si cambia el modo del efectivo, también', () => {
    const { pedidoCon, pagar, efectivo, ponerConfig } = mundo()
    ponerConfig({ redondeo_efectivo_modo: 'cercano_mitad_arriba' })
    expect(pagar(pedidoCon(36_810), efectivo({ multiplo: 100, modo: 'cercano_mitad_abajo' }))).toBe(
      'redondeo_distinto',
    )
    expect(
      pagar(pedidoCon(36_810), efectivo({ multiplo: 100, modo: 'cercano_mitad_arriba' })),
    ).toBe('confirmado')
  })

  it('un medio propio activo se acepta; archivado o inexistente, medio_no_habilitado', () => {
    const { pedidoCon, pagar, nequi, ponerConfig } = mundo()
    const sodexo = nuevoId()
    const pedido = pedidoCon(30_000)
    const conPropio = (id: string) => ({ ...nequi(5_000), medio: 'otro', medio_propio_id: id })
    ponerConfig({ medios_propios: [{ id: sodexo, nombre: 'Sodexo', activo: true }] })
    expect(pagar(pedido, conPropio(sodexo))).toBe('confirmado')
    expect(pagar(pedido, conPropio(nuevoId()))).toBe('medio_no_habilitado')
    ponerConfig({ medios_propios: [{ id: sodexo, nombre: 'Sodexo', activo: false }] })
    expect(pagar(pedido, conPropio(sodexo))).toBe('medio_no_habilitado')
  })

  it('un pago sin turno sigue rechazándose antes que el medio', () => {
    const { m, pedidoCon, pagar, nequi, ponerConfig } = mundo()
    ponerConfig({ medios_pago: ['efectivo'] })
    const pedido = pedidoCon(10_000)
    const sinTurno = { ...nequi(10_000), turno_caja_id: nuevoId() }
    expect(pagar(pedido, sinTurno)).toBe('sin_turno')
    expect(m.db.prepare('SELECT count(*) AS n FROM evento_rechazado').get()?.n).toBeGreaterThan(0)
  })

  it('una configuración dañada no deja sin servicio: toma los valores de fábrica', () => {
    const { m, pedidoCon, pagar, nequi } = mundo()
    m.db.prepare("UPDATE restaurante SET config = '{}' WHERE id = ?").run(m.restauranteId)
    expect(pagar(pedidoCon(10_000), nequi(10_000))).toBe('confirmado')
  })
})
