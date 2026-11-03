import { vi } from 'vitest'
import type { ApiEnv } from '../api'
import { PanelLive } from '../live-object'
import { type FakeSocket, FakeState, stubRuntime } from './durable-object'
import { NOW } from './world'

// The live panel's rooms for the tests that need more than a recording fake: one real `PanelLive`
// per room name over a fake Workers runtime, as the Worker reaches them. The object checks session
// expiry against the wall clock (`Date.now()`), so `Date` is faked at the tests' `NOW`: otherwise
// the tests would start failing the day real time passes a session’s expiry. Afterwards call
// `vi.useRealTimers()` and `vi.unstubAllGlobals()`.

export interface Rooms {
  environment: Partial<ApiEnv>
  /** The sockets each room accepted (closed ones stay in the list, with `closed` set). */
  sockets(room: string): FakeSocket[]
  /** The rooms that were created, by name. */
  names(): string[]
  /** Waits for every notice the Worker left to `waitUntil`. */
  settle(): Promise<void>
  /** A room's object as a new instance over the same sockets (the runtime woke it up again). */
  wake(room: string): PanelLive
  /** Moves the wall clock (and nothing else) to this instant. */
  setNow(now: Date): void
  /** Evicts every object, as a deploy does: the sockets are gone, the next call starts fresh. */
  deploy(): void
}

export function realRooms(): Rooms {
  stubRuntime()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  const states = new Map<string, FakeState>()
  const objects = new Map<string, PanelLive>()
  const pending: Promise<unknown>[] = []
  const object = (room: string) => {
    let o = objects.get(room)
    if (!o) {
      let state = states.get(room)
      if (!state) {
        state = new FakeState()
        states.set(room, state)
      }
      o = new PanelLive(state, {})
      objects.set(room, o)
    }
    return o
  }
  return {
    environment: {
      live: {
        connect: (room, request) => object(room).fetch(request),
        notify: (room, reason) => object(room).notify(reason),
        closeSession: (room, id) => object(room).closeSession(id),
      },
      waitUntil: (p) => void pending.push(p),
    },
    sockets: (room) => states.get(room)?.sockets ?? [],
    names: () => [...states.keys()],
    settle: async () => {
      while (pending.length > 0) await Promise.all(pending.splice(0))
    },
    wake: (room) => {
      const state = states.get(room)
      if (!state) throw new Error(`no room ${room}`)
      const o = new PanelLive(state, {})
      objects.set(room, o)
      return o
    },
    setNow: (now) => {
      vi.setSystemTime(now)
    },
    deploy: () => {
      states.clear()
      objects.clear()
    },
  }
}
