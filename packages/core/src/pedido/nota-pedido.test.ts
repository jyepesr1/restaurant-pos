import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { permisoPara } from '../acceso/permisos'
import { type EventoPedido, validarEventoNuevo } from '../eventos/pedido'
import { nuevoId } from '../id'
import { barajar } from '../pruebas/congelar'
import { copiaItem, enOrden, evento, HORA, MESERO } from '../pruebas/fabrica'
import { accionArb, Servicio } from '../pruebas/simulador'
import { aplicarEvento, reconstruir } from './aplicar'
import type { EstadoPedido } from './estado'
import { totalesPedido } from './totales'

// `NotaPedidoCambiada { notas }`: la nota de todo el pedido («alérgico al maní»). Va en cada
// comanda y en la tarjeta de cocina. Decisión de estas pruebas sobre el pedido cerrado o
// cancelado: la nota NO está en SIN_MONTOS, así que se rechaza con `pedido_cerrado` (igual que
// ComensalesCambiados); para cambiarla hay que reabrir el pedido.

function aplicarTodos(eventos: EventoPedido[], inicial: EstadoPedido | null = null): EstadoPedido {
  return eventos.reduce<EstadoPedido | null>((estado, e) => {
    const r = aplicarEvento(estado, enOrden(e, estado?.ultimaSecuencia ?? 0))
    if (r.problema) throw new Error(`${e.tipo}: ${r.problema.tipo} (${r.problema.descripcion})`)
    return r.estado
  }, inicial) as EstadoPedido
}

function abierto() {
  const pedido = nuevoId()
  return {
    pedido,
    estado: aplicarTodos([
      evento(pedido, 'PedidoAbierto', { canal: 'salon', mesa_id: nuevoId(), comensales: 2 }),
    ]),
  }
}

const nota = (pedido: string, notas: string | null) =>
  evento(pedido, 'NotaPedidoCambiada', { notas })

/** Aplica un solo evento y devuelve el resultado completo (con `problema` si lo hay). */
const intentar = (estado: EstadoPedido, e: EventoPedido) =>
  aplicarEvento(estado, enOrden(e, estado.ultimaSecuencia))

describe('NotaPedidoCambiada: el reductor', () => {
  it('un pedido recién abierto no tiene nota (null, no undefined)', () => {
    const { estado } = abierto()
    expect(estado.notas).toBeNull()
    expect(estado).toHaveProperty('notas', null)
  })

  it('pone la nota tal cual cuando no tiene espacios de más', () => {
    const { pedido, estado } = abierto()
    expect(aplicarTodos([nota(pedido, 'alérgico al maní')], estado).notas).toBe('alérgico al maní')
  })

  it.each([
    ['cadena vacía', ''],
    ['un espacio', ' '],
    ['solo espacios', '     '],
    ['tabuladores y saltos de línea', '\t\n  \r\n'],
    ['null', null],
  ])('quita la nota cuando llega %s', (_, valor) => {
    const { pedido, estado } = abierto()
    const con = aplicarTodos([nota(pedido, 'sin cebolla')], estado)
    expect(con.notas).toBe('sin cebolla')
    expect(aplicarTodos([nota(pedido, valor)], con).notas).toBeNull()
  })

  it('quitar una nota que no existe es válido y deja null', () => {
    const { pedido, estado } = abierto()
    expect(aplicarTodos([nota(pedido, null)], estado).notas).toBeNull()
    expect(aplicarTodos([nota(pedido, '   ')], estado).notas).toBeNull()
  })

  it('recorta los espacios del principio y del final, pero respeta los de adentro', () => {
    const { pedido, estado } = abierto()
    expect(aplicarTodos([nota(pedido, '  todo   junto \n')], estado).notas).toBe('todo   junto')
  })

  it('acepta exactamente 500 caracteres y los conserva enteros', () => {
    const { pedido, estado } = abierto()
    const larga = 'a'.repeat(500)
    expect(aplicarTodos([nota(pedido, larga)], estado).notas).toBe(larga)
  })

  it('500 caracteres con espacios en los bordes se guardan recortados (menos de 500)', () => {
    const { pedido, estado } = abierto()
    const conBordes = ` ${'b'.repeat(498)} `
    expect(conBordes).toHaveLength(500)
    expect(aplicarTodos([nota(pedido, conBordes)], estado).notas).toBe('b'.repeat(498))
  })

  it('500 espacios dejan la nota en null', () => {
    const { pedido, estado } = abierto()
    expect(aplicarTodos([nota(pedido, ' '.repeat(500))], estado).notas).toBeNull()
  })

  it('texto con emojis, acentos y comillas pasa intacto', () => {
    const { pedido, estado } = abierto()
    const texto = '¡Cumpleaños! «sin maní» 🎂 ñandú'
    expect(aplicarTodos([nota(pedido, texto)], estado).notas).toBe(texto)
  })

  it('gana la última: cambiar la nota reemplaza la anterior, no se acumula', () => {
    const { pedido, estado } = abierto()
    const final = aplicarTodos(
      [nota(pedido, 'primera'), nota(pedido, 'segunda'), nota(pedido, 'tercera')],
      estado,
    )
    expect(final.notas).toBe('tercera')
  })

  it('la misma nota dos veces seguidas es válida y deja el mismo estado', () => {
    const { pedido, estado } = abierto()
    const una = aplicarTodos([nota(pedido, 'sin sal')], estado)
    const dos = aplicarTodos([nota(pedido, 'sin sal')], una)
    expect({ ...dos, ultimaSecuencia: 0 }).toEqual({ ...una, ultimaSecuencia: 0 })
  })

  it('no toca ítems, descuentos, pagos ni totales', () => {
    const { pedido, estado } = abierto()
    const pizza = copiaItem()
    const conItem = aplicarTodos([evento(pedido, 'ItemAgregado', pizza)], estado)
    const con = aplicarTodos([nota(pedido, 'alérgico')], conItem)
    expect(totalesPedido(con)).toEqual(totalesPedido(conItem))
    expect(con.items).toEqual(conItem.items)
    expect(con.comensales).toBe(conItem.comensales)
    expect(con.estado).toBe('abierto')
  })

  it('la nota sobrevive a enviar ítems a cocina', () => {
    const { pedido, estado } = abierto()
    const pizza = copiaItem()
    const final = aplicarTodos(
      [
        nota(pedido, 'alérgico al maní'),
        evento(pedido, 'ItemAgregado', pizza),
        evento(pedido, 'ItemsEnviados', {
          comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [pizza.item_id] }],
        }),
      ],
      estado,
    )
    expect(final.notas).toBe('alérgico al maní')
  })

  it('no muta el estado de entrada', () => {
    const { pedido, estado } = abierto()
    const copia = structuredClone(estado)
    aplicarEvento(estado, enOrden(nota(pedido, 'x'), estado.ultimaSecuencia))
    expect(estado).toEqual(copia)
  })

  it('un evento de otro pedido no cambia la nota', () => {
    const { estado } = abierto()
    const r = intentar(estado, nota(nuevoId(), 'ajena'))
    expect(r.problema?.tipo).toBe('evento_ajeno')
    expect(r.estado?.notas).toBeNull()
  })

  it('sin pedido abierto no hay a quién ponerle la nota (pedido_inexistente)', () => {
    const r = aplicarEvento(null, nota(nuevoId(), 'x'))
    expect(r.problema?.tipo).toBe('pedido_inexistente')
    expect(r.estado).toBeNull()
  })

  it('un evento ya aplicado (misma secuencia) se ignora', () => {
    const { pedido, estado } = abierto()
    const e = enOrden(nota(pedido, 'una vez'), estado.ultimaSecuencia)
    const uno = aplicarEvento(estado, e)
    expect(uno.estado?.notas).toBe('una vez')
    const dos = aplicarEvento(uno.estado, { ...e, datos: { notas: 'otra' } })
    expect(dos.problema?.tipo).toBe('evento_ya_aplicado')
    expect(dos.estado?.notas).toBe('una vez')
  })
})

describe('NotaPedidoCambiada con el pedido cerrado o cancelado', () => {
  const cerrado = () => {
    const { pedido, estado } = abierto()
    const pizza = copiaItem({ precio_unitario: 10_000 })
    const conItem = aplicarTodos([evento(pedido, 'ItemAgregado', pizza)], estado)
    // Anular el ítem sin enviar: queda en cero y el pedido se puede cerrar sin pagos.
    return { pedido, conItem }
  }

  it('cancelado: la nota se rechaza con pedido_cerrado y el estado no cambia', () => {
    const { pedido, estado } = abierto()
    const con = aplicarTodos([nota(pedido, 'antes')], estado)
    const cancelado = aplicarTodos(
      [evento(pedido, 'PedidoCancelado', {}, { motivo: 'Se fueron' })],
      con,
    )
    expect(cancelado.estado).toBe('cancelado')
    const r = intentar(cancelado, nota(pedido, 'después'))
    expect(r.problema?.tipo).toBe('pedido_cerrado')
    expect(r.estado?.notas).toBe('antes')
  })

  it('cancelado: tampoco se puede quitar la nota', () => {
    const { pedido, estado } = abierto()
    const con = aplicarTodos([nota(pedido, 'antes')], estado)
    const cancelado = aplicarTodos(
      [evento(pedido, 'PedidoCancelado', {}, { motivo: 'Se fueron' })],
      con,
    )
    const r = intentar(cancelado, nota(pedido, null))
    expect(r.problema?.tipo).toBe('pedido_cerrado')
    expect(r.estado?.notas).toBe('antes')
  })

  it('cerrado: se rechaza con pedido_cerrado; reabierto, vuelve a aceptarse', () => {
    const { pedido, conItem } = cerrado()
    const quitado = aplicarTodos(
      [
        evento(pedido, 'ItemQuitado', { item_id: Object.keys(conItem.items)[0] as string }),
        nota(pedido, 'antes'),
        evento(pedido, 'PedidoCerrado', {}, { dia_operativo: '2026-10-24' }),
      ],
      conItem,
    )
    expect(quitado.estado).toBe('cerrado')
    const r = intentar(quitado, nota(pedido, 'después'))
    expect(r.problema?.tipo).toBe('pedido_cerrado')
    expect(r.estado?.notas).toBe('antes')

    const reabierto = aplicarTodos(
      [evento(pedido, 'PedidoReabierto', {}, { motivo: 'Faltó cobrar algo' })],
      quitado,
    )
    expect(reabierto.notas).toBe('antes')
    expect(aplicarTodos([nota(pedido, 'después')], reabierto).notas).toBe('después')
  })
})

describe('pedidos viejos y reconstrucción', () => {
  it('reconstruir un pedido sin ningún NotaPedidoCambiada da notas null', () => {
    const pedido = nuevoId()
    const pizza = copiaItem()
    const log = [
      evento(pedido, 'PedidoAbierto', { canal: 'salon', mesa_id: nuevoId(), comensales: 3 }),
      evento(pedido, 'ItemAgregado', pizza),
      evento(pedido, 'ComensalesCambiados', { comensales: 4 }),
    ]
    const estado = reconstruir(log, pedido)
    expect(estado).toHaveProperty('notas', null)
    expect(estado?.notas).toBeNull()
    expect(estado?.comensales).toBe(4)
  })

  it('un pedido de rescate también nace sin nota', () => {
    const original = nuevoId()
    const rescate = nuevoId()
    const e = evento(rescate, 'PedidoRescateCreado', {
      pedido_original_id: original,
      mesa_id: null,
      mesero_id: nuevoId(),
      canal: 'salon',
    })
    const estado = reconstruir([e], rescate)
    expect(estado?.notas ?? null).toBeNull()
  })

  it('reconstruir con la nota en medio del log la deja puesta', () => {
    const pedido = nuevoId()
    const log = [
      evento(pedido, 'PedidoAbierto', { canal: 'salon', mesa_id: nuevoId(), comensales: 2 }),
      nota(pedido, 'alérgico al maní'),
      evento(pedido, 'ItemAgregado', copiaItem()),
    ]
    expect(reconstruir(log, pedido)?.notas).toBe('alérgico al maní')
  })

  it('reconstruir ignora un evento de nota duplicado (mismo id)', () => {
    const pedido = nuevoId()
    const apertura = evento(pedido, 'PedidoAbierto', {
      canal: 'salon',
      mesa_id: nuevoId(),
      comensales: 2,
    })
    const n = nota(pedido, 'una')
    const log = [apertura, n, n]
    expect(reconstruir(log, pedido)?.notas).toBe('una')
  })

  it('reconstruir con los eventos desordenados da la nota de la última secuencia', () => {
    const pedido = nuevoId()
    const log = [
      evento(pedido, 'PedidoAbierto', { canal: 'salon', mesa_id: nuevoId(), comensales: 2 }),
      nota(pedido, 'vieja'),
      nota(pedido, 'nueva'),
    ]
    for (const semilla of [1, 2, 3, 4, 5, 99]) {
      expect(reconstruir(barajar(log, semilla), pedido)?.notas).toBe('nueva')
    }
    expect(reconstruir([...log].reverse(), pedido)?.notas).toBe('nueva')
  })

  it('al unir pedidos, el destino conserva SU nota y la del origen no pasa (hueco conocido)', () => {
    // Documenta el comportamiento actual (aplicar.ts, PedidosUnidos): la nota del pedido que se
    // une se pierde junto con el origen cancelado. Una alergia anotada en el origen deja de
    // salir en las comandas del destino. Se avisa en el informe de QA.
    const origen = nuevoId()
    const destino = nuevoId()
    const item = copiaItem()
    const apertura = (id: string) =>
      evento(id, 'PedidoAbierto', { canal: 'salon', mesa_id: nuevoId(), comensales: 2 })
    const eOrigen = [
      apertura(origen),
      nota(origen, 'alérgico al maní'),
      evento(origen, 'ItemAgregado', item),
    ]
    const eDestino = [apertura(destino), nota(destino, 'cumpleaños')]
    const union = evento(destino, 'PedidosUnidos', {
      pedido_origen_id: origen,
      items: [{ item, estado: 'pendiente', cantidad_anulada: 0, agregado_por: MESERO }],
    })
    const log = [...eOrigen, ...eDestino, union]
    expect(reconstruir(log, destino)?.notas).toBe('cumpleaños')
    expect(reconstruir(log, origen)?.estado).toBe('cancelado')
  })
})

describe('esquema de NotaPedidoCambiada', () => {
  const sobre = (datos: unknown) => ({
    id: nuevoId(),
    tipo: 'NotaPedidoCambiada',
    version_esquema: 1,
    agregado_tipo: 'pedido',
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
  })
  const valido = (datos: unknown) => validarEventoNuevo(sobre(datos)).ok

  it('acepta texto, vacío y null; 500 caracteres justos', () => {
    expect(valido({ notas: 'sin hielo' })).toBe(true)
    expect(valido({ notas: '' })).toBe(true)
    expect(valido({ notas: null })).toBe(true)
    expect(valido({ notas: 'a'.repeat(500) })).toBe(true)
  })

  it('rechaza 501 caracteres, tipos que no son texto, campo faltante y campos de más', () => {
    expect(valido({ notas: 'a'.repeat(501) })).toBe(false)
    expect(valido({ notas: 5 })).toBe(false)
    expect(valido({ notas: true })).toBe(false)
    expect(valido({ notas: ['x'] })).toBe(false)
    expect(valido({})).toBe(false)
    expect(valido({ notas: undefined })).toBe(false)
    expect(valido({ notas: 'x', extra: 1 })).toBe(false)
    expect(valido(null)).toBe(false)
  })

  it('el agregado debe ser un pedido', () => {
    expect(validarEventoNuevo({ ...sobre({ notas: 'x' }), agregado_tipo: 'producto' }).ok).toBe(
      false,
    )
  })

  it('el permiso que exige es tomar_pedido, con o sin pedido en el estado', () => {
    const e = evento(nuevoId(), 'NotaPedidoCambiada', { notas: 'x' })
    expect(permisoPara(e)).toBe('tomar_pedido')
    expect(permisoPara(e, abierto().estado)).toBe('tomar_pedido')
    expect(permisoPara(evento(nuevoId(), 'NotaPedidoCambiada', { notas: null }))).toBe(
      'tomar_pedido',
    )
  })
})

describe('propiedades con el simulador', () => {
  const secuencia = fc.array(accionArb, { minLength: 10, maxLength: 80, size: 'max' })
  const CONFIG = { seed: 20_261_025, numRuns: 400 }

  /** Lo que debería quedar tras la última nota aplicada a ese pedido. */
  const esperada = (servicio: Servicio, id: string): string | null => {
    const ultima = servicio.aplicados
      .filter((e) => e.tipo === 'NotaPedidoCambiada' && e.agregado_id === id)
      .at(-1)
    if (ultima?.tipo !== 'NotaPedidoCambiada') return null
    return ultima.datos.notas?.trim() || null
  }

  it('la nota del estado es siempre la de la última nota aplicada, recortada, o null', () => {
    let conNota = 0
    fc.assert(
      fc.property(secuencia, (acciones) => {
        const servicio = new Servicio()
        for (const accion of acciones) servicio.paso(accion)
        expect(servicio.invalidos).toEqual([])
        for (const p of [0, 1] as const) {
          const estado = servicio.estados[p]
          expect(estado?.notas ?? null).toBe(esperada(servicio, servicio.pedidos[p]))
          if (estado?.notas) conNota += 1
        }
      }),
      CONFIG,
    )
    // El simulador sí ejerce la nota: no es una propiedad vacía.
    expect(conNota).toBeGreaterThan(0)
  })

  it('nunca queda una nota vacía, con espacios en los bordes ni de más de 500', () => {
    fc.assert(
      fc.property(secuencia, (acciones) => {
        const servicio = new Servicio()
        for (const accion of acciones) servicio.paso(accion)
        for (const estado of servicio.estados) {
          if (!estado || estado.notas === null) continue
          expect(estado.notas.length).toBeGreaterThan(0)
          expect(estado.notas.length).toBeLessThanOrEqual(500)
          expect(estado.notas).toBe(estado.notas.trim())
        }
      }),
      { ...CONFIG, seed: 20_261_030 },
    )
  })

  it('reconstruir barajado o invertido conserva la nota', () => {
    fc.assert(
      fc.property(secuencia, fc.integer({ min: 0, max: 2 ** 31 }), (acciones, semilla) => {
        const servicio = new Servicio()
        for (const accion of acciones) servicio.paso(accion)
        for (const p of [0, 1] as const) {
          const id = servicio.pedidos[p]
          const esperado = servicio.estados[p]?.notas ?? null
          expect(reconstruir(barajar(servicio.log, semilla), id)?.notas ?? null).toBe(esperado)
          expect(reconstruir([...servicio.log].reverse(), id)?.notas ?? null).toBe(esperado)
        }
      }),
      { ...CONFIG, seed: 20_261_031 },
    )
  })

  it('texto arbitrario: el reductor siempre guarda el texto recortado o null', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (texto) => {
        const { pedido, estado } = abierto()
        const e = enOrden(nota(pedido, texto), estado.ultimaSecuencia)
        const r = aplicarEvento(estado, e)
        expect(r.problema).toBeNull()
        expect(r.estado?.notas).toBe(texto.trim() || null)
      }),
      { seed: 20_261_032, numRuns: 300 },
    )
  })
})
