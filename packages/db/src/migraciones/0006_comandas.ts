// Tarea 1.4 (ADR-015): comandas impresas por estación y pantalla de cocina opcional.
//
// - `impresora`: catálogo de impresoras del restaurante y las estaciones a las que imprimen.
//   Por red, `direccion` es la IP o el nombre del equipo y `puerto` el de la impresora (9100); por
//   USB (tarea 1.10), `direccion` es el nombre de la impresora en Windows.
// - `trabajo_impresion`: la cola del hub. Se crea en la misma transacción que el evento que lo
//   origina; no se borra: termina impreso o descartado por alguien de la caja.
// - Una pantalla de cocina es un dispositivo `kds` con sus estaciones, y lo que marca va a nombre
//   de un usuario técnico (`usuario.pantalla`) con un rol oculto (`rol.oculto`) que no se ve ni se
//   asigna en Personal y roles.

export const sql = `
ALTER TABLE dispositivo ADD COLUMN estacion_ids TEXT
  CHECK (estacion_ids IS NULL OR json_valid(estacion_ids));
ALTER TABLE usuario ADD COLUMN pantalla INTEGER NOT NULL DEFAULT 0 CHECK (pantalla IN (0, 1));
ALTER TABLE rol ADD COLUMN oculto INTEGER NOT NULL DEFAULT 0 CHECK (oculto IN (0, 1));

CREATE TABLE impresora (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurante_id TEXT NOT NULL REFERENCES restaurante (id),
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  usuario_id TEXT,
  dispositivo_id TEXT,
  activo INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  nombre TEXT NOT NULL CHECK (length(nombre) BETWEEN 1 AND 60),
  conexion TEXT NOT NULL CHECK (conexion IN ('red', 'usb')),
  direccion TEXT NOT NULL CHECK (length(direccion) BETWEEN 1 AND 255),
  puerto INTEGER CHECK (puerto IS NULL OR puerto BETWEEN 1 AND 65535),
  ancho INTEGER NOT NULL CHECK (ancho IN (58, 80)),
  -- Tabla de caracteres para tildes y eñes: cambia entre marcas genéricas (Jaltech, Xprinter…).
  pagina_codigos TEXT NOT NULL DEFAULT 'pc850' CHECK (pagina_codigos IN ('pc850', 'wpc1252', 'sin_tildes')),
  respaldo_id TEXT REFERENCES impresora (id),
  estacion_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(estacion_ids)),
  CHECK (respaldo_id IS NULL OR respaldo_id <> id)
) STRICT;
CREATE TRIGGER impresora_sin_delete BEFORE DELETE ON impresora
BEGIN SELECT RAISE(ABORT, 'impresora: se archiva con activo = 0, no se borra'); END;
CREATE INDEX impresora_por_version ON impresora (restaurante_id, version);

CREATE TABLE trabajo_impresion (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurante_id TEXT NOT NULL REFERENCES restaurante (id),
  impresora_id TEXT NOT NULL REFERENCES impresora (id),
  tipo TEXT NOT NULL CHECK (tipo IN ('comanda', 'prueba')),
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
CREATE TRIGGER trabajo_impresion_sin_delete BEFORE DELETE ON trabajo_impresion
BEGIN SELECT RAISE(ABORT, 'trabajo_impresion: termina impreso o descartado, no se borra'); END;
-- SQLite no dispara BEFORE DELETE al reemplazar: sin esto, un INSERT OR REPLACE reescribiría uno.
CREATE TRIGGER trabajo_impresion_sin_reemplazo BEFORE INSERT ON trabajo_impresion
WHEN EXISTS (SELECT 1 FROM trabajo_impresion WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'trabajo_impresion: los registros no se reemplazan'); END;
CREATE INDEX trabajo_impresion_pendiente ON trabajo_impresion (restaurante_id, estado, creado_en);
-- El número de comanda del día cuenta los envíos del día (y el de pedido, las aperturas).
CREATE INDEX evento_por_tipo_y_dia ON evento (restaurante_id, tipo, dia_operativo);
-- Reintentar el mismo evento no duplica la comanda en la misma impresora.
CREATE UNIQUE INDEX trabajo_impresion_unico ON trabajo_impresion (evento_id, comanda_id, impresora_id)
  WHERE evento_id IS NOT NULL;
`
