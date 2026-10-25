import { decodificar, type PaginaCodigos } from './codificacion'

// Lee lo que una impresora recibiría (las órdenes de `escpos.ts`) y lo deja como texto: para la
// impresora de prueba del hub y para comprobar en las pruebas qué salió en el papel.

const PAGINA_DE: Record<number, PaginaCodigos> = { 2: 'pc850', 16: 'wpc1252' }

export interface Leido {
  texto: string
  /** Cuántas veces se cortó el papel (una por comanda). */
  cortes: number
}

export function leerEscpos(bytes: Uint8Array): Leido {
  let pagina: PaginaCodigos = 'sin_tildes'
  let linea: number[] = []
  const lineas: string[] = []
  let cortes = 0
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    if (b === 0x1b) {
      const orden = bytes[i + 1]
      if (orden === 0x40) i += 1
      else if (orden === 0x74) {
        pagina = PAGINA_DE[bytes[i + 2] as number] ?? 'sin_tildes'
        i += 2
      } else if (orden === 0x64) {
        for (let n = 0; n < (bytes[i + 2] as number); n++) lineas.push('')
        i += 2
      } else i += 2
      continue
    }
    if (b === 0x1d) {
      if (bytes[i + 1] === 0x56) {
        cortes += 1
        lineas.push('✂ ─────────')
        i += 3
      } else i += 2
      continue
    }
    if (b === 0x0a) {
      lineas.push(decodificar(linea, pagina))
      linea = []
      continue
    }
    linea.push(b)
  }
  if (linea.length > 0) lineas.push(decodificar(linea, pagina))
  return { texto: lineas.join('\n'), cortes }
}
