import type { BaseSqlite, Fila } from '@pos/db'
import {
  type CierreZ,
  COLUMNAS,
  type Comanda,
  escpos,
  lineasCierreZ,
  lineasComanda,
  lineasPrecuenta,
  lineasPrueba,
  type PaginaCodigos,
  type Precuenta,
} from '@pos/printing'
import type { EstadoImpresora } from '@pos/sync'
import { type Enviar, enviarPorRed } from './transporte'

// La cola de impresión del hub (ADR-015). Los trabajos viven en `print_jobs` y sobreviven
// a un reinicio. Cada impresora imprime lo suyo en orden, de a uno. Si falla, se reintenta con
// una espera creciente hasta 30 s, sin rendirse; a los 3 fallos seguidos sus comandas van a la
// impresora de respaldo, si tiene. Lo que pasa con cada impresora lo ven todos los equipos.

/** Fallos seguidos tras los que las comandas pasan a la impresora de respaldo. */
export const FALLOS_PARA_RESPALDO = 3
const ESPERA_MAXIMA_MS = 30_000
/** Una página de prueba que no salió en este tiempo ya no la espera nadie: se descarta. */
export const VIGENCIA_PRUEBA_MS = 5 * 60_000

export interface PruebaImpresion {
  printer: string
  stations: string[]
  time: string
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
  send?: Enviar
  clock?: () => number
  /** Cambió cómo está alguna impresora (para avisar a los equipos). */
  onChange?: (statuses: EstadoImpresora[]) => void
  /** Una vuelta falló por algo del hub, no de la impresora (para el registro). */
  onFailure?: (error: unknown) => void
}

export class ColaImpresion {
  private readonly o: Required<Omit<OpcionesCola, 'onChange' | 'onFailure'>> &
    Pick<OpcionesCola, 'onChange' | 'onFailure'>
  private readonly statuses = new Map<string, Estado>()
  private corriendo: Promise<void> | null = null
  private otraVuelta = false
  private temporizador: ReturnType<typeof setTimeout> | null = null
  private detenida = false
  private ultimoAviso = ''
  /** Cuándo falló armar una comanda (no llegó a la cola): se avisa un rato en todos los equipos. */
  private sinArmarEn: number | null = null

  constructor(o: OpcionesCola) {
    this.o = { send: enviarPorRed, clock: Date.now, ...o }
  }

  /** Hay trabajo nuevo (o cambió una impresora): imprimir lo que se pueda ya. */
  despertar(): void {
    if (this.detenida) return
    if (this.corriendo) {
      this.otraVuelta = true
      return
    }
    this.corriendo = this.runOnce()
      .catch((error) => this.o.onFailure?.(error))
      .finally(() => {
        this.corriendo = null
        if (this.otraVuelta) {
          this.otraVuelta = false
          this.despertar()
        } else this.programar()
      })
  }

  /** Espera a que termine la vuelta en curso (para las pruebas y al cerrar el hub). */
  async ready(): Promise<void> {
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
    this.sinArmarEn = this.o.clock()
    this.avisar()
  }

  /** Cómo está cada impresora activa, con sus comandas en espera. */
  status(): EstadoImpresora[] {
    const sinArmar: EstadoImpresora[] =
      this.sinArmarEn !== null && this.o.clock() - this.sinArmarEn < 15 * 60_000
        ? [
            {
              id: 'tickets',
              name: 'Una comanda',
              status: 'failed',
              error:
                'No se pudo armar una comanda y no salió: reimprímela desde «Pedidos en cocina».',
              pendingList: 0,
            },
          ]
        : []
    return [...this.estadoImpresoras(), ...sinArmar]
  }

  private estadoImpresoras(): EstadoImpresora[] {
    const pendingList = new Map(
      this.o.db
        .prepare(
          `SELECT printer_id, count(*) AS n FROM print_jobs
           WHERE restaurant_id = ? AND status = 'pending' GROUP BY printer_id`,
        )
        .all(this.o.restauranteId)
        .map((f) => [String(f.printer_id), Number(f.n)]),
    )
    return this.printers()
      .filter((i) => i.active === 1)
      .map((i) => {
        const id = String(i.id)
        const e = this.statuses.get(id)
        return {
          id,
          name: String(i.name),
          status: e && e.fallosSeguidos > 0 ? 'failed' : 'ready',
          error: e?.fallosSeguidos ? e.error : null,
          pendingList: pendingList.get(id) ?? 0,
        }
      })
  }

  /** Una pasada por los trabajos pendientes: cada impresora imprime lo suyo, en orden. */
  async runOnce(): Promise<void> {
    const printers = new Map(this.printers().map((i) => [String(i.id), i]))
    // En el orden en que llegaron (rowid), no por la hora: si el reloj del PC se corrige hacia
    // atrás, una anulación no debe salir antes que su comanda.
    const trabajos = this.o.db
      .prepare(
        `SELECT * FROM print_jobs WHERE restaurant_id = ? AND status = 'pending'
         ORDER BY rowid`,
      )
      .all(this.o.restauranteId)

    // Qué impresora imprime cada trabajo en esta vuelta: la suya, o su respaldo si la suya falla.
    const porDestino = new Map<string, Fila[]>()
    const ahora = this.o.clock()
    // Una impresora caída se vuelve a probar con un trabajo cuando vence su espera: si responde,
    // vuelve a imprimir lo suyo; si no, lo demás sigue por el respaldo.
    const probadas = new Set<string>()
    for (const t of trabajos) {
      if (t.type === 'test' && ahora - Date.parse(String(t.created_at)) > VIGENCIA_PRUEBA_MS) {
        this.terminar(t, 'discarded', String(t.printer_id), 'La prueba no salió en 5 minutos')
        continue
      }
      const target = this.target(String(t.printer_id), printers, ahora, t.type === 'test', probadas)
      if (!target) continue
      porDestino.set(target, [...(porDestino.get(target) ?? []), t])
    }

    await Promise.all(
      [...porDestino].map(async ([targetId, list]) => {
        const printer = printers.get(targetId) as Fila
        for (const t of list) {
          const ok = await this.imprimir(t, printer)
          if (!ok) break
        }
      }),
    )
    this.avisar()
  }

  // ── Internos ─────────────────────────────────────────────────────────

  private printers(): Fila[] {
    return this.o.db
      .prepare('SELECT * FROM printers WHERE restaurant_id = ? ORDER BY created_at, id')
      .all(this.o.restauranteId)
  }

  /**
   * La impresora que imprime ahora un trabajo de `impresoraId`, o nada si toca esperar. Una
   * archivada, o con 3 fallos seguidos, pasa sus trabajos al respaldo si lo tiene y está activo.
   */
  private target(
    impresoraId: string,
    printers: Map<string, Fila>,
    ahora: number,
    esPrueba: boolean,
    probadas: Set<string>,
  ) {
    const propia = printers.get(impresoraId)
    if (!propia) return null
    const status = this.statuses.get(impresoraId)
    const caida = propia.active !== 1 || (status?.fallosSeguidos ?? 0) >= FALLOS_PARA_RESPALDO
    // La prueba es de esa impresora: nunca sale por otra.
    if (esPrueba)
      return propia.active === 1 && this.puedeIntentar(impresoraId, ahora) ? impresoraId : null
    if (caida && propia.active === 1 && this.puedeIntentar(impresoraId, ahora)) {
      // Mientras se prueba, lo demás espera esta vuelta: si responde, sale por la suya.
      if (probadas.has(impresoraId)) return null
      probadas.add(impresoraId)
      return impresoraId
    }
    if (caida && propia.fallback_id) {
      const respaldo = printers.get(String(propia.fallback_id))
      if (respaldo?.active === 1 && this.puedeIntentar(String(respaldo.id), ahora))
        return String(respaldo.id)
    }
    if (propia.active !== 1) {
      const reason =
        'La impresora está archivada y no tiene respaldo: descarta la comanda o reimprímela en otra.'
      this.fallo(impresoraId, reason, false)
      // Que la caja vea en lo pendiente por qué no sale.
      this.o.db
        .prepare(
          `UPDATE print_jobs SET last_error = ? WHERE restaurant_id = ? AND printer_id = ?
           AND status = 'pending' AND last_error IS NOT ?`,
        )
        .run(reason, this.o.restauranteId, impresoraId, reason)
      return null
    }
    if (caida) return null
    return this.puedeIntentar(impresoraId, ahora) ? impresoraId : null
  }

  private puedeIntentar(id: string, ahora: number) {
    return (this.statuses.get(id)?.reintentoEn ?? 0) <= ahora
  }

  private async imprimir(trabajo: Fila, printer: Fila): Promise<boolean> {
    const id = String(printer.id)
    let bytes: Uint8Array
    try {
      bytes = this.bytes(trabajo, printer)
    } catch {
      // Un contenido que no se entiende no debe frenar a los que vienen detrás.
      this.terminar(trabajo, 'discarded', id, 'No se pudo armar la comanda')
      return true
    }
    try {
      await this.o.send(
        {
          connection: printer.connection === 'usb' ? 'usb' : 'network',
          address: String(printer.address),
          port: printer.port === null ? null : Number(printer.port),
        },
        bytes,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.o.db
        .prepare(
          'UPDATE print_jobs SET attempts = attempts + 1, last_error = ? WHERE restaurant_id = ? AND id = ?',
        )
        .run(message, this.o.restauranteId, String(trabajo.id))
      this.fallo(id, message)
      return false
    }
    this.terminar(trabajo, 'printed', id, null)
    this.statuses.set(id, { fallosSeguidos: 0, error: null, reintentoEn: 0 })
    return true
  }

  private terminar(
    trabajo: Fila,
    status: 'printed' | 'discarded',
    impresoraId: string,
    error: string | null,
  ) {
    if (status === 'printed')
      this.o.db
        .prepare(
          `UPDATE print_jobs SET status = 'printed', attempts = attempts + 1, finished_at = ?,
             printed_on_id = ? WHERE restaurant_id = ? AND id = ? AND status = 'pending'`,
        )
        .run(
          new Date(this.o.clock()).toISOString(),
          impresoraId,
          this.o.restauranteId,
          String(trabajo.id),
        )
    else
      this.o.db
        .prepare(
          `UPDATE print_jobs SET status = 'discarded', finished_at = ?, last_error = ?
           WHERE restaurant_id = ? AND id = ? AND status = 'pending'`,
        )
        .run(
          new Date(this.o.clock()).toISOString(),
          error,
          this.o.restauranteId,
          String(trabajo.id),
        )
  }

  private fallo(id: string, error: string, contar = true) {
    const previous = this.statuses.get(id)
    const fallos = (previous?.fallosSeguidos ?? 0) + (contar ? 1 : 0)
    const delay = Math.min(ESPERA_MAXIMA_MS, 1000 * 2 ** Math.max(0, fallos - 1))
    this.statuses.set(id, {
      fallosSeguidos: Math.max(fallos, 1),
      error,
      // Archivada sin respaldo: no hay a quién intentar; la vuelta no se repite seguido por ella.
      reintentoEn: this.o.clock() + (contar ? delay : ESPERA_MAXIMA_MS),
    })
  }

  private bytes(trabajo: Fila, printer: Fila): Uint8Array {
    const width = Number(printer.width) === 58 ? 58 : 80
    const format = {
      columnas: COLUMNAS[width],
      pagina: String(printer.code_page) as PaginaCodigos,
    }
    const content = JSON.parse(String(trabajo.content))
    const lines =
      trabajo.type === 'test'
        ? lineasPrueba(content as PruebaImpresion, format)
        : trabajo.type === 'preBill'
          ? lineasPrecuenta(content as Precuenta, format)
          : trabajo.type === 'report'
            ? lineasCierreZ(content as CierreZ, format)
            : lineasComanda(content as Comanda, format)
    return escpos(lines, format)
  }

  /** La próxima vuelta: cuando venza la espera más corta de una impresora con trabajo. */
  private programar() {
    if (this.detenida) return
    if (this.temporizador) clearTimeout(this.temporizador)
    const pendingList = this.o.db
      .prepare(
        "SELECT DISTINCT printer_id FROM print_jobs WHERE restaurant_id = ? AND status = 'pending'",
      )
      .all(this.o.restauranteId)
    if (pendingList.length === 0) return
    const ahora = this.o.clock()
    const printers = new Map(this.printers().map((i) => [String(i.id), i]))
    // Lo de una impresora caída con respaldo sale cuando el respaldo pueda, no cuando toque
    // volver a probar la caída.
    const cuando = (id: string) => {
      const propia = this.statuses.get(id)?.reintentoEn ?? ahora
      const fila = printers.get(id)
      const caida =
        fila?.active !== 1 || (this.statuses.get(id)?.fallosSeguidos ?? 0) >= FALLOS_PARA_RESPALDO
      const respaldo = fila?.fallback_id ? printers.get(String(fila.fallback_id)) : undefined
      if (!caida || respaldo?.active !== 1) return propia
      return Math.min(propia, this.statuses.get(String(respaldo.id))?.reintentoEn ?? ahora)
    }
    const delay = Math.max(
      250,
      Math.min(...pendingList.map((f) => cuando(String(f.printer_id)) - ahora), ESPERA_MAXIMA_MS),
    )
    this.temporizador = setTimeout(() => this.despertar(), delay)
    this.temporizador.unref?.()
  }

  private avisar() {
    const statuses = this.status()
    const alert = JSON.stringify(statuses)
    if (alert === this.ultimoAviso) return
    this.ultimoAviso = alert
    this.o.onChange?.(statuses)
  }
}
