import { cashBalances } from '@pos/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  balanceOf,
  byItems,
  cardPayment,
  cashPayment,
  cashTip,
  checkTips,
  checkTotal,
  inEqualParts,
  tipOn,
  trimAssignments,
} from './check'

const l = (id: string, quantity: number, unitPrice: number, extras: number[] = []) => ({
  id,
  quantity,
  unitPrice,
  extras,
})

describe('total, balance and tip (with @pos/core)', () => {
  it('total with quantities and extras; balance after payments', () => {
    expect(checkTotal([])).toBe(0)
    expect(checkTotal([l('a', 2, 30_000, [2_000]), l('b', 1, 40_000)])).toBe(104_000)
    expect(balanceOf(100_000, [{ amount: 40_000 }])).toBe(60_000)
  })

  it('tip over the base without INC, as in DINERO.md', () => {
    expect(tipOn(100_000)).toBe(9_259)
    expect(tipOn(16_000)).toBe(1_481)
    expect(tipOn(257_500)).toBe(23_843)
    expect(tipOn(0)).toBe(0)
  })

  it('in cash the tip is suggested rounded to $100, half in favor of the guest', () => {
    expect(cashTip(23_843)).toBe(23_800)
    expect(cashTip(9_259)).toBe(9_300)
    expect(cashTip(9_250)).toBe(9_200)
  })
})

describe('split', () => {
  it('equal parts of the balance by largest remainder', () => {
    expect(inEqualParts(100_000, 3)).toEqual([33_334, 33_333, 33_333])
  })

  it('with prior payments the balance is split and the tip of each check comes from it (DINERO.md)', () => {
    const amounts = inEqualParts(balanceOf(100_000, [{ amount: 40_000 }]), 2)
    expect(amounts).toEqual([30_000, 30_000])
    expect(checkTips(amounts)).toEqual([2_778, 2_778])
  })

  it('by items, with one shared between two and what was not taken in "unassigned"', () => {
    const lines = [l('pizza', 1, 44_900), l('vino', 1, 129_900), l('te', 1, 13_900)]
    const r = byItems(
      lines,
      new Map([
        ['pizza', [0]],
        ['vino', [0, 1]],
      ]),
      2,
    )
    expect(r.amounts).toEqual([44_900 + 64_950, 64_950])
    expect(r.unassigned).toBe(13_900)
  })

  it('an item among three allocates the remainder: 44.900 → 14.967 + 14.967 + 14.966', () => {
    const r = byItems([l('pizza', 1, 44_900)], new Map([['pizza', [0, 1, 2]]]), 3)
    expect(r.amounts).toEqual([14_967, 14_967, 14_966])
  })

  it('removing a check returns its share to "unassigned", without breaking the split', () => {
    const assignedChecks = new Map([
      ['pizza', [0, 2]],
      ['vino', [2]],
    ])
    const trimmed = trimAssignments(assignedChecks, 2)
    expect([...trimmed]).toEqual([['pizza', [0]]])
    const r = byItems([l('pizza', 1, 44_900), l('vino', 1, 129_900)], trimmed, 2)
    expect(r).toEqual({ amounts: [44_900, 0], unassigned: 129_900 })
  })

  it('the checks plus the unassigned always add up to the total', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 200_000 }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 2, max: 6 }),
        fc.array(fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 3 }), { maxLength: 8 }),
        (prices, checks, who) => {
          const lines = prices.map((p, i) => l(`i${i}`, 1, p))
          const assignedChecks = new Map<string, number[]>()
          who.forEach((src, i) => {
            const validChecks = [...new Set(src.filter((c) => c < checks))]
            if (i < lines.length && validChecks.length > 0) assignedChecks.set(`i${i}`, validChecks)
          })
          const r = byItems(lines, assignedChecks, checks)
          const sum = r.amounts.reduce((s, m) => s + m, 0) + r.unassigned
          expect(sum).toBe(checkTotal(lines))
        },
      ),
    )
  })
})

describe('payments', () => {
  const cash = (balance: number, amount: number, tip: number, tendered: number) =>
    cashPayment({ balance, amount, tip, tendered })

  it('the payment that leaves the balance at 0 is rounded to $100, as in DINERO.md', () => {
    expect(cash(36_810, 36_810, 0, 40_000)).toMatchObject({
      charged: 36_800,
      adjustment: -10,
      change: 3_200,
    })
    expect(cash(36_850, 36_850, 0, 40_000)).toMatchObject({ charged: 36_800, adjustment: -50 })
    expect(cash(36_851, 36_851, 0, 40_000)).toMatchObject({
      charged: 36_900,
      adjustment: 49,
      change: 3_100,
    })
    expect(cash(36_860, 36_860, 0, 50_000)).toMatchObject({ change: 13_100 })
    expect(cash(36_800, 36_800, 0, 36_800)).toMatchObject({ adjustment: 0, change: 0, missing: 0 })
  })

  it('a balance of $30 or $50 is charged at $0', () => {
    expect(cash(30, 30, 0, 0)).toMatchObject({ charged: 0, adjustment: -30, missing: 0 })
    expect(cash(50, 50, 0, 0)).toMatchObject({ charged: 0, adjustment: -50 })
  })

  it('a partial payment (does not leave the balance at 0) is not rounded', () => {
    expect(cash(257_500, 100_050, 0, 100_050)).toMatchObject({ charged: 100_050, adjustment: 0 })
  })

  it('with a tip: what is missing and the change count the tip', () => {
    expect(cash(36_800, 36_800, 3_400, 40_000)).toMatchObject({
      amountDue: 40_200,
      change: 0,
      missing: 200,
    })
    expect(cash(257_500, 257_500, 23_800, 300_000)).toMatchObject({
      amountDue: 281_300,
      change: 18_700,
    })
  })

  it('rejects amounts outside the balance, negative or with decimals', () => {
    expect(() => cash(10_000, 0, 0, 10_000)).toThrow(RangeError)
    expect(() => cash(10_000, 10_001, 0, 20_000)).toThrow(RangeError)
    expect(() => cash(10_000, 10_000, -500, 10_000)).toThrow()
    expect(() => cash(10_000, 10_000, 0, 10_000.5)).toThrow()
    expect(() => cardPayment({ balance: 10_000, amount: 10_000, tip: 0.5 })).toThrow()
  })

  it('on a card terminal sale + tip is approved', () => {
    expect(cardPayment({ balance: 257_500, amount: 128_750, tip: 11_922 })).toEqual({
      approved: 140_672,
    })
  })

  it('it always balances: received = amount + adjustment + tip + change', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 500_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (balance, share, tip, extra) => {
          const amount = Math.max(1, Math.floor((balance * share) / 100))
          const base = cash(balance, amount, tip, 0)
          const tendered = base.amountDue + extra
          const r = cash(balance, amount, tip, tendered)
          expect(r.missing).toBe(0)
          expect(
            cashBalances({
              amount,
              roundingAdjustment: r.adjustment,
              tip,
              tendered,
              change: r.change,
            }),
          ).toBe(true)
        },
      ),
    )
  })
})
