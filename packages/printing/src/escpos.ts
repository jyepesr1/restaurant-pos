import { codificar, NUMERO_PAGINA, type PaginaCodigos } from './codificacion'
import type { Linea } from './documento'

// Órdenes ESC/POS del juego básico de Epson, que entienden las impresoras térmicas genéricas.
// Solo se usa lo que toda impresora de 58 u 80 mm trae: tamaño, negrita, invertido, alineación,
// avance y corte.

const ESC = 0x1b
const GS = 0x1d
const LF = 0x0a

const iniciar = [ESC, 0x40]
const tabla = (n: number) => [ESC, 0x74, n]
const alinear = (centro: boolean) => [ESC, 0x61, centro ? 1 : 0]
const negrita = (si: boolean) => [ESC, 0x45, si ? 1 : 0]
const invertido = (si: boolean) => [GS, 0x42, si ? 1 : 0]
const tamano = (grande: boolean) => [GS, 0x21, grande ? 0x11 : 0x00]
/** Avanza n líneas: el corte queda debajo de lo impreso y no a mitad del último producto. */
const avanzar = (n: number) => [ESC, 0x64, n]
/** Corte parcial (deja una pestaña): el papel no cae al piso de la cocina. */
const cortar = [GS, 0x56, 0x42, 0x00]

/** El documento en bytes para la impresora, con avance y corte al final. */
export function escpos(
  lineas: readonly Linea[],
  formato: { columnas: number; pagina: PaginaCodigos },
): Uint8Array {
  const bytes: number[] = [...iniciar]
  const n = NUMERO_PAGINA[formato.pagina]
  if (n !== null) bytes.push(...tabla(n))
  for (const linea of lineas) {
    if ('separador' in linea) {
      bytes.push(...alinear(false), ...tamano(false), ...negrita(false), ...invertido(false))
      bytes.push(...Array(formato.columnas).fill(0x2d), LF)
      continue
    }
    if ('espacio' in linea) {
      bytes.push(LF)
      continue
    }
    bytes.push(
      ...alinear(!!linea.centro),
      ...tamano(!!linea.grande),
      ...negrita(!!linea.negrita),
      ...invertido(!!linea.invertido),
      ...codificar(linea.texto, formato.pagina),
      // Se apaga antes del salto: el invertido no pinta el resto de la línea de negro.
      ...invertido(false),
      LF,
    )
  }
  bytes.push(...tamano(false), ...negrita(false), ...alinear(false), ...avanzar(4), ...cortar)
  return Uint8Array.from(bytes)
}
