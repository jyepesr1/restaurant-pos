import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { COLUMNAS_COMUNES, TABLAS_LOCALES, TABLAS_VERSIONADAS } from './esquema'
import { MIGRACIONES } from './migraciones'
import { aplicarMigraciones, huellaSql, versionActual } from './migrar'
import { abrirBase } from './node'
import { AHORA, insertarEnTabla, insertarVersionado, sembrar } from './pruebas/utiles'
import type { BaseSqlite, ValorSql } from './sqlite'

// Migración 6 (tarea 1.4, ADR-015): impresoras, cola de impresión y pantallas de cocina.

const HASTA_5 = MIGRACIONES.filter((m) => m.version <= 5)
const HASTA_6 = MIGRACIONES.filter((m) => m.version <= 6)

/** Una base real de la versión 5, con un salón, personal, un equipo y una sesión ya andando. */
function baseVersion5() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db, HASTA_5)
  const s = sembrar(db)
  const rol = insertarVersionado(db, 'rol', s.restaurante, { nombre: 'Mesero', sistema: 1 })
  const rolCocina = insertarVersionado(db, 'rol', s.restaurante, { nombre: 'Cocina' })
  const ana = insertarVersionado(db, 'usuario', s.restaurante, { nombre: 'Ana', rol_id: rol })
  const luis = insertarVersionado(db, 'usuario', s.restaurante, {
    nombre: 'Luis',
    rol_id: rolCocina,
    activo: 0,
  })
  const equipo = insertarVersionado(db, 'dispositivo', s.restaurante, {
    sede_id: s.sede,
    nombre: 'Celular de Ana',
    tipo: 'mesero',
  })
  const pantalla = insertarVersionado(db, 'dispositivo', s.restaurante, {
    sede_id: s.sede,
    nombre: 'Tablet vieja',
    tipo: 'kds',
    revocado_en: AHORA,
  })
  const estacion = insertarVersionado(db, 'estacion', s.restaurante, { nombre: 'Cocina' })
  insertarEnTabla(db, 'sesion', {
    id: nuevoId(),
    restaurante_id: s.restaurante,
    usuario_id: ana,
    dispositivo_id: equipo,
    secreto_hash: 'h',
    inicio: AHORA,
    ultimo_uso: AHORA,
  })
  return { db, ...s, rol, rolCocina, ana, luis, equipo, pantalla, estacion }
}

const migrada = () => {
  const base = baseVersion5()
  aplicarMigraciones(base.db)
  return base
}

const contar = (db: BaseSqlite, tabla: string) =>
  Number(db.prepare(`SELECT count(*) AS n FROM ${tabla}`).get()?.n)

const TABLAS_ANTES = [
  'restaurante',
  'sede',
  'zona',
  'impuesto',
  'categoria',
  'producto',
  'rol',
  'usuario',
  'dispositivo',
  'estacion',
  'sesion',
  'contador',
  'migracion',
] as const

/** Una impresora de red con todo en regla; `campos` cambia lo que se quiera probar. */
function impresora(
  db: BaseSqlite,
  restaurante: string,
  campos: Record<string, ValorSql> = {},
  id: string = nuevoId(),
) {
  return insertarVersionado(
    db,
    'impresora',
    restaurante,
    {
      nombre: 'Cocina',
      conexion: 'red',
      direccion: '192.168.1.50',
      puerto: 9100,
      ancho: 80,
      ...campos,
    },
    id,
  )
}

function trabajo(
  db: BaseSqlite,
  restaurante: string,
  impresoraId: string,
  campos: Record<string, ValorSql> = {},
) {
  const id = nuevoId()
  insertarEnTabla(db, 'trabajo_impresion', {
    id,
    restaurante_id: restaurante,
    impresora_id: impresoraId,
    tipo: 'comanda',
    contenido: '{"estacion":"Cocina"}',
    creado_en: AHORA,
    ...campos,
  })
  return id
}

describe('migración 6: ficha', () => {
  it('es la 6, se llama comandas y aplica sobre la 5 sin tocar nada más', () => {
    const { db } = baseVersion5()
    expect(MIGRACIONES.find((m) => m.version === 6)?.nombre).toBe('comandas')
    expect(MIGRACIONES).toHaveLength(6)
    expect(versionActual(db)).toBe(5)
    expect(aplicarMigraciones(db)).toEqual([6])
    expect(versionActual(db)).toBe(6)
    const registro = db.prepare('SELECT * FROM migracion WHERE version = 6').get()
    expect(registro).toMatchObject({
      nombre: 'comandas',
      hash: huellaSql(MIGRACIONES[5]?.sql as string),
    })
  })

  it('repetirla no hace nada, y editarla después de aplicada se rechaza por su huella', () => {
    const { db } = migrada()
    expect(aplicarMigraciones(db)).toEqual([])
    const editada = [
      ...HASTA_6.slice(0, 5),
      { ...(HASTA_6[5] as object), sql: `${MIGRACIONES[5]?.sql}\n-- x` },
    ]
    expect(() => aplicarMigraciones(db, editada as never)).toThrow(/cambió después de aplicarse/)
  })

  it('las dos tablas nuevas son STRICT y quedan en su categoría', () => {
    const { db } = migrada()
    const tablas = db.prepare('PRAGMA table_list').all()
    for (const nombre of ['impresora', 'trabajo_impresion'])
      expect(tablas.find((t) => t.name === nombre)).toMatchObject({ strict: 1 })
    expect(TABLAS_VERSIONADAS).toContain('impresora')
    expect(TABLAS_LOCALES).toContain('trabajo_impresion')
    const columnas = db
      .prepare("SELECT name FROM pragma_table_info('impresora')")
      .all()
      .map((c) => c.name)
    for (const comun of COLUMNAS_COMUNES) expect(columnas).toContain(comun)
  })
})

describe('migración 6: no se pierde nada', () => {
  it('ninguna fila de las tablas anteriores desaparece ni cambia', () => {
    const base = baseVersion5()
    const antes = Object.fromEntries(TABLAS_ANTES.map((t) => [t, contar(base.db, t)]))
    const filasAntes = base.db.prepare('SELECT * FROM usuario ORDER BY id').all()
    const dispositivosAntes = base.db.prepare('SELECT * FROM dispositivo ORDER BY id').all()
    const rolesAntes = base.db.prepare('SELECT * FROM rol ORDER BY id').all()
    expect(antes.usuario).toBe(2)
    expect(antes.dispositivo).toBe(2)
    aplicarMigraciones(base.db)
    // `migracion` crece en una fila (la 6); el resto queda igual.
    for (const t of TABLAS_ANTES) expect(contar(base.db, t)).toBe(t === 'migracion' ? 6 : antes[t])
    const sinColumnaNueva = (filas: Record<string, ValorSql>[], nueva: string) =>
      filas.map(({ [nueva]: _, ...resto }) => resto)
    expect(
      sinColumnaNueva(base.db.prepare('SELECT * FROM usuario ORDER BY id').all(), 'pantalla'),
    ).toEqual(filasAntes)
    expect(
      sinColumnaNueva(
        base.db.prepare('SELECT * FROM dispositivo ORDER BY id').all(),
        'estacion_ids',
      ),
    ).toEqual(dispositivosAntes)
    expect(
      sinColumnaNueva(base.db.prepare('SELECT * FROM rol ORDER BY id').all(), 'oculto'),
    ).toEqual(rolesAntes)
  })

  it('lo que ya existía queda como antes: personas reales, roles visibles, equipos sin estaciones', () => {
    const { db } = migrada()
    expect(db.prepare('SELECT DISTINCT pantalla FROM usuario').all()).toEqual([{ pantalla: 0 }])
    expect(db.prepare('SELECT DISTINCT oculto FROM rol').all()).toEqual([{ oculto: 0 }])
    expect(db.prepare('SELECT DISTINCT estacion_ids FROM dispositivo').all()).toEqual([
      { estacion_ids: null },
    ])
    expect(contar(db, 'impresora')).toBe(0)
    expect(contar(db, 'trabajo_impresion')).toBe(0)
  })

  it('la base queda íntegra: sin referencias rotas', () => {
    const { db } = migrada()
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
  })

  it('un equipo que ya era pantalla (kds) sigue siendo kds y puede recibir estaciones', () => {
    const { db, pantalla, estacion } = migrada()
    expect(db.prepare('SELECT tipo FROM dispositivo WHERE id = ?').get(pantalla)).toEqual({
      tipo: 'kds',
    })
    db.prepare('UPDATE dispositivo SET estacion_ids = ? WHERE id = ?').run(
      JSON.stringify([estacion]),
      pantalla,
    )
    expect(db.prepare('SELECT estacion_ids FROM dispositivo WHERE id = ?').get(pantalla)).toEqual({
      estacion_ids: JSON.stringify([estacion]),
    })
  })

  it('una migración que falla a medias deja la base en la 5 (todo o nada)', () => {
    const { db } = baseVersion5()
    const rota = {
      version: 6,
      nombre: 'comandas',
      sql: `${MIGRACIONES[5]?.sql}\nCREATE TABLE impresora (x TEXT) STRICT;`,
    }
    expect(() => aplicarMigraciones(db, [...HASTA_5, rota])).toThrow()
    expect(versionActual(db)).toBe(5)
    const nombres = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all()
      .map((t) => t.name)
    expect(nombres).not.toContain('impresora')
    expect(nombres).not.toContain('trabajo_impresion')
    const columnas = db.prepare("SELECT name FROM pragma_table_info('usuario')").all()
    expect(columnas.map((c) => c.name)).not.toContain('pantalla')
  })
})

describe('migración 6: columnas nuevas de equipo, persona y rol', () => {
  it.each([
    ['usuario', 'pantalla'],
    ['rol', 'oculto'],
  ])('%s.%s solo acepta 0 y 1', (tabla, columna) => {
    const { db, ana, rol } = migrada()
    const id = tabla === 'usuario' ? ana : rol
    expect(() =>
      db.prepare(`UPDATE ${tabla} SET ${columna} = 1 WHERE id = ?`).run(id),
    ).not.toThrow()
    expect(() =>
      db.prepare(`UPDATE ${tabla} SET ${columna} = 0 WHERE id = ?`).run(id),
    ).not.toThrow()
    for (const malo of [2, -1])
      expect(() =>
        db.prepare(`UPDATE ${tabla} SET ${columna} = ? WHERE id = ?`).run(malo, id),
      ).toThrow(/CHECK/)
    expect(() => db.prepare(`UPDATE ${tabla} SET ${columna} = NULL WHERE id = ?`).run(id)).toThrow()
  })

  it('dispositivo.estacion_ids acepta NULL y JSON, y rechaza texto que no es JSON', () => {
    const { db, equipo } = migrada()
    const poner = (v: string | null) =>
      db.prepare('UPDATE dispositivo SET estacion_ids = ? WHERE id = ?').run(v, equipo)
    expect(() => poner(null)).not.toThrow()
    expect(() => poner('[]')).not.toThrow()
    expect(() => poner('["a","b"]')).not.toThrow()
    expect(() => poner('[a,')).toThrow(/CHECK/)
    expect(() => poner('no es json')).toThrow(/CHECK/)
  })
})

describe('migración 6: tabla impresora', () => {
  it('una impresora de red con sus valores de fábrica', () => {
    const { db, restaurante } = migrada()
    const id = impresora(db, restaurante)
    expect(db.prepare('SELECT * FROM impresora WHERE id = ?').get(id)).toMatchObject({
      activo: 1,
      pagina_codigos: 'pc850',
      estacion_ids: '[]',
      respaldo_id: null,
      puerto: 9100,
    })
  })

  it('una impresora USB no lleva puerto', () => {
    const { db, restaurante } = migrada()
    expect(() =>
      impresora(db, restaurante, { conexion: 'usb', direccion: 'POS-80', puerto: null }),
    ).not.toThrow()
  })

  it.each([
    ['conexión desconocida', { conexion: 'bluetooth' }],
    ['ancho 57', { ancho: 57 }],
    ['ancho 0', { ancho: 0 }],
    ['página de códigos inventada', { pagina_codigos: 'utf8' }],
    ['nombre vacío', { nombre: '' }],
    ['nombre de 61', { nombre: 'a'.repeat(61) }],
    ['dirección vacía', { direccion: '' }],
    ['dirección de 256', { direccion: 'a'.repeat(256) }],
    ['puerto 0', { puerto: 0 }],
    ['puerto 65536', { puerto: 65536 }],
    ['puerto negativo', { puerto: -1 }],
    ['estaciones que no son JSON', { estacion_ids: '[Cocina' }],
    ['activo 2', { activo: 2 }],
    ['versión negativa', { version: -1 }],
  ])('rechaza %s', (_, campos) => {
    const { db, restaurante } = migrada()
    expect(() => impresora(db, restaurante, campos as Record<string, ValorSql>)).toThrow()
  })

  it.each([
    ['nombre de 1', { nombre: 'a' }],
    ['nombre de 60', { nombre: 'a'.repeat(60) }],
    ['dirección de 255', { direccion: 'a'.repeat(255) }],
    ['puerto 1', { puerto: 1 }],
    ['puerto 65535', { puerto: 65535 }],
    ['ancho 58', { ancho: 58 }],
    ['página wpc1252', { pagina_codigos: 'wpc1252' }],
    ['página sin_tildes', { pagina_codigos: 'sin_tildes' }],
    ['sin puerto', { puerto: null }],
  ])('acepta %s', (_, campos) => {
    const { db, restaurante } = migrada()
    expect(() => impresora(db, restaurante, campos as Record<string, ValorSql>)).not.toThrow()
  })

  it('el id debe ser un ULID de 26 caracteres', () => {
    const { db, restaurante } = migrada()
    expect(() => impresora(db, restaurante, {}, 'corto')).toThrow(/CHECK/)
  })

  it('una impresora no puede ser su propio respaldo, ni apuntar a una que no existe', () => {
    const { db, restaurante } = migrada()
    const id = nuevoId()
    expect(() => impresora(db, restaurante, { respaldo_id: id }, id)).toThrow(/CHECK/)
    expect(() => impresora(db, restaurante, { respaldo_id: nuevoId() })).toThrow(/FOREIGN KEY/)
    const otra = impresora(db, restaurante)
    expect(() => impresora(db, restaurante, { respaldo_id: otra })).not.toThrow()
    // Cambiarse a sí misma como respaldo después tampoco.
    expect(() =>
      db.prepare('UPDATE impresora SET respaldo_id = id WHERE id = ?').run(otra),
    ).toThrow(/CHECK/)
  })

  it('no se borra: se archiva', () => {
    const { db, restaurante } = migrada()
    const id = impresora(db, restaurante)
    expect(() => db.prepare('DELETE FROM impresora WHERE id = ?').run(id)).toThrow(/se archiva/)
    expect(() => db.prepare('UPDATE impresora SET activo = 0 WHERE id = ?').run(id)).not.toThrow()
    expect(contar(db, 'impresora')).toBe(1)
  })

  it('exige un restaurante que exista', () => {
    const { db } = migrada()
    expect(() => impresora(db, nuevoId())).toThrow(/FOREIGN KEY/)
  })
})

describe('migración 6: cola de impresión (trabajo_impresion)', () => {
  it('un trabajo nuevo nace pendiente, sin intentos y sin hora de fin', () => {
    const { db, restaurante } = migrada()
    const p = impresora(db, restaurante)
    const id = trabajo(db, restaurante, p)
    expect(db.prepare('SELECT * FROM trabajo_impresion WHERE id = ?').get(id)).toMatchObject({
      estado: 'pendiente',
      intentos: 0,
      terminado_en: null,
      ultimo_error: null,
      impreso_en_id: null,
      descartado_por_id: null,
    })
  })

  it.each([
    ['tipo desconocido', { tipo: 'factura' }],
    ['estado desconocido', { estado: 'enviado' }],
    ['intentos negativos', { intentos: -1 }],
    ['contenido que no es JSON', { contenido: 'comanda' }],
    ['pendiente con hora de fin', { terminado_en: AHORA }],
    ['impreso sin hora de fin', { estado: 'impreso', impreso_en_id: 'x' }],
    ['descartado sin hora de fin', { estado: 'descartado' }],
    ['id corto', { id: 'corto' }],
  ])('rechaza %s', (_, campos) => {
    const { db, restaurante } = migrada()
    const p = impresora(db, restaurante)
    expect(() => trabajo(db, restaurante, p, campos as Record<string, ValorSql>)).toThrow()
  })

  it('impreso exige decir en qué impresora salió', () => {
    const { db, restaurante } = migrada()
    const p = impresora(db, restaurante)
    expect(() => trabajo(db, restaurante, p, { estado: 'impreso', terminado_en: AHORA })).toThrow(
      /CHECK/,
    )
    expect(() =>
      trabajo(db, restaurante, p, { estado: 'impreso', terminado_en: AHORA, impreso_en_id: p }),
    ).not.toThrow()
  })

  it('descartado puede ser por una persona o por el hub (sin persona)', () => {
    const { db, restaurante, ana } = migrada()
    const p = impresora(db, restaurante)
    expect(() =>
      trabajo(db, restaurante, p, {
        estado: 'descartado',
        terminado_en: AHORA,
        descartado_por_id: ana,
      }),
    ).not.toThrow()
    expect(() =>
      trabajo(db, restaurante, p, { estado: 'descartado', terminado_en: AHORA }),
    ).not.toThrow()
    expect(() =>
      trabajo(db, restaurante, p, {
        estado: 'descartado',
        terminado_en: AHORA,
        descartado_por_id: nuevoId(),
      }),
    ).toThrow(/FOREIGN KEY/)
  })

  it('un trabajo pasa de pendiente a impreso, pero no vuelve a pendiente sin hora de fin', () => {
    const { db, restaurante } = migrada()
    const p = impresora(db, restaurante)
    const id = trabajo(db, restaurante, p)
    db.prepare(
      "UPDATE trabajo_impresion SET estado = 'impreso', terminado_en = ?, impreso_en_id = ? WHERE id = ?",
    ).run(AHORA, p, id)
    expect(() =>
      db.prepare("UPDATE trabajo_impresion SET estado = 'pendiente' WHERE id = ?").run(id),
    ).toThrow(/CHECK/)
  })

  it('apunta a impresoras que existen', () => {
    const { db, restaurante } = migrada()
    expect(() => trabajo(db, restaurante, nuevoId())).toThrow(/FOREIGN KEY/)
    const p = impresora(db, restaurante)
    expect(() =>
      trabajo(db, restaurante, p, {
        estado: 'impreso',
        terminado_en: AHORA,
        impreso_en_id: nuevoId(),
      }),
    ).toThrow(/FOREIGN KEY/)
  })

  it('no se borra nunca: ni siquiera el impreso', () => {
    const { db, restaurante } = migrada()
    const p = impresora(db, restaurante)
    const id = trabajo(db, restaurante, p, {
      estado: 'impreso',
      terminado_en: AHORA,
      impreso_en_id: p,
    })
    expect(() => db.prepare('DELETE FROM trabajo_impresion WHERE id = ?').run(id)).toThrow(
      /no se borra/,
    )
    expect(() => db.prepare('DELETE FROM trabajo_impresion').run()).toThrow(/no se borra/)
    expect(contar(db, 'trabajo_impresion')).toBe(1)
  })

  it('archivar una impresora con trabajos no borra ni toca sus trabajos', () => {
    const { db, restaurante } = migrada()
    const p = impresora(db, restaurante)
    trabajo(db, restaurante, p)
    trabajo(db, restaurante, p)
    db.prepare('UPDATE impresora SET activo = 0 WHERE id = ?').run(p)
    expect(contar(db, 'trabajo_impresion')).toBe(2)
    expect(
      db.prepare("SELECT count(*) AS n FROM trabajo_impresion WHERE estado = 'pendiente'").get(),
    ).toEqual({ n: 2 })
  })
})

describe('migración 6: el índice único impide duplicar la comanda', () => {
  const evento = nuevoId()
  const comanda = nuevoId()

  it('el mismo evento, la misma comanda y la misma impresora no se guardan dos veces', () => {
    const { db, restaurante } = migrada()
    const p = impresora(db, restaurante)
    trabajo(db, restaurante, p, { evento_id: evento, comanda_id: comanda })
    expect(() => trabajo(db, restaurante, p, { evento_id: evento, comanda_id: comanda })).toThrow(
      /UNIQUE/,
    )
    expect(contar(db, 'trabajo_impresion')).toBe(1)
  })

  it('con ON CONFLICT DO NOTHING (como lo usa el hub) el reintento se ignora sin error', () => {
    const { db, restaurante } = migrada()
    const p = impresora(db, restaurante)
    const insertar = () =>
      db
        .prepare(
          `INSERT INTO trabajo_impresion (id, restaurante_id, impresora_id, tipo, evento_id, comanda_id, contenido, creado_en)
           VALUES (?, ?, ?, 'comanda', ?, ?, '{}', ?) ON CONFLICT DO NOTHING`,
        )
        .run(nuevoId(), restaurante, p, evento, comanda, AHORA)
    expect(Number(insertar().changes)).toBe(1)
    expect(Number(insertar().changes)).toBe(0)
    expect(contar(db, 'trabajo_impresion')).toBe(1)
  })

  it('también cuenta aunque el primero ya se imprimió o se descartó', () => {
    const { db, restaurante } = migrada()
    const p = impresora(db, restaurante)
    trabajo(db, restaurante, p, {
      evento_id: evento,
      comanda_id: comanda,
      estado: 'impreso',
      terminado_en: AHORA,
      impreso_en_id: p,
    })
    expect(() => trabajo(db, restaurante, p, { evento_id: evento, comanda_id: comanda })).toThrow(
      /UNIQUE/,
    )
  })

  it('la misma comanda en otra impresora, u otra comanda del mismo evento, sí se guarda', () => {
    const { db, restaurante } = migrada()
    const p1 = impresora(db, restaurante)
    const p2 = impresora(db, restaurante, { nombre: 'Barra' })
    trabajo(db, restaurante, p1, { evento_id: evento, comanda_id: comanda })
    expect(() =>
      trabajo(db, restaurante, p2, { evento_id: evento, comanda_id: comanda }),
    ).not.toThrow()
    expect(() =>
      trabajo(db, restaurante, p1, { evento_id: evento, comanda_id: nuevoId() }),
    ).not.toThrow()
    expect(() =>
      trabajo(db, restaurante, p1, { evento_id: nuevoId(), comanda_id: comanda }),
    ).not.toThrow()
    expect(contar(db, 'trabajo_impresion')).toBe(4)
  })

  it('las páginas de prueba (sin evento) pueden repetirse todas las veces que se quiera', () => {
    const { db, restaurante } = migrada()
    const p = impresora(db, restaurante)
    for (let i = 0; i < 3; i++) trabajo(db, restaurante, p, { tipo: 'prueba' })
    expect(contar(db, 'trabajo_impresion')).toBe(3)
  })

  it('un trabajo sin comanda (comanda_id NULL) de un mismo evento no queda cubierto por el índice', () => {
    // Documenta el límite del índice: SQLite no compara NULL con NULL. El hub siempre manda
    // `comanda_id`, así que esto no pasa en uso normal.
    const { db, restaurante } = migrada()
    const p = impresora(db, restaurante)
    trabajo(db, restaurante, p, { evento_id: evento })
    expect(() => trabajo(db, restaurante, p, { evento_id: evento })).not.toThrow()
  })

  it('el índice es parcial: existe con ese nombre y solo cubre trabajos con evento', () => {
    const { db } = migrada()
    const indice = db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'trabajo_impresion_unico'",
      )
      .get()
    expect(String(indice?.sql)).toMatch(/UNIQUE/i)
    expect(String(indice?.sql)).toMatch(/WHERE evento_id IS NOT NULL/i)
  })
})

describe('migración 6: varios restaurantes en la misma base', () => {
  it('cada restaurante tiene sus impresoras y su cola; los conteos no se cruzan', () => {
    const { db, restaurante } = migrada()
    const otro = sembrar(db).restaurante
    const p1 = impresora(db, restaurante)
    const p2 = impresora(db, otro)
    trabajo(db, restaurante, p1)
    trabajo(db, otro, p2)
    trabajo(db, otro, p2)
    const por = (r: string) =>
      Number(
        db.prepare('SELECT count(*) AS n FROM trabajo_impresion WHERE restaurante_id = ?').get(r)
          ?.n,
      )
    expect(por(restaurante)).toBe(1)
    expect(por(otro)).toBe(2)
    expect(
      Number(
        db.prepare('SELECT count(*) AS n FROM impresora WHERE restaurante_id = ?').get(otro)?.n,
      ),
    ).toBe(1)
  })
})
