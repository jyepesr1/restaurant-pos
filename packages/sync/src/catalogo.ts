// Lo que el hub entrega en `GET /api/catalogo`: el catálogo y el salón vigentes. En la Fase 1 se
// sincroniza por versión (docs/SYNC.md#catálogo-y-configuración); por ahora va entero.

export interface Catalogo {
  /** Valor del contador global del catálogo: va como `catalogo_version` en cada ítem. */
  version: number
  restaurante: {
    nombre: string
    /** Minutos sin uso tras los que el dispositivo vuelve a pedir el PIN. */
    sesionInactividadMin: number
  }
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
  estaciones: { id: string; nombre: string }[]
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
