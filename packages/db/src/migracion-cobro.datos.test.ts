import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { MIGRACIONES } from './migraciones'
import { aplicarMigraciones, versionActual } from './migrar'
import { abrirBase } from './node'
import { AHORA, insertarEnTabla, insertarVersionado, sembrar } from './pruebas/utiles'
import type { BaseSqlite } from './sqlite'

// Migración 7 con datos reales de una base 6: la cola de impresión se reconstruye (SQLite no deja
// cambiar un CHECK) y no puede perder ni mover nada de lo que ya estaba.

const HASTA_6 = MIGRACIONES.filter((m) => m.version <= 6)

function baseVersion6() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db, HASTA_6)
  const s = sembrar(db)
  const impresora = (nombre: string, ancho = 80) =>
    insertarVersionado(db, 'impresora', s.restaurante, {
      nombre,
      conexion: 'red',
      direccion: '192.168.1.50',
      puerto: 9100,
      ancho,
    })
  const barra = impresora('Barra')
  const cocina = impresora('Cocina', 58)
  const rol = insertarVersionado(db, 'rol', s.restaurante, { nombre: 'Cajero' })
  const usuario = insertarVersionado(db, 'usuario', s.restaurante, { nombre: 'Caja', rol_id: rol })
  const dispositivo = insertarVersionado(db, 'dispositivo', s.restaurante, {
    sede_id: s.sede,
    nombre: 'Caja 1',
    tipo: 'caja',
  })
  const trabajo = (campos: Record<string, string | number | null>) => {
    const id = nuevoId()
    insertarEnTabla(db, 'trabajo_impresion', {
      id,
      restaurante_id: s.restaurante,
      impresora_id: barra,
      tipo: 'comanda',
      contenido: '{"estacion":"Barra","lineas":["1 x Garden Margarita"]}',
      creado_en: AHORA,
      ...campos,
    })
    return id
  }
  return { db, ...s, barra, cocina, usuario, dispositivo, trabajo }
}

const filas = (db: BaseSqlite) => db.prepare('SELECT * FROM trabajo_impresion ORDER BY id').all()

/** Una cola con un trabajo de cada estado y con todas las columnas llenas. */
function conCola() {
  const base = baseVersion6()
  const { trabajo, cocina, barra, usuario, dispositivo } = base
  const pendiente = trabajo({
    evento_id: nuevoId(),
    comanda_id: nuevoId(),
    impresora_id: cocina,
    intentos: 4,
    ultimo_error: 'ECONNREFUSED 192.168.1.50:9100',
  })
  const impreso = trabajo({
    estado: 'impreso',
    terminado_en: AHORA,
    impreso_en_id: cocina,
    intentos: 2,
    evento_id: nuevoId(),
    comanda_id: nuevoId(),
  })
  const descartado = trabajo({
    estado: 'descartado',
    terminado_en: AHORA,
    descartado_por_id: usuario,
    descartado_dispositivo_id: dispositivo,
    ultimo_error: 'sin papel',
    intentos: 7,
    impresora_id: barra,
  })
  const prueba = trabajo({ tipo: 'prueba', contenido: '{"prueba":true}' })
  return { ...base, pendiente, impreso, descartado, prueba }
}

describe('migración 7: una base 6 con trabajos de impresión de todos los estados', () => {
  it('cada fila queda idéntica, columna por columna (nada se corre ni se pierde)', () => {
    const { db } = conCola()
    const antes = filas(db)
    expect(antes).toHaveLength(4)
    expect(aplicarMigraciones(db)).toEqual([7])
    const despues = filas(db)
    expect(despues).toEqual(antes)
    // Las columnas no cambiaron ni de nombre ni de orden.
    const columnas = (tabla: string) =>
      db
        .prepare(`SELECT name FROM pragma_table_info('${tabla}')`)
        .all()
        .map((c) => c.name)
    expect(Object.keys(despues[0] ?? {})).toEqual(columnas('trabajo_impresion'))
  })

  it('conserva los datos que importan de una persona: quién descartó, desde qué equipo y por qué', () => {
    const { db, descartado, usuario, dispositivo, barra } = conCola()
    aplicarMigraciones(db)
    expect(
      db.prepare('SELECT * FROM trabajo_impresion WHERE id = ?').get(descartado),
    ).toMatchObject({
      estado: 'descartado',
      descartado_por_id: usuario,
      descartado_dispositivo_id: dispositivo,
      ultimo_error: 'sin papel',
      intentos: 7,
      impresora_id: barra,
      terminado_en: AHORA,
    })
  })

  it('el contenido JSON, el evento y la comanda de un pendiente se mantienen', () => {
    const { db, pendiente } = conCola()
    const antes = db.prepare('SELECT * FROM trabajo_impresion WHERE id = ?').get(pendiente)
    aplicarMigraciones(db)
    const despues = db.prepare('SELECT * FROM trabajo_impresion WHERE id = ?').get(pendiente)
    expect(despues).toEqual(antes)
    expect(JSON.parse(String(despues?.contenido))).toEqual({
      estacion: 'Barra',
      lineas: ['1 x Garden Margarita'],
    })
    expect(despues).toMatchObject({ estado: 'pendiente', intentos: 4, terminado_en: null })
  })

  it('las demás tablas quedan intactas y las claves foráneas, sin referencias rotas', () => {
    const { db } = conCola()
    const tablas = ['restaurante', 'impresora', 'usuario', 'dispositivo', 'rol', 'producto']
    const cuenta = (t: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${t}`).get()?.n)
    const antes = tablas.map(cuenta)
    aplicarMigraciones(db)
    expect(tablas.map(cuenta)).toEqual(antes)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
  })

  it('las claves foráneas quedan encendidas y se siguen exigiendo en la cola nueva', () => {
    const { db, trabajo } = conCola()
    aplicarMigraciones(db)
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(() => trabajo({ impresora_id: nuevoId() })).toThrow(/FOREIGN KEY/)
    expect(() =>
      trabajo({
        estado: 'descartado',
        terminado_en: AHORA,
        descartado_por_id: nuevoId(),
      }),
    ).toThrow(/FOREIGN KEY/)
  })

  it('la tabla no deja restos: ni la temporal ni índices o disparadores duplicados', () => {
    const { db } = conCola()
    aplicarMigraciones(db)
    const objetos = db
      .prepare(
        "SELECT type, name FROM sqlite_schema WHERE tbl_name LIKE 'trabajo_impresion%' ORDER BY name",
      )
      .all()
      .map((o) => `${o.type}:${o.name}`)
    expect(objetos.filter((o) => o.includes('nueva'))).toEqual([])
    expect(objetos).toEqual(
      expect.arrayContaining([
        'index:trabajo_impresion_pendiente',
        'index:trabajo_impresion_unico',
        'trigger:trabajo_impresion_sin_delete',
        'trigger:trabajo_impresion_sin_reemplazo',
        'table:trabajo_impresion',
      ]),
    )
    expect(new Set(objetos).size).toBe(objetos.length)
    const tabla = db
      .prepare('PRAGMA table_list')
      .all()
      .find((t) => t.name === 'trabajo_impresion')
    expect(tabla).toMatchObject({ strict: 1 })
  })

  it('las reglas de la tabla siguen vigentes con los trabajos migrados', () => {
    const { db, trabajo, pendiente, impreso, barra } = conCola()
    aplicarMigraciones(db)
    // No se borra ni se reemplaza uno que ya existía antes de migrar.
    expect(() => db.prepare('DELETE FROM trabajo_impresion WHERE id = ?').run(pendiente)).toThrow(
      /no se borra/,
    )
    expect(() =>
      db.prepare("UPDATE trabajo_impresion SET estado = 'cualquiera' WHERE id = ?").run(impreso),
    ).toThrow()
    // El estado pendiente va sin hora de término, y los terminados con ella.
    expect(() => trabajo({ estado: 'pendiente', terminado_en: AHORA })).toThrow()
    expect(() => trabajo({ estado: 'impreso' })).toThrow()
    // Impreso necesita decir en qué impresora salió.
    expect(() => trabajo({ estado: 'impreso', terminado_en: AHORA })).toThrow()
    expect(() =>
      trabajo({ estado: 'impreso', terminado_en: AHORA, impreso_en_id: barra }),
    ).not.toThrow()
    expect(() => trabajo({ intentos: -1 })).toThrow()
    expect(() => trabajo({ contenido: 'no es json' })).toThrow()
  })

  it('el mismo evento con la misma comanda no se duplica en una impresora, ni tampoco migrado', () => {
    const { db, trabajo, pendiente, cocina } = conCola()
    aplicarMigraciones(db)
    const migrado = db.prepare('SELECT * FROM trabajo_impresion WHERE id = ?').get(pendiente)
    expect(() =>
      trabajo({
        evento_id: String(migrado?.evento_id),
        comanda_id: String(migrado?.comanda_id),
        impresora_id: cocina,
      }),
    ).toThrow(/UNIQUE/)
    // Otra impresora o otra comanda del mismo evento sí.
    expect(() =>
      trabajo({
        evento_id: String(migrado?.evento_id),
        comanda_id: String(migrado?.comanda_id),
      }),
    ).not.toThrow()
    expect(() =>
      trabajo({
        evento_id: String(migrado?.evento_id),
        comanda_id: nuevoId(),
        impresora_id: cocina,
      }),
    ).not.toThrow()
  })

  it('los trabajos sin evento (pruebas) pueden repetirse: el índice único los ignora', () => {
    const { db, trabajo } = conCola()
    aplicarMigraciones(db)
    expect(() => {
      trabajo({ tipo: 'prueba' })
      trabajo({ tipo: 'prueba' })
      trabajo({ tipo: 'precuenta' })
      trabajo({ tipo: 'precuenta' })
    }).not.toThrow()
  })

  it('el índice de pendientes sigue sirviendo a la cola (restaurante, estado, creado_en)', () => {
    const { db } = conCola()
    aplicarMigraciones(db)
    const columnas = db
      .prepare("SELECT name FROM pragma_index_info('trabajo_impresion_pendiente') ORDER BY seqno")
      .all()
      .map((c) => c.name)
    expect(columnas).toEqual(['restaurante_id', 'estado', 'creado_en'])
  })

  it('una precuenta sin evento ni comanda se guarda y se consulta como pendiente', () => {
    const { db, trabajo } = conCola()
    aplicarMigraciones(db)
    const id = trabajo({
      tipo: 'precuenta',
      evento_id: nuevoId(),
      comanda_id: null,
      contenido: '{"mesa":"5"}',
    })
    expect(db.prepare('SELECT tipo, estado FROM trabajo_impresion WHERE id = ?').get(id)).toEqual({
      tipo: 'precuenta',
      estado: 'pendiente',
    })
    const pendientes = db
      .prepare("SELECT count(*) AS n FROM trabajo_impresion WHERE estado = 'pendiente'")
      .get()
    expect(pendientes).toEqual({ n: 3 })
  })
})

describe('migración 7: casos de borde', () => {
  it('con la cola vacía también aplica', () => {
    const db = abrirBase(':memory:')
    aplicarMigraciones(db, HASTA_6)
    sembrar(db)
    expect(aplicarMigraciones(db)).toEqual([7])
    expect(filas(db)).toEqual([])
  })

  it('desde una base nueva se aplican las siete en orden', () => {
    const db = abrirBase(':memory:')
    expect(aplicarMigraciones(db)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(versionActual(db)).toBe(7)
  })

  it('repetir la migración no hace nada y no toca los trabajos', () => {
    const { db } = conCola()
    aplicarMigraciones(db)
    const antes = filas(db)
    expect(aplicarMigraciones(db)).toEqual([])
    expect(filas(db)).toEqual(antes)
  })

  it('si hay una referencia rota, la migración falla entera: la base sigue en la 6 con su cola', () => {
    const { db, trabajo } = conCola()
    // Un trabajo con una impresora que no existe (se coló con las claves apagadas).
    db.exec('PRAGMA foreign_keys = OFF')
    trabajo({ impresora_id: nuevoId() })
    db.exec('PRAGMA foreign_keys = ON')
    const antes = filas(db)
    expect(() => aplicarMigraciones(db)).toThrow(/referencias rotas/)
    expect(versionActual(db)).toBe(6)
    expect(filas(db)).toEqual(antes)
    // No quedó ninguna tabla a medias y la tabla vieja sigue aceptando comandas.
    const nombres = db
      .prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'trabajo_impresion%'")
      .all()
      .map((o) => o.name)
    expect(nombres).not.toContain('trabajo_impresion_nueva')
    expect(nombres).not.toContain('datafono')
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
  })

  it('un trabajo con un tipo que la 6 no conoce sigue sin poder entrar', () => {
    const { db, trabajo } = conCola()
    expect(() => trabajo({ tipo: 'precuenta' })).toThrow()
    expect(() => trabajo({ tipo: 'ticket' })).toThrow()
    aplicarMigraciones(db)
    expect(() => trabajo({ tipo: 'ticket' })).toThrow()
  })
})

describe('migración 7: datafono', () => {
  function migrada() {
    const base = baseVersion6()
    aplicarMigraciones(base.db)
    const datafono = (campos: Record<string, string | number | null> = {}) =>
      insertarVersionado(base.db, 'datafono', base.restaurante, {
        nombre: 'Bold 1',
        proveedor: 'bold',
        ...campos,
      })
    return { ...base, datafono }
  }

  it.each(['bold', 'redeban', 'credibanco', 'otro'])('acepta el proveedor %s', (proveedor) => {
    const { datafono } = migrada()
    expect(() => datafono({ proveedor })).not.toThrow()
  })

  it.each(['visa', '', 'BOLD', null])('rechaza el proveedor %s', (proveedor) => {
    const { datafono } = migrada()
    expect(() => datafono({ proveedor })).toThrow()
  })

  it('el nombre va de 1 a 60 caracteres', () => {
    const { datafono } = migrada()
    expect(() => datafono({ nombre: 'x' })).not.toThrow()
    expect(() => datafono({ nombre: 'x'.repeat(60) })).not.toThrow()
    expect(() => datafono({ nombre: 'x'.repeat(61) })).toThrow()
    expect(() => datafono({ nombre: '' })).toThrow()
    expect(() => datafono({ nombre: null })).toThrow()
  })

  it('nace activo, y activo solo vale 0 o 1', () => {
    const { db, datafono } = migrada()
    const id = datafono()
    expect(db.prepare('SELECT activo FROM datafono WHERE id = ?').get(id)).toEqual({ activo: 1 })
    expect(() => datafono({ activo: 2 })).toThrow()
    expect(() => datafono({ activo: -1 })).toThrow()
  })

  it('se archiva con activo = 0 y se vuelve a usar; no se borra', () => {
    const { db, datafono } = migrada()
    const id = datafono()
    db.prepare('UPDATE datafono SET activo = 0, version = version + 1 WHERE id = ?').run(id)
    expect(db.prepare('SELECT activo, version FROM datafono WHERE id = ?').get(id)).toEqual({
      activo: 0,
      version: 2,
    })
    db.prepare('UPDATE datafono SET activo = 1, version = version + 1 WHERE id = ?').run(id)
    expect(db.prepare('SELECT activo FROM datafono WHERE id = ?').get(id)).toEqual({ activo: 1 })
    expect(() => db.prepare('DELETE FROM datafono WHERE id = ?').run(id)).toThrow(/se archiva/)
  })

  it('exige un restaurante que exista y un ULID de 26 caracteres', () => {
    const { db, datafono } = migrada()
    expect(() =>
      insertarVersionado(db, 'datafono', nuevoId(), { nombre: 'Huérfano', proveedor: 'bold' }),
    ).toThrow(/FOREIGN KEY/)
    expect(() =>
      insertarVersionado(
        db,
        'datafono',
        String(db.prepare('SELECT id FROM restaurante').get()?.id),
        { nombre: 'Corto', proveedor: 'bold' },
        'corto',
      ),
    ).toThrow()
    expect(() => datafono()).not.toThrow()
  })

  it('la versión no puede ser negativa y el índice por versión sirve a la sincronización', () => {
    const { db, datafono } = migrada()
    expect(() => datafono({ version: -1 })).toThrow()
    const columnas = db
      .prepare("SELECT name FROM pragma_index_info('datafono_por_version') ORDER BY seqno")
      .all()
      .map((c) => c.name)
    expect(columnas).toEqual(['restaurante_id', 'version'])
  })

  it('cada restaurante tiene los suyos: dos pueden llamar igual a su datáfono', () => {
    const { db, datafono } = migrada()
    const otro = nuevoId()
    insertarVersionado(db, 'restaurante', otro, { nombre: 'Otro', config: '{}' }, otro)
    datafono()
    expect(() =>
      insertarVersionado(db, 'datafono', otro, { nombre: 'Bold 1', proveedor: 'bold' }),
    ).not.toThrow()
    expect(
      db.prepare('SELECT count(*) AS n FROM datafono WHERE restaurante_id = ?').get(otro),
    ).toEqual({ n: 1 })
  })
})
