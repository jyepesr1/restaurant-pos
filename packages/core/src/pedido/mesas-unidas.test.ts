import { describe, expect, it } from 'vitest'
import { validarEventoNuevo } from '../eventos/pedido'
import { nuevoId } from '../id'
import { aplicarTodos, problemaDe } from '../pruebas/ayudas'
import { copiaItem, deNuevo, evento, HORA, MESERO } from '../pruebas/fabrica'
import { aplicarEvento, reconstruir } from './aplicar'
import type { EstadoPedido } from './estado'

// Unir mesas para un grupo grande (tarea 1.5): `MesasUnidas` y `MesasSeparadas` sobre el pedido,
// `EstadoPedido.mesasUnidas` y cómo se lleva con el cambio de mesa.

/** Pedido de salón abierto en una mesa conocida. */
function conMesa(): { pedido: string; mesa: string; estado: EstadoPedido }
function conMesa(mesa: null): { pedido: string; mesa: null; estado: EstadoPedido }
function conMesa(mesa: string | null = nuevoId()) {
  const pedido = nuevoId()
  const estado = aplicarTodos([
    evento(pedido, 'PedidoAbierto', { canal: 'salon', mesa_id: mesa, comensales: 2 }),
  ])
  return { pedido, mesa, estado }
}

const unir = (pedido: string, ...mesas: string[]) =>
  evento(pedido, 'MesasUnidas', { mesa_ids: mesas })
const separar = (pedido: string, ...mesas: string[]) =>
  evento(pedido, 'MesasSeparadas', { mesa_ids: mesas })
const pasar = (pedido: string, mesa: string) =>
  evento(pedido, 'PedidoMovidoDeMesa', { mesa_destino_id: mesa })

describe('MesasUnidas', () => {
  it('un pedido nuevo no tiene mesas unidas', () => {
    expect(conMesa().estado.mesasUnidas).toEqual([])
    expect(conMesa(null).estado.mesasUnidas).toEqual([])
  })

  it('suma las mesas en el orden en que llegan y deja la principal como está', () => {
    const { pedido, mesa, estado } = conMesa()
    const [a, b, c] = [nuevoId(), nuevoId(), nuevoId()]
    const unido = aplicarTodos([unir(pedido, c, a), unir(pedido, b)], estado)
    expect(unido.mesasUnidas).toEqual([c, a, b])
    expect(unido.mesaId).toBe(mesa)
  })

  it('un pedido sin mesa (barra, para llevar) no une mesas y el estado queda igual', () => {
    const { pedido, estado } = conMesa(null)
    const r = aplicarEvento(estado, unir(pedido, nuevoId()))
    expect(r.problema?.tipo).toBe('sin_mesa')
    expect(r.estado).toBe(estado)
  })

  it('un pedido sin mesa que se pasa a una sí puede unir', () => {
    const { pedido, estado } = conMesa(null)
    const mesa = nuevoId()
    const otra = nuevoId()
    const r = aplicarTodos([pasar(pedido, mesa), unir(pedido, otra)], estado)
    expect(r).toMatchObject({ mesaId: mesa, mesasUnidas: [otra] })
  })

  it('la mesa principal en la lista no cuenta dos veces: se descarta y las demás se unen', () => {
    const { pedido, mesa, estado } = conMesa()
    const otra = nuevoId()
    const unido = aplicarTodos([unir(pedido, mesa, otra)], estado)
    expect(unido.mesasUnidas).toEqual([otra])
  })

  it('unir solo la mesa propia no cambia nada: mesas_ya_unidas', () => {
    const { pedido, mesa, estado } = conMesa()
    const r = aplicarEvento(estado, unir(pedido, mesa))
    expect(r.problema?.tipo).toBe('mesas_ya_unidas')
    expect(r.estado).toBe(estado)
  })

  it('repetir una unión es mesas_ya_unidas; mezclar nuevas con ya unidas solo suma las nuevas', () => {
    const { pedido, estado } = conMesa()
    const [a, b] = [nuevoId(), nuevoId()]
    const uno = aplicarTodos([unir(pedido, a)], estado)
    expect(problemaDe(uno, unir(pedido, a))).toBe('mesas_ya_unidas')
    const dos = aplicarEvento(uno, unir(pedido, a, b))
    expect(dos.problema).toBeNull()
    expect(dos.estado?.mesasUnidas).toEqual([a, b])
  })

  it('nunca duplica una mesa aunque se una en eventos distintos', () => {
    const { pedido, estado } = conMesa()
    const m = nuevoId()
    const r = aplicarTodos([unir(pedido, m), unir(pedido, nuevoId(), m)], estado)
    expect(r.mesasUnidas.filter((x) => x === m)).toHaveLength(1)
  })

  it('no modifica el estado de entrada', () => {
    const { pedido, estado } = conMesa()
    const copia = structuredClone(estado)
    aplicarEvento(estado, unir(pedido, nuevoId()))
    expect(estado).toEqual(copia)
  })

  it.each(['cerrado', 'cancelado'] as const)('un pedido %s no une ni separa mesas', (final) => {
    const { pedido, estado } = conMesa()
    const m = nuevoId()
    const unido = aplicarTodos([unir(pedido, m)], estado)
    const cerrado = aplicarTodos(
      [
        evento(
          pedido,
          final === 'cerrado' ? 'PedidoCerrado' : 'PedidoCancelado',
          {},
          {
            motivo: 'Prueba',
          },
        ),
      ],
      unido,
    )
    expect(cerrado.estado).toBe(final)
    expect(problemaDe(cerrado, unir(pedido, nuevoId()))).toBe('pedido_cerrado')
    expect(problemaDe(cerrado, separar(pedido, m))).toBe('pedido_cerrado')
  })

  it('en un pedido que no existe no hay nada que unir', () => {
    expect(problemaDe(null, unir(nuevoId(), nuevoId()))).toBe('pedido_inexistente')
  })

  it('un evento ajeno (otro pedido) no se aplica', () => {
    const { estado } = conMesa()
    expect(problemaDe(estado, unir(nuevoId(), nuevoId()))).toBe('evento_ajeno')
  })

  it('un evento ya aplicado se ignora (idempotente por secuencia)', () => {
    const { pedido, estado } = conMesa()
    const e = unir(pedido, nuevoId())
    const una = aplicarEvento(estado, e)
    expect(una.problema).toBeNull()
    const otra = aplicarEvento(una.estado, e)
    expect(otra.problema?.tipo).toBe('evento_ya_aplicado')
    expect(otra.estado?.mesasUnidas).toEqual(una.estado?.mesasUnidas)
  })

  it('el mismo evento con otro id y secuencia no duplica: mesas_ya_unidas', () => {
    const { pedido, estado } = conMesa()
    const e = unir(pedido, nuevoId())
    const una = aplicarTodos([e], estado)
    expect(problemaDe(una, deNuevo(e))).toBe('mesas_ya_unidas')
  })

  it('tener mesas unidas no cambia los totales ni los ítems', () => {
    const { pedido, estado } = conMesa()
    const item = copiaItem()
    const con = aplicarTodos([evento(pedido, 'ItemAgregado', item)], estado)
    const unido = aplicarTodos([unir(pedido, nuevoId())], con)
    expect({ ...unido, mesasUnidas: [], ultimaSecuencia: 0 }).toEqual({
      ...con,
      ultimaSecuencia: 0,
    })
  })
})

describe('MesasSeparadas', () => {
  it('suelta las mesas indicadas y deja las demás', () => {
    const { pedido, estado } = conMesa()
    const [a, b, c] = [nuevoId(), nuevoId(), nuevoId()]
    const unido = aplicarTodos([unir(pedido, a, b, c)], estado)
    expect(aplicarTodos([separar(pedido, b)], unido).mesasUnidas).toEqual([a, c])
    expect(aplicarTodos([separar(pedido, c, a)], unido).mesasUnidas).toEqual([b])
    expect(aplicarTodos([separar(pedido, a, b, c)], unido).mesasUnidas).toEqual([])
  })

  it('una mesa que no está unida no se suelta: mesas_no_unidas y el estado queda igual', () => {
    const { pedido, estado } = conMesa()
    const unido = aplicarTodos([unir(pedido, nuevoId())], estado)
    const r = aplicarEvento(unido, separar(pedido, nuevoId()))
    expect(r.problema?.tipo).toBe('mesas_no_unidas')
    expect(r.estado).toBe(unido)
  })

  it('un pedido sin mesas unidas no tiene qué separar', () => {
    const { pedido, estado } = conMesa()
    expect(problemaDe(estado, separar(pedido, nuevoId()))).toBe('mesas_no_unidas')
  })

  it('la mesa principal no se puede soltar con este evento', () => {
    const { pedido, mesa, estado } = conMesa()
    const unido = aplicarTodos([unir(pedido, nuevoId())], estado)
    expect(problemaDe(unido, separar(pedido, mesa))).toBe('mesas_no_unidas')
  })

  it('con una unida y otra que no: suelta la unida sin quejarse', () => {
    const { pedido, estado } = conMesa()
    const a = nuevoId()
    const unido = aplicarTodos([unir(pedido, a)], estado)
    const r = aplicarEvento(unido, separar(pedido, nuevoId(), a))
    expect(r.problema).toBeNull()
    expect(r.estado?.mesasUnidas).toEqual([])
  })

  it('separar dos veces: la segunda es mesas_no_unidas', () => {
    const { pedido, estado } = conMesa()
    const a = nuevoId()
    const separado = aplicarTodos([unir(pedido, a), separar(pedido, a)], estado)
    expect(problemaDe(separado, separar(pedido, a))).toBe('mesas_no_unidas')
  })

  it('una mesa separada se puede volver a unir', () => {
    const { pedido, estado } = conMesa()
    const a = nuevoId()
    const r = aplicarTodos([unir(pedido, a), separar(pedido, a), unir(pedido, a)], estado)
    expect(r.mesasUnidas).toEqual([a])
  })
})

describe('cambiar de mesa con mesas unidas', () => {
  it('pasarse a una de sus mesas unidas la vuelve la principal y deja de contarse aparte', () => {
    const { pedido, mesa, estado } = conMesa()
    const [a, b] = [nuevoId(), nuevoId()]
    const unido = aplicarTodos([unir(pedido, a, b)], estado)
    const r = aplicarTodos([pasar(pedido, a)], unido)
    expect(r.mesaId).toBe(a)
    // La mesa de antes queda libre: no se vuelve «unida».
    expect(r.mesasUnidas).toEqual([b])
    expect(r.mesasUnidas).not.toContain(mesa)
    expect(r.mesasUnidas).not.toContain(a)
  })

  it('pasarse a una mesa nueva mantiene el grupo (las unidas siguen siéndolo)', () => {
    const { pedido, estado } = conMesa()
    const [a, nueva] = [nuevoId(), nuevoId()]
    const r = aplicarTodos([unir(pedido, a), pasar(pedido, nueva)], estado)
    expect(r).toMatchObject({ mesaId: nueva, mesasUnidas: [a] })
  })

  it('pasarse a la mesa en la que ya está es válido y no toca las unidas', () => {
    const { pedido, mesa, estado } = conMesa()
    const a = nuevoId()
    const r = aplicarTodos([unir(pedido, a), pasar(pedido, mesa)], estado)
    expect(r).toMatchObject({ mesaId: mesa, mesasUnidas: [a] })
  })

  it('pasar y volver a una mesa nunca deja la principal dentro de las unidas', () => {
    const { pedido, mesa, estado } = conMesa()
    const a = nuevoId()
    const r = aplicarTodos([unir(pedido, a), pasar(pedido, a), pasar(pedido, mesa)], estado)
    expect(r.mesaId).toBe(mesa)
    expect(r.mesasUnidas).not.toContain(mesa)
  })

  it('tras pasarse a una mesa unida, ya no se puede soltar como unida', () => {
    const { pedido, estado } = conMesa()
    const a = nuevoId()
    const r = aplicarTodos([unir(pedido, a), pasar(pedido, a)], estado)
    expect(problemaDe(r, separar(pedido, a))).toBe('mesas_no_unidas')
  })

  it('un pedido de barra que se pasa a una mesa queda con mesa y sin unidas', () => {
    const { pedido, estado } = conMesa(null)
    const mesa = nuevoId()
    expect(aplicarTodos([pasar(pedido, mesa)], estado)).toMatchObject({
      mesaId: mesa,
      mesasUnidas: [],
    })
  })
})

describe('reconstrucción con mesas unidas', () => {
  it('el mismo resultado al reconstruir que al aplicar uno por uno', () => {
    const { pedido, estado } = conMesa()
    const [a, b] = [nuevoId(), nuevoId()]
    const eventos = [
      unir(pedido, a, b),
      pasar(pedido, a),
      separar(pedido, b),
      unir(pedido, nuevoId()),
    ]
    const uno = aplicarTodos(eventos, estado)
    const abierto = evento(pedido, 'PedidoAbierto', {
      canal: 'salon',
      mesa_id: estado.mesaId,
      comensales: 2,
    })
    const todos = [abierto, ...eventos].map((e, i) => ({ ...e, secuencia: i + 1 }))
    const rec = reconstruir(todos, pedido)
    expect(rec?.mesasUnidas).toEqual(uno.mesasUnidas)
    expect(rec?.mesaId).toBe(uno.mesaId)
  })

  it('un evento de unión tolera datos de más o de menos sin lanzar (queda como evento_invalido)', () => {
    const { pedido, estado } = conMesa()
    const roto = { ...unir(pedido, nuevoId()), datos: {} } as unknown as Parameters<
      typeof aplicarEvento
    >[1]
    const r = aplicarEvento(estado, roto)
    expect(r.problema).not.toBeNull()
    expect(r.estado).toEqual(estado)
  })
})

describe('esquema de MesasUnidas y MesasSeparadas', () => {
  const sobre = (tipo: string, datos: unknown) => ({
    id: nuevoId(),
    tipo,
    version_esquema: 1,
    agregado_tipo: 'pedido',
    agregado_id: nuevoId(),
    relacionados: [],
    datos,
    sesion_id: null,
    usuario_id: MESERO,
    dispositivo_id: nuevoId(),
    autorizacion_id: null,
    motivo: null,
    hora_dispositivo: HORA,
    hora_estimada_hub: HORA,
    secuencia_base: 0,
  })
  const ok = (tipo: string, datos: unknown) => validarEventoNuevo(sobre(tipo, datos)).ok
  const ids = (n: number) => Array.from({ length: n }, () => nuevoId())

  it.each(['MesasUnidas', 'MesasSeparadas'])('%s acepta de 1 a 10 mesas distintas', (tipo) => {
    expect(ok(tipo, { mesa_ids: ids(1) })).toBe(true)
    expect(ok(tipo, { mesa_ids: ids(10) })).toBe(true)
  })

  it.each(['MesasUnidas', 'MesasSeparadas'])(
    '%s rechaza vacío, más de 10, repetidas, ids malos y campos de más',
    (tipo) => {
      const repetida = nuevoId()
      expect(ok(tipo, { mesa_ids: [] })).toBe(false)
      expect(ok(tipo, { mesa_ids: ids(11) })).toBe(false)
      expect(ok(tipo, { mesa_ids: [repetida, repetida] })).toBe(false)
      expect(ok(tipo, { mesa_ids: ['mesa-5'] })).toBe(false)
      expect(ok(tipo, { mesa_ids: [nuevoId().toLowerCase()] })).toBe(false)
      expect(ok(tipo, { mesa_ids: 'x' })).toBe(false)
      expect(ok(tipo, {})).toBe(false)
      expect(ok(tipo, { mesa_ids: ids(1), extra: 1 })).toBe(false)
      expect(ok(tipo, { mesa_ids: ids(1).concat([null as unknown as string]) })).toBe(false)
    },
  )

  it('son eventos del pedido (agregado pedido) y no exigen motivo', () => {
    expect(validarEventoNuevo(sobre('MesasUnidas', { mesa_ids: ids(2) })).ok).toBe(true)
    expect(
      validarEventoNuevo({
        ...sobre('MesasUnidas', { mesa_ids: ids(2) }),
        agregado_tipo: 'producto',
      }).ok,
    ).toBe(false)
  })
})
