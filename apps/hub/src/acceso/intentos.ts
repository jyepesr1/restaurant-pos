/** Tope de la espera tras intentos fallidos (ADR-008). */
export const ESPERA_MAXIMA_MS = 60_000
/** Ventana en que se cuentan los fallos para avisar al administrador. */
export const VENTANA_AVISO_MS = 10 * 60_000
/** Fallos en la ventana (en todo el hub) a partir de los cuales se avisa. */
export const FALLOS_PARA_AVISO = 20
/**
 * Fallos seguidos de un mismo equipo (sin 10 minutos de calma entre ellos) para avisar: detecta
 * a quien prueba despacio, respetando la espera de 60 s.
 */
export const FALLOS_DE_UN_EQUIPO_PARA_AVISO = 15

/** Dos errores sin espera (un dedo que se resbala); luego 2, 4, 8… s, hasta 60 s. */
export const esperaTras = (fallos: number) =>
  fallos < 3 ? 0 : Math.min(ESPERA_MAXIMA_MS, 1000 * 2 ** (fallos - 2))

interface Registro {
  fallos: number
  until: number
  latest: number
}

/**
 * Espera creciente tras PIN o códigos fallidos, por quien intenta (un dispositivo, o una IP al
 * canjear un código de emparejamiento). Un acierto no borra los fallos: se olvidan solos tras
 * 10 minutos sin errores. Nunca se bloquea el restaurante entero: un celular no debe poder dejar
 * sin acceso a todo el local en pleno servicio. Vive en memoria: reiniciar el hub la borra, pero
 * nadie puede reiniciarlo desde un celular.
 */
export class Intentos {
  private readonly registros = new Map<string, Registro>()
  private recientes: number[] = []
  private readonly ahora: () => number
  private readonly alAvisar: (alert: string) => void

  constructor(ahora: () => number = Date.now, alAvisar: (alert: string) => void = () => {}) {
    this.ahora = ahora
    this.alAvisar = alAvisar
  }

  /** Cuánto falta para poder intentar de nuevo (0 si ya se puede). */
  esperaMs(quien: string): number {
    const r = this.registros.get(quien)
    return r ? Math.max(0, r.until - this.ahora()) : 0
  }

  /**
   * Anota un fallo y devuelve la espera que queda. Con `contar: false` no suma al aviso de todo el
   * hub: un mismo intento se anota por el equipo y por la cuenta, y cuenta una sola vez. `tope`
   * acorta la espera de ese registro (la de una cuenta, para que nadie deje afuera a otro).
   */
  fallo(
    quien: string,
    { contar = true, tope = ESPERA_MAXIMA_MS }: { contar?: boolean; tope?: number } = {},
  ): number {
    const ahora = this.ahora()
    const previous = this.registros.get(quien)
    // Tras una ventana sin fallos, se empieza de cero.
    const fallos = previous && ahora - previous.latest < VENTANA_AVISO_MS ? previous.fallos + 1 : 1
    const delay = Math.min(tope, esperaTras(fallos))
    this.registros.set(quien, { fallos, until: ahora + delay, latest: ahora })
    this.clear(ahora)

    if (contar) this.recientes.push(ahora)
    this.recientes = this.recientes.filter((t) => ahora - t < VENTANA_AVISO_MS)
    if (contar && this.recientes.length === FALLOS_PARA_AVISO)
      this.alAvisar(`${FALLOS_PARA_AVISO} PIN o códigos errados en 10 minutos en el restaurante`)
    if (fallos === FALLOS_DE_UN_EQUIPO_PARA_AVISO)
      this.alAvisar(`${fallos} PIN o códigos errados seguidos desde ${quien}`)
    return delay
  }

  /** Que una IP que prueba sin parar no haga crecer la memoria sin límite. */
  private clear(ahora: number) {
    if (this.registros.size < 1000) return
    for (const [quien, r] of this.registros)
      if (ahora - r.latest >= VENTANA_AVISO_MS) this.registros.delete(quien)
  }
}
