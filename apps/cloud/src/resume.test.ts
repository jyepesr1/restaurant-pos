import { newId } from '@pos/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { CODE_TTL_MS } from './cloud'
import { batch, count, createWorld, flatEvent, NOW, statuses, type World } from './testing/world'

// A register PC connected again (task 1.11): the cloud counts what it resends, and the code is
// tied to the restaurant of the hub that types it. Extra cases on top of the idempotency and
// registration files.

let m: World
beforeAll(async () => {
  m = await createWorld()
})

const registration = (code: string, restaurantId: string, hubId = newId()) => ({
  code,
  restaurant_id: restaurantId,
  hub_id: hubId,
  location_id: newId(),
  name: 'Caja',
  instance: 'i',
})

describe('the confirmed sequence of a hub registered again', () => {
  it('counts what it resends in ascending batches of any size, without gaps', async () => {
    const first = await m.newHub()
    await m.cloud.receiveEvents(first.hub, batch(1, 40))
    await m.cloud.revokeHub(first.hub.id)
    const again = await m.newHub(first.restaurantId)
    const sizes = [1, 7, 12, 20]
    let from = 1
    for (const size of sizes) {
      await m.cloud.receiveEvents(again.hub, batch(from, size))
      from += size
      expect(await m.cloud.lastSequence(again.hub)).toBe(from - 1)
    }
    expect(await count(m.db, 'events', first.restaurantId)).toBe(40)
  })

  it('counts a resend in small batches with repeats inside each batch', async () => {
    const first = await m.newHub()
    await m.cloud.receiveEvents(first.hub, batch(1, 20))
    const again = await m.newHub(first.restaurantId)
    for (let from = 1; from <= 20; from += 5) {
      const events = batch(from, 5)
      const results = await m.cloud.receiveEvents(again.hub, [...events, ...events.slice(0, 2)])
      expect(statuses(results).every((s) => s === 'already_stored')).toBe(true)
    }
    expect(await m.cloud.lastSequence(again.hub)).toBe(20)
    expect(await count(m.db, 'events', first.restaurantId)).toBe(20)
  })

  it('a resend that mixes stored and new events counts both', async () => {
    const first = await m.newHub()
    await m.cloud.receiveEvents(first.hub, batch(1, 10))
    const again = await m.newHub(first.restaurantId)
    const results = await m.cloud.receiveEvents(again.hub, batch(1, 16))
    expect(statuses(results).filter((s) => s === 'saved')).toHaveLength(6)
    expect(statuses(results).filter((s) => s === 'already_stored')).toHaveLength(10)
    expect(await m.cloud.lastSequence(again.hub)).toBe(16)
  })

  it('a divergent event stops the count where it is, and what comes after does not skip it', async () => {
    const first = await m.newHub()
    await m.cloud.receiveEvents(first.hub, batch(1, 10))
    const again = await m.newHub(first.restaurantId)
    const events = batch(1, 20)
    events[4] = flatEvent(5, { data: { quantity: 99, notes: 'distinto' } })
    const results = await m.cloud.receiveEvents(again.hub, events)
    expect(results[4]?.status).toBe('divergent')
    expect(await m.cloud.lastSequence(again.hub)).toBe(4)
    // Sending the rest again changes nothing.
    await m.cloud.receiveEvents(again.hub, batch(6, 15))
    expect(await m.cloud.lastSequence(again.hub)).toBe(4)
    expect(await count(m.db, 'events', first.restaurantId)).toBe(20)
  })

  it('never goes backwards: a second resend of the beginning does not lower it', async () => {
    const first = await m.newHub()
    await m.cloud.receiveEvents(first.hub, batch(1, 30))
    await m.cloud.receiveEvents(first.hub, batch(1, 5))
    expect(await m.cloud.lastSequence(first.hub)).toBe(30)
  })

  it('a hub that resends nothing yet reads zero even if the restaurant has thousands', async () => {
    const first = await m.newHub()
    await m.cloud.receiveEvents(first.hub, batch(1, 100))
    const again = await m.newHub(first.restaurantId)
    expect(await m.cloud.lastSequence(again.hub)).toBe(0)
    const answer = await m.request('GET', '/v1/events/last', undefined, again.credential)
    expect(await answer.json()).toEqual({ last_sequence: 0 })
  })

  it("two restaurants resending the same sequences do not count each other's events", async () => {
    const a = await m.newHub()
    const b = await m.newHub()
    await m.cloud.receiveEvents(a.hub, batch(1, 10))
    expect(await m.cloud.lastSequence(b.hub)).toBe(0)
    // Same sequence numbers, different ids: they are b's own events.
    await m.cloud.receiveEvents(
      b.hub,
      batch(1000, 3).map((e, i) => ({ ...e, sequence: i + 1 })),
    )
    expect(await m.cloud.lastSequence(b.hub)).toBe(3)
    expect(await m.cloud.lastSequence(a.hub)).toBe(10)
  })
})

describe('the restaurant of the hub that registers', () => {
  const sendRegistration = (body: object) => m.request('POST', '/v1/hubs/register', body)

  async function restaurantAndCode() {
    const restaurant = newId()
    await m.cloud.createRestaurant({ id: restaurant, name: 'R' })
    const c = await m.cloud.createCode(restaurant)
    if (!c) throw new Error('no code')
    return { restaurant, code: c.code }
  }

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too short', 'ABC'],
    ['lower case', '01arz3ndektsv4rrffq69g5fav'],
    ['not text', 12],
    ['null', null],
  ])('a restaurant_id that is %s is a bad request and the code is not spent', async (_, id) => {
    const { restaurant, code } = await restaurantAndCode()
    const body = registration(code, restaurant) as Record<string, unknown>
    if (id === undefined) delete body.restaurant_id
    else body.restaurant_id = id
    expect((await sendRegistration(body)).status).toBe(400)
    expect((await sendRegistration(registration(code, restaurant))).status).toBe(201)
  })

  it('a restaurant that does not exist is refused as «other restaurant»', async () => {
    const { code } = await restaurantAndCode()
    const r = await sendRegistration(registration(code, newId()))
    expect(r.status).toBe(403)
    expect(((await r.json()) as { error: string }).error).toBe('other_restaurant')
  })

  it('an expired code is «invalid», not «other restaurant», whoever asks', async () => {
    const { code } = await restaurantAndCode()
    try {
      m.clock.now = new Date(NOW.getTime() + 2 * CODE_TTL_MS)
      const r = await sendRegistration(registration(code, newId()))
      expect(((await r.json()) as { error: string }).error).toBe('invalid_code')
    } finally {
      m.clock.now = NOW
    }
  })

  it('an unknown code is «invalid», not «other restaurant»', async () => {
    const r = await sendRegistration(registration('NADA-NADA-NADA', newId()))
    expect(((await r.json()) as { error: string }).error).toBe('invalid_code')
  })

  it('repeating with another restaurant after registering does not rotate the credential', async () => {
    const { restaurant, code } = await restaurantAndCode()
    const hubId = newId()
    const ok = await sendRegistration(registration(code, restaurant, hubId))
    const { credential } = (await ok.json()) as { credential: string }
    const wrong = await sendRegistration(registration(code, newId(), hubId))
    expect(wrong.status).toBe(403)
    const uploads = await m.request('GET', '/v1/events/last', undefined, credential)
    expect(uploads.status).toBe(200)
  })

  it('two hubs asking at once with the same code: one registers, the other is refused', async () => {
    const { restaurant, code } = await restaurantAndCode()
    const answers = await Promise.all([
      sendRegistration(registration(code, restaurant)),
      sendRegistration(registration(code, restaurant)),
    ])
    expect(answers.map((a) => a.status).sort()).toEqual([201, 403])
  })

  it('the answer says which restaurant the hub joined, and it is the one the hub asked for', async () => {
    const { restaurant, code } = await restaurantAndCode()
    const r = await sendRegistration(registration(code, restaurant))
    expect(((await r.json()) as { restaurant_id: string }).restaurant_id).toBe(restaurant)
  })
})
