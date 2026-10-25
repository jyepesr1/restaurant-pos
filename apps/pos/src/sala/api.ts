// Llamadas HTTP al hub (emparejar, PIN, catálogo). Lo que no es sincronización de eventos va por
// HTTP; los eventos van por el WebSocket (docs/SYNC.md).

const ESPERA_MS = 8000

export class ErrorApi extends Error {
  readonly codigo: string
  /** Cuánto esperar antes de otro intento (tras varios PIN errados, ADR-008). */
  readonly esperaMs: number

  constructor(codigo: string, mensaje: string, esperaMs = 0) {
    super(mensaje)
    this.codigo = codigo
    this.esperaMs = esperaMs
  }
}

export const SIN_HUB =
  'No hay conexión con el hub. Revisa el Wi-Fi del local y que la caja esté encendida.'

export async function llamar<T>(
  metodo: 'GET' | 'POST',
  ruta: string,
  { cuerpo, token }: { cuerpo?: object; token?: string } = {},
): Promise<T> {
  let r: Response
  try {
    r = await fetch(ruta, {
      method: metodo,
      headers: {
        ...(cuerpo ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: AbortSignal.timeout(ESPERA_MS),
    })
  } catch {
    throw new ErrorApi('sin_conexion', SIN_HUB)
  }
  if (r.status === 204) return undefined as T
  const datos = await r.json().catch(() => null)
  if (!r.ok)
    throw new ErrorApi(
      String(datos?.error ?? 'error'),
      String(datos?.mensaje ?? `El hub respondió ${r.status}`),
      Number(datos?.espera_ms ?? 0),
    )
  return datos as T
}
