// Achicar una foto en el equipo antes de subirla (tarea 1.3c): en la carta basta con 800 px por el
// lado más largo, y así viaja liviana por el Wi-Fi del local (unos 100 KB en vez de varios MB).

const LADO_MAXIMO = 800

/** La foto como `data:image/webp;base64,…` (o JPEG si el navegador no sabe hacer WebP). */
export async function achicarFoto(archivo: Blob): Promise<string> {
  const imagen = await createImageBitmap(archivo)
  const escala = Math.min(1, LADO_MAXIMO / Math.max(imagen.width, imagen.height))
  const lienzo = document.createElement('canvas')
  lienzo.width = Math.round(imagen.width * escala)
  lienzo.height = Math.round(imagen.height * escala)
  const contexto = lienzo.getContext('2d')
  if (!contexto) throw new Error('Este navegador no puede preparar la foto')
  contexto.drawImage(imagen, 0, 0, lienzo.width, lienzo.height)
  imagen.close()
  const webp = lienzo.toDataURL('image/webp', 0.82)
  return webp.startsWith('data:image/webp') ? webp : lienzo.toDataURL('image/jpeg', 0.85)
}
