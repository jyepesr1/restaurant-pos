import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId } from '@pos/core'
import type { HubMessage } from '@pos/sync'
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
  const dir = mkdtempSync(join(tmpdir(), 'hub-closeout-'))
  carpetas.push(dir)
  const floor = prepararSincronizacion(m.db, dir, m.restaurantId, m.access)
  const register = m.emparejar('register')
  const session = m.entrar(register.connection, 'cashier')
  const received: HubMessage[] = []
  const link = floor.connect((message) => received.push(message))
  link.receive({
    type: 'hello',
    token: register.token,
    hub_instance: null,
    until: 0,
    version_app: 'pruebas',
  })
  let batch = 0
  const maxSequence = () =>
    Number(
      m.db
        .prepare('SELECT coalesce(max(sequence), 0) AS s FROM events WHERE restaurant_id = ?')
        .get(m.restaurantId)?.s,
    )
  const submit = (type: string, aggregate: string, data: unknown): string => {
    batch += 1
    link.receive({
      type: 'push',
      batch_id: `lote-${batch}`,
      events: [
        m.event(register.connection, session, type, data, {
          aggregate_id: aggregate,
          aggregate_type: 'register_shift',
          base_sequence: maxSequence(),
        } as never),
      ],
    })
    const latest = received.filter((x) => x.type === 'result').at(-1)
    if (latest?.type !== 'result') throw new Error('Sin resultado')
    const r = latest.results[0]
    return r?.status === 'rejected' ? r.reason : (r?.status ?? 'sin resultado')
  }
  const ponerConfig = (config: object) =>
    m.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify(config), m.restaurantId)

  /** Abre un turno de base 100.000 y cuenta `contado` pesos (en billetes de $1.000 y monedas de $1). */
  const turnoContado = (counted: number) => {
    const shift = newId()
    expect(
      submit('ShiftOpened', shift, {
        register_id: register.connection.deviceId,
        base: 100_000,
      }),
    ).toBe('confirmed')
    const cashCount = newId()
    const tally = [
      { value: 1_000, quantity: Math.floor(counted / 1_000) },
      { value: 1, quantity: counted % 1_000 },
    ].filter((c) => c.quantity > 0)
    expect(
      submit('CashCountRecorded', shift, {
        cash_count_id: cashCount,
        tally,
        counted_cash: counted,
      }),
    ).toBe('confirmed')
    const close = (justification: string | null = null) =>
      submit('ShiftClosed', shift, {
        cash_count_id: cashCount,
        expected_cash: 100_000,
        counted_cash: counted,
        variance: counted - 100_000,
        justification,
      })
    return { shift, cashCount, close }
  }
  return { m, ponerConfig, turnoContado, submit }
}

describe('el umbral de diferencia se lee de la configuración en cada cierre', () => {
  it('de fábrica ($1.000): $999 de faltante se cierra solo; $1.000 pide justificación', () => {
    const e = mundo()
    expect(e.turnoContado(99_001).close()).toBe('confirmed')
    const t = e.turnoContado(99_000)
    expect(t.close()).toBe('missing_justification')
    expect(t.close('Propina de la mesa 3')).toBe('confirmed')
  })

  it('una configuración vieja, sin el campo, usa también $1.000', () => {
    const e = mundo()
    e.ponerConfig({})
    expect(e.turnoContado(99_500).close()).toBe('confirmed')
    expect(e.turnoContado(99_000).close()).toBe('missing_justification')
  })

  it('si el administrador lo baja a $0 con el hub andando, el siguiente cierre ya pide justificación', () => {
    const e = mundo()
    const t = e.turnoContado(99_999)
    e.ponerConfig({ register_variance_threshold: 0 })
    expect(t.close()).toBe('missing_justification')
    expect(t.close('Faltó un peso')).toBe('confirmed')
  })

  it('si lo sube a $5.000, un faltante de $4.999 pasa y uno de $5.000 no', () => {
    const e = mundo()
    e.ponerConfig({ register_variance_threshold: 5_000 })
    expect(e.turnoContado(95_001).close()).toBe('confirmed')
    const short = e.turnoContado(95_000)
    expect(short.close()).toBe('missing_justification')
    expect(short.close('Se pagó un proveedor')).toBe('confirmed')
    const sobrante = e.turnoContado(105_000)
    expect(sobrante.close()).toBe('missing_justification')
  })

  it('con umbral 0, una caja que cuadra exacto se cierra sin justificación', () => {
    const e = mundo()
    e.ponerConfig({ register_variance_threshold: 0 })
    expect(e.turnoContado(100_000).close()).toBe('confirmed')
  })
})
