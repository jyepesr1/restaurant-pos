import { type NewEvent, newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { FloorSync } from './hub/floor'
import { type AccessControl, type AccessVerdict, type Connection, HubSync } from './hub/hub'
import { MemoryStore } from './hub/store'
import type { HubMessage } from './protocol'

// How the hub uses its access control (the real implementation is in apps/hub).

const NOW = '2026-10-24T20:00:00.000Z'
const connection: Connection = { deviceId: newId(), type: 'waiter', revokedAt: null }
const user = newId()

const open = (extras = {}) => ({
  id: newId(),
  type: 'OrderOpened',
  schema_version: 1,
  aggregate_type: 'order',
  aggregate_id: newId(),
  related: [],
  data: { channel: 'bar', table_id: null, guests: 1 },
  session_id: newId(),
  user_id: user,
  device_id: connection.deviceId,
  authorization_id: null,
  reason: null,
  device_time: NOW,
  hub_estimated_time: NOW,
  base_sequence: 0,
  ...extras,
})

/** Access control that answers whatever the test says and logs what was used. */
function access(verdict: (event: NewEvent) => AccessVerdict) {
  const usageLog: string[] = []
  const control: AccessControl = {
    verify: (_c, event) => verdict(event),
    recordUse: (event) => usageLog.push(event.id),
  }
  return { control, usageLog }
}

function hubWith(control: AccessControl, store = new MemoryStore()) {
  const hub = new HubSync(store, {
    restaurantId: '',
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    instance: 'hub-1',
    clock: () => NOW,
    access: control,
  })
  return { hub, store }
}

describe('hub with access control', () => {
  it('without permission it is rejected with the control reason and nothing is used', () => {
    const { control, usageLog } = access(() => ({ ok: false, reason: 'no_permission' }))
    const { hub, store } = hubWith(control)
    const r = hub.receiveBatch(connection, [open()])

    expect(r.results[0]).toMatchObject({ status: 'rejected', reason: 'no_permission' })
    expect(store.events).toHaveLength(0)
    expect(usageLog).toEqual([])
  })

  it('an unknown session goes to quarantine', () => {
    const { control } = access(() => ({
      ok: false,
      reason: 'unknown_session',
      quarantine: true,
    }))
    const { hub, store } = hubWith(control)
    const r = hub.receiveBatch(connection, [open()])

    expect(r.results[0]).toMatchObject({ status: 'quarantine' })
    expect(store.quarantines[0]?.reason).toBe('unknown_session')
  })

  it('with an approval, the supervisor lands in `authorized_by_id` and the use is recorded on save', () => {
    const supervisor = newId()
    const { control, usageLog } = access(() => ({
      ok: true,
      authorizedById: supervisor,
      authorizationId: newId(),
    }))
    const { hub, store } = hubWith(control)
    const event = open()
    const r = hub.receiveBatch(connection, [event])

    expect(r.results[0]).toMatchObject({
      status: 'confirmed',
      acceptance: { authorized_by_id: supervisor },
    })
    expect(store.events[0]?.event.authorized_by_id).toBe(supervisor)
    expect(usageLog).toEqual([event.id])
  })

  it('an already confirmed resend does not go through the control again', () => {
    let calls = 0
    const { control, usageLog } = access(() => {
      calls += 1
      return { ok: true, authorizedById: null, authorizationId: null }
    })
    const { hub } = hubWith(control)
    const event = open()
    hub.receiveBatch(connection, [event])
    hub.receiveBatch(connection, [event])

    expect(calls).toBe(1)
    expect(usageLog).toHaveLength(1)
  })

  it('if the event is rejected by another rule, the approval is not used', () => {
    const { control, usageLog } = access(() => ({
      ok: true,
      authorizedById: null,
      authorizationId: newId(),
    }))
    const { hub } = hubWith(control)
    const r = hub.receiveBatch(connection, [open({ type: 'GuestsChanged', data: { guests: 3 } })])

    expect(r.results[0]).toMatchObject({ status: 'rejected', reason: 'order_not_found' })
    expect(usageLog).toEqual([])
  })
})

describe('floor: live revoke', () => {
  it('notifies the device, stops broadcasting to it and cuts off its `pull`', () => {
    const { control } = access(() => ({ ok: true, authorizedById: null, authorizationId: null }))
    const { hub } = hubWith(control)
    const other: Connection = { deviceId: newId(), type: 'register', revokedAt: null }
    const tokens = new Map([
      ['t-ana', { ...connection }],
      ['t-caja', other],
    ])
    const floor = new FloorSync(hub, (token) => tokens.get(token) ?? null)
    const toAna: HubMessage[] = []
    const ana = floor.connect((m) => toAna.push(m))
    const register = floor.connect(() => {})
    ana.receive({ type: 'hello', token: 't-ana', hub_instance: null, until: 0, version_app: 'x' })
    register.receive({
      type: 'hello',
      token: 't-caja',
      hub_instance: null,
      until: 0,
      version_app: 'x',
    })
    toAna.length = 0

    floor.revoke(connection.deviceId, NOW)
    register.receive({
      type: 'push',
      batch_id: 'l1',
      events: [open({ device_id: other.deviceId })],
    })
    ana.receive({ type: 'pull', from: 0 })

    expect(toAna.map((m) => (m.type === 'error' ? m.code : m.type))).toEqual([
      'revoked_token',
      'revoked_token',
    ])
  })
})
