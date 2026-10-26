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
  lineNet,
  tipOn,
  trimAssignments,
} from './check'

const l = (id: string, quantity: number, unitPrice: number, extras: number[] = []) => ({
  id,
  quantity,
  unitPrice,
  extras,
})

describe('check: total, balance and tip (edges)', () => {
  it('the net of a line adds the extras: 2 × (39.900 + 3.000) = 85.800', () => {
    expect(lineNet(l('a', 2, 39_900, [3_000]))).toBe(85_800)
  })

  it('the example order of table 12 adds up to 257.500 and its tip is 23.843', () => {
    const table12 = [
      l('a', 1, 44_900),
      l('b', 1, 40_900),
      l('c', 1, 27_900),
      l('d', 1, 129_900),
      l('e', 1, 13_900),
    ]
    expect(checkTotal(table12)).toBe(257_500)
    expect(tipOn(checkTotal(table12))).toBe(23_843)
  })

  it('the tip uses a single rounding: 2.500 → 231 (not 232)', () => {
    expect(tipOn(2_500)).toBe(231)
  })

  it('a negative or zero balance leaves no tip', () => {
    expect(tipOn(0)).toBe(0)
    expect(tipOn(-1_000)).toBe(0)
  })

  it('checkTotal rejects an order over the limit', () => {
    expect(() => checkTotal([l('a', 999, 100_000_000)])).toThrow(RangeError)
  })

  it('balanceOf: several payments, and with no payments it is the total', () => {
    expect(balanceOf(257_500, [])).toBe(257_500)
    expect(balanceOf(257_500, [{ amount: 100_000 }, { amount: 57_500 }])).toBe(100_000)
    expect(balanceOf(257_500, [{ amount: 257_500 }])).toBe(0)
  })

  it('cash tip: the exact half goes in favor of the guest and 0 stays at 0', () => {
    expect(cashTip(0)).toBe(0)
    expect(cashTip(49)).toBe(0)
    expect(cashTip(50)).toBe(0)
    expect(cashTip(51)).toBe(100)
    expect(cashTip(100)).toBe(100)
  })
})

describe('check: equal parts and tips per check', () => {
  it('one person pays everything; a 0 balance allocates zeros', () => {
    expect(inEqualParts(257_500, 1)).toEqual([257_500])
    expect(inEqualParts(0, 4)).toEqual([0, 0, 0, 0])
  })

  it('257.500 among 3: the leftover peso goes to the first check', () => {
    expect(inEqualParts(257_500, 3)).toEqual([85_834, 85_833, 85_833])
  })

  it('the tips of the checks add up to the tip of the balance (23.843 between 2 → 11.922 + 11.921)', () => {
    const tips = checkTips(inEqualParts(257_500, 2))
    expect(tips).toEqual([11_922, 11_921])
  })

  it('for any number of people, the tips add up to the tip of the balance', () => {
    for (let people = 2; people <= 20; people++) {
      const amounts = inEqualParts(257_500, people)
      const tips = checkTips(amounts)
      expect(tips.reduce((a, b) => a + b, 0)).toBe(tipOn(257_500))
    }
  })

  it('with no amounts to allocate, every tip is 0', () => {
    expect(checkTips([0, 0])).toEqual([0, 0])
    expect(checkTips([])).toEqual([])
  })
})

describe('check: by items (edges)', () => {
  it('with no assignment at all everything stays unassigned', () => {
    const r = byItems([l('a', 1, 10_000)], new Map(), 2)
    expect(r).toEqual({ amounts: [0, 0], unassigned: 10_000 })
  })

  it('the wine shared by two checks of table 12 leaves 137.750 and 119.750', () => {
    const lines = [
      l('quattro', 1, 44_900),
      l('tagliata', 1, 40_900),
      l('patatine', 1, 27_900),
      l('vino', 1, 129_900),
      l('te', 1, 13_900),
    ]
    const r = byItems(
      lines,
      new Map([
        ['quattro', [0]],
        ['patatine', [0]],
        ['tagliata', [1]],
        ['te', [1]],
        ['vino', [0, 1]],
      ]),
      2,
    )
    expect(r).toEqual({ amounts: [137_750, 119_750], unassigned: 0 })
  })

  it('an assignment to a check that does not exist is rejected in the calculation (that is why it is trimmed first)', () => {
    expect(() => byItems([l('a', 1, 1_000)], new Map([['a', [2]]]), 2)).toThrow(RangeError)
  })

  it('trimming does not touch what is still valid nor mutate the original map', () => {
    const original = new Map([['a', [0, 1]]])
    expect([...trimAssignments(original, 2)]).toEqual([['a', [0, 1]]])
    trimAssignments(original, 1)
    expect(original.get('a')).toEqual([0, 1])
  })

  it('trimming to one check leaves only the first and removes items left without an owner', () => {
    const r = trimAssignments(
      new Map([
        ['a', [0, 1]],
        ['b', [1]],
      ]),
      1,
    )
    expect([...r]).toEqual([['a', [0]]])
  })
})

describe('check: payments (edges)', () => {
  it('the partial payment is not rounded and the final one is: 128.750 + 128.750 → 128.700 is charged', () => {
    const partialPayment = cashPayment({
      balance: 257_500,
      amount: 128_750,
      tip: 11_900,
      tendered: 0,
    })
    expect(partialPayment).toMatchObject({ charged: 128_750, adjustment: 0, amountDue: 140_650 })
    const final = cashPayment({ balance: 128_750, amount: 128_750, tip: 11_900, tendered: 0 })
    expect(final).toMatchObject({ charged: 128_700, adjustment: -50, amountDue: 140_600 })
  })

  it('the same amount with a larger balance is never rounded even if it ends in 50', () => {
    expect(
      cashPayment({ balance: 100_000, amount: 36_850, tip: 0, tendered: 36_850 }).adjustment,
    ).toBe(0)
  })

  it('tendered 0 with no tip and amount > 0 is missing everything charged', () => {
    expect(cashPayment({ balance: 10_000, amount: 10_000, tip: 0, tendered: 0 })).toMatchObject({
      amountDue: 10_000,
      missing: 10_000,
      change: 0,
    })
  })

  it('the change can go to tip and then the check balances again with no change', () => {
    const before = cashPayment({
      balance: 257_500,
      amount: 257_500,
      tip: 23_800,
      tendered: 300_000,
    })
    expect(before.change).toBe(18_700)
    const after = cashPayment({
      balance: 257_500,
      amount: 257_500,
      tip: 23_800 + before.change,
      tendered: 300_000,
    })
    expect(after).toMatchObject({ change: 0, missing: 0, amountDue: 300_000 })
  })

  it('card: sale + tip; rejects amount 0 or over the balance and a negative tip', () => {
    expect(cardPayment({ balance: 100, amount: 100, tip: 0 })).toEqual({ approved: 100 })
    expect(() => cardPayment({ balance: 100, amount: 0, tip: 0 })).toThrow(RangeError)
    expect(() => cardPayment({ balance: 100, amount: 101, tip: 0 })).toThrow(RangeError)
    expect(() => cardPayment({ balance: 100, amount: 100, tip: -1 })).toThrow()
  })
})
