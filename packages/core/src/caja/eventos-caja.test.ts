import { describe, expect, it } from 'vitest'
import {
  PERMISOS_CON_CONTRASENA,
  permisoPara,
  ROLES_DE_FABRICA,
  SOLO_DESDE_CAJA,
} from '../acceso/permisos'
import { configCompleta } from '../config'
import { LIMITE_TOTAL_PEDIDO } from '../dinero'
import {
  agregadoDe,
  type EventoNuevo,
  TIPOS_EVENTO_PEDIDO,
  TIPOS_EVENTO_TURNO,
  validarEventoNuevo,
} from '../eventos/pedido'
import { nuevoId } from '../id'
import { aplicarEvento, reconstruir } from '../pedido/aplicar'
import { aplicarTodos, pedidoAbierto } from '../pruebas/ayudas'
import { copiaItem, evento, HORA } from '../pruebas/fabrica'

// Los tres eventos de caja de la tarea 1.7 (MovimientoCajaRegistrado, ArqueoRegistrado y
// TurnoCerrado): esquema con sus bordes, agregado turno_caja, permisos, solo desde la caja y que el
// reductor del pedido los ignore.

const TIPOS_CAJA = ['MovimientoCajaRegistrado', 'ArqueoRegistrado', 'TurnoCerrado'] as const

const sobre = (tipo: string, datos: unknown, extras: Record<string, unknown> = {}) => ({
  id: nuevoId(),
  tipo,
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
const ok = (e: unknown) => validarEventoNuevo(e).ok

const movimiento = (campos: Record<string, unknown> = {}) => ({
  movimiento_id: nuevoId(),
  tipo: 'entrada',
  monto: 10_000,
  descripcion: 'Cambio de billetes',
  a_quien: null,
  dias: [],
  ...campos,
})
const propinas = (campos: Record<string, unknown> = {}) =>
  movimiento({ tipo: 'pago_propinas', a_quien: 'Equipo de sala', dias: ['2026-10-25'], ...campos })
const arqueo = (campos: Record<string, unknown> = {}) => ({
  arqueo_id: nuevoId(),
  conteo: [{ valor: 20_000, cantidad: 3 }],
  contado_efectivo: 60_000,
  ...campos,
})
const cierre = (campos: Record<string, unknown> = {}) => ({
  arqueo_id: nuevoId(),
  esperado_efectivo: 100_000,
  contado_efectivo: 98_000,
  diferencia: -2_000,
  justificacion: null,
  ...campos,
})

describe('MovimientoCajaRegistrado: esquema', () => {
  it.each([
    ['entrada', movimiento()],
    ['salida', movimiento({ tipo: 'salida' })],
    ['pago_propinas', propinas()],
  ])('acepta una %s válida', (_, datos) => {
    expect(ok(sobre('MovimientoCajaRegistrado', datos))).toBe(true)
  })

  it('el monto va de $1 al tope de un pedido; $0 y lo que pasa del tope se rechazan', () => {
    expect(ok(sobre('MovimientoCajaRegistrado', movimiento({ monto: 1 })))).toBe(true)
    expect(ok(sobre('MovimientoCajaRegistrado', movimiento({ monto: LIMITE_TOTAL_PEDIDO })))).toBe(
      true,
    )
    for (const monto of [0, LIMITE_TOTAL_PEDIDO + 1])
      expect(ok(sobre('MovimientoCajaRegistrado', movimiento({ monto })))).toBe(false)
  })

  it.each([
    ['negativo', -1],
    ['fraccionado', 1000.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['entero no seguro', 2 ** 53],
    ['texto', '10000'],
    ['null', null],
    ['ausente', undefined],
  ])('rechaza un monto %s', (_, monto) => {
    expect(ok(sobre('MovimientoCajaRegistrado', movimiento({ monto })))).toBe(false)
  })

  it('la descripción es obligatoria: vacía, de espacios o de 501 letras se rechaza; 500 vale', () => {
    for (const descripcion of ['', '   ', 'x'.repeat(501), null, undefined])
      expect(ok(sobre('MovimientoCajaRegistrado', movimiento({ descripcion })))).toBe(false)
    expect(
      ok(sobre('MovimientoCajaRegistrado', movimiento({ descripcion: 'x'.repeat(500) }))),
    ).toBe(true)
  })

  it('el tipo debe ser entrada, salida o pago_propinas (no un retiro ni otro)', () => {
    for (const tipo of ['retiro_parcial', 'Entrada', '', null])
      expect(ok(sobre('MovimientoCajaRegistrado', movimiento({ tipo })))).toBe(false)
  })

  it('solo el pago de propinas dice a quién; una entrada o salida con a_quien se rechaza', () => {
    expect(ok(sobre('MovimientoCajaRegistrado', movimiento({ a_quien: 'Ana' })))).toBe(false)
    expect(
      ok(sobre('MovimientoCajaRegistrado', movimiento({ tipo: 'salida', a_quien: 'Ana' }))),
    ).toBe(false)
    expect(ok(sobre('MovimientoCajaRegistrado', propinas({ a_quien: null })))).toBe(false)
    // «a quién» no puede ser un texto vacío o de espacios.
    expect(ok(sobre('MovimientoCajaRegistrado', propinas({ a_quien: '  ' })))).toBe(false)
  })

  it('el pago de propinas dice de qué días sale; una entrada o salida no lleva días', () => {
    expect(ok(sobre('MovimientoCajaRegistrado', propinas({ dias: [] })))).toBe(false)
    expect(ok(sobre('MovimientoCajaRegistrado', movimiento({ dias: ['2026-10-25'] })))).toBe(false)
  })

  it('los días son fechas reales; hasta 31', () => {
    for (const dias of [['2026-13-01'], ['2026-02-30'], ['25/10/2026'], [''], [20261025]])
      expect(ok(sobre('MovimientoCajaRegistrado', propinas({ dias })))).toBe(false)
    const mes = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`)
    expect(ok(sobre('MovimientoCajaRegistrado', propinas({ dias: mes })))).toBe(true)
    expect(ok(sobre('MovimientoCajaRegistrado', propinas({ dias: [...mes, '2026-11-01'] })))).toBe(
      false,
    )
  })

  it('movimiento_id debe ser un ULID', () => {
    for (const movimiento_id of ['mov-1', '', null, undefined])
      expect(ok(sobre('MovimientoCajaRegistrado', movimiento({ movimiento_id })))).toBe(false)
  })

  it('esquema estricto: un campo de más se rechaza', () => {
    expect(ok(sobre('MovimientoCajaRegistrado', movimiento({ turno_caja_id: nuevoId() })))).toBe(
      false,
    )
  })
})

describe('ArqueoRegistrado: esquema', () => {
  it('acepta un conteo que suma lo contado', () => {
    expect(ok(sobre('ArqueoRegistrado', arqueo()))).toBe(true)
  })

  it('un cajón vacío es válido: conteo vacío y $0; con conteo vacío y plata, no', () => {
    expect(ok(sobre('ArqueoRegistrado', arqueo({ conteo: [], contado_efectivo: 0 })))).toBe(true)
    expect(ok(sobre('ArqueoRegistrado', arqueo({ conteo: [], contado_efectivo: 1 })))).toBe(false)
  })

  it('suma varias denominaciones, y un renglón con cantidad 0 no suma', () => {
    const conteo = [
      { valor: 50_000, cantidad: 2 },
      { valor: 2_000, cantidad: 5 },
      { valor: 500, cantidad: 3 },
      { valor: 100_000, cantidad: 0 },
    ]
    expect(ok(sobre('ArqueoRegistrado', arqueo({ conteo, contado_efectivo: 111_500 })))).toBe(true)
    expect(ok(sobre('ArqueoRegistrado', arqueo({ conteo, contado_efectivo: 111_000 })))).toBe(false)
  })

  it('el total contado debe ser exacto: $1 de más o de menos se rechaza', () => {
    for (const contado_efectivo of [59_999, 60_001, 0])
      expect(ok(sobre('ArqueoRegistrado', arqueo({ contado_efectivo })))).toBe(false)
  })

  it('el valor es de $1 en adelante; una cantidad negativa o fraccionada se rechaza', () => {
    for (const renglon of [
      { valor: 0, cantidad: 3 },
      { valor: -1_000, cantidad: 3 },
      { valor: 1_000.5, cantidad: 2 },
      { valor: 1_000, cantidad: -1 },
      { valor: 1_000, cantidad: 1.5 },
    ])
      expect(
        ok(sobre('ArqueoRegistrado', arqueo({ conteo: [renglon], contado_efectivo: 0 }))),
      ).toBe(false)
  })

  it('hasta 30 renglones y 100.000 unidades por renglón', () => {
    const treinta = Array.from({ length: 30 }, (_, i) => ({ valor: i + 1, cantidad: 1 }))
    const suma = treinta.reduce((s, c) => s + c.valor, 0)
    expect(ok(sobre('ArqueoRegistrado', arqueo({ conteo: treinta, contado_efectivo: suma })))).toBe(
      true,
    )
    const treintaYUno = [...treinta, { valor: 31, cantidad: 1 }]
    expect(
      ok(sobre('ArqueoRegistrado', arqueo({ conteo: treintaYUno, contado_efectivo: suma + 31 }))),
    ).toBe(false)
    expect(
      ok(
        sobre(
          'ArqueoRegistrado',
          arqueo({ conteo: [{ valor: 100, cantidad: 100_000 }], contado_efectivo: 10_000_000 }),
        ),
      ),
    ).toBe(true)
    expect(
      ok(
        sobre(
          'ArqueoRegistrado',
          arqueo({ conteo: [{ valor: 100, cantidad: 100_001 }], contado_efectivo: 10_000_100 }),
        ),
      ),
    ).toBe(false)
  })

  it('un conteo que pasa del tope de un pedido se rechaza aunque coincida', () => {
    const uno = { valor: 100_000, cantidad: 100_000 }
    expect(
      ok(
        sobre('ArqueoRegistrado', arqueo({ conteo: [uno], contado_efectivo: LIMITE_TOTAL_PEDIDO })),
      ),
    ).toBe(true)
    expect(
      ok(
        sobre(
          'ArqueoRegistrado',
          arqueo({
            conteo: [uno, { valor: 1, cantidad: 1 }],
            contado_efectivo: LIMITE_TOTAL_PEDIDO + 1,
          }),
        ),
      ),
    ).toBe(false)
  })

  it.each([
    ['negativo', -1],
    ['fraccionado', 0.5],
    ['NaN', Number.NaN],
    ['texto', '60000'],
    ['null', null],
    ['ausente', undefined],
  ])('rechaza un contado %s', (_, contado_efectivo) => {
    expect(ok(sobre('ArqueoRegistrado', arqueo({ contado_efectivo })))).toBe(false)
  })

  it('arqueo_id debe ser un ULID y no se admiten campos de más', () => {
    expect(ok(sobre('ArqueoRegistrado', arqueo({ arqueo_id: 'a1' })))).toBe(false)
    expect(ok(sobre('ArqueoRegistrado', arqueo({ esperado_efectivo: 60_000 })))).toBe(false)
  })
})

describe('TurnoCerrado: esquema', () => {
  it('acepta faltante, sobrante y cuadre exacto', () => {
    expect(ok(sobre('TurnoCerrado', cierre()))).toBe(true)
    expect(
      ok(sobre('TurnoCerrado', cierre({ contado_efectivo: 103_000, diferencia: 3_000 }))),
    ).toBe(true)
    expect(ok(sobre('TurnoCerrado', cierre({ contado_efectivo: 100_000, diferencia: 0 })))).toBe(
      true,
    )
  })

  it('la diferencia es contado − esperado, con signo: el signo cambiado se rechaza', () => {
    expect(ok(sobre('TurnoCerrado', cierre({ diferencia: 2_000 })))).toBe(false)
    expect(ok(sobre('TurnoCerrado', cierre({ diferencia: -1_999 })))).toBe(false)
    expect(ok(sobre('TurnoCerrado', cierre({ diferencia: 0 })))).toBe(false)
  })

  it('el esperado puede ser negativo (se devolvió más de lo que había) y la diferencia lo respeta', () => {
    expect(
      ok(
        sobre(
          'TurnoCerrado',
          cierre({ esperado_efectivo: -5_000, contado_efectivo: 0, diferencia: 5_000 }),
        ),
      ),
    ).toBe(true)
  })

  it('el contado no puede ser negativo ni fraccionado; el esperado, tampoco fraccionado', () => {
    expect(ok(sobre('TurnoCerrado', cierre({ contado_efectivo: -1, diferencia: -100_001 })))).toBe(
      false,
    )
    expect(ok(sobre('TurnoCerrado', cierre({ esperado_efectivo: 100_000.5 })))).toBe(false)
    expect(ok(sobre('TurnoCerrado', cierre({ contado_efectivo: 98_000.5 })))).toBe(false)
  })

  it('los límites del tope: ±tope valen, uno más se rechaza', () => {
    expect(
      ok(
        sobre(
          'TurnoCerrado',
          cierre({
            esperado_efectivo: LIMITE_TOTAL_PEDIDO,
            contado_efectivo: 0,
            diferencia: -LIMITE_TOTAL_PEDIDO,
          }),
        ),
      ),
    ).toBe(true)
    expect(
      ok(
        sobre(
          'TurnoCerrado',
          cierre({
            esperado_efectivo: LIMITE_TOTAL_PEDIDO + 1,
            contado_efectivo: LIMITE_TOTAL_PEDIDO,
            diferencia: -1,
          }),
        ),
      ),
    ).toBe(false)
    // La diferencia nunca debería pasar del tope con un esperado ya acotado, pero se valida igual.
    expect(
      ok(
        sobre(
          'TurnoCerrado',
          cierre({
            esperado_efectivo: -LIMITE_TOTAL_PEDIDO,
            contado_efectivo: LIMITE_TOTAL_PEDIDO,
            diferencia: 2 * LIMITE_TOTAL_PEDIDO,
          }),
        ),
      ),
    ).toBe(false)
  })

  it('la justificación es texto con contenido, de hasta 500 letras, o null', () => {
    expect(ok(sobre('TurnoCerrado', cierre({ justificacion: 'Faltó un vale' })))).toBe(true)
    expect(ok(sobre('TurnoCerrado', cierre({ justificacion: 'x'.repeat(500) })))).toBe(true)
    for (const justificacion of ['', '   ', 'x'.repeat(501), 5])
      expect(ok(sobre('TurnoCerrado', cierre({ justificacion })))).toBe(false)
  })

  it('arqueo_id es obligatorio y ULID; no admite campos de más', () => {
    const { arqueo_id: _a, ...sinArqueo } = cierre()
    expect(ok(sobre('TurnoCerrado', sinArqueo))).toBe(false)
    expect(ok(sobre('TurnoCerrado', cierre({ arqueo_id: 'x' })))).toBe(false)
    expect(ok(sobre('TurnoCerrado', cierre({ retiro: 1 })))).toBe(false)
  })
})

describe('eventos de caja: agregado turno_caja y sin pedidos', () => {
  const validos = {
    MovimientoCajaRegistrado: movimiento(),
    ArqueoRegistrado: arqueo(),
    TurnoCerrado: cierre(),
  }

  it.each(TIPOS_CAJA)('%s es del agregado turno_caja', (tipo) => {
    expect(agregadoDe(tipo)).toBe('turno_caja')
    expect(TIPOS_EVENTO_TURNO).toContain(tipo)
    expect(TIPOS_EVENTO_PEDIDO).toContain(tipo)
    expect(ok(sobre(tipo, validos[tipo]))).toBe(true)
  })

  it.each(TIPOS_CAJA)('%s dicho como evento de pedido o de producto se rechaza', (tipo) => {
    for (const agregado_tipo of ['pedido', 'producto', 'turno', 'caja', undefined])
      expect(ok(sobre(tipo, validos[tipo], { agregado_tipo }))).toBe(false)
  })

  it.each(TIPOS_CAJA)('%s no puede nombrar un pedido en relacionados', (tipo) => {
    expect(ok(sobre(tipo, validos[tipo], { relacionados: [nuevoId()] }))).toBe(false)
    expect(ok(sobre(tipo, validos[tipo], { relacionados: [nuevoId(), nuevoId()] }))).toBe(false)
    const r = validarEventoNuevo(sobre(tipo, validos[tipo], { relacionados: [nuevoId()] }))
    expect(r.ok ? '' : r.errores.join(' ')).toMatch(/no toca pedidos/)
  })

  it.each(TIPOS_CAJA)('%s con relacionados vacío es válido (control)', (tipo) => {
    expect(ok(sobre(tipo, validos[tipo], { relacionados: [] }))).toBe(true)
  })

  it('un evento de pedido no puede decir que es del turno_caja', () => {
    const datos = { canal: 'salon', mesa_id: null, comensales: 1 }
    expect(ok(sobre('PedidoAbierto', datos, { agregado_tipo: 'pedido' }))).toBe(true)
    expect(ok(sobre('PedidoAbierto', datos, { agregado_tipo: 'turno_caja' }))).toBe(false)
  })

  it('con el mismo id de turno como agregado y un pedido distinto: el evento no es de un pedido', () => {
    // El agregado de un evento de caja es el turno: lo dice el tipo, no el contenido.
    const turno = nuevoId()
    const e = evento(
      turno,
      'MovimientoCajaRegistrado',
      movimiento() as never,
      {
        agregado_tipo: 'turno_caja',
      } as never,
    )
    expect(e.agregado_id).toBe(turno)
    expect(e.agregado_tipo).toBe('turno_caja')
  })
})

describe('eventos de caja: permisos y solo desde la caja', () => {
  const nuevo = (tipo: string, datos: unknown) => {
    const r = validarEventoNuevo(sobre(tipo, datos))
    if (!r.ok) throw new Error(r.errores.join('; '))
    return r.evento as EventoNuevo
  }

  it('el movimiento pide movimiento_caja; el arqueo y el cierre piden cerrar_turno_caja', () => {
    expect(permisoPara(nuevo('MovimientoCajaRegistrado', movimiento()))).toBe('movimiento_caja')
    expect(permisoPara(nuevo('MovimientoCajaRegistrado', propinas()))).toBe('movimiento_caja')
    expect(permisoPara(nuevo('ArqueoRegistrado', arqueo()))).toBe('cerrar_turno_caja')
    expect(permisoPara(nuevo('TurnoCerrado', cierre()))).toBe('cerrar_turno_caja')
  })

  it.each(TIPOS_CAJA)('%s solo se crea desde un equipo de caja', (tipo) => {
    expect(SOLO_DESDE_CAJA.has(tipo)).toBe(true)
  })

  it('administrador y cajero tienen los dos permisos; mesero y reportes, ninguno', () => {
    const tiene = (rol: keyof typeof ROLES_DE_FABRICA, p: string) =>
      (ROLES_DE_FABRICA[rol].permisos as readonly string[]).includes(p)
    for (const p of ['movimiento_caja', 'cerrar_turno_caja']) {
      expect(tiene('admin', p), `admin ${p}`).toBe(true)
      expect(tiene('cajero', p), `cajero ${p}`).toBe(true)
      expect(tiene('mesero', p), `mesero ${p}`).toBe(false)
      expect(tiene('reportes', p), `reportes ${p}`).toBe(false)
    }
  })

  it('ambos permisos piden contraseña, no basta un PIN', () => {
    expect(PERMISOS_CON_CONTRASENA.has('movimiento_caja')).toBe(true)
    expect(PERMISOS_CON_CONTRASENA.has('cerrar_turno_caja')).toBe(true)
  })
})

describe('eventos de caja: el reductor del pedido los ignora', () => {
  const eventosCaja = () => [
    evento(
      nuevoId(),
      'MovimientoCajaRegistrado',
      movimiento() as never,
      {
        agregado_tipo: 'turno_caja',
      } as never,
    ),
    evento(
      nuevoId(),
      'ArqueoRegistrado',
      arqueo() as never,
      {
        agregado_tipo: 'turno_caja',
      } as never,
    ),
    evento(
      nuevoId(),
      'TurnoCerrado',
      cierre() as never,
      {
        agregado_tipo: 'turno_caja',
      } as never,
    ),
  ]

  it('sin pedido no crean ninguno y avisan que no son de un pedido', () => {
    for (const e of eventosCaja()) {
      const r = aplicarEvento(null, e)
      expect(r.estado, e.tipo).toBeNull()
      expect(r.problema?.tipo, e.tipo).toBe('no_es_del_pedido')
    }
  })

  it('con un pedido abierto el estado queda idéntico, aunque el evento nombre su id', () => {
    const { pedido, estado } = pedidoAbierto()
    const conItem = aplicarTodos([evento(pedido, 'ItemAgregado', copiaItem())], estado)
    for (const base of eventosCaja()) {
      const e = { ...base, agregado_id: pedido }
      const r = aplicarEvento(conItem, e)
      expect(r.estado, e.tipo).toEqual(conItem)
      expect(r.problema?.tipo, e.tipo).toBe('no_es_del_pedido')
    }
  })

  it('reconstruir un pedido con eventos de caja en medio da lo mismo que sin ellos', () => {
    const { pedido } = pedidoAbierto()
    const abierto = evento(
      pedido,
      'PedidoAbierto',
      { canal: 'salon', mesa_id: null, comensales: 1 },
      { secuencia: 1 },
    )
    const item = evento(pedido, 'ItemAgregado', copiaItem({ precio_unitario: 10_000 }), {
      secuencia: 5,
    })
    const [mov, arq, cer] = eventosCaja().map((e, i) => ({ ...e, secuencia: 2 + i }))
    const sin = reconstruir([abierto, item], pedido)
    const con = reconstruir([abierto, mov, arq, cer, item] as never, pedido)
    expect(con).toEqual(sin)
  })

  it('solos no dejan proyección de pedido', () => {
    for (const e of eventosCaja()) expect(reconstruir([e], e.agregado_id)).toBeNull()
  })
})

describe('config: umbral_diferencia_caja', () => {
  it('de fábrica es $1.000', () => {
    expect(configCompleta().umbral_diferencia_caja).toBe(1000)
  })

  it('una configuración vieja, sin el campo, toma $1.000', () => {
    expect(configCompleta({}).umbral_diferencia_caja).toBe(1000)
  })

  it('acepta de $0 a $1.000.000', () => {
    for (const v of [0, 1, 1000, 1_000_000])
      expect(configCompleta({ umbral_diferencia_caja: v }).umbral_diferencia_caja).toBe(v)
  })

  it.each([
    ['negativo', -1],
    ['sobre el tope', 1_000_001],
    ['fraccionado', 500.5],
    ['NaN', Number.NaN],
    ['texto', '1000'],
    ['null', null],
  ])('rechaza un umbral %s', (_, v) => {
    expect(() => configCompleta({ umbral_diferencia_caja: v as never })).toThrow()
  })
})
