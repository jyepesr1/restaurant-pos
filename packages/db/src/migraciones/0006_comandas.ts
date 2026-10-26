// Tarea 1.4 (ADR-015): comandas impresas por estación y pantalla de cocina opcional.
//
// - `impresora`: catálogo de impresoras del restaurante y las estaciones a las que imprimen.
//   Por red, `direccion` es la IP o el nombre del equipo y `puerto` el de la impresora (9100); por
//   USB (tarea 1.10), `direccion` es el nombre de la impresora en Windows.
// - `print_jobs`: la cola del hub. Se crea en la misma transacción que el evento que lo
//   origina; no se borra: termina impreso o descartado por alguien de la caja.
// - Una pantalla de cocina es un dispositivo `kds` con sus estaciones, y lo que marca va a nombre
//   de un usuario técnico (`usuario.pantalla`) con un rol oculto (`rol.oculto`) que no se ve ni se
//   asigna en Personal y roles.

export const sql = `
ALTER TABLE devices ADD COLUMN station_ids TEXT
  CHECK (station_ids IS NULL OR json_valid(station_ids));
ALTER TABLE users ADD COLUMN screen INTEGER NOT NULL DEFAULT 0 CHECK (screen IN (0, 1));
ALTER TABLE roles ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1));

CREATE TABLE printers (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  user_id TEXT,
  device_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  connection TEXT NOT NULL CHECK (connection IN ('network', 'usb')),
  address TEXT NOT NULL CHECK (length(address) BETWEEN 1 AND 255),
  port INTEGER CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
  width INTEGER NOT NULL CHECK (width IN (58, 80)),
  -- Tabla de caracteres para tildes y eñes: cambia entre marcas genéricas (Jaltech, Xprinter…).
  code_page TEXT NOT NULL DEFAULT 'pc850' CHECK (code_page IN ('pc850', 'wpc1252', 'no_accents')),
  fallback_id TEXT REFERENCES printers (id),
  station_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(station_ids)),
  CHECK (fallback_id IS NULL OR fallback_id <> id)
) STRICT;
CREATE TRIGGER printers_no_delete BEFORE DELETE ON printers
BEGIN SELECT RAISE(ABORT, 'impresora: se archiva con activo = 0, no se borra'); END;
CREATE INDEX printers_by_version ON printers (restaurant_id, version);

CREATE TABLE print_jobs (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  printer_id TEXT NOT NULL REFERENCES printers (id),
  type TEXT NOT NULL CHECK (type IN ('ticket', 'test')),
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
  -- Descarta una persona de la caja (descartado_por_id) o el hub, si el trabajo no se entiende.
  CHECK (status <> 'printed' OR printed_on_id IS NOT NULL)
) STRICT;
CREATE TRIGGER print_jobs_no_delete BEFORE DELETE ON print_jobs
BEGIN SELECT RAISE(ABORT, 'trabajo_impresion: termina impreso o descartado, no se borra'); END;
-- SQLite no dispara BEFORE DELETE al reemplazar: sin esto, un INSERT OR REPLACE reescribiría uno.
CREATE TRIGGER print_jobs_no_replace BEFORE INSERT ON print_jobs
WHEN EXISTS (SELECT 1 FROM print_jobs WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'trabajo_impresion: los registros no se reemplazan'); END;
CREATE INDEX print_jobs_pending ON print_jobs (restaurant_id, status, created_at);
-- El número de comanda del día cuenta los envíos del día (y el de pedido, las aperturas).
CREATE INDEX events_by_type_and_day ON events (restaurant_id, type, business_day);
-- Reintentar el mismo evento no duplica la comanda en la misma impresora.
CREATE UNIQUE INDEX print_jobs_unique ON print_jobs (event_id, ticket_id, printer_id)
  WHERE event_id IS NOT NULL;
`
