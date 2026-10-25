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
  zonas: { id: string; nombre: string }[]
  mesas: {
    id: string
    zonaId: string
    nombre: string
    x: number
    y: number
    forma: string
    capacidad: number
  }[]
  estaciones: { id: string; nombre: string }[]
  categorias: {
    id: string
    nombre: string
    estacionId: string | null
    productos: {
      id: string
      nombre: string
      descripcion: string | null
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
