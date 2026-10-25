// Tarea 1.2: lo que se dibuja en el plano además de las mesas (paredes, puertas, plantas, la
// barra, textos), para que el plano se parezca al salón real (docs/MODELO_DATOS.md). Misma
// geometría que una mesa, en centímetros: x e y de la esquina superior izquierda, ancho, alto y
// rotación en grados alrededor del centro.

export const sql = `
CREATE TABLE elemento_plano (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurante_id TEXT NOT NULL REFERENCES restaurante (id),
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  usuario_id TEXT,
  dispositivo_id TEXT,
  activo INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  zona_id TEXT NOT NULL REFERENCES zona (id),
  tipo TEXT NOT NULL CHECK (tipo IN ('pared', 'puerta', 'planta', 'barra', 'texto')),
  texto TEXT,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  ancho INTEGER NOT NULL CHECK (ancho > 0),
  alto INTEGER NOT NULL CHECK (alto > 0),
  rotacion INTEGER NOT NULL DEFAULT 0 CHECK (rotacion BETWEEN 0 AND 359)
) STRICT;
CREATE TRIGGER elemento_plano_sin_delete BEFORE DELETE ON elemento_plano
BEGIN SELECT RAISE(ABORT, 'elemento_plano: se archiva con activo = 0, no se borra'); END;
CREATE INDEX elemento_plano_por_version ON elemento_plano (restaurante_id, version);
CREATE INDEX elemento_plano_por_zona ON elemento_plano (zona_id);
`
