// Tarea 1.6: precuenta, división, pagos y propina.
//
// - `datafono`: los datáfonos del restaurante (Bold, Redeban…). Un pago con tarjeta dice en cuál se
//   cobró; la conciliación de la 1.8 los empareja con lo que reporta cada uno.
// - `print_jobs` acepta `precuenta`: la tabla se reconstruye porque SQLite no deja cambiar un
//   CHECK. Las filas, los índices y los disparadores quedan iguales.

export const sql = `
CREATE TABLE card_terminals (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  user_id TEXT,
  device_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  provider TEXT NOT NULL CHECK (provider IN ('bold', 'redeban', 'credibanco', 'other'))
) STRICT;
CREATE TRIGGER card_terminals_no_delete BEFORE DELETE ON card_terminals
BEGIN SELECT RAISE(ABORT, 'datafono: se archiva con activo = 0, no se borra'); END;
CREATE INDEX card_terminals_by_version ON card_terminals (restaurant_id, version);

CREATE TABLE print_jobs_new (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  printer_id TEXT NOT NULL REFERENCES printers (id),
  type TEXT NOT NULL CHECK (type IN ('ticket', 'test', 'preBill')),
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
INSERT INTO print_jobs_new SELECT * FROM print_jobs;
DROP TABLE print_jobs;
ALTER TABLE print_jobs_new RENAME TO print_jobs;
CREATE TRIGGER print_jobs_no_delete BEFORE DELETE ON print_jobs
BEGIN SELECT RAISE(ABORT, 'trabajo_impresion: termina impreso o descartado, no se borra'); END;
-- SQLite no dispara BEFORE DELETE al reemplazar: sin esto, un INSERT OR REPLACE reescribiría uno.
CREATE TRIGGER print_jobs_no_replace BEFORE INSERT ON print_jobs
WHEN EXISTS (SELECT 1 FROM print_jobs WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'trabajo_impresion: los registros no se reemplazan'); END;
CREATE INDEX print_jobs_pending ON print_jobs (restaurant_id, status, created_at);
-- Reintentar el mismo evento no duplica la comanda en la misma impresora.
CREATE UNIQUE INDEX print_jobs_unique ON print_jobs (event_id, ticket_id, printer_id)
  WHERE event_id IS NOT NULL;
`
