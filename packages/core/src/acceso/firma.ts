import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { jsonCanonico } from '../canonico'
import type { EventoNuevo } from '../eventos/pedido'

// Firma de eventos y huella para comprobantes de supervisor (ADR-008). SHA-256 en JavaScript
// puro: por HTTP (ADR-001) el navegador no ofrece `crypto.subtle`. El mismo código corre en el
// celular y en el hub.

/** Sin la firma ni lo que el dispositivo puede ajustar después (`secuencia_base`). */
function contenido(evento: EventoNuevo, sin: readonly string[]): string {
  const copia: Record<string, unknown> = { ...evento }
  for (const campo of ['firma', 'secuencia_base', ...sin]) delete copia[campo]
  return jsonCanonico(copia)
}

/**
 * Firma del evento con el secreto de la sesión que lo crea. El dispositivo la calcula al crear el
 * evento y olvida el secreto al cerrar la sesión: con el `sesion_id` de otro no se puede firmar.
 */
export function firmarEvento(evento: EventoNuevo, secretoSesion: string): string {
  return bytesToHex(hmac(sha256, utf8ToBytes(secretoSesion), utf8ToBytes(contenido(evento, []))))
}

/**
 * Huella del evento que un supervisor autoriza: el comprobante vale solo para ese contenido.
 * No incluye `autorizacion_id`, que se agrega después de recibir el comprobante.
 */
export function huellaAutorizable(evento: EventoNuevo): string {
  return bytesToHex(sha256(utf8ToBytes(contenido(evento, ['autorizacion_id']))))
}

/** Compara dos textos sin cortar en la primera diferencia (no da pistas por el tiempo). */
export function igualesSinFiltrarTiempo(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diferencia = 0
  for (let i = 0; i < a.length; i++) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diferencia === 0
}
