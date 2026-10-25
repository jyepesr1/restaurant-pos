import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { firmarEvento, nuevoId } from '@pos/core'
import type { MensajeHub } from '@pos/sync'
import { afterEach, describe, expect, it } from 'vitest'
import type WebSocket from 'ws'
import { abrirDatos, prepararAcceso, prepararSincronizacion } from './arranque'
import { leerCarta } from './seed/carta'
import { sembrar } from './seed/sembrar'
import { crearServidor } from './servidor'

// Agotado (86) por el WebSocket real del hub, con la carta del piloto: el aviso `nuevo` llega a
// los demás equipos, quien no tiene permiso no lo difunde y un ítem de un producto agotado entra.

const CARTA = readFileSync(
  fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)

let carpeta = ''
afterEach(() => rmSync(carpeta, { recursive: true, force: true }))

type Sesion = { sesion_id: string; secreto: string; usuario: { id: string } }

async function montar() {
  carpeta = mkdtempSync(join(tmpdir(), 'pos-agotados-'))
  const { db } = abrirDatos(carpeta)
  let sala: ReturnType<typeof prepararSincronizacion> | null = null
  const acceso = prepararAcceso(
    db,
    carpeta,
    () => {},
    (id, en) => sala?.revocar(id, en),
  )
  const { pines } = sembrar(
    db,
    acceso.acceso,
    { restauranteId: acceso.restauranteId, roles: acceso.roles, carta: leerCarta(CARTA) },
    new Date().toISOString(),
  )
  sala = prepararSincronizacion(db, carpeta, acceso.restauranteId, acceso.acceso)
  const app = crearServidor({
    acceso: acceso.acceso,
    sincronizacion: { sala, intervaloLatidoMs: 60_000 },
    catalogo: { db, restauranteId: acceso.restauranteId, acceso: acceso.acceso },
  })
  await app.ready()
  /** Con qué entra cada quien: usuario y contraseña si los tiene (ADR-013), si no su PIN. */
  const credencialesDe = (nombre: string) => {
    if (nombre === 'Administrador')
      return {
        usuario: acceso.admin.usuario as string,
        contrasena: acceso.admin.contrasena as string,
      }
    const p = pines.find((x) => x.nombre === nombre)
    return p?.usuario
      ? { usuario: p.usuario, contrasena: p.contrasena as string }
      : { pin: p?.pin as string }
  }
  const post = async (url: string, cuerpo: object, token?: string) =>
    (
      await app.inject({
        method: 'POST',
        url,
        payload: cuerpo,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
    ).json()

  /**
   * Entra sin emparejar (ADR-013): el hub registra el equipo, de caja si quien entra cobra. El
   * tipo y el nombre de cada llamada solo dicen qué equipo es en la prueba.
   */
  async function equipo(_tipo: 'mesero' | 'caja', _nombre: string, quien: string) {
    const r = await post('/api/entrar', credencialesDe(quien))
    return {
      token: r.equipo.token as string,
      dispositivoId: r.equipo.dispositivo_id as string,
      sesion: r as Sesion,
    }
  }

  /** Abre el WebSocket; `esperar` se resuelve cuando llega (o ya llegó) un mensaje así. */
  async function conectar(token: string) {
    const recibidos: MensajeHub[] = []
    const pendientes: { sirve: (m: MensajeHub) => boolean; listo: (m: MensajeHub) => void }[] = []
    const ws: WebSocket = await app.injectWS('/api/sync/ws')
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as MensajeHub
      recibidos.push(m)
      for (const [i, p] of pendientes.entries())
        if (p.sirve(m)) {
          pendientes.splice(i, 1)
          p.listo(m)
          break
        }
    })
    const enviar = (m: object) => ws.send(JSON.stringify(m))
    enviar({ tipo: 'hola', token, hub_instancia: null, hasta: 0, version_app: 'prueba' })
    const esperar = <T extends MensajeHub['tipo']>(
      tipo: T,
      sirve: (m: Extract<MensajeHub, { tipo: T }>) => boolean = () => true,
    ) =>
      new Promise<Extract<MensajeHub, { tipo: T }>>((listo) => {
        const cumple = (m: MensajeHub) =>
          m.tipo === tipo && sirve(m as Extract<MensajeHub, { tipo: T }>)
        const ya = recibidos.find(cumple)
        if (ya) listo(ya as Extract<MensajeHub, { tipo: T }>)
        else pendientes.push({ sirve: cumple, listo: listo as (m: MensajeHub) => void })
      })
    await esperar('bienvenido')
    return { ws, recibidos, enviar, esperar }
  }

  const catalogo = async (token: string) =>
    (
      await app.inject({
        method: 'GET',
        url: '/api/catalogo',
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()

  return { app, equipo, conectar, catalogo }
}

const evento = (
  e: { sesion: Sesion; dispositivoId: string },
  tipo: string,
  datos: unknown,
  extras: Record<string, unknown> = {},
) => {
  const ahora = new Date().toISOString()
  const base = {
    id: nuevoId(),
    tipo,
    version_esquema: 1,
    agregado_tipo: 'pedido',
    agregado_id: nuevoId(),
    relacionados: [],
    datos,
    sesion_id: e.sesion.sesion_id,
    usuario_id: e.sesion.usuario.id,
    dispositivo_id: e.dispositivoId,
    autorizacion_id: null,
    motivo: null,
    hora_dispositivo: ahora,
    hora_estimada_hub: ahora,
    secuencia_base: 0,
    ...extras,
  }
  return { ...base, firma: firmarEvento(base as never, e.sesion.secreto) }
}

const agotar = (
  e: Parameters<typeof evento>[0],
  producto: string,
  variante: string | null = null,
) =>
  evento(
    e,
    'ProductoAgotado',
    { producto_id: producto, variante_id: variante },
    { agregado_tipo: 'producto', agregado_id: producto },
  )

type ProductoCarta = {
  id: string
  nombre: string
  precio: number
  impuesto: { tipo: string; tarifa: number }
  variantes: { id: string }[]
}
const primerProductoSimple = (catalogo: { categorias: { productos: ProductoCarta[] }[] }) =>
  catalogo.categorias
    .flatMap((c) => c.productos)
    .find((p) => p.variantes.length === 0) as ProductoCarta

describe('agotados por el WebSocket', () => {
  it('la caja marca agotado: se confirma y el celular del mesero recibe el aviso nuevo, sin la sesión', async () => {
    const m = await montar()
    const caja = await m.equipo('caja', 'Caja', 'Caja')
    const celular = await m.equipo('mesero', 'Celular Ana', 'Mesero 1')
    const producto = primerProductoSimple(await m.catalogo(caja.token))
    const enCaja = await m.conectar(caja.token)
    const enCelular = await m.conectar(celular.token)

    const e = agotar(caja, producto.id)
    enCaja.enviar({ tipo: 'empujar', lote_id: 'l1', eventos: [e] })

    const resultado = await enCaja.esperar('resultado')
    expect(resultado).toMatchObject({
      lote_id: 'l1',
      resultados: [{ id: e.id, estado: 'confirmado', aceptacion: { secuencia: 1 } }],
    })
    const aviso = await enCelular.esperar('nuevo', (n) => n.evento.id === e.id)
    expect(aviso).toMatchObject({
      hasta_anterior: 0,
      hasta: 1,
      evento: {
        tipo: 'ProductoAgotado',
        agregado_tipo: 'producto',
        agregado_id: producto.id,
        sesion_id: null,
        datos: { producto_id: producto.id, variante_id: null },
      },
    })

    enCaja.ws.terminate()
    enCelular.ws.terminate()
    await m.app.close()
  })

  it('el mesero no puede agotar: lo rechaza con sin_permiso y no se avisa a nadie', async () => {
    const m = await montar()
    const caja = await m.equipo('caja', 'Caja', 'Caja')
    const celular = await m.equipo('mesero', 'Celular Ana', 'Mesero 1')
    const producto = primerProductoSimple(await m.catalogo(caja.token))
    const enCaja = await m.conectar(caja.token)
    const enCelular = await m.conectar(celular.token)

    const e = agotar(celular, producto.id)
    enCelular.enviar({ tipo: 'empujar', lote_id: 'l1', eventos: [e] })
    expect(await enCelular.esperar('resultado')).toMatchObject({
      resultados: [{ id: e.id, estado: 'rechazado', motivo: 'sin_permiso' }],
    })
    // El pong llega después de todo lo anterior en el mismo orden: si hubiera aviso, ya estaría.
    enCaja.enviar({ tipo: 'ping', marca: 'fin' })
    await enCaja.esperar('pong')
    expect(enCaja.recibidos.some((x) => x.tipo === 'nuevo')).toBe(false)
    expect(enCelular.recibidos.some((x) => x.tipo === 'nuevo')).toBe(false)

    enCaja.ws.terminate()
    enCelular.ws.terminate()
    await m.app.close()
  })

  it('un ítem de un producto agotado entra con el precio de la carta y sin conflicto', async () => {
    const m = await montar()
    const caja = await m.equipo('caja', 'Caja', 'Caja')
    const celular = await m.equipo('mesero', 'Celular Ana', 'Mesero 1')
    const catalogo = await m.catalogo(caja.token)
    const producto = primerProductoSimple(catalogo)
    const enCaja = await m.conectar(caja.token)
    const enCelular = await m.conectar(celular.token)
    enCaja.enviar({ tipo: 'empujar', lote_id: 'a', eventos: [agotar(caja, producto.id)] })
    await enCelular.esperar('nuevo')

    // El celular, que ya sabe que está agotado, igual manda lo que su mesero ya había tomado.
    const pedido = nuevoId()
    const abrir = evento(
      celular,
      'PedidoAbierto',
      { canal: 'barra', mesa_id: null, comensales: 1 },
      { agregado_id: pedido },
    )
    const itemAgotado = evento(
      celular,
      'ItemAgregado',
      {
        item_id: nuevoId(),
        producto_id: producto.id,
        variante_id: null,
        nombre: producto.nombre,
        precio_unitario: producto.precio,
        impuesto_tipo: producto.impuesto.tipo,
        tarifa: producto.impuesto.tipo === 'exento' ? 0 : producto.impuesto.tarifa,
        cantidad: 2,
        comensal: null,
        curso: null,
        modificadores: [],
        notas: null,
        catalogo_version: catalogo.version,
        precio_canal_id: null,
      },
      { agregado_id: pedido, secuencia_base: 1 },
    )
    enCelular.enviar({ tipo: 'empujar', lote_id: 'b', eventos: [abrir, itemAgotado] })

    const r = await enCelular.esperar('resultado', (x) => x.lote_id === 'b')
    expect(r.resultados.map((x) => x.estado)).toEqual(['confirmado', 'confirmado'])
    expect(r.resultados[1]).toMatchObject({ conflicto: null })

    enCaja.ws.terminate()
    enCelular.ws.terminate()
    await m.app.close()
  })

  it('un equipo que se conecta después trae el agotado con `traer`, en su lugar de la secuencia', async () => {
    const m = await montar()
    const caja = await m.equipo('caja', 'Caja', 'Caja')
    const celular = await m.equipo('mesero', 'Celular Ana', 'Mesero 1')
    const producto = primerProductoSimple(await m.catalogo(caja.token))
    const enCaja = await m.conectar(caja.token)
    enCaja.enviar({ tipo: 'empujar', lote_id: 'a', eventos: [agotar(caja, producto.id)] })
    await enCaja.esperar('resultado')
    enCaja.enviar({
      tipo: 'empujar',
      lote_id: 'b',
      eventos: [
        evento(
          caja,
          'ProductoDisponible',
          { producto_id: producto.id, variante_id: null },
          { agregado_tipo: 'producto', agregado_id: producto.id, secuencia_base: 1 },
        ),
      ],
    })
    await enCaja.esperar('resultado', (x) => x.lote_id === 'b')

    const tarde = await m.conectar(celular.token)
    tarde.enviar({ tipo: 'traer', desde: 0 })
    const traido = await tarde.esperar('eventos')
    expect(traido.eventos.map((x) => [x.secuencia, x.tipo, x.agregado_tipo])).toEqual([
      [1, 'ProductoAgotado', 'producto'],
      [2, 'ProductoDisponible', 'producto'],
    ])

    enCaja.ws.terminate()
    tarde.ws.terminate()
    await m.app.close()
  })
})
