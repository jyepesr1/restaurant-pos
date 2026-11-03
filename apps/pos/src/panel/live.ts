import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import { documentVisibility, type Visibility } from './visibility'

// The panel «en vivo» (task 1.11c-2, docs/PANEL.md#aviso-en-vivo-websocket): one WebSocket per tab, open while
// there is a session and the tab is in view. The cloud only says «something changed»; each screen
// then reads again from the API (poller.ts). The socket is a shortcut, never the truth: if it
// drops, the screens keep polling (every 15 s instead of every 60 s).

/** `connecting`: opening for the first time (or back in view); `down`: waiting to reconnect. */
export type LiveState = 'connecting' | 'live' | 'down'

/** What the screens see of the connection. */
export interface LiveFeed {
  state(): LiveState
  /** `changed`: read again; `state`: the connection changed. Returns how to stop listening. */
  subscribe(listener: LiveListener): () => void
}

export interface LiveListener {
  changed?: () => void
  state?: (state: LiveState) => void
}

export interface LiveConnection extends LiveFeed {
  start(): void
  stop(): void
}

/** The part of the browser's WebSocket this code uses (a fake one in the tests). */
export interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number }) => void) | null
  onerror: ((event: unknown) => void) | null
}

/** The browser coming back online (`online` on window). */
export interface Network {
  subscribe(online: () => void): () => void
}

export const browserNetwork: Network = {
  subscribe: (online) => {
    window.addEventListener('online', online)
    return () => window.removeEventListener('online', online)
  },
}

const OPEN = 1

/** The app's ping (the auto-response answers «pong» without waking the Durable Object). */
export const PING_EVERY_MS = 25_000
/** No «pong» in this long: the connection is dead even if the browser did not notice. */
export const PONG_WITHIN_MS = 10_000
/** Waits between reconnections, the last one repeated; each with ±20 % chance. */
export const RECONNECT_DELAYS_MS: readonly number[] = [1000, 2000, 5000, 10_000, 20_000, 30_000]
/** After this many attempts in a row that never opened, it asks whether the session is alive. */
export const FAILURES_BEFORE_CHECK = 3
/**
 * The cloud closes with this code when the session must be checked: it ended (expired or signed
 * out elsewhere), it was opened over an hour ago (revalidation) or the session has too many sockets.
 */
export const SESSION_ENDED = 4401
/**
 * The cloud closes with this code a socket that sent something other than «ping»: trying again at
 * once would only repeat it. It waits for the tab to come back into view or the network to return
 * (the screens keep reading every 15 s meanwhile).
 */
export const POLICY_VIOLATION = 1008
/**
 * Live this long, the connection is good: the wait between reconnections starts over. Not on
 * opening: a server that accepts and drops at once would otherwise be retried every second.
 */
export const STABLE_AFTER_MS = 5_000

/** `wss://host/v1/panel/live` (or `ws://` while testing locally over http). */
export const liveUrl = (where: Pick<Location, 'protocol' | 'host'> = location) =>
  `${where.protocol === 'https:' ? 'wss' : 'ws'}://${where.host}/v1/panel/live`

const isUnauthorized = (e: unknown) => (e as { kind?: unknown } | null)?.kind === 'unauthorized'

export function createLive({
  url,
  open = (u) => new WebSocket(u) as unknown as SocketLike,
  visibility = documentVisibility,
  network = browserNetwork,
  checkSession,
  onSignedOut,
  random = Math.random,
}: {
  url: string
  open?: (url: string) => SocketLike
  visibility?: Visibility
  network?: Network
  /** `api.me()`: fails with `kind: 'unauthorized'` when the session is over. */
  checkSession: () => Promise<unknown>
  /** The session is over: the panel goes back to «Entrar». */
  onSignedOut: () => void
  random?: () => number
}): LiveConnection {
  const listeners = new Set<LiveListener>()
  let state: LiveState = 'connecting'
  let socket: SocketLike | null = null
  let opened = false
  /** Reconnections since the last time it stayed live (the index of the wait). */
  let attempt = 0
  /** Attempts in a row that never opened (since the last time it stayed live). */
  let failures = 0
  /** «Online» or back in view while the session was being checked: connect at once after it. */
  let nowAfterCheck = false
  /** A reopen after a drop says «changed»: what happened meanwhile was not heard. */
  let announceOnOpen = false
  let checking = false
  let running = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let pongTimer: ReturnType<typeof setTimeout> | null = null
  let stableTimer: ReturnType<typeof setTimeout> | null = null
  let unsubscribe: (() => void)[] = []

  const emit = (what: 'changed' | 'state') => {
    for (const l of [...listeners]) {
      try {
        if (what === 'changed') l.changed?.()
        else l.state?.(state)
      } catch (e) {
        console.error('A live panel listener failed:', e)
      }
    }
  }
  const setState = (next: LiveState) => {
    if (next === state) return
    state = next
    emit('state')
  }
  const clearTimer = (t: ReturnType<typeof setTimeout> | null) => {
    if (t) clearTimeout(t)
    return null
  }

  /** Forgets the current socket (its late events are ignored) and closes it. */
  function dropSocket(code: number, reason: string) {
    const old = socket
    socket = null
    opened = false
    if (pingTimer) clearInterval(pingTimer)
    pingTimer = null
    pongTimer = clearTimer(pongTimer)
    stableTimer = clearTimer(stableTimer)
    if (!old) return
    old.onopen = old.onmessage = old.onclose = old.onerror = null
    try {
      old.close(code, reason)
    } catch {}
  }

  function connect() {
    retryTimer = clearTimer(retryTimer)
    if (!running || socket || checking || visibility.hidden()) return
    let ws: SocketLike
    try {
      ws = open(url)
    } catch {
      failures++
      afterClose(1006)
      return
    }
    socket = ws
    ws.onopen = () => {
      opened = true
      setState('live')
      stableTimer = setTimeout(() => {
        stableTimer = null
        failures = 0
        attempt = 0
      }, STABLE_AFTER_MS)
      pingTimer = setInterval(ping, PING_EVERY_MS)
      if (announceOnOpen) emit('changed')
      announceOnOpen = false
    }
    ws.onmessage = (event) => {
      if (event.data === 'pong') {
        pongTimer = clearTimer(pongTimer)
        return
      }
      if (typeof event.data !== 'string' || event.data.length > 1024) return
      try {
        if ((JSON.parse(event.data) as { type?: unknown } | null)?.type === 'changed')
          emit('changed')
      } catch {}
    }
    ws.onclose = (event) => {
      const neverOpened = !opened
      dropSocket(1000, '')
      if (neverOpened) failures++
      afterClose(event.code)
    }
    ws.onerror = () => {}
  }

  function afterClose(code: number) {
    if (!running) return
    announceOnOpen = true
    if (code === POLICY_VIOLATION) {
      // Not in a loop: the next try is when the tab comes back into view or the network returns.
      retryTimer = clearTimer(retryTimer)
      setState('down')
      return
    }
    if (code === SESSION_ENDED || failures >= FAILURES_BEFORE_CHECK) {
      failures = 0
      check()
    } else retry()
  }

  function retry() {
    setState('down')
    retryTimer = clearTimer(retryTimer)
    if (!running || visibility.hidden()) return
    const base = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 30_000
    attempt++
    retryTimer = setTimeout(connect, Math.round(base * (0.8 + random() * 0.4)))
  }

  /** Is the session still alive? If not, out; if it is (or it is not known), keep trying. */
  function check() {
    setState('down')
    checking = true
    nowAfterCheck = false
    /** The session is alive (or it is not known): on, at once if «online» came meanwhile. */
    const goOn = () => {
      if (!nowAfterCheck) return retry()
      nowAfterCheck = false
      attempt = 0
      connect()
    }
    checkSession().then(
      () => {
        checking = false
        if (running) goOn()
      },
      (e) => {
        checking = false
        if (!running) return
        if (isUnauthorized(e)) {
          stop()
          onSignedOut()
        } else goOn()
      },
    )
  }

  function ping() {
    if (!socket || socket.readyState !== OPEN) return
    try {
      socket.send('ping')
    } catch {}
    pongTimer ??= setTimeout(() => {
      // No answer: the connection is dead even if the browser still says it is open.
      dropSocket(4000, 'no pong')
      afterClose(1006)
    }, PONG_WITHIN_MS)
  }

  /** Back in view or back online: try now, from the shortest wait. */
  function now() {
    if (!running || socket || visibility.hidden()) return
    // The check decides first (the session may be over); then it connects without waiting.
    if (checking) {
      nowAfterCheck = true
      return
    }
    attempt = 0
    connect()
  }

  function start() {
    if (running) return
    running = true
    announceOnOpen = false
    setState('connecting')
    unsubscribe = [
      visibility.subscribe(() => {
        if (visibility.hidden()) {
          // Only a tab in view keeps a socket (Safari cuts them in the background anyway).
          retryTimer = clearTimer(retryTimer)
          dropSocket(1000, 'hidden')
          setState('down')
        } else {
          // The screen reads again when it comes back into view: no need to announce the reopen.
          announceOnOpen = false
          setState('connecting')
          now()
        }
      }),
      network.subscribe(now),
    ]
    connect()
  }

  function stop() {
    running = false
    retryTimer = clearTimer(retryTimer)
    dropSocket(1000, 'bye')
    for (const u of unsubscribe) u()
    unsubscribe = []
    setState('down')
  }

  return {
    state: () => state,
    subscribe: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    start,
    stop,
  }
}

/** The tab's connection, for the screens; null where there is none (tests, the register). */
export const LiveContext = createContext<LiveFeed | null>(null)

export const useLiveFeed = () => useContext(LiveContext)

/** The connection's state for the «En vivo» mark; null without a connection. */
export function useLiveState(): LiveState | null {
  const feed = useLiveFeed()
  const subscribe = useCallback(
    (change: () => void) => (feed ? feed.subscribe({ state: change }) : () => {}),
    [feed],
  )
  const read = () => feed?.state() ?? null
  return useSyncExternalStore(subscribe, read, read)
}
