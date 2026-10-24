import { nuevoId } from '@pos/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { aplicarMigraciones } from './migrar'
import { abrirBase } from './node'
import {
  AHORA,
  insertarConflicto,
  insertarEnTabla,
  insertarEvento,
  insertarItem,
  insertarPedido,
  insertarVersionado,
  sembrar,
} from './pruebas/utiles'
import type { BaseSqlite } from './sqlite'

describe('restricciones del esquema', () => {
  let db: BaseSqlite
  let base: ReturnType<typeof sembrar>

  beforeEach(() => {
    db = abrirBase(':memory:')
    aplicarMigraciones(db)
    base = sembrar(db)
  })

  const mesa = (campos: Record<string, string | number> = {}) =>
    insertarVersionado(db, 'mesa', base.restaurante, {
      zona_id: base.zona,
      nombre: '1',
      forma: 'redonda',
      x: 0,
      y: 0,
      ancho: 2,
      alto: 2,
      capacidad: 4,
      ...campos,
    })

  describe('mesa', () => {
    it('acepta una mesa válida y los límites de rotación', () => {
      expect(() => mesa()).not.toThrow()
      expect(() => mesa({ rotacion: 0 })).not.toThrow()
      expect(() => mesa({ rotacion: 359 })).not.toThrow()
      expect(() => mesa({ capacidad: 1 })).not.toThrow()
    })

    it.each(['hexagonal', '', 'REDONDA'])('rechaza la forma "%s"', (forma) => {
      expect(() => mesa({ forma })).toThrow(/CHECK/)
    })

    it.each(['redonda', 'cuadrada', 'rectangular', 'barra'])('acepta la forma %s', (forma) => {
      expect(() => mesa({ forma })).not.toThrow()
    })

    it.each([-1, 360, 720])('rechaza la rotación %d', (rotacion) => {
      expect(() => mesa({ rotacion })).toThrow(/CHECK/)
    })

    it.each([0, -3])('rechaza la capacidad %d', (capacidad) => {
      expect(() => mesa({ capacidad })).toThrow(/CHECK/)
    })

    it.each([0, -1])('rechaza ancho o alto %d', (medida) => {
      expect(() => mesa({ ancho: medida })).toThrow(/CHECK/)
      expect(() => mesa({ alto: medida })).toThrow(/CHECK/)
    })

    it('rechaza una rotación con decimales', () => {
      expect(() => mesa({ rotacion: 45.5 })).toThrow()
    })
  })

  describe('dispositivo', () => {
    const dispositivo = (tipo: string) =>
      insertarVersionado(db, 'dispositivo', base.restaurante, {
        sede_id: base.sede,
        nombre: 'Celular 1',
        tipo,
      })

    it.each(['mesero', 'caja', 'kds'])('acepta el tipo %s', (tipo) => {
      expect(() => dispositivo(tipo)).not.toThrow()
    })

    it.each(['tablet', '', 'Caja'])('rechaza el tipo "%s"', (tipo) => {
      expect(() => dispositivo(tipo)).toThrow(/CHECK/)
    })
  })

  describe('pedido e ítems', () => {
    it.each(['abierto', 'cerrado', 'cancelado'])('acepta el estado de pedido %s', (estado) => {
      expect(() => insertarPedido(db, base.restaurante, { estado })).not.toThrow()
    })

    it.each(['anulado', 'pagado', ''])('rechaza el estado de pedido "%s"', (estado) => {
      expect(() => insertarPedido(db, base.restaurante, { estado })).toThrow(/CHECK/)
    })

    it('rechaza un canal de pedido desconocido', () => {
      expect(() => insertarPedido(db, base.restaurante, { canal: 'drone' })).toThrow(/CHECK/)
    })

    it('rechaza un número del día menor que 1', () => {
      expect(() => insertarPedido(db, base.restaurante, { numero_dia: 0 })).toThrow(/CHECK/)
    })

    it.each([
      'retenido',
      'pendiente',
      'enviado',
      'en_preparacion',
      'listo',
      'entregado',
      'anulado',
    ])('acepta el estado de ítem %s', (estado) => {
      const pedido = insertarPedido(db, base.restaurante)
      expect(() => insertarItem(db, base.restaurante, pedido, { estado })).not.toThrow()
    })

    it.each(['cancelado', 'preparando', ''])('rechaza el estado de ítem "%s"', (estado) => {
      const pedido = insertarPedido(db, base.restaurante)
      expect(() => insertarItem(db, base.restaurante, pedido, { estado })).toThrow(/CHECK/)
    })

    it('rechaza un curso o un tipo de impuesto desconocidos', () => {
      const pedido = insertarPedido(db, base.restaurante)
      expect(() => insertarItem(db, base.restaurante, pedido, { curso: 'aperitivo' })).toThrow(
        /CHECK/,
      )
      expect(() => insertarItem(db, base.restaurante, pedido, { impuesto_tipo: 'icui' })).toThrow(
        /CHECK/,
      )
    })

    it('rechaza estacion_ids que no es JSON', () => {
      const pedido = insertarPedido(db, base.restaurante)
      expect(() => insertarItem(db, base.restaurante, pedido, { estacion_ids: '[1,' })).toThrow(
        /CHECK/,
      )
    })

    it('rechaza precio_extra negativo o con decimales en el modificador de un ítem', () => {
      const pedido = insertarPedido(db, base.restaurante)
      const item = insertarItem(db, base.restaurante, pedido)
      const modificador = (precio_extra: number) =>
        insertarEnTabla(db, 'pedido_item_modificador', {
          pedido_item_id: item,
          modificador_id: nuevoId(),
          nombre: 'Extra queso',
          precio_extra,
        })

      expect(() => modificador(3000)).not.toThrow()
      expect(() => modificador(-1)).toThrow(/CHECK/)
      expect(() => modificador(100.5)).toThrow()
    })

    it('al borrar un pedido se borran sus ítems (proyección reconstruible)', () => {
      const pedido = insertarPedido(db, base.restaurante)
      insertarItem(db, base.restaurante, pedido)

      db.prepare('DELETE FROM pedido WHERE id = ?').run(pedido)

      expect(db.prepare('SELECT count(*) AS n FROM pedido_item').get()?.n).toBe(0)
    })
  })

  describe('grupos y modificadores', () => {
    const grupo = (minimo: number, maximo: number) =>
      insertarVersionado(db, 'grupo_modificador', base.restaurante, {
        nombre: 'Salsas',
        minimo,
        maximo,
      })

    it('acepta mínimo igual al máximo y mínimo cero', () => {
      expect(() => grupo(0, 1)).not.toThrow()
      expect(() => grupo(2, 2)).not.toThrow()
    })

    it.each([
      [3, 2],
      [1, 0],
      [-1, 2],
      [0, 0],
    ])('rechaza el grupo con mínimo %d y máximo %d', (minimo, maximo) => {
      expect(() => grupo(minimo, maximo)).toThrow(/CHECK/)
    })

    it('rechaza precio_extra negativo y por encima del tope en un modificador', () => {
      const grupoId = grupo(0, 2)
      const modificador = (precio_extra: number) =>
        insertarVersionado(db, 'modificador', base.restaurante, {
          grupo_id: grupoId,
          nombre: 'Picante',
          precio_extra,
        })

      expect(() => modificador(0)).not.toThrow()
      expect(() => modificador(-500)).toThrow(/CHECK/)
      expect(() => modificador(100_000_001)).toThrow(/CHECK/)
    })

    it('un producto no repite el mismo grupo', () => {
      const grupoId = grupo(0, 2)
      const vincular = () =>
        insertarVersionado(db, 'producto_grupo_modificador', base.restaurante, {
          producto_id: base.producto,
          grupo_id: grupoId,
        })

      vincular()
      expect(() => vincular()).toThrow(/UNIQUE/)
    })
  })

  describe('ids', () => {
    it.each(['', 'CORTO', '0'.repeat(25), '0'.repeat(27)])(
      'rechaza el id "%s" que no mide 26',
      (id) => {
        expect(() =>
          insertarVersionado(db, 'categoria', base.restaurante, { nombre: 'X' }, id),
        ).toThrow(/CHECK/)
        expect(() => insertarEvento(db, base.restaurante, { id })).toThrow(/CHECK/)
        expect(() => insertarConflicto(db, base.restaurante, { id })).toThrow(/CHECK/)
      },
    )

    it('acepta un id de exactamente 26 caracteres', () => {
      expect(() =>
        insertarVersionado(db, 'categoria', base.restaurante, { nombre: 'X' }, '0'.repeat(26)),
      ).not.toThrow()
    })

    it('rechaza un id de pedido de longitud incorrecta', () => {
      const pedido = nuevoId().slice(0, 20)
      expect(() =>
        insertarEnTabla(db, 'pedido', {
          id: pedido,
          restaurante_id: base.restaurante,
          canal: 'salon',
          estado: 'abierto',
          abierto_en: AHORA,
          ultima_secuencia: 1,
        }),
      ).toThrow(/CHECK/)
    })

    it('el restaurante debe ser su propio restaurante_id', () => {
      const id = nuevoId()
      expect(() =>
        insertarVersionado(db, 'restaurante', nuevoId(), { nombre: 'X', config: '{}' }, id),
      ).toThrow(/CHECK/)
    })
  })

  describe('JSON', () => {
    it.each(['relacionados', 'afecta', 'asignaciones', 'datos'])(
      'rechaza JSON inválido en evento.%s',
      (columna) => {
        expect(() => insertarEvento(db, base.restaurante, { [columna]: '{roto' })).toThrow(/CHECK/)
        expect(() => insertarEvento(db, base.restaurante, { [columna]: '' })).toThrow(/CHECK/)
      },
    )

    it.each([
      ['relacionados', '["01HZX"]'],
      ['afecta', '[]'],
      ['asignaciones', '{"numero_dia":4}'],
    ])('acepta JSON válido en evento.%s', (columna, valor) => {
      expect(() => insertarEvento(db, base.restaurante, { [columna]: valor })).not.toThrow()
    })

    it('los valores por defecto de relacionados, afecta y asignaciones son JSON vacío', () => {
      const evento = insertarEvento(db, base.restaurante)
      const fila = db
        .prepare('SELECT relacionados, afecta, asignaciones FROM evento WHERE id = ?')
        .get(evento.id ?? null)

      expect(fila).toEqual({ relacionados: '[]', afecta: '[]', asignaciones: '{}' })
    })

    it('rechaza config del restaurante que no es JSON', () => {
      const id = nuevoId()
      expect(() =>
        insertarVersionado(db, 'restaurante', id, { nombre: 'X', config: 'no json' }, id),
      ).toThrow(/CHECK/)
    })

    it('rechaza contenido de cuarentena que no es JSON', () => {
      const fila = (contenido: string) =>
        insertarEnTabla(db, 'evento_cuarentena', {
          restaurante_id: base.restaurante,
          evento_id: nuevoId(),
          dispositivo_id: nuevoId(),
          motivo: 'esquema desconocido',
          contenido,
          recibido_en: AHORA,
        })

      expect(() => fila('{"a":1}')).not.toThrow()
      expect(() => fila('<html>')).toThrow(/CHECK/)
    })
  })

  describe('eventos', () => {
    it.each(['pedido', 'mesa', 'producto', 'catalogo', 'turno_caja', 'usuario', 'sistema'])(
      'acepta agregado_tipo %s',
      (agregado_tipo) => {
        expect(() =>
          insertarEvento(db, base.restaurante, { agregado_tipo, secuencia: 1 }),
        ).not.toThrow()
      },
    )

    it.each(['cliente', '', 'Pedido'])('rechaza agregado_tipo "%s"', (agregado_tipo) => {
      expect(() => insertarEvento(db, base.restaurante, { agregado_tipo })).toThrow(/CHECK/)
    })

    it('rechaza secuencia 0, secuencia_base negativa y version_esquema 0', () => {
      expect(() => insertarEvento(db, base.restaurante, { secuencia: 0 })).toThrow(
        /CHECK|siguiente/,
      )
      expect(() => insertarEvento(db, base.restaurante, { secuencia_base: -1 })).toThrow(/CHECK/)
      expect(() => insertarEvento(db, base.restaurante, { version_esquema: 0 })).toThrow(/CHECK/)
    })

    it('rechaza un evento de un restaurante que no existe', () => {
      expect(() => insertarEvento(db, nuevoId())).toThrow(/FOREIGN KEY/)
    })

    it('no admite el mismo evento rechazado dos veces ni modificarlo', () => {
      const id = nuevoId()
      const rechazar = () =>
        insertarEnTabla(db, 'evento_rechazado', {
          restaurante_id: base.restaurante,
          evento_id: id,
          dispositivo_id: nuevoId(),
          motivo: 'id repetido con otro contenido',
          contenido: '{}',
          contenido_hash: 'h',
          recibido_en: AHORA,
        })

      rechazar()
      expect(() => rechazar()).toThrow(/no se reemplazan|UNIQUE|PRIMARY KEY/)
      // El mismo id con otro contenido (id_repetido) sí se registra aparte.
      expect(() =>
        insertarEnTabla(db, 'evento_rechazado', {
          restaurante_id: base.restaurante,
          evento_id: id,
          dispositivo_id: nuevoId(),
          motivo: 'id_repetido',
          contenido: '{"otro":1}',
          contenido_hash: 'h2',
          recibido_en: AHORA,
        }),
      ).not.toThrow()
      expect(() => db.exec("UPDATE evento_rechazado SET motivo = 'otro'")).toThrow(
        /no se modifican/,
      )
      expect(() => db.exec('DELETE FROM evento_rechazado')).toThrow(/no se borran/)
    })

    it('rechaza una resolución de cuarentena desconocida', () => {
      expect(() =>
        insertarEnTabla(db, 'evento_cuarentena', {
          restaurante_id: base.restaurante,
          evento_id: nuevoId(),
          dispositivo_id: nuevoId(),
          motivo: 'm',
          contenido: '{}',
          recibido_en: AHORA,
          resolucion: 'ignorado',
        }),
      ).toThrow(/CHECK/)
    })
  })

  describe('evento_agregado', () => {
    const indexar = (evento_id: string, agregado_id = nuevoId(), secuencia = 1) =>
      insertarEnTabla(db, 'evento_agregado', {
        restaurante_id: base.restaurante,
        agregado_id,
        secuencia,
        evento_id,
      })

    it('indexa un evento existente', () => {
      const evento = insertarEvento(db, base.restaurante)

      expect(() => indexar(String(evento.id), String(evento.agregado_id))).not.toThrow()
    })

    it('rechaza apuntar a un evento inexistente', () => {
      expect(() => indexar(nuevoId())).toThrow(/FOREIGN KEY/)
    })

    it('rechaza apuntar a un evento de otro restaurante', () => {
      const otro = nuevoId()
      insertarVersionado(db, 'restaurante', otro, { nombre: 'Otro', config: '{}' }, otro)
      const ajeno = insertarEvento(db, otro)

      expect(() => indexar(String(ajeno.id))).toThrow(/FOREIGN KEY/)
    })

    it('no se modifica ni se borra', () => {
      const evento = insertarEvento(db, base.restaurante)
      indexar(String(evento.id), String(evento.agregado_id))

      expect(() => db.exec('UPDATE evento_agregado SET secuencia = 9')).toThrow(/no se modifican/)
      expect(() => db.exec('DELETE FROM evento_agregado')).toThrow(/no se borran/)
    })

    it('un evento no se puede borrar aunque lo referencie el índice', () => {
      const evento = insertarEvento(db, base.restaurante)
      indexar(String(evento.id), String(evento.agregado_id))

      expect(() => db.prepare('DELETE FROM evento WHERE id = ?').run(String(evento.id))).toThrow(
        /no se borran/,
      )
    })
  })

  describe('conflicto', () => {
    it.each([
      'mesa_duplicada',
      'mesa_bloqueada',
      'item_inexistente',
      'item_ya_enviado',
      'item_ya_anulado',
      'item_movido',
      'pedido_cerrado',
      'precio_distinto',
    ])('acepta el tipo %s', (tipo) => {
      expect(() => insertarConflicto(db, base.restaurante, { tipo })).not.toThrow()
    })

    it.each(['otro', '', 'Mesa_Duplicada'])('rechaza el tipo "%s"', (tipo) => {
      expect(() => insertarConflicto(db, base.restaurante, { tipo })).toThrow(/CHECK/)
    })

    it('guarda un solo conflicto por evento en un restaurante', () => {
      const evento_id = nuevoId()
      insertarConflicto(db, base.restaurante, { evento_id })

      expect(() =>
        insertarConflicto(db, base.restaurante, { evento_id, tipo: 'mesa_bloqueada' }),
      ).toThrow(/UNIQUE/)
    })

    it('el mismo evento_id puede tener conflicto en otro restaurante', () => {
      const otro = nuevoId()
      insertarVersionado(db, 'restaurante', otro, { nombre: 'Otro', config: '{}' }, otro)
      const evento_id = nuevoId()

      insertarConflicto(db, base.restaurante, { evento_id })
      expect(() => insertarConflicto(db, otro, { evento_id })).not.toThrow()
    })
  })

  describe('otras tablas', () => {
    it('rechaza tipos de impuesto desconocidos', () => {
      expect(() =>
        insertarVersionado(db, 'impuesto', base.restaurante, {
          nombre: 'X',
          tipo: 'icui',
          tarifa: 0,
        }),
      ).toThrow(/CHECK/)
    })

    it('un contador no puede ser negativo', () => {
      expect(() =>
        insertarEnTabla(db, 'contador', {
          restaurante_id: base.restaurante,
          nombre: 'catalogo',
          valor: -1,
        }),
      ).toThrow(/CHECK/)
    })

    it('activo solo admite 0 o 1', () => {
      expect(() =>
        insertarVersionado(db, 'categoria', base.restaurante, { nombre: 'X', activo: 2 }),
      ).toThrow(/CHECK/)
    })

    it('una credencial de dispositivo exige un token único', () => {
      const dispositivo = (nombre: string) =>
        insertarVersionado(db, 'dispositivo', base.restaurante, {
          sede_id: base.sede,
          nombre,
          tipo: 'mesero',
        })
      const credencial = (id: string) =>
        insertarEnTabla(db, 'dispositivo_credencial', {
          dispositivo_id: id,
          restaurante_id: base.restaurante,
          token_hash: 'mismo',
          creado_en: AHORA,
        })

      credencial(dispositivo('A'))
      expect(() => credencial(dispositivo('B'))).toThrow(/UNIQUE/)
    })
  })
})
