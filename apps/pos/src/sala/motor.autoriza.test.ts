import 'fake-indexeddb/auto'
import { firmarEvento, huellaAutorizable, nuevoId } from '@pos/core'
import type { Canal } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import { ErrorApi } from './api'
import { type Equipo, Sala, type Sesion } from './motor'
import { catalogoDePrueba } from './pruebas'

// El motor con el PIN de un supervisor (tarea 1.5, ADR-008): `registrar(..., { motivo, autoriza })`
// pide `/api/autorizaciones` con la huella del evento, y el evento sale con el comprobante y su
// firma. Sin conexión, o con un PIN que el hub no acepta, no se guarda nada.

const salas: Sala[] = []
const bases: BaseDispositivo[] = []
afterEach(async () => {
  for (const s of salas.splice(0)) s.simularSinConexion(true)
  vi.unstubAllGlobals()
  await new Promise((r) => setTimeout(r, 20))
  for (const b of bases.splice(0)) await b.delete()
})

const sinRed = (): Canal => ({ enviar: () => {}, cerrar: () => {} })
const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })

interface Llamada {
  url: string
  cuerpo: Record<string, unknown> | null
  token: string | null
}

function hubFalso(responder: (l: Llamada) => Response) {
  const llamadas: Llamada[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const llamada: Llamada = {
        url,
        cuerpo: init?.body ? JSON.parse(String(init.body)) : null,
        token: headers.authorization?.replace('Bearer ', '') ?? null,
      }
      llamadas.push(llamada)
      if (url === '/api/catalogo') return json(catalogoDePrueba())
      return responder(llamada)
    }),
  )
  return llamadas
}
const autorizaciones = (l: Llamada[]) => l.filter((x) => x.url === '/api/autorizaciones')

const equipo: Equipo = {
  dispositivoId: nuevoId(),
  token: 'token-ana',
  nombre: 'Ana',
  tipo: 'mesero',
}
const sesionMesero = (): Sesion => ({
  sesionId: nuevoId(),
  secreto: 'secreto-ana',
  usuario: { id: nuevoId(), nombre: 'Ana', rol: 'Mesero' },
  permisos: ['tomar_pedido'],
  ultimoUso: Date.now(),
})

async function abrir(sesion: Sesion | null = sesionMesero()) {
  const db = new BaseDispositivo(`prueba-${nuevoId()}`)
  bases.push(db)
  await db.guardarAjuste('equipo', equipo)
  if (sesion) await db.guardarAjuste('sesion', sesion)
  await db.guardarAjuste('catalogo', catalogoDePrueba())
  const sala = new Sala({ db, abrir: sinRed })
  salas.push(sala)
  await sala.cargar()
  return { sala, sesion }
}

const ANULAR = { item_id: nuevoId(), cantidad: 1, ya_preparado: false, comanda_id: null }
const COMPROBANTE = nuevoId()
const concede = () =>
  json({ autorizacion_id: COMPROBANTE, supervisor: { id: nuevoId(), nombre: 'Gloria' } }, 201)
const guardados = async (sala: Sala) => (await sala.sync?.locales()) ?? []

describe('Sala.registrar con autoriza', () => {
  it('pide el comprobante con la huella del evento, para ese pedido, ese evento y esa acción', async () => {
    const llamadas = hubFalso(concede)
    const { sala, sesion } = await abrir()
    const pedido = nuevoId()
    const evento = await sala.registrar('ItemAnulado', pedido, ANULAR, {
      motivo: 'Error del mesero',
      autoriza: { pin: '4321', permiso: 'anular_item_enviado' },
    })
    const [llamada, ...otras] = autorizaciones(llamadas)
    expect(otras).toEqual([])
    expect(llamada).toMatchObject({
      token: 'token-ana',
      cuerpo: {
        sesion_id: sesion?.sesionId,
        secreto: 'secreto-ana',
        pin: '4321',
        accion: 'anular_item_enviado',
        agregado_id: pedido,
        evento_id: evento.id,
      },
    })
    // La huella es la del evento tal como salió (sin comprobante ni firma).
    expect(llamada?.cuerpo?.huella).toBe(huellaAutorizable(evento))
    expect(llamada?.cuerpo?.huella).toMatch(/^[0-9a-f]{64}$/)
  })

  it('el evento sale con el autorizacion_id del hub y una firma válida que cubre ese comprobante', async () => {
    hubFalso(concede)
    const { sala } = await abrir()
    const evento = await sala.registrar('ItemAnulado', nuevoId(), ANULAR, {
      motivo: 'Demora',
      autoriza: { pin: '4321', permiso: 'anular_item_enviado' },
    })
    expect(evento.autorizacion_id).toBe(COMPROBANTE)
    const { firma, ...sinFirma } = evento
    expect(firma).toBe(firmarEvento(sinFirma as never, 'secreto-ana'))
    // La firma cambia si el comprobante cambia: está firmado con él puesto.
    expect(firmarEvento({ ...sinFirma, autorizacion_id: null } as never, 'secreto-ana')).not.toBe(
      firma,
    )
    // Y la huella (sin comprobante) no cambia por ponerlo.
    expect(huellaAutorizable({ ...sinFirma, autorizacion_id: null } as never)).toBe(
      huellaAutorizable(evento),
    )
  })

  it('el evento queda guardado en el equipo, pendiente, con el comprobante y el motivo', async () => {
    hubFalso(concede)
    const { sala } = await abrir()
    const evento = await sala.registrar(
      'PedidoCancelado',
      nuevoId(),
      {},
      {
        motivo: 'El cliente cambió',
        autoriza: { pin: '1111', permiso: 'cancelar_pedido' },
      },
    )
    const guardado = (await guardados(sala)).find((l) => l.evento.id === evento.id)
    expect(guardado).toMatchObject({
      estado: 'pendiente',
      evento: {
        autorizacion_id: COMPROBANTE,
        motivo: 'El cliente cambió',
        tipo: 'PedidoCancelado',
      },
    })
  })

  it('la acción que se pide es la del permiso, tal cual (cancelar_pedido)', async () => {
    const llamadas = hubFalso(concede)
    const { sala } = await abrir()
    await sala.registrar(
      'PedidoCancelado',
      nuevoId(),
      {},
      {
        motivo: 'x',
        autoriza: { pin: '1111', permiso: 'cancelar_pedido' },
      },
    )
    expect(autorizaciones(llamadas)[0]?.cuerpo?.accion).toBe('cancelar_pedido')
  })

  it('cada evento pide su propio comprobante (evento_id distinto)', async () => {
    const llamadas = hubFalso(concede)
    const { sala } = await abrir()
    const a = await sala.registrar('ItemAnulado', nuevoId(), ANULAR, {
      motivo: 'x',
      autoriza: { pin: '4321', permiso: 'anular_item_enviado' },
    })
    const b = await sala.registrar('ItemAnulado', nuevoId(), ANULAR, {
      motivo: 'x',
      autoriza: { pin: '4321', permiso: 'anular_item_enviado' },
    })
    const ids = autorizaciones(llamadas).map((l) => l.cuerpo?.evento_id)
    expect(ids).toEqual([a.id, b.id])
    expect(a.id).not.toBe(b.id)
  })

  it('motivo y relacionados llegan al evento, con o sin comprobante', async () => {
    const llamadas = hubFalso(concede)
    const { sala } = await abrir()
    const destino = nuevoId()
    const mover = await sala.registrar(
      'PedidoMovidoDeMesa',
      nuevoId(),
      { mesa_destino_id: nuevoId() },
      { relacionados: [destino], motivo: 'por si acaso' },
    )
    expect(mover).toMatchObject({
      relacionados: [destino],
      motivo: 'por si acaso',
      autorizacion_id: null,
    })
    expect(autorizaciones(llamadas)).toHaveLength(0)
    const anular = await sala.registrar('ItemAnulado', nuevoId(), ANULAR, {
      motivo: 'Demora',
      relacionados: [destino],
      autoriza: { pin: '4321', permiso: 'anular_item_enviado' },
    })
    expect(anular).toMatchObject({ relacionados: [destino], motivo: 'Demora' })
    // La huella cubre el motivo y los relacionados: son parte del contenido que se autoriza.
    expect(autorizaciones(llamadas)[0]?.cuerpo?.huella).toBe(huellaAutorizable(anular))
  })

  it('sin opciones: motivo null, sin relacionados y sin comprobante (como antes)', async () => {
    const llamadas = hubFalso(concede)
    const { sala } = await abrir()
    const e = await sala.registrar('ComensalesCambiados', nuevoId(), { comensales: 3 })
    expect(e).toMatchObject({ motivo: null, relacionados: [], autorizacion_id: null })
    expect(autorizaciones(llamadas)).toEqual([])
  })

  it('sin conexión con la caja falla limpio: ErrorApi sin_conexion y no se guarda nada', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const { sala } = await abrir()
    await expect(
      sala.registrar('ItemAnulado', nuevoId(), ANULAR, {
        motivo: 'x',
        autoriza: { pin: '4321', permiso: 'anular_item_enviado' },
      }),
    ).rejects.toMatchObject({ codigo: 'sin_conexion' })
    expect(await guardados(sala)).toEqual([])
  })

  it('con el corte simulado tampoco sale la llamada ni se guarda el evento', async () => {
    const llamadas = hubFalso(concede)
    const { sala } = await abrir()
    sala.simularSinConexion(true)
    const r = sala.registrar('ItemAnulado', nuevoId(), ANULAR, {
      motivo: 'x',
      autoriza: { pin: '4321', permiso: 'anular_item_enviado' },
    })
    await expect(r).rejects.toBeInstanceOf(ErrorApi)
    await expect(r).rejects.toMatchObject({ codigo: 'sin_conexion' })
    expect(autorizaciones(llamadas)).toEqual([])
    expect(await guardados(sala)).toEqual([])
  })

  it.each([
    ['PIN incorrecto', 401, 'pin_incorrecto'],
    ['el mismo usuario', 403, 'autoautorizacion'],
    ['muchos intentos', 429, 'demasiados_intentos'],
  ])(
    'si el hub dice %s, falla con ese código y no se guarda ni se firma nada',
    async (_n, status, codigo) => {
      hubFalso(() => json({ error: codigo, mensaje: 'No se pudo autorizar' }, status))
      const { sala } = await abrir()
      await expect(
        sala.registrar('ItemAnulado', nuevoId(), ANULAR, {
          motivo: 'x',
          autoriza: { pin: '0000', permiso: 'anular_item_enviado' },
        }),
      ).rejects.toMatchObject({ codigo, message: 'No se pudo autorizar' })
      expect(await guardados(sala)).toEqual([])
      expect(sala.instantanea().sesion).not.toBeNull()
    },
  )

  it('si el hub dice que la sesión ya no vale, se cierra la sesión del equipo', async () => {
    hubFalso(() => json({ error: 'sesion_invalida', mensaje: 'Entra otra vez' }, 401))
    const { sala } = await abrir()
    await expect(
      sala.registrar('ItemAnulado', nuevoId(), ANULAR, {
        motivo: 'x',
        autoriza: { pin: '4321', permiso: 'anular_item_enviado' },
      }),
    ).rejects.toMatchObject({ codigo: 'sesion_invalida' })
    expect(sala.instantanea().sesion).toBeNull()
    expect(await guardados(sala)).toEqual([])
  })

  it('sin sesión no llama al hub y avisa que hay que entrar', async () => {
    const llamadas = hubFalso(concede)
    const { sala } = await abrir(null)
    await expect(
      sala.registrar('ItemAnulado', nuevoId(), ANULAR, {
        motivo: 'x',
        autoriza: { pin: '4321', permiso: 'anular_item_enviado' },
      }),
    ).rejects.toThrow('Sin sesión')
    expect(autorizaciones(llamadas)).toEqual([])
  })

  it('un fallo del comprobante deja la sesión abierta y el siguiente intento sí funciona', async () => {
    let n = 0
    const llamadas = hubFalso(() =>
      n++ === 0 ? json({ error: 'pin_incorrecto', mensaje: 'PIN incorrecto' }, 401) : concede(),
    )
    const { sala } = await abrir()
    const datos = {
      motivo: 'x',
      autoriza: { pin: '4321', permiso: 'anular_item_enviado' },
    }
    await expect(sala.registrar('ItemAnulado', nuevoId(), ANULAR, datos)).rejects.toMatchObject({
      codigo: 'pin_incorrecto',
    })
    const e = await sala.registrar('ItemAnulado', nuevoId(), ANULAR, datos)
    expect(e.autorizacion_id).toBe(COMPROBANTE)
    expect(autorizaciones(llamadas)).toHaveLength(2)
    expect((await guardados(sala)).map((l) => l.evento.id)).toEqual([e.id])
  })
})
