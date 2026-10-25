// Tarea 1.1: historial del catálogo (`CatalogoCambiado`, docs/MODELO_DATOS.md). Cada cambio de
// un registro del catálogo deja una fila con cómo quedó (y cómo estaba), en la versión que tomó
// del contador. Con él, el hub sabe qué precio valía en la `catalogo_version` que copió un ítem
// (docs/DINERO.md#precio-copiado). Solo se agregan filas.
//
// La migración llena el historial con el estado actual de cada registro: lo anterior a esta
// tarea no se guardó, pero así toda versión vigente hoy queda en el historial.

const COLUMNAS_COMUNES = [
  'id',
  'restaurante_id',
  'creado_en',
  'actualizado_en',
  'version',
  'usuario_id',
  'dispositivo_id',
  'activo',
]

/** Columnas de cada tabla del catálogo tal como están en la versión 2 del esquema. */
const COLUMNAS: Record<string, string[]> = {
  impuesto: ['nombre', 'tipo', 'tarifa'],
  estacion: ['nombre', 'orden'],
  categoria: ['nombre', 'orden', 'estacion_id', 'foto'],
  producto: ['categoria_id', 'nombre', 'descripcion', 'precio', 'impuesto_id', 'foto', 'favorito'],
  variante: ['producto_id', 'nombre', 'precio', 'orden'],
  grupo_modificador: ['nombre', 'minimo', 'maximo'],
  producto_grupo_modificador: ['producto_id', 'grupo_id', 'orden'],
  modificador: ['grupo_id', 'nombre', 'precio_extra', 'orden'],
  producto_estacion: ['producto_id', 'estacion_id'],
}

const ENTIDADES = Object.keys(COLUMNAS)
  .map((t) => `'${t}'`)
  .join(', ')

const copiarEstadoActual = (tabla: string, columnas: string[]) => `
INSERT INTO catalogo_cambio
  (restaurante_id, version, entidad, registro_id, antes, despues, usuario_id, dispositivo_id, hecho_en)
SELECT restaurante_id, version, '${tabla}', id, NULL,
  json_object(${[...COLUMNAS_COMUNES, ...columnas].map((c) => `'${c}', ${c}`).join(', ')}),
  usuario_id, dispositivo_id, actualizado_en
FROM ${tabla};`

export const sql = `
CREATE TABLE catalogo_cambio (
  restaurante_id TEXT NOT NULL REFERENCES restaurante (id),
  version INTEGER NOT NULL CHECK (version >= 0),
  entidad TEXT NOT NULL CHECK (entidad IN (${ENTIDADES})),
  registro_id TEXT NOT NULL CHECK (length(registro_id) = 26),
  antes TEXT CHECK (antes IS NULL OR json_valid(antes)),
  despues TEXT NOT NULL CHECK (json_valid(despues)),
  usuario_id TEXT,
  dispositivo_id TEXT,
  hecho_en TEXT NOT NULL,
  PRIMARY KEY (restaurante_id, version)
) STRICT;
CREATE INDEX catalogo_cambio_por_registro ON catalogo_cambio (restaurante_id, registro_id, version);

CREATE TRIGGER catalogo_cambio_sin_update BEFORE UPDATE ON catalogo_cambio
BEGIN SELECT RAISE(ABORT, 'catalogo_cambio: los registros no se modifican'); END;
CREATE TRIGGER catalogo_cambio_sin_delete BEFORE DELETE ON catalogo_cambio
BEGIN SELECT RAISE(ABORT, 'catalogo_cambio: los registros no se borran'); END;
CREATE TRIGGER catalogo_cambio_sin_reemplazo BEFORE INSERT ON catalogo_cambio
WHEN EXISTS (
  SELECT 1 FROM catalogo_cambio WHERE restaurante_id = NEW.restaurante_id AND version = NEW.version
)
BEGIN SELECT RAISE(ABORT, 'catalogo_cambio: los registros no se reemplazan'); END;
${Object.entries(COLUMNAS)
  .map(([tabla, columnas]) => copiarEstadoActual(tabla, columnas))
  .join('\n')}

-- Desde qué versión hay historial completo: para una versión anterior solo se conoce el estado
-- que se copió aquí.
INSERT INTO contador (restaurante_id, nombre, valor)
SELECT restaurante_id, 'historial_desde', valor FROM contador WHERE nombre = 'catalogo';
`
