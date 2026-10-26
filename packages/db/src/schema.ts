// Category of each table (docs/MODELO_DATOS.md#categorías). The tests require every table of
// the database to be in exactly one list, so a new table cannot go unclassified.

/** Catalog and configuration: they carry the common columns and are archived, not deleted. */
export const VERSIONED_TABLES = [
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

/** Rows are only appended: the database rejects UPDATE and DELETE. */
export const IMMUTABLE_TABLES = [
  'events',
  'event_aggregates',
  'rejected_events',
  'catalog_changes',
] as const

/** State computed from the events; it can be deleted and rebuilt. */
export const PROJECTION_TABLES = [
  'orders',
  'order_items',
  'order_item_modifiers',
  'conflicts',
] as const

/** The hub's own data, never synced. */
export const LOCAL_TABLES = [
  'device_credentials',
  'user_credentials',
  'sessions',
  'authorizations',
  'counters',
  'quarantined_events',
  'migrations',
  'print_jobs',
] as const

export const COMMON_COLUMNS = [
  'id',
  'restaurant_id',
  'created_at',
  'updated_at',
  'version',
  'user_id',
  'device_id',
  'active',
] as const
