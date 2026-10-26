import type { IconName } from './icons'
import { Label, type Tone } from './Label'

// Always-on connection and printer indicator (brief §5, rule 7). "Solo red local" is the
// normal state without internet: the dining room keeps running on the hub (ADR-001).

export type ConnectionState = 'online' | 'local_only' | 'connecting' | 'offline'

const STATUSES: Record<ConnectionState, { tone: Tone; icon: IconName; text: string }> = {
  online: { tone: 'free', icon: 'wifi', text: 'En línea' },
  // The normal state without internet: neutral, not amber (amber is "waiting").
  local_only: { tone: 'neutral', icon: 'local', text: 'Solo red local' },
  connecting: { tone: 'neutral', icon: 'clock', text: 'Conectando…' },
  offline: { tone: 'warning', icon: 'noWifi', text: 'Sin conexión' },
}

export function ConnectionIndicator({
  status,
  pendingList = 0,
  failingPrinters = 0,
  compact = false,
}: {
  status: ConnectionState
  /** Events saved here that the hub has not confirmed yet. */
  pendingList?: number
  failingPrinters?: number
  /**
   * On the phone, the normal state («Solo red local») is shortened to «Local», so the header fits
   * on one row. What needs attention (no connection, pending) always shows its full text.
   */
  compact?: boolean
}) {
  const e = STATUSES[status]
  return (
    <div className="flex flex-wrap items-center gap-2" role="status">
      <Label tone={e.tone} icon={e.icon}>
        {compact && status === 'local_only' ? (
          <>
            <span className="sm:hidden" aria-hidden="true">
              Local
            </span>
            <span className="max-sm:sr-only">{e.text}</span>
          </>
        ) : (
          e.text
        )}
      </Label>
      {pendingList > 0 && (
        <Label tone="progress" icon="clock">{`${pendingList} sin confirmar`}</Label>
      )}
      {failingPrinters > 0 && (
        <Label tone="warning" icon="printer">
          {failingPrinters === 1
            ? 'Una impresora no responde'
            : `${failingPrinters} impresoras no responden`}
        </Label>
      )}
    </div>
  )
}
