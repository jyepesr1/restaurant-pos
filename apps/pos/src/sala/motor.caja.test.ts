import 'fake-indexeddb/auto'
import { type EventoNuevo, firmarEvento, nuevoId, validarEventoNuevo } from '@pos/core'
import type { Canal } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import { turnoDeCaja } from './cuentas'
import { type Equipo, Sala, type Sesion } from './motor'
import { catalogoDePrueba } from './pruebas'

// «Caja y pagos» y abrir turno en el motor (tarea 1.6): cada método llama a su ruta con el token del
// equipo y la sesión, y los errores del hub llegan tal cual.

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
  metodo: string
}

function hubFalso(responder: (l: Llamada) => Response = () => new Response(null, { status: 204 })) {
  const llamadas: Llamada[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const llamada: Llamada = {
        url,
        metodo: init?.method ?? 'GET',
        cuerpo: init?.body ? JSON.parse(String(init.body)) : null,
        token: headers.authorization?.replace('Bearer ', '') ?? null,
      }
      llamadas.push(llamada)
      if (url === '/api/catalogo') return json(catalogoDePrueba({ version: 9 }))
      return responder(llamada)
    }),
  )
  return llamadas
}

const equipo: Equipo = {
  dispositivoId: nuevoId(),
  token: 'token-caja',
  nombre: 'Caja 1',
  tipo: 'caja',
}
const sesion = (): Sesion => ({
  sesionId: nuevoId(),
  secreto: 'secreto-carlos',
  usuario: { id: nuevoId(), nombre: 'Carlos', rol: 'Cajero' },
  permisos: ['registrar_pago', 'abrir_turno_caja', 'administrar_dispositivos'],
  ultimoUso: Date.now(),
})

async function abrir(sinConexion = false) {
  const db = new BaseDispositivo(`caja-${nuevoId()}`)
  bases.push(db)
  await db.guardarAjuste('equipo', equipo)
  const s = sesion()
  await db.guardarAjuste('sesion', s)
  await db.guardarAjuste('catalogo', catalogoDePrueba())
  const sala = new Sala({ db, abrir: sinRed })
  salas.push(sala)
  if (sinConexion) sala.simularSinConexion(true)
  await sala.cargar()
  return { sala, sesion: s }
}

const deRuta = (l: Llamada[], ruta: string) => l.filter((x) => x.url === ruta)
const locales = async (s: Sala) => (await s.sync?.locales()) ?? []

describe('métodos de «Caja y pagos»: ruta, token y sesión', () => {
  it.each([
    ['configuracionCaja', '/api/caja/configuracion', (s: Sala) => s.configuracionCaja(), {}],
    [
      'mediosDePago',
      '/api/caja/medios',
      (s: Sala) => s.mediosDePago(['efectivo', 'nequi']),
      { medios: ['efectivo', 'nequi'] },
    ],
    ['propinaSugerida', '/api/caja/propina', (s: Sala) => s.propinaSugerida(750), { puntos: 750 }],
    [
      'impresoraPrecuenta',
      '/api/caja/precuenta',
      (s: Sala) => s.impresoraPrecuenta('I'.repeat(26)),
      { impresora_id: 'I'.repeat(26) },
    ],
    [
      'impresoraPrecuenta (quitar)',
      '/api/caja/precuenta',
      (s: Sala) => s.impresoraPrecuenta(null),
      { impresora_id: null },
    ],
  ])('%s llama a %s con el token del equipo y la sesión', async (_n, ruta, llamar, extra) => {
    const llamadas = hubFalso(() =>
      json({ medios_pago: [], propina_sugerida: 1000, medios_propios: [], datafonos: [] }),
    )
    const { sala, sesion: s } = await abrir()
    await llamar(sala)
    const [l, ...otras] = deRuta(llamadas, ruta)
    expect(otras).toEqual([])
    expect(l).toMatchObject({
      metodo: 'POST',
      token: 'token-caja',
      cuerpo: { sesion_id: s.sesionId, secreto: 'secreto-carlos', ...extra },
    })
  })

  it('configuracionCaja devuelve lo que contesta el hub', async () => {
    const respuesta = {
      medios_pago: ['efectivo', 'nequi'],
      propina_sugerida: 1000,
      medios_propios: [{ id: 'm', nombre: 'Sodexo', activo: true }],
      datafonos: [{ id: 'd', nombre: 'Bold 1', proveedor: 'bold', activo: true }],
    }
    hubFalso(() => json(respuesta))
    const { sala } = await abrir()
    await expect(sala.configuracionCaja()).resolves.toEqual(respuesta)
  })

  it('guardarDatafono manda el datáfono y devuelve la lista nueva', async () => {
    const lista = [{ id: 'd'.repeat(26), nombre: 'Bold 1', proveedor: 'bold', activo: true }]
    const llamadas = hubFalso(() => json({ id: lista[0]?.id, datafonos: lista }))
    const { sala } = await abrir()
    const datafono = { nombre: 'Bold 1', proveedor: 'bold' as const, activo: true }
    await expect(sala.guardarDatafono(datafono)).resolves.toEqual(lista)
    expect(deRuta(llamadas, '/api/datafonos')[0]).toMatchObject({
      token: 'token-caja',
      cuerpo: { datafono },
    })
  })

  it('guardarMedioPropio manda el medio y devuelve la lista nueva', async () => {
    const lista = [{ id: 'm'.repeat(26), nombre: 'Sodexo', activo: true }]
    const llamadas = hubFalso(() => json({ id: lista[0]?.id, medios_propios: lista }))
    const { sala } = await abrir()
    const medio = { nombre: 'Sodexo', activo: true }
    await expect(sala.guardarMedioPropio(medio)).resolves.toEqual(lista)
    expect(deRuta(llamadas, '/api/caja/medios-propios')[0]).toMatchObject({
      token: 'token-caja',
      cuerpo: { medio },
    })
  })

  it('un error del hub (sin permiso, nombre repetido) llega como error con su código', async () => {
    hubFalso(() => json({ error: 'sin_permiso', mensaje: 'No tienes permiso' }, 403))
    const { sala } = await abrir()
    await expect(sala.mediosDePago(['efectivo'])).rejects.toMatchObject({ codigo: 'sin_permiso' })
    await expect(sala.propinaSugerida(500)).rejects.toMatchObject({ codigo: 'sin_permiso' })
    await expect(sala.configuracionCaja()).rejects.toMatchObject({ codigo: 'sin_permiso' })
    hubFalso(() =>
      json({ error: 'datos_invalidos', mensaje: 'Ya hay un datáfono con ese nombre' }, 400),
    )
    const otra = await abrir()
    await expect(
      otra.sala.guardarDatafono({ nombre: 'Bold 1', proveedor: 'bold', activo: true }),
    ).rejects.toMatchObject({
      codigo: 'datos_invalidos',
      message: 'Ya hay un datáfono con ese nombre',
    })
  })

  it('una sesión inválida cierra la sesión del equipo', async () => {
    hubFalso(() => json({ error: 'sesion_invalida', mensaje: 'Vuelve a entrar' }, 401))
    const { sala } = await abrir()
    await expect(sala.configuracionCaja()).rejects.toMatchObject({ codigo: 'sesion_invalida' })
    expect(sala.instantanea().sesion).toBeNull()
  })

  it('sin conexión con la caja, todos fallan con sin_conexion y no llaman al hub', async () => {
    const llamadas = hubFalso()
    const { sala } = await abrir(true)
    const antes = llamadas.length
    for (const f of [
      () => sala.configuracionCaja(),
      () => sala.mediosDePago(['efectivo']),
      () => sala.propinaSugerida(0),
      () => sala.impresoraPrecuenta(null),
      () => sala.guardarDatafono({ nombre: 'B', proveedor: 'otro', activo: true }),
      () => sala.guardarMedioPropio({ nombre: 'S', activo: true }),
    ])
      await expect(f()).rejects.toMatchObject({ codigo: 'sin_conexion' })
    expect(llamadas.length).toBe(antes)
  })

  it('sin sesión fallan sin llamar al hub', async () => {
    const llamadas = hubFalso()
    const { sala } = await abrir()
    await sala.salir()
    const antes = llamadas.length
    await expect(sala.configuracionCaja()).rejects.toThrow(/Sin sesión/)
    expect(llamadas.length).toBe(antes)
  })
})

describe('Sala.abrirTurno', () => {
  it('guarda un TurnoAbierto firmado, del agregado turno_caja, con la caja de este equipo y la base', async () => {
    hubFalso()
    const { sala, sesion: s } = await abrir(true)
    const turnoId = await sala.abrirTurno(200_000)
    const guardados = await locales(sala)
    expect(guardados).toHaveLength(1)
    const [l] = guardados
    const e = l?.evento as EventoNuevo
    expect(l?.estado).toBe('pendiente')
    expect(e).toMatchObject({
      tipo: 'TurnoAbierto',
      agregado_tipo: 'turno_caja',
      agregado_id: turnoId,
      datos: { caja_id: equipo.dispositivoId, base: 200_000 },
      dispositivo_id: equipo.dispositivoId,
      usuario_id: s.usuario.id,
      sesion_id: s.sesionId,
      relacionados: [],
    })
    const { firma, ...sinFirma } = e
    expect(firma).toBe(firmarEvento(sinFirma as EventoNuevo, 'secreto-carlos'))
    expect(validarEventoNuevo(e).ok).toBe(true)
  })

  it('el turno se ve en la proyección (por confirmar) antes de que el hub responda', async () => {
    hubFalso()
    const { sala } = await abrir(true)
    const turnoId = await sala.abrirTurno(50_000)
    expect(turnoDeCaja(await locales(sala), equipo.dispositivoId)).toMatchObject({
      id: turnoId,
      base: 50_000,
      porConfirmar: true,
    })
  })

  it('una base de $0 es válida; una negativa o con decimales no se guarda', async () => {
    hubFalso()
    const { sala } = await abrir(true)
    await expect(sala.abrirTurno(0)).resolves.toBeTruthy()
    await expect(sala.abrirTurno(-1)).rejects.toThrow(/Evento inválido/)
    await expect(sala.abrirTurno(10.5)).rejects.toThrow(/Evento inválido/)
    expect(await locales(sala)).toHaveLength(1)
  })

  it('sin sesión no abre turno', async () => {
    hubFalso()
    const { sala } = await abrir(true)
    await sala.salir()
    await expect(sala.abrirTurno(1_000)).rejects.toThrow(/Sin sesión/)
  })

  it('cada llamada es un turno nuevo con su propio id', async () => {
    hubFalso()
    const { sala } = await abrir(true)
    const a = await sala.abrirTurno(1)
    const b = await sala.abrirTurno(2)
    expect(a).not.toBe(b)
  })
})
