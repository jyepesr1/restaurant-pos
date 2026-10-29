import { newId } from '@pos/core'
import type { SqliteDatabase } from '@pos/db'
import type { CloudStatus } from '@pos/sync'
import { SqliteStore } from '@pos/sync/sqlite'
import { type CloudLink, readLink, saveLink } from './link'
import { CloudUploader, REQUEST_TIMEOUT_MS, type UploaderOptions } from './uploader'

// This register PC with the cloud (task 1.11): registering it with the single-use code the
// Faro admin gives, and the upload of its events. The credential stays in the data folder.

/** The cloud's address for every restaurant; `CLOUD_URL` changes it (tests, another account). */
export const DEFAULT_CLOUD_URL = 'https://faro-api.johanyepes.workers.dev'

/** Counter (local table `counters`) with the last sequence the cloud confirmed. */
const CONFIRMED = 'cloud_confirmed'

export type RegistrationResult =
  | { ok: true }
  | {
      ok: false
      code: 'already_connected' | 'invalid_code' | 'other_restaurant' | 'offline' | 'cloud_error'
      message: string
    }

export interface CloudConnectionOptions {
  db: SqliteDatabase
  restaurantId: string
  dataDir: string
  /** The hub installation (`hub-instance`): the cloud keeps it with the registration. */
  instance: string
  url?: string
  onStatus?: (status: CloudStatus) => void
  onFailure?: (error: unknown) => void
  fetch?: typeof fetch
  clock?: () => Date
  /** For the tests: the uploader's waits and timers. */
  uploader?: Pick<
    UploaderOptions,
    'timers' | 'retryDelaysMs' | 'stuckRetryMs' | 'requestTimeoutMs' | 'maxBatchBytes'
  >
}

/** The cloud did not answer the registration (no internet, timeout). */
class NetworkError extends Error {}

/**
 * The credential travels in a header: only over HTTPS. Plain HTTP only to this same machine (tests
 * and a local fake cloud).
 */
export function checkCloudUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`CLOUD_URL no es una dirección válida: ${url}`)
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local))
    throw new Error(`CLOUD_URL debe empezar con https:// (es ${parsed.protocol}//)`)
  return url.replace(/\/+$/, '')
}

export class CloudConnection {
  readonly uploader: CloudUploader
  private readonly o: CloudConnectionOptions
  private readonly url: string
  private readonly fetch: typeof fetch
  private link: CloudLink | null
  private registering = false

  constructor(options: CloudConnectionOptions) {
    this.o = options
    this.url = checkCloudUrl(options.url ?? DEFAULT_CLOUD_URL)
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.link = readLink(options.dataDir, () =>
      options.onFailure?.(
        new Error(
          'El archivo de conexión con la nube está dañado: el PC de caja queda sin conectar hasta escribir un código nuevo',
        ),
      ),
    )
    const { db, restaurantId } = options
    this.uploader = new CloudUploader({
      url: this.url,
      events: new SqliteStore(db, restaurantId),
      credential: () => this.link?.credential ?? null,
      confirmed: {
        read: () =>
          Number(
            db
              .prepare('SELECT value FROM counters WHERE restaurant_id = ? AND name = ?')
              .get(restaurantId, CONFIRMED)?.value ?? 0,
          ),
        write: (sequence) => this.writeConfirmed(sequence),
      },
      onStatus: options.onStatus,
      onFailure: options.onFailure,
      fetch: this.fetch,
      clock: options.clock,
      ...options.uploader,
    })
  }

  status(): CloudStatus {
    return this.uploader.current()
  }

  private writeConfirmed(sequence: number) {
    this.o.db
      .prepare(
        `INSERT INTO counters (restaurant_id, name, value) VALUES (?, ?, ?)
         ON CONFLICT (restaurant_id, name) DO UPDATE SET value = excluded.value`,
      )
      .run(this.o.restaurantId, CONFIRMED, sequence)
  }

  /** The main location: the cloud keeps which one this register PC serves. */
  private location(): { id: string; name: string } {
    const row = this.o.db
      .prepare(
        'SELECT id, name FROM locations WHERE restaurant_id = ? AND active = 1 ORDER BY created_at LIMIT 1',
      )
      .get(this.o.restaurantId)
    if (!row) throw new Error('El restaurante no tiene sede')
    return { id: String(row.id), name: String(row.name) }
  }

  /**
   * Connects this register PC to the cloud with the code. The hub id is saved before asking, so if
   * the answer is lost the same code works again. A revoked PC gets a new id: the cloud does not
   * revive a revoked one.
   */
  async register(rawCode: string): Promise<RegistrationResult> {
    const state = this.uploader.current().state
    if (this.link?.credential && state !== 'revoked')
      return {
        ok: false,
        code: 'already_connected',
        message: 'Este PC de caja ya está conectado a la nube.',
      }
    if (this.registering)
      return {
        ok: false,
        code: 'cloud_error',
        message: 'Ya se está conectando. Espera un momento.',
      }
    this.registering = true
    try {
      const location = this.location()
      if (!this.link || this.link.credential) this.setLink(newId())
      let r = await this.ask(rawCode, location)
      // This id is already registered with another code (an earlier attempt whose answer was
      // lost): it starts over with a new id, so the code typed now is the one that counts.
      if (r.status === 409) {
        this.setLink(newId())
        r = await this.ask(rawCode, location)
      }
      if (r.status === 201) {
        const data = r.data as { credential?: unknown; restaurant_id?: unknown } | null
        const credential = data?.credential
        // Empty is no credential, and what the link file cannot keep would be lost on restart.
        if (
          typeof credential !== 'string' ||
          credential.length === 0 ||
          credential.length > 200 ||
          data?.restaurant_id !== this.o.restaurantId
        )
          return this.cloudError()
        const link: CloudLink = {
          hubId: (this.link as CloudLink).hubId,
          credential,
          registeredAt: (this.o.clock?.() ?? new Date()).toISOString(),
        }
        // Saved first: if the disk fails, the hub does not upload with a credential it will lose.
        saveLink(this.o.dataDir, link)
        this.link = link
        // A new registration starts from zero in the cloud: it asks again how far it is.
        this.writeConfirmed(0)
        this.uploader.restart()
        return { ok: true }
      }
      const error = String((r.data as { error?: unknown } | null)?.error ?? '')
      if (r.status === 403 && error === 'other_restaurant')
        return {
          ok: false,
          code: 'other_restaurant',
          message: 'Ese código es de otro restaurante. Pide uno para este restaurante.',
        }
      if (r.status === 403 || r.status === 400)
        return {
          ok: false,
          code: 'invalid_code',
          message: 'El código no existe, ya se usó o venció. Revísalo o pide uno nuevo.',
        }
      return this.cloudError()
    } catch (error) {
      if (error instanceof NetworkError)
        return {
          ok: false,
          code: 'offline',
          message:
            'No hay conexión con la nube. Revisa el internet del PC de caja e intenta de nuevo.',
        }
      // Not the internet (the disk, the database): it goes to the hub's log.
      this.o.onFailure?.(error)
      return this.cloudError()
    } finally {
      this.registering = false
    }
  }

  private setLink(hubId: string) {
    this.link = { hubId, credential: null, registeredAt: null }
    saveLink(this.o.dataDir, this.link)
  }

  private cloudError(): RegistrationResult {
    return {
      ok: false,
      code: 'cloud_error',
      message: 'La nube tuvo un problema. Intenta de nuevo en unos minutos.',
    }
  }

  private async ask(
    rawCode: string,
    location: { id: string; name: string },
  ): Promise<{ status: number; data: unknown }> {
    let r: Response
    try {
      r = await this.fetch(`${this.url}/v1/hubs/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // The route already limits it; whoever calls this directly does not send a novel.
          code: rawCode.trim().slice(0, 40),
          restaurant_id: this.o.restaurantId,
          hub_id: (this.link as CloudLink).hubId,
          location_id: location.id,
          name: `Caja de ${location.name}`.slice(0, 60),
          instance: this.o.instance,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      throw new NetworkError('network')
    }
    return { status: r.status, data: await r.json().catch(() => null) }
  }
}
