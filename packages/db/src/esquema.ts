// Categoría de cada tabla (docs/MODELO_DATOS.md#categorías). Las pruebas exigen que toda tabla
// de la base esté en exactamente una lista, para que una tabla nueva no quede sin clasificar.

/** Catálogo y configuración: llevan las columnas comunes y se archivan, no se borran. */
export const TABLAS_VERSIONADAS = [
  'restaurants',
  'locations',
  'zones',
  'dining_tables',
  'floor_plan_elements',
  'devices',
  'roles',
  'role_permissions',
  'users',
  'taxes',
  'stations',
  'categories',
  'products',
  'variants',
  'modifier_groups',
  'product_modifier_groups',
  'modifiers',
  'product_stations',
  'printers',
  'card_terminals',
] as const

/** Solo se agregan filas: la base rechaza UPDATE y DELETE. */
export const TABLAS_INMUTABLES = [
  'events',
  'event_aggregates',
  'rejected_events',
  'catalog_changes',
] as const

/** Estado calculado a partir de los eventos; se puede borrar y reconstruir. */
export const TABLAS_PROYECCION = [
  'orders',
  'order_items',
  'order_item_modifiers',
  'conflicts',
] as const

/** Datos propios del hub que nunca se sincronizan. */
export const TABLAS_LOCALES = [
  'device_credentials',
  'user_credentials',
  'sessions',
  'authorizations',
  'counters',
  'quarantined_events',
  'migrations',
  'print_jobs',
] as const

export const COLUMNAS_COMUNES = [
  'id',
  'restaurant_id',
  'created_at',
  'updated_at',
  'version',
  'user_id',
  'device_id',
  'active',
] as const
