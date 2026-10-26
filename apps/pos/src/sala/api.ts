// Llamadas HTTP al hub (emparejar, PIN, catálogo). Lo que no es sincronización de eventos va por
// HTTP; los eventos van por el WebSocket (docs/SYNC.md).

const WAIT_MS = 8000

export class ErrorApi extends Error {
  readonly code: string
  /** Cuánto esperar antes de otro intento (tras varios PIN errados, ADR-008). */
  readonly waitMs: number

  constructor(code: string, message: string, waitMs = 0) {
    super(message)
    this.code = code
    this.waitMs = waitMs
  }
}

export const SIN_HUB =
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
    throw new ErrorApi('offline', SIN_HUB)
  }
  if (r.status === 204) return undefined as T
  const data = await r.json().catch(() => null)
  if (!r.ok)
    throw new ErrorApi(
      String(data?.error ?? 'error'),
      String(data?.message ?? `La caja respondió con un error (${r.status}). Intenta de nuevo.`),
      Number(data?.wait_ms ?? 0),
    )
  return data as T
}
