import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Product photos (task 1.3c). The app shrinks them before uploading; the hub saves them in its
// data folder named after the content fingerprint, so a new photo gets a different name and
// devices cache each one forever. Works without internet: the hub serves them.

/** Size limit of a decoded photo. The app uploads them shrunk (about 100 KB). */
export const MAX_PHOTO_SIZE = 1024 * 1024

const TYPES = {
  webp: {
    signature: (b: Buffer) =>
      b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
    mime: 'image/webp',
  },
  jpg: {
    signature: (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    mime: 'image/jpeg',
  },
  png: {
    signature: (b: Buffer) =>
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    mime: 'image/png',
  },
} as const
type Extension = keyof typeof TYPES

/** A photo name the hub could have created: no paths and no made-up names. */
export const PHOTO_NAME = /^[a-f0-9]{24}\.(webp|jpg|png)$/

export class PhotoError extends Error {}

/**
 * Saves the photo that arrives as `data:image/…;base64,…` and returns its name. It is accepted for
 * what it is (its first bytes), not for what it claims to be: a file that is not an image is not
 * saved.
 */
export function savePhoto(photosDir: string, image: string): string {
  const parts = /^data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(image)
  if (!parts) throw new PhotoError('La foto debe ser una imagen WebP, JPEG o PNG')
  const bytes = Buffer.from(parts[2] as string, 'base64')
  if (bytes.length === 0) throw new PhotoError('La foto está vacía')
  if (bytes.length > MAX_PHOTO_SIZE) throw new PhotoError('La foto pesa más de 1 MB')
  const extension = (Object.keys(TYPES) as Extension[]).find((e) => TYPES[e].signature(bytes))
  if (!extension) throw new PhotoError('El archivo no es una imagen WebP, JPEG o PNG')
  const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}.${extension}`
  mkdirSync(photosDir, { recursive: true })
  const route = join(photosDir, name)
  // Written separately and then renamed: a power cut halfway does not leave a broken photo under
  // its final name (which devices would cache forever). If it was already complete, it is left
  // alone.
  if (!existsSync(route) || statSync(route).size !== bytes.length) {
    const temporal = `${route}.${process.pid}.tmp`
    writeFileSync(temporal, bytes)
    renameSync(temporal, route)
  }
  return name
}

/** The saved photo and its type, or `null` if the name is not a photo's or it is missing. */
export function readPhoto(photosDir: string, name: string): { bytes: Buffer; mime: string } | null {
  if (!PHOTO_NAME.test(name)) return null
  const route = join(photosDir, name)
  if (!existsSync(route)) return null
  const extension = name.split('.').pop() as Extension
  return { bytes: readFileSync(route), mime: TYPES[extension].mime }
}

/** Public path of a saved photo (for the devices' menu). */
export const photoUrl = (name: unknown) =>
  typeof name === 'string' && PHOTO_NAME.test(name) ? `/photos/${name}` : null
