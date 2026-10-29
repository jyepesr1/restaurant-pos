import { type NewEvent, newId, type OrderEventType } from '@pos/core'
import { SyncClient } from '../device/client'
import { MemoryDeviceStore } from '../device/store'
import type { FloorSync } from '../hub/floor'
import type { Connection } from '../hub/hub'
import type { DeviceMessage, HubMessage } from '../protocol'

// Simulated network for the scenarios in docs/SYNC.md: several devices and an in-memory hub,
// with messages that can be cut, lost or duplicated, and a hub that can crash and come back.

type Rule = {
  direction: 'to_hub' | 'to_device'
  type: string
  action: 'drop' | 'duplicate'
  times: number
}

/** Copies as if it traveled over the network: only what survives JSON. */
const overNetwork = <T>(m: T): T => JSON.parse(JSON.stringify(m))

export class NetNode {
  readonly name: string
  readonly deviceId: string
  readonly userId = newId()
  readonly client: SyncClient
  readonly store: MemoryDeviceStore
  /** Device clock offset, in ms. */
  offsetMs = 0
  toHub: DeviceMessage[] = []
  toDevice: HubMessage[] = []
  link: { receive: (raw: unknown) => void; close: () => void } | null = null
  rules: Rule[] = []
  private readonly network: SimulatedNetwork

  constructor(
    network: SimulatedNetwork,
    name: string,
    token: string,
    store = new MemoryDeviceStore(),
  ) {
    this.network = network
    this.name = name
    this.deviceId = network.tokens.get(token)?.deviceId ?? newId()
    this.store = store
    this.client = new SyncClient({
      store,
      token,
      versionApp: 'test',
      now: () => this.network.now() + this.offsetMs,
      send: (m) => {
        if (this.link) this.toHub.push(overNetwork(m))
      },
    })
  }

  get online() {
    return this.link !== null
  }

  async connect() {
    this.link = this.network.floor.connect((m) => this.toDevice.push(overNetwork(m)))
    await this.client.onConnect()
  }

  disconnect() {
    this.link?.close()
    this.link = null
    this.toHub = []
    this.toDevice = []
    this.client.onDisconnect()
  }

  /** Creates and records an event the way the device app would. */
  async create<T extends OrderEventType>(
    orderId: string,
    type: T,
    data: Extract<NewEvent, { type: T }>['data'],
    extras: Partial<NewEvent> = {},
  ): Promise<NewEvent> {
    const time = new Date(this.network.now() + this.offsetMs).toISOString()
    const estimated = this.client.hubEstimatedTime()
    const event = {
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: orderId,
      related: [],
      data,
      session_id: null,
      user_id: this.userId,
      device_id: this.deviceId,
      authorization_id: null,
      reason: null,
      device_time: time,
      hub_estimated_time: estimated,
      base_sequence: await this.client.known(),
      ...extras,
    } as NewEvent
    const r = await this.client.record(event)
    if (!r.ok) throw new Error(`Invalid event in the test: ${r.errors.join('; ')}`)
    return event
  }

  /** The next time a message of that type goes through, it is lost or duplicated. */
  rule(direction: Rule['direction'], type: string, action: Rule['action'], times = 1) {
    this.rules.push({ direction, type, action, times })
  }

  /** Applies the rules to a message: how many copies are delivered (0, 1 or 2). */
  copies(direction: Rule['direction'], type: string): number {
    const rule = this.rules.find((r) => r.direction === direction && r.type === type && r.times > 0)
    if (!rule) return 1
    rule.times -= 1
    return rule.action === 'drop' ? 0 : 2
  }
}

export class SimulatedNetwork {
  floor: FloorSync
  readonly nodes: NetNode[] = []
  readonly tokens = new Map<string, Connection>()
  private clock = Date.parse('2026-10-24T20:00:00.000Z')
  /** Called if the hub throws while processing a message: simulates the hub process crashing. */
  onHubCrash: (() => FloorSync) | null = null

  constructor(floor: FloorSync) {
    this.floor = floor
  }

  now = () => this.clock
  isoTime = () => new Date(this.clock).toISOString()
  advance(ms: number) {
    this.clock += ms
  }

  /** Authenticator for the test hub. */
  authenticate = (token: string): Connection | null => this.tokens.get(token) ?? null

  device(name: string, store?: MemoryDeviceStore): NetNode {
    const token = `token-${name}`
    if (!this.tokens.has(token))
      this.tokens.set(token, { deviceId: newId(), type: 'waiter', revokedAt: null })
    const node = new NetNode(this, name, token, store)
    this.nodes.push(node)
    return node
  }

  /**
   * Delivers a message to the hub (with the loss and duplicate rules). If the hub throws, it
   * crashes.
   */
  private deliverToHub(node: NetNode, m: DeviceMessage) {
    for (let i = 0; i < node.copies('to_hub', m.type); i++) {
      try {
        node.link?.receive(m)
      } catch {
        this.crashHub()
        return
      }
    }
  }

  private async deliverToDevice(node: NetNode, m: HubMessage) {
    for (let i = 0; i < node.copies('to_device', m.type); i++) await node.client.receive(m)
  }

  /**
   * Delivers a single in-flight message (the first one, or the one at position `index`, which
   * allows reordering). Returns `false` if there was none.
   */
  async deliverOne(node: NetNode, direction: Rule['direction'], index = 0): Promise<boolean> {
    if (direction === 'to_hub') {
      if (!node.link || node.toHub.length === 0) return false
      const [m] = node.toHub.splice(index % node.toHub.length, 1)
      this.deliverToHub(node, m as DeviceMessage)
      return true
    }
    if (node.toDevice.length === 0) return false
    const [m] = node.toDevice.splice(index % node.toDevice.length, 1)
    await this.deliverToDevice(node, m as HubMessage)
    return true
  }

  /** Delivers messages in both directions until none are left in flight. */
  async settle(maxRounds = 1000) {
    for (let round = 0; round < maxRounds; round++) {
      let happened = false
      for (const node of this.nodes) {
        while (node.toHub.length > 0 && node.link) {
          happened = true
          this.deliverToHub(node, node.toHub.shift() as DeviceMessage)
        }
        while (node.toDevice.length > 0) {
          happened = true
          await this.deliverToDevice(node, node.toDevice.shift() as HubMessage)
        }
      }
      await Promise.all(this.nodes.map((n) => n.client.ready()))
      if (!happened) return
    }
    throw new Error('The network did not settle')
  }

  /** The hub process crashes: all connections drop and it comes back with what it saved. */
  crashHub() {
    for (const node of this.nodes) node.disconnect()
    if (!this.onHubCrash) throw new Error('The hub crashed and the test gave no way to restart it')
    this.floor = this.onHubCrash()
  }

  async connectAll() {
    for (const node of this.nodes) if (!node.online) await node.connect()
    await this.settle()
  }
}
