import { LOGO_MAX_HEIGHT, LOGO_MAX_WIDTH, type PrintLogo } from '@pos/core'

// The restaurant's logo for the pre-bill: thermal printers only print black dots, so the image is
// turned into black and white on the device when uploaded, at the size it will print. What the
// owner sees in the preview is exactly what comes out.

/** The size that fits the paper and the header, keeping the proportions; the width in 8-dot steps. */
export function logoSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, LOGO_MAX_WIDTH / width, LOGO_MAX_HEIGHT / height)
  const w = Math.max(8, Math.floor((width * scale) / 8) * 8)
  return {
    width: w,
    height: Math.max(1, Math.min(LOGO_MAX_HEIGHT, Math.round(height * (w / width)))),
  }
}

/**
 * RGBA pixels (as a canvas gives them) to the printer's 1-bit image: dark and opaque is black,
 * light or transparent is paper. A logo is flat color, so a threshold reads better than dithering.
 */
export function toPrintLogo(rgba: ArrayLike<number>, width: number, height: number): PrintLogo {
  const rowBytes = width / 8
  const bytes = new Uint8Array(rowBytes * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const alpha = (rgba[i + 3] as number) / 255
      // Over white paper: a half-transparent dot counts as lighter.
      const light =
        (0.299 * (rgba[i] as number) +
          0.587 * (rgba[i + 1] as number) +
          0.114 * (rgba[i + 2] as number)) *
          alpha +
        255 * (1 - alpha)
      const at = y * rowBytes + (x >> 3)
      if (light < 128) bytes[at] = (bytes[at] as number) | (0x80 >> (x & 7))
    }
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return { width, height, data: btoa(binary) }
}

/** The 1-bit image back to RGBA, to show the owner how it will print. */
export function printLogoPixels(logo: PrintLogo): Uint8ClampedArray<ArrayBuffer> {
  const bytes = Uint8Array.from(atob(logo.data), (c) => c.charCodeAt(0))
  const rgba = new Uint8ClampedArray(new ArrayBuffer(logo.width * logo.height * 4))
  const rowBytes = logo.width / 8
  for (let y = 0; y < logo.height; y++)
    for (let x = 0; x < logo.width; x++) {
      const black = ((bytes[y * rowBytes + (x >> 3)] as number) & (0x80 >> (x & 7))) !== 0
      const i = (y * logo.width + x) * 4
      rgba.fill(black ? 0 : 255, i, i + 3)
      rgba[i + 3] = 255
    }
  return rgba
}

/** How much of the logo prints black (0 to 1): almost all or almost nothing deserves a warning. */
export function blackShare(logo: PrintLogo): number {
  const bytes = atob(logo.data)
  let black = 0
  for (const c of bytes) {
    let b = c.charCodeAt(0)
    for (; b; b &= b - 1) black++
  }
  return black / (logo.width * logo.height)
}

/** Bigger than this, decoding it could take the whole memory of a phone. */
const MAX_FILE_BYTES = 15 * 1024 * 1024

/** Reads the chosen image file and converts it on a canvas. */
export async function logoFromFile(file: File): Promise<PrintLogo> {
  if (file.size > MAX_FILE_BYTES) throw new Error('La imagen es muy pesada')
  const bitmap = await createImageBitmap(file)
  const { width, height } = logoSize(bitmap.width, bitmap.height)
  // A very thin strip would come out deformed: better to refuse it than to print it wrong.
  if (
    Math.abs(width / height - bitmap.width / bitmap.height) >
    0.1 * (bitmap.width / bitmap.height)
  ) {
    bitmap.close()
    throw new Error('El logo es demasiado angosto')
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Este equipo no pudo leer la imagen')
  // Fine strokes survive the reduction before the black-and-white threshold.
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return toPrintLogo(context.getImageData(0, 0, width, height).data, width, height)
}

/** The logo as an image for the screen (a data URL), black on white. */
export function logoPreview(logo: PrintLogo): string {
  const canvas = document.createElement('canvas')
  canvas.width = logo.width
  canvas.height = logo.height
  canvas
    .getContext('2d')
    ?.putImageData(new ImageData(printLogoPixels(logo), logo.width, logo.height), 0, 0)
  return canvas.toDataURL('image/png')
}
