import { type EventoPedido, nuevoId, validarEventoNuevo } from '@pos/core'
// El simulador del reductor de @pos/core: dos pedidos y dos turnos con eventos al azar. Solo para
// pruebas, por eso se importa por ruta y no desde el paquete.
import { type Accion, Servicio } from '../../../core/src/pruebas/simulador'
import type { AlmacenHub } from '../hub/almacen'

// Historias al azar para probar lo que el hub lee de la base para los reportes (tarea 1.9): los
// eventos del simulador, con días operativos repartidos, turnos de caja abiertos y cerrados y los
// números de secuencia contiguos que exige la base.

export const DIAS = ['2026-10-23', '2026-10-24', '2026-10-25'] as const
const DEL_PERIODO = [
  'PagoRegistrado',
  'PagoAnulado',
  'ReembolsoRegistrado',
  'ItemAnulado',
  'PedidoCancelado',
]

export interface PlanDeHistoria {
  acciones: Accion[]
  /** Un día (0..2) por evento, según su posición. */
  dias: number[]
  /** Cuáles de los dos turnos se cierran al final. */
  cierra: [boolean, boolean]
  /** Con propinas pagadas desde la caja en cada turno. */
  propinas: [number, number]
  /**
   * Días en orden, como en la vida real: los eventos de antes de `cortes[0]` son del primer día,
   * hasta `cortes[1]` del segundo y el resto del tercero (cada uno es una posición entre los
   * eventos aceptados). Así ningún evento nuevo cae en un día ya pasado. Sustituye a `dias`, y
   * también reparte el día de los cierres de mesa.
   */
  cortes?: [number, number]
}

export interface Historia {
  servicio: Servicio
  /** Todos los eventos aceptados, con su secuencia contigua desde 1. */
  eventos: EventoPedido[]
  turnos: readonly [string, string]
}

const CAJA = nuevoId()
const USUARIO = nuevoId()

function crudo(
  tipo: string,
  agregado: string,
  datos: unknown,
  extras: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: nuevoId(),
    tipo,
    version_esquema: 1,
    agregado_tipo: 'turno_caja',
    agregado_id: agregado,
    relacionados: [],
    datos,
    sesion_id: null,
    usuario_id: USUARIO,
    dispositivo_id: CAJA,
    autorizacion_id: null,
    motivo: null,
    hora_dispositivo: '2026-10-24T20:00:00.000Z',
    hora_estimada_hub: '2026-10-24T20:00:00.000Z',
    secuencia_base: 0,
    recibido_en: '2026-10-24T20:00:00.000Z',
    asignaciones: {},
    afecta: [],
    autorizado_por_id: null,
    ...extras,
  }
}

/** Arma la historia: abre los turnos, corre al simulador, reparte los días y cierra los turnos. */
export function armarHistoria(plan: PlanDeHistoria): Historia {
  const servicio = new Servicio()
  for (const a of plan.acciones) servicio.paso(a)
  const aplicados = new Set(servicio.aplicados.map((e) => e.id))
  const dia = (i: number) => DIAS[plan.dias[i % plan.dias.length] ?? 1] as string

  const apertura = servicio.turnos.map((t) =>
    crudo('TurnoAbierto', t, { caja_id: CAJA, base: 100_000 }, { dia_operativo: DIAS[0] }),
  )
  const medio = plan.cortes
    ? servicio.log
        .filter((e) => aplicados.has(e.id))
        .map((e, j) => {
          const [c1, c2] = plan.cortes as [number, number]
          const d = j < c1 ? DIAS[0] : j < c2 ? DIAS[1] : DIAS[2]
          return { ...e, dia_operativo: d } as EventoPedido
        })
    : servicio.log
        .map((e, i) =>
          DEL_PERIODO.includes(e.tipo) ? ({ ...e, dia_operativo: dia(i) } as EventoPedido) : e,
        )
        .filter((e) => aplicados.has(e.id))
  const cierre = servicio.turnos.flatMap((t, n) => {
    const propinas = plan.propinas[n as 0 | 1]
    const eventos = []
    if (propinas > 0)
      eventos.push(
        crudo(
          'MovimientoCajaRegistrado',
          t,
          {
            movimiento_id: nuevoId(),
            tipo: 'pago_propinas',
            monto: propinas,
            descripcion: 'Propinas',
            a_quien: 'Equipo',
            dias: [DIAS[1]],
          },
          { dia_operativo: DIAS[1] },
        ),
      )
    if (plan.cierra[n as 0 | 1]) {
      const arqueo = nuevoId()
      eventos.push(
        crudo(
          'ArqueoRegistrado',
          t,
          {
            arqueo_id: arqueo,
            conteo: [{ valor: 1_000, cantidad: 100 }],
            contado_efectivo: 100_000,
          },
          { dia_operativo: DIAS[2] },
        ),
        crudo(
          'TurnoCerrado',
          t,
          {
            arqueo_id: arqueo,
            esperado_efectivo: 100_000,
            contado_efectivo: 100_000,
            diferencia: 0,
            justificacion: null,
            otros_medios: [],
          },
          { dia_operativo: DIAS[2] },
        ),
      )
    }
    return eventos
  })

  const eventos = [...apertura, ...medio, ...cierre].map((e, i) => ({
    ...e,
    secuencia: i + 1,
  })) as unknown as EventoPedido[]
  // Los de caja pasan por el esquema real: la historia nunca trae un evento que el hub rechazaría.
  for (const e of eventos.filter((x) => x.agregado_tipo === 'turno_caja')) {
    const {
      secuencia: _s,
      recibido_en: _r,
      dia_operativo: _d,
      asignaciones: _a,
      afecta: _f,
      autorizado_por_id: _p,
      ...nuevo
    } = e as unknown as Record<string, unknown>
    const v = validarEventoNuevo(nuevo)
    if (!v.ok) throw new Error(`Evento de caja inválido: ${v.errores.join('; ')}`)
  }
  return { servicio, eventos, turnos: servicio.turnos }
}

const pedidosDe = (e: EventoPedido) => [...new Set([e.agregado_id, ...e.relacionados])]

/** Guarda los eventos en un almacén, como los guardaría el hub. */
export function cargar(almacen: AlmacenHub, eventos: readonly EventoPedido[]) {
  for (const e of eventos) almacen.guardarEvento(e, e.id, pedidosDe(e))
}

/** Les pone a los eventos la secuencia contigua desde 1 que exige la base. */
export const numerar = (eventos: readonly EventoPedido[]): EventoPedido[] =>
  eventos.map((e, i) => ({ ...e, secuencia: i + 1 }))
