import { type ClaveRol, configCompleta, jsonCanonico } from '@pos/core'
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
import type { CategoriaCarta, Estacion, GrupoCarta } from './carta'

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
export const IMPUESTO = { nombre: 'INC 8 %', tipo: 'inc', tarifa: 800 } as const

/** Plano provisional: 25 mesas en una zona, en cuadrícula. El real se dibuja en la Fase 1. */
export const MESAS = 25
const COLUMNAS = 5
const PASO = 120

/**
 * Personal de ejemplo, por rol (los nombres reales los pone el restaurante). Con `usuario` entra a
 * la caja con usuario y contraseña; sin él, con su PIN (ADR-013).
 */
export const PERSONAL: readonly {
  clave: string
  nombre: string
  rol: ClaveRol
  usuario?: string
}[] = [
  { clave: 'caja', nombre: 'Caja', rol: 'cajero', usuario: 'caja' },
  { clave: 'reportes', nombre: 'Reportes', rol: 'reportes', usuario: 'reportes' },
  { clave: 'mesero-1', nombre: 'Mesero 1', rol: 'mesero' },
  { clave: 'mesero-2', nombre: 'Mesero 2', rol: 'mesero' },
  { clave: 'mesero-3', nombre: 'Mesero 3', rol: 'mesero' },
]

/** Tablas que llena el seed y en las que archiva lo que ya no está en la carta. */
const SEMBRADAS = [
  'zona',
  'mesa',
  'estacion',
  'grupo_modificador',
  'modificador',
  'categoria',
  'producto',
  'variante',
  'producto_grupo_modificador',
] as const

const ESTACIONES: Record<Estacion, { nombre: string; orden: number }> = {
  cocina: { nombre: 'Cocina', orden: 0 },
  barra: { nombre: 'Barra', orden: 1 },
}

export interface Resumen {
  /** Por tabla: cuántos registros se crearon, cambiaron, quedaron igual, se respetaron o se archivaron. */
  tablas: Record<string, Record<Cambio, number>>
  /**
   * PIN de las personas creadas en esta corrida (las que ya existían conservan el suyo), y usuario
   * y contraseña de quien entra con ellos. A quien ya existía sin usuario y ahora lo lleva (una
   * base de antes de ADR-013), se le dan usuario y contraseña, sin PIN nuevo.
   */
  pines: {
    nombre: string
    rol: ClaveRol
    pin: string | null
    usuario?: string
    contrasena?: string
  }[]
}

export function sembrar(
  db: BaseSqlite,
  acceso: ServicioAcceso,
  datos: {
    restauranteId: string
    roles: Record<ClaveRol, string>
    carta: CategoriaCarta[]
    /** Sin el personal de ejemplo (para un restaurante que crea sus propios usuarios). */
    sinPersonal?: boolean
  },
  ahora: string,
): Resumen {
  const { restauranteId, roles, carta } = datos
  const tablas: Resumen['tablas'] = {}
  const contar = (tabla: string, cambio: Cambio) => {
    tablas[tabla] ??= { creado: 0, actualizado: 0, igual: 0, respetado: 0, archivado: 0 }
    tablas[tabla][cambio] += 1
  }
  const id = (clave: string) => idEstable(restauranteId, clave)
  const vigentes = new Map<string, Set<string>>()
  const guardar = (
    tabla: string,
    idRegistro: string,
    campos: Record<string, ValorSql>,
    opciones: { soloCrear?: boolean } = {},
  ) => {
    vigentes.set(tabla, (vigentes.get(tabla) ?? new Set()).add(idRegistro))
    contar(
      tabla,
      guardarVersionado(db, tabla, restauranteId, idRegistro, campos, SISTEMA, ahora, opciones),
    )
  }
  const pines: Resumen['pines'] = []

  enTransaccion(db, () => {
    const restaurante = db.prepare('SELECT config FROM restaurante WHERE id = ?').get(restauranteId)
    // Lo que el restaurante ya configuró se respeta; lo que falte toma el valor del piloto. Se
    // compara como objeto: el mismo contenido con las claves en otro orden no es un cambio.
    const actual = String(restaurante?.config ?? '{}')
    // El piloto se ve con su marca, salvo que el restaurante haya elegido otra (tarea 1.3c).
    const config = jsonCanonico(configCompleta({ marca: 'la-spritzzeria', ...JSON.parse(actual) }))
    guardar('restaurante', restauranteId, {
      nombre: NOMBRE_RESTAURANTE,
      config: jsonCanonico(JSON.parse(actual)) === config ? actual : config,
    })
    const sede = db
      .prepare('SELECT id FROM sede WHERE restaurante_id = ? ORDER BY creado_en, id LIMIT 1')
      .get(restauranteId)
    if (!sede) throw new Error('El restaurante no tiene sede: arranca el hub una vez primero')
    const sedeId = String(sede.id)
    guardar('sede', sedeId, { nombre: NOMBRE_SEDE, zona_horaria: 'America/Bogota' })

    // Salón.
    const zonaId = id('zona:salon')
    guardar('zona', zonaId, { sede_id: sedeId, nombre: 'Salón', orden: 0, piso: 1 })
    for (let n = 1; n <= MESAS; n++) {
      guardar('mesa', id(`mesa:${n}`), {
        zona_id: zonaId,
        nombre: String(n),
        forma: 'cuadrada',
        x: ((n - 1) % COLUMNAS) * PASO,
        y: Math.floor((n - 1) / COLUMNAS) * PASO,
        ancho: 80,
        alto: 80,
        rotacion: 0,
        capacidad: 4,
      })
    }

    // Estaciones e impuesto.
    for (const [clave, e] of Object.entries(ESTACIONES))
      guardar('estacion', id(`estacion:${clave}`), { nombre: e.nombre, orden: e.orden })
    const impuestoId = id('impuesto:inc')
    guardar('impuesto', impuestoId, { ...IMPUESTO }, { soloCrear: true })

    // Carta. Primero los grupos de modificadores, que los productos comparten.
    const grupos = new Map<string, GrupoCarta>()
    for (const p of carta.flatMap((c) => c.productos))
      for (const g of p.grupos) grupos.set(g.clave, g)
    for (const g of grupos.values()) {
      guardar('grupo_modificador', id(`grupo:${g.clave}`), {
        nombre: g.nombre,
        minimo: g.minimo,
        maximo: g.maximo,
      })
      for (const [orden, o] of g.opciones.entries())
        guardar('modificador', id(`modificador:${g.clave}:${o.nombre}`), {
          grupo_id: id(`grupo:${g.clave}`),
          nombre: o.nombre,
          precio_extra: o.precioExtra,
          orden,
        })
    }
    for (const categoria of carta) {
      const categoriaId = id(`categoria:${categoria.clave}`)
      guardar('categoria', categoriaId, {
        nombre: categoria.nombre,
        orden: categoria.orden,
        estacion_id: id(`estacion:${categoria.estacion}`),
        foto: categoria.foto,
      })
      for (const p of categoria.productos) {
        const productoId = id(`producto:${p.clave}`)
        guardar('producto', productoId, {
          categoria_id: categoriaId,
          nombre: p.nombre,
          descripcion: p.descripcion,
          precio: p.precio,
          impuesto_id: impuestoId,
          foto: null,
          favorito: 0,
        })
        for (const [orden, v] of p.variantes.entries())
          guardar('variante', id(`variante:${p.clave}:${v.nombre}`), {
            producto_id: productoId,
            nombre: v.nombre,
            precio: v.precio,
            orden,
          })
        for (const [orden, g] of p.grupos.entries()) {
          guardar('producto_grupo_modificador', id(`producto-grupo:${p.clave}:${g.clave}`), {
            producto_id: productoId,
            grupo_id: id(`grupo:${g.clave}`),
            orden,
          })
        }
      }
    }

    // Lo que el seed cargó antes y ya no está en la carta se archiva (nunca se borra). Solo lo
    // del sistema: lo que creó una persona no es del seed.
    for (const tabla of SEMBRADAS) {
      const quedan = vigentes.get(tabla) ?? new Set<string>()
      const sobran = db
        .prepare(
          `SELECT id FROM ${tabla} WHERE restaurante_id = ? AND activo = 1 AND usuario_id IS NULL`,
        )
        .all(restauranteId)
        .map((f) => String(f.id))
        .filter((x) => !quedan.has(x))
      for (const x of sobran) {
        actualizarVersionado(db, tabla, restauranteId, x, { activo: 0 }, SISTEMA, ahora)
        contar(tabla, 'archivado')
      }
    }

    // Personal de ejemplo, en la misma transacción: o queda todo con sus PIN, o nada.
    if (datos.sinPersonal) return
    for (const persona of PERSONAL) {
      const usuarioId = id(`usuario:${persona.clave}`)
      const existe = db
        .prepare('SELECT activo FROM usuario WHERE restaurante_id = ? AND id = ?')
        .get(restauranteId, usuarioId)
      const contrasena = persona.usuario ? generarContrasena() : undefined
      if (existe) {
        // Quien se archivó no vuelve, ni recibe una contraseña que no le serviría.
        if (
          existe.activo !== 1 ||
          !persona.usuario ||
          acceso.tieneContrasena(usuarioId) ||
          !contrasena
        ) {
          contar('usuario', 'igual')
          continue
        }
        acceso.fijarContrasena(usuarioId, persona.usuario, contrasena)
        contar('usuario', 'actualizado')
        pines.push({
          nombre: persona.nombre,
          rol: persona.rol,
          pin: null,
          usuario: persona.usuario,
          contrasena,
        })
        continue
      }
      const { pin } = acceso.insertarUsuario({
        id: usuarioId,
        nombre: persona.nombre,
        rolId: roles[persona.rol],
        ...(persona.usuario && contrasena ? { usuario: persona.usuario, contrasena } : {}),
      })
      contar('usuario', 'creado')
      pines.push({
        nombre: persona.nombre,
        rol: persona.rol,
        pin,
        ...(persona.usuario ? { usuario: persona.usuario, contrasena } : {}),
      })
    }
  })
  return { tablas, pines }
}
