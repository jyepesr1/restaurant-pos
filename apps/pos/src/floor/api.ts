// HTTP calls to the hub (pair, PIN, catalog). Whatever is not event sync goes over HTTP; events
// go over the WebSocket (docs/SYNC.md).

const WAIT_MS = 8000

export class ApiError extends Error {
  readonly code: string
  /** How long to wait before another attempt (after several wrong PINs, ADR-008). */
  readonly waitMs: number

  constructor(code: string, message: string, waitMs = 0) {
    super(message)
    this.code = code
    this.waitMs = waitMs
  }
}

export const NO_HUB =
  'No hay conexión con la caja. Revisa el Wi-Fi del local y que la caja esté encendida.'

export async function makeCall<T>(
  httpMethod: 'GET' | 'POST',
  route: string,
  { body, token }: { body?: object; token?: string } = {},
): Promise<T> {
  let r: Response
  try {
    r = await fetch(route, {
      method: httpMethod,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(WAIT_MS),
    })
  } catch {
    throw new ApiError('offline', NO_HUB)
  }
  if (r.status === 204) return undefined as T
  const data = await r.json().catch(() => null)
  if (!r.ok)
    throw new ApiError(
      String(data?.error ?? 'error'),
      String(data?.message ?? `La caja respondió con un error (${r.status}). Intenta de nuevo.`),
      Number(data?.wait_ms ?? 0),
    )
  return data as T
}
