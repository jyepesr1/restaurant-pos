import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { montarAcceso } from './acceso/montaje'
import { leerCatalogo } from './catalogo'
import { catalogoParaEditar } from './edicion-catalogo'
import { CARTA } from './pruebas-catalogo'
import { sembrar } from './seed/sembrar'
import { crearServidor } from './servidor'

// Reglas del plano (tarea 1.2) más allá del camino feliz: cambiar de zona, reactivar, nombres que
// casi se repiten, lotes grandes y qué pasa con el seed después de que alguien dibuja el salón.

// El tipo que devuelve `catalogoParaEditar` pierde las columnas al desestructurar: aquí se declara.
type Fila = { id: string; nombre: string; version: number; activo: boolean; zona_id: string }
type Edicion = { version: number; zonas: Fila[]; mesas: Fila[]; elementos: Fila[] }

async function montar() {
  const m = montarAcceso()
  const sembrarSalon = () =>
    sembrar(
      m.db,
      m.acceso,
      { restauranteId: m.restauranteId, roles: m.roles, carta: CARTA, sinPersonal: true },
      m.reloj(),
    )
  sembrarSalon()
  const avisos: number[] = []
  const app = crearServidor({
    acceso: m.acceso,
    catalogo: {
      db: m.db,
      restauranteId: m.restauranteId,
      acceso: m.acceso,
      reloj: m.reloj,
      alCambiar: (v) => avisos.push(v),
    },
  })
  await app.ready()
  const caja = m.emparejar('caja')
  const s = m.entrar(caja.conexion, 'gerente')
  const editar = async (cambios: unknown[]) => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/catalogo/cambios',
      headers: { authorization: `Bearer ${caja.token}` },
      payload: { sesion_id: s.sesionId, secreto: s.secreto, cambios },
    })
    return { codigo: r.statusCode, cuerpo: r.json() }
  }
  const catalogo = () => leerCatalogo(m.db, m.restauranteId)
  const edicion = () => catalogoParaEditar(m.db, m.restauranteId) as unknown as Edicion
  const salon = () => catalogo().zonas[0]?.id as string
  return { ...m, app, editar, catalogo, edicion, salon, avisos, sembrarSalon }
}

const GEO = { x: 0, y: 0, ancho: 90, alto: 90, rotacion: 0 }
const mesa = (zonaId: string, nombre: string, campos: Record<string, unknown> = {}) => ({
  entidad: 'mesa',
  id: nuevoId(),
  datos: {
    zona_id: zonaId,
    nombre,
    forma: 'redonda',
    capacidad: 2,
    activo: true,
    ...GEO,
    ...campos,
  },
})
const zona = (nombre: string, campos: Record<string, unknown> = {}) => ({
  entidad: 'zona',
  id: nuevoId(),
  datos: { nombre, orden: 1, piso: 1, activo: true, ...campos },
})
const elemento = (zonaId: string, campos: Record<string, unknown> = {}) => ({
  entidad: 'elemento_plano',
  id: nuevoId(),
  datos: { zona_id: zonaId, tipo: 'pared', texto: null, ...GEO, activo: true, ...campos },
})

describe('mover una mesa o un elemento a otra zona', () => {
  it('la mesa pasa a la otra zona con su nombre y geometría, y cada zona la ve en su lado', async () => {
    const m = await montar()
    const terraza = zona('Terraza')
    expect((await m.editar([terraza])).codigo).toBe(200)
    const uno = m.catalogo().mesas.find((x) => x.nombre === '1')
    expect(uno).toBeDefined()
    const r = await m.editar([{ entidad: 'mesa', id: uno?.id, datos: { zona_id: terraza.id } }])
    expect(r.codigo).toBe(200)
    const movida = m.catalogo().mesas.find((x) => x.id === uno?.id)
    expect(movida).toMatchObject({ zonaId: terraza.id, nombre: '1', x: uno?.x, y: uno?.y })
    expect(m.catalogo().mesas.filter((x) => x.zonaId === m.salon())).toHaveLength(24)
    expect(m.catalogo().mesas.filter((x) => x.zonaId === terraza.id)).toHaveLength(1)
  })

  it('moverla y cambiarle la geometría en un solo guardado también vale, y sube su versión', async () => {
    const m = await montar()
    const terraza = zona('Terraza')
    await m.editar([terraza])
    const antes = m.edicion().mesas.find((x) => x.nombre === '2')
    const r = await m.editar([
      { entidad: 'mesa', id: antes?.id, datos: { zona_id: terraza.id, x: 500, rotacion: 90 } },
    ])
    expect(r).toMatchObject({ codigo: 200, cuerpo: { cambiados: 1 } })
    const despues = m.edicion().mesas.find((x) => x.id === antes?.id)
    expect(despues).toMatchObject({ zona_id: terraza.id, x: 500, rotacion: 90 })
    expect(Number(despues?.version)).toBeGreaterThan(Number(antes?.version))
  })

  it('no se puede mover a una zona archivada ni a una que no existe', async () => {
    const m = await montar()
    const vacia = zona('Vacía')
    await m.editar([vacia])
    await m.editar([{ entidad: 'zona', id: vacia.id, datos: { activo: false } }])
    const uno = m.catalogo().mesas[0]?.id
    const aArchivada = await m.editar([{ entidad: 'mesa', id: uno, datos: { zona_id: vacia.id } }])
    expect(aArchivada.codigo).toBe(400)
    expect(aArchivada.cuerpo.mensaje).toMatch(/zona está archivado/)
    const aNinguna = await m.editar([{ entidad: 'mesa', id: uno, datos: { zona_id: nuevoId() } }])
    expect(aNinguna.cuerpo.mensaje).toMatch(/zona_id no existe/)
    // Nada se movió.
    expect(m.catalogo().mesas.find((x) => x.id === uno)?.zonaId).toBe(m.salon())
  })

  it('un mismo guardado puede vaciar la zona vieja: pasar sus mesas y archivarla', async () => {
    const m = await montar()
    const nueva = zona('Nueva', { orden: 0 })
    const salon = m.salon()
    const r = await m.editar([
      nueva,
      ...m.catalogo().mesas.map((x) => ({
        entidad: 'mesa',
        id: x.id,
        datos: { zona_id: nueva.id },
      })),
      { entidad: 'zona', id: salon, datos: { activo: false } },
    ])
    expect(r.codigo).toBe(200)
    expect(m.catalogo().zonas.map((z) => z.nombre)).toEqual(['Nueva'])
    expect(m.catalogo().mesas).toHaveLength(25)
  })

  it('un elemento del plano también cambia de zona', async () => {
    const m = await montar()
    const a = zona('A')
    const pared = elemento(a.datos.nombre === 'A' ? m.salon() : '')
    await m.editar([a, pared])
    expect(
      (await m.editar([{ entidad: 'elemento_plano', id: pared.id, datos: { zona_id: a.id } }]))
        .codigo,
    ).toBe(200)
    expect(m.catalogo().elementos.find((e) => e.id === pared.id)?.zonaId).toBe(a.id)
  })
})

describe('reactivar lo archivado', () => {
  it('una zona archivada vuelve sola, vacía: sus mesas siguen archivadas hasta que se reactiven', async () => {
    const m = await montar()
    const t = zona('Terraza')
    const t1 = mesa(t.id, 'T1')
    const pared = elemento(t.id)
    await m.editar([t, t1, pared])
    await m.editar([
      { entidad: 'mesa', id: t1.id, datos: { activo: false } },
      { entidad: 'elemento_plano', id: pared.id, datos: { activo: false } },
      { entidad: 'zona', id: t.id, datos: { activo: false } },
    ])
    expect(m.catalogo().zonas.map((z) => z.nombre)).toEqual(['Salón'])

    expect((await m.editar([{ entidad: 'zona', id: t.id, datos: { activo: true } }])).codigo).toBe(
      200,
    )
    expect(m.catalogo().zonas.map((z) => z.nombre)).toEqual(['Salón', 'Terraza'])
    expect(m.catalogo().mesas.filter((x) => x.zonaId === t.id)).toEqual([])
    expect(m.catalogo().elementos).toEqual([])

    // Reactivar mesa y elemento, ahora que la zona está activa.
    const r = await m.editar([
      { entidad: 'mesa', id: t1.id, datos: { activo: true } },
      { entidad: 'elemento_plano', id: pared.id, datos: { activo: true } },
    ])
    expect(r.codigo).toBe(200)
    expect(
      m
        .catalogo()
        .mesas.filter((x) => x.zonaId === t.id)
        .map((x) => x.nombre),
    ).toEqual(['T1'])
    expect(m.catalogo().elementos.map((e) => e.id)).toEqual([pared.id])
  })

  it('reactivar la zona y sus mesas en un solo guardado vale', async () => {
    const m = await montar()
    const t = zona('Terraza')
    const t1 = mesa(t.id, 'T1')
    await m.editar([t, t1])
    await m.editar([
      { entidad: 'mesa', id: t1.id, datos: { activo: false } },
      { entidad: 'zona', id: t.id, datos: { activo: false } },
    ])
    const r = await m.editar([
      { entidad: 'mesa', id: t1.id, datos: { activo: true } },
      { entidad: 'zona', id: t.id, datos: { activo: true } },
    ])
    expect(r.codigo).toBe(200)
    expect(m.catalogo().mesas.some((x) => x.id === t1.id)).toBe(true)
  })

  it('no se reactiva una mesa dentro de una zona que sigue archivada', async () => {
    const m = await montar()
    const t = zona('Terraza')
    const t1 = mesa(t.id, 'T1')
    await m.editar([t, t1])
    await m.editar([
      { entidad: 'mesa', id: t1.id, datos: { activo: false } },
      { entidad: 'zona', id: t.id, datos: { activo: false } },
    ])
    const r = await m.editar([{ entidad: 'mesa', id: t1.id, datos: { activo: true } }])
    expect(r.codigo).toBe(400)
    expect(r.cuerpo.mensaje).toMatch(/zona está archivado/)
  })

  it('no se reactiva una mesa cuyo nombre ya tomó otra mesa activa', async () => {
    const m = await montar()
    const s = m.salon()
    const vieja = mesa(s, 'Barra 1')
    await m.editar([vieja])
    await m.editar([{ entidad: 'mesa', id: vieja.id, datos: { activo: false } }])
    await m.editar([mesa(s, 'barra 1')])
    const r = await m.editar([{ entidad: 'mesa', id: vieja.id, datos: { activo: true } }])
    expect(r.codigo).toBe(400)
    expect(r.cuerpo.mensaje).toMatch(/dos mesas que se llaman/)
    expect(m.edicion().mesas.find((x) => x.id === vieja.id)?.activo).toBe(false)
  })

  it('reactivar algo que ya está activo no cambia nada ni avisa a los equipos', async () => {
    const m = await montar()
    const antes = m.catalogo().version
    const r = await m.editar([{ entidad: 'zona', id: m.salon(), datos: { activo: true } }])
    expect(r).toMatchObject({ codigo: 200, cuerpo: { cambiados: 0, version: antes } })
    expect(m.avisos).toEqual([])
  })
})

describe('nombres de mesa que casi se repiten', () => {
  it.each([
    ['solo difiere en mayúsculas', 'T1', 't1'],
    ['solo difiere en mayúsculas (todas)', 'MESA A', 'mesa a'],
    ['con espacios al principio y al final', '70', '  70  '],
    ['con espacios y mayúsculas', 'Barra', ' BARRA '],
  ])('%s: se rechaza', async (_caso, primero, segundo) => {
    const m = await montar()
    const s = m.salon()
    expect((await m.editar([mesa(s, primero)])).codigo).toBe(200)
    const r = await m.editar([mesa(s, segundo)])
    expect(r.codigo).toBe(400)
    expect(r.cuerpo.mensaje).toMatch(/dos mesas que se llaman/)
  })

  it('en el mismo guardado también se detecta, y no se aplica ninguna de las dos', async () => {
    const m = await montar()
    const antes = m.catalogo().mesas.length
    const r = await m.editar([mesa(m.salon(), 'X1'), mesa(m.salon(), 'x1')])
    expect(r.codigo).toBe(400)
    expect(m.catalogo().mesas).toHaveLength(antes)
  })

  it('cambiar los nombres entre dos mesas en un mismo guardado vale (se revisa al final)', async () => {
    const m = await montar()
    const [a, b] = m.catalogo().mesas
    const r = await m.editar([
      { entidad: 'mesa', id: a?.id, datos: { nombre: b?.nombre } },
      { entidad: 'mesa', id: b?.id, datos: { nombre: a?.nombre } },
    ])
    expect(r.codigo).toBe(200)
    const ahora = m.catalogo().mesas
    expect(ahora.find((x) => x.id === a?.id)?.nombre).toBe(b?.nombre)
    expect(ahora.find((x) => x.id === b?.id)?.nombre).toBe(a?.nombre)
  })

  it('renombrar una mesa con el nombre de otra se rechaza; con el de una archivada, no', async () => {
    const m = await montar()
    const [a, b] = m.catalogo().mesas
    const mayusculas = await m.editar([
      { entidad: 'mesa', id: a?.id, datos: { nombre: `${b?.nombre} ` } },
    ])
    expect(mayusculas.codigo).toBe(400)
    await m.editar([{ entidad: 'mesa', id: b?.id, datos: { activo: false } }])
    const libre = await m.editar([
      { entidad: 'mesa', id: a?.id, datos: { nombre: String(b?.nombre) } },
    ])
    expect(libre.codigo).toBe(200)
  })

  it('un nombre solo de espacios, vacío o de más de 20 caracteres se rechaza; de 20 vale', async () => {
    const m = await montar()
    const s = m.salon()
    for (const nombre of ['', '   ', 'x'.repeat(21)])
      expect((await m.editar([mesa(s, nombre)])).codigo, nombre).toBe(400)
    expect((await m.editar([mesa(s, 'y'.repeat(20))])).codigo).toBe(200)
    // El nombre se guarda sin los espacios de los lados.
    expect((await m.editar([mesa(s, '  Alta  ')])).codigo).toBe(200)
    expect(m.catalogo().mesas.some((x) => x.nombre === 'Alta')).toBe(true)
  })

  it('espacios en medio sí hacen otro nombre (no se normalizan)', async () => {
    const m = await montar()
    const s = m.salon()
    expect((await m.editar([mesa(s, 'Mesa 1')])).codigo).toBe(200)
    expect((await m.editar([mesa(s, 'Mesa  1')])).codigo).toBe(200)
  })

  // Lo encontró qa-pruebas en la 1.2 y ya está corregido: lower() de SQLite solo conoce ASCII, así
  // que «Ñandú» y «ñandú» no chocaban en el hub aunque la pantalla sí las viera iguales.
  it('acentos y eñes en mayúscula y minúscula también chocan', async () => {
    const m = await montar()
    const s = m.salon()
    expect((await m.editar([mesa(s, 'Ñandú')])).codigo).toBe(200)
    expect((await m.editar([mesa(s, 'ñandú')])).codigo).toBe(400)
  })

  it('las zonas pueden llamarse igual que una mesa y dos zonas pueden compartir nombre', async () => {
    // Documenta lo que hoy permite el hub: el nombre único es solo de las mesas.
    const m = await montar()
    expect((await m.editar([zona('Salón')])).codigo).toBe(200)
    expect((await m.editar([zona('1')])).codigo).toBe(200)
  })
})

describe('lote grande de cambios', () => {
  it('200 mesas en un solo guardado, con sus números, quedan todas y avisan una sola vez', async () => {
    const m = await montar()
    const s = m.salon()
    const zonaNueva = zona('Eventos')
    const mesas = Array.from({ length: 199 }, (_, i) =>
      mesa(zonaNueva.id, `E${i + 1}`, { x: (i % 20) * 100, y: Math.floor(i / 20) * 100 }),
    )
    const antes = m.catalogo().version
    const r = await m.editar([zonaNueva, ...mesas])
    expect(r).toMatchObject({ codigo: 200, cuerpo: { cambiados: 200 } })
    expect(r.cuerpo.version).toBe(antes + 200)
    expect(m.avisos).toEqual([antes + 200])
    const guardadas = m.catalogo().mesas.filter((x) => x.zonaId === zonaNueva.id)
    expect(guardadas).toHaveLength(199)
    expect(new Set(guardadas.map((x) => x.nombre)).size).toBe(199)
    expect(m.catalogo().mesas.filter((x) => x.zonaId === s)).toHaveLength(25)
    // El mismo guardado otra vez no cambia nada.
    const otra = await m.editar([zonaNueva, ...mesas])
    expect(otra).toMatchObject({ codigo: 200, cuerpo: { cambiados: 0 } })
  })

  it('201 cambios se rechazan enteros', async () => {
    const m = await montar()
    const antes = m.catalogo().version
    const r = await m.editar(Array.from({ length: 201 }, (_, i) => mesa(m.salon(), `Z${i}`)))
    expect(r.codigo).toBe(400)
    expect(m.catalogo().version).toBe(antes)
  })

  it('un solo cambio malo al final de 150 buenos deja todo como estaba', async () => {
    const m = await montar()
    const antes = { version: m.catalogo().version, mesas: m.edicion().mesas.length }
    const buenas = Array.from({ length: 150 }, (_, i) => mesa(m.salon(), `B${i}`))
    const r = await m.editar([...buenas, mesa(m.salon(), 'Mala', { rotacion: 360 })])
    expect(r.codigo).toBe(400)
    expect(m.catalogo().version).toBe(antes.version)
    expect(m.edicion().mesas).toHaveLength(antes.mesas)
  })

  it('un nombre repetido escondido entre 150 mesas nuevas tumba todo el lote', async () => {
    const m = await montar()
    const antes = m.edicion().mesas.length
    const buenas = Array.from({ length: 150 }, (_, i) => mesa(m.salon(), `B${i}`))
    const r = await m.editar([...buenas, mesa(m.salon(), 'b77')])
    expect(r.codigo).toBe(400)
    expect(r.cuerpo.mensaje).toMatch(/dos mesas que se llaman «B77»|«b77»/i)
    expect(m.edicion().mesas).toHaveLength(antes)
  })

  it('archivar las 25 mesas de golpe y crear 25 nuevas con los mismos nombres vale', async () => {
    const m = await montar()
    const s = m.salon()
    const viejas = m.catalogo().mesas
    const r = await m.editar([
      ...viejas.map((x) => ({ entidad: 'mesa', id: x.id, datos: { activo: false } })),
      ...viejas.map((x) => mesa(s, x.nombre, { x: x.x, y: x.y })),
    ])
    expect(r.codigo).toBe(200)
    expect(m.catalogo().mesas).toHaveLength(25)
    expect(m.edicion().mesas).toHaveLength(50)
    expect(new Set(m.catalogo().mesas.map((x) => x.id)).size).toBe(25)
  })

  it('cada registro tocado del lote sube de versión una sola vez y las versiones son distintas', async () => {
    const m = await montar()
    const nuevas = Array.from({ length: 40 }, (_, i) => mesa(m.salon(), `V${i}`))
    await m.editar(nuevas)
    const versiones = m.edicion().mesas.map((x) => Number(x.version))
    expect(new Set(versiones).size).toBe(versiones.length)
    expect(Math.max(...versiones)).toBe(m.catalogo().version)
  })
})

describe('el seed después de dibujar el salón', () => {
  it('lo que una persona movió, renombró o archivó no se pisa al repetir el seed', async () => {
    const m = await montar()
    const [a, b, c] = m.catalogo().mesas
    await m.editar([
      { entidad: 'mesa', id: a?.id, datos: { x: 777, nombre: 'Esquina' } },
      { entidad: 'mesa', id: b?.id, datos: { activo: false } },
    ])
    m.sembrarSalon()
    const ahora = m.edicion().mesas
    expect(ahora.find((x) => x.id === a?.id)).toMatchObject({ x: 777, nombre: 'Esquina' })
    expect(ahora.find((x) => x.id === b?.id)?.activo).toBe(false)
    // La que nadie tocó sigue donde el seed la dejó.
    expect(ahora.find((x) => x.id === c?.id)).toMatchObject({ x: c?.x, y: c?.y, activo: true })
  })

  it('una zona con mesas y elementos dibujada por una persona no se archiva al repetir el seed', async () => {
    const m = await montar()
    const t = zona('Terraza')
    const t1 = mesa(t.id, 'T1')
    const planta = elemento(t.id, { tipo: 'planta' })
    await m.editar([t, t1, planta])
    const antes = m.catalogo()
    const r = m.sembrarSalon()
    expect(r.tablas.zona).toMatchObject({ archivado: 0 })
    const despues = m.catalogo()
    expect(despues.zonas.map((z) => z.nombre)).toEqual(antes.zonas.map((z) => z.nombre))
    expect(despues.mesas.map((x) => x.id).sort()).toEqual(antes.mesas.map((x) => x.id).sort())
    expect(despues.elementos).toEqual(antes.elementos)
  })

  it('si la persona archivó el salón del seed (con sus mesas) y dibujó otro, el seed no lo devuelve', async () => {
    const m = await montar()
    const viejas = m.catalogo().mesas
    const nueva = zona('Nuevo salón', { orden: 0 })
    await m.editar([
      nueva,
      ...viejas.map((x) => ({ entidad: 'mesa', id: x.id, datos: { activo: false } })),
      { entidad: 'zona', id: m.salon(), datos: { activo: false } },
    ])
    m.sembrarSalon()
    expect(m.catalogo().zonas.map((z) => z.nombre)).toEqual(['Nuevo salón'])
    expect(m.catalogo().mesas).toEqual([])
  })
})

describe('lo que ve el editor y lo que ven los equipos', () => {
  it('el editor trae también lo archivado; los equipos, solo lo activo', async () => {
    const m = await montar()
    const t = zona('Terraza')
    const t1 = mesa(t.id, 'T1')
    const pared = elemento(t.id)
    await m.editar([t, t1, pared])
    await m.editar([
      { entidad: 'mesa', id: t1.id, datos: { activo: false } },
      { entidad: 'elemento_plano', id: pared.id, datos: { activo: false } },
      { entidad: 'zona', id: t.id, datos: { activo: false } },
    ])
    const e = m.edicion()
    expect(e.zonas.find((z) => z.id === t.id)).toMatchObject({ activo: false })
    expect(e.mesas.find((x) => x.id === t1.id)).toMatchObject({ activo: false })
    expect(e.elementos.find((x) => x.id === pared.id)).toMatchObject({ activo: false })
    const c = m.catalogo()
    expect(c.zonas.some((z) => z.id === t.id)).toBe(false)
    expect(c.mesas.some((x) => x.id === t1.id)).toBe(false)
    expect(c.elementos).toEqual([])
  })

  it('el editor no entrega la sede, el autor ni la fecha de creación', async () => {
    const m = await montar()
    const e = m.edicion()
    for (const fila of [...e.zonas, ...e.mesas, ...e.elementos]) {
      for (const campo of [
        'sede_id',
        'restaurante_id',
        'usuario_id',
        'dispositivo_id',
        'creado_en',
      ])
        expect(Object.keys(fila)).not.toContain(campo)
    }
  })

  it('las zonas salen por piso, orden y nombre; las mesas de cada zona de arriba a abajo', async () => {
    const m = await montar()
    const alta = zona('Azotea', { piso: 3, orden: 0 })
    const sotano = zona('Sótano', { piso: -1, orden: 5 })
    await m.editar([alta, sotano])
    expect(m.catalogo().zonas.map((z) => z.nombre)).toEqual(['Sótano', 'Salón', 'Azotea'])
    const filas = m.catalogo().mesas.filter((x) => x.zonaId === m.salon())
    const ordenadas = [...filas].sort((p, q) => p.y - q.y || p.x - q.x)
    expect(filas.map((x) => x.id)).toEqual(ordenadas.map((x) => x.id))
  })

  it('un elemento de una zona archivada con elementos activos no sale a los equipos', async () => {
    // El hub deja archivar una zona sin mesas aunque tenga elementos activos; los equipos no los ven.
    const m = await montar()
    const t = zona('Patio')
    const pared = elemento(t.id)
    await m.editar([t, pared])
    const r = await m.editar([{ entidad: 'zona', id: t.id, datos: { activo: false } }])
    expect(r.codigo).toBe(200)
    expect(m.catalogo().elementos).toEqual([])
    expect(m.edicion().elementos.find((e) => e.id === pared.id)?.activo).toBe(true)
  })

  it('crear un elemento en una zona archivada se rechaza', async () => {
    const m = await montar()
    const t = zona('Patio')
    await m.editar([t])
    await m.editar([{ entidad: 'zona', id: t.id, datos: { activo: false } }])
    const r = await m.editar([elemento(t.id)])
    expect(r.codigo).toBe(400)
    expect(r.cuerpo.mensaje).toMatch(/zona está archivado/)
  })
})

describe('elementos del plano: validación', () => {
  it.each([
    ['tipo desconocido', { tipo: 'ventana' }],
    ['texto de más de 60 caracteres', { tipo: 'texto', texto: 'x'.repeat(61) }],
    ['ancho menor al mínimo', { ancho: 4 }],
    ['alto de más de 10 000', { alto: 10_001 }],
    ['coordenada fuera del salón', { x: 10_001 }],
    ['coordenada con decimales', { y: 1.5 }],
    ['rotación negativa', { rotacion: -1 }],
    ['campo que no existe', { color: 'rojo' }],
  ])('%s se rechaza', async (_caso, campos) => {
    const m = await montar()
    const antes = m.catalogo().version
    expect((await m.editar([elemento(m.salon(), campos)])).codigo).toBe(400)
    expect(m.catalogo().version).toBe(antes)
  })

  it('un elemento sin zona o sin ancho se rechaza al crearlo (pide todos los campos)', async () => {
    const m = await montar()
    const incompleto = { entidad: 'elemento_plano', id: nuevoId(), datos: { tipo: 'pared' } }
    expect((await m.editar([incompleto])).codigo).toBe(400)
  })

  it('el id de un elemento puede coincidir con el de una mesa: son tablas distintas y no se cruzan', async () => {
    // Hoy el hub solo revisa que un id no sea de dos tipos en el historial del catálogo, y el
    // plano no entra en él. Se deja dicho para que un cambio futuro sea consciente.
    const m = await montar()
    const uno = m.catalogo().mesas[0]
    const r = await m.editar([{ ...elemento(m.salon()), id: uno?.id }])
    expect(r.codigo).toBe(200)
    expect(m.catalogo().mesas.find((x) => x.id === uno?.id)?.nombre).toBe(uno?.nombre)
    expect(m.catalogo().elementos.some((e) => e.id === uno?.id)).toBe(true)
  })

  it('se actualiza de a pedazos y se archiva', async () => {
    const m = await montar()
    const e = elemento(m.salon(), { tipo: 'texto', texto: 'Baños' })
    await m.editar([e])
    expect(
      (await m.editar([{ entidad: 'elemento_plano', id: e.id, datos: { x: 40 } }])).codigo,
    ).toBe(200)
    expect(m.catalogo().elementos[0]).toMatchObject({ texto: 'Baños', x: 40 })
    expect(
      (await m.editar([{ entidad: 'elemento_plano', id: e.id, datos: { activo: false } }])).codigo,
    ).toBe(200)
    expect(m.catalogo().elementos).toEqual([])
  })

  it('el texto de un elemento llega sin espacios en los lados', async () => {
    const m = await montar()
    await m.editar([elemento(m.salon(), { tipo: 'texto', texto: '  Baños  ' })])
    expect(m.catalogo().elementos[0]?.texto).toBe('Baños')
  })
})
