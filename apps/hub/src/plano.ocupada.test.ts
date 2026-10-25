import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { firmarEvento, nuevoId } from '@pos/core'
import type { BaseSqlite } from '@pos/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { abrirDatos, prepararAcceso } from './arranque'
import { leerCarta } from './seed/carta'
import { sembrar } from './seed/sembrar'

// La regla «una mesa con un pedido abierto no se archiva» por la ruta real: el proceso del hub
// (`src/main.ts`, que es quien conecta la sala con la edición del catálogo), un pedido abierto de
// verdad por WebSocket y la edición por HTTP. Sin esto, un cambio en el cableado de `main.ts`
// dejaría la regla muerta sin que ninguna prueba lo note.

const DIR_HUB = fileURLToPath(new URL('..', import.meta.url))
const CARTA = readFileSync(
  fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)

function puertoLibre(): Promise<number> {
  return new Promise((resolver, rechazar) => {
    const servidor = createServer()
    servidor.once('error', rechazar)
    servidor.listen(0, '127.0.0.1', () => {
      const { port } = servidor.address() as { port: number }
      servidor.close(() => resolver(port))
    })
  })
}

interface Arrancado {
  hijo: ChildProcess
  salida: () => string
  detener: () => Promise<void>
}

function arrancar(env: Record<string, string>): Promise<Arrancado> {
  const hijo = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/main.ts'],
    { cwd: DIR_HUB, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let texto = ''
  const acumular = (trozo: Buffer) => {
    texto += String(trozo)
  }
  hijo.stdout?.on('data', acumular)
  hijo.stderr?.on('data', acumular)
  const terminado = new Promise<void>((resolver) => hijo.once('exit', () => resolver()))
  return new Promise((resolver, rechazar) => {
    const revisar = () => {
      if (!texto.includes('Hub en marcha')) return
      hijo.stdout?.off('data', revisar)
      resolver({
        hijo,
        salida: () => texto,
        detener: async () => {
          hijo.kill('SIGKILL')
          await terminado
        },
      })
    }
    hijo.stdout?.on('data', revisar)
    hijo.once('exit', (codigo) =>
      rechazar(new Error(`El hub terminó con código ${codigo} antes de arrancar:\n${texto}`)),
    )
  })
}

// biome-ignore lint/suspicious/noExplicitAny: respuestas JSON de la prueba, sin tipar.
type Json = Record<string, any>

/** Un equipo conectado por WebSocket: junta lo que llega y deja esperar un mensaje sin sleeps. */
function conectarWs(url: string, token: string) {
  const ws = new WebSocket(url)
  const recibidos: Json[] = []
  const esperando: { cumple: (m: Json) => boolean; resolver: (m: Json) => void }[] = []
  ws.addEventListener('message', (e) => {
    const mensaje = JSON.parse(String(e.data)) as Json
    recibidos.push(mensaje)
    for (const [i, w] of esperando.entries())
      if (w.cumple(mensaje)) {
        esperando.splice(i, 1)
        w.resolver(mensaje)
        break
      }
  })
  const abierto = new Promise<void>((resolver, rechazar) => {
    ws.addEventListener('open', () => resolver())
    ws.addEventListener('error', () => rechazar(new Error('No abrió el WebSocket')))
  })
  const esperar = (tipo: string, cumple: (m: Json) => boolean = () => true) => {
    const ya = recibidos.find((m) => m.tipo === tipo && cumple(m))
    if (ya) return Promise.resolve(ya)
    return new Promise<Json>((resolver) =>
      esperando.push({ cumple: (m) => m.tipo === tipo && cumple(m), resolver }),
    )
  }
  const enviar = (m: object) => ws.send(JSON.stringify(m))
  return {
    ws,
    recibidos,
    esperar,
    enviar,
    async saludar() {
      await abierto
      enviar({ tipo: 'hola', token, hub_instancia: null, hasta: 0, version_app: 'prueba' })
      return esperar('bienvenido')
    },
    cerrar: () => ws.close(),
  }
}

describe('mesa ocupada por la ruta real del hub (main.ts)', () => {
  let carpeta = ''
  let hub: Arrancado | undefined
  const abiertos: { cerrar: () => void }[] = []

  beforeEach(() => {
    carpeta = mkdtempSync(join(tmpdir(), 'pos-ocupada-'))
  })
  afterEach(async () => {
    for (const c of abiertos.splice(0)) c.cerrar()
    await hub?.detener()
    hub = undefined
    rmSync(carpeta, { recursive: true, force: true })
  })

  /** Siembra el salón (con personal) y deja la carpeta lista para que arranque el hub. */
  function prepararCarpeta() {
    const dirDatos = join(carpeta, 'datos')
    const { db } = abrirDatos(dirDatos)
    const acceso = prepararAcceso(db, dirDatos)
    const { pines } = sembrar(
      db,
      acceso.acceso,
      { restauranteId: acceso.restauranteId, roles: acceso.roles, carta: leerCarta(CARTA) },
      new Date().toISOString(),
    )
    ;(db as BaseSqlite & { close(): void }).close()
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
    return { dirDatos, credencialesDe }
  }

  async function levantar(dirDatos: string, puerto: number) {
    hub = await arrancar({
      DIR_DATOS: dirDatos,
      DIR_APP: join(carpeta, 'sin-app'),
      PUERTO: String(puerto),
    })
  }

  async function escenario() {
    const { dirDatos, credencialesDe } = prepararCarpeta()
    const puerto = await puertoLibre()
    await levantar(dirDatos, puerto)
    const url = `http://127.0.0.1:${puerto}`
    const post = async (ruta: string, cuerpo: object, token?: string) => {
      const r = await fetch(url + ruta, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(cuerpo),
      })
      return { codigo: r.status, cuerpo: (await r.json()) as Json }
    }
    const get = async (ruta: string, token: string) =>
      (await (
        await fetch(url + ruta, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as Json

    // Entran sin emparejar (ADR-013): el hub registra cada equipo.
    const emparejar = async (tipo: 'caja' | 'mesero', _nombre: string) => {
      const { cuerpo: r } = await post(
        '/api/entrar',
        credencialesDe(tipo === 'caja' ? 'Administrador' : 'Mesero 2'),
      )
      return r.equipo as { token: string; dispositivo_id: string }
    }
    const caja = await emparejar('caja', 'Caja')
    const celular = await emparejar('mesero', 'Celular')
    const sesion = async (equipo: { token: string }, nombre: string) =>
      (await post('/api/entrar', credencialesDe(nombre), equipo.token)).cuerpo as Json
    const gerente = await sesion(caja, 'Administrador')
    const mesero = await sesion(celular, 'Mesero 1')

    const wsUrl = `${url.replace('http', 'ws')}/api/sync/ws`
    const enCelular = conectarWs(wsUrl, celular.token)
    const enCaja = conectarWs(wsUrl, caja.token)
    abiertos.push(enCelular, enCaja)
    await enCelular.saludar()
    await enCaja.saludar()

    /** Evento firmado de un equipo; `base` es lo último que ese equipo conoce del hub. */
    const evento = (
      quien: { dispositivo_id: string },
      s: Json,
      pedido: string,
      tipo: string,
      datos: object,
      base: number,
    ) => {
      const ahora = new Date().toISOString()
      const e = {
        id: nuevoId(),
        tipo,
        version_esquema: 1,
        agregado_tipo: 'pedido',
        agregado_id: pedido,
        relacionados: [],
        datos,
        sesion_id: s.sesion_id,
        usuario_id: s.usuario.id,
        dispositivo_id: quien.dispositivo_id,
        autorizacion_id: null,
        motivo: tipo === 'PedidoCancelado' || tipo === 'PedidoReabierto' ? 'Prueba' : null,
        hora_dispositivo: ahora,
        hora_estimada_hub: ahora,
        secuencia_base: base,
      }
      return { ...e, firma: firmarEvento(e as never, s.secreto) }
    }
    const empujar = async (ws: ReturnType<typeof conectarWs>, e: Json): Promise<Json> => {
      const lote = nuevoId()
      ws.enviar({ tipo: 'empujar', lote_id: lote, eventos: [e] })
      const r = await ws.esperar('resultado', (m) => m.lote_id === lote)
      return r.resultados[0]
    }
    const editar = (cambios: object[]) =>
      post(
        '/api/catalogo/cambios',
        { sesion_id: gerente.sesion_id, secreto: gerente.secreto, cambios },
        caja.token,
      )
    const catalogo = () => get('/api/catalogo', caja.token)
    const mesaPorNombre = async (nombre: string) => {
      const c = await catalogo()
      const m = (c.mesas as Json[]).find((x) => x.nombre === nombre)
      if (!m) throw new Error(`No está la mesa ${nombre}`)
      return m.id as string
    }
    return {
      dirDatos,
      puerto,
      post,
      caja,
      celular,
      gerente,
      mesero,
      enCaja,
      enCelular,
      evento,
      empujar,
      editar,
      catalogo,
      mesaPorNombre,
      sesion,
      wsUrl,
    }
  }

  const archivar = (id: string) => [{ entidad: 'mesa', id, datos: { activo: false } }]

  it('con un pedido abierto por WebSocket la mesa no se archiva; al cerrarlo, sí', async () => {
    const e = await escenario()
    const mesa = await e.mesaPorNombre('5')
    const pedido = nuevoId()
    const abierto = await e.empujar(
      e.enCelular,
      e.evento(
        e.celular,
        e.mesero,
        pedido,
        'PedidoAbierto',
        { canal: 'salon', mesa_id: mesa, comensales: 2 },
        0,
      ),
    )
    expect(abierto.estado).toBe('confirmado')

    const bloqueado = await e.editar(archivar(mesa))
    expect(bloqueado.codigo).toBe(400)
    expect(bloqueado.cuerpo.mensaje).toMatch(/la mesa 5 tiene un pedido abierto/)
    expect(((await e.catalogo()).mesas as Json[]).some((m) => m.id === mesa)).toBe(true)

    // Archivar una mesa libre junto con la ocupada tampoco pasa: el guardado es todo o nada.
    const otra = await e.mesaPorNombre('6')
    const junto = await e.editar([...archivar(otra), ...archivar(mesa)])
    expect(junto.codigo).toBe(400)
    expect(((await e.catalogo()).mesas as Json[]).some((m) => m.id === otra)).toBe(true)

    // La caja cierra el pedido (vacío: saldo 0) y entonces la mesa queda libre.
    const cerrado = await e.empujar(
      e.enCaja,
      e.evento(e.caja, e.gerente, pedido, 'PedidoCerrado', {}, abierto.aceptacion.secuencia),
    )
    expect(cerrado.estado).toBe('confirmado')
    const libre = await e.editar(archivar(mesa))
    expect(libre).toMatchObject({ codigo: 200, cuerpo: { cambiados: 1 } })
    expect(((await e.catalogo()).mesas as Json[]).some((m) => m.id === mesa)).toBe(false)
  })

  it('un pedido cancelado también libera la mesa', async () => {
    const e = await escenario()
    const mesa = await e.mesaPorNombre('8')
    const pedido = nuevoId()
    const abierto = await e.empujar(
      e.enCelular,
      e.evento(
        e.celular,
        e.mesero,
        pedido,
        'PedidoAbierto',
        { canal: 'salon', mesa_id: mesa, comensales: 1 },
        0,
      ),
    )
    expect((await e.editar(archivar(mesa))).codigo).toBe(400)
    const cancelado = await e.empujar(
      e.enCaja,
      e.evento(e.caja, e.gerente, pedido, 'PedidoCancelado', {}, abierto.aceptacion.secuencia),
    )
    expect(cancelado.estado).toBe('confirmado')
    expect((await e.editar(archivar(mesa))).codigo).toBe(200)
  })

  it('al cambiar el pedido de mesa, la vieja se libera y la nueva queda protegida', async () => {
    const e = await escenario()
    const origen = await e.mesaPorNombre('1')
    const destino = await e.mesaPorNombre('2')
    const pedido = nuevoId()
    const abierto = await e.empujar(
      e.enCelular,
      e.evento(
        e.celular,
        e.mesero,
        pedido,
        'PedidoAbierto',
        { canal: 'salon', mesa_id: origen, comensales: 1 },
        0,
      ),
    )
    const movido = await e.empujar(
      e.enCelular,
      e.evento(
        e.celular,
        e.mesero,
        pedido,
        'PedidoMovidoDeMesa',
        { mesa_destino_id: destino },
        abierto.aceptacion.secuencia,
      ),
    )
    expect(movido.estado).toBe('confirmado')
    expect((await e.editar(archivar(destino))).codigo).toBe(400)
    expect((await e.editar(archivar(origen))).codigo).toBe(200)
  })

  it('una edición que sí se aplica avisa por WebSocket a los equipos conectados con la versión nueva', async () => {
    const e = await escenario()
    const mesa = await e.mesaPorNombre('10')
    const r = await e.editar([{ entidad: 'mesa', id: mesa, datos: { x: 900 } }])
    expect(r.codigo).toBe(200)
    const aviso = await e.enCelular.esperar('catalogo', (m) => m.version === r.cuerpo.version)
    expect(aviso.version).toBe(r.cuerpo.version)
    // Una edición rechazada no avisa: el siguiente aviso que llega es el de la edición buena.
    const ocupada = await e.mesaPorNombre('11')
    const pedido = nuevoId()
    await e.empujar(
      e.enCelular,
      e.evento(
        e.celular,
        e.mesero,
        pedido,
        'PedidoAbierto',
        { canal: 'salon', mesa_id: ocupada, comensales: 1 },
        0,
      ),
    )
    const antes = e.enCelular.recibidos.filter((m) => m.tipo === 'catalogo').length
    expect((await e.editar(archivar(ocupada))).codigo).toBe(400)
    expect(e.enCelular.recibidos.filter((m) => m.tipo === 'catalogo')).toHaveLength(antes)
  })

  it('si el hub se apaga y vuelve con el pedido abierto, la mesa sigue protegida', async () => {
    const e = await escenario()
    const mesa = await e.mesaPorNombre('12')
    const pedido = nuevoId()
    const abierto = await e.empujar(
      e.enCelular,
      e.evento(
        e.celular,
        e.mesero,
        pedido,
        'PedidoAbierto',
        { canal: 'salon', mesa_id: mesa, comensales: 3 },
        0,
      ),
    )
    expect(abierto.estado).toBe('confirmado')
    expect(e.puerto).toBeGreaterThan(0)

    // Corte: el proceso muere sin avisar y vuelve a arrancar con la misma carpeta de datos.
    for (const c of abiertos.splice(0)) c.cerrar()
    await hub?.detener()
    hub = undefined
    await levantar(e.dirDatos, e.puerto)

    // Los equipos siguen emparejados y con su sesión: el hub guarda ambos.
    const r = await e.editar(archivar(mesa))
    expect(r.codigo).toBe(400)
    expect(r.cuerpo.mensaje).toMatch(/tiene un pedido abierto/)
  })
})
