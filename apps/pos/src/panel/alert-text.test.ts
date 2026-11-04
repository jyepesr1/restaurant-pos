import type { Alert } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { ALERT_KINDS, type AlertPlace, alertText, kindLabel } from './alert-text'
import { ALERTS, rules, UNAPPLIED_ALERTS } from './testing'

// How each alert reads for the owner (task 1.11c-2).

const place: AlertPlace = {
  users: { ana: 'Ana', carla: 'Carla', luis: 'Luis' },
  tables: { t3: '3' },
  rules,
  time: (iso) => iso.slice(11, 16),
}

const byId = (id: string) => ALERTS.find((a) => a.id === id) as Alert
const read = (a: Alert, p = place) => {
  const t = alertText(a, p)
  return [t.sentence, ...t.details].join(' · ')
}

describe('alertText', () => {
  it('a voided product: who, how many, how much, where, who authorized and why', () => {
    expect(read(byId('a1'))).toBe(
      'Ana anuló 1 Pinsa ($20.900) en la Mesa 3 · autorizó Luis · ya estaba preparado · Motivo: Se quemó',
    )
  })

  it('a canceled order without a table goes by its channel and number', () => {
    expect(read(byId('a2'))).toBe(
      'Ana canceló el pedido Para llevar #13 ($12.000) · Motivo: El cliente se fue',
    )
    const atTable = {
      ...byId('a2'),
      order: { id: 'o', number: 4, tableId: 't3', channel: 'dine_in' },
    } as Alert
    expect(alertText(atTable, place).sentence).toBe('Ana canceló el pedido de la Mesa 3 ($12.000)')
  })

  it('a courtesy, a percentage on one product and a value on the order, and a removed one', () => {
    expect(read(byId('a3'))).toBe(
      'Ana dio de cortesía 1 Pinsa ($20.900) en la Mesa 3 · autorizó Luis · Motivo: Cliente frecuente',
    )
    const percent = {
      ...byId('a3'),
      rule: 'percent',
      basisPoints: 1_250,
      units: null,
      value: 2_613,
      authorizedById: null,
      reason: null,
      removedAt: '2026-10-30T02:00:00.000Z',
      removedBy: 'luis',
    } as Alert
    expect(read(percent)).toBe(
      'Ana hizo un descuento del 12,5 % a Pinsa ($2.613) en la Mesa 3 (quitado a las 02:00) · lo quitó Luis',
    )
    const value = {
      ...byId('a3'),
      rule: 'value',
      scope: 'order',
      units: null,
      value: 5_000,
      items: ['Pinsa', 'Limonada'],
      authorizedById: 'ana',
      reason: null,
      removedAt: '2026-10-30T02:00:00.000Z',
      removedBy: null,
      order: null,
    } as Alert
    // Whoever authorizes themselves is not said twice.
    expect(read(value)).toBe('Ana hizo un descuento de $5.000 en un pedido (quitado a las 02:00)')
    const removedCourtesy = { ...byId('a3'), removedAt: '2026-10-30T02:00:00.000Z' } as Alert
    expect(alertText(removedCourtesy, place).sentence).toBe(
      'Ana dio de cortesía 1 Pinsa ($20.900) en la Mesa 3 (quitada a las 02:00)',
    )
  })

  it('a voided payment: its method, its amount, the tip it included; unknown, «monto no disponible»', () => {
    expect(read(byId('a4'))).toBe(
      'Carla anuló un pago en efectivo ($44.900) en la Mesa 3 · incluye $4.000 de propina · Motivo: Cobro duplicado',
    )
    const unknown = { ...byId('a4'), method: null, reason: null, tip: 0 } as Alert
    expect(read(unknown)).toBe('Carla anuló un pago ($44.900) en la Mesa 3')
    // Without its payment among the events the amount is not known: never a made-up $0.
    const lost = {
      ...byId('a4'),
      reason: null,
      value: null,
      tip: null,
      roundingAdjustment: null,
    } as Alert
    expect(read(lost)).toBe('Carla anuló un pago en efectivo (monto no disponible) en la Mesa 3')
    expect(read(lost)).not.toContain('$0')
    // The cash rounding adjustment it carried, with its sign.
    const rounded = { ...byId('a4'), reason: null, tip: 0, roundingAdjustment: -50 } as Alert
    expect(read(rounded)).toBe(
      'Carla anuló un pago en efectivo ($44.900) en la Mesa 3 · incluye -$50 de redondeo del efectivo',
    )
  })

  it('a refund names the restaurant’s own method and the tip it includes', () => {
    expect(read(byId('a5'))).toBe(
      'Carla devolvió $12.000 en QR Bancolombia de la Mesa 3 · autorizó Luis · incluye $2.000 de propina · Motivo: Plato frío',
    )
  })

  it('a reopened order says what it had closed for', () => {
    expect(read(byId('a6'))).toBe(
      'Luis reabrió la cuenta de la Mesa 3, que había cerrado en $61.800 · Motivo: Faltó un postre',
    )
    const takeout = {
      ...byId('a6'),
      order: { id: 'o', number: 9, tableId: null, channel: 'delivery' },
    } as Alert
    expect(alertText(takeout, place).sentence).toBe(
      'Luis reabrió el pedido Domicilio #9, que había cerrado en $61.800',
    )
  })

  it('a register variance: missing or left over, by method, with the justification', () => {
    expect(read(byId('a7'))).toBe(
      'En la caja de Carla faltaron $5.000 en efectivo · cerró Luis · debería haber $300.000 · contado $295.000 · Justificación: Se dio mal un cambio',
    )
    const nequi = {
      ...byId('a7'),
      method: 'nequi',
      value: 2_000,
      expected: 80_000,
      counted: 82_000,
      reason: null,
      userId: 'nadie',
    } as Alert
    expect(read(nequi)).toBe(
      'En la caja de Carla sobraron $2.000 en Nequi · cerró Alguien · según el sistema $80.000 · según su cierre $82.000',
    )
  })

  it('an unknown table, a dine-in order without a table and an order without a number', () => {
    const lost = {
      ...byId('a1'),
      order: { id: 'o', number: null, tableId: 'tx', channel: 'dine_in' },
    } as Alert
    expect(alertText(lost, place).sentence).toContain('en una mesa que ya no está en el plano')
    expect(alertText(lost, place).sentence).not.toContain('?')
    const plain = {
      ...byId('a1'),
      order: { id: 'o', number: 5, tableId: null, channel: 'dine_in' },
    } as Alert
    expect(alertText(plain, place).sentence).toContain('en el pedido #5')
    const bare = {
      ...byId('a1'),
      order: { id: 'o', number: null, tableId: null, channel: 'bar' },
    } as Alert
    expect(alertText(bare, place).sentence).toContain('en el pedido Barra')
    const noTable = {
      ...byId('a1'),
      order: { id: 'o', number: null, tableId: null, channel: 'dine_in' },
    } as Alert
    expect(alertText(noTable, place).sentence).toContain('en un pedido sin mesa')
  })

  it('a refund says where the money came back from: a table, an order or one without a table', () => {
    const refund = byId('a5')
    const of = (order: Alert['order']) =>
      alertText({ ...refund, order } as Alert, place).sentence.replace(/^.* QR Bancolombia /, '')
    expect(of(refund.order)).toBe('de la Mesa 3')
    expect(of({ id: 'o', number: 7, tableId: null, channel: 'takeout' })).toBe(
      'del pedido Para llevar #7',
    )
    expect(of({ id: 'o', number: null, tableId: null, channel: 'dine_in' })).toBe(
      'de un pedido sin mesa',
    )
    expect(of({ id: 'o', number: null, tableId: 'gone', channel: 'dine_in' })).toBe(
      'de una mesa que ya no está en el plano',
    )
  })

  it('a reopening without the previous close says the amount is not known', () => {
    expect(alertText({ ...byId('a6'), value: null } as Alert, place).sentence).toBe(
      'Luis reabrió la cuenta de la Mesa 3 (monto no disponible)',
    )
  })

  it('each row has its label, and only discounts and reopenings are amber', () => {
    expect(kindLabel(byId('a3'))).toBe('Cortesía')
    expect(kindLabel({ ...byId('a3'), rule: 'percent' } as Alert)).toBe('Descuento')
    expect(kindLabel(byId('a7'))).toBe('Descuadre')
    const amber = Object.entries(ALERT_KINDS)
      .filter(([, k]) => k.tone === 'progress')
      .map(([t]) => t)
    expect(amber).toEqual(['discount', 'order_reopened'])
    expect(
      Object.values(ALERT_KINDS).every((k) => k.tone === 'progress' || k.tone === 'warning'),
    ).toBe(true)
  })

  it('every kind has its name for the filters', () => {
    expect(Object.values(ALERT_KINDS).map((k) => k.name)).toEqual([
      'Productos anulados',
      'Pedidos cancelados',
      'Descuentos y cortesías',
      'Pagos anulados',
      'Devoluciones',
      'Cuentas reabiertas',
      'Descuadres de caja',
      'Dinero no aplicado',
    ])
  })

  it('unapplied money: what was tried, with its method and amount, and what to check', () => {
    const [refund, voided, payment] = UNAPPLIED_ALERTS as [Alert, Alert, Alert]
    expect(read(payment)).toBe(
      'Carla cobró $44.900 en efectivo en la Mesa 3, pero no se aplicó · no cuenta en la caja: revisa si ese dinero se recibió o se entregó',
    )
    // A return is said without its minus sign: «devolvió $12.000».
    expect(read(refund)).toBe(
      'Carla devolvió $12.000 en QR Bancolombia de la Mesa 3, pero no se aplicó · autorizó Luis · no cuenta en la caja: revisa si ese dinero se recibió o se entregó · Motivo: Plato frío',
    )
    // Without its payment among the events: neither method nor a made-up amount.
    expect(read(voided)).toBe(
      'Carla anuló un pago (monto no disponible) en la Mesa 3, pero no se aplicó · no cuenta en la caja: revisa si ese dinero se recibió o se entregó · Motivo: Cobro duplicado',
    )
    expect(read({ ...voided, value: -44_900, method: 'cash' } as Alert)).toContain(
      'anuló un pago en efectivo ($44.900) en la Mesa 3, pero no se aplicó',
    )
    expect(kindLabel(payment)).toBe('Dinero no aplicado')
    expect(ALERT_KINDS.unapplied_money.tone).toBe('warning')
  })
})
