import { LIMITE_PRECIO } from '@pos/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  type BorradorGrupo,
  type BorradorProducto,
  borradorDeGrupo,
  borradorDeProducto,
  cambiosDeGrupo,
  cambiosDeProducto,
  grupoNuevo,
  leerPesos,
  problemasDeGrupo,
  problemasDeProducto,
  productoNuevo,
} from './borradores'
import type { CambioCatalogo, CatalogoEdicion } from './motor'

// Propiedad central del editor de la carta: aplicar al catálogo los cambios que salen de un
// borrador deja un borrador igual al editado. Para "aplicar" se usa un hub de referencia que
// sigue las reglas de `apps/hub/src/edicion-catalogo.ts` (campos completos al crear, el padre no
// cambia, un enlace por par, nada activo apunta a algo archivado). Semilla fija: determinista.

const SEMILLA = 20_261_024
const CORRIDAS = 300

// ── Hub de referencia ────────────────────────────────────────────────────────────────────────

type Entidad = CambioCatalogo['entidad']
type Registro = Record<string, string | number | boolean | null>

const TABLA: Record<Entidad, keyof Omit<CatalogoEdicion, 'version'>> = {
  zona: 'zonas',
  mesa: 'mesas',
  elemento_plano: 'elementos',
  impuesto: 'impuestos',
  estacion: 'estaciones',
  categoria: 'categorias',
  producto: 'productos',
  variante: 'variantes',
  grupo_modificador: 'grupos',
  producto_grupo_modificador: 'enlaces',
  modificador: 'modificadores',
}

const CAMPOS: Record<Entidad, string[]> = {
  zona: ['nombre', 'orden', 'piso', 'activo'],
  mesa: [
    'zona_id',
    'nombre',
    'forma',
    'x',
    'y',
    'ancho',
    'alto',
    'rotacion',
    'capacidad',
    'activo',
  ],
  elemento_plano: ['zona_id', 'tipo', 'texto', 'x', 'y', 'ancho', 'alto', 'rotacion', 'activo'],
  impuesto: ['nombre', 'tipo', 'tarifa', 'activo'],
  estacion: ['nombre', 'orden', 'activo'],
  categoria: ['nombre', 'orden', 'estacion_id', 'activo'],
  producto: [
    'categoria_id',
    'nombre',
    'descripcion',
    'precio',
    'impuesto_id',
    'favorito',
    'activo',
  ],
  variante: ['producto_id', 'nombre', 'precio', 'orden', 'activo'],
  grupo_modificador: ['nombre', 'minimo', 'maximo', 'activo'],
  producto_grupo_modificador: ['producto_id', 'grupo_id', 'orden', 'activo'],
  modificador: ['grupo_id', 'nombre', 'precio_extra', 'orden', 'activo'],
}

const PADRES: Partial<Record<Entidad, string[]>> = {
  variante: ['producto_id'],
  modificador: ['grupo_id'],
  producto_grupo_modificador: ['producto_id', 'grupo_id'],
}

const REFERENCIAS: Record<string, keyof Omit<CatalogoEdicion, 'version'>> = {
  estacion_id: 'estaciones',
  categoria_id: 'categorias',
  impuesto_id: 'impuestos',
  producto_id: 'productos',
  grupo_id: 'grupos',
}

const entero = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

function validar(entidad: Entidad, r: Registro, donde: string) {
  const malo = (campo: string) => {
    throw new Error(`${donde}: ${campo} inválido (${String(r[campo])})`)
  }
  if ('nombre' in r) {
    const n = String(r.nombre)
    if (n !== n.trim() || n.length < 1 || n.length > 80) malo('nombre')
  }
  for (const campo of ['precio', 'precio_extra'])
    if (campo in r && !entero(r[campo], 0, LIMITE_PRECIO)) malo(campo)
  if ('orden' in r && !entero(r.orden, 0, 10_000)) malo('orden')
  if (
    typeof r.descripcion === 'string' &&
    (r.descripcion !== r.descripcion.trim() || r.descripcion.length > 300)
  )
    malo('descripcion')
  if (typeof r.activo !== 'boolean') malo('activo')
  if (entidad === 'grupo_modificador') {
    if (!entero(r.minimo, 0, 20)) malo('minimo')
    if (!entero(r.maximo, 1, 20) || (r.maximo as number) < (r.minimo as number)) malo('maximo')
  }
}

/** Aplica los cambios como lo haría el hub; lanza si el hub los rechazaría (o si sobra algo). */
function aplicar(origen: CatalogoEdicion, cambios: CambioCatalogo[]): CatalogoEdicion {
  const c = structuredClone(origen)
  let version = c.version
  const tocados: { entidad: Entidad; id: string; donde: string }[] = []
  const tabla = (e: Entidad) => c[TABLA[e]] as unknown as (Registro & { id: string })[]

  for (const [i, cambio] of cambios.entries()) {
    const donde = `Cambio ${i + 1} (${cambio.entidad})`
    const claves = Object.keys(cambio.datos)
    if (claves.length === 0) throw new Error(`${donde}: no cambia nada`)
    for (const k of claves)
      if (!CAMPOS[cambio.entidad].includes(k)) throw new Error(`${donde}: campo ${k} no existe`)
    for (const [campo, destino] of Object.entries(REFERENCIAS)) {
      const valor = cambio.datos[campo]
      if (
        typeof valor === 'string' &&
        !(c[destino] as { id: string }[]).some((x) => x.id === valor)
      )
        throw new Error(`${donde}: ${campo} no existe`)
    }
    const filas = tabla(cambio.entidad)
    const actual = filas.find((f) => f.id === cambio.id)
    if (!actual) {
      for (const k of CAMPOS[cambio.entidad])
        if (!(k in cambio.datos)) throw new Error(`${donde}: falta ${k} al crear`)
      const nueva = { id: cambio.id, version: ++version, ...cambio.datos } as Registro & {
        id: string
      }
      validar(cambio.entidad, nueva, donde)
      filas.push(nueva)
    } else {
      for (const k of PADRES[cambio.entidad] ?? [])
        if (k in cambio.datos && cambio.datos[k] !== actual[k])
          throw new Error(`${donde}: no se puede cambiar ${k}`)
      const cambia = Object.entries(cambio.datos).filter(([k, v]) => actual[k] !== v)
      // El hub lo toleraría, pero un borrador no debe mandar campos que no cambiaron.
      if (cambia.length !== claves.length) throw new Error(`${donde}: manda campos sin cambio`)
      Object.assign(actual, cambio.datos, { version: ++version })
      validar(cambio.entidad, actual, donde)
    }
    if (cambio.entidad === 'producto_grupo_modificador') {
      const par = (f: Registro) => `${f.producto_id}|${f.grupo_id}`
      const mismos = tabla('producto_grupo_modificador').filter(
        (f) =>
          par(f) ===
          par(tabla('producto_grupo_modificador').find((x) => x.id === cambio.id) as Registro),
      )
      if (mismos.length > 1) throw new Error(`${donde}: ese producto ya tiene ese grupo`)
    }
    tocados.push({ entidad: cambio.entidad, id: cambio.id, donde })
  }

  for (const t of tocados) {
    const fila = tabla(t.entidad).find((f) => f.id === t.id) as Registro
    if (fila.activo === true) {
      for (const [campo, destino] of Object.entries(REFERENCIAS)) {
        const ref = fila[campo]
        const padre =
          typeof ref === 'string'
            ? (c[destino] as unknown as Registro[]).find((x) => x.id === ref)
            : null
        if (typeof ref === 'string' && padre?.activo !== true)
          throw new Error(`${t.donde}: ${campo.replace('_id', '')} está archivado`)
      }
    } else if (t.entidad === 'grupo_modificador') {
      for (const e of c.enlaces) if (e.grupo_id === t.id && e.activo) e.activo = false
    }
  }
  c.version = version
  return c
}

// ── Generadores ──────────────────────────────────────────────────────────────────────────────

const arbBase = fc.stringMatching(/^[A-Za-zñÑáéíóú]{1,12}$/)
const arbEspacios = fc.constantFrom('', ' ', '  ', '\t')
/** Un nombre válido con espacios de sobra a los lados: el borrador los recorta al guardar. */
const arbNombre = fc.tuple(arbEspacios, arbBase, arbEspacios).map(([a, b, c]) => `${a}${b}${c}`)
const arbDescripcion = fc.oneof(
  fc.constant(''),
  fc.constant('   '),
  fc.stringMatching(/^[A-Za-z ,.]{1,40}$/),
)
const arbPrecio = fc.integer({ min: 0, max: 400_000 })
const arbPrecioPositivo = fc.integer({ min: 1, max: 400_000 })
const reg = (id: string, activo: boolean) => ({ id, version: 1, activo })

interface SemillaEdicion {
  activosImp: boolean[]
  activasCat: boolean[]
  productos: {
    activo: boolean
    precio: number
    desc: string | null
    variantes: { precio: number; activa: boolean }[]
  }[]
  grupos: {
    activo: boolean
    min: number
    max: number
    opciones: { activa: boolean; extra: number }[]
  }[]
  enlaces: { activo: boolean; usa: boolean }[][]
}

const arbSemilla: fc.Arbitrary<SemillaEdicion> = fc.record({
  activosImp: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
  activasCat: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
  productos: fc.array(
    fc.record({
      activo: fc.boolean(),
      precio: arbPrecio,
      desc: fc.option(fc.stringMatching(/^[A-Za-z]{1,10}$/), { nil: null }),
      variantes: fc.array(fc.record({ precio: arbPrecioPositivo, activa: fc.boolean() }), {
        maxLength: 4,
      }),
    }),
    { minLength: 4, maxLength: 4 },
  ),
  grupos: fc.array(
    fc.record({
      activo: fc.boolean(),
      min: fc.integer({ min: 0, max: 2 }),
      max: fc.integer({ min: 2, max: 5 }),
      opciones: fc.array(fc.record({ activa: fc.boolean(), extra: arbPrecio }), {
        minLength: 1,
        maxLength: 5,
      }),
    }),
    { minLength: 3, maxLength: 3 },
  ),
  enlaces: fc.array(
    fc.array(fc.record({ activo: fc.boolean(), usa: fc.boolean() }), {
      minLength: 3,
      maxLength: 3,
    }),
    { minLength: 4, maxLength: 4 },
  ),
})

/**
 * Un catálogo coherente: lo activo apunta a lo activo, siempre hay un impuesto y una categoría
 * activos. Con `contiguo` (lo normal), el `orden` de lo activo es 0, 1, 2… y lo archivado va al
 * final; sin él, lo archivado queda en su lugar (como tras archivar un tamaño del medio).
 */
function edicionDe(s: SemillaEdicion, contiguo = true): CatalogoEdicion {
  const acomodar = <T extends { activa: boolean }>(lista: T[]) =>
    contiguo ? [...lista.filter((x) => x.activa), ...lista.filter((x) => !x.activa)] : lista
  const impuestos = s.activosImp.map((a, i) => ({
    ...reg(`IMP${i}`, i === 0 || a),
    nombre: `INC ${i}`,
    tipo: 'inc' as const,
    tarifa: 800,
  }))
  const categorias = s.activasCat.map((a, i) => ({
    ...reg(`CAT${i}`, i === 0 || a),
    nombre: `Cat ${i}`,
    orden: i,
    estacion_id: null,
  }))
  const grupos = s.grupos.map((g, i) => ({
    ...reg(`GRP${i}`, i === 0 || g.activo),
    nombre: `Grupo ${i}`,
    minimo: 0,
    maximo: Math.max(g.max, g.min, 1),
  }))
  const modificadores = s.grupos.flatMap((g, gi) =>
    acomodar(g.opciones).map((o, oi) => ({
      ...reg(`MOD${gi}_${oi}`, o.activa && grupos[gi]?.activo === true),
      grupo_id: `GRP${gi}`,
      nombre: `Opción ${gi}.${oi}`,
      precio_extra: o.extra,
      orden: oi,
    })),
  )
  const productos = s.productos.map((p, i) => {
    const activos = impuestos.filter((x) => x.activo)
    const cats = categorias.filter((x) => x.activo)
    const activo = p.activo
    // Con tamaños activos, el precio del producto es el del más barato (docs/DINERO.md).
    const desde = p.variantes.filter((v) => v.activa && activo).map((v) => v.precio)
    return {
      ...reg(`PRO${i}`, activo),
      categoria_id: (cats[i % cats.length] ?? categorias[0])?.id as string,
      nombre: `Producto ${i}`,
      descripcion: p.desc,
      precio: desde.length > 0 ? Math.min(...desde) : p.precio,
      impuesto_id: (activos[i % activos.length] ?? impuestos[0])?.id as string,
      favorito: false,
    }
  })
  const variantes = s.productos.flatMap((p, pi) =>
    acomodar(p.variantes).map((v, vi) => ({
      ...reg(`VAR${pi}_${vi}`, v.activa && productos[pi]?.activo === true),
      producto_id: `PRO${pi}`,
      nombre: `Tamaño ${vi}`,
      precio: v.precio,
      orden: vi,
    })),
  )
  const enlaces = s.enlaces.flatMap((fila, pi) =>
    acomodar(
      fila
        .map((e, gi) => ({
          e,
          gi,
          activa: e.activo && productos[pi]?.activo === true && grupos[gi]?.activo === true,
        }))
        .filter(({ e }) => e.usa),
    ).map(({ gi, activa }, orden) => ({
      ...reg(`ENL${pi}_${gi}`, activa),
      producto_id: `PRO${pi}`,
      grupo_id: `GRP${gi}`,
      orden,
    })),
  )
  return {
    version: 100,
    zonas: [],
    mesas: [],
    elementos: [],
    impuestos,
    estaciones: [],
    categorias,
    productos,
    variantes,
    grupos,
    enlaces,
    modificadores,
  }
}

// ── Cómo queda un borrador después de guardarlo ──────────────────────────────────────────────

/** El borrador tal como se vuelve a leer tras guardar: recortado, sin lo archivado, con el precio "desde". */
function comoQuedaProducto(b: BorradorProducto): BorradorProducto {
  const activas = b.variantes.filter((v) => v.activo)
  return {
    id: b.id,
    nuevo: false,
    nombre: b.nombre.trim(),
    descripcion: b.descripcion.trim(),
    categoriaId: b.categoriaId,
    precio: activas.length > 0 ? Math.min(...activas.map((v) => v.precio)) : b.precio,
    impuestoId: b.impuestoId,
    activo: b.activo,
    variantes: activas.map((v) => ({
      id: v.id,
      nuevo: false,
      nombre: v.nombre.trim(),
      precio: v.precio,
      activo: true,
    })),
    grupos: [...b.grupos],
  }
}

function comoQuedaGrupo(g: BorradorGrupo): BorradorGrupo {
  return {
    id: g.id,
    nuevo: false,
    nombre: g.nombre.trim(),
    minimo: g.minimo,
    maximo: g.maximo,
    activo: g.activo,
    opciones: g.opciones
      .filter((o) => o.activo)
      .map((o) => ({
        id: o.id,
        nuevo: false,
        nombre: o.nombre.trim(),
        precioExtra: o.precioExtra,
        activo: true,
      })),
  }
}

const ordenar = <T>(lista: T[], claves: number[]): T[] =>
  lista
    .map((x, i) => ({ x, k: claves[i % Math.max(claves.length, 1)] ?? 0, i }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map(({ x }) => x)

// ── Producto ─────────────────────────────────────────────────────────────────────────────────

interface EdicionProducto {
  indice: number
  nombre: string | null
  descripcion: string | null
  precio: number | null
  categoria: number | null
  impuesto: number | null
  activo: boolean | null
  variantes: { nombre: string | null; precio: number | null; activo: boolean | null }[]
  nuevas: { precio: number; activo: boolean }[]
  clavesVariantes: number[]
  grupos: boolean[]
  clavesGrupos: number[]
}

const arbEdicionProducto: fc.Arbitrary<EdicionProducto> = fc.record({
  indice: fc.integer({ min: 0, max: 3 }),
  nombre: fc.option(arbNombre, { nil: null }),
  descripcion: fc.option(arbDescripcion, { nil: null }),
  precio: fc.option(arbPrecio, { nil: null }),
  categoria: fc.option(fc.nat(5), { nil: null }),
  impuesto: fc.option(fc.nat(5), { nil: null }),
  activo: fc.option(fc.boolean(), { nil: null }),
  variantes: fc.array(
    fc.record({
      nombre: fc.option(arbBase, { nil: null }),
      precio: fc.option(arbPrecioPositivo, { nil: null }),
      activo: fc.option(fc.boolean(), { nil: null }),
    }),
    { maxLength: 4 },
  ),
  nuevas: fc.array(fc.record({ precio: arbPrecioPositivo, activo: fc.boolean() }), {
    maxLength: 3,
  }),
  clavesVariantes: fc.array(fc.nat(3), { maxLength: 8 }),
  grupos: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
  clavesGrupos: fc.array(fc.nat(3), { maxLength: 3 }),
})

/** Edita el borrador de un producto existente como lo haría la persona en pantalla. */
function editarProducto(c: CatalogoEdicion, e: EdicionProducto): BorradorProducto {
  const b = borradorDeProducto(c, `PRO${e.indice}`)
  const impuestos = c.impuestos.filter((x) => x.activo)
  const categorias = c.categorias.filter((x) => x.activo)
  if (e.nombre !== null) b.nombre = e.nombre
  if (e.descripcion !== null) b.descripcion = e.descripcion
  if (e.precio !== null) b.precio = e.precio
  if (e.categoria !== null)
    b.categoriaId = categorias[e.categoria % categorias.length]?.id ?? b.categoriaId
  if (e.impuesto !== null)
    b.impuestoId = impuestos[e.impuesto % impuestos.length]?.id ?? b.impuestoId
  if (e.activo !== null) b.activo = e.activo
  b.variantes.forEach((v, i) => {
    const ed = e.variantes[i]
    if (!ed) return
    // Nombres distintos por tamaño: el borrador no deja guardar dos iguales.
    if (ed.nombre !== null) v.nombre = `${ed.nombre} ${i}`
    if (ed.precio !== null) v.precio = ed.precio
    if (ed.activo !== null) v.activo = ed.activo
  })
  for (const [i, n] of e.nuevas.entries())
    b.variantes.push({
      id: `NUEVA${i}`,
      nuevo: true,
      nombre: `Nueva ${i}`,
      precio: n.precio,
      activo: n.activo,
    })
  b.variantes = ordenar(b.variantes, e.clavesVariantes)
  const grupos = c.grupos.filter((g) => g.activo)
  b.grupos = ordenar(
    grupos.filter((_, i) => e.grupos[i]).map((g) => g.id),
    e.clavesGrupos,
  )
  // Un producto archivado no se toca por dentro (el hub no deja cambiar lo activo bajo algo
  // archivado): ver «archivar y cambiar un tamaño a la vez» en los tests del hub.
  if (!b.activo) {
    const original = borradorDeProducto(c, b.id)
    b.variantes = original.variantes
    b.grupos = original.grupos
  }
  return b
}

describe('producto: lo que se guarda es lo que se editó', () => {
  it('aplicar los cambios deja un borrador igual al editado', () => {
    fc.assert(
      fc.property(arbSemilla, arbEdicionProducto, (semilla, edicion) => {
        const c = edicionDe(semilla)
        const b = editarProducto(c, edicion)
        fc.pre(problemasDeProducto(b).length === 0)

        const despues = aplicar(c, cambiosDeProducto(c, b))

        expect(borradorDeProducto(despues, b.id)).toEqual(comoQuedaProducto(b))
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('sin tocar nada no hay cambios, en cualquier catálogo', () => {
    fc.assert(
      fc.property(arbSemilla, fc.integer({ min: 0, max: 3 }), (semilla, i) => {
        const c = edicionDe(semilla)
        expect(cambiosDeProducto(c, borradorDeProducto(c, `PRO${i}`))).toEqual([])
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('un producto no queda con dos enlaces al mismo grupo ni toca lo que no es suyo', () => {
    fc.assert(
      fc.property(arbSemilla, arbEdicionProducto, (semilla, edicion) => {
        const c = edicionDe(semilla)
        const b = editarProducto(c, edicion)
        fc.pre(problemasDeProducto(b).length === 0)
        const cambios = cambiosDeProducto(c, b)
        const despues = aplicar(c, cambios)

        const pares = despues.enlaces.map((e) => `${e.producto_id}|${e.grupo_id}`)
        expect(new Set(pares).size).toBe(pares.length)
        // Los cambios solo tocan este producto, sus variantes y sus enlaces.
        for (const cambio of cambios) {
          if (cambio.entidad === 'producto') expect(cambio.id).toBe(b.id)
          else if (
            cambio.entidad === 'variante' ||
            cambio.entidad === 'producto_grupo_modificador'
          ) {
            const fila = (cambio.entidad === 'variante' ? despues.variantes : despues.enlaces).find(
              (x) => x.id === cambio.id,
            )
            expect(fila?.producto_id).toBe(b.id)
          } else throw new Error(`Cambio inesperado: ${cambio.entidad}`)
        }
        // Los demás productos quedan igual.
        for (const p of c.productos.filter((x) => x.id !== b.id))
          expect(borradorDeProducto(despues, p.id).nombre).toBe(borradorDeProducto(c, p.id).nombre)
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('un producto nuevo, con tamaños y grupos, se guarda completo', () => {
    fc.assert(
      fc.property(
        arbSemilla,
        arbNombre,
        arbDescripcion,
        arbPrecioPositivo,
        fc.array(fc.record({ precio: arbPrecioPositivo, activa: fc.boolean() }), { maxLength: 3 }),
        fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
        (semilla, nombre, descripcion, precio, tamanos, grupos) => {
          const c = edicionDe(semilla)
          const categoria = c.categorias.find((x) => x.activo)?.id as string
          const b = productoNuevo(c, categoria)
          b.nombre = nombre
          b.descripcion = descripcion
          b.precio = precio
          b.variantes = tamanos.map((t, i) => ({
            id: `NV${i}`,
            nuevo: true,
            nombre: `Tamaño nuevo ${i}`,
            precio: t.precio,
            activo: t.activa,
          }))
          b.grupos = c.grupos.filter((g, i) => g.activo && grupos[i]).map((g) => g.id)
          expect(problemasDeProducto(b)).toEqual([])

          const cambios = cambiosDeProducto(c, b)
          const despues = aplicar(c, cambios)

          expect(borradorDeProducto(despues, b.id)).toEqual(comoQuedaProducto(b))
          // Lo primero es el producto: sus variantes y enlaces lo necesitan.
          expect(cambios[0]).toMatchObject({ entidad: 'producto', id: b.id })
          // Una variante nueva que se quitó antes de guardar no viaja.
          const quitadas = b.variantes.filter((v) => !v.activo).map((v) => v.id)
          expect(cambios.some((x) => quitadas.includes(x.id))).toBe(false)
        },
      ),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('volver a poner un grupo que se había quitado reactiva su enlace, no crea otro', () => {
    fc.assert(
      fc.property(arbSemilla, fc.integer({ min: 0, max: 3 }), (semilla, i) => {
        const c = edicionDe(semilla)
        const id = `PRO${i}`
        const antes = borradorDeProducto(c, id)
        // Se quitan todos los grupos y se guarda; luego se vuelven a poner los mismos.
        const sin = { ...antes, grupos: [] }
        const c2 = aplicar(c, cambiosDeProducto(c, sin))
        const de_nuevo = { ...borradorDeProducto(c2, id), grupos: antes.grupos }
        const c3 = aplicar(c2, cambiosDeProducto(c2, de_nuevo))

        expect(borradorDeProducto(c3, id).grupos).toEqual(antes.grupos)
        expect(c3.enlaces.length).toBe(c.enlaces.length)
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })
})

// ── Grupo de opciones ────────────────────────────────────────────────────────────────────────

interface EdicionGrupo {
  indice: number
  nombre: string | null
  minimo: number | null
  maximo: number | null
  activo: boolean | null
  opciones: { nombre: string | null; extra: number | null; activa: boolean | null }[]
  nuevas: { extra: number; activa: boolean }[]
  claves: number[]
}

const arbEdicionGrupo: fc.Arbitrary<EdicionGrupo> = fc.record({
  indice: fc.integer({ min: 0, max: 2 }),
  nombre: fc.option(arbNombre, { nil: null }),
  minimo: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }),
  maximo: fc.option(fc.integer({ min: 1, max: 8 }), { nil: null }),
  activo: fc.option(fc.boolean(), { nil: null }),
  opciones: fc.array(
    fc.record({
      nombre: fc.option(arbBase, { nil: null }),
      extra: fc.option(arbPrecio, { nil: null }),
      activa: fc.option(fc.boolean(), { nil: null }),
    }),
    { maxLength: 5 },
  ),
  nuevas: fc.array(fc.record({ extra: arbPrecio, activa: fc.boolean() }), { maxLength: 3 }),
  claves: fc.array(fc.nat(3), { maxLength: 8 }),
})

function editarGrupo(c: CatalogoEdicion, e: EdicionGrupo): BorradorGrupo {
  const g = borradorDeGrupo(c, `GRP${e.indice}`)
  if (e.nombre !== null) g.nombre = e.nombre
  if (e.minimo !== null) g.minimo = e.minimo
  if (e.maximo !== null) g.maximo = e.maximo
  if (e.activo !== null) g.activo = e.activo
  g.opciones.forEach((o, i) => {
    const ed = e.opciones[i]
    if (!ed) return
    if (ed.nombre !== null) o.nombre = `${ed.nombre} ${i}`
    if (ed.extra !== null) o.precioExtra = ed.extra
    if (ed.activa !== null) o.activo = ed.activa
  })
  for (const [i, n] of e.nuevas.entries())
    g.opciones.push({
      id: `NUEVAOP${i}`,
      nuevo: true,
      nombre: `Nueva ${i}`,
      precioExtra: n.extra,
      activo: n.activa,
    })
  g.opciones = ordenar(g.opciones, e.claves)
  // Un grupo archivado no se toca por dentro (ver «archivar y cambiar a la vez» más abajo).
  if (!g.activo) g.opciones = borradorDeGrupo(c, g.id).opciones
  return g
}

describe('grupo de opciones: lo que se guarda es lo que se editó', () => {
  it('aplicar los cambios deja un borrador igual al editado', () => {
    fc.assert(
      fc.property(arbSemilla, arbEdicionGrupo, (semilla, edicion) => {
        const c = edicionDe(semilla)
        const g = editarGrupo(c, edicion)
        fc.pre(problemasDeGrupo(g).length === 0)

        const despues = aplicar(c, cambiosDeGrupo(c, g))

        expect(borradorDeGrupo(despues, g.id)).toEqual(comoQuedaGrupo(g))
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('sin tocar nada no hay cambios', () => {
    fc.assert(
      fc.property(arbSemilla, fc.integer({ min: 0, max: 2 }), (semilla, i) => {
        const c = edicionDe(semilla)
        expect(cambiosDeGrupo(c, borradorDeGrupo(c, `GRP${i}`))).toEqual([])
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('un grupo nuevo con opciones se guarda completo y no deja opciones quitadas', () => {
    fc.assert(
      fc.property(
        arbSemilla,
        arbNombre,
        fc.array(fc.record({ extra: arbPrecio, activa: fc.boolean() }), {
          minLength: 1,
          maxLength: 5,
        }),
        fc.integer({ min: 0, max: 2 }),
        fc.integer({ min: 1, max: 5 }),
        (semilla, nombre, opciones, minimo, maximo) => {
          const c = edicionDe(semilla)
          const g = grupoNuevo()
          g.nombre = nombre
          g.opciones = opciones.map((o, i) => ({
            id: `OP${i}`,
            nuevo: true,
            nombre: `Opción ${i}`,
            precioExtra: o.extra,
            activo: o.activa,
          }))
          g.minimo = minimo
          g.maximo = Math.max(maximo, minimo, 1)
          fc.pre(problemasDeGrupo(g).length === 0)

          const cambios = cambiosDeGrupo(c, g)
          const despues = aplicar(c, cambios)

          expect(borradorDeGrupo(despues, g.id)).toEqual(comoQuedaGrupo(g))
          expect(cambios[0]).toMatchObject({ entidad: 'grupo_modificador', id: g.id })
          const quitadas = g.opciones.filter((o) => !o.activo).map((o) => o.id)
          expect(cambios.some((x) => quitadas.includes(x.id))).toBe(false)
        },
      ),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('el orden de las opciones se conserva tras guardar', () => {
    fc.assert(
      fc.property(
        arbSemilla,
        fc.array(fc.nat(9), { minLength: 1, maxLength: 8 }),
        (semilla, claves) => {
          const c = edicionDe(semilla)
          const g = borradorDeGrupo(c, 'GRP0')
          g.opciones = ordenar(g.opciones, claves)
          const despues = aplicar(c, cambiosDeGrupo(c, g))
          expect(borradorDeGrupo(despues, g.id).opciones.map((o) => o.id)).toEqual(
            g.opciones.map((o) => o.id),
          )
        },
      ),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })
})

// ── Hallazgos: el orden tras archivar ────────────────────────────────────────────────────────
// Estas pruebas dicen cómo DEBE comportarse el editor; hoy fallan (ver el informe de QA).

describe('orden de tamaños y opciones cuando hay archivados en medio', () => {
  /** Un producto con tres tamaños; el del medio fue archivado antes (orden 0, 1 archivado, 2). */
  function conTamanoArchivado(): CatalogoEdicion {
    const c = edicionDe(
      fc.sample(arbSemilla, { seed: SEMILLA, numRuns: 1 })[0] as SemillaEdicion,
      false,
    )
    c.variantes = c.variantes.filter((v) => v.producto_id !== 'PRO0')
    c.variantes.push(
      { ...reg('V0', true), producto_id: 'PRO0', nombre: 'Copa', precio: 10, orden: 0 },
      { ...reg('V1', false), producto_id: 'PRO0', nombre: 'Media', precio: 20, orden: 1 },
      { ...reg('V2', true), producto_id: 'PRO0', nombre: 'Botella', precio: 30, orden: 2 },
    )
    const p = c.productos.find((x) => x.id === 'PRO0')
    if (p) {
      p.activo = true
      p.precio = 10
    }
    return c
  }

  it('abrir un producto con un tamaño archivado antes y guardar sin editar no manda nada', () => {
    const c = conTamanoArchivado()
    expect(cambiosDeProducto(c, borradorDeProducto(c, 'PRO0'))).toEqual([])
  })

  it('archivar ese producto no toca sus tamaños (el hub no deja tocar lo activo bajo algo archivado)', () => {
    const c = conTamanoArchivado()
    const b = borradorDeProducto(c, 'PRO0')
    b.activo = false
    const cambios = cambiosDeProducto(c, b)
    expect(cambios.map((x) => x.entidad)).toEqual(['producto'])
    expect(() => aplicar(c, cambios)).not.toThrow()
  })

  it('archivar un producto y cambiar el precio de un tamaño a la vez no manda lo que el hub rechaza', () => {
    const c = edicionDe(fc.sample(arbSemilla, { seed: SEMILLA, numRuns: 1 })[0] as SemillaEdicion)
    c.variantes = c.variantes.filter((v) => v.producto_id !== 'PRO0')
    c.variantes.push({
      ...reg('V0', true),
      producto_id: 'PRO0',
      nombre: 'Copa',
      precio: 10,
      orden: 0,
    })
    const p = c.productos.find((x) => x.id === 'PRO0')
    if (p) {
      p.activo = true
      p.precio = 10
    }
    const b = borradorDeProducto(c, 'PRO0')
    b.activo = false
    const copa = b.variantes[0]
    if (!copa) throw new Error('falta')
    copa.precio = 12
    expect(() => aplicar(c, cambiosDeProducto(c, b))).not.toThrow()
  })

  it('archivar un grupo y cambiar el precio de una opción a la vez no manda lo que el hub rechaza', () => {
    const c = edicionDe(fc.sample(arbSemilla, { seed: SEMILLA, numRuns: 1 })[0] as SemillaEdicion)
    const g = borradorDeGrupo(c, 'GRP0')
    g.activo = false
    const opcion = g.opciones[0]
    if (!opcion) throw new Error('falta')
    opcion.precioExtra += 500
    expect(() => aplicar(c, cambiosDeGrupo(c, g))).not.toThrow()
  })

  it('guardar dos veces: la segunda no manda nada, aunque se haya archivado un tamaño del medio', () => {
    fc.assert(
      fc.property(arbSemilla, arbEdicionProducto, (semilla, edicion) => {
        const c = edicionDe(semilla)
        const b = editarProducto(c, edicion)
        fc.pre(problemasDeProducto(b).length === 0)
        const despues = aplicar(c, cambiosDeProducto(c, b))

        expect(cambiosDeProducto(despues, borradorDeProducto(despues, b.id))).toEqual([])
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('lo mismo con las opciones de un grupo', () => {
    fc.assert(
      fc.property(arbSemilla, arbEdicionGrupo, (semilla, edicion) => {
        const c = edicionDe(semilla)
        const g = editarGrupo(c, edicion)
        fc.pre(problemasDeGrupo(g).length === 0)
        const despues = aplicar(c, cambiosDeGrupo(c, g))

        expect(cambiosDeGrupo(despues, borradorDeGrupo(despues, g.id))).toEqual([])
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })
})

describe('leerPesos', () => {
  const conPuntos = (n: number) => n.toLocaleString('es-CO').replace(/\s/g, '')

  it('lee lo que escribe la persona: el número con puntos de miles, con $ o con espacios', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: LIMITE_PRECIO }), (n) => {
        const base = conPuntos(n)
        expect(leerPesos(base)).toBe(n)
        expect(leerPesos(`$ ${base}`)).toBe(n)
        expect(leerPesos(`  $${base}  `)).toBe(n)
        expect(leerPesos(String(n))).toBe(n)
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    )
  })

  it('nunca devuelve algo que no sea un monto entero válido', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), (texto) => {
        const v = leerPesos(texto)
        if (v === null) return
        expect(Number.isInteger(v)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(LIMITE_PRECIO)
      }),
      { seed: SEMILLA, numRuns: 1_000 },
    )
  })

  it('no confunde decimales con miles ni acepta coma, signo o notación científica', () => {
    for (const t of [
      '1.5',
      '40.90',
      '1,5',
      '40,900',
      '-5',
      '+5',
      '1e3',
      '0x10',
      '1..000',
      '.500',
      '1.0000',
      '١٢٣',
    ])
      expect(leerPesos(t), t).toBeNull()
  })
})

describe('el generador y el hub de referencia', () => {
  it('rechaza lo que el hub rechazaría: crear sin todos los campos y cambiar el padre', () => {
    const c = edicionDe(fc.sample(arbSemilla, { seed: SEMILLA, numRuns: 1 })[0] as SemillaEdicion)
    expect(() =>
      aplicar(c, [{ entidad: 'variante', id: 'X', datos: { producto_id: 'PRO0' } }]),
    ).toThrow(/falta/)
    expect(() =>
      aplicar(c, [{ entidad: 'variante', id: 'VAR0_0', datos: { producto_id: 'PRO1' } }]),
    ).toThrow()
    expect(() =>
      aplicar(c, [{ entidad: 'producto', id: 'PRO0', datos: { nombre: ' x' } }]),
    ).toThrow(/nombre inválido/)
  })
})
