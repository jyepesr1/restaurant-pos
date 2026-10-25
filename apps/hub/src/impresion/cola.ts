import type { BaseSqlite, Fila } from '@pos/db'
import {
  COLUMNAS,
  type Comanda,
  escpos,
  lineasComanda,
  lineasPrueba,
  type PaginaCodigos,
} from '@pos/printing'
import type { EstadoImpresora } from '@pos/sync'
import { type Enviar, enviarPorRed } from './transporte'

// La cola de impresión del hub (ADR-015). Los trabajos viven en `trabajo_impresion` y sobreviven
// a un reinicio. Cada impresora imprime lo suyo en orden, de a uno. Si falla, se reintenta con
// una espera creciente hasta 30 s, sin rendirse; a los 3 fallos seguidos sus comandas van a la
// impresora de respaldo, si tiene. Lo que pasa con cada impresora lo ven todos los equipos.

/** Fallos seguidos tras los que las comandas pasan a la impresora de respaldo. */
export const FALLOS_PARA_RESPALDO = 3
const ESPERA_MAXIMA_MS = 30_000
/** Una página de prueba que no salió en este tiempo ya no la espera nadie: se descarta. */
export const VIGENCIA_PRUEBA_MS = 5 * 60_000

export interface PruebaImpresion {
  impresora: string
  estaciones: string[]
  hora: string
}

interface Estado {
  fallosSeguidos: number
  error: string | null
  /** No se vuelve a intentar antes de esta hora (ms). */
  reintentoEn: number
}

export interface OpcionesCola {
  db: BaseSqlite
  restauranteId: string
  enviar?: Enviar
  reloj?: () => number
  /** Cambió cómo está alguna impresora (para avisar a los equipos). */
  alCambiar?: (estados: EstadoImpresora[]) => void
  /** Una vuelta falló por algo del hub, no de la impresora (para el registro). */
  alFallo?: (error: unknown) => void
}

export class ColaImpresion {
  private readonly o: Required<Omit<OpcionesCola, 'alCambiar' | 'alFallo'>> &
    Pick<OpcionesCola, 'alCambiar' | 'alFallo'>
  private readonly estados = new Map<string, Estado>()
  private corriendo: Promise<void> | null = null
  private otraVuelta = false
  private temporizador: ReturnType<typeof setTimeout> | null = null
  private detenida = false
  private ultimoAviso = ''
  /** Cuándo falló armar una comanda (no llegó a la cola): se avisa un rato en todos los equipos. */
  private sinArmarEn: number | null = null

  constructor(o: OpcionesCola) {
    this.o = { enviar: enviarPorRed, reloj: Date.now, ...o }
  }

  /** Hay trabajo nuevo (o cambió una impresora): imprimir lo que se pueda ya. */
  despertar(): void {
    if (this.detenida) return
    if (this.corriendo) {
      this.otraVuelta = true
      return
    }
    this.corriendo = this.vuelta()
      .catch((error) => this.o.alFallo?.(error))
      .finally(() => {
        this.corriendo = null
        if (this.otraVuelta) {
          this.otraVuelta = false
          this.despertar()
        } else this.programar()
      })
  }

  /** Espera a que termine la vuelta en curso (para las pruebas y al cerrar el hub). */
  async listo(): Promise<void> {
    while (this.corriendo) await this.corriendo
  }

  detener(): void {
    this.detenida = true
    if (this.temporizador) clearTimeout(this.temporizador)
  }

  /**
   * Un envío se aceptó pero su comanda no se pudo armar (un error del hub): nadie la va a
   * imprimir. Todos los equipos lo ven durante 15 minutos, para reimprimirla desde «Pedidos en
   * cocina».
   */
  comandaSinArmar(): void {
    this.sinArmarEn = this.o.reloj()
    this.avisar()
  }

  /** Cómo está cada impresora activa, con sus comandas en espera. */
  estado(): EstadoImpresora[] {
    const sinArmar: EstadoImpresora[] =
      this.sinArmarEn !== null && this.o.reloj() - this.sinArmarEn < 15 * 60_000
        ? [
            {
              id: 'comandas',
              nombre: 'Una comanda',
              estado: 'falla',
              error:
                'No se pudo armar una comanda y no salió: reimprímela desde «Pedidos en cocina».',
              pendientes: 0,
            },
          ]
        : []
    return [...this.estadoImpresoras(), ...sinArmar]
  }

  private estadoImpresoras(): EstadoImpresora[] {
    const pendientes = new Map(
      this.o.db
        .prepare(
          `SELECT impresora_id, count(*) AS n FROM trabajo_impresion
           WHERE restaurante_id = ? AND estado = 'pendiente' GROUP BY impresora_id`,
        )
        .all(this.o.restauranteId)
        .map((f) => [String(f.impresora_id), Number(f.n)]),
    )
    return this.impresoras()
      .filter((i) => i.activo === 1)
      .map((i) => {
        const id = String(i.id)
        const e = this.estados.get(id)
        return {
          id,
          nombre: String(i.nombre),
          estado: e && e.fallosSeguidos > 0 ? 'falla' : 'lista',
          error: e?.fallosSeguidos ? e.error : null,
          pendientes: pendientes.get(id) ?? 0,
        }
      })
  }

  /** Una pasada por los trabajos pendientes: cada impresora imprime lo suyo, en orden. */
  async vuelta(): Promise<void> {
    const impresoras = new Map(this.impresoras().map((i) => [String(i.id), i]))
    // En el orden en que llegaron (rowid), no por la hora: si el reloj del PC se corrige hacia
    // atrás, una anulación no debe salir antes que su comanda.
    const trabajos = this.o.db
      .prepare(
        `SELECT * FROM trabajo_impresion WHERE restaurante_id = ? AND estado = 'pendiente'
         ORDER BY rowid`,
      )
      .all(this.o.restauranteId)

    // Qué impresora imprime cada trabajo en esta vuelta: la suya, o su respaldo si la suya falla.
    const porDestino = new Map<string, Fila[]>()
    const ahora = this.o.reloj()
    // Una impresora caída se vuelve a probar con un trabajo cuando vence su espera: si responde,
    // vuelve a imprimir lo suyo; si no, lo demás sigue por el respaldo.
    const probadas = new Set<string>()
    for (const t of trabajos) {
      if (t.tipo === 'prueba' && ahora - Date.parse(String(t.creado_en)) > VIGENCIA_PRUEBA_MS) {
        this.terminar(t, 'descartado', String(t.impresora_id), 'La prueba no salió en 5 minutos')
        continue
      }
      const destino = this.destino(
        String(t.impresora_id),
        impresoras,
        ahora,
        t.tipo === 'prueba',
        probadas,
      )
      if (!destino) continue
      porDestino.set(destino, [...(porDestino.get(destino) ?? []), t])
    }

    await Promise.all(
      [...porDestino].map(async ([destinoId, lista]) => {
        const impresora = impresoras.get(destinoId) as Fila
        for (const t of lista) {
          const ok = await this.imprimir(t, impresora)
          if (!ok) break
        }
      }),
    )
    this.avisar()
  }

  // ── Internos ─────────────────────────────────────────────────────────

  private impresoras(): Fila[] {
    return this.o.db
      .prepare('SELECT * FROM impresora WHERE restaurante_id = ? ORDER BY creado_en, id')
      .all(this.o.restauranteId)
  }

  /**
   * La impresora que imprime ahora un trabajo de `impresoraId`, o nada si toca esperar. Una
   * archivada, o con 3 fallos seguidos, pasa sus trabajos al respaldo si lo tiene y está activo.
   */
  private destino(
    impresoraId: string,
    impresoras: Map<string, Fila>,
    ahora: number,
    esPrueba: boolean,
    probadas: Set<string>,
  ) {
    const propia = impresoras.get(impresoraId)
    if (!propia) return null
    const estado = this.estados.get(impresoraId)
    const caida = propia.activo !== 1 || (estado?.fallosSeguidos ?? 0) >= FALLOS_PARA_RESPALDO
    // La prueba es de esa impresora: nunca sale por otra.
    if (esPrueba)
      return propia.activo === 1 && this.puedeIntentar(impresoraId, ahora) ? impresoraId : null
    if (caida && propia.activo === 1 && this.puedeIntentar(impresoraId, ahora)) {
      // Mientras se prueba, lo demás espera esta vuelta: si responde, sale por la suya.
      if (probadas.has(impresoraId)) return null
      probadas.add(impresoraId)
      return impresoraId
    }
    if (caida && propia.respaldo_id) {
      const respaldo = impresoras.get(String(propia.respaldo_id))
      if (respaldo?.activo === 1 && this.puedeIntentar(String(respaldo.id), ahora))
        return String(respaldo.id)
    }
    if (propia.activo !== 1) {
      const motivo =
        'La impresora está archivada y no tiene respaldo: descarta la comanda o reimprímela en otra.'
      this.fallo(impresoraId, motivo, false)
      // Que la caja vea en lo pendiente por qué no sale.
      this.o.db
        .prepare(
          `UPDATE trabajo_impresion SET ultimo_error = ? WHERE restaurante_id = ? AND impresora_id = ?
           AND estado = 'pendiente' AND ultimo_error IS NOT ?`,
        )
        .run(motivo, this.o.restauranteId, impresoraId, motivo)
      return null
    }
    if (caida) return null
    return this.puedeIntentar(impresoraId, ahora) ? impresoraId : null
  }

  private puedeIntentar(id: string, ahora: number) {
    return (this.estados.get(id)?.reintentoEn ?? 0) <= ahora
  }

  private async imprimir(trabajo: Fila, impresora: Fila): Promise<boolean> {
    const id = String(impresora.id)
    let bytes: Uint8Array
    try {
      bytes = this.bytes(trabajo, impresora)
    } catch {
      // Un contenido que no se entiende no debe frenar a los que vienen detrás.
      this.terminar(trabajo, 'descartado', id, 'No se pudo armar la comanda')
      return true
    }
    try {
      await this.o.enviar(
        {
          conexion: impresora.conexion === 'usb' ? 'usb' : 'red',
          direccion: String(impresora.direccion),
          puerto: impresora.puerto === null ? null : Number(impresora.puerto),
        },
        bytes,
      )
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error)
      this.o.db
        .prepare(
          'UPDATE trabajo_impresion SET intentos = intentos + 1, ultimo_error = ? WHERE restaurante_id = ? AND id = ?',
        )
        .run(mensaje, this.o.restauranteId, String(trabajo.id))
      this.fallo(id, mensaje)
      return false
    }
    this.terminar(trabajo, 'impreso', id, null)
    this.estados.set(id, { fallosSeguidos: 0, error: null, reintentoEn: 0 })
    return true
  }

  private terminar(
    trabajo: Fila,
    estado: 'impreso' | 'descartado',
    impresoraId: string,
    error: string | null,
  ) {
    if (estado === 'impreso')
      this.o.db
        .prepare(
          `UPDATE trabajo_impresion SET estado = 'impreso', intentos = intentos + 1, terminado_en = ?,
             impreso_en_id = ? WHERE restaurante_id = ? AND id = ? AND estado = 'pendiente'`,
        )
        .run(
          new Date(this.o.reloj()).toISOString(),
          impresoraId,
          this.o.restauranteId,
          String(trabajo.id),
        )
    else
      this.o.db
        .prepare(
          `UPDATE trabajo_impresion SET estado = 'descartado', terminado_en = ?, ultimo_error = ?
           WHERE restaurante_id = ? AND id = ? AND estado = 'pendiente'`,
        )
        .run(
          new Date(this.o.reloj()).toISOString(),
          error,
          this.o.restauranteId,
          String(trabajo.id),
        )
  }

  private fallo(id: string, error: string, contar = true) {
    const previo = this.estados.get(id)
    const fallos = (previo?.fallosSeguidos ?? 0) + (contar ? 1 : 0)
    const espera = Math.min(ESPERA_MAXIMA_MS, 1000 * 2 ** Math.max(0, fallos - 1))
    this.estados.set(id, {
      fallosSeguidos: Math.max(fallos, 1),
      error,
      // Archivada sin respaldo: no hay a quién intentar; la vuelta no se repite seguido por ella.
      reintentoEn: this.o.reloj() + (contar ? espera : ESPERA_MAXIMA_MS),
    })
  }

  private bytes(trabajo: Fila, impresora: Fila): Uint8Array {
    const ancho = Number(impresora.ancho) === 58 ? 58 : 80
    const formato = {
      columnas: COLUMNAS[ancho],
      pagina: String(impresora.pagina_codigos) as PaginaCodigos,
    }
    const contenido = JSON.parse(String(trabajo.contenido))
    const lineas =
      trabajo.tipo === 'prueba'
        ? lineasPrueba(contenido as PruebaImpresion, formato)
        : lineasComanda(contenido as Comanda, formato)
    return escpos(lineas, formato)
  }

  /** La próxima vuelta: cuando venza la espera más corta de una impresora con trabajo. */
  private programar() {
    if (this.detenida) return
    if (this.temporizador) clearTimeout(this.temporizador)
    const pendientes = this.o.db
      .prepare(
        "SELECT DISTINCT impresora_id FROM trabajo_impresion WHERE restaurante_id = ? AND estado = 'pendiente'",
      )
      .all(this.o.restauranteId)
    if (pendientes.length === 0) return
    const ahora = this.o.reloj()
    const impresoras = new Map(this.impresoras().map((i) => [String(i.id), i]))
    // Lo de una impresora caída con respaldo sale cuando el respaldo pueda, no cuando toque
    // volver a probar la caída.
    const cuando = (id: string) => {
      const propia = this.estados.get(id)?.reintentoEn ?? ahora
      const fila = impresoras.get(id)
      const caida =
        fila?.activo !== 1 || (this.estados.get(id)?.fallosSeguidos ?? 0) >= FALLOS_PARA_RESPALDO
      const respaldo = fila?.respaldo_id ? impresoras.get(String(fila.respaldo_id)) : undefined
      if (!caida || respaldo?.activo !== 1) return propia
      return Math.min(propia, this.estados.get(String(respaldo.id))?.reintentoEn ?? ahora)
    }
    const espera = Math.max(
      250,
      Math.min(...pendientes.map((f) => cuando(String(f.impresora_id)) - ahora), ESPERA_MAXIMA_MS),
    )
    this.temporizador = setTimeout(() => this.despertar(), espera)
    this.temporizador.unref?.()
  }

  private avisar() {
    const estados = this.estado()
    const aviso = JSON.stringify(estados)
    if (aviso === this.ultimoAviso) return
    this.ultimoAviso = aviso
    this.o.alCambiar?.(estados)
  }
}
