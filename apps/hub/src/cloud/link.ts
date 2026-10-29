import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

// This register PC's link with the cloud (task 1.11, ADR-016): its hub id there and the
// credential the cloud gave it when it registered with the code. The credential is a secret: it
// lives in its own file and never leaves the hub (not even to the register's screen). On macOS and
// Linux the file is readable only by the hub's user; on Windows `chmod` does not restrict access,
// so it is protected by the data folder's permissions (set by the installer, task 1.13).

export const LINK_FILE = 'cloud-link.json'

export interface CloudLink {
  /** This hub's id in the cloud. Kept from the first attempt, so a retry uses the same one. */
  hubId: string
  /** null until the cloud accepts the code. */
  credential: string | null
  registeredAt: string | null
}

const Saved = z.strictObject({
  hub_id: z.string().length(26),
  credential: z.string().min(1).max(200).nullable(),
  registered_at: z.string().nullable(),
})

/**
 * The saved link, or null if this PC never tried to connect. A damaged file is also null (the PC
 * has to be connected again with a new code), and `onDamaged` says so for the hub's log.
 */
export function readLink(dataDir: string, onDamaged?: () => void): CloudLink | null {
  const route = join(dataDir, LINK_FILE)
  if (!existsSync(route)) return null
  try {
    const s = Saved.parse(JSON.parse(readFileSync(route, 'utf8')))
    return { hubId: s.hub_id, credential: s.credential, registeredAt: s.registered_at }
  } catch {
    onDamaged?.()
    return null
  }
}

/** Saves it whole or not at all (a power cut while writing does not leave half a file). */
export function saveLink(dataDir: string, link: CloudLink) {
  const route = join(dataDir, LINK_FILE)
  const temporary = `${route}.tmp`
  const content = JSON.stringify({
    hub_id: link.hubId,
    credential: link.credential,
    registered_at: link.registeredAt,
  })
  const fd = openSync(temporary, 'w', 0o600)
  try {
    writeSync(fd, `${content}\n`)
    // On disk before the rename: a power cut does not leave an empty file in its place.
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  // The mode only applies when creating it: a leftover file keeps its own permissions otherwise.
  chmodSync(temporary, 0o600)
  renameSync(temporary, route)
}
