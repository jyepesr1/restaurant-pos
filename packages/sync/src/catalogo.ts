import type { CashRoundingMode, PaymentMethod } from '@pos/core'

// Lo que el hub entrega en `GET /api/catalogo`: el catálogo y el salón vigentes. En la Fase 1 se
// sincroniza por versión (docs/SYNC.md#catálogo-y-configuración); por ahora va entero.

export interface Catalogo {
  /** Valor del contador global del catálogo: va como `catalog_version` en cada ítem. */
  version: number
  restaurant: {
    name: string
    /** Minutos sin uso tras los que el dispositivo vuelve a pedir el PIN. */
    sesionInactividadMin: number
    /** La marca con que se ve el POS (tarea 1.3c); sin ella, Faro. */
    brand?: string | null
    /** Minutos desde el envío tras los que lo de cocina pasa a ámbar y a rojo (ADR-015). */
    cocinaAmarilloMin?: number
    cocinaRojoMin?: number
    /** Si se toman pedidos por curso (entrada, fuerte, postre). Sin el dato, no. */
    usarCursos?: boolean
    /**
     * Reglas del cobro (tarea 1.6, docs/DINERO.md): medios que recibe, propina sugerida en
     * puntos básicos y redondeos. Un hub de antes de la 1.6 no las manda: entonces no se cobra.
     */
    checkout?: {
      mediosPago: PaymentMethod[]
      /** Los medios que creó el restaurante (Sodexo, QR del banco), activos. */
      mediosPropios?: { id: string; name: string }[]
      /** Los archivados: ya no salen al cobrar, pero sus pagos los siguen nombrando. */
      mediosPropiosArchivados?: { id: string; name: string }[]
      suggestedTip: number
      redondeoModo: 'half_up' | 'half_even'
      redondeoEfectivo: number
      cashRoundingMode: CashRoundingMode
      /** Si la precuenta sale impresa; si no, solo se ve en pantalla. */
      imprimePrecuenta: boolean
      /** Desde qué diferencia el cierre de caja pide justificación (tarea 1.7). */
      umbralDiferencia?: number
      /** Para saber el día operativo en el equipo (el pago de propinas dice de qué día sale). */
      timeZone?: string
      inicioDiaOperativo?: string
    }
  }
  /** Los datáfonos del restaurante (tarea 1.6), para decir en cuál se cobró una tarjeta. */
  cardTerminals?: { id: string; name: string; provider?: string }[]
  /** Zonas o pisos del salón, en su orden. */
  zones: { id: string; name: string; level: number }[]
  /** Geometría en centímetros: esquina superior izquierda, medidas y rotación en grados. */
  tables: {
    id: string
    zonaId: string
    name: string
    x: number
    y: number
    width: number
    height: number
    rotation: number
    shape: 'round' | 'square' | 'rectangular' | 'bar'
    capacity: number
  }[]
  /** Paredes, puertas, plantas, la barra y textos del plano, con la misma geometría. */
  elements: {
    id: string
    zonaId: string
    type: 'wall' | 'door' | 'plant' | 'bar' | 'text'
    text: string | null
    x: number
    y: number
    width: number
    height: number
    rotation: number
  }[]
  /** Quién atiende (para mostrar el mesero de cada mesa); solo nombre, nada de credenciales. */
  staff: { id: string; name: string }[]
  /**
   * Cocina, barra… Cómo recibe cada una (ADR-015): `imprime` si tiene alguna impresora activa,
   * `pantalla` si alguna pantalla de cocina la muestra. Un hub de antes de la 1.4 no los manda.
   */
  stations: { id: string; name: string; imprime?: boolean; screen?: boolean }[]
  /** Las pantallas de cocina y lo que muestra cada una (para que cada pantalla sepa lo suyo). */
  pantallas?: { dispositivoId: string; name: string; estacionIds: string[] }[]
  categories: {
    id: string
    name: string
    estacionId: string | null
    products: {
      id: string
      name: string
      description: string | null
      /** Sale en "Favoritos" al tomar el pedido. */
      favorite: boolean
      /** Ruta de su foto en el hub (tarea 1.3c), o nada: entonces se muestra el ícono. */
      photo?: string | null
      price: number
      tax: { type: 'inc' | 'iva' | 'exempt'; rate: number }
      variants: { id: string; name: string; price: number }[]
      groups: {
        id: string
        name: string
        minimum: number
        maximum: number
        options: { id: string; name: string; extraPrice: number }[]
      }[]
    }[]
  }[]
}
