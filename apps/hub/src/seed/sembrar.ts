import { canonicalJson, fullConfig, type RoleKey } from '@pos/core'
import { type BaseSqlite, enTransaccion, type ValorSql } from '@pos/db'
import {
  actualizarVersionado,
  type Cambio,
  guardarVersionado,
  idEstable,
  SISTEMA,
} from '../acceso/registros'
import { generarContrasena } from '../acceso/secretos'
import type { ServicioAcceso } from '../acceso/servicio'
import type { MenuCategory, MenuGroup, Station } from './carta'

// Carga los datos del piloto (tarea 0.8): restaurante, salón, estaciones, impuesto, carta y
// personal, todo en una transacción. Cada registro tiene un ID estable (`idEstable`): correrlo
// otra vez deja todo igual y solo cambia lo que cambió en la carta. Reglas:
// - lo que escribió una persona (con el editor del catálogo, Fase 1) no se pisa;
// - el impuesto se crea una sola vez: si el contador lo cambia, el seed no lo devuelve;
// - lo que el seed cargó antes y ya no está en la carta (o quedó «no disponible») se archiva;
// - el personal de ejemplo se crea una vez y conserva su PIN; quien se archive no vuelve.

export const NOMBRE_RESTAURANTE = 'La Spritzzería'
export const NOMBRE_SEDE = 'Envigado'

/** INC del 8 % en restaurantes y bares. (validar) con el contador. */
export const IMPUESTO = { name: 'INC 8 %', type: 'inc', rate: 800 } as const

/** Plano provisional: 25 mesas en una zona, en cuadrícula. El real se dibuja en la Fase 1. */
export const TABLES = 25
const COLUMNS = 5
const PASO = 120

/**
 * Personal de ejemplo, por rol (los nombres reales los pone el restaurante). Con `usuario` entra a
 * la caja con usuario y contraseña; sin él, con su PIN (ADR-013).
 */
export const PERSONAL: readonly {
  key: string
  name: string
  role: RoleKey
  user?: string
}[] = [
  { key: 'caja', name: 'Caja', role: 'cashier', user: 'caja' },
  { key: 'reportes', name: 'Reportes', role: 'reports', user: 'reportes' },
  { key: 'mesero-1', name: 'Mesero 1', role: 'waiter' },
  { key: 'mesero-2', name: 'Mesero 2', role: 'waiter' },
  { key: 'mesero-3', name: 'Mesero 3', role: 'waiter' },
]

/** Tablas que llena el seed y en las que archiva lo que ya no está en la carta. */
const SEMBRADAS = [
  'zones',
  'dining_tables',
  'stations',
  'modifier_groups',
  'modifiers',
  'categories',
  'products',
  'variants',
  'product_modifier_groups',
] as const

const ESTACIONES: Record<Station, { name: string; position: number }> = {
  cocina: { name: 'Cocina', position: 0 },
  barra: { name: 'Barra', position: 1 },
}

export interface Resumen {
  /** Por tabla: cuántos registros se crearon, cambiaron, quedaron igual, se respetaron o se archivaron. */
  sqlTables: Record<string, Record<Cambio, number>>
  /**
   * PIN de las personas creadas en esta corrida (las que ya existían conservan el suyo), y usuario
   * y contraseña de quien entra con ellos. A quien ya existía sin usuario y ahora lo lleva (una
   * base de antes de ADR-013), se le dan usuario y contraseña, sin PIN nuevo.
   */
  pins: {
    name: string
    role: RoleKey
    pin: string | null
    user?: string
    password?: string
  }[]
}

export function sembrar(
  db: BaseSqlite,
  access: ServicioAcceso,
  data: {
    restauranteId: string
    roles: Record<RoleKey, string>
    menu: MenuCategory[]
    /** Sin el personal de ejemplo (para un restaurante que crea sus propios usuarios). */
    sinPersonal?: boolean
  },
  ahora: string,
): Resumen {
  const { restauranteId, roles, menu } = data
  const sqlTables: Resumen['sqlTables'] = {}
  const contar = (tableName: string, change: Cambio) => {
    sqlTables[tableName] ??= { created: 0, updated: 0, equal: 0, respected: 0, archived: 0 }
    sqlTables[tableName][change] += 1
  }
  const id = (key: string) => idEstable(restauranteId, key)
  const currentOnes = new Map<string, Set<string>>()
  const guardar = (
    tableName: string,
    idRegistro: string,
    fields: Record<string, ValorSql>,
    options: { soloCrear?: boolean } = {},
  ) => {
    currentOnes.set(tableName, (currentOnes.get(tableName) ?? new Set()).add(idRegistro))
    contar(
      tableName,
      guardarVersionado(db, tableName, restauranteId, idRegistro, fields, SISTEMA, ahora, options),
    )
  }
  const pins: Resumen['pins'] = []

  enTransaccion(db, () => {
    const restaurant = db.prepare('SELECT config FROM restaurants WHERE id = ?').get(restauranteId)
    // Lo que el restaurante ya configuró se respeta; lo que falte toma el valor del piloto. Se
    // compara como objeto: el mismo contenido con las claves en otro orden no es un cambio.
    const current = String(restaurant?.config ?? '{}')
    // El piloto se ve con su marca, salvo que el restaurante haya elegido otra (tarea 1.3c).
    const config = canonicalJson(fullConfig({ brand: 'la-spritzzeria', ...JSON.parse(current) }))
    guardar('restaurants', restauranteId, {
      name: NOMBRE_RESTAURANTE,
      config: canonicalJson(JSON.parse(current)) === config ? current : config,
    })
    const location = db
      .prepare('SELECT id FROM locations WHERE restaurant_id = ? ORDER BY created_at, id LIMIT 1')
      .get(restauranteId)
    if (!location) throw new Error('El restaurante no tiene sede: arranca el hub una vez primero')
    const sedeId = String(location.id)
    guardar('locations', sedeId, { name: NOMBRE_SEDE, time_zone: 'America/Bogota' })

    // Salón.
    const zonaId = id('zona:salon')
    guardar('zones', zonaId, { location_id: sedeId, name: 'Salón', position: 0, level: 1 })
    for (let n = 1; n <= TABLES; n++) {
      guardar('dining_tables', id(`mesa:${n}`), {
        zone_id: zonaId,
        name: String(n),
        shape: 'square',
        x: ((n - 1) % COLUMNS) * PASO,
        y: Math.floor((n - 1) / COLUMNS) * PASO,
        width: 80,
        height: 80,
        rotation: 0,
        capacity: 4,
      })
    }

    // Estaciones e impuesto.
    for (const [key, e] of Object.entries(ESTACIONES))
      guardar('stations', id(`estacion:${key}`), { name: e.name, position: e.position })
    const impuestoId = id('impuesto:inc')
    guardar('taxes', impuestoId, { ...IMPUESTO }, { soloCrear: true })
    // Datáfonos Bold del piloto (tarea 1.6). Solo se crean: el administrador los renombra, agrega
    // o archiva en «Caja y pagos», y el seed lo respeta.
    for (const n of [1, 2])
      guardar(
        'card_terminals',
        id(`datafono:bold-${n}`),
        { name: `Bold ${n}`, provider: 'bold' },
        { soloCrear: true },
      )

    // Carta. Primero los grupos de modificadores, que los productos comparten.
    const groups = new Map<string, MenuGroup>()
    for (const p of menu.flatMap((c) => c.products)) for (const g of p.groups) groups.set(g.key, g)
    for (const g of groups.values()) {
      guardar('modifier_groups', id(`grupo:${g.key}`), {
        name: g.name,
        minimum: g.minimum,
        maximum: g.maximum,
      })
      for (const [position, o] of g.options.entries())
        guardar('modifiers', id(`modificador:${g.key}:${o.name}`), {
          group_id: id(`grupo:${g.key}`),
          name: o.name,
          extra_price: o.extraPrice,
          position,
        })
    }
    for (const category of menu) {
      const categoriaId = id(`categoria:${category.key}`)
      guardar('categories', categoriaId, {
        name: category.name,
        position: category.position,
        station_id: id(`estacion:${category.station}`),
        photo: category.photo,
      })
      for (const p of category.products) {
        const productId = id(`producto:${p.key}`)
        guardar('products', productId, {
          category_id: categoriaId,
          name: p.name,
          description: p.description,
          price: p.price,
          tax_id: impuestoId,
          photo: null,
          favorite: 0,
        })
        for (const [position, v] of p.variants.entries())
          guardar('variants', id(`variante:${p.key}:${v.name}`), {
            product_id: productId,
            name: v.name,
            price: v.price,
            position,
          })
        for (const [position, g] of p.groups.entries()) {
          guardar('product_modifier_groups', id(`producto-grupo:${p.key}:${g.key}`), {
            product_id: productId,
            group_id: id(`grupo:${g.key}`),
            position,
          })
        }
      }
    }

    // Lo que el seed cargó antes y ya no está en la carta se archiva (nunca se borra). Solo lo
    // del sistema: lo que creó una persona no es del seed.
    for (const tableName of SEMBRADAS) {
      const quedan = currentOnes.get(tableName) ?? new Set<string>()
      const sobran = db
        .prepare(
          `SELECT id FROM ${tableName} WHERE restaurant_id = ? AND active = 1 AND user_id IS NULL`,
        )
        .all(restauranteId)
        .map((f) => String(f.id))
        .filter((x) => !quedan.has(x))
      for (const x of sobran) {
        actualizarVersionado(db, tableName, restauranteId, x, { active: 0 }, SISTEMA, ahora)
        contar(tableName, 'archived')
      }
    }

    // Personal de ejemplo, en la misma transacción: o queda todo con sus PIN, o nada.
    if (data.sinPersonal) return
    for (const person of PERSONAL) {
      const userId = id(`usuario:${person.key}`)
      const existe = db
        .prepare('SELECT active FROM users WHERE restaurant_id = ? AND id = ?')
        .get(restauranteId, userId)
      const password = person.user ? generarContrasena() : undefined
      if (existe) {
        // Quien se archivó no vuelve, ni recibe una contraseña que no le serviría.
        if (existe.active !== 1 || !person.user || access.tieneContrasena(userId) || !password) {
          contar('users', 'equal')
          continue
        }
        access.fijarContrasena(userId, person.user, password)
        contar('users', 'updated')
        pins.push({
          name: person.name,
          role: person.role,
          pin: null,
          user: person.user,
          password,
        })
        continue
      }
      const { pin } = access.insertUser({
        id: userId,
        name: person.name,
        rolId: roles[person.role],
        ...(person.user && password ? { user: person.user, password } : {}),
      })
      contar('users', 'created')
      pins.push({
        name: person.name,
        role: person.role,
        pin,
        ...(person.user ? { user: person.user, password } : {}),
      })
    }
  })
  return { sqlTables, pins }
}
