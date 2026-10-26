import { Etiqueta, type Tono } from './Etiqueta'
import type { NombreIcono } from './iconos'

// Indicador permanente de conexión y de impresoras (brief §5, regla 7). "Solo red local" es lo
// normal sin internet: el salón sigue operando con el hub (ADR-001).

export type ConnectionState = 'online' | 'local_only' | 'connecting' | 'offline'

const STATUSES: Record<ConnectionState, { tono: Tono; icono: NombreIcono; text: string }> = {
  online: { tono: 'free', icono: 'wifi', text: 'En línea' },
  // Lo normal sin internet: neutro, no ámbar (ámbar es "en espera").
  local_only: { tono: 'neutral', icono: 'local', text: 'Solo red local' },
  connecting: { tono: 'neutral', icono: 'clock', text: 'Conectando…' },
  offline: { tono: 'warning', icono: 'noWifi', text: 'Sin conexión' },
}

export function IndicadorConexion({
  status,
  pendingList = 0,
  impresorasConFalla = 0,
  compacto = false,
}: {
  status: ConnectionState
  /** Eventos guardados aquí que el hub aún no confirma. */
  pendingList?: number
  impresorasConFalla?: number
  /**
   * En el celular, lo normal («Solo red local») se abrevia «Local», para que el encabezado quepa
   * en una fila. Lo que pide atención (sin conexión, pendientes) siempre lleva su texto completo.
   */
  compacto?: boolean
}) {
  const e = STATUSES[status]
  return (
    <div className="flex flex-wrap items-center gap-2" role="status">
      <Etiqueta tono={e.tono} icono={e.icono}>
        {compacto && status === 'local_only' ? (
          <>
            <span className="sm:hidden" aria-hidden="true">
              Local
            </span>
            <span className="max-sm:sr-only">{e.text}</span>
          </>
        ) : (
          e.text
        )}
      </Etiqueta>
      {pendingList > 0 && (
        <Etiqueta tono="progress" icono="clock">{`${pendingList} sin confirmar`}</Etiqueta>
      )}
      {impresorasConFalla > 0 && (
        <Etiqueta tono="warning" icono="printer">
          {impresorasConFalla === 1
            ? 'Una impresora no responde'
            : `${impresorasConFalla} impresoras no responden`}
        </Etiqueta>
      )}
    </div>
  )
}
