// Hub schema described in docs/MODELO_DATOS.md. Every table is STRICT: SQLite rejects a number
// with decimals in an INTEGER column, so no amount can be fractional.
//
// Common columns of versioned records:
//   id, restaurant_id, created_at, updated_at, version, user_id, device_id, active

const PRICE_LIMIT = 100_000_000
// Includes the aggregates of future phases: widening this CHECK later would force rebuilding
// the events table, which is immutable.
const AGGREGATES = `'order', 'table', 'product', 'catalog', 'register_shift', 'user', 'system',
  'card_terminal', 'reconciliation', 'document'`
const ITEM_STATUSES = `'held', 'pending', 'sent', 'in_preparation', 'ready', 'served', 'voided'`
const CONFLICT_TYPES = `'duplicate_table', 'table_locked', 'item_not_found', 'item_already_sent',
  'item_already_voided', 'item_moved', 'order_closed', 'price_mismatch'`
// Catalog tables whose changes go to the catalog history.
const CATALOG_ENTITIES = `'taxes', 'stations', 'categories', 'products', 'variants',
  'modifier_groups', 'product_modifier_groups', 'modifiers', 'product_stations'`

const versioned = (restaurantRef = 'REFERENCES restaurants (id)') => `
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurant_id TEXT NOT NULL ${restaurantRef},
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  user_id TEXT,
  device_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))`

/**
 * Append-only table. Besides UPDATE and DELETE, it blocks INSERT OR REPLACE: SQLite does not
 * fire BEFORE DELETE when replacing, so without this a REPLACE would rewrite history.
 * `exists` is the condition (on NEW) that tells the row is already there.
 */
const immutable = (tableName: string, exists: string) => `
  CREATE TRIGGER ${tableName}_no_update BEFORE UPDATE ON ${tableName}
  BEGIN SELECT RAISE(ABORT, '${tableName}: los registros no se modifican'); END;
  CREATE TRIGGER ${tableName}_no_delete BEFORE DELETE ON ${tableName}
  BEGIN SELECT RAISE(ABORT, '${tableName}: los registros no se borran'); END;
  CREATE TRIGGER ${tableName}_no_replace BEFORE INSERT ON ${tableName}
  WHEN EXISTS (SELECT 1 FROM ${tableName} WHERE ${exists})
  BEGIN SELECT RAISE(ABORT, '${tableName}: los registros no se reemplazan'); END;`

/**
 * Catalog and configuration: archived (active = 0), never deleted.
 */
const archivable = (tableName: string) => `
  CREATE TRIGGER ${tableName}_no_delete BEFORE DELETE ON ${tableName}
  BEGIN SELECT RAISE(ABORT, '${tableName}: se archiva con active = 0, no se borra'); END;
  CREATE INDEX ${tableName}_by_version ON ${tableName} (restaurant_id, version);`

export const sql = `
-- ── Organization and floor ──────────────────────────────────────────────

CREATE TABLE restaurants (${versioned('CHECK (restaurant_id = id)')},
  name TEXT NOT NULL,
  nit TEXT,
  config TEXT NOT NULL CHECK (json_valid(config))
) STRICT;
${archivable('restaurants')}

CREATE TABLE locations (${versioned()},
  name TEXT NOT NULL,
  address TEXT,
  time_zone TEXT NOT NULL
) STRICT;
${archivable('locations')}

CREATE TABLE zones (${versioned()},
  location_id TEXT NOT NULL REFERENCES locations (id),
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1
) STRICT;
${archivable('zones')}

CREATE TABLE dining_tables (${versioned()},
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

-- What is drawn on the floor plan besides tables (walls, doors, plants, the bar, labels). Same
-- geometry as a table, in centimeters: x and y of the top-left corner, width, height and
-- rotation in degrees around the center.
CREATE TABLE floor_plan_elements (${versioned()},
  zone_id TEXT NOT NULL REFERENCES zones (id),
  type TEXT NOT NULL CHECK (type IN ('wall', 'door', 'plant', 'bar', 'text')),
  text TEXT,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  rotation INTEGER NOT NULL DEFAULT 0 CHECK (rotation BETWEEN 0 AND 359)
) STRICT;
${archivable('floor_plan_elements')}
CREATE INDEX floor_plan_elements_by_zone ON floor_plan_elements (zone_id);

-- A kitchen screen is a \`kds\` device with its stations (ADR-015).
CREATE TABLE devices (${versioned()},
  location_id TEXT NOT NULL REFERENCES locations (id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('waiter', 'register', 'kds')),
  paired_at TEXT,
  revoked_at TEXT,
  revocation_sequence INTEGER,
  station_ids TEXT CHECK (station_ids IS NULL OR json_valid(station_ids))
) STRICT;
${archivable('devices')}

-- Hub only; never synced (ADR-008).
CREATE TABLE device_credentials (
  device_id TEXT NOT NULL PRIMARY KEY REFERENCES devices (id),
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

-- ── Users and permissions ───────────────────────────────────────────────

-- A hidden role is not shown or assignable in Staff and roles (the kitchen screen's role).
CREATE TABLE roles (${versioned()},
  name TEXT NOT NULL,
  system INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1)),
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1))
) STRICT;
${archivable('roles')}

CREATE TABLE role_permissions (${versioned()},
  role_id TEXT NOT NULL REFERENCES roles (id),
  permission TEXT NOT NULL,
  UNIQUE (role_id, permission)
) STRICT;
${archivable('role_permissions')}

-- \`screen\`: the technical user a kitchen screen acts as.
CREATE TABLE users (${versioned()},
  name TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles (id),
  screen INTEGER NOT NULL DEFAULT 0 CHECK (screen IN (0, 1))
) STRICT;
${archivable('users')}

-- Hub only. The PIN hash is HMAC-SHA256 of the PIN with the hub key; the PIN is never stored.
-- "current" follows the user's state so the hash is unique only among active users.
-- Register staff sign in with username and password (ADR-013): the username is stored
-- normalized (lowercase), the password as a slow salted hash (scrypt). Without a username the
-- person signs in with their PIN (waiters); with one, the PIN only serves to authorize.
CREATE TABLE user_credentials (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES users (id),
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  pin_hash TEXT NOT NULL,
  pin_generated_at TEXT NOT NULL,
  current INTEGER NOT NULL DEFAULT 1 CHECK (current IN (0, 1)),
  username TEXT
    CHECK (username IS NULL OR (length(username) BETWEEN 3 AND 40
      AND username = lower(username))),
  password_hash TEXT,
  password_changed_at TEXT
) STRICT;
CREATE UNIQUE INDEX pin_unique_among_current ON user_credentials (restaurant_id, pin_hash)
  WHERE current = 1;
CREATE UNIQUE INDEX username_unique_among_current
  ON user_credentials (restaurant_id, username)
  WHERE current = 1 AND username IS NOT NULL;
-- Archiving or reactivating a user carries their PIN along.
CREATE TRIGGER users_pin_validity AFTER UPDATE OF active ON users
BEGIN UPDATE user_credentials SET current = NEW.active WHERE user_id = NEW.id; END;
-- Username and password go together: one without the other lets nobody in.
CREATE TRIGGER users_with_password_insert BEFORE INSERT ON user_credentials
WHEN (NEW.username IS NULL) <> (NEW.password_hash IS NULL)
BEGIN SELECT RAISE(ABORT, 'user_credentials: usuario y contraseña van juntos'); END;
CREATE TRIGGER users_with_password_update BEFORE UPDATE ON user_credentials
WHEN (NEW.username IS NULL) <> (NEW.password_hash IS NULL)
BEGIN SELECT RAISE(ABORT, 'user_credentials: usuario y contraseña van juntos'); END;

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

-- A supervisor approval is bound to the exact content of the authorized event and to the
-- session that asked for it (ADR-008).
CREATE TABLE authorizations (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  supervisor_id TEXT NOT NULL REFERENCES users (id),
  action TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  used_at TEXT,
  content_hash TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  UNIQUE (restaurant_id, event_id)
) STRICT;

-- ── Catalog ─────────────────────────────────────────────────────────────

CREATE TABLE taxes (${versioned()},
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('inc', 'iva', 'exempt')),
  rate INTEGER NOT NULL CHECK (rate BETWEEN 0 AND 10000),
  CHECK (type <> 'exempt' OR rate = 0)
) STRICT;
${archivable('taxes')}

CREATE TABLE stations (${versioned()},
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
) STRICT;
${archivable('stations')}

CREATE TABLE categories (${versioned()},
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  station_id TEXT REFERENCES stations (id),
  photo TEXT
) STRICT;
${archivable('categories')}

CREATE TABLE products (${versioned()},
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

CREATE TABLE variants (${versioned()},
  product_id TEXT NOT NULL REFERENCES products (id),
  name TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price BETWEEN 0 AND ${PRICE_LIMIT}),
  position INTEGER NOT NULL DEFAULT 0
) STRICT;
${archivable('variants')}

CREATE TABLE modifier_groups (${versioned()},
  name TEXT NOT NULL,
  minimum INTEGER NOT NULL DEFAULT 0 CHECK (minimum >= 0),
  maximum INTEGER NOT NULL CHECK (maximum >= 1 AND maximum >= minimum)
) STRICT;
${archivable('modifier_groups')}

CREATE TABLE product_modifier_groups (${versioned()},
  product_id TEXT NOT NULL REFERENCES products (id),
  group_id TEXT NOT NULL REFERENCES modifier_groups (id),
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (product_id, group_id)
) STRICT;
${archivable('product_modifier_groups')}

CREATE TABLE modifiers (${versioned()},
  group_id TEXT NOT NULL REFERENCES modifier_groups (id),
  name TEXT NOT NULL,
  extra_price INTEGER NOT NULL DEFAULT 0 CHECK (extra_price BETWEEN 0 AND ${PRICE_LIMIT}),
  position INTEGER NOT NULL DEFAULT 0
) STRICT;
${archivable('modifiers')}

CREATE TABLE product_stations (${versioned()},
  product_id TEXT NOT NULL REFERENCES products (id),
  station_id TEXT NOT NULL REFERENCES stations (id),
  UNIQUE (product_id, station_id)
) STRICT;
${archivable('product_stations')}

-- Catalog history (\`CatalogChanged\`, docs/MODELO_DATOS.md): each change to a catalog record
-- leaves a row with how it ended up (and how it was), at the version it took from the counter.
-- With it the hub knows which price applied at the \`catalog_version\` an item copied
-- (docs/DINERO.md#precio-copiado). Rows are only appended.
CREATE TABLE catalog_changes (
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  version INTEGER NOT NULL CHECK (version >= 0),
  entity TEXT NOT NULL CHECK (entity IN (${CATALOG_ENTITIES})),
  record_id TEXT NOT NULL CHECK (length(record_id) = 26),
  before TEXT CHECK (before IS NULL OR json_valid(before)),
  after TEXT NOT NULL CHECK (json_valid(after)),
  user_id TEXT,
  device_id TEXT,
  done_at TEXT NOT NULL,
  PRIMARY KEY (restaurant_id, version)
) STRICT;
CREATE INDEX catalog_changes_by_record ON catalog_changes (restaurant_id, record_id, version);
${immutable('catalog_changes', 'restaurant_id = NEW.restaurant_id AND version = NEW.version')}

-- Hub counters per restaurant (e.g. "catalog": global catalog version).
CREATE TABLE counters (
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  name TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value >= 0),
  PRIMARY KEY (restaurant_id, name)
) STRICT;

-- ── Events (docs/SYNC.md) ───────────────────────────────────────────────

CREATE TABLE events (
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  id TEXT NOT NULL CHECK (length(id) = 26),
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  aggregate_type TEXT NOT NULL CHECK (aggregate_type IN (${AGGREGATES})),
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
  -- What the hub adds on accepting
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  received_at TEXT NOT NULL,
  business_day TEXT NOT NULL
    CHECK (business_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  assignments TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(assignments)),
  affects TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(affects)),
  -- Hash of the content sent: detects the same id with different content
  content_hash TEXT NOT NULL,
  PRIMARY KEY (restaurant_id, id),
  UNIQUE (restaurant_id, sequence)
) STRICT;
${immutable('events', 'restaurant_id = NEW.restaurant_id AND (id = NEW.id OR sequence = NEW.sequence)')}
-- The sequence is contiguous: no gaps or jumps (docs/SYNC.md).
CREATE TRIGGER events_contiguous_sequence BEFORE INSERT ON events
WHEN NEW.sequence <> coalesce(
  (SELECT max(sequence) FROM events WHERE restaurant_id = NEW.restaurant_id), 0) + 1
BEGIN SELECT RAISE(ABORT, 'events: la secuencia debe ser la siguiente, sin huecos'); END;
-- The day's ticket number counts the day's sends (and the order number, the openings).
CREATE INDEX events_by_type_and_day ON events (restaurant_id, type, business_day);

-- Index of the aggregates each event touches (its aggregate, related and affects), to rebuild
-- an order's projection without scanning every event.
CREATE TABLE event_aggregates (
  restaurant_id TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (restaurant_id, aggregate_id, sequence),
  FOREIGN KEY (restaurant_id, event_id) REFERENCES events (restaurant_id, id)
) STRICT;
${immutable('event_aggregates', 'restaurant_id = NEW.restaurant_id AND aggregate_id = NEW.aggregate_id AND sequence = NEW.sequence')}

CREATE TABLE rejected_events (
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  event_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  -- The same id can be rejected again with different content (duplicate_id): both are kept.
  PRIMARY KEY (restaurant_id, event_id, content_hash)
) STRICT;
${immutable('rejected_events', 'restaurant_id = NEW.restaurant_id AND event_id = NEW.event_id AND content_hash = NEW.content_hash')}

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

-- ── Projections (can be deleted and rebuilt from the events) ───────────

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
  -- Partial void (1 of 3): the original quantity is kept for the reports.
  voided_quantity INTEGER NOT NULL DEFAULT 0 CHECK (voided_quantity BETWEEN 0 AND quantity),
  guest INTEGER CHECK (guest >= 1),
  course TEXT CHECK (course IN ('starter', 'main', 'dessert')),
  status TEXT NOT NULL CHECK (status IN (${ITEM_STATUSES})),
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
  type TEXT NOT NULL CHECK (type IN (${CONFLICT_TYPES})),
  event_id TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  description TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT,
  UNIQUE (restaurant_id, event_id)
) STRICT;

-- ── Printing and payments (ADR-015) ─────────────────────────────────────

-- The restaurant's printers and the stations they print for. Over the network, \`address\` is
-- the IP or host name and \`port\` the printer's (9100); over USB, \`address\` is the printer's
-- name in Windows.
CREATE TABLE printers (${versioned()},
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  connection TEXT NOT NULL CHECK (connection IN ('network', 'usb')),
  address TEXT NOT NULL CHECK (length(address) BETWEEN 1 AND 255),
  port INTEGER CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
  width INTEGER NOT NULL CHECK (width IN (58, 80)),
  -- Code page for accents and ñ: it varies across generic brands (Jaltech, Xprinter…).
  code_page TEXT NOT NULL DEFAULT 'pc850' CHECK (code_page IN ('pc850', 'wpc1252', 'no_accents')),
  fallback_id TEXT REFERENCES printers (id),
  station_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(station_ids)),
  CHECK (fallback_id IS NULL OR fallback_id <> id)
) STRICT;
${archivable('printers')}

-- The hub's print queue: kitchen tickets, test pages, pre-bills and the Z report. A job is
-- created in the same transaction as the event behind it and is never deleted: it ends up
-- printed or discarded by someone at the register.
CREATE TABLE print_jobs (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  printer_id TEXT NOT NULL REFERENCES printers (id),
  type TEXT NOT NULL CHECK (type IN ('ticket', 'test', 'preBill', 'report')),
  event_id TEXT,
  ticket_id TEXT,
  content TEXT NOT NULL CHECK (json_valid(content)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'printed', 'discarded')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  printed_on_id TEXT REFERENCES printers (id),
  discarded_by_id TEXT REFERENCES users (id),
  discarded_device_id TEXT REFERENCES devices (id),
  CHECK ((status = 'pending') = (finished_at IS NULL)),
  -- Discarded by someone at the register (discarded_by_id) or by the hub, if the job is unreadable.
  CHECK (status <> 'printed' OR printed_on_id IS NOT NULL)
) STRICT;
CREATE TRIGGER print_jobs_no_delete BEFORE DELETE ON print_jobs
BEGIN SELECT RAISE(ABORT, 'print_jobs: termina impreso o descartado, no se borra'); END;
-- SQLite does not fire BEFORE DELETE when replacing: without this, INSERT OR REPLACE would rewrite one.
CREATE TRIGGER print_jobs_no_replace BEFORE INSERT ON print_jobs
WHEN EXISTS (SELECT 1 FROM print_jobs WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'print_jobs: los registros no se reemplazan'); END;
CREATE INDEX print_jobs_pending ON print_jobs (restaurant_id, status, created_at);
-- Retrying the same event does not duplicate the ticket on the same printer.
CREATE UNIQUE INDEX print_jobs_unique ON print_jobs (event_id, ticket_id, printer_id)
  WHERE event_id IS NOT NULL;

-- The restaurant's card terminals (Bold, Redeban…). A card payment says which one charged it;
-- reconciliation matches them with what each one reports.
CREATE TABLE card_terminals (${versioned()},
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  provider TEXT NOT NULL CHECK (provider IN ('bold', 'redeban', 'credibanco', 'other'))
) STRICT;
${archivable('card_terminals')}
`
