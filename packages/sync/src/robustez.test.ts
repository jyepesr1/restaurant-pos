import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { AlmacenDispositivoMemoria } from './dispositivo/almacen'
import { ClienteSync } from './dispositivo/cliente'
import { AlmacenMemoria } from './hub/almacen'
import { HubSync } from './hub/hub'
import { huella, huellaEvento, jsonCanonico, PROFUNDIDAD_MAXIMA } from './huella'
import type { MensajeDispositivo, MensajeHub } from './protocolo'
import { accesoLibre } from './pruebas/acceso'
import {
  AHORA,
  abrirPedido,
  eventosDe,
  item,
  type Montaje,
  montar,
  venLoMismo,
} from './pruebas/montaje'
import type { Nodo } from './pruebas/red'

// Lo que encontró la revisión de la tarea 0.6: entradas que no deben tumbar al hub, carreras del
// dispositivo al reconectar, el reloj desfasado y lo que ve un dispositivo revocado.

const crudo = (nodo: Nodo, pedido: string, tipo: string, datos: unknown, extras = {}) => ({
  id: nuevoId(),
  tipo,
  version_esquema: 1,
  agregado_tipo: 'pedido',
  agregado_id: pedido,
  relacionados: [],
  datos,
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

const abrir = (nodo: Nodo, pedido: string, extras = {}) =>
  crudo(nodo, pedido, 'PedidoAbierto', { canal: 'barra', mesa_id: null, comensales: 1 }, extras)

const conexionDe = (m: Montaje, nodo: Nodo) => {
  const conexion = m.red.tokens.get(`token-${nodo.nombre}`)
  if (!conexion) throw new Error(`Sin token para ${nodo.nombre}`)
  return conexion
}

function anidado(niveles: number): unknown {
  let valor: unknown = 'fondo'
  for (let i = 0; i < niveles; i++) valor = { a: valor }
  return valor
}

describe('huella', () => {
  it('no depende del orden de las claves ni de `secuencia_base`', () => {
    expect(huella({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(huella({ b: [1, { d: 3, c: 2 }], a: 1 }))
    expect(huellaEvento({ id: 'x', secuencia_base: 7 })).toBe(
      huellaEvento({ id: 'x', secuencia_base: 0 }),
    )
    expect(huellaEvento({ id: 'x', motivo: 'a' })).not.toBe(huellaEvento({ id: 'x', motivo: 'b' }))
  })

  it('corta el recorrido de algo demasiado anidado en vez de agotar la pila', () => {
    expect(() => jsonCanonico(anidado(PROFUNDIDAD_MAXIMA - 1))).not.toThrow()
    expect(() => jsonCanonico(anidado(PROFUNDIDAD_MAXIMA + 1))).toThrow(RangeError)
    expect(() => huella(anidado(100_000))).toThrow(RangeError)
  })
})

describe('hub: entradas que no deben tumbarlo', () => {
  it('un evento sin id, malformado, repetido: misma respuesta y un solo rechazo guardado', () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const malo = { tipo: 'PedidoAbierto', datos: null }
    const r1 = m.hub().recibirLote(conexionDe(m, ana), [malo])
    const r2 = m.hub().recibirLote(conexionDe(m, ana), [malo])

    expect(r1.resultados).toEqual(r2.resultados)
    expect(r1.resultados[0]).toMatchObject({ id: '', estado: 'rechazado' })
    expect(m.db.prepare('SELECT count(*) AS n FROM evento_rechazado').get()?.n).toBe(1)
  })

  it('eventos enormes o muy anidados se rechazan sin recorrerlos y el lote sigue', () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const pedido = nuevoId()
    const r = m
      .hub()
      .recibirLote(conexionDe(m, ana), [
        { ...abrir(ana, pedido), motivo: 'x'.repeat(70_000) },
        { ...abrir(ana, nuevoId()), datos: anidado(100_000) },
        abrir(ana, nuevoId()),
      ])

    expect(r.resultados.map((x) => x.estado)).toEqual(['rechazado', 'rechazado', 'confirmado'])
    expect(r.resultados[0]).toMatchObject({ motivo: 'esquema: demasiado_grande' })
    expect(r.resultados[1]).toMatchObject({ motivo: 'esquema: demasiado_anidado' })
  })

  it('un evento que hace fallar al hub se rechaza como `error_interno`; el resto del lote sigue', () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const errores: string[] = []
    const almacen = new AlmacenMemoria()
    const veneno = abrir(ana, nuevoId())
    const original = almacen.guardarEvento.bind(almacen)
    almacen.guardarEvento = (evento, ...resto) => {
      if (evento.id === veneno.id) throw new Error('falla con este evento')
      original(evento, ...resto)
    }
    const hub = new HubSync(almacen, {
      restauranteId: '',
      zonaHoraria: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      acceso: accesoLibre,
      instancia: 'hub-1',
      reloj: m.red.horaIso,
      alErrorInterno: (_error, id) => errores.push(id),
    })

    const r = hub.recibirLote(conexionDe(m, ana), [veneno, abrir(ana, nuevoId())])
    const otraVez = hub.recibirLote(conexionDe(m, ana), [veneno])

    expect(r.resultados.map((x) => x.estado)).toEqual(['rechazado', 'confirmado'])
    expect(r.resultados[0]).toMatchObject({ motivo: 'error_interno' })
    expect(otraVez.resultados).toEqual([r.resultados[0]])
    expect(errores).toEqual([veneno.id])
  })

  it('si el almacén no guarda ni el rechazo, el hub lanza (se reinicia) y no queda nada a medias', () => {
    const m = montar({ almacen: 'memoria' })
    const ana = m.red.dispositivo('ana')
    const almacen = m.almacen as AlmacenMemoria
    almacen.fallar = () => {
      throw new Error('disco lleno')
    }

    expect(() => m.hub().recibirLote(conexionDe(m, ana), [abrir(ana, nuevoId())])).toThrow(
      'disco lleno',
    )
    expect(almacen.eventos).toHaveLength(0)
    expect(almacen.rechazos).toHaveLength(0)
  })

  it('una conexión que falla al enviar no deja sin el evento a las demás', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const luis = m.red.dispositivo('luis')
    await m.red.conectarTodos()
    const rota = m.red.sala.conectar((mensaje) => {
      if (mensaje.tipo === 'nuevo') throw new Error('socket cerrado')
    })
    rota.recibir({
      tipo: 'hola',
      token: 'token-luis',
      hub_instancia: null,
      hasta: 0,
      version_app: 'x',
    })

    const pedido = await abrirPedido(ana)
    await m.red.estabilizar()

    await venLoMismo(m.hub(), eventosDe(m), [ana, luis], [pedido])
  })
})

describe('hub: al día y proyecciones', () => {
  it('lo que el mismo dispositivo hizo antes cuenta como conocido: un error suyo se rechaza', () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const pedido = nuevoId()
    const r = m.hub().recibirLote(conexionDe(m, ana), [
      abrir(ana, pedido),
      crudo(ana, pedido, 'ItemAgregado', item()),
      // Todo lo que hay en el pedido lo hizo ana: no hay nada que no conociera.
      crudo(ana, pedido, 'ItemQuitado', { item_id: nuevoId() }),
    ])

    expect(r.resultados[2]).toMatchObject({ estado: 'rechazado', motivo: 'item_inexistente' })
    expect(m.hub().conflictos()).toEqual([])
  })

  it('un pedido cancelado sale de la memoria del hub pero se sigue consultando de la base', () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const luis = m.red.dispositivo('luis')
    const pedido = nuevoId()
    m.hub().recibirLote(conexionDe(m, ana), [
      abrir(ana, pedido),
      crudo(ana, pedido, 'PedidoCancelado', {}, { secuencia_base: 1, motivo: 'Se fueron' }),
    ])
    expect(m.hub().pedido(pedido)?.estado).toBe('cancelado')

    // Luis no sabía de la cancelación: su cambio entra como conflicto, no cambia el pedido.
    const tarde = m
      .hub()
      .recibirLote(conexionDe(m, luis), [
        crudo(luis, pedido, 'ComensalesCambiados', { comensales: 3 }, { secuencia_base: 1 }),
      ])
    expect(tarde.resultados[0]).toMatchObject({ estado: 'confirmado', conflicto: 'pedido_cerrado' })
    expect(m.hub().pedido(pedido)?.comensales).toBe(1)
  })
})

describe('dispositivo revocado', () => {
  it('no recibe eventos del salón; lo suyo de antes va a cuarentena, con tope', async () => {
    const m = montar({ almacen: 'memoria' })
    const ana = m.red.dispositivo('ana')
    const luis = m.red.dispositivo('luis')
    const errores: string[] = []
    await m.red.conectarTodos()
    const conexion = conexionDe(m, ana)
    conexion.revocadoEn = m.red.horaIso()
    ana.aDispositivo = []

    await abrirPedido(luis)
    await m.red.estabilizar()
    expect(ana.aDispositivo).toEqual([])

    const sala = m.red.sala.conectar((mensaje) => {
      if (mensaje.tipo === 'error') errores.push(mensaje.codigo)
    })
    sala.recibir({
      tipo: 'hola',
      token: 'token-ana',
      hub_instancia: null,
      hasta: 0,
      version_app: 'x',
    })
    sala.recibir({ tipo: 'traer', desde: 0 })
    expect(errores).toEqual(['token_revocado'])

    const antes = { hora_estimada_hub: '2026-10-24T19:00:00.000Z' }
    for (let i = 0; i < 6; i++) {
      m.hub().recibirLote(
        conexion,
        Array.from({ length: 100 }, () => abrir(ana, nuevoId(), antes)),
      )
    }
    expect((m.almacen as AlmacenMemoria).cuarentenas).toHaveLength(500)
  })
})

describe('sesión de quien creó el evento', () => {
  it('solo la recibe el dispositivo que lo creó', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const luis = m.red.dispositivo('luis')
    await m.red.conectarTodos()
    const sesion = nuevoId()
    await ana.crear(
      nuevoId(),
      'PedidoAbierto',
      { canal: 'barra', mesa_id: null, comensales: 1 },
      {
        sesion_id: sesion,
      },
    )
    await m.red.estabilizar()

    const [deAna] = await ana.cliente.locales()
    const [deLuis] = await luis.cliente.locales()
    expect(deAna?.evento.sesion_id).toBe(sesion)
    expect(deLuis?.evento.sesion_id).toBeNull()
    expect(m.hub().traer(0, 'mesero', ana.dispositivoId).eventos[0]?.sesion_id).toBe(sesion)
    expect(m.hub().traer(0, 'mesero', luis.dispositivoId).eventos[0]?.sesion_id).toBeNull()
  })
})

describe('cliente: reconexiones y reloj', () => {
  /** Un cliente suelto, sin red: lo que envía queda en `enviados`. */
  function suelto() {
    const enviados: MensajeDispositivo[] = []
    const almacen = new AlmacenDispositivoMemoria()
    let reloj = Date.parse('2026-10-24T20:00:00.000Z')
    const cliente = new ClienteSync({
      almacen,
      token: 't',
      versionApp: 'x',
      enviar: (mensaje) => enviados.push(mensaje),
      ahora: () => reloj,
    })
    return { cliente, enviados, almacen, avanzar: (ms: number) => (reloj += ms) }
  }
  const bienvenido = (hora = '2026-10-24T20:00:00.000Z'): MensajeHub => ({
    tipo: 'bienvenido',
    hub_instancia: 'hub-1',
    secuencia_max: 0,
    hora_hub: hora,
  })

  it('lo que llega por una conexión ya cerrada no se procesa ni envía nada por la nueva', async () => {
    const { cliente, enviados } = suelto()
    await cliente.alConectar()
    const tardio = cliente.recibir(bienvenido())
    cliente.alDesconectar()
    const nueva = cliente.alConectar()
    await Promise.all([tardio, nueva])

    expect(enviados.map((x) => x.tipo)).toEqual(['hola', 'hola'])
  })

  it('un evento registrado dos veces se guarda una sola vez', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    const evento = await ana.crear(nuevoId(), 'PedidoAbierto', {
      canal: 'barra',
      mesa_id: null,
      comensales: 1,
    })
    expect(await ana.cliente.registrar(evento)).toEqual({ ok: true })
    expect(await ana.cliente.pendientes()).toBe(1)
  })

  it('aprende el desfase del reloj al conectar, lo usa en `hora_estimada_hub` y lo guarda', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    ana.desfaseMs = -59_000 // como el Android de la prueba en celulares (ADR-001)
    await m.red.conectarTodos()

    const evento = await ana.crear(nuevoId(), 'PedidoAbierto', {
      canal: 'barra',
      mesa_id: null,
      comensales: 1,
    })
    expect(evento.hora_estimada_hub).toBe(m.red.horaIso())
    expect(evento.hora_dispositivo).not.toBe(m.red.horaIso())
    expect((await ana.almacen.cursor()).desfaseMs).toBe(59_000)

    const otro = new ClienteSync({
      almacen: ana.almacen,
      token: 't',
      versionApp: 'x',
      enviar: () => {},
      ahora: () => m.red.ahora() - 59_000,
    })
    await otro.iniciar()
    expect(otro.horaEstimadaHub()).toBe(m.red.horaIso())
  })

  it('un rechazo que llega después de que el evento volvió confirmado no lo deshace', async () => {
    const m = montar()
    const ana = m.red.dispositivo('ana')
    await m.red.conectarTodos()
    ana.regla('al_dispositivo', 'resultado', 'perder')
    const evento = await ana.crear(nuevoId(), 'PedidoAbierto', {
      canal: 'barra',
      mesa_id: null,
      comensales: 1,
    })
    await m.red.estabilizar()
    expect((await ana.cliente.locales())[0]?.estado).toBe('confirmado')

    // Llega tarde un resultado (de un reenvío) que dice que no.
    const lote = (ana.cliente as unknown as { loteEnVuelo: unknown }).loteEnVuelo
    expect(lote).toBeNull()
    ;(ana.cliente as unknown as { loteEnVuelo: unknown }).loteEnVuelo = {
      id: 'tarde',
      eventos: [evento.id],
    }
    await ana.cliente.recibir({
      tipo: 'resultado',
      lote_id: 'tarde',
      resultados: [{ id: evento.id, estado: 'rechazado', motivo: 'id_repetido' }],
    })
    expect((await ana.cliente.locales())[0]?.estado).toBe('confirmado')
  })

  it('un error del hub por token inválido deja de enviar y avisa a la app', async () => {
    const errores: string[] = []
    const enviados: MensajeDispositivo[] = []
    const cliente = new ClienteSync({
      almacen: new AlmacenDispositivoMemoria(),
      token: 't',
      versionApp: 'x',
      enviar: (mensaje) => enviados.push(mensaje),
      alErrorHub: (codigo) => errores.push(codigo),
    })
    await cliente.alConectar()
    await cliente.recibir({ tipo: 'error', codigo: 'token_invalido', mensaje: 'no' })
    await cliente.recibir(bienvenido())

    expect(errores).toEqual(['token_invalido'])
    expect(enviados.map((x) => x.tipo)).toEqual(['hola'])
  })

  it('un fallo al procesar un mensaje no rompe la cola: llega a `alFallo` y lo siguiente sigue', async () => {
    const fallos: unknown[] = []
    const almacen = new AlmacenDispositivoMemoria()
    const enviados: MensajeDispositivo[] = []
    const cliente = new ClienteSync({
      almacen,
      token: 't',
      versionApp: 'x',
      enviar: (mensaje) => enviados.push(mensaje),
      alFallo: (error) => fallos.push(error),
    })
    await cliente.alConectar()
    const cursor = almacen.cursor.bind(almacen)
    almacen.cursor = async () => {
      almacen.cursor = cursor
      throw new Error('IndexedDB cerrada')
    }
    await cliente.recibir(bienvenido())
    await cliente.recibir(bienvenido())

    expect(fallos).toHaveLength(1)
    expect(enviados.map((x) => x.tipo)).toEqual(['hola', 'traer'])
  })
})
