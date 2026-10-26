import { configCompleta, nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { insertarVersionado, SISTEMA } from '../acceso/registros'
import { leerCatalogo } from '../catalogo'
import { type Equipo, montarImpresion } from './montaje-impresion'

// Las rutas de la tarea 1.6: `/api/caja/precuenta`, `/api/caja/configuracion`, `/api/caja/medios`,
// `/api/caja/propina` y `/api/datafonos`, y lo que la carta dice del cobro. Todas piden un equipo
// con token y una sesión con `administrar_dispositivos`.

type Json = Record<string, unknown>

function mundo() {
  const t = montarImpresion()
  const admin = t.equipo('admin', 'caja')
  const cajero = t.equipo('cajero', 'caja')
  const gerente = t.equipo('gerente', 'caja')
  const mesero = t.equipo('mesero')
  const llamar = (e: Equipo, url: string, extra: Json = {}) =>
    t.post(url, { ...e.cuerpoSesion, ...extra }, e.token)
  const catalogo = () => leerCatalogo(t.db, t.restauranteId)
  const configGuardada = () =>
    configCompleta(
      JSON.parse(
        String(
          t.db.prepare('SELECT config FROM restaurante WHERE id = ?').get(t.restauranteId)?.config,
        ),
      ),
    )
  const precuenta = (impresora_id: unknown, e: Equipo = admin) =>
    llamar(e, '/api/caja/precuenta', { impresora_id })
  const medios = (m: unknown, e: Equipo = admin) => llamar(e, '/api/caja/medios', { medios: m })
  const propina = (puntos: unknown, e: Equipo = admin) => llamar(e, '/api/caja/propina', { puntos })
  const datafono = (d: Json, e: Equipo = admin) => llamar(e, '/api/datafonos', { datafono: d })
  const ajustes = async (e: Equipo = admin) =>
    (await llamar(e, '/api/caja/configuracion')).json() as {
      medios_pago: string[]
      propina_sugerida: number
      datafonos: { id: string; nombre: string; proveedor: string; activo: boolean }[]
    }
  /** Un restaurante ajeno en la misma base, con una impresora y un datáfono suyos. */
  const ajeno = () => {
    const otro = nuevoId()
    t.db
      .prepare(
        `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
         VALUES (?, ?, ?, ?, 1, 'Otro restaurante', '{}')`,
      )
      .run(otro, otro, new Date(t.reloj()).toISOString(), new Date(t.reloj()).toISOString())
    t.db
      .prepare("INSERT INTO contador (restaurante_id, nombre, valor) VALUES (?, 'catalogo', 1)")
      .run(otro)
    const impresora = insertarVersionado(
      t.db,
      'impresora',
      otro,
      { nombre: 'Barra ajena', conexion: 'red', direccion: '10.9.9.9', puerto: 9100, ancho: 80 },
      SISTEMA,
      new Date(t.reloj()).toISOString(),
    )
    const datafonoId = insertarVersionado(
      t.db,
      'datafono',
      otro,
      { nombre: 'Bold ajeno', proveedor: 'bold' },
      SISTEMA,
      new Date(t.reloj()).toISOString(),
    )
    return { otro, impresora, datafonoId }
  }
  return {
    t,
    admin,
    cajero,
    gerente,
    mesero,
    llamar,
    catalogo,
    configGuardada,
    precuenta,
    medios,
    propina,
    datafono,
    ajustes,
    ajeno,
  }
}

type Mundo = ReturnType<typeof mundo>

describe('permisos: las cinco rutas piden administrar_dispositivos', () => {
  const rutas: [string, (m: Mundo, e: Equipo) => Promise<{ statusCode: number }>][] = [
    ['/api/caja/precuenta', (m, e) => m.precuenta(null, e)],
    ['/api/caja/configuracion', (m, e) => m.llamar(e, '/api/caja/configuracion')],
    ['/api/caja/medios', (m, e) => m.medios(['efectivo', 'nequi'], e)],
    ['/api/caja/propina', (m, e) => m.propina(500, e)],
    [
      '/api/datafonos',
      (m, e) => m.datafono({ nombre: 'Nuevo', proveedor: 'otro', activo: true }, e),
    ],
  ]
  /** El resto del cuerpo que cada ruta espera, para probar la sesión con datos válidos. */
  const CUERPO: Record<string, Json> = {
    '/api/caja/precuenta': { impresora_id: null },
    '/api/caja/configuracion': {},
    '/api/caja/medios': { medios: ['efectivo'] },
    '/api/caja/propina': { puntos: 500 },
    '/api/caja/medios-propios': { medio: { nombre: 'Sodexo', activo: true } },
    '/api/datafonos': { datafono: { nombre: 'Nuevo', proveedor: 'otro', activo: true } },
  }

  it.each(rutas)('%s: sin token responde 401, aunque el cuerpo sea basura', async (url) => {
    const m = mundo()
    for (const cuerpo of [{}, 'texto', [1], { medios: 1 }]) {
      const r = await m.t.post(url, cuerpo)
      expect(r.statusCode).toBe(401)
      expect(r.json()).toMatchObject({ error: 'token_invalido' })
    }
  })

  it.each(rutas)('%s: un token inventado, 401', async (url) => {
    const m = mundo()
    const r = await m.t.post(url, { ...m.admin.cuerpoSesion, ...CUERPO[url] }, 'inventado')
    expect(r.statusCode).toBe(401)
  })

  it.each(rutas)('%s: sesión inventada o con otro secreto, 401', async (url) => {
    const m = mundo()
    for (const sesion of [
      { sesion_id: '01JB0000000000000000000000', secreto: 'inventado' },
      { sesion_id: m.admin.cuerpoSesion.sesion_id, secreto: 'otro-secreto' },
    ]) {
      const r = await m.t.post(url, { ...sesion, ...CUERPO[url] }, m.admin.token)
      expect(r.statusCode).toBe(401)
      expect(r.json()).toMatchObject({ error: 'sesion_invalida' })
    }
  })

  it.each(rutas)('%s: la sesión de otro equipo no sirve', async (url, llamar) => {
    const m = mundo()
    const r = await m.t.post(url, { ...m.admin.cuerpoSesion, ...CUERPO[url] }, m.mesero.token)
    expect(r.statusCode).toBe(401)
    expect(llamar).toBeTypeOf('function')
  })

  it.each(rutas)('%s: sin los datos de la sesión, 400', async (url) => {
    const m = mundo()
    const { sesion_id: _s, secreto: _x, ...sinSesion } = { ...m.admin.cuerpoSesion, ...CUERPO[url] }
    const r = await m.t.post(url, sinSesion, m.admin.token)
    expect(r.statusCode).toBe(400)
  })

  it.each(rutas)(
    '%s: cajero, gerente y mesero responden 403 y no cambian nada',
    async (url, llamar) => {
      for (const quien of ['cajero', 'gerente', 'mesero'] as const) {
        const m = mundo()
        const antes = m.catalogo().version
        const r = await llamar(m, m[quien])
        expect(r.statusCode, `${url} · ${quien}`).toBe(403)
        expect(m.catalogo().version).toBe(antes)
        expect(m.t.cambiosCatalogo).toEqual([])
        expect(m.configGuardada().medios_pago).toEqual(configCompleta().medios_pago)
      }
    },
  )

  it.each(rutas)('%s: una sesión cerrada, 401', async (url, llamar) => {
    const m = mundo()
    await m.t.post('/api/sesiones/cerrar', m.admin.cuerpoSesion, m.admin.token)
    expect((await llamar(m, m.admin)).statusCode, url).toBe(401)
  })

  it('un equipo retirado pierde el acceso a las rutas de caja', async () => {
    const m = mundo()
    await m.t.post(
      `/api/dispositivos/${m.mesero.conexion.dispositivoId}/revocar`,
      m.admin.cuerpoSesion,
      m.admin.token,
    )
    expect((await m.medios(['efectivo'], m.mesero)).statusCode).toBe(401)
  })
})

describe('POST /api/caja/precuenta', () => {
  const nuevaImpresora = (m: Mundo, extra: Record<string, string | number> = {}) =>
    m.t.impresoraNueva('Caja', [m.t.cocina], extra)

  it('de fábrica no hay impresora de precuentas y la carta dice que no se imprime', () => {
    const m = mundo()
    expect(m.configGuardada().impresora_precuenta_id).toBeNull()
    expect(m.catalogo().restaurante.cobro?.imprimePrecuenta).toBe(false)
  })

  it('elegir una impresora activa: 204, la guarda, avisa y la carta dice que se imprime', async () => {
    const m = mundo()
    const { id } = nuevaImpresora(m)
    const antes = m.catalogo().version
    const r = await m.precuenta(id)
    expect(r.statusCode).toBe(204)
    expect(r.body).toBe('')
    expect(m.configGuardada().impresora_precuenta_id).toBe(id)
    expect(m.catalogo().restaurante.cobro?.imprimePrecuenta).toBe(true)
    expect(m.catalogo().version).toBeGreaterThan(antes)
    expect(m.t.cambiosCatalogo).toEqual([m.catalogo().version])
  })

  it('el cambio queda a nombre de quien lo hizo', async () => {
    const m = mundo()
    await m.precuenta(nuevaImpresora(m).id)
    const fila = m.t.db
      .prepare('SELECT usuario_id, dispositivo_id FROM restaurante WHERE id = ?')
      .get(m.t.restauranteId)
    expect(fila).toEqual({
      usuario_id: m.t.personas.admin.usuarioId,
      dispositivo_id: m.admin.conexion.dispositivoId,
    })
  })

  it('quitarla (null) la deja sin impresora y repetirlo no sube la versión', async () => {
    const m = mundo()
    await m.precuenta(nuevaImpresora(m).id)
    expect((await m.precuenta(null)).statusCode).toBe(204)
    expect(m.configGuardada().impresora_precuenta_id).toBeNull()
    expect(m.catalogo().restaurante.cobro?.imprimePrecuenta).toBe(false)
    const v = m.catalogo().version
    expect((await m.precuenta(null)).statusCode).toBe(204)
    expect(m.catalogo().version).toBe(v)
  })

  it('elegir la misma impresora otra vez no sube la versión ni avisa', async () => {
    const m = mundo()
    const { id } = nuevaImpresora(m)
    await m.precuenta(id)
    const v = m.catalogo().version
    const avisos = m.t.cambiosCatalogo.length
    await m.precuenta(id)
    expect(m.catalogo().version).toBe(v)
    expect(m.t.cambiosCatalogo).toHaveLength(avisos)
  })

  it('una impresora archivada se rechaza con 400', async () => {
    const m = mundo()
    const { id } = nuevaImpresora(m, { activo: 0 })
    const r = await m.precuenta(id)
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({
      error: 'datos_invalidos',
      mensaje: 'Esa impresora no existe o está archivada',
    })
    expect(m.configGuardada().impresora_precuenta_id).toBeNull()
  })

  it('una impresora que no existe se rechaza con 400', async () => {
    const m = mundo()
    expect((await m.precuenta(nuevoId())).statusCode).toBe(400)
    expect(m.configGuardada().impresora_precuenta_id).toBeNull()
  })

  it('la impresora de OTRO restaurante se rechaza con 400', async () => {
    const m = mundo()
    const { impresora } = m.ajeno()
    const r = await m.precuenta(impresora)
    expect(r.statusCode).toBe(400)
    expect(m.configGuardada().impresora_precuenta_id).toBeNull()
  })

  it.each([
    ['texto corto', 'abc'],
    ['cadena vacía', ''],
    ['número', 7],
    ['objeto', {}],
    ['arreglo', [nuevoId()]],
    ['id de 27 caracteres', `${nuevoId()}X`],
  ])('rechaza impresora_id = %s con 400', async (_, valor) => {
    const m = mundo()
    expect((await m.precuenta(valor)).statusCode).toBe(400)
  })

  it('sin impresora_id y con campos de más, 400', async () => {
    const m = mundo()
    expect((await m.llamar(m.admin, '/api/caja/precuenta', {})).statusCode).toBe(400)
    expect(
      (await m.llamar(m.admin, '/api/caja/precuenta', { impresora_id: null, otro: 1 })).statusCode,
    ).toBe(400)
  })

  it('archivar la impresora elegida apaga la impresión; volver a activarla la prende', async () => {
    const m = mundo()
    const { id } = nuevaImpresora(m)
    await m.precuenta(id)
    expect(m.catalogo().restaurante.cobro?.imprimePrecuenta).toBe(true)
    m.t.db.prepare('UPDATE impresora SET activo = 0 WHERE id = ?').run(id)
    expect(m.catalogo().restaurante.cobro?.imprimePrecuenta).toBe(false)
    // La elección no se pierde: sigue guardada en la configuración.
    expect(m.configGuardada().impresora_precuenta_id).toBe(id)
    m.t.db.prepare('UPDATE impresora SET activo = 1 WHERE id = ?').run(id)
    expect(m.catalogo().restaurante.cobro?.imprimePrecuenta).toBe(true)
  })

  it('la pantalla «Cocina e impresoras» devuelve la impresora de precuentas elegida', async () => {
    const m = mundo()
    const { id } = nuevaImpresora(m)
    await m.precuenta(id)
    const r = await m.llamar(m.admin, '/api/cocina/configuracion')
    expect(r.json()).toMatchObject({ impresora_precuenta_id: id })
  })
})

describe('catálogo: restaurante.cobro y datafonos', () => {
  it('trae los valores de fábrica del cobro', () => {
    const { catalogo } = mundo()
    expect(catalogo().restaurante.cobro).toEqual({
      mediosPago: ['efectivo', 'tarjeta', 'nequi', 'daviplata', 'breb', 'transferencia'],
      mediosPropios: [],
      propinaSugerida: 1000,
      redondeoModo: 'mitad_arriba',
      redondeoEfectivo: 100,
      redondeoEfectivoModo: 'cercano_mitad_abajo',
      imprimePrecuenta: false,
    })
    expect(catalogo().datafonos).toEqual([])
  })

  it('refleja la configuración guardada del restaurante', () => {
    const m = mundo()
    m.t.db.prepare('UPDATE restaurante SET config = ? WHERE id = ?').run(
      JSON.stringify({
        medios_pago: ['nequi', 'efectivo'],
        propina_sugerida: 700,
        redondeo_modo: 'mitad_par',
        redondeo_efectivo: 50,
        redondeo_efectivo_modo: 'arriba',
      }),
      m.t.restauranteId,
    )
    expect(m.catalogo().restaurante.cobro).toMatchObject({
      mediosPago: ['nequi', 'efectivo'],
      propinaSugerida: 700,
      redondeoModo: 'mitad_par',
      redondeoEfectivo: 50,
      redondeoEfectivoModo: 'arriba',
    })
  })

  it('una configuración vieja, sin los campos nuevos, toma los valores de fábrica', () => {
    const m = mundo()
    m.t.db.prepare("UPDATE restaurante SET config = '{}' WHERE id = ?").run(m.t.restauranteId)
    expect(m.catalogo().restaurante.cobro?.mediosPago).toEqual(configCompleta().medios_pago)
    expect(m.catalogo().restaurante.cobro?.imprimePrecuenta).toBe(false)
  })

  it('imprimePrecuenta es falso si la impresora elegida es de otro restaurante', () => {
    const m = mundo()
    const { impresora } = m.ajeno()
    m.t.db
      .prepare('UPDATE restaurante SET config = ? WHERE id = ?')
      .run(JSON.stringify({ impresora_precuenta_id: impresora }), m.t.restauranteId)
    expect(m.catalogo().restaurante.cobro?.imprimePrecuenta).toBe(false)
  })

  it('imprimePrecuenta es falso si la impresora elegida ya no existe', () => {
    const m = mundo()
    m.t.db
      .prepare('UPDATE restaurante SET config = ? WHERE id = ?')
      .run(JSON.stringify({ impresora_precuenta_id: nuevoId() }), m.t.restauranteId)
    expect(m.catalogo().restaurante.cobro?.imprimePrecuenta).toBe(false)
  })

  it('los datáfonos: solo los activos de este restaurante, por nombre', async () => {
    const m = mundo()
    const ajeno = m.ajeno()
    await m.datafono({ nombre: 'Bold 2', proveedor: 'bold', activo: true })
    await m.datafono({ nombre: 'Bold 1', proveedor: 'bold', activo: true })
    const archivado = (
      await m.datafono({ nombre: 'Viejo', proveedor: 'redeban', activo: true })
    ).json() as { id: string }
    await m.datafono({ id: archivado.id, nombre: 'Viejo', proveedor: 'redeban', activo: false })
    expect(m.catalogo().datafonos?.map((d) => d.nombre)).toEqual(['Bold 1', 'Bold 2'])
    expect(m.catalogo().datafonos?.map((d) => d.id)).not.toContain(ajeno.datafonoId)
    // El catálogo dice id, nombre y proveedor: los de un mismo proveedor tienen un solo cierre, así
    // que al cobrar solo se elige el proveedor si hay varios.
    for (const d of m.catalogo().datafonos ?? [])
      expect(Object.keys(d).sort()).toEqual(['id', 'nombre', 'proveedor'])
  })
})

describe('POST /api/caja/medios', () => {
  it('de fábrica: efectivo, tarjeta, Nequi, Daviplata, Bre-B y transferencia, en ese orden', async () => {
    const m = mundo()
    expect((await m.ajustes()).medios_pago).toEqual([
      'efectivo',
      'tarjeta',
      'nequi',
      'daviplata',
      'breb',
      'transferencia',
    ])
  })

  it('guarda los medios en el orden elegido, avisa y la carta los trae', async () => {
    const m = mundo()
    const antes = m.catalogo().version
    const r = await m.medios(['nequi', 'efectivo', 'tarjeta'])
    expect(r.statusCode).toBe(204)
    expect((await m.ajustes()).medios_pago).toEqual(['nequi', 'efectivo', 'tarjeta'])
    expect(m.catalogo().restaurante.cobro?.mediosPago).toEqual(['nequi', 'efectivo', 'tarjeta'])
    expect(m.catalogo().version).toBeGreaterThan(antes)
    expect(m.t.cambiosCatalogo).toEqual([m.catalogo().version])
  })

  it('solo efectivo es válido; el bono se puede agregar', async () => {
    const m = mundo()
    expect((await m.medios(['efectivo'])).statusCode).toBe(204)
    expect((await m.medios(['efectivo', 'bono'])).statusCode).toBe(204)
    expect(m.configGuardada().medios_pago).toEqual(['efectivo', 'bono'])
  })

  it('los repetidos se quitan y se queda el primero', async () => {
    const m = mundo()
    expect((await m.medios(['tarjeta', 'efectivo', 'tarjeta', 'efectivo'])).statusCode).toBe(204)
    expect(m.configGuardada().medios_pago).toEqual(['tarjeta', 'efectivo'])
  })

  it('sin efectivo se rechaza con 400 y el mensaje lo explica', async () => {
    const m = mundo()
    const antes = m.catalogo().version
    const r = await m.medios(['tarjeta', 'nequi'])
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ mensaje: 'El efectivo siempre se recibe' })
    expect(m.configGuardada().medios_pago).toEqual(configCompleta().medios_pago)
    expect(m.catalogo().version).toBe(antes)
  })

  it.each([
    ['lista vacía', []],
    ['un medio que no existe', ['efectivo', 'cheque']],
    ['mayúsculas', ['Efectivo']],
    ['no es lista', 'efectivo'],
    ['null', null],
    ['elemento no texto', ['efectivo', 3]],
    ['más de diez', Array(11).fill('efectivo')],
  ])('rechaza medios = %s con 400', async (_, valor) => {
    const m = mundo()
    expect((await m.medios(valor)).statusCode).toBe(400)
    expect(m.configGuardada().medios_pago).toEqual(configCompleta().medios_pago)
  })

  it('sin medios y con campos de más, 400', async () => {
    const m = mundo()
    expect((await m.llamar(m.admin, '/api/caja/medios', {})).statusCode).toBe(400)
    expect(
      (await m.llamar(m.admin, '/api/caja/medios', { medios: ['efectivo'], x: 1 })).statusCode,
    ).toBe(400)
  })

  it('repetir la misma lista no sube la versión ni avisa', async () => {
    const m = mundo()
    await m.medios(['efectivo', 'tarjeta'])
    const v = m.catalogo().version
    const avisos = m.t.cambiosCatalogo.length
    expect((await m.medios(['efectivo', 'tarjeta'])).statusCode).toBe(204)
    expect(m.catalogo().version).toBe(v)
    expect(m.t.cambiosCatalogo).toHaveLength(avisos)
  })

  it('cambiar solo el orden sí es un cambio', async () => {
    const m = mundo()
    await m.medios(['efectivo', 'tarjeta'])
    const v = m.catalogo().version
    await m.medios(['tarjeta', 'efectivo'])
    expect(m.catalogo().version).toBeGreaterThan(v)
  })

  it('no toca el resto de la configuración del restaurante', async () => {
    const m = mundo()
    const antes = { ...m.configGuardada(), medios_pago: undefined }
    await m.medios(['efectivo', 'nequi'])
    expect({ ...m.configGuardada(), medios_pago: undefined }).toEqual(antes)
  })
})

describe('POST /api/caja/propina', () => {
  it.each([0, 1, 500, 750, 1000])('guarda %i puntos básicos', async (puntos) => {
    const m = mundo()
    expect((await m.propina(puntos)).statusCode).toBe(204)
    expect(m.configGuardada().propina_sugerida).toBe(puntos)
    expect(m.catalogo().restaurante.cobro?.propinaSugerida).toBe(puntos)
    expect((await m.ajustes()).propina_sugerida).toBe(puntos)
  })

  it.each([
    ['negativo', -1],
    ['sobre el tope legal del 10 %', 1001],
    ['con decimales', 10.5],
    ['texto', '1000'],
    ['null', null],
    ['NaN como texto', 'NaN'],
  ])('rechaza %s con 400 y el mensaje explica el rango', async (_, puntos) => {
    const m = mundo()
    const r = await m.propina(puntos)
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ mensaje: 'La propina sugerida va de 0 % a 10 %' })
    expect(m.configGuardada().propina_sugerida).toBe(1000)
  })

  it('el mismo valor no sube la versión', async () => {
    const m = mundo()
    const v = m.catalogo().version
    await m.propina(1000)
    expect(m.catalogo().version).toBe(v)
  })
})

describe('POST /api/caja/configuracion', () => {
  it('devuelve los medios, la propina sugerida y los datáfonos (activos primero)', async () => {
    const m = mundo()
    const a = (await m.datafono({ nombre: 'Zeta', proveedor: 'otro', activo: true })).json() as {
      id: string
    }
    await m.datafono({ nombre: 'Bold 1', proveedor: 'bold', activo: true })
    await m.datafono({ id: a.id, nombre: 'Zeta', proveedor: 'otro', activo: false })
    const r = await m.ajustes()
    expect(r.medios_pago).toEqual(configCompleta().medios_pago)
    expect(r.propina_sugerida).toBe(1000)
    expect(r.datafonos.map((d) => [d.nombre, d.proveedor, d.activo])).toEqual([
      ['Bold 1', 'bold', true],
      ['Zeta', 'otro', false],
    ])
  })

  it('no muestra los datáfonos de otro restaurante', async () => {
    const m = mundo()
    m.ajeno()
    expect((await m.ajustes()).datafonos).toEqual([])
  })

  it('con campos de más, 400', async () => {
    const m = mundo()
    expect((await m.llamar(m.admin, '/api/caja/configuracion', { x: 1 })).statusCode).toBe(400)
  })
})

describe('POST /api/datafonos', () => {
  const bold = { nombre: 'Bold 1', proveedor: 'bold', activo: true }

  it('crea un datáfono: devuelve su id y la lista, queda a nombre de quien lo creó y sube la versión', async () => {
    const m = mundo()
    const antes = m.catalogo().version
    const r = await m.datafono(bold)
    expect(r.statusCode).toBe(200)
    const cuerpo = r.json() as { id: string; datafonos: { id: string; nombre: string }[] }
    expect(cuerpo.datafonos).toEqual([
      { id: cuerpo.id, nombre: 'Bold 1', proveedor: 'bold', activo: true },
    ])
    expect(m.t.db.prepare('SELECT * FROM datafono WHERE id = ?').get(cuerpo.id)).toMatchObject({
      usuario_id: m.t.personas.admin.usuarioId,
      dispositivo_id: m.admin.conexion.dispositivoId,
      activo: 1,
    })
    expect(m.catalogo().version).toBeGreaterThan(antes)
    expect(m.t.cambiosCatalogo).toEqual([m.catalogo().version])
    expect(m.catalogo().datafonos).toEqual([{ id: cuerpo.id, nombre: 'Bold 1', proveedor: 'bold' }])
  })

  it.each(['bold', 'redeban', 'credibanco', 'otro'])(
    'acepta el proveedor %s',
    async (proveedor) => {
      const m = mundo()
      expect((await m.datafono({ ...bold, proveedor })).statusCode).toBe(200)
    },
  )

  it('el nombre se recorta, y a 60 caracteres pasa pero a 61 no', async () => {
    const m = mundo()
    const r = await m.datafono({ ...bold, nombre: '   Bold   ' })
    expect((r.json() as { datafonos: { nombre: string }[] }).datafonos[0]?.nombre).toBe('Bold')
    expect((await m.datafono({ ...bold, nombre: 'x'.repeat(60) })).statusCode).toBe(200)
    expect((await m.datafono({ ...bold, nombre: 'y'.repeat(61) })).statusCode).toBe(400)
  })

  it.each([
    ['nombre vacío', { nombre: '' }],
    ['nombre de espacios', { nombre: '    ' }],
    ['nombre que no es texto', { nombre: 5 }],
    ['sin nombre', { nombre: undefined }],
    ['proveedor desconocido', { proveedor: 'visa' }],
    ['proveedor en mayúsculas', { proveedor: 'BOLD' }],
    ['sin proveedor', { proveedor: undefined }],
    ['activo como texto', { activo: 'true' }],
    ['sin activo', { activo: undefined }],
    ['id que no es ULID', { id: 'abc' }],
    ['campo de más', { color: 'rojo' }],
  ])('rechaza %s con 400 y no crea nada', async (_, cambio) => {
    const m = mundo()
    const r = await m.datafono({ ...bold, ...cambio })
    expect(r.statusCode).toBe(400)
    expect((await m.ajustes()).datafonos).toEqual([])
  })

  it('sin el objeto datafono, 400', async () => {
    const m = mundo()
    expect((await m.llamar(m.admin, '/api/datafonos', {})).statusCode).toBe(400)
    expect((await m.llamar(m.admin, '/api/datafonos', { datafono: null })).statusCode).toBe(400)
  })

  it('nombre repetido entre activos: 400, sin importar mayúsculas ni tildes de más', async () => {
    const m = mundo()
    await m.datafono(bold)
    for (const nombre of ['Bold 1', 'bold 1', 'BOLD 1']) {
      const r = await m.datafono({ ...bold, nombre })
      expect(r.statusCode, nombre).toBe(400)
      expect(r.json()).toMatchObject({ mensaje: 'Ya hay un datáfono con ese nombre' })
    }
    expect((await m.ajustes()).datafonos).toHaveLength(1)
  })

  it('dos nombres distintos conviven, y el mismo nombre en otro restaurante no cuenta', async () => {
    const m = mundo()
    m.ajeno()
    expect((await m.datafono({ ...bold, nombre: 'Bold bar' })).statusCode).toBe(200)
    expect((await m.datafono({ ...bold, nombre: 'Bold ajeno' })).statusCode).toBe(200)
    expect((await m.ajustes()).datafonos).toHaveLength(2)
  })

  it('renombrar y guardar el mismo nombre del propio datáfono no cuenta como repetido', async () => {
    const m = mundo()
    const { id } = (await m.datafono(bold)).json() as { id: string }
    expect((await m.datafono({ ...bold, id })).statusCode).toBe(200)
    const r = await m.datafono({ ...bold, id, nombre: 'Bold barra' })
    expect(r.statusCode).toBe(200)
    expect((await m.ajustes()).datafonos.map((d) => d.nombre)).toEqual(['Bold barra'])
  })

  it('renombrar a un nombre que ya tiene otro activo, 400', async () => {
    const m = mundo()
    await m.datafono(bold)
    const { id } = (await m.datafono({ ...bold, nombre: 'Bold 2' })).json() as { id: string }
    const r = await m.datafono({ ...bold, id, nombre: 'bold 1' })
    expect(r.statusCode).toBe(400)
    expect((await m.ajustes()).datafonos.map((d) => d.nombre).sort()).toEqual(['Bold 1', 'Bold 2'])
  })

  it('editar sube la versión del datáfono y del contador; el id y la fecha de creación no cambian', async () => {
    const m = mundo()
    const { id } = (await m.datafono(bold)).json() as { id: string }
    const antes = m.t.db.prepare('SELECT * FROM datafono WHERE id = ?').get(id)
    m.t.avanzar(5000)
    await m.datafono({ ...bold, id, nombre: 'Bold terraza', proveedor: 'redeban' })
    const despues = m.t.db.prepare('SELECT * FROM datafono WHERE id = ?').get(id)
    expect(despues).toMatchObject({ nombre: 'Bold terraza', proveedor: 'redeban', id })
    expect(Number(despues?.version)).toBeGreaterThan(Number(antes?.version))
    expect(despues?.creado_en).toBe(antes?.creado_en)
    expect(despues?.actualizado_en).not.toBe(antes?.actualizado_en)
  })

  it('archivar: activo false lo saca de la carta pero queda en la lista de caja, y no se borra', async () => {
    const m = mundo()
    const { id } = (await m.datafono(bold)).json() as { id: string }
    const r = await m.datafono({ ...bold, id, activo: false })
    expect(r.statusCode).toBe(200)
    expect((await m.ajustes()).datafonos).toEqual([
      { id, nombre: 'Bold 1', proveedor: 'bold', activo: false },
    ])
    expect(m.catalogo().datafonos).toEqual([])
    expect(Number(m.t.db.prepare('SELECT count(*) AS n FROM datafono').get()?.n)).toBe(1)
  })

  it('volver a usar un archivado: activo true lo devuelve a la carta', async () => {
    const m = mundo()
    const { id } = (await m.datafono(bold)).json() as { id: string }
    await m.datafono({ ...bold, id, activo: false })
    const r = await m.datafono({ ...bold, id, activo: true })
    expect(r.statusCode).toBe(200)
    expect(m.catalogo().datafonos).toEqual([{ id, nombre: 'Bold 1', proveedor: 'bold' }])
  })

  it('un archivado no estorba el nombre: se puede crear otro con el mismo', async () => {
    const m = mundo()
    const { id } = (await m.datafono(bold)).json() as { id: string }
    await m.datafono({ ...bold, id, activo: false })
    expect((await m.datafono(bold)).statusCode).toBe(200)
  })

  it('pero reactivar el archivado cuando ya hay otro activo con ese nombre, 400', async () => {
    const m = mundo()
    const { id } = (await m.datafono(bold)).json() as { id: string }
    await m.datafono({ ...bold, id, activo: false })
    await m.datafono(bold)
    const r = await m.datafono({ ...bold, id, activo: true })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ mensaje: 'Ya hay un datáfono con ese nombre' })
    expect((await m.ajustes()).datafonos.filter((d) => d.activo)).toHaveLength(1)
  })

  it('renombrar un archivado a un nombre en uso se permite mientras siga archivado', async () => {
    const m = mundo()
    await m.datafono(bold)
    const { id } = (await m.datafono({ ...bold, nombre: 'Bold 2' })).json() as { id: string }
    await m.datafono({ ...bold, nombre: 'Bold 2', id, activo: false })
    expect((await m.datafono({ ...bold, id, nombre: 'Bold 1', activo: false })).statusCode).toBe(
      200,
    )
  })

  it('un id que no existe, 400 y no crea nada', async () => {
    const m = mundo()
    const r = await m.datafono({ ...bold, id: nuevoId() })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ mensaje: 'Ese datáfono no existe' })
    expect((await m.ajustes()).datafonos).toEqual([])
  })

  it('el id de un datáfono de OTRO restaurante, 400, y el ajeno queda intacto', async () => {
    const m = mundo()
    const ajeno = m.ajeno()
    const antes = m.t.db.prepare('SELECT * FROM datafono WHERE id = ?').get(ajeno.datafonoId)
    const r = await m.datafono({ ...bold, id: ajeno.datafonoId, nombre: 'Robado' })
    expect(r.statusCode).toBe(400)
    expect(m.t.db.prepare('SELECT * FROM datafono WHERE id = ?').get(ajeno.datafonoId)).toEqual(
      antes,
    )
    expect((await m.ajustes()).datafonos).toEqual([])
  })

  it('un rechazo no sube la versión del catálogo ni avisa a los equipos', async () => {
    const m = mundo()
    await m.datafono(bold)
    const v = m.catalogo().version
    const avisos = m.t.cambiosCatalogo.length
    await m.datafono(bold)
    await m.datafono({ ...bold, id: nuevoId() })
    expect(m.catalogo().version).toBe(v)
    expect(m.t.cambiosCatalogo).toHaveLength(avisos)
  })

  it('dos peticiones iguales a la vez no dejan dos datáfonos con el mismo nombre', async () => {
    const m = mundo()
    const [a, b] = await Promise.all([m.datafono(bold), m.datafono(bold)])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400])
    expect((await m.ajustes()).datafonos).toHaveLength(1)
  })
})

describe('POST /api/caja/medios-propios', () => {
  type Respuesta = { id: string; medios_propios: { id: string; nombre: string; activo: boolean }[] }
  const guardar = (m: Mundo, medio: Json, e: Equipo = m.admin) =>
    m.llamar(e, '/api/caja/medios-propios', { medio })

  it('crea un medio: devuelve su id y la lista, queda en la configuración y en la carta', async () => {
    const m = mundo()
    const antes = m.catalogo().version
    const r = await guardar(m, { nombre: 'Sodexo', activo: true })
    expect(r.statusCode).toBe(200)
    const cuerpo = r.json() as Respuesta
    expect(cuerpo.medios_propios).toEqual([{ id: cuerpo.id, nombre: 'Sodexo', activo: true }])
    expect(m.configGuardada().medios_propios).toEqual(cuerpo.medios_propios)
    expect(m.catalogo().restaurante.cobro?.mediosPropios).toEqual([
      { id: cuerpo.id, nombre: 'Sodexo' },
    ])
    expect(m.catalogo().version).toBeGreaterThan(antes)
    expect((await m.ajustes()) as unknown).toMatchObject({ medios_propios: cuerpo.medios_propios })
  })

  it('el nombre se recorta; vacío, de espacios o de más de 30 letras, 400', async () => {
    const m = mundo()
    const r = (await guardar(m, { nombre: '  QR  ', activo: true })).json() as Respuesta
    expect(r.medios_propios[0]?.nombre).toBe('QR')
    for (const nombre of ['', '    ', 'x'.repeat(31), 5])
      expect((await guardar(m, { nombre, activo: true })).statusCode, String(nombre)).toBe(400)
    expect((await guardar(m, { nombre: 'x'.repeat(30), activo: true })).statusCode).toBe(200)
  })

  it('campos de más, sin activo o con un id que no es ULID, 400', async () => {
    const m = mundo()
    expect((await guardar(m, { nombre: 'A', activo: true, color: 'r' })).statusCode).toBe(400)
    expect((await guardar(m, { nombre: 'A' })).statusCode).toBe(400)
    expect((await guardar(m, { id: 'abc', nombre: 'A', activo: true })).statusCode).toBe(400)
    expect((await m.llamar(m.admin, '/api/caja/medios-propios', {})).statusCode).toBe(400)
  })

  it('nombre repetido entre activos (sin importar mayúsculas), 400; un archivado no estorba', async () => {
    const m = mundo()
    const a = (await guardar(m, { nombre: 'Sodexo', activo: true })).json() as Respuesta
    const r = await guardar(m, { nombre: 'SODEXO', activo: true })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ mensaje: 'Ya hay un medio con ese nombre' })
    await guardar(m, { id: a.id, nombre: 'Sodexo', activo: false })
    expect((await guardar(m, { nombre: 'Sodexo', activo: true })).statusCode).toBe(200)
    // Reactivar el archivado cuando ya hay uno activo con ese nombre.
    expect((await guardar(m, { id: a.id, nombre: 'Sodexo', activo: true })).statusCode).toBe(400)
  })

  it('renombrar, archivar y volver a usar; el archivado sale de la carta pero queda en la configuración', async () => {
    const m = mundo()
    const a = (await guardar(m, { nombre: 'Sodexo', activo: true })).json() as Respuesta
    await guardar(m, { id: a.id, nombre: 'Sodexo Pass', activo: true })
    expect(m.catalogo().restaurante.cobro?.mediosPropios?.[0]?.nombre).toBe('Sodexo Pass')
    await guardar(m, { id: a.id, nombre: 'Sodexo Pass', activo: false })
    expect(m.catalogo().restaurante.cobro?.mediosPropios).toEqual([])
    expect(m.configGuardada().medios_propios).toEqual([
      { id: a.id, nombre: 'Sodexo Pass', activo: false },
    ])
    await guardar(m, { id: a.id, nombre: 'Sodexo Pass', activo: true })
    expect(m.catalogo().restaurante.cobro?.mediosPropios).toHaveLength(1)
  })

  it('un id que no existe, 400', async () => {
    const m = mundo()
    const r = await guardar(m, { id: nuevoId(), nombre: 'A', activo: true })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ mensaje: 'Ese medio no existe' })
  })

  it('máximo 20 medios propios: el 21 se rechaza', async () => {
    const m = mundo()
    for (let i = 0; i < 20; i++)
      expect((await guardar(m, { nombre: `Medio ${i}`, activo: true })).statusCode).toBe(200)
    const r = await guardar(m, { nombre: 'Uno más', activo: true })
    expect(r.statusCode).toBe(400)
    expect(m.configGuardada().medios_propios).toHaveLength(20)
  })

  it('guardar los mismos datos de un medio existente no sube la versión', async () => {
    const m = mundo()
    const a = (await guardar(m, { nombre: 'Sodexo', activo: true })).json() as Respuesta
    const v = m.catalogo().version
    await guardar(m, { id: a.id, nombre: 'Sodexo', activo: true })
    expect(m.catalogo().version).toBe(v)
  })

  it('cajero, gerente y mesero, 403 y no crean nada', async () => {
    const m = mundo()
    for (const quien of ['cajero', 'gerente', 'mesero'] as const)
      expect((await guardar(m, { nombre: 'A', activo: true }, m[quien])).statusCode).toBe(403)
    expect(m.configGuardada().medios_propios).toEqual([])
  })

  it('los medios propios y los de fábrica conviven: cambiar uno no toca el otro', async () => {
    const m = mundo()
    await guardar(m, { nombre: 'Sodexo', activo: true })
    await m.medios(['efectivo', 'nequi'])
    expect(m.configGuardada().medios_propios).toHaveLength(1)
    await guardar(m, { nombre: 'QR', activo: true })
    expect(m.configGuardada().medios_pago).toEqual(['efectivo', 'nequi'])
  })

  // BUG: `/api/caja/medios` acepta «otro» en el esquema (z.array(MedioPago)) pero `configCompleta`
  // lo rechaza al guardar y la ruta responde 500 en vez de 400.
  // apps/hub/src/impresion/rutas.ts:561 (esquema de `medios` / `actualizarConfig`).
  it('/api/caja/medios rechaza «otro» con 400 (no con un error del servidor)', async () => {
    const m = mundo()
    const r = await m.medios(['efectivo', 'otro'])
    expect(r.statusCode).toBe(400)
    expect(m.configGuardada().medios_pago).not.toContain('otro')
  })
})
