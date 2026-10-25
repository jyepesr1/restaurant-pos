import { type EventoPedido, nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { AlmacenDispositivoMemoria } from './dispositivo/almacen'
import { ClienteSync } from './dispositivo/cliente'
import { AlmacenMemoria } from './hub/almacen'
import { AlmacenSqlite } from './hub/almacen-sqlite'
import { type CambioPedido, type Conexion, HubSync } from './hub/hub'
import { SalaSync } from './hub/sala'
import type { EstadoImpresora, MensajeHub } from './protocolo'
import { accesoLibre } from './pruebas/acceso'
import { baseSqlite, item } from './pruebas/montaje'

// Tarea 1.4 (ADR-015) en la sincronización: el número de cada comanda lo da el hub, por día
// operativo; `alGuardar` corre con el evento ya guardado y sin poder frenarlo; y el estado de las
// impresoras viaja a los equipos por el WebSocket.

const BOGOTA = (hora: string) => new Date(`${hora}-05:00`).getTime()
const MESERO: Conexion = { dispositivoId: nuevoId(), tipo: 'mesero', revocadoEn: null }
const OTRO: Conexion = { dispositivoId: nuevoId(), tipo: 'mesero', revocadoEn: null }
const USUARIO = nuevoId()

type Almacen = 'memoria' | 'sqlite'

function montar(almacen: Almacen, config: Partial<ConstructorParameters<typeof HubSync>[1]> = {}) {
  const { db, restauranteId } = baseSqlite()
  const guardado =
    almacen === 'sqlite' ? new AlmacenSqlite(db, restauranteId) : new AlmacenMemoria()
  let ms = BOGOTA('2026-10-24T15:00:00')
  const hub = new HubSync(guardado, {
    restauranteId,
    zonaHoraria: 'America/Bogota',
    inicioDiaOperativo: '06:00',
    instancia: 'hub-1',
    reloj: () => new Date(ms).toISOString(),
    acceso: accesoLibre,
    ...config,
  })
  /** Un evento en bruto como lo manda un dispositivo (hora estimada = la que se indique). */
  const crudo = (
    conexion: Conexion,
    pedido: string,
    tipo: string,
    datos: unknown,
    horaEstimada = new Date(ms).toISOString(),
  ) => ({
    id: nuevoId(),
    tipo,
    version_esquema: 1,
    agregado_tipo: 'pedido',
    agregado_id: pedido,
    relacionados: [],
    datos,
    sesion_id: null,
    usuario_id: USUARIO,
    dispositivo_id: conexion.dispositivoId,
    autorizacion_id: null,
    motivo: null,
    hora_dispositivo: horaEstimada,
    hora_estimada_hub: horaEstimada,
    secuencia_base: guardado.maxSecuencia(),
  })
  const enviar = (
    conexion: Conexion,
    pedido: string,
    tipo: string,
    datos: unknown,
    horaEstimada?: string,
  ) => {
    const r = hub.recibirLote(conexion, [crudo(conexion, pedido, tipo, datos, horaEstimada)])
    return { resultado: r.resultados[0], aceptado: r.aceptados[0] }
  }
  return {
    db,
    restauranteId,
    guardado,
    hub,
    crudo,
    enviar,
    ahora: () => ms,
    fijar: (hora: string) => {
      ms = BOGOTA(hora)
    },
    avanzar: (n: number) => {
      ms += n
    },
  }
}
type Montaje = ReturnType<typeof montar>

/** Abre un pedido con `n` platos y los deja listos para enviar. */
function conPlatos(m: Montaje, n: number, conexion = MESERO, hora?: string) {
  const pedido = nuevoId()
  expect(
    m.enviar(
      conexion,
      pedido,
      'PedidoAbierto',
      { canal: 'salon', mesa_id: null, comensales: 2 },
      hora,
    ).resultado?.estado,
  ).toBe('confirmado')
  const platos = Array.from({ length: n }, () => item())
  for (const p of platos)
    expect(m.enviar(conexion, pedido, 'ItemAgregado', p, hora).resultado?.estado).toBe('confirmado')
  return { pedido, ids: platos.map((p) => p.item_id) }
}

const comanda = (itemIds: string[], estacion = nuevoId()) => ({
  comanda_id: nuevoId(),
  estacion_id: estacion,
  item_ids: itemIds,
})

const numeros = (e: EventoPedido | undefined) =>
  (e?.asignaciones as { numeros_comanda?: Record<string, number> } | undefined)?.numeros_comanda

describe.each(['memoria', 'sqlite'] as const)('número de comanda (%s)', (almacen) => {
  it('cada comanda de un envío recibe un número seguido, una por estación', () => {
    const m = montar(almacen)
    const { pedido, ids } = conPlatos(m, 3)
    const [a, b, c] = [
      comanda([ids[0] as string]),
      comanda([ids[1] as string]),
      comanda([ids[2] as string]),
    ]
    const r = m.enviar(MESERO, pedido, 'ItemsEnviados', { comandas: [a, b, c] })
    expect(numeros(r.aceptado)).toEqual({ [a.comanda_id]: 1, [b.comanda_id]: 2, [c.comanda_id]: 3 })
    expect(r.resultado?.estado === 'confirmado' && r.resultado.aceptacion.asignaciones).toEqual({
      numeros_comanda: numeros(r.aceptado),
    })
  })

  it('el siguiente envío, aunque sea de otro pedido u otro equipo, sigue la cuenta del día', () => {
    const m = montar(almacen)
    const uno = conPlatos(m, 2)
    const dos = conPlatos(m, 1, OTRO)
    const e1 = m.enviar(MESERO, uno.pedido, 'ItemsEnviados', {
      comandas: [comanda([uno.ids[0] as string]), comanda([uno.ids[1] as string])],
    })
    const c2 = comanda([dos.ids[0] as string])
    const e2 = m.enviar(OTRO, dos.pedido, 'ItemsEnviados', { comandas: [c2] })
    expect(Object.values(numeros(e1.aceptado) ?? {})).toEqual([1, 2])
    expect(numeros(e2.aceptado)).toEqual({ [c2.comanda_id]: 3 })
  })

  it('solo ItemsEnviados trae números de comanda; PedidoAbierto sigue trayendo el número de pedido', () => {
    const m = montar(almacen)
    const pedido = nuevoId()
    const abierto = m.enviar(MESERO, pedido, 'PedidoAbierto', {
      canal: 'salon',
      mesa_id: null,
      comensales: 1,
    })
    expect(abierto.aceptado?.asignaciones).toEqual({ numero_dia: 1 })
    const plato = item()
    const agregado = m.enviar(MESERO, pedido, 'ItemAgregado', plato)
    expect(agregado.aceptado?.asignaciones).toEqual({})
    const enviado = m.enviar(MESERO, pedido, 'ItemsEnviados', {
      comandas: [comanda([plato.item_id])],
    })
    expect(Object.keys(enviado.aceptado?.asignaciones ?? {})).toEqual(['numeros_comanda'])
    // Un evento que no crea comanda no gasta números.
    const listo = m.enviar(MESERO, pedido, 'ItemListo', { item_ids: [plato.item_id] })
    expect(listo.aceptado?.asignaciones).toEqual({})
  })

  it('un envío rechazado no gasta números', () => {
    const m = montar(almacen)
    const { pedido, ids } = conPlatos(m, 2)
    const malo = m.enviar(MESERO, pedido, 'ItemsEnviados', { comandas: [comanda([nuevoId()])] })
    expect(malo.resultado?.estado).toBe('rechazado')
    const c = comanda([ids[0] as string])
    const bueno = m.enviar(MESERO, pedido, 'ItemsEnviados', { comandas: [c] })
    expect(numeros(bueno.aceptado)).toEqual({ [c.comanda_id]: 1 })
  })

  it('el mismo envío reenviado (misma id) devuelve el mismo número y no gasta otro', () => {
    const m = montar(almacen)
    const { pedido, ids } = conPlatos(m, 1)
    const c = comanda([ids[0] as string])
    const evento = m.crudo(MESERO, pedido, 'ItemsEnviados', { comandas: [c] })
    const primero = m.hub.recibirLote(MESERO, [evento])
    const repetido = m.hub.recibirLote(MESERO, [evento])
    expect(repetido.aceptados).toHaveLength(0)
    expect(repetido.resultados[0]).toEqual(primero.resultados[0])
    const otro = conPlatos(m, 1)
    const c2 = comanda([otro.ids[0] as string])
    expect(
      numeros(m.enviar(MESERO, otro.pedido, 'ItemsEnviados', { comandas: [c2] }).aceptado),
    ).toEqual({
      [c2.comanda_id]: 2,
    })
  })

  describe('día operativo', () => {
    const enviarUno = (m: Montaje, hora: string) => {
      m.fijar(hora)
      const { pedido, ids } = conPlatos(m, 1)
      const c = comanda([ids[0] as string])
      const r = m.enviar(MESERO, pedido, 'ItemsEnviados', { comandas: [c] })
      return { numero: numeros(r.aceptado)?.[c.comanda_id], dia: r.aceptado?.dia_operativo }
    }

    it('a las 6:00 a. m. empieza un día nuevo y la numeración vuelve a 1', () => {
      const m = montar(almacen)
      expect(enviarUno(m, '2026-10-24T20:00:00')).toEqual({ numero: 1, dia: '2026-10-24' })
      expect(enviarUno(m, '2026-10-24T21:00:00')).toEqual({ numero: 2, dia: '2026-10-24' })
      expect(enviarUno(m, '2026-10-25T05:59:00')).toEqual({ numero: 3, dia: '2026-10-24' })
      expect(enviarUno(m, '2026-10-25T06:00:00')).toEqual({ numero: 1, dia: '2026-10-25' })
      expect(enviarUno(m, '2026-10-25T06:01:00')).toEqual({ numero: 2, dia: '2026-10-25' })
    })

    it('la madrugada (después de medianoche) sigue siendo del día anterior', () => {
      const m = montar(almacen)
      enviarUno(m, '2026-10-24T22:00:00')
      expect(enviarUno(m, '2026-10-25T01:30:00')).toEqual({ numero: 2, dia: '2026-10-24' })
    })

    it('un envío con la hora del dispositivo de ayer que llega hoy cuenta en el día de ayer', () => {
      const m = montar(almacen)
      enviarUno(m, '2026-10-24T22:00:00')
      enviarUno(m, '2026-10-25T07:00:00')
      // Sin conexión desde las 11 p. m.; el hub lo recibe a las 7:10 a. m., dentro de la ventana de 12 h.
      m.fijar('2026-10-25T07:10:00')
      const { pedido, ids } = conPlatos(
        m,
        1,
        OTRO,
        new Date(BOGOTA('2026-10-24T23:00:00')).toISOString(),
      )
      const c = comanda([ids[0] as string])
      const r = m.enviar(
        OTRO,
        pedido,
        'ItemsEnviados',
        { comandas: [c] },
        new Date(BOGOTA('2026-10-24T23:05:00')).toISOString(),
      )
      expect(r.aceptado?.dia_operativo).toBe('2026-10-24')
      expect(numeros(r.aceptado)).toEqual({ [c.comanda_id]: 2 })
      // El día de hoy no se mueve.
      expect(enviarUno(m, '2026-10-25T07:20:00')).toEqual({ numero: 2, dia: '2026-10-25' })
    })

    it('un dispositivo con el reloj muy atrasado no mete su comanda en un día viejo: vale la hora del hub', () => {
      const m = montar(almacen)
      enviarUno(m, '2026-10-24T20:00:00')
      m.fijar('2026-10-25T10:00:00')
      const { pedido, ids } = conPlatos(m, 1)
      const c = comanda([ids[0] as string])
      // El equipo dice que son las 2 p. m. del 20 de octubre (más de 12 h de diferencia).
      const r = m.enviar(
        MESERO,
        pedido,
        'ItemsEnviados',
        { comandas: [c] },
        new Date(BOGOTA('2026-10-20T14:00:00')).toISOString(),
      )
      expect(r.aceptado?.dia_operativo).toBe('2026-10-25')
      expect(numeros(r.aceptado)).toEqual({ [c.comanda_id]: 1 })
    })

    it('un reloj adelantado más de un minuto tampoco adelanta el día', () => {
      const m = montar(almacen)
      m.fijar('2026-10-24T23:00:00')
      const { pedido, ids } = conPlatos(m, 1)
      const c = comanda([ids[0] as string])
      const r = m.enviar(
        MESERO,
        pedido,
        'ItemsEnviados',
        { comandas: [c] },
        new Date(BOGOTA('2026-10-25T09:00:00')).toISOString(),
      )
      expect(r.aceptado?.dia_operativo).toBe('2026-10-24')
    })

    it('el inicio del día es configurable (4:00 a. m.)', () => {
      const m = montar(almacen, { inicioDiaOperativo: '04:00' })
      expect(enviarUno(m, '2026-10-25T03:59:00').dia).toBe('2026-10-24')
      expect(enviarUno(m, '2026-10-25T04:00:00')).toEqual({ numero: 1, dia: '2026-10-25' })
    })
  })

  it('el hub reiniciado sigue la cuenta donde iba (la numeración vive en los eventos guardados)', () => {
    const m = montar(almacen)
    const { pedido, ids } = conPlatos(m, 2)
    m.enviar(MESERO, pedido, 'ItemsEnviados', { comandas: [comanda([ids[0] as string])] })
    const reiniciado = new HubSync(m.guardado, {
      restauranteId: m.restauranteId,
      zonaHoraria: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      instancia: 'hub-2',
      reloj: () => new Date(m.ahora()).toISOString(),
      acceso: accesoLibre,
    })
    const c = comanda([ids[1] as string])
    const r = reiniciado.recibirLote(MESERO, [
      m.crudo(MESERO, pedido, 'ItemsEnviados', { comandas: [c] }),
    ])
    expect(numeros(r.aceptados[0])).toEqual({ [c.comanda_id]: 2 })
  })

  it('un envío con 40 comandas numera de 1 a 40 en el orden recibido, sin repetir', () => {
    const m = montar(almacen)
    const { pedido, ids } = conPlatos(m, 40)
    const comandas = ids.map((id) => comanda([id]))
    const r = m.enviar(MESERO, pedido, 'ItemsEnviados', { comandas })
    expect(r.resultado?.estado).toBe('confirmado')
    const dadas = numeros(r.aceptado) ?? {}
    expect(comandas.map((c) => dadas[c.comanda_id])).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1),
    )
  })
})

describe('número de comanda: varios restaurantes en la misma base', () => {
  it('cada restaurante lleva su propia cuenta del día', () => {
    const { db, restauranteId } = baseSqlite()
    const otro = nuevoId()
    db.prepare(
      `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
       VALUES (?, ?, '2026-10-24T15:00:00.000Z', '2026-10-24T15:00:00.000Z', 1, 'Otro', '{}')`,
    ).run(otro, otro)
    const ms = BOGOTA('2026-10-24T15:00:00')
    const hubDe = (id: string) =>
      new HubSync(new AlmacenSqlite(db, id), {
        restauranteId: id,
        zonaHoraria: 'America/Bogota',
        inicioDiaOperativo: '06:00',
        instancia: `hub-${id}`,
        reloj: () => new Date(ms).toISOString(),
        acceso: accesoLibre,
      })
    const [a, b] = [hubDe(restauranteId), hubDe(otro)]
    let secuencia = 0
    const evento = (conexion: Conexion, pedido: string, tipo: string, datos: unknown) => ({
      id: nuevoId(),
      tipo,
      version_esquema: 1,
      agregado_tipo: 'pedido',
      agregado_id: pedido,
      relacionados: [],
      datos,
      sesion_id: null,
      usuario_id: USUARIO,
      dispositivo_id: conexion.dispositivoId,
      autorizacion_id: null,
      motivo: null,
      hora_dispositivo: new Date(ms).toISOString(),
      hora_estimada_hub: new Date(ms).toISOString(),
      secuencia_base: secuencia,
    })
    const enviarEn = (hub: HubSync, base: number, comandas: number) => {
      const pedido = nuevoId()
      const platos = Array.from({ length: comandas }, () => item())
      secuencia = base
      const lote = [
        evento(MESERO, pedido, 'PedidoAbierto', { canal: 'salon', mesa_id: null, comensales: 1 }),
        ...platos.map((p) => evento(MESERO, pedido, 'ItemAgregado', p)),
        evento(MESERO, pedido, 'ItemsEnviados', {
          comandas: platos.map((p) => comanda([p.item_id])),
        }),
      ]
      const r = hub.recibirLote(MESERO, lote)
      expect(r.resultados.every((x) => x.estado === 'confirmado')).toBe(true)
      return Object.values(numeros(r.aceptados.at(-1)) ?? {})
    }
    // Las secuencias son globales de la base: el segundo restaurante arranca en la suya.
    const maxDe = (id: string) =>
      Number(
        db
          .prepare('SELECT coalesce(max(secuencia), 0) AS s FROM evento WHERE restaurante_id = ?')
          .get(id)?.s,
      )
    expect(enviarEn(a, maxDe(restauranteId), 2)).toEqual([1, 2])
    expect(enviarEn(b, maxDe(otro), 3)).toEqual([1, 2, 3])
    expect(enviarEn(a, maxDe(restauranteId), 1)).toEqual([3])
    expect(enviarEn(b, maxDe(otro), 1)).toEqual([4])
  })
})

describe('comandasDelDia (almacenes)', () => {
  it.each(['memoria', 'sqlite'] as const)(
    '%s: suma las comandas de los envíos del día y de ningún otro evento',
    (almacen) => {
      const m = montar(almacen)
      expect(m.guardado.comandasDelDia('2026-10-24')).toBe(0)
      const { pedido, ids } = conPlatos(m, 3)
      m.enviar(MESERO, pedido, 'ItemsEnviados', {
        comandas: [comanda([ids[0] as string]), comanda([ids[1] as string])],
      })
      m.enviar(MESERO, pedido, 'ItemsEnviados', { comandas: [comanda([ids[2] as string])] })
      expect(m.guardado.comandasDelDia('2026-10-24')).toBe(3)
      expect(m.guardado.comandasDelDia('2026-10-23')).toBe(0)
      expect(m.guardado.comandasDelDia('2026-10-25')).toBe(0)
    },
  )
})

describe.each(['memoria', 'sqlite'] as const)('alGuardar (%s)', (almacen) => {
  type Llamada = { evento: EventoPedido; cambios: CambioPedido[] }
  const conGancho = () => {
    const llamadas: Llamada[] = []
    const fallos: { error: unknown; id: string }[] = []
    const m = montar(almacen, {
      alGuardar: (evento, cambios) => {
        llamadas.push({ evento, cambios })
      },
      alFalloAlGuardar: (error, id) => fallos.push({ error, id }),
    })
    return { m, llamadas, fallos }
  }

  it('recibe el evento ya numerado y el pedido antes y después de aplicarlo', () => {
    const { m, llamadas } = conGancho()
    const { pedido, ids } = conPlatos(m, 1)
    llamadas.length = 0
    const c = comanda([ids[0] as string])
    const r = m.enviar(MESERO, pedido, 'ItemsEnviados', { comandas: [c] })
    expect(llamadas).toHaveLength(1)
    const { evento, cambios } = llamadas[0] as Llamada
    expect(evento.id).toBe(r.aceptado?.id)
    expect(evento.secuencia).toBe(r.aceptado?.secuencia)
    expect(numeros(evento)).toEqual({ [c.comanda_id]: 1 })
    expect(cambios).toHaveLength(1)
    expect(cambios[0]?.antes?.items[ids[0] as string]?.estado).toBe('pendiente')
    expect(cambios[0]?.despues?.items[ids[0] as string]?.estado).toBe('enviado')
    // La proyección del hub ya quedó al día después.
    expect(m.hub.pedido(pedido)?.items[ids[0] as string]?.estado).toBe('enviado')
  })

  it('al abrir un pedido, antes es null; el evento de un producto no trae pedidos', () => {
    const { m, llamadas } = conGancho()
    const pedido = nuevoId()
    m.enviar(MESERO, pedido, 'PedidoAbierto', { canal: 'barra', mesa_id: null, comensales: 1 })
    expect(llamadas[0]?.cambios).toEqual([
      { antes: null, despues: expect.objectContaining({ id: pedido, estado: 'abierto' }) },
    ])
    llamadas.length = 0
    const producto = {
      id: nuevoId(),
      tipo: 'ProductoAgotado',
      version_esquema: 1,
      agregado_tipo: 'producto',
      agregado_id: nuevoId(),
      relacionados: [],
      datos: { producto_id: nuevoId(), variante_id: null },
      sesion_id: null,
      usuario_id: USUARIO,
      dispositivo_id: MESERO.dispositivoId,
      autorizacion_id: null,
      motivo: null,
      hora_dispositivo: new Date(m.ahora()).toISOString(),
      hora_estimada_hub: new Date(m.ahora()).toISOString(),
      secuencia_base: m.guardado.maxSecuencia(),
    }
    const r = m.hub.recibirLote(MESERO, [producto])
    if (r.aceptados.length > 0) {
      expect(llamadas).toHaveLength(1)
      expect(llamadas[0]?.cambios).toEqual([])
    }
  })

  it('el pedido «antes» no se modifica al aplicar el evento (es una foto)', () => {
    const { m, llamadas } = conGancho()
    const { pedido, ids } = conPlatos(m, 2)
    llamadas.length = 0
    m.enviar(MESERO, pedido, 'ItemsEnviados', { comandas: [comanda([ids[0] as string])] })
    m.enviar(MESERO, pedido, 'ItemListo', { item_ids: [ids[0] as string] })
    const [enviado, listo] = llamadas as [Llamada, Llamada]
    expect(enviado.cambios[0]?.antes?.items[ids[0] as string]?.estado).toBe('pendiente')
    expect(enviado.cambios[0]?.despues?.items[ids[0] as string]?.estado).toBe('enviado')
    expect(listo.cambios[0]?.antes?.items[ids[0] as string]?.estado).toBe('enviado')
    expect(listo.cambios[0]?.despues?.items[ids[0] as string]?.estado).toBe('listo')
  })

  it('no corre con un evento rechazado ni con uno reenviado', () => {
    const { m, llamadas } = conGancho()
    const { pedido, ids } = conPlatos(m, 1)
    const total = llamadas.length
    const malo = m.enviar(MESERO, pedido, 'ItemsEnviados', { comandas: [comanda([nuevoId()])] })
    expect(malo.resultado?.estado).toBe('rechazado')
    const evento = m.crudo(MESERO, pedido, 'ItemsEnviados', {
      comandas: [comanda([ids[0] as string])],
    })
    m.hub.recibirLote(MESERO, [evento])
    m.hub.recibirLote(MESERO, [evento])
    expect(llamadas.length).toBe(total + 1)
  })

  it('si el gancho lanza, el evento igual se acepta, se confirma y se avisa el fallo', () => {
    const fallos: { error: unknown; id: string }[] = []
    const m = montar(almacen, {
      alGuardar: () => {
        throw new Error('la impresora explotó')
      },
      alFalloAlGuardar: (error, id) => fallos.push({ error, id }),
    })
    const { pedido, ids } = conPlatos(m, 1)
    const c = comanda([ids[0] as string])
    const r = m.enviar(MESERO, pedido, 'ItemsEnviados', { comandas: [c] })
    expect(r.resultado?.estado).toBe('confirmado')
    expect(r.aceptado).toBeDefined()
    expect(numeros(r.aceptado)).toEqual({ [c.comanda_id]: 1 })
    expect(m.guardado.porId(r.aceptado?.id as string)).toBeDefined()
    expect(m.hub.pedido(pedido)?.items[ids[0] as string]?.estado).toBe('enviado')
    expect(fallos.length).toBeGreaterThan(0)
    expect(fallos.at(-1)?.id).toBe(r.aceptado?.id)
    expect(String((fallos.at(-1)?.error as Error | undefined)?.message)).toBe(
      'la impresora explotó',
    )
    // Y el hub sigue funcionando.
    expect(
      m.enviar(MESERO, pedido, 'ItemListo', { item_ids: [ids[0] as string] }).resultado?.estado,
    ).toBe('confirmado')
  })

  it('si el gancho lanza y no hay quién escuche el fallo, tampoco frena el evento', () => {
    const m = montar(almacen, {
      alGuardar: () => {
        throw new Error('x')
      },
    })
    const { pedido } = conPlatos(m, 0)
    expect(pedido).toBeTruthy()
    expect(m.guardado.maxSecuencia()).toBe(1)
  })

  it('un fallo del gancho en un evento no afecta a los demás del mismo lote', () => {
    let n = 0
    const m = montar(almacen, {
      alGuardar: () => {
        n += 1
        if (n === 2) throw new Error('solo el segundo')
      },
    })
    const pedido = nuevoId()
    const platos = [item(), item()]
    const lote = [
      m.crudo(MESERO, pedido, 'PedidoAbierto', { canal: 'salon', mesa_id: null, comensales: 1 }),
      ...platos.map((p) => m.crudo(MESERO, pedido, 'ItemAgregado', p)),
    ]
    const r = m.hub.recibirLote(MESERO, lote)
    expect(r.resultados.map((x) => x.estado)).toEqual(['confirmado', 'confirmado', 'confirmado'])
    expect(r.aceptados).toHaveLength(3)
  })
})

describe('alGuardar: misma transacción que el evento (SQLite)', () => {
  class CaeAlFinal extends AlmacenSqlite {
    cae = false
    override transaccion<T>(trabajo: () => T): T {
      return super.transaccion(() => {
        const r = trabajo()
        if (this.cae) throw new Error('se fue la luz antes del COMMIT')
        return r
      })
    }
  }

  function montarConSonda() {
    const { db, restauranteId } = baseSqlite()
    db.exec('CREATE TABLE sonda (evento_id TEXT, existia_el_evento INTEGER)')
    const almacen = new CaeAlFinal(db, restauranteId)
    const hub = new HubSync(almacen, {
      restauranteId,
      zonaHoraria: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      instancia: 'hub-1',
      reloj: () => '2026-10-24T20:00:00.000Z',
      acceso: accesoLibre,
      alGuardar: (evento) => {
        // El evento ya está guardado cuando corre el gancho.
        const fila = db
          .prepare('SELECT count(*) AS n FROM evento WHERE restaurante_id = ? AND id = ?')
          .get(restauranteId, evento.id)
        db.prepare('INSERT INTO sonda VALUES (?, ?)').run(evento.id, Number(fila?.n))
      },
    })
    const crudo = (pedido: string) => ({
      id: nuevoId(),
      tipo: 'PedidoAbierto',
      version_esquema: 1,
      agregado_tipo: 'pedido',
      agregado_id: pedido,
      relacionados: [],
      datos: { canal: 'salon', mesa_id: null, comensales: 1 },
      sesion_id: null,
      usuario_id: USUARIO,
      dispositivo_id: MESERO.dispositivoId,
      autorizacion_id: null,
      motivo: null,
      hora_dispositivo: '2026-10-24T20:00:00.000Z',
      hora_estimada_hub: '2026-10-24T20:00:00.000Z',
      secuencia_base: 0,
    })
    return { db, almacen, hub, crudo }
  }

  it('lo que escribe el gancho se guarda junto con el evento y ve el evento ya guardado', () => {
    const { db, hub, crudo } = montarConSonda()
    const e = crudo(nuevoId())
    hub.recibirLote(MESERO, [e])
    expect(db.prepare('SELECT * FROM sonda').all()).toEqual([
      { evento_id: e.id, existia_el_evento: 1 },
    ])
  })

  it('si el hub se cae antes de confirmar, no queda ni el evento ni lo que escribió el gancho', () => {
    const { db, almacen, hub, crudo } = montarConSonda()
    almacen.cae = true
    const e = crudo(nuevoId())
    // Tampoco se puede guardar el rechazo: el almacén está caído y el hub debe reiniciarse.
    expect(() => hub.recibirLote(MESERO, [e])).toThrow(/luz/)
    expect(db.prepare('SELECT count(*) AS n FROM sonda').get()).toEqual({ n: 0 })
    expect(Number(db.prepare('SELECT count(*) AS n FROM evento WHERE id = ?').get(e.id)?.n)).toBe(0)
  })
})

// ── Mensaje `impresoras` ────────────────────────────────────────────────

const ESTADOS: EstadoImpresora[] = [
  { id: nuevoId(), nombre: 'Cocina', estado: 'lista', error: null, pendientes: 0 },
  {
    id: nuevoId(),
    nombre: 'Barra',
    estado: 'falla',
    error: 'La impresora no responde',
    pendientes: 3,
  },
]

function montarSala() {
  const m = montar('memoria')
  const tokens = new Map<string, Conexion>([
    ['t-ana', { dispositivoId: nuevoId(), tipo: 'mesero', revocadoEn: null }],
    ['t-caja', { dispositivoId: nuevoId(), tipo: 'caja', revocadoEn: null }],
    ['t-rev', { dispositivoId: nuevoId(), tipo: 'mesero', revocadoEn: '2026-10-24T10:00:00.000Z' }],
  ])
  const sala = new SalaSync(m.hub, (t) => tokens.get(t) ?? null)
  const conectar = (token?: string) => {
    const recibidos: MensajeHub[] = []
    const enlace = sala.conectar((msg) => recibidos.push(JSON.parse(JSON.stringify(msg))))
    if (token)
      enlace.recibir({ tipo: 'hola', token, hub_instancia: null, hasta: 0, version_app: 'x' })
    return { recibidos, enlace }
  }
  const impresoras = (r: MensajeHub[]) => r.filter((x) => x.tipo === 'impresoras')
  return { sala, conectar, impresoras, tokens }
}

describe('mensaje impresoras', () => {
  it('lo reciben los equipos conectados cada vez que cambia el estado', () => {
    const { sala, conectar, impresoras } = montarSala()
    const ana = conectar('t-ana')
    const caja = conectar('t-caja')
    sala.avisarImpresoras(ESTADOS)
    expect(impresoras(ana.recibidos)).toEqual([{ tipo: 'impresoras', impresoras: ESTADOS }])
    expect(impresoras(caja.recibidos)).toEqual([{ tipo: 'impresoras', impresoras: ESTADOS }])
    const sana = ESTADOS.map((e) => ({
      ...e,
      estado: 'lista' as const,
      error: null,
      pendientes: 0,
    }))
    sala.avisarImpresoras(sana)
    expect(impresoras(ana.recibidos).at(-1)).toEqual({ tipo: 'impresoras', impresoras: sana })
    expect(impresoras(ana.recibidos)).toHaveLength(2)
  })

  it('un equipo que se conecta después recibe el último estado justo tras la bienvenida', () => {
    const { sala, conectar } = montarSala()
    sala.avisarImpresoras(ESTADOS)
    const tarde = conectar('t-ana')
    expect(tarde.recibidos.map((r) => r.tipo)).toEqual(['bienvenido', 'impresoras'])
    expect(tarde.recibidos[1]).toEqual({ tipo: 'impresoras', impresoras: ESTADOS })
  })

  it('al conectar recibe el estado más reciente, no uno viejo', () => {
    const { sala, conectar } = montarSala()
    sala.avisarImpresoras(ESTADOS)
    sala.avisarImpresoras([ESTADOS[0] as EstadoImpresora])
    const tarde = conectar('t-caja')
    expect(tarde.recibidos[1]).toEqual({ tipo: 'impresoras', impresoras: [ESTADOS[0]] })
  })

  it('si aún no se sabe nada de las impresoras, al conectar solo llega la bienvenida', () => {
    const { conectar } = montarSala()
    expect(conectar('t-ana').recibidos.map((r) => r.tipo)).toEqual(['bienvenido'])
  })

  it('una lista vacía se avisa a los conectados, pero un equipo nuevo no recibe nada de más', () => {
    const { sala, conectar, impresoras } = montarSala()
    const ana = conectar('t-ana')
    sala.avisarImpresoras(ESTADOS)
    sala.avisarImpresoras([])
    expect(impresoras(ana.recibidos).at(-1)).toEqual({ tipo: 'impresoras', impresoras: [] })
    expect(conectar('t-caja').recibidos.map((r) => r.tipo)).toEqual(['bienvenido'])
  })

  it('no se le manda a quien no se presentó, ni a quien tiene un token inválido', () => {
    const { sala, conectar, impresoras } = montarSala()
    const anonimo = conectar()
    const falso = conectar('inventado')
    sala.avisarImpresoras(ESTADOS)
    expect(impresoras(anonimo.recibidos)).toHaveLength(0)
    expect(impresoras(falso.recibidos)).toHaveLength(0)
    expect(falso.recibidos[0]).toMatchObject({ tipo: 'error', codigo: 'token_invalido' })
  })

  it('un equipo retirado no recibe el estado, ni al avisar ni al conectarse', () => {
    const { sala, conectar, impresoras } = montarSala()
    const rev = conectar('t-rev')
    sala.avisarImpresoras(ESTADOS)
    expect(impresoras(rev.recibidos)).toHaveLength(0)
    expect(impresoras(conectar('t-rev').recibidos)).toHaveLength(0)
  })

  it('un equipo que se revoca después deja de recibirlo', () => {
    const { sala, conectar, impresoras, tokens } = montarSala()
    const ana = conectar('t-ana')
    sala.avisarImpresoras(ESTADOS)
    sala.revocar((tokens.get('t-ana') as Conexion).dispositivoId, '2026-10-24T21:00:00.000Z')
    sala.avisarImpresoras([])
    expect(impresoras(ana.recibidos)).toHaveLength(1)
  })

  it('una conexión rota no impide que las demás reciban el aviso, y se descarta', () => {
    const m = montar('memoria')
    const conexion: Conexion = { dispositivoId: nuevoId(), tipo: 'mesero', revocadoEn: null }
    const sala = new SalaSync(m.hub, () => conexion)
    let rota = false
    const recibidos: MensajeHub[] = []
    const mala = sala.conectar(() => {
      if (rota) throw new Error('socket cerrado')
    })
    const buena = sala.conectar((msg) => recibidos.push(msg))
    for (const e of [mala, buena])
      e.recibir({ tipo: 'hola', token: 't', hub_instancia: null, hasta: 0, version_app: 'x' })
    rota = true
    expect(() => sala.avisarImpresoras(ESTADOS)).not.toThrow()
    expect(recibidos.filter((r) => r.tipo === 'impresoras')).toHaveLength(1)
    // Ya está descartada: un segundo aviso no vuelve a tocarla.
    let toques = 0
    rota = false
    const contada = sala.conectar(() => {
      toques += 1
    })
    contada.recibir({ tipo: 'hola', token: 't', hub_instancia: null, hasta: 0, version_app: 'x' })
    toques = 0
    sala.avisarImpresoras(ESTADOS)
    expect(toques).toBe(1)
  })

  it('el aviso no altera el estado guardado por el hub: la lista se copia por la red', () => {
    const { sala, conectar } = montarSala()
    sala.avisarImpresoras(ESTADOS)
    const a = conectar('t-ana')
    const b = conectar('t-caja')
    expect(a.recibidos[1]).toEqual(b.recibidos[1])
  })

  it('un mensaje de dispositivo mal formado sigue recibiendo error, no impresoras', () => {
    const { sala, conectar } = montarSala()
    sala.avisarImpresoras(ESTADOS)
    const c = conectar('t-ana')
    c.enlace.recibir({ tipo: 'impresoras', impresoras: [] })
    expect(c.recibidos.at(-1)).toMatchObject({ tipo: 'error', codigo: 'mensaje_invalido' })
  })
})

describe('el dispositivo y el mensaje impresoras', () => {
  async function conectado() {
    const enviados: unknown[] = []
    let cambios = 0
    const fallos: unknown[] = []
    const almacen = new AlmacenDispositivoMemoria()
    const cliente = new ClienteSync({
      almacen,
      token: 't',
      versionApp: 'x',
      enviar: (m) => enviados.push(m),
      alCambiar: () => {
        cambios += 1
      },
      alFallo: (e) => fallos.push(e),
    })
    await cliente.alConectar()
    await cliente.listo()
    return { cliente, almacen, enviados, fallos, cambios: () => cambios }
  }

  it('no cambia nada guardado, no hace releer la pantalla y no pide nada al hub', async () => {
    const c = await conectado()
    const antes = { enviados: c.enviados.length, cambios: c.cambios() }
    await c.cliente.recibir({ tipo: 'impresoras', impresoras: ESTADOS })
    await c.cliente.listo()
    expect(c.enviados).toHaveLength(antes.enviados)
    expect(c.cambios()).toBe(antes.cambios)
    expect(c.fallos).toEqual([])
    expect(await c.almacen.cursor()).toMatchObject({ hasta: 0 })
    expect(await c.cliente.locales()).toEqual([])
  })

  it('varios avisos seguidos (incluso vacíos o repetidos) no rompen la cola de mensajes', async () => {
    const c = await conectado()
    for (const lista of [ESTADOS, ESTADOS, [], ESTADOS.slice(0, 1)])
      await c.cliente.recibir({ tipo: 'impresoras', impresoras: lista })
    // Un evento nuevo del hub después sigue procesándose con normalidad.
    const m = montar('memoria')
    const { pedido } = conPlatos(m, 0)
    const e = m.hub.traer(0, 'mesero').eventos[0]
    await c.cliente.recibir({
      tipo: 'nuevo',
      evento: e as EventoPedido,
      hasta_anterior: 0,
      hasta: 1,
    })
    await c.cliente.listo()
    expect((await c.cliente.locales()).map((l) => l.evento.agregado_id)).toEqual([pedido])
    expect(c.fallos).toEqual([])
  })
})
