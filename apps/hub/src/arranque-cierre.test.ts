import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nuevoId } from '@pos/core'
import type { MensajeHub } from '@pos/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { montarAcceso } from './acceso/montaje'
import { prepararSincronizacion } from './arranque'

// El cierre de caja (tarea 1.7) en el hub real: `prepararSincronizacion` lee el umbral de la
// configuración en cada cierre, así que lo que el administrador cambie con el hub andando vale
// desde el siguiente cierre. Complementa packages/sync/src/caja.cierre.test.ts.

const carpetas: string[] = []
afterEach(() => {
  for (const c of carpetas.splice(0)) rmSync(c, { recursive: true, force: true })
})

function mundo() {
  const m = montarAcceso()
  const dir = mkdtempSync(join(tmpdir(), 'hub-cierre-'))
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
  const mandar = (tipo: string, agregado: string, datos: unknown): string => {
    lote += 1
    enlace.recibir({
      tipo: 'empujar',
      lote_id: `lote-${lote}`,
      eventos: [
        m.evento(caja.conexion, sesion, tipo, datos, {
          agregado_id: agregado,
          agregado_tipo: 'turno_caja',
          secuencia_base: maxSecuencia(),
        } as never),
      ],
    })
    const ultimo = recibidos.filter((x) => x.tipo === 'resultado').at(-1)
    if (ultimo?.tipo !== 'resultado') throw new Error('Sin resultado')
    const r = ultimo.resultados[0]
    return r?.estado === 'rechazado' ? r.motivo : (r?.estado ?? 'sin resultado')
  }
  const ponerConfig = (config: object) =>
    m.db
      .prepare('UPDATE restaurante SET config = ? WHERE id = ?')
      .run(JSON.stringify(config), m.restauranteId)

  /** Abre un turno de base 100.000 y cuenta `contado` pesos (en billetes de $1.000 y monedas de $1). */
  const turnoContado = (contado: number) => {
    const turno = nuevoId()
    expect(
      mandar('TurnoAbierto', turno, { caja_id: caja.conexion.dispositivoId, base: 100_000 }),
    ).toBe('confirmado')
    const arqueo = nuevoId()
    const conteo = [
      { valor: 1_000, cantidad: Math.floor(contado / 1_000) },
      { valor: 1, cantidad: contado % 1_000 },
    ].filter((c) => c.cantidad > 0)
    expect(
      mandar('ArqueoRegistrado', turno, { arqueo_id: arqueo, conteo, contado_efectivo: contado }),
    ).toBe('confirmado')
    const cerrar = (justificacion: string | null = null) =>
      mandar('TurnoCerrado', turno, {
        arqueo_id: arqueo,
        esperado_efectivo: 100_000,
        contado_efectivo: contado,
        diferencia: contado - 100_000,
        justificacion,
      })
    return { turno, arqueo, cerrar }
  }
  return { m, ponerConfig, turnoContado, mandar }
}

describe('el umbral de diferencia se lee de la configuración en cada cierre', () => {
  it('de fábrica ($1.000): $999 de faltante se cierra solo; $1.000 pide justificación', () => {
    const e = mundo()
    expect(e.turnoContado(99_001).cerrar()).toBe('confirmado')
    const t = e.turnoContado(99_000)
    expect(t.cerrar()).toBe('falta_justificacion')
    expect(t.cerrar('Propina de la mesa 3')).toBe('confirmado')
  })

  it('una configuración vieja, sin el campo, usa también $1.000', () => {
    const e = mundo()
    e.ponerConfig({})
    expect(e.turnoContado(99_500).cerrar()).toBe('confirmado')
    expect(e.turnoContado(99_000).cerrar()).toBe('falta_justificacion')
  })

  it('si el administrador lo baja a $0 con el hub andando, el siguiente cierre ya pide justificación', () => {
    const e = mundo()
    const t = e.turnoContado(99_999)
    e.ponerConfig({ umbral_diferencia_caja: 0 })
    expect(t.cerrar()).toBe('falta_justificacion')
    expect(t.cerrar('Faltó un peso')).toBe('confirmado')
  })

  it('si lo sube a $5.000, un faltante de $4.999 pasa y uno de $5.000 no', () => {
    const e = mundo()
    e.ponerConfig({ umbral_diferencia_caja: 5_000 })
    expect(e.turnoContado(95_001).cerrar()).toBe('confirmado')
    const faltante = e.turnoContado(95_000)
    expect(faltante.cerrar()).toBe('falta_justificacion')
    expect(faltante.cerrar('Se pagó un proveedor')).toBe('confirmado')
    const sobrante = e.turnoContado(105_000)
    expect(sobrante.cerrar()).toBe('falta_justificacion')
  })

  it('con umbral 0, una caja que cuadra exacto se cierra sin justificación', () => {
    const e = mundo()
    e.ponerConfig({ umbral_diferencia_caja: 0 })
    expect(e.turnoContado(100_000).cerrar()).toBe('confirmado')
  })
})
