// Tarea 1.9 (reportes básicos, docs/KPIS.md):
// - `print_jobs` acepta `informe`: el cierre Z que sale al cerrar la caja y sus
//   reimpresiones. La tabla se reconstruye igual que en la 0007 (SQLite no deja cambiar un CHECK);
//   las filas, los índices y los disparadores quedan iguales.

export const sql = `
CREATE TABLE print_jobs_new (
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
