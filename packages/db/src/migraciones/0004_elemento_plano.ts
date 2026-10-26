// Tarea 1.2: lo que se dibuja en el plano además de las mesas (paredes, puertas, plantas, la
// barra, textos), para que el plano se parezca al salón real (docs/MODELO_DATOS.md). Misma
// geometría que una mesa, en centímetros: x e y de la esquina superior izquierda, ancho, alto y
// rotación en grados alrededor del centro.

export const sql = `
CREATE TABLE floor_plan_elements (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  user_id TEXT,
  device_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  zone_id TEXT NOT NULL REFERENCES zones (id),
  type TEXT NOT NULL CHECK (type IN ('wall', 'door', 'plant', 'bar', 'text')),
  text TEXT,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  rotation INTEGER NOT NULL DEFAULT 0 CHECK (rotation BETWEEN 0 AND 359)
) STRICT;
CREATE TRIGGER floor_plan_elements_no_delete BEFORE DELETE ON floor_plan_elements
BEGIN SELECT RAISE(ABORT, 'elemento_plano: se archiva con activo = 0, no se borra'); END;
CREATE INDEX floor_plan_elements_by_version ON floor_plan_elements (restaurant_id, version);
CREATE INDEX floor_plan_elements_by_zone ON floor_plan_elements (zone_id);
`
