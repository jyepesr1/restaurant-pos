import { DurableObject } from 'cloudflare:workers'
import {
  EXPIRES_HEADER,
  LIVE_REASONS,
  type LiveAttachment,
  type LiveReason,
  MAX_SOCKETS_PER_SESSION,
  POLICY_VIOLATION,
  REVALIDATE_MS,
  SESSION_ENDED,
  SESSION_HEADER,
  sessionTag,
} from './live-protocol'

// The live panel's Durable Object (task 1.11c-2, docs/PANEL.md#aviso-en-vivo-websocket): one per location,
// named `${restaurantId}:${locationId}`. It keeps the panels' WebSockets open with the
// Hibernation API and, when the Worker saves something from that location, tells them «something
// changed»: each panel then reads again from the API, so the restaurant's data never goes through
// here (Postgres, with its row security, stays the only source). No alarms and no timers: they
// would keep it awake and it would charge duration (docs/integraciones/panel-cloudflare.md, 4.1).

const SESSION_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/

function attachmentOf(ws: HibernatableWebSocket): LiveAttachment | null {
  try {
    const a = ws.deserializeAttachment() as Partial<LiveAttachment> | null
    return a &&
      typeof a.sessionId === 'string' &&
      typeof a.expiresAt === 'string' &&
      typeof a.checkedAt === 'number'
      ? { sessionId: a.sessionId, expiresAt: a.expiresAt, checkedAt: a.checkedAt }
      : null
  } catch {
    return null
  }
}

/** Closing a socket that is already gone must not stop the others. */
function closeQuietly(ws: HibernatableWebSocket, code: number, reason: string) {
  try {
    ws.close(code, reason)
  } catch {}
}

/** Codes a close frame cannot carry (they only describe what happened): answered with 1000. */
const RESERVED_CODES = new Set([1005, 1006, 1015])

export class PanelLive extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env)
    // The panel's «ping» is answered without waking the object (or charging duration).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  /**
   * A panel connects. Only the Worker gets here, after checking the cookie, the `Origin` and the
   * permission; it says which session in its own headers.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return new Response('Expected a WebSocket', { status: 426 })
    const sessionId = request.headers.get(SESSION_HEADER) ?? ''
    const expiresAt = request.headers.get(EXPIRES_HEADER) ?? ''
    if (!SESSION_ID.test(sessionId) || Number.isNaN(Date.parse(expiresAt)))
      return new Response('Missing session', { status: 400 })
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    // A session with too many sockets open (a tab reopened in a loop) loses the oldest ones.
    const same = this.ctx
      .getWebSockets(sessionTag(sessionId))
      .map((ws) => ({ ws, checkedAt: attachmentOf(ws)?.checkedAt ?? 0 }))
      .sort((a, b) => a.checkedAt - b.checkedAt)
    for (const old of same.slice(0, Math.max(0, same.length - MAX_SOCKETS_PER_SESSION + 1)))
      closeQuietly(old.ws, SESSION_ENDED, 'too many sockets')
    this.ctx.acceptWebSocket(server, [sessionTag(sessionId)])
    server.serializeAttachment({
      sessionId,
      expiresAt,
      checkedAt: Date.now(),
    } satisfies LiveAttachment)
    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * Tells every panel of the location to read again, and closes the sockets whose session already
   * expired or was checked more than REVALIDATE_MS ago (the panel checks it and reconnects).
   * Returns how many it told (for the tests and the logs).
   */
  async notify(reason: LiveReason): Promise<number> {
    if (!LIVE_REASONS.includes(reason)) return 0
    const message = JSON.stringify({ type: 'changed', reason })
    const now = Date.now()
    let told = 0
    for (const ws of this.ctx.getWebSockets()) {
      const a = attachmentOf(ws)
      if (!a || !(Date.parse(a.expiresAt) > now)) {
        closeQuietly(ws, SESSION_ENDED, 'session ended')
        continue
      }
      if (now - a.checkedAt >= REVALIDATE_MS) {
        closeQuietly(ws, SESSION_ENDED, 'check the session')
        continue
      }
      try {
        ws.send(message)
        told++
      } catch {
        // A socket that broke midway: the runtime will call webSocketClose; the rest go on.
      }
    }
    return told
  }

  /** Closes the sockets of one session (signing out). Returns how many. */
  async closeSession(sessionId: string): Promise<number> {
    if (!SESSION_ID.test(sessionId)) return 0
    const list = this.ctx.getWebSockets(sessionTag(sessionId))
    for (const ws of list) closeQuietly(ws, SESSION_ENDED, 'session ended')
    return list.length
  }

  /**
   * The panel only sends «ping», which the auto-response answers before getting here. Anything
   * else is not the panel: the socket is closed (1008) and nothing changes.
   */
  async webSocketMessage(ws: HibernatableWebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === 'ping') {
      // Only if the auto-response was not in place (it always is: set in the constructor).
      try {
        ws.send('pong')
      } catch {}
      return
    }
    closeQuietly(ws, POLICY_VIOLATION, 'only ping is expected')
  }

  /**
   * The browser closed: the close is answered with its code (a code that cannot go in a close
   * frame, with 1000). With `web_socket_auto_reply_to_close` the runtime already answered and
   * this does nothing; without it, the socket would stay half closed. The attachment goes with it.
   */
  async webSocketClose(ws: HibernatableWebSocket, code: number, reason: string): Promise<void> {
    closeQuietly(ws, RESERVED_CODES.has(code) ? 1000 : code, reason)
  }

  async webSocketError(): Promise<void> {}
}
