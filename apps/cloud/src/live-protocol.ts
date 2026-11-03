// What the Worker and the live panel's Durable Object agree on (task 1.11c-2,
// docs/PANEL.md#aviso-en-vivo-websocket). Separate from live-object.ts so that api.ts, which the hub's tests also
// import, never imports the Workers runtime (`cloudflare:workers`).

/** Why the panels should read again. */
export type LiveReason = 'events' | 'snapshot' | 'back_online'
export const LIVE_REASONS: readonly LiveReason[] = ['events', 'snapshot', 'back_online']

/** The close code for a session that ended (expired or signed out): the panel then checks `me`. */
export const SESSION_ENDED = 4401

/** The headers the Worker adds after checking the session (it drops any `x-faro-*` from the browser). */
export const SESSION_HEADER = 'x-faro-session-id'
export const EXPIRES_HEADER = 'x-faro-session-expires'

/** What each socket remembers through hibernation (well under the 16 KiB limit). */
export interface LiveAttachment {
  sessionId: string
  /** ISO; from then on the socket is closed at the next notice. */
  expiresAt: string
  /**
   * When the Worker checked the session to open it (ms since the epoch). After REVALIDATE_MS the
   * next notice closes it with SESSION_ENDED: the panel checks `me` and, if the session is still
   * good, opens a new one (a session revoked meanwhile does not keep hearing notices).
   */
  checkedAt: number
}

/** How long a socket lives on one session check (docs/PANEL.md#aviso-en-vivo-websocket). */
export const REVALIDATE_MS = 60 * 60_000

/** At most this many open sockets per session (tabs, phones): a new one closes the oldest. */
export const MAX_SOCKETS_PER_SESSION = 10

/** The close code for a message the panel never sends (only «ping» is expected). */
export const POLICY_VIOLATION = 1008

export const sessionTag = (sessionId: string) => `session:${sessionId}`

/** The Durable Object of a location: always from the checked session or hub, never from the URL. */
export const roomOf = (restaurantId: string, locationId: string) => `${restaurantId}:${locationId}`

/** The live panel's rooms, as the Worker reaches them (worker.ts gives them to the API). */
export interface LiveRooms {
  /** Hands the WebSocket over to the room's Durable Object; its 101 goes back untouched. */
  connect(room: string, request: Request): Promise<Response>
  notify(room: string, reason: LiveReason): Promise<unknown>
  closeSession(room: string, sessionId: string): Promise<unknown>
}
