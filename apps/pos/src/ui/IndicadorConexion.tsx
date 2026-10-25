import { Etiqueta, type Tono } from './Etiqueta'
import type { NombreIcono } from './iconos'

// Indicador permanente de conexión y de impresoras (brief §5, regla 7). "Solo red local" es lo
// normal sin internet: el salón sigue operando con el hub (ADR-001).

export type EstadoConexion = 'en_linea' | 'solo_local' | 'conectando' | 'sin_conexion'

const ESTADOS: Record<EstadoConexion, { tono: Tono; icono: NombreIcono; texto: string }> = {
  en_linea: { tono: 'libre', icono: 'wifi', texto: 'En línea' },
  // Lo normal sin internet: neutro, no ámbar (ámbar es "en espera").
  solo_local: { tono: 'neutro', icono: 'local', texto: 'Solo red local' },
  conectando: { tono: 'neutro', icono: 'reloj', texto: 'Conectando…' },
  sin_conexion: { tono: 'alerta', icono: 'sinWifi', texto: 'Sin conexión' },
}

export function IndicadorConexion({
  estado,
  pendientes = 0,
  impresorasConFalla = 0,
}: {
  estado: EstadoConexion
  /** Eventos guardados aquí que el hub aún no confirma. */
  pendientes?: number
  impresorasConFalla?: number
}) {
  const e = ESTADOS[estado]
  return (
    <div className="flex flex-wrap items-center gap-2" role="status">
      <Etiqueta tono={e.tono} icono={e.icono}>
        {e.texto}
      </Etiqueta>
      {pendientes > 0 && (
        <Etiqueta tono="proceso" icono="reloj">{`${pendientes} sin confirmar`}</Etiqueta>
      )}
      {impresorasConFalla > 0 && (
        <Etiqueta tono="alerta" icono="impresora">
          {impresorasConFalla === 1
            ? 'Una impresora no responde'
            : `${impresorasConFalla} impresoras no responden`}
        </Etiqueta>
      )}
    </div>
  )
}
