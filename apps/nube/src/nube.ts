import { huellaEvento } from '@pos/sync'
import { z } from 'zod'
import type { Sql } from './sql'

// La lógica de la nube (tarea 1.10, ADR-016): restaurantes, registro de hubs con un código de un
// solo uso y recepción de los eventos que sube cada hub, sin duplicar. No sabe de HTTP (eso es
// `api.ts`) ni de con qué se conecta a Postgres (`sql.ts`).

/** Cuántos eventos caben en un lote. El hub sube de a varios para ponerse al día rápido. */
export const MAX_EVENTOS_POR_LOTE = 500
/** Un evento más grande que esto no es un evento del POS (el hub limita lo que acepta). */
export const MAX_BYTES_EVENTO = 64 * 1024
/** Cuánto dura un código de registro. */
export const VIGENCIA_CODIGO_MS = 24 * 60 * 60 * 1000

const anioValido = (t: string) => {
  const anio = Number(t.slice(0, 4))
  return anio >= 2000 && anio <= 2999
}
/** «Z» o un desfase de hasta 14 horas (el mayor que existe). */
const desfaseValido = (t: string) => {
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(t)
  return !m || Number(m[2]) * 60 + Number(m[3]) <= 14 * 60
}

const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)

/**
 * Lo mínimo que la nube exige de un evento: el sobre con lo que puso el hub. Los datos no se
 * revisan aquí: el hub ya lo aceptó, y la nube no rechaza lo que el hub aceptó (ADR-016).
 */
const EventoSubido = z.looseObject({
  id: Ulid,
  tipo: z.string().min(1).max(60),
  agregado_tipo: z.string().min(1).max(30),
  agregado_id: Ulid,
  secuencia: z.int().min(1),
  // Fechas razonables para un POS: Postgres no acepta el año 0 ni desfases de horas imposibles.
  recibido_en: z.iso.datetime({ offset: true }).refine((t) => anioValido(t) && desfaseValido(t)),
  dia_operativo: z.iso.date().refine(anioValido),
  datos: z.record(z.string(), z.unknown()),
})

export const Registro = z.strictObject({
  codigo: z.string().min(1).max(40),
  hub_id: Ulid,
  sede_id: Ulid,
  nombre: z.string().trim().min(1).max(60),
  instancia: z.string().min(1).max(100),
})
export type Registro = z.infer<typeof Registro>

export const NuevoRestaurante = z.strictObject({
  id: Ulid,
  nombre: z.string().trim().min(1).max(120),
})

/** Lo que pasó con cada evento de un lote. */
export type ResultadoEvento =
  | { id: string; estado: 'guardado' | 'ya_estaba' }
  /** El id ya estaba con otro contenido: el guardado no cambia y el nuevo queda para revisión. */
  | { id: string; estado: 'distinto' }
  | { id: string | null; estado: 'invalido'; motivo: string }

export interface HubAutenticado {
  id: string
  restauranteId: string
  sedeId: string
}

/**
 * Postgres no guarda en `jsonb` el carácter nulo ni medio par de sustitutos de Unicode: un texto
 * así haría fallar el lote entero. Se revisan valores y claves.
 */
const SUSTITUTO_SUELTO = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const NULO = String.fromCharCode(0)
const noValido = (texto: string) => texto.includes(NULO) || SUSTITUTO_SUELTO.test(texto)
export function textoValido(valor: unknown): boolean {
  // Sin recursión: un dato muy anidado no agota la pila.
  const pendientes: unknown[] = [valor]
  while (pendientes.length > 0) {
    const v = pendientes.pop()
    if (typeof v === 'string') {
      if (noValido(v)) return false
    } else if (Array.isArray(v)) pendientes.push(...v)
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        if (noValido(k)) return false
        pendientes.push(x)
      }
  }
  return true
}

/** Un error de Postgres por un dato que no acepta (clase 22: fechas, textos, números fuera de rango). */
const esErrorDeDato = (e: unknown) => String((e as { code?: unknown })?.code ?? '').startsWith('22')

// ── Credenciales ───────────────────────────────────────────────────────

/** SHA-256 en hexadecimal (Web Crypto: igual en Workers y en Node). */
export async function sha256(texto: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const aleatorio = (bytes: number) => crypto.getRandomValues(new Uint8Array(bytes))

/** Credencial de un hub: 32 bytes al azar en base64url. Se muestra una vez; se guarda su huella. */
export function nuevaCredencial(): string {
  return btoa(String.fromCharCode(...aleatorio(32)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

/** Sin letras que se confunden al dictarlas (0/O, 1/I/L). */
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/** «K7PM-QX2R-9DHT»: 12 caracteres para escribir a mano al instalar el PC de caja. */
export function nuevoCodigo(): string {
  const letras = [...aleatorio(12)].map((b) => ALFABETO[b % ALFABETO.length]).join('')
  return `${letras.slice(0, 4)}-${letras.slice(4, 8)}-${letras.slice(8)}`
}

/** El código como lo escriba la persona: sin espacios ni guiones y en mayúsculas. */
export const normalizarCodigo = (codigo: string) => codigo.replace(/[\s-]/g, '').toUpperCase()

// ── Operaciones ────────────────────────────────────────────────────────

export class Nube {
  private readonly sql: Sql
  private readonly reloj: () => Date

  constructor(sql: Sql, reloj: () => Date = () => new Date()) {
    this.sql = sql
    this.reloj = reloj
  }

  /**
   * Corre el trabajo dentro de una transacción de un solo restaurante: la seguridad por fila de
   * la base solo deja ver y escribir sus eventos, aunque una consulta olvide filtrar.
   */
  private enRestaurante<T>(restauranteId: string, trabajo: (tx: Sql) => Promise<T>): Promise<T> {
    return this.sql.transaccion(async (tx) => {
      await tx.query("SELECT set_config('faro.restaurante_id', $1, true)", [restauranteId])
      await tx.query('SET LOCAL ROLE faro_datos')
      return trabajo(tx)
    })
  }

  /** Crea el restaurante si no existe (con el mismo id que tiene en su hub). */
  async crearRestaurante(
    datos: z.infer<typeof NuevoRestaurante>,
  ): Promise<'creado' | 'ya_existia'> {
    const filas = await this.sql.query(
      'INSERT INTO restaurante (id, nombre) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id',
      [datos.id, datos.nombre],
    )
    return filas.length > 0 ? 'creado' : 'ya_existia'
  }

  /** Un código para registrar un hub del restaurante; null si el restaurante no existe. */
  async crearCodigo(restauranteId: string): Promise<{ codigo: string; venceEn: string } | null> {
    const [existe] = await this.sql.query('SELECT 1 FROM restaurante WHERE id = $1', [
      restauranteId,
    ])
    if (!existe) return null
    const codigo = nuevoCodigo()
    const venceEn = new Date(this.reloj().getTime() + VIGENCIA_CODIGO_MS).toISOString()
    await this.sql.query(
      'INSERT INTO codigo_registro (huella, restaurante_id, creado_en, vence_en) VALUES ($1, $2, $3, $4)',
      [await sha256(normalizarCodigo(codigo)), restauranteId, this.reloj().toISOString(), venceEn],
    )
    return { codigo, venceEn }
  }

  /**
   * Registra un hub con su código y devuelve su credencial. El código vence a las 24 horas y es
   * de un solo hub: si la respuesta se perdió (se cayó el Wi-Fi), el mismo hub puede repetir el
   * registro con el mismo código mientras no venza y recibe una credencial nueva (la anterior deja
   * de servir). Otro hub con un código usado, o el mismo hub con otro código, no se registra.
   */
  async registrarHub(
    datos: Registro,
  ): Promise<
    | { ok: true; credencial: string; restauranteId: string }
    | { ok: false; motivo: 'codigo_invalido' | 'hub_ya_registrado' }
  > {
    const huella = await sha256(normalizarCodigo(datos.codigo))
    const credencial = nuevaCredencial()
    const huellaCredencial = await sha256(credencial)
    const ahora = this.reloj().toISOString()
    try {
      return await this.sql.transaccion(async (tx) => {
        // FOR UPDATE: dos registros a la vez con el mismo código no lo usan los dos.
        const [codigo] = await tx.query<{ restaurante_id: string; hub_id: string | null }>(
          `SELECT restaurante_id, hub_id FROM codigo_registro
           WHERE huella = $1 AND vence_en > $2 FOR UPDATE`,
          [huella, ahora],
        )
        if (!codigo) return { ok: false, motivo: 'codigo_invalido' } as const
        if (codigo.hub_id !== null) {
          // Ya usado: solo lo repite el mismo hub, y solo si no fue revocado.
          if (codigo.hub_id !== datos.hub_id)
            return { ok: false, motivo: 'codigo_invalido' } as const
          const repetido = await tx.query(
            `UPDATE hub SET credencial_huella = $2
             WHERE id = $1 AND revocado_en IS NULL RETURNING id`,
            [datos.hub_id, huellaCredencial],
          )
          if (repetido.length === 0) return { ok: false, motivo: 'codigo_invalido' } as const
          return { ok: true, credencial, restauranteId: codigo.restaurante_id } as const
        }
        const [ya] = await tx.query('SELECT 1 FROM hub WHERE id = $1', [datos.hub_id])
        if (ya) return { ok: false, motivo: 'hub_ya_registrado' } as const
        await tx.query(
          `INSERT INTO hub (id, restaurante_id, sede_id, nombre, instancia, credencial_huella, creado_en)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            datos.hub_id,
            codigo.restaurante_id,
            datos.sede_id,
            datos.nombre,
            datos.instancia,
            huellaCredencial,
            ahora,
          ],
        )
        await tx.query('UPDATE codigo_registro SET usado_en = $2, hub_id = $3 WHERE huella = $1', [
          huella,
          ahora,
          datos.hub_id,
        ])
        return { ok: true, credencial, restauranteId: codigo.restaurante_id } as const
      })
    } catch (e) {
      // Dos registros del mismo hub a la vez con códigos distintos: el segundo choca con la clave.
      if ((e as { code?: string }).code === '23505')
        return { ok: false, motivo: 'hub_ya_registrado' }
      throw e
    }
  }

  /** El hub dueño de una credencial, si existe y no está revocado. */
  async autenticar(credencial: string): Promise<HubAutenticado | null> {
    if (!credencial || credencial.length > 200) return null
    const [hub] = await this.sql.query<{ id: string; restaurante_id: string; sede_id: string }>(
      'SELECT id, restaurante_id, sede_id FROM hub WHERE credencial_huella = $1 AND revocado_en IS NULL',
      [await sha256(credencial)],
    )
    return hub ? { id: hub.id, restauranteId: hub.restaurante_id, sedeId: hub.sede_id } : null
  }

  /** Revoca un hub: su credencial deja de servir. */
  async revocarHub(hubId: string): Promise<boolean> {
    const filas = await this.sql.query(
      'UPDATE hub SET revocado_en = $2 WHERE id = $1 AND revocado_en IS NULL RETURNING id',
      [hubId, this.reloj().toISOString()],
    )
    return filas.length > 0
  }

  /**
   * Guarda un lote de eventos del hub en una transacción. Un evento que ya estaba (mismo id y
   * contenido) no se duplica; uno que ya estaba con otro contenido no pisa el guardado y queda en
   * `evento_distinto`. Devuelve el resultado de cada uno, en el orden en que llegaron.
   */
  async recibirEventos(
    hub: HubAutenticado,
    crudos: readonly unknown[],
  ): Promise<ResultadoEvento[]> {
    const resultados: ResultadoEvento[] = []
    type Valido = { indice: number; id: string; huella: string; fila: Record<string, unknown> }
    const validos: Valido[] = []
    /** El mismo id otra vez en el lote: se compara con lo que quede guardado. */
    const repetidosEnLote: Valido[] = []
    const vistos = new Set<string>()
    crudos.forEach((crudo, indice) => {
      const r = EventoSubido.safeParse(crudo)
      // El id solo se devuelve si parece un id (no se le devuelve al hub cualquier texto).
      const crudoId = (crudo as { id?: unknown } | null)?.id
      const id = typeof crudoId === 'string' && crudoId.length <= 26 ? crudoId : null
      if (!r.success) {
        resultados[indice] = { id, estado: 'invalido', motivo: 'formato' }
        return
      }
      // La huella también limita el anidamiento: así lo que sigue no recorre datos sin fondo.
      let huella: string
      try {
        huella = huellaEvento(r.data)
      } catch {
        resultados[indice] = { id: r.data.id, estado: 'invalido', motivo: 'demasiado_anidado' }
        return
      }
      if (!textoValido(r.data)) {
        resultados[indice] = { id: r.data.id, estado: 'invalido', motivo: 'caracter_no_valido' }
        return
      }
      const contenido = JSON.stringify(r.data)
      if (new TextEncoder().encode(contenido).length > MAX_BYTES_EVENTO) {
        resultados[indice] = { id: r.data.id, estado: 'invalido', motivo: 'demasiado_grande' }
        return
      }
      const valido: Valido = {
        indice,
        id: r.data.id,
        huella,
        fila: {
          id: r.data.id,
          tipo: r.data.tipo,
          agregado_tipo: r.data.agregado_tipo,
          agregado_id: r.data.agregado_id,
          secuencia_hub: r.data.secuencia,
          dia_operativo: r.data.dia_operativo,
          recibido_en: r.data.recibido_en,
          contenido: r.data,
          huella,
        },
      }
      if (vistos.has(r.data.id)) repetidosEnLote.push(valido)
      else {
        vistos.add(r.data.id)
        validos.push(valido)
      }
    })
    if (validos.length === 0) return resultados

    return this.enRestaurante(hub.restauranteId, async (tx) => {
      const insertar = (filas: Valido[]) =>
        tx.query<{ id: string }>(
          `INSERT INTO evento (restaurante_id, id, hub_id, tipo, agregado_tipo, agregado_id,
                               secuencia_hub, dia_operativo, recibido_en, contenido, huella)
           SELECT $1, x.id, $2, x.tipo, x.agregado_tipo, x.agregado_id,
                  x.secuencia_hub, x.dia_operativo, x.recibido_en, x.contenido, x.huella
           FROM jsonb_to_recordset($3::jsonb) AS x(
             id text, tipo text, agregado_tipo text, agregado_id text, secuencia_hub bigint,
             dia_operativo date, recibido_en timestamptz, contenido jsonb, huella text)
           ON CONFLICT (restaurante_id, id) DO NOTHING
           RETURNING id`,
          [hub.restauranteId, hub.id, JSON.stringify(filas.map((v) => v.fila))],
        )
      // Una sola sentencia para todo el lote. Si la base rechaza un dato (una fecha que Postgres
      // no acepta, por ejemplo), se prueba uno por uno: el malo queda inválido y el resto entra.
      // Si no, el hub reintentaría para siempre un lote que nunca pasa.
      let aGuardar = validos
      let guardados: { id: string }[]
      await tx.query('SAVEPOINT lote')
      try {
        guardados = await insertar(validos)
        await tx.query('RELEASE SAVEPOINT lote')
      } catch (e) {
        if (!esErrorDeDato(e)) throw e
        await tx.query('ROLLBACK TO SAVEPOINT lote')
        guardados = []
        aGuardar = []
        for (const v of validos) {
          await tx.query('SAVEPOINT uno')
          try {
            guardados.push(...(await insertar([v])))
            await tx.query('RELEASE SAVEPOINT uno')
            aGuardar.push(v)
          } catch (e2) {
            if (!esErrorDeDato(e2)) throw e2
            await tx.query('ROLLBACK TO SAVEPOINT uno')
            resultados[v.indice] = { id: v.id, estado: 'invalido', motivo: 'rechazado_por_la_base' }
          }
        }
      }

      const nuevos = new Set(guardados.map((g) => g.id))
      // Lo que quedó guardado de cada id: lo nuevo de este lote o lo de antes.
      const guardada = new Map<string, string>()
      for (const v of aGuardar) if (nuevos.has(v.id)) guardada.set(v.id, v.huella)
      const consultar = [
        ...new Set(
          [...aGuardar, ...repetidosEnLote].map((v) => v.id).filter((id) => !guardada.has(id)),
        ),
      ]
      if (consultar.length > 0) {
        const filas = await tx.query<{ id: string; huella: string }>(
          'SELECT id, huella FROM evento WHERE restaurante_id = $1 AND id = ANY($2::text[])',
          [hub.restauranteId, consultar],
        )
        for (const f of filas) guardada.set(f.id, f.huella)
      }
      const enLote = repetidosEnLote.filter((v) => guardada.has(v.id))
      const distintos = [...aGuardar.filter((v) => !nuevos.has(v.id)), ...enLote].filter(
        (v) => guardada.get(v.id) !== v.huella,
      )
      if (distintos.length > 0)
        await tx.query(
          `INSERT INTO evento_distinto (restaurante_id, evento_id, hub_id, contenido, huella)
           SELECT $1, x.id, $2, x.contenido, x.huella
           FROM jsonb_to_recordset($3::jsonb) AS x(id text, contenido jsonb, huella text)
           ON CONFLICT (restaurante_id, evento_id, huella) DO NOTHING`,
          [hub.restauranteId, hub.id, JSON.stringify(distintos.map((d) => d.fila))],
        )
      // Lo guardado sin huecos desde la secuencia 1: desde ahí sigue el hub (`ultimaSecuencia`).
      await tx.query(
        `UPDATE hub SET secuencia_contigua = (
           SELECT coalesce(max(s.secuencia_hub), hub.secuencia_contigua) FROM (
             SELECT secuencia_hub, row_number() OVER (ORDER BY secuencia_hub) AS n
             FROM (SELECT DISTINCT secuencia_hub FROM evento
                   WHERE restaurante_id = $1 AND hub_id = $2
                     AND secuencia_hub > hub.secuencia_contigua) d
           ) s WHERE s.secuencia_hub = hub.secuencia_contigua + s.n)
         WHERE id = $2`,
        [hub.restauranteId, hub.id],
      )
      for (const v of [...aGuardar, ...repetidosEnLote]) {
        if (!guardada.has(v.id)) {
          // Repetido en el lote de uno que la base rechazó: corre la misma suerte.
          resultados[v.indice] = { id: v.id, estado: 'invalido', motivo: 'rechazado_por_la_base' }
          continue
        }
        const esNuevo = nuevos.has(v.id) && !repetidosEnLote.includes(v)
        resultados[v.indice] = {
          id: v.id,
          estado: esNuevo ? 'guardado' : guardada.get(v.id) === v.huella ? 'ya_estaba' : 'distinto',
        }
      }
      return resultados
    })
  }

  /**
   * Hasta qué secuencia del hub está todo en la nube, sin huecos desde la 1: desde ahí sigue
   * subiendo. Si un evento no se pudo guardar (inválido), se queda ahí y el hub lo debe avisar.
   */
  async ultimaSecuencia(hub: HubAutenticado): Promise<number> {
    const [fila] = await this.sql.query<{ s: string | number }>(
      'SELECT secuencia_contigua AS s FROM hub WHERE id = $1',
      [hub.id],
    )
    return Number(fila?.s ?? 0)
  }
}
