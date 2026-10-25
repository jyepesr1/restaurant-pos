import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { HistorialCatalogo } from './precios'
import { montarServidor } from './pruebas-catalogo'

// La API de edición del catálogo en sus bordes: lotes grandes, enlaces repetidos, archivar y
// reactivar, quién puede editar y qué datos se rechazan.

const producto = (m: Awaited<ReturnType<typeof montarServidor>>, campos = {}) => ({
  categoria_id: m.categoriaId,
  nombre: 'Prosecco de la casa',
  descripcion: null,
  precio: 18_000,
  impuesto_id: m.impuestoId,
  favorito: false,
  activo: true,
  ...campos,
})
const grupo = (campos = {}) => ({ nombre: 'Hielo', minimo: 0, maximo: 1, activo: true, ...campos })
const burrataDe = (m: Awaited<ReturnType<typeof montarServidor>>) => m.producto('Burrata Spritz')

describe('un lote grande', () => {
  it('un producto con variantes y grupos, con 200 cambios en un pedido, se aplica entero', async () => {
    const m = await montarServidor()
    const antes = m.catalogo().version
    const filasAntes = m.historial().length
    const p = nuevoId()
    const g = nuevoId()
    const cambios: unknown[] = [
      { entidad: 'producto', id: p, datos: producto(m) },
      { entidad: 'grupo_modificador', id: g, datos: grupo({ maximo: 5 }) },
      {
        entidad: 'producto_grupo_modificador',
        id: nuevoId(),
        datos: { producto_id: p, grupo_id: g, orden: 0, activo: true },
      },
      {
        entidad: 'variante',
        id: nuevoId(),
        datos: { producto_id: p, nombre: 'Copa', precio: 18_000, orden: 0, activo: true },
      },
      {
        entidad: 'variante',
        id: nuevoId(),
        datos: { producto_id: p, nombre: 'Botella', precio: 95_000, orden: 1, activo: true },
      },
    ]
    for (let i = 0; cambios.length < 200; i++)
      cambios.push({
        entidad: 'modificador',
        id: nuevoId(),
        datos: {
          grupo_id: g,
          nombre: `Opción ${i}`,
          precio_extra: i * 100,
          orden: i,
          activo: true,
        },
      })
    expect(cambios).toHaveLength(200)

    const r = await m.editar(m.sesionDe('gerente'), cambios)
    expect(r.codigo).toBe(200)
    // Cada registro tomó una versión propia y todas quedaron en el historial.
    expect(r.cuerpo.version).toBe(antes + 200)
    expect(m.historial()).toHaveLength(filasAntes + 200)
    expect(m.avisos).toEqual([antes + 200])
    const nuevo = m.productos().find((x) => x.id === p)
    expect(nuevo?.variantes).toHaveLength(2)
    expect(nuevo?.grupos[0]?.opciones).toHaveLength(195)
    // Un solo aviso por pedido, no uno por cambio.
    expect(m.avisos).toHaveLength(1)
  })

  it('201 cambios se rechazan sin aplicar nada', async () => {
    const m = await montarServidor()
    const antes = m.catalogo().version
    const filas = m.historial().length
    const cambios = Array.from({ length: 201 }, (_, i) => ({
      entidad: 'estacion',
      id: nuevoId(),
      datos: { nombre: `E${i}`, orden: i, activo: true },
    }))
    const r = await m.editar(m.sesionDe('gerente'), cambios)
    expect(r.codigo).toBe(400)
    expect(m.catalogo().version).toBe(antes)
    expect(m.historial()).toHaveLength(filas)
    expect(m.avisos).toEqual([])
  })

  it('si falla el cambio 200 de 200, no queda ninguno de los 199 anteriores', async () => {
    const m = await montarServidor()
    const antes = m.catalogo().version
    const filas = m.historial().length
    const cambios: unknown[] = Array.from({ length: 199 }, (_, i) => ({
      entidad: 'estacion',
      id: nuevoId(),
      datos: { nombre: `E${i}`, orden: i, activo: true },
    }))
    cambios.push({ entidad: 'producto', id: nuevoId(), datos: { nombre: 'incompleto' } })
    const r = await m.editar(m.sesionDe('gerente'), cambios)
    expect(r.codigo).toBe(400)
    expect(r.cuerpo.mensaje).toMatch(/Cambio 200/)
    expect(m.catalogo().version).toBe(antes)
    // Ni siquiera el contador de versiones avanzó: la transacción se deshizo completa.
    expect(m.historial()).toHaveLength(filas)
    expect(m.db.prepare("SELECT 1 FROM estacion WHERE nombre = 'E0'").get()).toBeUndefined()
  })
})

describe('el mismo enlace producto-grupo', () => {
  const nuevoEnlace = (p: string, g: string, id = nuevoId()) => ({
    entidad: 'producto_grupo_modificador',
    id,
    datos: { producto_id: p, grupo_id: g, orden: 0, activo: true },
  })

  it('dos veces con ids distintos en el mismo pedido: se rechaza todo', async () => {
    const m = await montarServidor()
    const antes = m.catalogo().version
    const filas = m.historial().length
    const p = nuevoId()
    const g = nuevoId()
    const r = await m.editar(m.sesionDe('gerente'), [
      { entidad: 'producto', id: p, datos: producto(m) },
      { entidad: 'grupo_modificador', id: g, datos: grupo() },
      nuevoEnlace(p, g),
      nuevoEnlace(p, g),
    ])
    expect(r.codigo).toBe(400)
    expect(r.cuerpo.mensaje).toMatch(/Cambio 4/)
    // Ni el producto ni el grupo quedaron a medias.
    expect(m.productos().some((x) => x.id === p)).toBe(false)
    expect(m.catalogo().version).toBe(antes)
    expect(m.historial()).toHaveLength(filas)
  })

  it('dos veces con el mismo id: la segunda actualiza a la primera y queda un solo enlace', async () => {
    const m = await montarServidor()
    const p = nuevoId()
    const g = nuevoId()
    const enlace = nuevoId()
    const r = await m.editar(m.sesionDe('gerente'), [
      { entidad: 'producto', id: p, datos: producto(m) },
      { entidad: 'grupo_modificador', id: g, datos: grupo() },
      nuevoEnlace(p, g, enlace),
      { entidad: 'producto_grupo_modificador', id: enlace, datos: { orden: 3 } },
    ])
    expect(r.codigo).toBe(200)
    const filas = m.db
      .prepare('SELECT orden FROM producto_grupo_modificador WHERE producto_id = ?')
      .all(p)
    expect(filas).toEqual([{ orden: 3 }])
    const historial = m.db
      .prepare('SELECT count(*) AS n FROM catalogo_cambio WHERE registro_id = ?')
      .get(enlace)
    expect(historial?.n).toBe(2)
  })

  it('un enlace ya existente con un id nuevo se rechaza, también si el viejo está archivado', async () => {
    const m = await montarServidor()
    const tagliata = m.producto('Tagliata di Manzo')
    const grupoId = tagliata.grupos[0]?.id as string
    const sesion = m.sesionDe('gerente')
    expect((await m.editar(sesion, [nuevoEnlace(tagliata.id, grupoId)])).codigo).toBe(400)

    const enlace = String(
      m.db
        .prepare('SELECT id FROM producto_grupo_modificador WHERE producto_id = ? AND grupo_id = ?')
        .get(tagliata.id, grupoId)?.id,
    )
    expect(
      (
        await m.editar(sesion, [
          { entidad: 'producto_grupo_modificador', id: enlace, datos: { activo: false } },
        ])
      ).codigo,
    ).toBe(200)
    // Hay que reactivar el enlace archivado, no crear otro.
    expect((await m.editar(sesion, [nuevoEnlace(tagliata.id, grupoId)])).codigo).toBe(400)
    expect(
      (
        await m.editar(sesion, [
          { entidad: 'producto_grupo_modificador', id: enlace, datos: { activo: true } },
        ])
      ).codigo,
    ).toBe(200)
    expect(m.producto('Tagliata di Manzo').grupos).toHaveLength(1)
  })

  it('un enlace a un producto o un grupo que no existe se rechaza', async () => {
    const m = await montarServidor()
    const g = nuevoId()
    const sesion = m.sesionDe('gerente')
    expect((await m.editar(sesion, [nuevoEnlace(nuevoId(), g)])).codigo).toBe(400)
    const tagliata = m.producto('Tagliata di Manzo')
    expect((await m.editar(sesion, [nuevoEnlace(tagliata.id, nuevoId())])).codigo).toBe(400)
  })

  it('referenciar algo creado más abajo en el mismo pedido falla: el orden importa', async () => {
    const m = await montarServidor()
    const p = nuevoId()
    const r = await m.editar(m.sesionDe('gerente'), [
      {
        entidad: 'variante',
        id: nuevoId(),
        datos: { producto_id: p, nombre: 'Copa', precio: 1, orden: 0, activo: true },
      },
      { entidad: 'producto', id: p, datos: producto(m) },
    ])
    expect(r.codigo).toBe(400)
    expect(r.cuerpo.mensaje).toMatch(/Cambio 1.*producto_id no existe/)
  })
})

describe('archivar y reactivar', () => {
  it('archivar saca el producto de la carta y reactivarlo lo devuelve, con tres filas de historial', async () => {
    const m = await montarServidor()
    const burrata = burrataDe(m)
    const sesion = m.sesionDe('gerente')
    const archivar = await m.editar(sesion, [
      { entidad: 'producto', id: burrata.id, datos: { activo: false } },
    ])
    expect(archivar.codigo).toBe(200)
    expect(m.productos().some((x) => x.id === burrata.id)).toBe(false)

    const reactivar = await m.editar(sesion, [
      { entidad: 'producto', id: burrata.id, datos: { activo: true } },
    ])
    expect(reactivar.codigo).toBe(200)
    expect(reactivar.cuerpo.version).toBeGreaterThan(archivar.cuerpo.version)
    expect(m.producto('Burrata Spritz')).toEqual(burrata)

    const filas = m.db
      .prepare(
        'SELECT version, despues FROM catalogo_cambio WHERE registro_id = ? ORDER BY version',
      )
      .all(burrata.id)
    expect(filas.map((f) => JSON.parse(String(f.despues)).activo)).toEqual([1, 0, 1])
    const historial = new HistorialCatalogo(m.db, m.restauranteId)
    expect(historial.estadoEn('producto', burrata.id, archivar.cuerpo.version)?.activo).toBe(0)
    expect(historial.estadoEn('producto', burrata.id, reactivar.cuerpo.version)?.activo).toBe(1)
  })

  it('el editor ve lo archivado con activo=false y lo vigente con activo=true', async () => {
    const m = await montarServidor()
    const burrata = burrataDe(m)
    await m.editar(m.sesionDe('gerente'), [
      { entidad: 'producto', id: burrata.id, datos: { activo: false } },
    ])
    const r = await m.edicion()
    expect(r.statusCode).toBe(200)
    const cuerpo = r.json()
    const fila = cuerpo.productos.find((p: { id: string }) => p.id === burrata.id)
    expect(fila.activo).toBe(false)
    expect(typeof fila.favorito).toBe('boolean')
    expect(cuerpo.productos.some((p: { activo: boolean }) => p.activo)).toBe(true)
    expect(cuerpo.version).toBe(m.catalogo().version)
    // La respuesta no trae quién ni de qué restaurante.
    expect(fila).not.toHaveProperty('restaurante_id')
    expect(fila).not.toHaveProperty('usuario_id')
  })

  it('archivar y reactivar en un solo pedido deja la última palabra y dos versiones', async () => {
    const m = await montarServidor()
    const burrata = burrataDe(m)
    const antes = m.catalogo().version
    const r = await m.editar(m.sesionDe('gerente'), [
      { entidad: 'producto', id: burrata.id, datos: { activo: false } },
      { entidad: 'producto', id: burrata.id, datos: { activo: true } },
    ])
    expect(r.codigo).toBe(200)
    expect(r.cuerpo.version).toBe(antes + 2)
    expect(m.productos().some((x) => x.id === burrata.id)).toBe(true)
  })

  it('archivar una variante la quita del producto y de la carta; su historial queda', async () => {
    const m = await montarServidor()
    const vino = m.producto('Ramón Bilbao Crianza')
    const botella = vino.variantes[1]
    if (!botella) throw new Error('falta')
    const r = await m.editar(m.sesionDe('gerente'), [
      { entidad: 'variante', id: botella.id, datos: { activo: false } },
    ])
    expect(r.codigo).toBe(200)
    expect(m.producto('Ramón Bilbao Crianza').variantes.map((v) => v.id)).not.toContain(botella.id)
    expect(
      m.db
        .prepare('SELECT count(*) AS n FROM catalogo_cambio WHERE registro_id = ?')
        .get(botella.id)?.n,
    ).toBe(2)
  })

  it('nada se borra: la fila archivada sigue en su tabla', async () => {
    const m = await montarServidor()
    const burrata = burrataDe(m)
    await m.editar(m.sesionDe('gerente'), [
      { entidad: 'producto', id: burrata.id, datos: { activo: false } },
    ])
    expect(m.db.prepare('SELECT activo FROM producto WHERE id = ?').get(burrata.id)).toEqual({
      activo: 0,
    })
  })
})

describe('permisos y sesiones', () => {
  const cambio = (m: Awaited<ReturnType<typeof montarServidor>>) => [
    { entidad: 'producto', id: burrataDe(m).id, datos: { precio: 12_345 } },
  ]
  const sinCambios = (m: Awaited<ReturnType<typeof montarServidor>>, antes: number) => {
    expect(m.catalogo().version).toBe(antes)
    expect(m.avisos).toEqual([])
  }

  it('la sesión abierta en otro equipo no vale en este, aunque sea de un gerente', async () => {
    const m = await montarServidor()
    const otro = m.emparejar('mesero', 'Celular')
    const antes = m.catalogo().version
    const sesionDelOtro = m.sesionDe('gerente', otro.conexion)
    // Con el token de la caja y la sesión del celular.
    const r = await m.enviar(sesionDelOtro, cambio(m), m.caja.token)
    expect(r.codigo).toBe(401)
    expect(r.cuerpo.error).toBe('sesion_invalida')
    // Con el token del celular y la sesión del celular, sí es un gerente.
    expect((await m.enviar(sesionDelOtro, cambio(m), otro.token)).codigo).toBe(200)
    expect(m.catalogo().version).toBeGreaterThan(antes)
  })

  it('una sesión cerrada ya no edita', async () => {
    const m = await montarServidor()
    const antes = m.catalogo().version
    const s = m.entrar(m.caja.conexion, 'gerente')
    m.acceso.cerrarSesion(m.caja.conexion, { sesionId: s.sesionId, secreto: s.secreto })
    const r = await m.editar({ sesion_id: s.sesionId, secreto: s.secreto }, cambio(m))
    expect(r.codigo).toBe(401)
    sinCambios(m, antes)
  })

  it('al entrar otra persona en el equipo, la sesión anterior deja de valer', async () => {
    const m = await montarServidor()
    const antes = m.catalogo().version
    const gerente = m.sesionDe('gerente')
    m.sesionDe('mesero')
    expect((await m.editar(gerente, cambio(m))).codigo).toBe(401)
    sinCambios(m, antes)
  })

  it('un gerente archivado pierde la sesión', async () => {
    const m = await montarServidor()
    const sesion = m.sesionDe('gerente')
    m.acceso.archivarUsuario(m.personas.gerente.usuarioId)
    const antes = m.catalogo().version
    expect((await m.editar(sesion, cambio(m))).codigo).toBe(401)
    sinCambios(m, antes)
  })

  it('con un secreto ajeno o vacío no se edita', async () => {
    const m = await montarServidor()
    const antes = m.catalogo().version
    const s = m.sesionDe('gerente')
    expect((await m.editar({ ...s, secreto: 'otro' }, cambio(m))).codigo).toBe(401)
    expect((await m.editar({ sesion_id: nuevoId(), secreto: s.secreto }, cambio(m))).codigo).toBe(
      401,
    )
    expect((await m.editar({ ...s, secreto: '' }, cambio(m))).codigo).toBe(400)
    sinCambios(m, antes)
  })

  it('un equipo retirado no edita ni lee el catálogo', async () => {
    const m = await montarServidor()
    const admin = m.sesionDe('admin')
    const otro = m.emparejar('mesero', 'Celular')
    const sesion = m.sesionDe('gerente', otro.conexion)
    const retiro = m.acceso.revocarDispositivo(m.caja.conexion, {
      sesionId: admin.sesion_id,
      secreto: admin.secreto,
      dispositivoId: otro.conexion.dispositivoId,
    })
    expect(retiro.ok).toBe(true)
    const antes = m.catalogo().version
    expect((await m.enviar(sesion, cambio(m), otro.token)).codigo).toBe(401)
    expect((await m.edicion(otro.token)).statusCode).toBe(401)
    sinCambios(m, antes)
  })

  it('sin token, o con uno inventado, nada se edita ni se lee', async () => {
    const m = await montarServidor()
    const sesion = m.sesionDe('gerente')
    expect((await m.enviar(sesion, cambio(m), 'inventado')).codigo).toBe(401)
    expect((await m.edicion('inventado')).statusCode).toBe(401)
    const sinEncabezado = await m.app.inject({ method: 'GET', url: '/api/catalogo/edicion' })
    expect(sinEncabezado.statusCode).toBe(401)
    const otroEsquema = await m.app.inject({
      method: 'GET',
      url: '/api/catalogo',
      headers: { authorization: `Basic ${m.caja.token}` },
    })
    expect(otroEsquema.statusCode).toBe(401)
  })

  it('el mesero, el cajero y el mesero 2 reciben 403 y no queda rastro', async () => {
    const m = await montarServidor()
    const antes = m.catalogo().version
    const filas = m.historial().length
    for (const quien of ['mesero', 'mesero2', 'cajero'] as const) {
      const r = await m.editar(m.sesionDe(quien), cambio(m))
      expect(r.codigo, quien).toBe(403)
      expect(r.cuerpo.error).toBe('sin_permiso')
    }
    sinCambios(m, antes)
    expect(m.historial()).toHaveLength(filas)
  })

  it('el gerente y el administrador sí editan, y el historial dice quién fue', async () => {
    const m = await montarServidor()
    const burrata = burrataDe(m)
    for (const [quien, precio] of [
      ['gerente', 20_000],
      ['admin', 21_000],
    ] as const) {
      const r = await m.editar(m.sesionDe(quien), [
        { entidad: 'producto', id: burrata.id, datos: { precio } },
      ])
      expect(r.codigo, quien).toBe(200)
      const ultimo = m.db
        .prepare(
          'SELECT usuario_id, dispositivo_id FROM catalogo_cambio ORDER BY version DESC LIMIT 1',
        )
        .get()
      expect(ultimo).toEqual({
        usuario_id: m.personas[quien].usuarioId,
        dispositivo_id: m.caja.conexion.dispositivoId,
      })
    }
  })

  it('quien tiene solo editar_precios no puede mezclar precio con archivar', async () => {
    const m = await montarServidor()
    const { insertarVersionado } = await import('./acceso/registros')
    insertarVersionado(
      m.db,
      'rol_permiso',
      m.restauranteId,
      { rol_id: m.roles.cajero, permiso: 'editar_precios' },
      { usuarioId: null, dispositivoId: null },
      m.reloj(),
    )
    const burrata = burrataDe(m)
    const sesion = m.sesionDe('cajero')
    const mezcla = await m.editar(sesion, [
      { entidad: 'producto', id: burrata.id, datos: { precio: 1_000, activo: false } },
    ])
    expect(mezcla.codigo).toBe(403)
    // Un precio en una variante o un modificador también es solo precio.
    const vino = m.producto('Ramón Bilbao Crianza')
    const botella = vino.variantes[1]
    const termino = m.producto('Tagliata di Manzo').grupos[0]?.opciones[0]
    if (!botella || !termino) throw new Error('falta')
    const r = await m.editar(sesion, [
      { entidad: 'variante', id: botella.id, datos: { precio: botella.precio + 1_000 } },
      { entidad: 'modificador', id: termino.id, datos: { precio_extra: 500 } },
    ])
    expect(r.codigo).toBe(200)
    // Y no puede tocar el precio de algo que no es producto, variante o modificador.
    const impuestoId = m.impuestoId
    expect(
      (await m.editar(sesion, [{ entidad: 'impuesto', id: impuestoId, datos: { tarifa: 1 } }]))
        .codigo,
    ).toBe(403)
  })
})

describe('ids y datos inválidos', () => {
  const rechazado = async (m: Awaited<ReturnType<typeof montarServidor>>, cambios: unknown) => {
    const antes = m.catalogo().version
    const filas = m.historial().length
    const r = await m.enviar(m.sesionDe('gerente'), cambios)
    expect(r.codigo).toBe(400)
    expect(m.catalogo().version).toBe(antes)
    expect(m.historial()).toHaveLength(filas)
    expect(m.avisos).toEqual([])
    return r
  }
  const estacion = (id: unknown) => ({
    entidad: 'estacion',
    id,
    datos: { nombre: 'X', orden: 0, activo: true },
  })

  it.each([
    ['vacío', ''],
    ['corto', 'ABC'],
    ['en minúsculas', nuevoId().toLowerCase()],
    ['con letras que ULID no usa (I, L, O, U)', '01ARZ3NDEKTSV4RRFFQ69G5FAI'],
    ['de 27 caracteres', `${nuevoId()}0`],
    ['con el primer carácter fuera de 0-7', `8${nuevoId().slice(1)}`],
    ['un UUID', '123e4567-e89b-12d3-a456-426614174000'],
    ['con espacios', ` ${nuevoId().slice(1)}`],
    ['un número', 12345],
    ['null', null],
    ['un objeto', { $ne: null }],
    ['una lista', [nuevoId()]],
    ['con comillas (SQL)', "01ARZ3NDEKTSV4RRFFQ69G5F'"],
  ])('el id del registro %s se rechaza', async (_caso, id) => {
    const m = await montarServidor()
    await rechazado(m, [estacion(id)])
  })

  it.each([
    ['categoria_id', 'categoria_id'],
    ['impuesto_id', 'impuesto_id'],
  ])('un %s que no es ULID se rechaza al crear un producto', async (_c, campo) => {
    const m = await montarServidor()
    await rechazado(m, [
      { entidad: 'producto', id: nuevoId(), datos: producto(m, { [campo]: 'no-es-id' }) },
    ])
  })

  it('una referencia que es un ULID válido pero de otra tabla no cuenta como existente', async () => {
    const m = await montarServidor()
    const burrata = burrataDe(m)
    // La "categoría" es un producto.
    const r = await rechazado(m, [
      { entidad: 'producto', id: nuevoId(), datos: producto(m, { categoria_id: burrata.id }) },
    ])
    expect(r.cuerpo.mensaje).toMatch(/categoria_id no existe/)
    // El "producto" de una variante es un impuesto.
    await rechazado(m, [
      {
        entidad: 'variante',
        id: nuevoId(),
        datos: { producto_id: m.impuestoId, nombre: 'V', precio: 1, orden: 0, activo: true },
      },
    ])
  })

  it('algo activo no puede apuntar a un registro archivado; algo archivado sí', async () => {
    const m = await montarServidor()
    const sesion = m.sesionDe('gerente')
    const e = nuevoId()
    await m.editar(sesion, [estacion(e)])
    await m.editar(sesion, [{ entidad: 'estacion', id: e, datos: { activo: false } }])
    const nueva = (activo: boolean) => [
      {
        entidad: 'categoria',
        id: nuevoId(),
        datos: { nombre: 'Nueva', orden: 0, estacion_id: e, activo },
      },
    ]
    const avisos = m.avisos.length
    const r = await m.editar(sesion, nueva(true))
    expect(r.codigo).toBe(400)
    expect(r.cuerpo.mensaje).toMatch(/archivado/)
    expect(m.avisos).toHaveLength(avisos)
    expect((await m.editar(sesion, nueva(false))).codigo).toBe(200)
  })

  it('el id de un producto no se puede reusar como id de una variante', async () => {
    // Los ids son únicos en todo el catálogo (el historial busca por registro_id sin entidad).
    const m = await montarServidor()
    const burrata = burrataDe(m)
    const r = await m.enviar(m.sesionDe('gerente'), [
      {
        entidad: 'variante',
        id: burrata.id,
        datos: { producto_id: burrata.id, nombre: 'Doble', precio: 99_000, orden: 0, activo: true },
      },
    ])
    expect(r.codigo).toBe(400)
    expect(r.cuerpo.mensaje).toMatch(/otro tipo de registro/)
    expect(m.db.prepare('SELECT count(*) AS n FROM variante WHERE id = ?').get(burrata.id)?.n).toBe(
      0,
    )
  })

  it('una entidad que no se edita desde aquí se rechaza', async () => {
    const m = await montarServidor()
    for (const entidad of [
      'usuario',
      'rol',
      'mesa',
      'restaurante',
      'producto_estacion',
      'evento',
      '',
      'PRODUCTO',
    ])
      await rechazado(m, [{ entidad, id: nuevoId(), datos: { nombre: 'X' } }])
  })

  it.each([
    'version',
    'restaurante_id',
    'id',
    'creado_en',
    'actualizado_en',
    'usuario_id',
    'dispositivo_id',
    'foto',
    'secuencia',
  ])('el campo «%s» dentro de datos se rechaza al actualizar', async (campo) => {
    const m = await montarServidor()
    const burrata = burrataDe(m)
    const valor = campo === 'version' ? 1 : campo === 'foto' ? 'x.jpg' : nuevoId()
    const r = await rechazado(m, [
      { entidad: 'producto', id: burrata.id, datos: { precio: 5_000, [campo]: valor } },
    ])
    expect(r.cuerpo.mensaje).toMatch(/Cambio 1/)
    expect(m.producto('Burrata Spritz').precio).toBe(burrata.precio)
  })

  it.each(['version', 'restaurante_id', 'creado_en', 'actualizado_en', 'usuario_id'])(
    'el campo «%s» dentro de datos se rechaza al crear',
    async (campo) => {
      const m = await montarServidor()
      const id = nuevoId()
      const valor = campo === 'version' ? 0 : nuevoId()
      await rechazado(m, [{ entidad: 'producto', id, datos: producto(m, { [campo]: valor }) }])
      expect(m.db.prepare('SELECT 1 FROM producto WHERE id = ?').get(id)).toBeUndefined()
    },
  )

  it('meter la versión en datos no deja saltarse el contador del hub', async () => {
    const m = await montarServidor()
    const antes = m.catalogo().version
    await rechazado(m, [
      {
        entidad: 'estacion',
        id: nuevoId(),
        datos: { nombre: 'X', orden: 0, activo: true, version: 0 },
      },
    ])
    await rechazado(m, [
      {
        entidad: 'estacion',
        id: nuevoId(),
        datos: { nombre: 'X', orden: 0, activo: true, version: antes + 1_000 },
      },
    ])
  })

  it('un restaurante_id en el cuerpo, en el cambio o con __proto__ se rechaza', async () => {
    const m = await montarServidor()
    const sesion = m.sesionDe('gerente')
    const cambios = [estacion(nuevoId())]
    const antes = m.catalogo().version
    expect(
      (await m.enviar(sesion, cambios, m.caja.token, { restaurante_id: nuevoId() })).codigo,
    ).toBe(400)
    expect(
      (await m.enviar(sesion, [{ ...estacion(nuevoId()), restaurante_id: nuevoId() }])).codigo,
    ).toBe(400)
    const crudo = await m.app.inject({
      method: 'POST',
      url: '/api/catalogo/cambios',
      headers: { authorization: `Bearer ${m.caja.token}`, 'content-type': 'application/json' },
      payload: `{"sesion_id":"${sesion.sesion_id}","secreto":"${sesion.secreto}","cambios":[{"entidad":"estacion","id":"${nuevoId()}","datos":{"nombre":"X","orden":0,"activo":true,"__proto__":{"version":1}}}]}`,
    })
    expect(crudo.statusCode).toBe(400)
    expect(m.catalogo().version).toBe(antes)
  })

  it('el cuerpo sin cambios, con una lista vacía o que no es lista se rechaza', async () => {
    const m = await montarServidor()
    await rechazado(m, [])
    await rechazado(m, undefined)
    await rechazado(m, 'cambios')
    await rechazado(m, { entidad: 'estacion' })
    await rechazado(m, [null])
    await rechazado(m, [{ entidad: 'estacion', id: nuevoId() }])
    await rechazado(m, [{ entidad: 'estacion', id: nuevoId(), datos: null }])
    await rechazado(m, [{ entidad: 'estacion', id: nuevoId(), datos: [] }])
  })

  it('un cuerpo que no es JSON se rechaza sin romper el servidor', async () => {
    const m = await montarServidor()
    const r = await m.app.inject({
      method: 'POST',
      url: '/api/catalogo/cambios',
      headers: { authorization: `Bearer ${m.caja.token}`, 'content-type': 'application/json' },
      payload: '{roto',
    })
    expect(r.statusCode).toBe(400)
    expect((await m.edicion()).statusCode).toBe(200)
  })

  it.each([
    ['precio como texto', { precio: '1000' }],
    ['precio con decimales', { precio: 0.5 }],
    ['precio NaN como texto', { precio: 'NaN' }],
    ['precio sobre el límite', { precio: 100_000_001 }],
    ['precio negativo', { precio: -1 }],
    ['precio nulo', { precio: null }],
    ['activo como número', { activo: 1 }],
    ['activo como texto', { activo: 'true' }],
    ['favorito como número', { favorito: 1 }],
    ['nombre vacío', { nombre: '' }],
    ['nombre solo de espacios', { nombre: '   ' }],
    ['nombre de 81 caracteres', { nombre: 'a'.repeat(81) }],
    ['nombre que no es texto', { nombre: 42 }],
    ['descripción de 301 caracteres', { descripcion: 'a'.repeat(301) }],
    ['impuesto_id nulo', { impuesto_id: null }],
  ])('%s se rechaza', async (_caso, datos) => {
    const m = await montarServidor()
    await rechazado(m, [{ entidad: 'producto', id: burrataDe(m).id, datos }])
  })

  it('el nombre se guarda sin espacios de los lados', async () => {
    const m = await montarServidor()
    const burrata = burrataDe(m)
    const r = await m.editar(m.sesionDe('gerente'), [
      { entidad: 'producto', id: burrata.id, datos: { nombre: '  Burrata nueva  ' } },
    ])
    expect(r.codigo).toBe(200)
    expect(m.productos().some((p) => p.nombre === 'Burrata nueva')).toBe(true)
  })

  it('en los extremos válidos sí se acepta: precio 0 y 100.000.000, nombre de 80', async () => {
    const m = await montarServidor()
    const sesion = m.sesionDe('gerente')
    for (const precio of [0, 100_000_000])
      expect(
        (await m.editar(sesion, [{ entidad: 'producto', id: burrataDe(m).id, datos: { precio } }]))
          .codigo,
      ).toBe(200)
    expect(
      (
        await m.editar(sesion, [
          { entidad: 'producto', id: burrataDe(m).id, datos: { nombre: 'a'.repeat(80) } },
        ])
      ).codigo,
    ).toBe(200)
  })

  it('reglas de impuestos y grupos: exento sin tarifa, tarifa máxima, mínimo y máximo', async () => {
    const m = await montarServidor()
    const imp = (datos: object) => [
      { entidad: 'impuesto', id: nuevoId(), datos: { nombre: 'I', activo: true, ...datos } },
    ]
    await rechazado(m, imp({ tipo: 'exento', tarifa: 1 }))
    await rechazado(m, imp({ tipo: 'inc', tarifa: 10_001 }))
    await rechazado(m, imp({ tipo: 'inc', tarifa: -1 }))
    await rechazado(m, imp({ tipo: 'inc', tarifa: 8.5 }))
    await rechazado(m, imp({ tipo: 'otro', tarifa: 8 }))
    const grp = (datos: object) => [
      {
        entidad: 'grupo_modificador',
        id: nuevoId(),
        datos: { nombre: 'G', activo: true, ...datos },
      },
    ]
    await rechazado(m, grp({ minimo: 2, maximo: 1 }))
    await rechazado(m, grp({ minimo: 0, maximo: 0 }))
    await rechazado(m, grp({ minimo: -1, maximo: 1 }))
    await rechazado(m, grp({ minimo: 0, maximo: 21 }))
    const sesion = m.sesionDe('gerente')
    expect((await m.editar(sesion, imp({ tipo: 'exento', tarifa: 0 }))).codigo).toBe(200)
    expect((await m.editar(sesion, imp({ tipo: 'iva', tarifa: 1_900 }))).codigo).toBe(200)
    expect((await m.editar(sesion, grp({ minimo: 1, maximo: 1 }))).codigo).toBe(200)
  })

  it('subir el mínimo de un grupo por encima de su máximo se rechaza al actualizar', async () => {
    const m = await montarServidor()
    const termino = m.producto('Tagliata di Manzo').grupos[0]
    if (!termino) throw new Error('falta')
    const r = await rechazado(m, [
      { entidad: 'grupo_modificador', id: termino.id, datos: { minimo: termino.maximo + 1 } },
    ])
    expect(r.cuerpo.mensaje).toMatch(/Cambio 1/)
  })

  it('un cambio que no cambia nada (datos vacíos) se rechaza', async () => {
    const m = await montarServidor()
    await rechazado(m, [{ entidad: 'producto', id: burrataDe(m).id, datos: {} }])
  })

  it('un error en el mensaje no revela datos internos', async () => {
    const m = await montarServidor()
    const r = await rechazado(m, [
      { entidad: 'producto', id: burrataDe(m).id, datos: { categoria_id: nuevoId() } },
    ])
    expect(JSON.stringify(r.cuerpo)).not.toMatch(/SELECT|INSERT|sqlite|at .*\.ts/i)
  })
})

describe('cambios que no cambian nada', () => {
  it('repetir el mismo pedido no sube la versión, no escribe historial ni avisa', async () => {
    const m = await montarServidor()
    const burrata = burrataDe(m)
    const sesion = m.sesionDe('gerente')
    const pedido = [
      { entidad: 'producto', id: burrata.id, datos: { precio: burrata.precio + 700 } },
    ]
    const primero = await m.editar(sesion, pedido)
    expect(primero.cuerpo.cambiados).toBe(1)
    const filas = m.historial().length
    const segundo = await m.editar(sesion, pedido)
    expect(segundo.codigo).toBe(200)
    expect(segundo.cuerpo).toEqual({ version: primero.cuerpo.version, cambiados: 0 })
    expect(m.historial()).toHaveLength(filas)
    expect(m.avisos).toEqual([primero.cuerpo.version])
  })

  it('con un campo igual y otro distinto solo cuenta el distinto', async () => {
    const m = await montarServidor()
    const burrata = burrataDe(m)
    const r = await m.editar(m.sesionDe('gerente'), [
      { entidad: 'producto', id: burrata.id, datos: { precio: burrata.precio, favorito: true } },
    ])
    expect(r.cuerpo.cambiados).toBe(1)
    const ultimo = m.db
      .prepare('SELECT antes, despues FROM catalogo_cambio ORDER BY version DESC LIMIT 1')
      .get()
    expect(JSON.parse(String(ultimo?.antes)).favorito).toBe(0)
    expect(JSON.parse(String(ultimo?.despues)).favorito).toBe(1)
  })

  it('el mismo registro dos veces con el mismo cambio cuenta una sola vez', async () => {
    const m = await montarServidor()
    const burrata = burrataDe(m)
    const antes = m.catalogo().version
    const cambio = { entidad: 'producto', id: burrata.id, datos: { precio: 33_333 } }
    const r = await m.editar(m.sesionDe('gerente'), [cambio, cambio])
    expect(r.cuerpo).toEqual({ version: antes + 1, cambiados: 1 })
  })

  it('un cambio sin efecto sigue validándose: un valor inválido no pasa por ser igual', async () => {
    const m = await montarServidor()
    const r = await m.editar(m.sesionDe('gerente'), [
      { entidad: 'producto', id: burrataDe(m).id, datos: { categoria_id: 'x' } },
    ])
    expect(r.codigo).toBe(400)
  })
})

describe('el padre de un registro no cambia', () => {
  it('una variante no pasa a otro producto, una opción no pasa a otro grupo', async () => {
    const m = await montarServidor()
    const sesion = m.sesionDe('gerente')
    const vino = m.producto('Ramón Bilbao Crianza')
    const otro = burrataDe(m)
    const variante = vino.variantes[0]
    const tagliata = m.producto('Tagliata di Manzo')
    const opcion = tagliata.grupos[0]?.opciones[0]
    const otroGrupo = m.db
      .prepare('SELECT id FROM grupo_modificador WHERE id <> ? LIMIT 1')
      .get(tagliata.grupos[0]?.id ?? '')
    if (!variante || !opcion) throw new Error('falta')
    const antes = m.catalogo().version
    const r1 = await m.editar(sesion, [
      { entidad: 'variante', id: variante.id, datos: { producto_id: otro.id } },
    ])
    expect(r1.codigo).toBe(400)
    expect(r1.cuerpo.mensaje).toMatch(/otro producto/)
    if (otroGrupo) {
      const r2 = await m.editar(sesion, [
        { entidad: 'modificador', id: opcion.id, datos: { grupo_id: String(otroGrupo.id) } },
      ])
      expect(r2.codigo).toBe(400)
      expect(r2.cuerpo.mensaje).toMatch(/otro grupo/)
    }
    const enlace = String(
      m.db.prepare('SELECT id FROM producto_grupo_modificador LIMIT 1').get()?.id,
    )
    const r3 = await m.editar(sesion, [
      { entidad: 'producto_grupo_modificador', id: enlace, datos: { producto_id: otro.id } },
    ])
    expect(r3.codigo).toBe(400)
    expect(m.catalogo().version).toBe(antes)
  })

  it('mandar el mismo padre que ya tiene no es un error', async () => {
    const m = await montarServidor()
    const vino = m.producto('Ramón Bilbao Crianza')
    const variante = vino.variantes[0]
    if (!variante) throw new Error('falta')
    const r = await m.editar(m.sesionDe('gerente'), [
      {
        entidad: 'variante',
        id: variante.id,
        datos: { producto_id: vino.id, nombre: 'Copa grande' },
      },
    ])
    expect(r.codigo).toBe(200)
    expect(r.cuerpo.cambiados).toBe(1)
  })
})

describe('archivar lo que otros usan', () => {
  const archivar = (entidad: string, id: string) => [{ entidad, id, datos: { activo: false } }]

  it('un impuesto o una categoría con productos activos no se archiva', async () => {
    const m = await montarServidor()
    const sesion = m.sesionDe('gerente')
    const antes = m.catalogo().version
    const imp = await m.editar(sesion, archivar('impuesto', m.impuestoId))
    expect(imp.codigo).toBe(400)
    expect(imp.cuerpo.mensaje).toMatch(/lo usan \d+ productos/)
    const cat = await m.editar(sesion, archivar('categoria', m.categoriaId))
    expect(cat.codigo).toBe(400)
    expect(m.catalogo().version).toBe(antes)
    expect(m.productos().length).toBeGreaterThan(0)
  })

  it('una estación con categorías activas no se archiva', async () => {
    const m = await montarServidor()
    const estacionId = String(
      m.db
        .prepare(
          'SELECT estacion_id AS id FROM categoria WHERE estacion_id IS NOT NULL AND activo = 1 LIMIT 1',
        )
        .get()?.id,
    )
    const r = await m.editar(m.sesionDe('gerente'), archivar('estacion', estacionId))
    expect(r.codigo).toBe(400)
    expect(r.cuerpo.mensaje).toMatch(/categorías/)
  })

  it('en el mismo pedido se puede archivar todo lo que depende y luego el padre', async () => {
    const m = await montarServidor()
    const sesion = m.sesionDe('gerente')
    const categoria = String(
      m.db.prepare('SELECT id FROM categoria WHERE activo = 1 ORDER BY nombre LIMIT 1').get()?.id,
    )
    const productos = m.db
      .prepare('SELECT id FROM producto WHERE categoria_id = ? AND activo = 1')
      .all(categoria)
      .map((p) => ({ entidad: 'producto', id: String(p.id), datos: { activo: false } }))
    // Primero la categoría sola: se rechaza.
    expect((await m.editar(sesion, archivar('categoria', categoria))).codigo).toBe(400)
    // Con sus productos archivados antes, pasa.
    const r = await m.editar(sesion, [...productos, ...archivar('categoria', categoria)])
    expect(r.codigo).toBe(200)
    // Al revés (la categoría primero) también: se revisa con todo aplicado.
    expect(m.catalogo().categorias.some((c) => c.id === categoria)).toBe(false)
  })

  it('no se puede reactivar un producto cuya categoría sigue archivada', async () => {
    const m = await montarServidor()
    const sesion = m.sesionDe('gerente')
    const categoria = String(
      m.db.prepare('SELECT id FROM categoria WHERE activo = 1 ORDER BY nombre LIMIT 1').get()?.id,
    )
    const productos = m.db
      .prepare('SELECT id FROM producto WHERE categoria_id = ? AND activo = 1')
      .all(categoria)
      .map((p) => String(p.id))
    await m.editar(sesion, [
      ...productos.map((id) => ({ entidad: 'producto', id, datos: { activo: false } })),
      ...archivar('categoria', categoria),
    ])
    const r = await m.editar(sesion, [
      { entidad: 'producto', id: productos[0], datos: { activo: true } },
    ])
    expect(r.codigo).toBe(400)
    expect(r.cuerpo.mensaje).toMatch(/categoria está archivado/)
  })

  it('archivar un grupo archiva sus enlaces y queda en el historial', async () => {
    const m = await montarServidor()
    const tagliata = m.producto('Tagliata di Manzo')
    const grupo = tagliata.grupos[0]
    if (!grupo) throw new Error('falta')
    const enlace = String(
      m.db.prepare('SELECT id FROM producto_grupo_modificador WHERE grupo_id = ?').get(grupo.id)
        ?.id,
    )
    const r = await m.editar(m.sesionDe('gerente'), archivar('grupo_modificador', grupo.id))
    expect(r.codigo).toBe(200)
    expect(
      m.db.prepare('SELECT activo FROM producto_grupo_modificador WHERE id = ?').get(enlace),
    ).toEqual({ activo: 0 })
    expect(m.producto('Tagliata di Manzo').grupos).toHaveLength(0)
    // El enlace archivado se anotó, con una versión propia.
    expect(
      m.db.prepare('SELECT count(*) AS n FROM catalogo_cambio WHERE registro_id = ?').get(enlace)
        ?.n,
    ).toBe(2)
    expect(r.cuerpo.version).toBe(m.catalogo().version)
  })

  it('el aviso a los equipos lleva la versión final, después de archivar los enlaces', async () => {
    const m = await montarServidor()
    const grupo = m.producto('Tagliata di Manzo').grupos[0]
    if (!grupo) throw new Error('falta')
    const r = await m.editar(m.sesionDe('gerente'), archivar('grupo_modificador', grupo.id))
    expect(m.avisos).toEqual([r.cuerpo.version])
  })

  it('archivar un producto y tocar en el mismo pedido uno de sus tamaños activos se rechaza', async () => {
    // Lo que el editor de la carta no debe mandar junto (ver borradores.propiedades.test.ts).
    const m = await montarServidor()
    const vino = m.producto('Ramón Bilbao Crianza')
    const copa = vino.variantes[0]
    if (!copa) throw new Error('falta')
    const antes = m.catalogo().version
    const r = await m.editar(m.sesionDe('gerente'), [
      { entidad: 'producto', id: vino.id, datos: { activo: false } },
      { entidad: 'variante', id: copa.id, datos: { precio: copa.precio + 1_000 } },
    ])
    expect(r.codigo).toBe(400)
    expect(r.cuerpo.mensaje).toMatch(/Cambio 2.*producto está archivado/)
    expect(m.catalogo().version).toBe(antes)
    // Por separado, sí.
    expect(
      (
        await m.editar(m.sesionDe('gerente'), [
          { entidad: 'producto', id: vino.id, datos: { activo: false } },
        ])
      ).codigo,
    ).toBe(200)
  })

  it('archivar un grupo y tocar en el mismo pedido una de sus opciones activas se rechaza', async () => {
    const m = await montarServidor()
    const grupo = m.producto('Tagliata di Manzo').grupos[0]
    const opcion = grupo?.opciones[0]
    if (!grupo || !opcion) throw new Error('falta')
    const r = await m.editar(m.sesionDe('gerente'), [
      { entidad: 'grupo_modificador', id: grupo.id, datos: { activo: false } },
      { entidad: 'modificador', id: opcion.id, datos: { precio_extra: opcion.precioExtra + 500 } },
    ])
    expect(r.codigo).toBe(400)
    expect(r.cuerpo.mensaje).toMatch(/Cambio 2.*grupo está archivado/)
  })
})
