// Categoría de cada tabla (docs/MODELO_DATOS.md#categorías). Las pruebas exigen que toda tabla
// de la base esté en exactamente una lista, para que una tabla nueva no quede sin clasificar.

/** Catálogo y configuración: llevan las columnas comunes y se archivan, no se borran. */
export const TABLAS_VERSIONADAS = [
  'restaurante',
  'sede',
  'zona',
  'mesa',
  'elemento_plano',
  'dispositivo',
  'rol',
  'rol_permiso',
  'usuario',
  'impuesto',
  'estacion',
  'categoria',
  'producto',
  'variante',
  'grupo_modificador',
  'producto_grupo_modificador',
  'modificador',
  'producto_estacion',
  'impresora',
  'datafono',
] as const

/** Solo se agregan filas: la base rechaza UPDATE y DELETE. */
export const TABLAS_INMUTABLES = [
  'evento',
  'evento_agregado',
  'evento_rechazado',
  'catalogo_cambio',
] as const

/** Estado calculado a partir de los eventos; se puede borrar y reconstruir. */
export const TABLAS_PROYECCION = [
  'pedido',
  'pedido_item',
  'pedido_item_modificador',
  'conflicto',
] as const

/** Datos propios del hub que nunca se sincronizan. */
export const TABLAS_LOCALES = [
  'dispositivo_credencial',
  'usuario_credencial',
  'sesion',
  'autorizacion',
  'contador',
  'evento_cuarentena',
  'migracion',
  'trabajo_impresion',
] as const

export const COLUMNAS_COMUNES = [
  'id',
  'restaurante_id',
  'creado_en',
  'actualizado_en',
  'version',
  'usuario_id',
  'dispositivo_id',
  'activo',
] as const
