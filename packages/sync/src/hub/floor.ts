import { DeviceMessage, type HubMessage, type PrinterStatus } from '../protocol'
import type { Connection, HubSync } from './hub'

/** Validates a device's token (task 0.7). `null` if it is not valid. */
export type Authenticator = (token: string) => Connection | null

interface Participant {
  connection: Connection | null
  send: (message: HubMessage) => void
}

/**
 * The open connections with the hub: translates messages into `HubSync` calls and broadcasts each
 * accepted event to every connected device (including the one that sent it, which discards it
 * by id).
 */
export class FloorSync {
  private readonly hub: HubSync
  private readonly authenticate: Authenticator
  private readonly participants = new Set<Participant>()
  /** Latest known printer status: told to each device that connects. */
  private printers: PrinterStatus[] = []

  constructor(hub: HubSync, authenticate: Authenticator) {
    this.hub = hub
    this.authenticate = authenticate
  }

  /** Opens a connection. Returns how to hand it the device's messages and how to close it. */
  connect(send: (message: HubMessage) => void): {
    receive: (raw: unknown) => void
    close: () => void
  } {
    const participant: Participant = { connection: null, send }
    this.participants.add(participant)
    return {
      receive: (raw) => this.receive(participant, raw),
      close: () => this.participants.delete(participant),
    }
  }

  /**
   * A device was revoked: its open connections stop receiving the floor right away and it is
   * notified. It can still deliver whatever it has pending (it goes to quarantine).
   */
  revoke(deviceId: string, revokedAt: string) {
    for (const p of this.participants) {
      if (p.connection?.deviceId !== deviceId) continue
      p.connection = { ...p.connection, revokedAt }
      try {
        p.send({
          type: 'error',
          code: 'revoked_token',
          message: 'Este equipo fue retirado del restaurante',
        })
      } catch {
        this.participants.delete(p)
      }
    }
  }

  /** Whether the table has an open order. */
  hasOpenOrder(tableId: string): boolean {
    return this.hub.hasOpenOrder(tableId)
  }

  /** Heartbeat for all connections (docs/SYNC.md: every 5 s). */
  beat() {
    for (const p of this.participants) if (p.connection) p.send({ type: 'heartbeat' })
  }

  /**
   * The catalog was edited: connected devices fetch it again
   * (docs/SYNC.md#catálogo-y-configuración).
   */
  notifyCatalog(version: number) {
    for (const p of this.participants)
      if (p.connection && !p.connection.revokedAt) p.send({ type: 'catalog', version })
  }

  /** The status of a ticket printer changed (ADR-015): all connected devices see it. */
  notifyPrinters(printers: PrinterStatus[]) {
    this.printers = printers
    for (const p of this.participants)
      if (p.connection && !p.connection.revokedAt) this.safeSend(p, { type: 'printers', printers })
  }

  private safeSend(participant: Participant, message: HubMessage) {
    try {
      participant.send(message)
    } catch {
      this.participants.delete(participant)
    }
  }

  private receive(participant: Participant, raw: unknown) {
    const parsed = DeviceMessage.safeParse(raw)
    if (!parsed.success) {
      participant.send({
        type: 'error',
        code: 'invalid_message',
        message: 'Mensaje con formato inesperado',
      })
      return
    }
    const message = parsed.data

    if (message.type === 'hello') {
      const connection = this.authenticate(message.token)
      if (!connection) {
        participant.send({
          type: 'error',
          code: 'invalid_token',
          message: 'Este equipo ya no tiene acceso al restaurante: hay que entrar otra vez',
        })
        return
      }
      participant.connection = connection
      participant.send(this.hub.welcomeMessage())
      if (this.printers.length > 0 && !connection.revokedAt)
        participant.send({ type: 'printers', printers: this.printers })
      return
    }
    if (message.type === 'ping') {
      participant.send({ type: 'pong', brand: message.brand })
      return
    }
    const connection = participant.connection
    if (!connection) {
      participant.send({
        type: 'error',
        code: 'invalid_token',
        message: 'Primero hay que saludar',
      })
      return
    }

    if (message.type === 'pull') {
      // A revoked device can deliver whatever it has pending (it goes to quarantine), but it no
      // longer reads anything from the floor.
      if (connection.revokedAt) {
        participant.send({
          type: 'error',
          code: 'revoked_token',
          message: 'Este equipo fue retirado del restaurante',
        })
        return
      }
      participant.send(this.hub.pull(message.from, connection.type, connection.deviceId))
      return
    }

    const { results, acceptedEvents } = this.hub.receiveBatch(connection, message.events)
    participant.send({ type: 'result', batch_id: message.batch_id, results })
    for (const event of acceptedEvents) {
      for (const other of this.participants) {
        const c = other.connection
        if (!c || c.revokedAt || !this.hub.sees(c.type, event)) continue
        try {
          other.send(this.hub.fresh(event, c.deviceId))
        } catch {
          // A broken connection must not leave the others without the event; it will catch up.
          this.participants.delete(other)
        }
      }
    }
  }
}
