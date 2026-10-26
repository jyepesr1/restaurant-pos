// Tablas de la Fase 0 descritas en docs/MODELO_DATOS.md. Todas STRICT: SQLite rechaza un
// número con decimales en una columna INTEGER, así que ningún monto puede ser fraccionario.
//
// Columnas comunes de los registros versionados (V):
//   id, restaurant_id, created_at, updated_at, version, user_id, device_id, activo

const PRICE_LIMIT = 100_000_000
// Incluye los agregados de fases futuras: ampliar este CHECK después obligaría a reconstruir
// la tabla de eventos, que es inmutable.
const AGREGADOS = `'order', 'table', 'product', 'catalog', 'register_shift', 'user', 'system',
  'card_terminal', 'reconciliation', 'document'`
const ESTADOS_ITEM = `'held', 'pending', 'sent', 'in_preparation', 'ready', 'served', 'voided'`
const TIPOS_CONFLICTO = `'duplicate_table', 'table_locked', 'item_not_found', 'item_already_sent',
  'item_already_voided', 'item_moved', 'order_closed', 'price_mismatch'`

const versionado = (restauranteRef = 'REFERENCES restaurants (id)') => `
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurant_id TEXT NOT NULL ${restauranteRef},
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  user_id TEXT,
  device_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))`

/**
 * Tabla de solo agregar. Además de UPDATE y DELETE, bloquea INSERT OR REPLACE: SQLite no
 * dispara BEFORE DELETE al reemplazar, así que sin esto un REPLACE reescribiría la historia.
 * `existe` es la condición (sobre NEW) que indica que la fila ya está.
 */
const inmutable = (tabla: string, existe: string) => `
  CREATE TRIGGER ${tabla}_no_update BEFORE UPDATE ON ${tabla}
  BEGIN SELECT RAISE(ABORT, '${tabla}: los registros no se modifican'); END;
  CREATE TRIGGER ${tabla}_no_delete BEFORE DELETE ON ${tabla}
  BEGIN SELECT RAISE(ABORT, '${tabla}: los registros no se borran'); END;
  CREATE TRIGGER ${tabla}_no_replace BEFORE INSERT ON ${tabla}
  WHEN EXISTS (SELECT 1 FROM ${tabla} WHERE ${existe})
  BEGIN SELECT RAISE(ABORT, '${tabla}: los registros no se reemplazan'); END;`

/** Catálogo y configuración: se archivan (activo = 0), nunca se borran. */
const archivable = (tabla: string) => `
  CREATE TRIGGER ${tabla}_no_delete BEFORE DELETE ON ${tabla}
  BEGIN SELECT RAISE(ABORT, '${tabla}: se archiva con activo = 0, no se borra'); END;
  CREATE INDEX ${tabla}_por_version ON ${tabla} (restaurant_id, version);`

export const sql = `
-- ── Organización y salón ────────────────────────────────────────────────

CREATE TABLE restaurants (${versionado('CHECK (restaurant_id = id)')},
  name TEXT NOT NULL,
  nit TEXT,
  config TEXT NOT NULL CHECK (json_valid(config))
) STRICT;
${archivable('restaurants')}

CREATE TABLE locations (${versionado()},
  name TEXT NOT NULL,
  address TEXT,
  time_zone TEXT NOT NULL
) STRICT;
${archivable('locations')}

CREATE TABLE zones (${versionado()},
  location_id TEXT NOT NULL REFERENCES locations (id),
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1
) STRICT;
${archivable('zones')}

CREATE TABLE dining_tables (${versionado()},
  zone_id TEXT NOT NULL REFERENCES zones (id),
  name TEXT NOT NULL,
  shape TEXT NOT NULL CHECK (shape IN ('round', 'square', 'rectangular', 'bar')),
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  rotation INTEGER NOT NULL DEFAULT 0 CHECK (rotation BETWEEN 0 AND 359),
  capacity INTEGER NOT NULL CHECK (capacity >= 1)
) STRICT;
${archivable('dining_tables')}
CREATE INDEX dining_tables_by_zone ON dining_tables (zone_id);

CREATE TABLE devices (${versionado()},
  location_id TEXT NOT NULL REFERENCES locations (id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('waiter', 'register', 'kds')),
  paired_at TEXT,
  revoked_at TEXT,
  revocation_sequence INTEGER
) STRICT;
${archivable('devices')}

-- Solo en el hub; nunca se sincroniza (ADR-008).
CREATE TABLE device_credentials (
  device_id TEXT NOT NULL PRIMARY KEY REFERENCES devices (id),
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

-- ── Usuarios y permisos ─────────────────────────────────────────────────

CREATE TABLE roles (${versionado()},
  name TEXT NOT NULL,
  system INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1))
) STRICT;
${archivable('roles')}

CREATE TABLE role_permissions (${versionado()},
  role_id TEXT NOT NULL REFERENCES roles (id),
  permission TEXT NOT NULL,
  UNIQUE (role_id, permission)
) STRICT;
${archivable('role_permissions')}

CREATE TABLE users (${versionado()},
  name TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles (id)
) STRICT;
${archivable('users')}

-- Solo en el hub. La huella es HMAC-SHA256 del PIN con la clave del hub; el PIN nunca se guarda.
-- "vigente" acompaña al estado del usuario para que la huella sea única solo entre activos.
CREATE TABLE user_credentials (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES users (id),
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  pin_hash TEXT NOT NULL,
  pin_generated_at TEXT NOT NULL,
  current INTEGER NOT NULL DEFAULT 1 CHECK (current IN (0, 1))
) STRICT;
CREATE UNIQUE INDEX pin_unique_among_current ON user_credentials (restaurant_id, pin_hash)
  WHERE current = 1;
-- Archivar o reactivar un usuario arrastra su PIN.
CREATE TRIGGER users_pin_validity AFTER UPDATE OF active ON users
BEGIN UPDATE user_credentials SET current = NEW.active WHERE user_id = NEW.id; END;

CREATE TABLE sessions (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  device_id TEXT NOT NULL REFERENCES devices (id),
  secret_hash TEXT NOT NULL,
  start TEXT NOT NULL,
  last_used TEXT NOT NULL,
  closed_at TEXT
) STRICT;

CREATE TABLE authorizations (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  supervisor_id TEXT NOT NULL REFERENCES users (id),
  action TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  used_at TEXT,
  UNIQUE (restaurant_id, event_id)
) STRICT;

-- ── Catálogo ────────────────────────────────────────────────────────────

CREATE TABLE taxes (${versionado()},
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('inc', 'iva', 'exempt')),
  rate INTEGER NOT NULL CHECK (rate BETWEEN 0 AND 10000),
  CHECK (type <> 'exempt' OR rate = 0)
) STRICT;
${archivable('taxes')}

CREATE TABLE stations (${versionado()},
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
) STRICT;
${archivable('stations')}

CREATE TABLE categories (${versionado()},
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  station_id TEXT REFERENCES stations (id),
  photo TEXT
) STRICT;
${archivable('categories')}

CREATE TABLE products (${versionado()},
  category_id TEXT NOT NULL REFERENCES categories (id),
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL CHECK (price BETWEEN 0 AND ${PRICE_LIMIT}),
  tax_id TEXT NOT NULL REFERENCES taxes (id),
  photo TEXT,
  favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1))
) STRICT;
${archivable('products')}
CREATE INDEX products_by_category ON products (category_id);

CREATE TABLE variants (${versionado()},
  product_id TEXT NOT NULL REFERENCES products (id),
  name TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price BETWEEN 0 AND ${PRICE_LIMIT}),
  position INTEGER NOT NULL DEFAULT 0
) STRICT;
${archivable('variants')}

CREATE TABLE modifier_groups (${versionado()},
  name TEXT NOT NULL,
  minimum INTEGER NOT NULL DEFAULT 0 CHECK (minimum >= 0),
  maximum INTEGER NOT NULL CHECK (maximum >= 1 AND maximum >= minimum)
) STRICT;
${archivable('modifier_groups')}

CREATE TABLE product_modifier_groups (${versionado()},
  product_id TEXT NOT NULL REFERENCES products (id),
  group_id TEXT NOT NULL REFERENCES modifier_groups (id),
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (product_id, group_id)
) STRICT;
${archivable('product_modifier_groups')}

CREATE TABLE modifiers (${versionado()},
  group_id TEXT NOT NULL REFERENCES modifier_groups (id),
  name TEXT NOT NULL,
  extra_price INTEGER NOT NULL DEFAULT 0 CHECK (extra_price BETWEEN 0 AND ${PRICE_LIMIT}),
  position INTEGER NOT NULL DEFAULT 0
) STRICT;
${archivable('modifiers')}

CREATE TABLE product_stations (${versionado()},
  product_id TEXT NOT NULL REFERENCES products (id),
  station_id TEXT NOT NULL REFERENCES stations (id),
  UNIQUE (product_id, station_id)
) STRICT;
${archivable('product_stations')}

-- Contadores del hub por restaurante (p. ej. "catalogo": versión global del catálogo).
CREATE TABLE counters (
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  name TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value >= 0),
  PRIMARY KEY (restaurant_id, name)
) STRICT;

-- ── Eventos (docs/SYNC.md) ──────────────────────────────────────────────

CREATE TABLE events (
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  id TEXT NOT NULL CHECK (length(id) = 26),
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  aggregate_type TEXT NOT NULL CHECK (aggregate_type IN (${AGREGADOS})),
  aggregate_id TEXT NOT NULL,
  related TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(related)),
  data TEXT NOT NULL CHECK (json_valid(data)),
  session_id TEXT,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  authorization_id TEXT,
  authorized_by_id TEXT,
  reason TEXT,
  device_time TEXT NOT NULL,
  hub_estimated_time TEXT NOT NULL,
  base_sequence INTEGER NOT NULL CHECK (base_sequence >= 0),
  -- Lo que agrega el hub al aceptar
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  received_at TEXT NOT NULL,
  business_day TEXT NOT NULL
    CHECK (business_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  assignments TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(assignments)),
  affects TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(affects)),
  -- Huella del contenido enviado: detecta un mismo id con contenido distinto
  content_hash TEXT NOT NULL,
  PRIMARY KEY (restaurant_id, id),
  UNIQUE (restaurant_id, sequence)
) STRICT;
${inmutable('events', 'restaurant_id = NEW.restaurant_id AND (id = NEW.id OR sequence = NEW.sequence)')}
-- La secuencia es contigua: sin huecos ni saltos (docs/SYNC.md).
CREATE TRIGGER events_contiguous_sequence BEFORE INSERT ON events
WHEN NEW.sequence <> coalesce(
  (SELECT max(sequence) FROM events WHERE restaurant_id = NEW.restaurant_id), 0) + 1
BEGIN SELECT RAISE(ABORT, 'evento: la secuencia debe ser la siguiente, sin huecos'); END;

-- Índice de los agregados que toca cada evento (su agregado, relacionados y afecta), para
-- reconstruir la proyección de un pedido sin recorrer todos los eventos.
CREATE TABLE event_aggregates (
  restaurant_id TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (restaurant_id, aggregate_id, sequence),
  FOREIGN KEY (restaurant_id, event_id) REFERENCES events (restaurant_id, id)
) STRICT;
${inmutable('event_aggregates', 'restaurant_id = NEW.restaurant_id AND aggregate_id = NEW.aggregate_id AND sequence = NEW.sequence')}

CREATE TABLE rejected_events (
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  event_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  -- Un mismo id puede rechazarse otra vez con contenido distinto (id_repetido): se guardan ambos.
  PRIMARY KEY (restaurant_id, event_id, content_hash)
) STRICT;
${inmutable('rejected_events', 'restaurant_id = NEW.restaurant_id AND event_id = NEW.event_id AND content_hash = NEW.content_hash')}

CREATE TABLE quarantined_events (
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  event_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  content TEXT NOT NULL CHECK (json_valid(content)),
  received_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution TEXT CHECK (resolution IN ('accepted', 'discarded')),
  PRIMARY KEY (restaurant_id, event_id)
) STRICT;

-- ── Proyecciones (se pueden borrar y reconstruir desde los eventos) ─────

CREATE TABLE orders (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  channel TEXT NOT NULL CHECK (channel IN ('dine_in', 'takeout', 'delivery', 'bar')),
  table_id TEXT,
  day_number INTEGER CHECK (day_number >= 1),
  provisional_number TEXT,
  guests INTEGER NOT NULL DEFAULT 0 CHECK (guests >= 0),
  assigned_waiter_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'canceled')),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  business_day TEXT,
  rescue_order_of TEXT,
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 1)
) STRICT;
CREATE INDEX orders_by_status ON orders (restaurant_id, status);
CREATE INDEX orders_by_table ON orders (table_id) WHERE status = 'open';

CREATE TABLE order_items (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  order_id TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 1),
  product_id TEXT NOT NULL,
  variant_id TEXT,
  name TEXT NOT NULL,
  unit_price INTEGER NOT NULL CHECK (unit_price BETWEEN 0 AND ${PRICE_LIMIT}),
  tax_type TEXT NOT NULL CHECK (tax_type IN ('inc', 'iva', 'exempt')),
  rate INTEGER NOT NULL CHECK (rate BETWEEN 0 AND 10000),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  -- Anulación parcial (1 de 3): se conserva la cantidad original para los informes.
  voided_quantity INTEGER NOT NULL DEFAULT 0 CHECK (voided_quantity BETWEEN 0 AND quantity),
  guest INTEGER CHECK (guest >= 1),
  course TEXT CHECK (course IN ('entry', 'main', 'dessert')),
  status TEXT NOT NULL CHECK (status IN (${ESTADOS_ITEM})),
  added_by TEXT NOT NULL,
  notes TEXT,
  station_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(station_ids)),
  CHECK (tax_type <> 'exempt' OR rate = 0)
) STRICT;
CREATE INDEX order_items_by_order ON order_items (order_id, position);

CREATE TABLE order_item_modifiers (
  order_item_id TEXT NOT NULL REFERENCES order_items (id) ON DELETE CASCADE,
  modifier_id TEXT NOT NULL,
  name TEXT NOT NULL,
  extra_price INTEGER NOT NULL CHECK (extra_price BETWEEN 0 AND ${PRICE_LIMIT}),
  PRIMARY KEY (order_item_id, modifier_id)
) STRICT;

CREATE TABLE conflicts (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  type TEXT NOT NULL CHECK (type IN (${TIPOS_CONFLICTO})),
  event_id TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  description TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT,
  UNIQUE (restaurant_id, event_id)
) STRICT;
`
