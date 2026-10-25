import type { EventoPedido } from '@pos/core'
import { type BaseSqlite, enTransaccion, type Fila } from '@pos/db'
import type { AlmacenHub, Conflicto, Cuarentena, Rechazo, TipoConflicto } from './almacen'

const texto = (v: unknown) => (v === null || v === undefined ? null : String(v))

function aEvento(f: Fila): EventoPedido {
  return {
    id: String(f.id),
    tipo: String(f.tipo),
    version_esquema: Number(f.version_esquema),
    agregado_tipo: String(f.agregado_tipo),
    agregado_id: String(f.agregado_id),
    relacionados: JSON.parse(String(f.relacionados)),
    datos: JSON.parse(String(f.datos)),
    sesion_id: texto(f.sesion_id),
    usuario_id: String(f.usuario_id),
    dispositivo_id: String(f.dispositivo_id),
    autorizacion_id: texto(f.autorizacion_id),
    motivo: texto(f.motivo),
    hora_dispositivo: String(f.hora_dispositivo),
    hora_estimada_hub: String(f.hora_estimada_hub),
    secuencia_base: Number(f.secuencia_base),
    secuencia: Number(f.secuencia),
    recibido_en: String(f.recibido_en),
    dia_operativo: String(f.dia_operativo),
    asignaciones: JSON.parse(String(f.asignaciones)),
    afecta: JSON.parse(String(f.afecta)),
    autorizado_por_id: texto(f.autorizado_por_id),
  } as EventoPedido
}

/** Almacén del hub sobre las tablas de `@pos/db` (evento, evento_agregado, rechazos, conflictos). */
export class AlmacenSqlite implements AlmacenHub {
  private readonly db: BaseSqlite
  private readonly restauranteId: string

  constructor(db: BaseSqlite, restauranteId: string) {
    this.db = db
    this.restauranteId = restauranteId
  }

  transaccion<T>(trabajo: () => T): T {
    return enTransaccion(this.db, trabajo)
  }

  maxSecuencia(): number {
    const fila = this.db
      .prepare('SELECT max(secuencia) AS m FROM evento WHERE restaurante_id = ?')
      .get(this.restauranteId)
    return Number(fila?.m ?? 0)
  }

  porId(id: string) {
    const fila = this.db
      .prepare('SELECT * FROM evento WHERE restaurante_id = ? AND id = ?')
      .get(this.restauranteId, id)
    return fila ? { evento: aEvento(fila), huella: String(fila.contenido_hash) } : undefined
  }

  rechazo(eventoId: string, huella: string): Rechazo | undefined {
    const f = this.db
      .prepare(
        'SELECT * FROM evento_rechazado WHERE restaurante_id = ? AND evento_id = ? AND contenido_hash = ?',
      )
      .get(this.restauranteId, eventoId, huella)
    if (!f) return undefined
    return {
      eventoId: String(f.evento_id),
      huella: String(f.contenido_hash),
      dispositivoId: String(f.dispositivo_id),
      motivo: String(f.motivo),
      contenido: String(f.contenido),
      recibidoEn: String(f.recibido_en),
    }
  }

  conflictoDe(eventoId: string): Conflicto | undefined {
    const f = this.db
      .prepare('SELECT * FROM conflicto WHERE restaurante_id = ? AND evento_id = ?')
      .get(this.restauranteId, eventoId)
    return f ? this.aConflicto(f) : undefined
  }

  ultimaSecuenciaDe(agregados: readonly string[], excepto?: string): number {
    if (agregados.length === 0) return 0
    const lista = agregados.map(() => '?').join(', ')
    const fila =
      excepto === undefined
        ? this.db
            .prepare(
              `SELECT max(secuencia) AS m FROM evento_agregado
               WHERE restaurante_id = ? AND agregado_id IN (${lista})`,
            )
            .get(this.restauranteId, ...agregados)
        : this.db
            .prepare(
              `SELECT max(a.secuencia) AS m FROM evento_agregado a
               JOIN evento e ON e.restaurante_id = a.restaurante_id AND e.id = a.evento_id
               WHERE a.restaurante_id = ? AND a.agregado_id IN (${lista}) AND e.dispositivo_id <> ?`,
            )
            .get(this.restauranteId, ...agregados, excepto)
    return Number(fila?.m ?? 0)
  }

  eventosDeAgregado(agregadoId: string): EventoPedido[] {
    return this.db
      .prepare(
        `SELECT e.* FROM evento_agregado a
         JOIN evento e ON e.restaurante_id = a.restaurante_id AND e.id = a.evento_id
         WHERE a.restaurante_id = ? AND a.agregado_id = ? ORDER BY a.secuencia`,
      )
      .all(this.restauranteId, agregadoId)
      .map(aEvento)
  }

  cuarentenasDe(dispositivoId: string): number {
    const fila = this.db
      .prepare(
        'SELECT count(*) AS n FROM evento_cuarentena WHERE restaurante_id = ? AND dispositivo_id = ?',
      )
      .get(this.restauranteId, dispositivoId)
    return Number(fila?.n ?? 0)
  }

  aperturasDelDia(dia: string): number {
    const fila = this.db
      .prepare(
        "SELECT count(*) AS n FROM evento WHERE restaurante_id = ? AND tipo = 'PedidoAbierto' AND dia_operativo = ?",
      )
      .get(this.restauranteId, dia)
    return Number(fila?.n ?? 0)
  }

  comandasDelDia(dia: string): number {
    const fila = this.db
      .prepare(
        `SELECT coalesce(sum((SELECT count(*) FROM json_each(asignaciones, '$.numeros_comanda'))), 0) AS n
         FROM evento WHERE restaurante_id = ? AND tipo = 'ItemsEnviados' AND dia_operativo = ?`,
      )
      .get(this.restauranteId, dia)
    return Number(fila?.n ?? 0)
  }

  eventosDesde(desde: number, limite: number): EventoPedido[] {
    return this.db
      .prepare(
        'SELECT * FROM evento WHERE restaurante_id = ? AND secuencia > ? ORDER BY secuencia LIMIT ?',
      )
      .all(this.restauranteId, desde, limite)
      .map(aEvento)
  }

  guardarEvento(e: EventoPedido, huella: string, agregados: readonly string[]) {
    this.db
      .prepare(
        `INSERT INTO evento (restaurante_id, id, tipo, version_esquema, agregado_tipo, agregado_id,
           relacionados, datos, sesion_id, usuario_id, dispositivo_id, autorizacion_id, autorizado_por_id,
           motivo, hora_dispositivo, hora_estimada_hub, secuencia_base, secuencia, recibido_en,
           dia_operativo, asignaciones, afecta, contenido_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.restauranteId,
        e.id,
        e.tipo,
        e.version_esquema,
        e.agregado_tipo,
        e.agregado_id,
        JSON.stringify(e.relacionados),
        JSON.stringify(e.datos),
        e.sesion_id,
        e.usuario_id,
        e.dispositivo_id,
        e.autorizacion_id,
        e.autorizado_por_id,
        e.motivo,
        e.hora_dispositivo,
        e.hora_estimada_hub,
        e.secuencia_base,
        e.secuencia,
        e.recibido_en,
        e.dia_operativo,
        JSON.stringify(e.asignaciones),
        JSON.stringify(e.afecta),
        huella,
      )
    const indice = this.db.prepare(
      'INSERT INTO evento_agregado (restaurante_id, agregado_id, secuencia, evento_id) VALUES (?, ?, ?, ?)',
    )
    for (const agregado of agregados) indice.run(this.restauranteId, agregado, e.secuencia, e.id)
  }

  guardarRechazo(r: Rechazo) {
    // Sin fila no salta el disparador `sin_reemplazo`: un rechazo repetido no hace nada.
    this.db
      .prepare(
        `INSERT INTO evento_rechazado (restaurante_id, evento_id, dispositivo_id, motivo, contenido, contenido_hash, recibido_en)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM evento_rechazado
           WHERE restaurante_id = ? AND evento_id = ? AND contenido_hash = ?)`,
      )
      .run(
        this.restauranteId,
        r.eventoId,
        r.dispositivoId,
        r.motivo,
        r.contenido,
        r.huella,
        r.recibidoEn,
        this.restauranteId,
        r.eventoId,
        r.huella,
      )
  }

  guardarCuarentena(c: Cuarentena) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO evento_cuarentena (restaurante_id, evento_id, dispositivo_id, motivo, contenido, recibido_en)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(this.restauranteId, c.eventoId, c.dispositivoId, c.motivo, c.contenido, c.recibidoEn)
  }

  guardarConflicto(c: Conflicto) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO conflicto (id, restaurante_id, tipo, evento_id, agregado_id, descripcion, detectado_en)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.id, this.restauranteId, c.tipo, c.eventoId, c.agregadoId, c.descripcion, c.detectadoEn)
  }

  conflictos(): Conflicto[] {
    return this.db
      .prepare('SELECT * FROM conflicto WHERE restaurante_id = ? ORDER BY detectado_en, evento_id')
      .all(this.restauranteId)
      .map((f) => this.aConflicto(f))
  }

  private aConflicto(f: Fila): Conflicto {
    return {
      id: String(f.id),
      tipo: String(f.tipo) as TipoConflicto,
      eventoId: String(f.evento_id),
      agregadoId: String(f.agregado_id),
      descripcion: String(f.descripcion),
      detectadoEn: String(f.detectado_en),
    }
  }
}
