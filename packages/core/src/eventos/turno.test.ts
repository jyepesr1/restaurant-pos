import { describe, expect, it } from 'vitest'
import {
  PERMISOS_CON_CONTRASENA,
  permisoPara,
  ROLES_DE_FABRICA,
  SOLO_DESDE_CAJA,
} from '../acceso/permisos'
import { LIMITE_TOTAL_PEDIDO } from '../dinero'
import { nuevoId } from '../id'
import { aplicarEvento, reconstruir } from '../pedido/aplicar'
import { aplicarTodos, pedidoAbierto } from '../pruebas/ayudas'
import { copiaItem, evento, HORA, pagoEfectivo, pagoTarjeta } from '../pruebas/fabrica'
import { agregadoDe, TIPOS_EVENTO_PEDIDO, TIPOS_EVENTO_TURNO, validarEventoNuevo } from './pedido'

// `TurnoAbierto` y el pago con tarjeta sin número de aprobación (tarea 1.6).

const sobreTurno = (datos: unknown, extras: Record<string, unknown> = {}) => ({
  id: nuevoId(),
  tipo: 'TurnoAbierto',
  version_esquema: 1,
  agregado_tipo: 'turno_caja',
  agregado_id: nuevoId(),
  relacionados: [],
  datos,
  sesion_id: null,
  usuario_id: nuevoId(),
  dispositivo_id: nuevoId(),
  autorizacion_id: null,
  motivo: null,
  hora_dispositivo: HORA,
  hora_estimada_hub: HORA,
  secuencia_base: 0,
  ...extras,
})

const errores = (entrada: unknown) => {
  const r = validarEventoNuevo(entrada)
  return r.ok ? [] : r.errores
}

const turnoValido = () => sobreTurno({ caja_id: nuevoId(), base: 200_000 })

describe('TurnoAbierto: esquema', () => {
  it('acepta caja y base en pesos enteros', () => {
    expect(errores(turnoValido())).toEqual([])
  })

  it('una base de $0 es válida (caja sin fondo) y el tope del pedido también', () => {
    expect(errores(sobreTurno({ caja_id: nuevoId(), base: 0 }))).toEqual([])
    expect(errores(sobreTurno({ caja_id: nuevoId(), base: LIMITE_TOTAL_PEDIDO }))).toEqual([])
  })

  it.each([
    ['negativa', -1],
    ['fraccionada', 1000.5],
    ['sobre el límite', LIMITE_TOTAL_PEDIDO + 1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['entero no seguro', 2 ** 53],
    ['texto', '200000'],
    ['null', null],
    ['ausente', undefined],
  ])('rechaza una base %s', (_, base) => {
    expect(errores(sobreTurno({ caja_id: nuevoId(), base }))).not.toEqual([])
  })

  it('exige un caja_id que sea ULID', () => {
    expect(errores(sobreTurno({ base: 0 }))).not.toEqual([])
    expect(errores(sobreTurno({ caja_id: 'caja-1', base: 0 }))).not.toEqual([])
    expect(errores(sobreTurno({ caja_id: null, base: 0 }))).not.toEqual([])
  })

  it('no admite campos de más (esquema estricto)', () => {
    expect(
      errores(sobreTurno({ caja_id: nuevoId(), base: 0, cierre: 'x' } as unknown)),
    ).not.toEqual([])
  })

  it('es un evento del agregado turno_caja: dicho como pedido o producto se rechaza', () => {
    const datos = { caja_id: nuevoId(), base: 0 }
    expect(errores(sobreTurno(datos, { agregado_tipo: 'pedido' }))).not.toEqual([])
    expect(errores(sobreTurno(datos, { agregado_tipo: 'producto' }))).not.toEqual([])
    expect(errores(sobreTurno(datos, { agregado_tipo: 'turno' }))).not.toEqual([])
  })

  it('un evento de pedido no puede decir que es de un turno_caja', () => {
    const abierto = evento(nuevoId(), 'PedidoAbierto', {
      canal: 'salon',
      mesa_id: null,
      comensales: 1,
    })
    const { secuencia: _s, recibido_en: _r, dia_operativo: _d, ...resto } = abierto
    const nuevo = { ...resto, agregado_tipo: 'turno_caja' }
    expect(errores(nuevo)).not.toEqual([])
  })

  it('agregadoDe: turno_caja para TurnoAbierto y, para el resto, lo de siempre', () => {
    expect(agregadoDe('TurnoAbierto')).toBe('turno_caja')
    expect([...TIPOS_EVENTO_TURNO]).toEqual(['TurnoAbierto'])
    expect(TIPOS_EVENTO_PEDIDO).toContain('TurnoAbierto')
    expect(agregadoDe('PagoRegistrado')).toBe('pedido')
    expect(agregadoDe('ProductoAgotado')).toBe('producto')
  })

  it('el evento aceptado por el hub (con secuencia y día) es el mismo tipo', () => {
    const e = evento(nuevoId(), 'TurnoAbierto', { caja_id: nuevoId(), base: 50_000 }, {
      agregado_tipo: 'turno_caja',
    } as never)
    expect(e.agregado_tipo).toBe('turno_caja')
    expect(e.datos.base).toBe(50_000)
  })
})

describe('TurnoAbierto: no toca pedidos', () => {
  // BUG: un TurnoAbierto puede nombrar un pedido en `relacionados` y el hub lo guarda como evento de
  // ese pedido (eventosDeAgregado(pedido) lo incluye). ProductoAgotado ya lo impide en
  // packages/core/src/eventos/pedido.ts (superRefine de EventoPedidoNuevo, «Un evento de producto
  // no toca pedidos»); falta la misma guarda para los eventos del agregado turno_caja.
  it('un TurnoAbierto no puede nombrar un pedido en relacionados', () => {
    const conPedido = sobreTurno({ caja_id: nuevoId(), base: 0 }, { relacionados: [nuevoId()] })
    expect(errores(conPedido)).not.toEqual([])
  })
})

describe('TurnoAbierto: permiso y caja', () => {
  const turno = () =>
    evento(nuevoId(), 'TurnoAbierto', { caja_id: nuevoId(), base: 0 }, {
      agregado_tipo: 'turno_caja',
    } as never)

  it('pide abrir_turno_caja', () => {
    expect(permisoPara(turno())).toBe('abrir_turno_caja')
  })

  it('solo se crea desde un equipo de caja', () => {
    expect(SOLO_DESDE_CAJA.has('TurnoAbierto')).toBe(true)
  })

  it('lo pueden el administrador y el cajero; el mesero y reportes, no', () => {
    const tiene = (rol: keyof typeof ROLES_DE_FABRICA) =>
      (ROLES_DE_FABRICA[rol].permisos as readonly string[]).includes('abrir_turno_caja')
    expect(tiene('admin')).toBe(true)
    expect(tiene('cajero')).toBe(true)
    expect(tiene('mesero')).toBe(false)
    expect(tiene('reportes')).toBe(false)
  })

  it('abrir caja pide contraseña, no basta un PIN', () => {
    expect(PERMISOS_CON_CONTRASENA.has('abrir_turno_caja')).toBe(true)
  })
})

describe('TurnoAbierto: el reductor del pedido lo ignora', () => {
  it('sin pedido, no crea ninguno y avisa que no es de un pedido', () => {
    const r = aplicarEvento(
      null,
      evento(nuevoId(), 'TurnoAbierto', { caja_id: nuevoId(), base: 0 }, {
        agregado_tipo: 'turno_caja',
      } as never),
    )
    expect(r.estado).toBeNull()
    expect(r.problema?.tipo).toBe('no_es_del_pedido')
  })

  it('con un pedido abierto, el estado queda idéntico, aunque el evento nombre su id', () => {
    const { pedido, estado } = pedidoAbierto()
    const conItem = aplicarTodos([evento(pedido, 'ItemAgregado', copiaItem())], estado)
    const r = aplicarEvento(
      conItem,
      evento(pedido, 'TurnoAbierto', { caja_id: nuevoId(), base: 99_999 }, {
        agregado_tipo: 'turno_caja',
      } as never),
    )
    expect(r.estado).toEqual(conItem)
    expect(r.problema?.tipo).toBe('no_es_del_pedido')
  })

  it('al reconstruir un pedido con un turno en medio, el resultado es el mismo que sin él', () => {
    const { pedido, estado } = pedidoAbierto()
    const item = evento(pedido, 'ItemAgregado', copiaItem({ precio_unitario: 10_000 }))
    const turno = evento(nuevoId(), 'TurnoAbierto', { caja_id: nuevoId(), base: 0 }, {
      agregado_tipo: 'turno_caja',
      secuencia: 2,
    } as never)
    const abierto = evento(
      pedido,
      'PedidoAbierto',
      { canal: 'salon', mesa_id: null, comensales: 1 },
      {
        secuencia: 1,
      },
    )
    const sinTurno = reconstruir([abierto, { ...item, secuencia: 3 }], pedido)
    const conTurno = reconstruir([abierto, turno, { ...item, secuencia: 3 }], pedido)
    expect(conTurno).toEqual(sinTurno)
    expect(estado.id).toBe(pedido)
  })

  it('un turno por sí solo no deja ninguna proyección de pedido', () => {
    const turno = evento(nuevoId(), 'TurnoAbierto', { caja_id: nuevoId(), base: 0 }, {
      agregado_tipo: 'turno_caja',
    } as never)
    expect(reconstruir([turno], turno.agregado_id)).toBeNull()
  })
})

describe('PagoRegistrado con tarjeta sin número de aprobación', () => {
  const sobrePago = (datos: unknown) => ({
    ...turnoValido(),
    tipo: 'PagoRegistrado',
    agregado_tipo: 'pedido',
    datos,
  })

  it('acepta la tarjeta con aprobacion: null (solo el monto)', () => {
    const base = pagoTarjeta(40_000)
    const datafono = { ...(base.datafono as object), aprobacion: null }
    expect(errores(sobrePago({ ...base, datafono }))).toEqual([])
  })

  it('sigue aceptando la tarjeta con aprobación, franquicia y últimos 4', () => {
    expect(errores(sobrePago(pagoTarjeta(40_000)))).toEqual([])
  })

  it('el datáfono sigue siendo obligatorio con tarjeta, aunque la aprobación no', () => {
    expect(errores(sobrePago({ ...pagoTarjeta(40_000), datafono: null }))).not.toEqual([])
  })

  it('una aprobación vacía o de espacios no es un número: debe mandarse null', () => {
    const base = pagoTarjeta(40_000)
    for (const aprobacion of ['', '   ']) {
      const datafono = { ...(base.datafono as object), aprobacion }
      expect(errores(sobrePago({ ...base, datafono }))).not.toEqual([])
    }
  })

  it('la aprobación no puede faltar del todo (undefined): es null o un texto', () => {
    const base = pagoTarjeta(40_000)
    const { aprobacion: _a, ...sinAprobacion } = base.datafono as Record<string, unknown>
    expect(errores(sobrePago({ ...base, datafono: sinAprobacion }))).not.toEqual([])
  })

  it('el reductor registra el pago de tarjeta sin aprobación y el pedido cierra', () => {
    const { pedido, estado } = pedidoAbierto()
    const base = pagoTarjeta(40_900)
    const pago = { ...base, datafono: { ...(base.datafono as object), aprobacion: null } }
    const final = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', copiaItem({ precio_unitario: 40_900 })),
        evento(pedido, 'PagoRegistrado', pago as typeof base),
        evento(pedido, 'PedidoCerrado', {}),
      ],
      estado,
    )
    expect(final.estado).toBe('cerrado')
    expect(Object.values(final.pagos)[0]).toMatchObject({ medio: 'tarjeta', monto: 40_900 })
  })

  it('un pago en efectivo sigue sin llevar datáfono ni aprobación', () => {
    expect(errores(sobrePago(pagoEfectivo(10_000)))).toEqual([])
  })
})
