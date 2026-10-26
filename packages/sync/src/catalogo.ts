import type { MedioPago, ModoRedondeoEfectivo } from '@pos/core'

// Lo que el hub entrega en `GET /api/catalogo`: el catálogo y el salón vigentes. En la Fase 1 se
// sincroniza por versión (docs/SYNC.md#catálogo-y-configuración); por ahora va entero.

export interface Catalogo {
  /** Valor del contador global del catálogo: va como `catalogo_version` en cada ítem. */
  version: number
  restaurante: {
    nombre: string
    /** Minutos sin uso tras los que el dispositivo vuelve a pedir el PIN. */
    sesionInactividadMin: number
    /** La marca con que se ve el POS (tarea 1.3c); sin ella, Faro. */
    marca?: string | null
    /** Minutos desde el envío tras los que lo de cocina pasa a ámbar y a rojo (ADR-015). */
    cocinaAmarilloMin?: number
    cocinaRojoMin?: number
    /** Si se toman pedidos por curso (entrada, fuerte, postre). Sin el dato, no. */
    usarCursos?: boolean
    /**
     * Reglas del cobro (tarea 1.6, docs/DINERO.md): medios que recibe, propina sugerida en
     * puntos básicos y redondeos. Un hub de antes de la 1.6 no las manda: entonces no se cobra.
     */
    cobro?: {
      mediosPago: MedioPago[]
      /** Los medios que creó el restaurante (Sodexo, QR del banco), activos. */
      mediosPropios?: { id: string; nombre: string }[]
      propinaSugerida: number
      redondeoModo: 'mitad_arriba' | 'mitad_par'
      redondeoEfectivo: number
      redondeoEfectivoModo: ModoRedondeoEfectivo
      /** Si la precuenta sale impresa; si no, solo se ve en pantalla. */
      imprimePrecuenta: boolean
    }
  }
  /** Los datáfonos del restaurante (tarea 1.6), para decir en cuál se cobró una tarjeta. */
  datafonos?: { id: string; nombre: string }[]
  /** Zonas o pisos del salón, en su orden. */
  zonas: { id: string; nombre: string; piso: number }[]
  /** Geometría en centímetros: esquina superior izquierda, medidas y rotación en grados. */
  mesas: {
    id: string
    zonaId: string
    nombre: string
    x: number
    y: number
    ancho: number
    alto: number
    rotacion: number
    forma: 'redonda' | 'cuadrada' | 'rectangular' | 'barra'
    capacidad: number
  }[]
  /** Paredes, puertas, plantas, la barra y textos del plano, con la misma geometría. */
  elementos: {
    id: string
    zonaId: string
    tipo: 'pared' | 'puerta' | 'planta' | 'barra' | 'texto'
    texto: string | null
    x: number
    y: number
    ancho: number
    alto: number
    rotacion: number
  }[]
  /** Quién atiende (para mostrar el mesero de cada mesa); solo nombre, nada de credenciales. */
  personal: { id: string; nombre: string }[]
  /**
   * Cocina, barra… Cómo recibe cada una (ADR-015): `imprime` si tiene alguna impresora activa,
   * `pantalla` si alguna pantalla de cocina la muestra. Un hub de antes de la 1.4 no los manda.
   */
  estaciones: { id: string; nombre: string; imprime?: boolean; pantalla?: boolean }[]
  /** Las pantallas de cocina y lo que muestra cada una (para que cada pantalla sepa lo suyo). */
  pantallas?: { dispositivoId: string; nombre: string; estacionIds: string[] }[]
  categorias: {
    id: string
    nombre: string
    estacionId: string | null
    productos: {
      id: string
      nombre: string
      descripcion: string | null
      /** Sale en "Favoritos" al tomar el pedido. */
      favorito: boolean
      /** Ruta de su foto en el hub (tarea 1.3c), o nada: entonces se muestra el ícono. */
      foto?: string | null
      precio: number
      impuesto: { tipo: 'inc' | 'iva' | 'exento'; tarifa: number }
      variantes: { id: string; nombre: string; precio: number }[]
      grupos: {
        id: string
        nombre: string
        minimo: number
        maximo: number
        opciones: { id: string; nombre: string; precioExtra: number }[]
      }[]
    }[]
  }[]
}
