import { type EventoNuevo, type EventoPedido, nuevoId } from '@pos/core'
import { aplicarMigraciones } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import { describe, expect, it } from 'vitest'
import { AlmacenDispositivoMemoria } from './dispositivo/almacen'
import { AlmacenMemoria } from './hub/almacen'
import { AlmacenSqlite } from './hub/almacen-sqlite'
import { HubSync } from './hub/hub'
import { SalaSync } from './hub/sala'
import { accesoLibre } from './pruebas/acceso'
import { type Nodo, RedSimulada } from './pruebas/red'

// Escenarios de aceptación de la tarea 0.6 (docs/SYNC.md#pruebas-de-aceptación-tarea-06).

const AHORA = '2026-10-24T15:00:00.000Z'

function baseSqlite() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db)
  const restauranteId = nuevoId()
  db.prepare(
    `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
     VALUES (?, ?, ?, ?, 1, 'La Spritzzería', '{}')`,
  ).run(restauranteId, restauranteId, AHORA, AHORA)
  return { db, restauranteId }
}

/**
 * Hub + red simulada. Con `caer`, el almacén lanza al guardar el evento número `caer` y, como un
 * proceso apagado, no guarda nada más hasta que el hub se levanta.
 */
function montar(opciones: { almacen?: 'sqlite' | 'memoria'; caer?: number } = {}) {
  const { db, restauranteId } = baseSqlite()
  let guardados = 0
  let caido = false
  class AlmacenQueSeCae extends AlmacenSqlite {
    override transaccion<T>(trabajo: () => T): T {
      if (caido) throw new Error('el hub está apagado')
      return super.transaccion(trabajo)
    }
    override guardarEvento(...args: Parameters<AlmacenSqlite['guardarEvento']>) {
      guardados += 1
      if (guardados === opciones.caer) {
        caido = true
        throw new Error('el hub se apagó')
      }
      super.guardarEvento(...args)
    }
  }
  const almacen =
    opciones.almacen === 'memoria' ? new AlmacenMemoria() : new AlmacenQueSeCae(db, restauranteId)
  const estado: { hub: HubSync | null; instancia: string } = { hub: null, instancia: 'hub-1' }
  const red: RedSimulada = new RedSimulada(null as unknown as SalaSync)
  const crearSala = (almacenHub = almacen) => {
    estado.hub = new HubSync(almacenHub, {
      restauranteId,
      zonaHoraria: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      acceso: accesoLibre,
      instancia: estado.instancia,
      reloj: red.horaIso,
    })
    return new SalaSync(estado.hub, red.autenticar)
  }
  red.sala = crearSala()
  red.alCaerHub = () => {
    caido = false
    return crearSala()
  }
  return { red, db, almacen, hub: () => estado.hub as HubSync, crearSala, estado }
}

const abrirPedido = (nodo: Nodo, pedido = nuevoId(), mesa: string | null = nuevoId()) =>
  nodo
    .crear(pedido, 'PedidoAbierto', { canal: 'salon', mesa_id: mesa, comensales: 2 })
    .then(() => pedido)

const item = (precio = 40_900, campos = {}) => ({
  item_id: nuevoId(),
  producto_id: nuevoId(),
  variante_id: null,
  nombre: 'Garden Margarita',
  precio_unitario: precio,
  impuesto_tipo: 'inc' as const,
  tarifa: 800,
  cantidad: 1,
  comensal: null,
  curso: null,
  modificadores: [],
  notas: null,
  catalogo_version: 1,
  precio_canal_id: null,
  ...campos,
})

/** "Ven lo mismo": el hub tiene los eventos 1..N sin huecos y cada dispositivo, iguales proyecciones. */
async function venLoMismo(
  hub: HubSync,
  eventosHub: EventoPedido[],
  nodos: Nodo[],
  pedidos: string[],
) {
  expect(eventosHub.map((e) => e.secuencia)).toEqual(eventosHub.map((_, i) => i + 1))
  expect(new Set(eventosHub.map((e) => e.id)).size).toBe(eventosHub.length)
  for (const nodo of nodos) {
    expect(await nodo.cliente.pendientes()).toBe(0)
    const confirmados = (await nodo.cliente.locales())
      .filter((l) => l.estado === 'confirmado')
      .map((l) => l.evento.id)
    expect(new Set(confirmados)).toEqual(new Set(eventosHub.map((e) => e.id)))
    for (const pedido of pedidos)
      expect(await nodo.cliente.pedido(pedido)).toEqual(hub.pedido(pedido))
  }
}

const eventosDe = (m: ReturnType<typeof montar>) => m.almacen.eventosDesde(0, 100_000)

describe('escenarios de sincronización', () => {
  it('1. dos dispositivos sin hub crean pedidos en mesas distintas y al reconectar ven lo mismo, sin duplicados', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const luis = m.red.dispositivo('luis')

    const p1 = await abrirPedido(ana)
    await ana.crear(p1, 'ItemAgregado', item())
    const p2 = await abrirPedido(luis)
    await luis.crear(p2, 'ItemAgregado', item(12_900))
    expect(await ana.cliente.pendientes()).toBe(2)

    await m.red.conectarTodos()
    // Reconectar otra vez no duplica nada.
    ana.desconectar()
    luis.desconectar()
    await m.red.conectarTodos()

    expect(eventosDe(m)).toHaveLength(4)
    await venLoMismo(m.hub(), eventosDe(m), [ana, luis], [p1, p2])
    expect(m.hub().pedido(p1)?.numeroDia).toBe(1)
    expect(m.hub().pedido(p2)?.numeroDia).toBe(2)
  })

  it('2. los dos agregan ítems al mismo pedido sin conexión: se conservan todos', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const luis = m.red.dispositivo('luis')
    await m.red.conectarTodos()
    const pedido = await abrirPedido(ana)
    await m.red.estabilizar()

    ana.desconectar()
    luis.desconectar()
    await ana.crear(pedido, 'ItemAgregado', item())
    await luis.crear(pedido, 'ItemAgregado', item(12_900))
    await luis.crear(pedido, 'ItemAgregado', item(8900))
    await m.red.conectarTodos()

    expect(Object.keys(m.hub().pedido(pedido)?.items ?? {})).toHaveLength(3)
    await venLoMismo(m.hub(), eventosDe(m), [ana, luis], [pedido])
  })

  it('3. los dos abren la misma mesa sin conexión: dos pedidos y exactamente un conflicto, también al reenviar', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const luis = m.red.dispositivo('luis')
    const mesa = nuevoId()
    const p1 = await abrirPedido(ana, nuevoId(), mesa)
    const p2 = await abrirPedido(luis, nuevoId(), mesa)

    luis.regla('al_hub', 'empujar', 'duplicar')
    await m.red.conectarTodos()

    expect(m.hub().pedido(p1)?.estado).toBe('abierto')
    expect(m.hub().pedido(p2)?.estado).toBe('abierto')
    expect(
      m
        .hub()
        .conflictos()
        .map((c) => c.tipo),
    ).toEqual(['mesa_duplicada'])
    const conflictivo = (await luis.cliente.locales()).find((l) => l.evento.agregado_id === p2)
    expect(conflictivo?.conflicto).toBe('mesa_duplicada')
    await venLoMismo(m.hub(), eventosDe(m), [ana, luis], [p1, p2])
  })

  it('3b. con la información al día, abrir una mesa ocupada se rechaza', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const luis = m.red.dispositivo('luis')
    await m.red.conectarTodos()
    const mesa = nuevoId()
    await abrirPedido(ana, nuevoId(), mesa)
    await m.red.estabilizar()

    const p2 = await abrirPedido(luis, nuevoId(), mesa)
    await m.red.estabilizar()

    expect((await luis.cliente.locales()).find((l) => l.evento.agregado_id === p2)).toMatchObject({
      estado: 'rechazado',
      motivo: 'mesa_ocupada',
    })
    expect(m.hub().pedido(p2)).toBeNull()
  })

  it('4. se pierde la respuesta y el mismo lote llega dos veces: sin duplicados', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const luis = m.red.dispositivo('luis')
    await m.red.conectarTodos()

    ana.regla('al_dispositivo', 'resultado', 'perder')
    ana.regla('al_dispositivo', 'nuevo', 'perder', 2)
    const pedido = await abrirPedido(ana)
    await ana.crear(pedido, 'ItemAgregado', item())
    await m.red.estabilizar()
    expect(await ana.cliente.pendientes()).toBe(2)

    // La conexión se reabre (por ejemplo, al volver a la pantalla) y el lote se reenvía.
    ana.desconectar()
    await m.red.conectarTodos()

    expect(eventosDe(m)).toHaveLength(2)
    await venLoMismo(m.hub(), eventosDe(m), [ana, luis], [pedido])
  })

  it('5a. el hub se cae a mitad de un lote: al volver, nada perdido ni duplicado', async () => {
    const m = montar({ caer: 3 })
    const ana = m.red.dispositivo('ana')
    const pedido = await abrirPedido(ana)
    for (const precio of [10_000, 20_000, 30_000])
      await ana.crear(pedido, 'ItemAgregado', item(precio))

    await m.red.conectarTodos()
    expect(ana.enLinea).toBe(false)
    expect(eventosDe(m)).toHaveLength(2)

    await m.red.conectarTodos()
    expect(eventosDe(m)).toHaveLength(4)
    await venLoMismo(m.hub(), eventosDe(m), [ana], [pedido])
  })

  it('5b. el hub guarda y se cae antes de responder: el reenvío no duplica', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    await m.red.conectarTodos()
    ana.regla('al_dispositivo', 'resultado', 'perder')
    ana.regla('al_dispositivo', 'nuevo', 'perder', 5)
    const pedido = await abrirPedido(ana)
    await ana.crear(pedido, 'ItemAgregado', item())
    await m.red.estabilizar()

    m.red.caerHub()
    await m.red.conectarTodos()

    expect(eventosDe(m)).toHaveLength(2)
    await venLoMismo(m.hub(), eventosDe(m), [ana], [pedido])
  })

  it('6. un dispositivo con el reloj desfasado horas: el orden sale de la secuencia', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const luis = m.red.dispositivo('luis')
    luis.desfaseMs = -5 * 60 * 60 * 1000
    await m.red.conectarTodos()
    const pedido = await abrirPedido(ana)
    await m.red.estabilizar()

    const primero = item(10_000)
    const segundo = item(20_000)
    await ana.crear(pedido, 'ItemAgregado', primero)
    await m.red.estabilizar()
    await luis.crear(pedido, 'ItemAgregado', segundo)
    await m.red.estabilizar()

    const estado = m.hub().pedido(pedido)
    expect(estado?.items[primero.item_id]?.orden).toBe(1)
    expect(estado?.items[segundo.item_id]?.orden).toBe(2)
    // La hora del dispositivo de Luis es 5 horas "anterior", pero no cambia el orden.
    const [, e1, e2] = eventosDe(m)
    expect((e2?.hora_dispositivo ?? '') < (e1?.hora_dispositivo ?? '')).toBe(true)
    expect(e2?.secuencia).toBeGreaterThan(e1?.secuencia ?? 0)
    await venLoMismo(m.hub(), eventosDe(m), [ana, luis], [pedido])
  })

  it('7. un rechazo arrastra a sus dependientes del mismo pedido y el dispositivo deshace su efecto', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const luis = m.red.dispositivo('luis')
    await m.red.conectarTodos()
    const pedido = await abrirPedido(ana)
    await m.red.estabilizar()
    const otro = await abrirPedido(luis)
    await m.red.estabilizar()

    ana.desconectar()
    // 999 unidades de $100.000.000 pasan del tope del pedido: se rechaza, y lo siguiente del pedido también.
    const caro = item(100_000_000, { cantidad: 999 })
    await ana.crear(pedido, 'ItemAgregado', caro)
    const despues = item()
    await ana.crear(pedido, 'ItemAgregado', despues)
    await ana.crear(otro, 'ItemAgregado', item(5000))
    // En el propio celular el ítem que pasa del tope ya no se aplica; el siguiente sí, por ahora.
    expect(Object.keys((await ana.cliente.pedido(pedido))?.items ?? {})).toHaveLength(1)

    await m.red.conectarTodos()

    const locales = await ana.cliente.locales()
    expect(
      locales.find(
        (l) =>
          l.evento.id && (l.evento as EventoNuevo<'ItemAgregado'>).datos.item_id === caro.item_id,
      )?.motivo,
    ).toBe('total_excede')
    expect(
      locales.find(
        (l) => (l.evento as EventoNuevo<'ItemAgregado'>).datos.item_id === despues.item_id,
      )?.motivo,
    ).toBe('depende_de_rechazado')
    expect(Object.keys((await ana.cliente.pedido(pedido))?.items ?? {})).toHaveLength(0)
    // El evento de otro pedido no dependía y se aceptó.
    expect(Object.keys(m.hub().pedido(otro)?.items ?? {})).toHaveLength(1)
    await venLoMismo(m.hub(), eventosDe(m), [luis], [pedido, otro])
  })

  it('8. llega un evento con un hueco: el dispositivo trae lo que falta antes de avanzar', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const caja = m.red.dispositivo('caja')
    await m.red.conectarTodos()

    caja.regla('al_dispositivo', 'nuevo', 'perder')
    const pedido = await abrirPedido(ana)
    await ana.crear(pedido, 'ItemAgregado', item())
    await ana.crear(pedido, 'ItemAgregado', item(12_900))
    await m.red.estabilizar()

    expect((await caja.almacen.cursor()).hasta).toBe(3)
    await venLoMismo(m.hub(), eventosDe(m), [ana, caja], [pedido])
  })

  it('9. el hub se restaura de un respaldo viejo: los dispositivos reenvían y todos quedan iguales', async () => {
    const m = montar({ almacen: 'memoria' })
    const ana = m.red.dispositivo('ana')
    const luis = m.red.dispositivo('luis')
    await m.red.conectarTodos()
    const pedido = await abrirPedido(ana)
    await ana.crear(pedido, 'ItemAgregado', item())
    await m.red.estabilizar()
    const respaldo = structuredClone((m.almacen as AlmacenMemoria).eventos)

    await luis.crear(pedido, 'ItemAgregado', item(12_900))
    await ana.crear(pedido, 'ItemAgregado', item(8900))
    await m.red.estabilizar()
    expect(eventosDe(m)).toHaveLength(4)

    // Se restaura el respaldo (2 eventos) en un hub reinstalado.
    for (const nodo of m.red.nodos) nodo.desconectar()
    const restaurado = new AlmacenMemoria()
    restaurado.eventos = respaldo
    m.estado.instancia = 'hub-2'
    m.red.sala = m.crearSala(restaurado)
    await m.red.conectarTodos()

    const eventos = restaurado.eventosDesde(0, 1000)
    expect(eventos).toHaveLength(4)
    await venLoMismo(m.hub(), eventos, [ana, luis], [pedido])
  })

  it('10. se borran los datos de un dispositivo: al reconectar queda igual a los demás', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    await m.red.conectarTodos()
    const pedido = await abrirPedido(ana)
    await ana.crear(pedido, 'ItemAgregado', item())
    await m.red.estabilizar()

    // Mismo equipo (mismo token), almacenamiento borrado por el navegador.
    ana.desconectar()
    m.red.nodos.splice(m.red.nodos.indexOf(ana), 1)
    const anaDeNuevo = m.red.dispositivo('ana', new AlmacenDispositivoMemoria())
    await m.red.conectarTodos()

    await venLoMismo(m.hub(), eventosDe(m), [anaDeNuevo], [pedido])
  })

  it('11. más de 100 eventos pendientes se envían completos, en orden', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const pedido = await abrirPedido(ana)
    const items = Array.from({ length: 150 }, (_, i) => item(1000 + i))
    for (const i of items) await ana.crear(pedido, 'ItemAgregado', i)

    await m.red.conectarTodos()

    const eventos = eventosDe(m)
    expect(eventos).toHaveLength(151)
    const orden = eventos.slice(1).map((e) => (e.datos as { item_id: string }).item_id)
    expect(orden).toEqual(items.map((i) => i.item_id))
    await venLoMismo(m.hub(), eventos, [ana], [pedido])
  })

  it('12. un dispositivo revocado con eventos de antes de la revocación: quedan en cuarentena', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const pedido = await abrirPedido(ana)
    m.red.avanzar(60_000)
    const conexion = m.red.tokens.get('token-ana')
    if (conexion) conexion.revocadoEn = m.red.horaIso()
    m.red.avanzar(60_000)
    await ana.crear(pedido, 'ItemAgregado', item())

    await m.red.conectarTodos()

    const locales = await ana.cliente.locales()
    expect(locales.map((l) => l.estado)).toEqual(['cuarentena', 'rechazado'])
    expect(m.db.prepare('SELECT count(*) AS n FROM evento_cuarentena').get()?.n).toBe(1)
    expect(eventosDe(m)).toHaveLength(0)
  })
})

describe('hub: validaciones', () => {
  const crudo = (nodo: Nodo, extras: Record<string, unknown> = {}) => ({
    id: nuevoId(),
    tipo: 'PedidoAbierto',
    version_esquema: 1,
    agregado_tipo: 'pedido',
    agregado_id: nuevoId(),
    relacionados: [],
    datos: { canal: 'barra', mesa_id: null, comensales: 1 },
    sesion_id: null,
    usuario_id: nodo.usuarioId,
    dispositivo_id: nodo.dispositivoId,
    autorizacion_id: null,
    motivo: null,
    hora_dispositivo: AHORA,
    hora_estimada_hub: AHORA,
    secuencia_base: 0,
    ...extras,
  })
  const conexionDe = (m: ReturnType<typeof montar>, nodo: Nodo) => {
    const conexion = m.red.tokens.get(`token-${nodo.nombre}`)
    if (!conexion) throw new Error(`Sin token para ${nodo.nombre}`)
    return conexion
  }

  it('el mismo id con otro contenido se rechaza; con el mismo contenido, misma respuesta', () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const evento = crudo(ana)
    const primero = m.hub().recibirLote(conexionDe(m, ana), [evento])
    const repetido = m.hub().recibirLote(conexionDe(m, ana), [evento])
    const distinto = m
      .hub()
      .recibirLote(conexionDe(m, ana), [{ ...evento, datos: { ...evento.datos, comensales: 5 } }])

    expect(repetido.resultados).toEqual(primero.resultados)
    expect(repetido.aceptados).toEqual([])
    expect(distinto.resultados[0]).toMatchObject({ estado: 'rechazado', motivo: 'id_repetido' })
  })

  it('rechaza formato inválido, otro dispositivo y una secuencia base del futuro', () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const r = m
      .hub()
      .recibirLote(conexionDe(m, ana), [
        { ...crudo(ana), datos: { canal: 'salon' } },
        crudo(ana, { dispositivo_id: nuevoId() }),
        crudo(ana, { secuencia_base: 99 }),
        null,
      ])
    expect(
      r.resultados.map((x) => (x.estado === 'rechazado' ? x.motivo.split(':')[0] : x.estado)),
    ).toEqual(['esquema', 'dispositivo_distinto', 'secuencia_base_invalida', 'esquema'])
  })

  it('el día operativo sale de la hora estimada si es razonable; si no, de la del hub', () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    // Hub: 15:00 UTC del 24 (10 a. m. en Bogotá).
    m.red.avanzar(Date.parse(AHORA) - m.red.ahora())
    const r = m.hub().recibirLote(conexionDe(m, ana), [
      crudo(ana, { hora_estimada_hub: '2026-10-24T09:00:00.000Z' }), // 4 a. m.: día anterior
      crudo(ana, { hora_estimada_hub: '2026-10-20T09:00:00.000Z' }), // días atrás: se ignora
    ])
    expect(r.aceptados.map((e) => e.dia_operativo)).toEqual(['2026-10-23', '2026-10-24'])
  })

  it('un evento sobre un pedido cerrado: conflicto si no estaba al día, rechazo si lo estaba', () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const caja = m.red.dispositivo('caja')
    const conexion = conexionDe(m, ana)
    const pedido = nuevoId()
    const pago = {
      pago_id: nuevoId(),
      cuenta_id: null,
      turno_caja_id: nuevoId(),
      medio: 'tarjeta',
      monto: 10_000,
      propina: 0,
      recibido: null,
      cambio: null,
      ajuste_redondeo: 0,
      redondeo: null,
      datafono: {
        datafono_id: nuevoId(),
        franquicia: null,
        ultimos4: null,
        aprobacion: '1',
        recibo: null,
      },
      referencia_cobro: null,
    }
    const base = { agregado_id: pedido }
    m.hub().recibirLote(conexion, [
      crudo(ana, { ...base, datos: { canal: 'salon', mesa_id: null, comensales: 1 } }),
      crudo(ana, { ...base, tipo: 'ItemAgregado', datos: item(10_000), secuencia_base: 1 }),
    ])
    // La caja cobra y cierra: ana solo sabe de eso si su `secuencia_base` llega a 4.
    m.hub().recibirLote(conexionDe(m, caja), [
      crudo(caja, { ...base, tipo: 'PagoRegistrado', datos: pago, secuencia_base: 2 }),
      crudo(caja, { ...base, tipo: 'PedidoCerrado', datos: {}, secuencia_base: 3 }),
    ])

    const atrasado = m.hub().recibirLote(conexion, [
      crudo(ana, {
        ...base,
        tipo: 'ComensalesCambiados',
        datos: { comensales: 4 },
        secuencia_base: 2,
      }),
    ])
    const alDia = m.hub().recibirLote(conexion, [
      crudo(ana, {
        ...base,
        tipo: 'ComensalesCambiados',
        datos: { comensales: 4 },
        secuencia_base: 5,
      }),
    ])

    expect(atrasado.resultados[0]).toMatchObject({
      estado: 'confirmado',
      conflicto: 'pedido_cerrado',
    })
    expect(alDia.resultados[0]).toMatchObject({ estado: 'rechazado', motivo: 'pedido_cerrado' })
    expect(m.hub().pedido(pedido)?.comensales).toBe(1)
  })

  it('el hub reconstruye sus proyecciones desde la base al arrancar', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    await m.red.conectarTodos()
    const pedido = await abrirPedido(ana)
    await ana.crear(pedido, 'ItemAgregado', item())
    await m.red.estabilizar()
    const antes = m.hub().pedido(pedido)

    const nuevo = new HubSync(m.almacen, {
      restauranteId: '',
      zonaHoraria: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      acceso: accesoLibre,
      instancia: 'hub-1',
      reloj: m.red.horaIso,
    })
    expect(nuevo.pedido(pedido)).toEqual(antes)
  })

  it('la sala rechaza mensajes con formato inválido y tokens desconocidos', () => {
    const m = montar()
    const recibidos: unknown[] = []
    const enlace = m.red.sala.conectar((msg) => recibidos.push(msg))
    enlace.recibir({ tipo: 'empujar' })
    enlace.recibir({
      tipo: 'hola',
      token: 'desconocido',
      hub_instancia: null,
      hasta: 0,
      version_app: 'x',
    })
    enlace.recibir({ tipo: 'traer', desde: 0 })
    enlace.recibir({ tipo: 'ping', marca: 'm1' })

    expect(recibidos).toEqual([
      expect.objectContaining({ tipo: 'error', codigo: 'mensaje_invalido' }),
      expect.objectContaining({ tipo: 'error', codigo: 'token_invalido' }),
      expect.objectContaining({ tipo: 'error', codigo: 'token_invalido' }),
      { tipo: 'pong', marca: 'm1' },
    ])
  })
})
