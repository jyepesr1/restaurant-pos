import { esIdValido, Precio, PuntosBasicos } from '@pos/core'
import { type BaseSqlite, enTransaccion, type ValorSql } from '@pos/db'
import { z } from 'zod'
import { type Autor, actualizarVersionado, insertarVersionado } from './acceso/registros'

// Edición del catálogo desde la caja (tarea 1.1). Un pedido de edición trae una lista de cambios
// que se aplican juntos o ninguno: así, crear un producto con sus variantes no deja nunca un
// producto a medias. Cada registro tocado sube de versión y queda en el historial
// (`catalogo_cambio`), del que sale la revisión del precio copiado.
//
// Un registro que no existe se crea (el id lo genera el equipo, ADR-006) y pide todos sus
// campos; uno que existe se actualiza con los campos que traiga. Nada se borra: se archiva con
// `activo: false`.

const Id = z.string().refine(esIdValido, 'Debe ser un ULID')
const Nombre = z.string().trim().min(1).max(80)
const Orden = z.int().min(0).max(10_000)
const Activo = z.boolean()

const ENTIDADES = {
  impuesto: z.strictObject({
    nombre: Nombre,
    tipo: z.enum(['inc', 'iva', 'exento']),
    tarifa: PuntosBasicos,
    activo: Activo,
  }),
  estacion: z.strictObject({ nombre: Nombre, orden: Orden, activo: Activo }),
  categoria: z.strictObject({
    nombre: Nombre,
    orden: Orden,
    estacion_id: Id.nullable(),
    activo: Activo,
  }),
  producto: z.strictObject({
    categoria_id: Id,
    nombre: Nombre,
    descripcion: z.string().trim().max(300).nullable(),
    precio: Precio,
    impuesto_id: Id,
    favorito: z.boolean(),
    activo: Activo,
  }),
  variante: z.strictObject({
    producto_id: Id,
    nombre: Nombre,
    precio: Precio,
    orden: Orden,
    activo: Activo,
  }),
  grupo_modificador: z.strictObject({
    nombre: Nombre,
    minimo: z.int().min(0).max(20),
    maximo: z.int().min(1).max(20),
    activo: Activo,
  }),
  producto_grupo_modificador: z.strictObject({
    producto_id: Id,
    grupo_id: Id,
    orden: Orden,
    activo: Activo,
  }),
  modificador: z.strictObject({
    grupo_id: Id,
    nombre: Nombre,
    precio_extra: Precio,
    orden: Orden,
    activo: Activo,
  }),
} as const

export type EntidadEditable = keyof typeof ENTIDADES
const NOMBRES = Object.keys(ENTIDADES) as [EntidadEditable, ...EntidadEditable[]]

/** A qué tabla apunta cada campo que es una referencia. */
const REFERENCIAS: Record<string, string> = {
  estacion_id: 'estacion',
  categoria_id: 'categoria',
  impuesto_id: 'impuesto',
  producto_id: 'producto',
  grupo_id: 'grupo_modificador',
}

/** Solo estos campos cambian con el permiso `editar_precios`; todo lo demás pide `editar_catalogo`. */
const CAMPOS_DE_PRECIO: Partial<Record<EntidadEditable, readonly string[]>> = {
  producto: ['precio'],
  variante: ['precio'],
  modificador: ['precio_extra'],
}

export const PedidoEdicion = z.strictObject({
  cambios: z
    .array(
      z.strictObject({
        entidad: z.enum(NOMBRES),
        id: Id,
        // Se valida contra el esquema de la entidad al aplicar (completo al crear, parcial al
        // actualizar).
        datos: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1)
    .max(200),
})
export type CambioCatalogo = z.infer<typeof PedidoEdicion>['cambios'][number]

/** Si todos los cambios son solo de precio de registros que ya existen. */
export function soloPrecios(db: BaseSqlite, restauranteId: string, cambios: CambioCatalogo[]) {
  return cambios.every((c) => {
    const campos = CAMPOS_DE_PRECIO[c.entidad]
    return (
      campos !== undefined &&
      existe(db, restauranteId, c.entidad, c.id) &&
      Object.keys(c.datos).every((k) => campos.includes(k))
    )
  })
}

const existe = (db: BaseSqlite, restauranteId: string, tabla: string, id: string) =>
  db
    .prepare(`SELECT 1 FROM ${tabla} WHERE restaurante_id = ? AND id = ?`)
    .get(restauranteId, id) !== undefined

const aSql = (datos: Record<string, unknown>): Record<string, ValorSql> =>
  Object.fromEntries(
    Object.entries(datos).map(([k, v]) => [
      k,
      typeof v === 'boolean' ? (v ? 1 : 0) : (v as ValorSql),
    ]),
  )

export class ErrorEdicion extends Error {}

/** El registro padre no se cambia: una variante no pasa a otro producto, ni una opción a otro grupo. */
const PADRES: Partial<Record<EntidadEditable, readonly string[]>> = {
  variante: ['producto_id'],
  modificador: ['grupo_id'],
  producto_grupo_modificador: ['producto_id', 'grupo_id'],
}

/** Lo que no se puede archivar mientras algo activo lo use. */
const DEPENDIENTES: Partial<
  Record<EntidadEditable, { tabla: string; campo: string; que: string }>
> = {
  impuesto: { tabla: 'producto', campo: 'impuesto_id', que: 'productos' },
  categoria: { tabla: 'producto', campo: 'categoria_id', que: 'productos' },
  estacion: { tabla: 'categoria', campo: 'estacion_id', que: 'categorías' },
}

/** Las reglas de la base, dichas para la persona. Otros errores no son de los datos: se relanzan. */
function mensajeDeRestriccion(error: unknown): string | null {
  const texto = error instanceof Error ? error.message : ''
  if (!/constraint/i.test(texto)) return null
  if (/UNIQUE/i.test(texto)) return 'Ese producto ya tiene ese grupo de opciones'
  if (/maximo/i.test(texto)) return 'El máximo debe ser al menos 1 y no menor que el mínimo'
  if (/exento/i.test(texto)) return 'Un impuesto exento no lleva tarifa'
  if (/FOREIGN/i.test(texto)) return 'Apunta a un registro que no existe'
  return 'No cumple las reglas de la carta'
}

const leer = (db: BaseSqlite, restauranteId: string, tabla: string, id: string) =>
  db.prepare(`SELECT * FROM ${tabla} WHERE restaurante_id = ? AND id = ?`).get(restauranteId, id)

/**
 * Aplica los cambios en una transacción. Devuelve la versión del catálogo que quedó y cuántos
 * registros cambiaron de verdad (un campo igual al guardado no cuenta: reintentar el mismo pedido
 * no sube la versión ni avisa a los equipos). Lanza `ErrorEdicion` con un mensaje para la persona
 * si algo no vale; entonces no se aplica nada.
 */
export function aplicarCambios(
  db: BaseSqlite,
  restauranteId: string,
  cambios: CambioCatalogo[],
  autor: Autor,
  ahora: string,
): { version: number; cambiados: number } {
  return enTransaccion(db, () => {
    const tocados: { entidad: EntidadEditable; id: string; donde: string }[] = []
    for (const [i, c] of cambios.entries()) {
      const donde = `Cambio ${i + 1} (${c.entidad})`
      if (Object.keys(c.datos).length === 0) throw new ErrorEdicion(`${donde}: no cambia nada`)
      // Un id es de un solo tipo de registro: el historial no debe confundirlos.
      const otro = db
        .prepare(
          'SELECT entidad FROM catalogo_cambio WHERE restaurante_id = ? AND registro_id = ? AND entidad <> ? LIMIT 1',
        )
        .get(restauranteId, c.id, c.entidad)
      if (otro) throw new ErrorEdicion(`${donde}: ese id ya es de otro tipo de registro`)

      const actual = leer(db, restauranteId, c.entidad, c.id)
      const esquema = ENTIDADES[c.entidad]
      const lectura = (actual ? esquema.partial() : esquema).safeParse(c.datos)
      if (!lectura.success) {
        const problema = lectura.error.issues[0]
        throw new ErrorEdicion(
          `${donde}: ${problema?.path.join('.') || 'datos'}: ${problema?.message}`,
        )
      }
      let datos = aSql(lectura.data as Record<string, unknown>)
      for (const [campo, tabla] of Object.entries(REFERENCIAS)) {
        const valor = datos[campo]
        if (typeof valor === 'string' && !leer(db, restauranteId, tabla, valor))
          throw new ErrorEdicion(`${donde}: ${campo} no existe`)
      }
      if (actual) {
        for (const campo of PADRES[c.entidad] ?? [])
          if (campo in datos && datos[campo] !== actual[campo])
            throw new ErrorEdicion(`${donde}: no se puede pasar a otro ${campo.replace('_id', '')}`)
        datos = Object.fromEntries(Object.entries(datos).filter(([k, v]) => actual[k] !== v))
        if (Object.keys(datos).length === 0) continue
      }
      try {
        if (actual) actualizarVersionado(db, c.entidad, restauranteId, c.id, datos, autor, ahora)
        else insertarVersionado(db, c.entidad, restauranteId, datos, autor, ahora, c.id)
      } catch (error) {
        const mensaje = mensajeDeRestriccion(error)
        if (!mensaje) throw error
        throw new ErrorEdicion(`${donde}: ${mensaje}`)
      }
      tocados.push({ entidad: c.entidad, id: c.id, donde })
    }

    // Con todo aplicado (un mismo pedido puede archivar productos y luego su categoría):
    for (const t of tocados) {
      const fila = leer(db, restauranteId, t.entidad, t.id)
      if (!fila) continue
      if (fila.activo === 1) {
        // Lo activo no apunta a algo archivado: no desaparecería de la carta sin avisar.
        for (const [campo, tabla] of Object.entries(REFERENCIAS)) {
          const ref = fila[campo]
          if (typeof ref === 'string' && leer(db, restauranteId, tabla, ref)?.activo !== 1)
            throw new ErrorEdicion(`${t.donde}: ${campo.replace('_id', '')} está archivado`)
        }
        continue
      }
      const dep = DEPENDIENTES[t.entidad]
      if (dep) {
        const usan = db
          .prepare(
            `SELECT count(*) AS n FROM ${dep.tabla} WHERE restaurante_id = ? AND ${dep.campo} = ? AND activo = 1`,
          )
          .get(restauranteId, t.id)
        const n = Number(usan?.n ?? 0)
        if (n > 0) throw new ErrorEdicion(`${t.donde}: lo usan ${n} ${dep.que}; cámbialos primero`)
      }
      if (t.entidad === 'grupo_modificador') {
        // Archivar un grupo lo quita de los productos que lo usaban.
        const enlaces = db
          .prepare(
            'SELECT id FROM producto_grupo_modificador WHERE restaurante_id = ? AND grupo_id = ? AND activo = 1',
          )
          .all(restauranteId, t.id)
        for (const e of enlaces)
          actualizarVersionado(
            db,
            'producto_grupo_modificador',
            restauranteId,
            String(e.id),
            { activo: 0 },
            autor,
            ahora,
          )
      }
    }
    const fila = db
      .prepare("SELECT valor FROM contador WHERE restaurante_id = ? AND nombre = 'catalogo'")
      .get(restauranteId)
    return { version: Number(fila?.valor ?? 0), cambiados: tocados.length }
  })
}

/** Todo el catálogo, también lo archivado, para el editor. */
export function catalogoParaEditar(db: BaseSqlite, restauranteId: string) {
  const todas = (tabla: string, orden: string) =>
    db
      .prepare(`SELECT * FROM ${tabla} WHERE restaurante_id = ? ORDER BY ${orden}`)
      .all(restauranteId)
      .map(({ restaurante_id: _r, creado_en: _c, usuario_id: _u, dispositivo_id: _d, ...f }) => ({
        ...f,
        activo: f.activo === 1,
        ...('favorito' in f ? { favorito: f.favorito === 1 } : {}),
      }))
  const version = db
    .prepare("SELECT valor FROM contador WHERE restaurante_id = ? AND nombre = 'catalogo'")
    .get(restauranteId)
  return {
    version: Number(version?.valor ?? 0),
    impuestos: todas('impuesto', 'nombre'),
    estaciones: todas('estacion', 'orden, nombre'),
    categorias: todas('categoria', 'orden, nombre'),
    productos: todas('producto', 'nombre'),
    variantes: todas('variante', 'orden, nombre'),
    grupos: todas('grupo_modificador', 'nombre'),
    enlaces: todas('producto_grupo_modificador', 'orden'),
    modificadores: todas('modificador', 'orden, nombre'),
  }
}
