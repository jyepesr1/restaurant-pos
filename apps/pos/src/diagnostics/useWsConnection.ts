import { useEffect, useState } from 'react'
import { recordEvent } from './log'

const PING_INTERVAL_MS = 5000
/** The hub sends a heartbeat every 5 s: three cycles with nothing mean a dead connection. */
const NO_RESPONSE_MS = 15_000
const WATCHDOG_INTERVAL_MS = 1000
const MAX_RECONNECT_WAIT_MS = 5000
/**
 * A connection attempt made with the screen locked can hang without opening or failing
 * (seen on Android: ~30 s). After this time it is abandoned and tried again.
 */
const MAX_CONNECTION_TIME_MS = 4000
/** Back from the background: how long to wait for a reply to consider the connection alive. */
const CHECK_WAIT_MS = 3000
const MAX_SAMPLES = 200

export type ChannelState = 'connecting' | 'connected' | 'no-response' | 'disconnected'

export interface Latency {
  lastMs: number
  medianMs: number
  maxMs: number
  samples: number
}

export interface WsState {
  channel: ChannelState
  latency: Latency | null
}

function computeLatency(samples: number[]): Latency | null {
  const lastMs = samples.at(-1)
  if (lastMs === undefined) return null
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    lastMs,
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? lastMs,
    maxMs: sorted.at(-1) ?? lastMs,
    samples: samples.length,
  }
}

/**
 * Keeps a WebSocket with the hub, measures latency, detects dead connections and reconnects
 * on its own. It also logs every time the screen is hidden and, on return, checks whether the
 * connection survived: that is what we want to measure on each phone.
 */
export function useWsConnection(): WsState {
  const [status, setStatus] = useState<WsState>({ channel: 'connecting', latency: null })

  useEffect(() => {
    let active = true
    let socket: WebSocket | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    let openings = 0
    let closings = 0
    let lastMessageAt = Date.now()
    // Every hide invalidates in-flight pings: their latency would include the time asleep.
    let generation = 0
    const samples: number[] = []

    let hiddenSince: number | null = null
    let visibleSince: number | null = null
    let closingsOnHide = 0
    let pendingCheck: { gotMessage: boolean; finish: () => void } | undefined

    const changeChannel = (channel: ChannelState) =>
      setStatus((previous) => (previous.channel === channel ? previous : { ...previous, channel }))

    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
      const fresh = new WebSocket(`${protocol}://${location.host}/api/diagnostics/ws`)
      socket = fresh
      const connectTimeout = setTimeout(() => {
        if (fresh.readyState === WebSocket.CONNECTING) {
          discard(fresh, { reason: 'timed-out' }, 'disconnected')
        }
      }, MAX_CONNECTION_TIME_MS)

      fresh.onopen = () => {
        clearTimeout(connectTimeout)
        attempts = 0
        lastMessageAt = Date.now()
        // How long the connection took to recover since the user came back to the screen.
        const recovery = visibleSince === null ? {} : { msSinceVisible: Date.now() - visibleSince }
        visibleSince = null
        recordEvent('ws-open', { reconnections: openings, ...recovery })
        openings += 1
        changeChannel('connected')
      }

      fresh.onmessage = ({ data }) => {
        lastMessageAt = Date.now()
        if (pendingCheck) pendingCheck.gotMessage = true
        changeChannel('connected')

        const text = String(data)
        if (!text.startsWith('pong:')) return
        const [gen, sent] = text.slice('pong:'.length).split(':').map(Number)
        if (gen !== generation || document.hidden || sent === undefined) return
        samples.push(Math.round(performance.now() - sent))
        if (samples.length > MAX_SAMPLES) samples.shift()
        setStatus((previous) => ({ ...previous, latency: computeLatency(samples) }))
      }

      fresh.onclose = ({ code }) => {
        clearTimeout(connectTimeout)
        onClose(fresh, { code: code })
      }
    }

    /** Releases a socket no longer in use: its late events must not affect the state. */
    function release(staleSocket: WebSocket) {
      staleSocket.onopen = null
      staleSocket.onmessage = null
      staleSocket.onclose = null
      staleSocket.close()
    }

    /** Abandons a hung or dead socket without waiting for the browser to close it. */
    function discard(
      staleSocket: WebSocket,
      detail: Record<string, unknown>,
      channel: ChannelState,
    ) {
      onClose(staleSocket, detail, channel)
      release(staleSocket)
    }

    /** Connects now, without waiting for the scheduled retry (the browser may have frozen it). */
    function reconnectImmediately() {
      clearTimeout(retry)
      attempts = 0
      connect()
    }

    function onClose(
      closed: WebSocket,
      detail: Record<string, unknown>,
      channel: ChannelState = 'disconnected',
    ) {
      // An old socket that was already replaced does not count.
      if (!active || closed !== socket) return
      closings += 1
      recordEvent('ws-closed', detail)
      changeChannel(channel)
      attempts += 1
      retry = setTimeout(connect, Math.min(1000 * attempts, MAX_RECONNECT_WAIT_MS))
    }

    const ping = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN && !document.hidden) {
        socket.send(`ping:${generation}:${performance.now()}`)
      }
    }, PING_INTERVAL_MS)

    // The browser can take minutes to report that a connection died (Wi-Fi down without a
    // clean close): if nothing arrives for a good while, it is dropped and another one is opened.
    const watchdog = setInterval(() => {
      if (document.hidden || socket?.readyState !== WebSocket.OPEN) return
      if (Date.now() - lastMessageAt < NO_RESPONSE_MS) return
      discard(socket, { reason: 'no-response' }, 'no-response')
    }, WATCHDOG_INTERVAL_MS)

    function onVisibilityChange() {
      if (document.hidden) {
        pendingCheck?.finish()
        generation += 1
        visibleSince = null
        hiddenSince = Date.now()
        closingsOnHide = closings
        recordEvent('hidden')
        return
      }

      if (hiddenSince === null) return
      const returnedAt = Date.now()
      const durationMs = returnedAt - hiddenSince
      hiddenSince = null
      // After sleeping, the watchdog must not kill the connection before messages arrive.
      lastMessageAt = returnedAt
      // Every reconnection from now on is measured from when the user came back.
      visibleSince = returnedAt
      const openOnReturn = socket?.readyState === WebSocket.OPEN
      // Only this socket (the one that survived the lock) can turn out silent; one reopened after
      // coming back has not received anything yet because the hub sends no messages on open.
      const socketOnReturn = openOnReturn ? socket : undefined
      if (openOnReturn) {
        socket?.send(`ping:${generation}:${performance.now()}`)
      } else {
        // No connection on return: do not wait for the retry or for an attempt hung while asleep.
        if (socket?.readyState === WebSocket.CONNECTING) {
          discard(socket, { reason: 'retry-on-return' }, 'connecting')
        } else if (socket) {
          release(socket)
        }
        reconnectImmediately()
      }

      const current = {
        gotMessage: false,
        finish: () => {
          clearTimeout(limit)
          if (pendingCheck !== current) return
          pendingCheck = undefined
          const keptConnection = openOnReturn && current.gotMessage && closings === closingsOnHide
          recordEvent('visible', { durationMs, keptConnection, openOnReturn })
          if (keptConnection) {
            visibleSince = null
            return
          }
          // Open but silent after returning (typical on iPhone): dead. Don't wait for the watchdog.
          const muted =
            socket === socketOnReturn &&
            socket?.readyState === WebSocket.OPEN &&
            !current.gotMessage
          if (!document.hidden && socket && muted) {
            discard(socket, { reason: 'no-response-on-return' }, 'no-response')
            reconnectImmediately()
          }
        },
      }
      const limit = setTimeout(() => current.finish(), CHECK_WAIT_MS)
      pendingCheck = current
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    connect()

    return () => {
      active = false
      document.removeEventListener('visibilitychange', onVisibilityChange)
      clearInterval(ping)
      clearInterval(watchdog)
      clearTimeout(retry)
      socket?.close()
    }
  }, [])

  return status
}
