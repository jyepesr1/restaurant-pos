// Shrink a photo on the device before uploading it (task 1.3c): for the menu 800 px on the
// longest side is enough, and so it travels light over the location's Wi-Fi (about 100 KB
// instead of several MB).

const MAX_SIDE = 800

/** The photo as `data:image/webp;base64,…` (or JPEG if the browser cannot do WebP). */
export async function shrinkPhoto(file: Blob): Promise<string> {
  const image = await createImageBitmap(file)
  const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(image.width * scale)
  canvas.height = Math.round(image.height * scale)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Este navegador no puede preparar la foto')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  image.close()
  const webp = canvas.toDataURL('image/webp', 0.82)
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.85)
}
