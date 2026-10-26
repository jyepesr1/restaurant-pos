import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Fotos de los productos (tarea 1.3c). La app las achica antes de subirlas; el hub las guarda en
// su carpeta de datos con la huella del contenido como nombre, así una foto nueva tiene otro nombre
// y los equipos guardan cada una en caché para siempre. Funciona sin internet: las sirve el hub.

/** Tope de una foto ya decodificada. La app las sube achicadas (unos 100 KB). */
export const TAMANO_MAXIMO_FOTO = 1024 * 1024

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

/** Un nombre de foto que el hub pudo haber creado: nada de rutas ni nombres inventados. */
export const NOMBRE_FOTO = /^[a-f0-9]{24}\.(webp|jpg|png)$/

export class ErrorFoto extends Error {}

/**
 * Guarda la foto que llega como `data:image/…;base64,…` y devuelve su nombre. Se acepta por lo que
 * es (sus primeros bytes), no por lo que dice ser: un archivo que no es imagen no se guarda.
 */
export function guardarFoto(dirFotos: string, imagen: string): string {
  const parts = /^data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(imagen)
  if (!parts) throw new ErrorFoto('La foto debe ser una imagen WebP, JPEG o PNG')
  const bytes = Buffer.from(parts[2] as string, 'base64')
  if (bytes.length === 0) throw new ErrorFoto('La foto está vacía')
  if (bytes.length > TAMANO_MAXIMO_FOTO) throw new ErrorFoto('La foto pesa más de 1 MB')
  const extension = (Object.keys(TYPES) as Extension[]).find((e) => TYPES[e].signature(bytes))
  if (!extension) throw new ErrorFoto('El archivo no es una imagen WebP, JPEG o PNG')
  const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}.${extension}`
  mkdirSync(dirFotos, { recursive: true })
  const route = join(dirFotos, name)
  // Se escribe aparte y se renombra: un corte de luz a mitad no deja una foto rota con su nombre
  // definitivo (que los equipos guardarían en caché para siempre). Si ya estaba entera, no se toca.
  if (!existsSync(route) || statSync(route).size !== bytes.length) {
    const temporal = `${route}.${process.pid}.tmp`
    writeFileSync(temporal, bytes)
    renameSync(temporal, route)
  }
  return name
}

/** La foto guardada y su tipo, o `null` si el nombre no es de una foto o no está. */
export function leerFoto(dirFotos: string, name: string): { bytes: Buffer; mime: string } | null {
  if (!NOMBRE_FOTO.test(name)) return null
  const route = join(dirFotos, name)
  if (!existsSync(route)) return null
  const extension = name.split('.').pop() as Extension
  return { bytes: readFileSync(route), mime: TYPES[extension].mime }
}

/** Ruta pública de una foto guardada (para la carta de los equipos). */
export const urlFoto = (name: unknown) =>
  typeof name === 'string' && NOMBRE_FOTO.test(name) ? `/photos/${name}` : null
