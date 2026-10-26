// Tarea 1.1: historial del catálogo (`CatalogoCambiado`, docs/MODELO_DATOS.md). Cada cambio de
// un registro del catálogo deja una fila con cómo quedó (y cómo estaba), en la versión que tomó
// del contador. Con él, el hub sabe qué precio valía en la `catalog_version` que copió un ítem
// (docs/DINERO.md#precio-copiado). Solo se agregan filas.
//
// La migración llena el historial con el estado actual de cada registro: lo anterior a esta
// tarea no se guardó, pero así toda versión vigente hoy queda en el historial.

const COLUMNAS_COMUNES = [
  'id',
  'restaurant_id',
  'created_at',
  'updated_at',
  'version',
  'user_id',
  'device_id',
  'active',
]

/** Columnas de cada tabla del catálogo tal como están en la versión 2 del esquema. */
const COLUMNS: Record<string, string[]> = {
  taxes: ['name', 'type', 'rate'],
  stations: ['name', 'position'],
  categories: ['name', 'position', 'station_id', 'photo'],
  products: ['category_id', 'name', 'description', 'price', 'tax_id', 'photo', 'favorite'],
  variants: ['product_id', 'name', 'price', 'position'],
  modifier_groups: ['name', 'minimum', 'maximum'],
  product_modifier_groups: ['product_id', 'group_id', 'position'],
  modifiers: ['group_id', 'name', 'extra_price', 'position'],
  product_stations: ['product_id', 'station_id'],
}

const ENTIDADES = Object.keys(COLUMNS)
  .map((t) => `'${t}'`)
  .join(', ')

const copiarEstadoActual = (tableName: string, columns: string[]) => `
INSERT INTO catalog_changes
  (restaurant_id, version, entity, record_id, before, after, user_id, device_id, done_at)
SELECT restaurant_id, version, '${tableName}', id, NULL,
  json_object(${[...COLUMNAS_COMUNES, ...columns].map((c) => `'${c}', ${c}`).join(', ')}),
  user_id, device_id, updated_at
FROM ${tableName};`

export const sql = `
CREATE TABLE catalog_changes (
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  version INTEGER NOT NULL CHECK (version >= 0),
  entity TEXT NOT NULL CHECK (entity IN (${ENTIDADES})),
  record_id TEXT NOT NULL CHECK (length(record_id) = 26),
  before TEXT CHECK (before IS NULL OR json_valid(before)),
  after TEXT NOT NULL CHECK (json_valid(after)),
  user_id TEXT,
  device_id TEXT,
  done_at TEXT NOT NULL,
  PRIMARY KEY (restaurant_id, version)
) STRICT;
CREATE INDEX catalog_changes_by_record ON catalog_changes (restaurant_id, record_id, version);

CREATE TRIGGER catalog_changes_no_update BEFORE UPDATE ON catalog_changes
BEGIN SELECT RAISE(ABORT, 'catalogo_cambio: los registros no se modifican'); END;
CREATE TRIGGER catalog_changes_no_delete BEFORE DELETE ON catalog_changes
BEGIN SELECT RAISE(ABORT, 'catalogo_cambio: los registros no se borran'); END;
CREATE TRIGGER catalog_changes_no_replace BEFORE INSERT ON catalog_changes
WHEN EXISTS (
  SELECT 1 FROM catalog_changes WHERE restaurant_id = NEW.restaurant_id AND version = NEW.version
)
BEGIN SELECT RAISE(ABORT, 'catalogo_cambio: los registros no se reemplazan'); END;
${Object.entries(COLUMNS)
  .map(([tableName, columns]) => copiarEstadoActual(tableName, columns))
  .join('\n')}

-- Desde qué versión hay historial completo: para una versión anterior solo se conoce el estado
-- que se copió aquí.
INSERT INTO counters (restaurant_id, name, value)
SELECT restaurant_id, 'history_since', value FROM counters WHERE name = 'catalog';
`
