// The few Cloudflare Workers types the live panel uses (task 1.11c-2), written here instead of
// depending on @cloudflare/workers-types: only what live-object.ts and worker.ts touch. Official
// reference: https://developers.cloudflare.com/durable-objects/api/state/ and
// https://developers.cloudflare.com/durable-objects/best-practices/websockets/.

/** A server-side WebSocket accepted with the Hibernation API. */
interface HibernatableWebSocket {
  send(message: string): void
  close(code?: number, reason?: string): void
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}

/** `ctx` of a Durable Object: only the WebSocket Hibernation API. */
interface DurableObjectState {
  acceptWebSocket(ws: HibernatableWebSocket, tags?: string[]): void
  getWebSockets(tag?: string): HibernatableWebSocket[]
  setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair): void
}

/** A Durable Object stub: `fetch` (to hand over the WebSocket) and its public methods by RPC. */
type DurableObjectStub<T> = { fetch(request: Request): Promise<Response> } & {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never
}

interface DurableObjectNamespace<T> {
  getByName(name: string): DurableObjectStub<T>
}

declare class WebSocketRequestResponsePair {
  constructor(request: string, response: string)
  readonly request: string
  readonly response: string
}

declare class WebSocketPair {
  0: HibernatableWebSocket
  1: HibernatableWebSocket
}

/** In the Workers runtime a 101 response carries the client end of the socket. */
interface ResponseInit {
  webSocket?: HibernatableWebSocket | null
}

declare module 'cloudflare:workers' {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState
    protected env: Env
    constructor(ctx: DurableObjectState, env: Env)
  }
}
