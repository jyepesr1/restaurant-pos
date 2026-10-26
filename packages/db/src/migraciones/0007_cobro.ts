// Tarea 1.6: precuenta, división, pagos y propina.
//
// - `datafono`: los datáfonos del restaurante (Bold, Redeban…). Un pago con tarjeta dice en cuál se
//   cobró; la conciliación de la 1.8 los empareja con lo que reporta cada uno.
// - `trabajo_impresion` acepta `precuenta`: la tabla se reconstruye porque SQLite no deja cambiar un
//   CHECK. Las filas, los índices y los disparadores quedan iguales.

export const sql = `
CREATE TABLE datafono (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurante_id TEXT NOT NULL REFERENCES restaurante (id),
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  usuario_id TEXT,
  dispositivo_id TEXT,
  activo INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  nombre TEXT NOT NULL CHECK (length(nombre) BETWEEN 1 AND 60),
  proveedor TEXT NOT NULL CHECK (proveedor IN ('bold', 'redeban', 'credibanco', 'otro'))
) STRICT;
CREATE TRIGGER datafono_sin_delete BEFORE DELETE ON datafono
BEGIN SELECT RAISE(ABORT, 'datafono: se archiva con activo = 0, no se borra'); END;
CREATE INDEX datafono_por_version ON datafono (restaurante_id, version);

CREATE TABLE trabajo_impresion_nueva (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurante_id TEXT NOT NULL REFERENCES restaurante (id),
  impresora_id TEXT NOT NULL REFERENCES impresora (id),
  tipo TEXT NOT NULL CHECK (tipo IN ('comanda', 'prueba', 'precuenta')),
  evento_id TEXT,
  comanda_id TEXT,
  contenido TEXT NOT NULL CHECK (json_valid(contenido)),
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'impreso', 'descartado')),
  intentos INTEGER NOT NULL DEFAULT 0 CHECK (intentos >= 0),
  ultimo_error TEXT,
  creado_en TEXT NOT NULL,
  terminado_en TEXT,
  impreso_en_id TEXT REFERENCES impresora (id),
  descartado_por_id TEXT REFERENCES usuario (id),
  descartado_dispositivo_id TEXT REFERENCES dispositivo (id),
  CHECK ((estado = 'pendiente') = (terminado_en IS NULL)),
  -- Descarta una persona de la caja (descartado_por_id) o el hub, si el trabajo no se entiende.
  CHECK (estado <> 'impreso' OR impreso_en_id IS NOT NULL)
) STRICT;
INSERT INTO trabajo_impresion_nueva SELECT * FROM trabajo_impresion;
DROP TABLE trabajo_impresion;
ALTER TABLE trabajo_impresion_nueva RENAME TO trabajo_impresion;
CREATE TRIGGER trabajo_impresion_sin_delete BEFORE DELETE ON trabajo_impresion
BEGIN SELECT RAISE(ABORT, 'trabajo_impresion: termina impreso o descartado, no se borra'); END;
-- SQLite no dispara BEFORE DELETE al reemplazar: sin esto, un INSERT OR REPLACE reescribiría uno.
CREATE TRIGGER trabajo_impresion_sin_reemplazo BEFORE INSERT ON trabajo_impresion
WHEN EXISTS (SELECT 1 FROM trabajo_impresion WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'trabajo_impresion: los registros no se reemplazan'); END;
CREATE INDEX trabajo_impresion_pendiente ON trabajo_impresion (restaurante_id, estado, creado_en);
-- Reintentar el mismo evento no duplica la comanda en la misma impresora.
CREATE UNIQUE INDEX trabajo_impresion_unico ON trabajo_impresion (evento_id, comanda_id, impresora_id)
  WHERE evento_id IS NOT NULL;
`
