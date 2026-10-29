import type { CloudStatus } from '@pos/sync'
import type { IconName } from '../ui/icons'
import type { Tone } from '../ui/Label'

// How the upload to the cloud reads on the register (task 1.11): the same words in the top bar,
// on the «Copia en la nube» screen and when closing the register.

/** Who sees the upload in the bar: the register and the admin. The waiters do not need it. */
export const SEES_CLOUD = ['open_register_shift', 'record_payment', 'manage_devices'] as const

const changes = (n: number) => (n === 1 ? '1 cambio' : `${n} cambios`)

export interface CloudLabel {
  tone: Tone
  icon: IconName
  text: string
  /** For the phone's bar, which must fit on one row. */
  short: string
}

export function cloudLabel(c: CloudStatus): CloudLabel {
  switch (c.state) {
    case 'up_to_date':
      return { tone: 'free', icon: 'cloud', text: 'Nube al día', short: 'Al día' }
    case 'uploading':
      return {
        tone: 'progress',
        icon: 'cloud',
        text: `Subiendo ${changes(c.pending)}`,
        short: `Subiendo ${c.pending}`,
      }
    // Without internet the dining room keeps going (ADR-016): neutral, not an alarm.
    case 'offline':
      return c.pending > 0
        ? {
            tone: 'neutral',
            icon: 'cloudOff',
            text: `${changes(c.pending)} por subir · sin internet`,
            short: `${c.pending} por subir`,
          }
        : { tone: 'neutral', icon: 'cloudOff', text: 'Sin internet', short: 'Sin internet' }
    // These do need someone: they say who.
    case 'revoked':
      return {
        tone: 'warning',
        icon: 'warning',
        text: 'La nube no acepta esta caja · avisa al administrador',
        short: 'Revisar nube',
      }
    case 'stuck':
      return {
        tone: 'warning',
        icon: 'warning',
        text: `${changes(c.pending)} sin subir · avisa a Faro`,
        short: 'Revisar nube',
      }
    case 'not_connected':
      return { tone: 'neutral', icon: 'cloud', text: 'Sin conectar a la nube', short: 'Sin nube' }
  }
}

/** What to say when closing the register if something is still waiting to go up. */
export function pendingOnClose(c: CloudStatus | null): string | null {
  if (!c || c.pending === 0 || c.state === 'not_connected') return null
  const n = changes(c.pending)
  switch (c.state) {
    case 'offline':
      return `Quedan ${n} por subir a la nube. La caja se cierra igual: se suben solos cuando vuelva internet.`
    case 'revoked':
      return `La nube no acepta este PC de caja y quedan ${n} sin subir. La caja se cierra igual y no se pierde nada: avisa al administrador.`
    case 'stuck':
      return `Quedan ${n} que no se pueden subir a la nube. La caja se cierra igual y todo queda guardado en este PC: avisa a Faro.`
    default:
      return `Se están subiendo ${n} a la nube. La caja se cierra igual y no se pierde nada.`
  }
}
