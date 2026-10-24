// Tablas de la Fase 0 descritas en docs/MODELO_DATOS.md. Todas STRICT: SQLite rechaza un
// número con decimales en una columna INTEGER, así que ningún monto puede ser fraccionario.
//
// Columnas comunes de los registros versionados (V):
//   id, restaurante_id, creado_en, actualizado_en, version, usuario_id, dispositivo_id, activo

const LIMITE_PRECIO = 100_000_000
// Incluye los agregados de fases futuras: ampliar este CHECK después obligaría a reconstruir
// la tabla de eventos, que es inmutable.
const AGREGADOS = `'pedido', 'mesa', 'producto', 'catalogo', 'turno_caja', 'usuario', 'sistema',
  'datafono', 'conciliacion', 'documento'`
const ESTADOS_ITEM = `'retenido', 'pendiente', 'enviado', 'en_preparacion', 'listo', 'entregado', 'anulado'`
const TIPOS_CONFLICTO = `'mesa_duplicada', 'mesa_bloqueada', 'item_inexistente', 'item_ya_enviado',
  'item_ya_anulado', 'item_movido', 'pedido_cerrado', 'precio_distinto'`

const versionado = (restauranteRef = 'REFERENCES restaurante (id)') => `
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurante_id TEXT NOT NULL ${restauranteRef},
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  usuario_id TEXT,
  dispositivo_id TEXT,
  activo INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1))`

/**
 * Tabla de solo agregar. Además de UPDATE y DELETE, bloquea INSERT OR REPLACE: SQLite no
 * dispara BEFORE DELETE al reemplazar, así que sin esto un REPLACE reescribiría la historia.
 * `existe` es la condición (sobre NEW) que indica que la fila ya está.
 */
const inmutable = (tabla: string, existe: string) => `
  CREATE TRIGGER ${tabla}_sin_update BEFORE UPDATE ON ${tabla}
  BEGIN SELECT RAISE(ABORT, '${tabla}: los registros no se modifican'); END;
  CREATE TRIGGER ${tabla}_sin_delete BEFORE DELETE ON ${tabla}
  BEGIN SELECT RAISE(ABORT, '${tabla}: los registros no se borran'); END;
  CREATE TRIGGER ${tabla}_sin_reemplazo BEFORE INSERT ON ${tabla}
  WHEN EXISTS (SELECT 1 FROM ${tabla} WHERE ${existe})
  BEGIN SELECT RAISE(ABORT, '${tabla}: los registros no se reemplazan'); END;`

/** Catálogo y configuración: se archivan (activo = 0), nunca se borran. */
const archivable = (tabla: string) => `
  CREATE TRIGGER ${tabla}_sin_delete BEFORE DELETE ON ${tabla}
  BEGIN SELECT RAISE(ABORT, '${tabla}: se archiva con activo = 0, no se borra'); END;
  CREATE INDEX ${tabla}_por_version ON ${tabla} (restaurante_id, version);`

export const sql = `
-- ── Organización y salón ────────────────────────────────────────────────

CREATE TABLE restaurante (${versionado('CHECK (restaurante_id = id)')},
  nombre TEXT NOT NULL,
  nit TEXT,
  config TEXT NOT NULL CHECK (json_valid(config))
) STRICT;
${archivable('restaurante')}

CREATE TABLE sede (${versionado()},
  nombre TEXT NOT NULL,
  direccion TEXT,
  zona_horaria TEXT NOT NULL
) STRICT;
${archivable('sede')}

CREATE TABLE zona (${versionado()},
  sede_id TEXT NOT NULL REFERENCES sede (id),
  nombre TEXT NOT NULL,
  orden INTEGER NOT NULL DEFAULT 0,
  piso INTEGER NOT NULL DEFAULT 1
) STRICT;
${archivable('zona')}

CREATE TABLE mesa (${versionado()},
  zona_id TEXT NOT NULL REFERENCES zona (id),
  nombre TEXT NOT NULL,
  forma TEXT NOT NULL CHECK (forma IN ('redonda', 'cuadrada', 'rectangular', 'barra')),
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  ancho INTEGER NOT NULL CHECK (ancho > 0),
  alto INTEGER NOT NULL CHECK (alto > 0),
  rotacion INTEGER NOT NULL DEFAULT 0 CHECK (rotacion BETWEEN 0 AND 359),
  capacidad INTEGER NOT NULL CHECK (capacidad >= 1)
) STRICT;
${archivable('mesa')}
CREATE INDEX mesa_por_zona ON mesa (zona_id);

CREATE TABLE dispositivo (${versionado()},
  sede_id TEXT NOT NULL REFERENCES sede (id),
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('mesero', 'caja', 'kds')),
  emparejado_en TEXT,
  revocado_en TEXT,
  secuencia_revocacion INTEGER
) STRICT;
${archivable('dispositivo')}

-- Solo en el hub; nunca se sincroniza (ADR-008).
CREATE TABLE dispositivo_credencial (
  dispositivo_id TEXT NOT NULL PRIMARY KEY REFERENCES dispositivo (id),
  restaurante_id TEXT NOT NULL REFERENCES restaurante (id),
  token_hash TEXT NOT NULL UNIQUE,
  creado_en TEXT NOT NULL
) STRICT;

-- ── Usuarios y permisos ─────────────────────────────────────────────────

CREATE TABLE rol (${versionado()},
  nombre TEXT NOT NULL,
  sistema INTEGER NOT NULL DEFAULT 0 CHECK (sistema IN (0, 1))
) STRICT;
${archivable('rol')}

CREATE TABLE rol_permiso (${versionado()},
  rol_id TEXT NOT NULL REFERENCES rol (id),
  permiso TEXT NOT NULL,
  UNIQUE (rol_id, permiso)
) STRICT;
${archivable('rol_permiso')}

CREATE TABLE usuario (${versionado()},
  nombre TEXT NOT NULL,
  rol_id TEXT NOT NULL REFERENCES rol (id)
) STRICT;
${archivable('usuario')}

-- Solo en el hub. La huella es HMAC-SHA256 del PIN con la clave del hub; el PIN nunca se guarda.
-- "vigente" acompaña al estado del usuario para que la huella sea única solo entre activos.
CREATE TABLE usuario_credencial (
  usuario_id TEXT NOT NULL PRIMARY KEY REFERENCES usuario (id),
  restaurante_id TEXT NOT NULL REFERENCES restaurante (id),
  pin_huella TEXT NOT NULL,
  pin_generado_en TEXT NOT NULL,
  vigente INTEGER NOT NULL DEFAULT 1 CHECK (vigente IN (0, 1))
) STRICT;
CREATE UNIQUE INDEX pin_unico_entre_vigentes ON usuario_credencial (restaurante_id, pin_huella)
  WHERE vigente = 1;
-- Archivar o reactivar un usuario arrastra su PIN.
CREATE TRIGGER usuario_vigencia_pin AFTER UPDATE OF activo ON usuario
BEGIN UPDATE usuario_credencial SET vigente = NEW.activo WHERE usuario_id = NEW.id; END;

CREATE TABLE sesion (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurante_id TEXT NOT NULL REFERENCES restaurante (id),
  usuario_id TEXT NOT NULL REFERENCES usuario (id),
  dispositivo_id TEXT NOT NULL REFERENCES dispositivo (id),
  secreto_hash TEXT NOT NULL,
  inicio TEXT NOT NULL,
  ultimo_uso TEXT NOT NULL,
  cerrada_en TEXT
) STRICT;

CREATE TABLE autorizacion (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurante_id TEXT NOT NULL REFERENCES restaurante (id),
  supervisor_id TEXT NOT NULL REFERENCES usuario (id),
  accion TEXT NOT NULL,
  agregado_id TEXT NOT NULL,
  evento_id TEXT NOT NULL,
  emitida_en TEXT NOT NULL,
  usada_en TEXT,
  UNIQUE (restaurante_id, evento_id)
) STRICT;

-- ── Catálogo ────────────────────────────────────────────────────────────

CREATE TABLE impuesto (${versionado()},
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('inc', 'iva', 'exento')),
  tarifa INTEGER NOT NULL CHECK (tarifa BETWEEN 0 AND 10000),
  CHECK (tipo <> 'exento' OR tarifa = 0)
) STRICT;
${archivable('impuesto')}

CREATE TABLE estacion (${versionado()},
  nombre TEXT NOT NULL,
  orden INTEGER NOT NULL DEFAULT 0
) STRICT;
${archivable('estacion')}

CREATE TABLE categoria (${versionado()},
  nombre TEXT NOT NULL,
  orden INTEGER NOT NULL DEFAULT 0,
  estacion_id TEXT REFERENCES estacion (id),
  foto TEXT
) STRICT;
${archivable('categoria')}

CREATE TABLE producto (${versionado()},
  categoria_id TEXT NOT NULL REFERENCES categoria (id),
  nombre TEXT NOT NULL,
  descripcion TEXT,
  precio INTEGER NOT NULL CHECK (precio BETWEEN 0 AND ${LIMITE_PRECIO}),
  impuesto_id TEXT NOT NULL REFERENCES impuesto (id),
  foto TEXT,
  favorito INTEGER NOT NULL DEFAULT 0 CHECK (favorito IN (0, 1))
) STRICT;
${archivable('producto')}
CREATE INDEX producto_por_categoria ON producto (categoria_id);

CREATE TABLE variante (${versionado()},
  producto_id TEXT NOT NULL REFERENCES producto (id),
  nombre TEXT NOT NULL,
  precio INTEGER NOT NULL CHECK (precio BETWEEN 0 AND ${LIMITE_PRECIO}),
  orden INTEGER NOT NULL DEFAULT 0
) STRICT;
${archivable('variante')}

CREATE TABLE grupo_modificador (${versionado()},
  nombre TEXT NOT NULL,
  minimo INTEGER NOT NULL DEFAULT 0 CHECK (minimo >= 0),
  maximo INTEGER NOT NULL CHECK (maximo >= 1 AND maximo >= minimo)
) STRICT;
${archivable('grupo_modificador')}

CREATE TABLE producto_grupo_modificador (${versionado()},
  producto_id TEXT NOT NULL REFERENCES producto (id),
  grupo_id TEXT NOT NULL REFERENCES grupo_modificador (id),
  orden INTEGER NOT NULL DEFAULT 0,
  UNIQUE (producto_id, grupo_id)
) STRICT;
${archivable('producto_grupo_modificador')}

CREATE TABLE modificador (${versionado()},
  grupo_id TEXT NOT NULL REFERENCES grupo_modificador (id),
  nombre TEXT NOT NULL,
  precio_extra INTEGER NOT NULL DEFAULT 0 CHECK (precio_extra BETWEEN 0 AND ${LIMITE_PRECIO}),
  orden INTEGER NOT NULL DEFAULT 0
) STRICT;
${archivable('modificador')}

CREATE TABLE producto_estacion (${versionado()},
  producto_id TEXT NOT NULL REFERENCES producto (id),
  estacion_id TEXT NOT NULL REFERENCES estacion (id),
  UNIQUE (producto_id, estacion_id)
) STRICT;
${archivable('producto_estacion')}

-- Contadores del hub por restaurante (p. ej. "catalogo": versión global del catálogo).
CREATE TABLE contador (
  restaurante_id TEXT NOT NULL REFERENCES restaurante (id),
  nombre TEXT NOT NULL,
  valor INTEGER NOT NULL CHECK (valor >= 0),
  PRIMARY KEY (restaurante_id, nombre)
) STRICT;

-- ── Eventos (docs/SYNC.md) ──────────────────────────────────────────────

CREATE TABLE evento (
  restaurante_id TEXT NOT NULL REFERENCES restaurante (id),
  id TEXT NOT NULL CHECK (length(id) = 26),
  tipo TEXT NOT NULL,
  version_esquema INTEGER NOT NULL CHECK (version_esquema >= 1),
  agregado_tipo TEXT NOT NULL CHECK (agregado_tipo IN (${AGREGADOS})),
  agregado_id TEXT NOT NULL,
  relacionados TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(relacionados)),
  datos TEXT NOT NULL CHECK (json_valid(datos)),
  sesion_id TEXT,
  usuario_id TEXT NOT NULL,
  dispositivo_id TEXT NOT NULL,
  autorizacion_id TEXT,
  autorizado_por_id TEXT,
  motivo TEXT,
  hora_dispositivo TEXT NOT NULL,
  hora_estimada_hub TEXT NOT NULL,
  secuencia_base INTEGER NOT NULL CHECK (secuencia_base >= 0),
  -- Lo que agrega el hub al aceptar
  secuencia INTEGER NOT NULL CHECK (secuencia >= 1),
  recibido_en TEXT NOT NULL,
  dia_operativo TEXT NOT NULL
    CHECK (dia_operativo GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  asignaciones TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(asignaciones)),
  afecta TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(afecta)),
  -- Huella del contenido enviado: detecta un mismo id con contenido distinto
  contenido_hash TEXT NOT NULL,
  PRIMARY KEY (restaurante_id, id),
  UNIQUE (restaurante_id, secuencia)
) STRICT;
${inmutable('evento', 'restaurante_id = NEW.restaurante_id AND (id = NEW.id OR secuencia = NEW.secuencia)')}
-- La secuencia es contigua: sin huecos ni saltos (docs/SYNC.md).
CREATE TRIGGER evento_secuencia_contigua BEFORE INSERT ON evento
WHEN NEW.secuencia <> coalesce(
  (SELECT max(secuencia) FROM evento WHERE restaurante_id = NEW.restaurante_id), 0) + 1
BEGIN SELECT RAISE(ABORT, 'evento: la secuencia debe ser la siguiente, sin huecos'); END;

-- Índice de los agregados que toca cada evento (su agregado, relacionados y afecta), para
-- reconstruir la proyección de un pedido sin recorrer todos los eventos.
CREATE TABLE evento_agregado (
  restaurante_id TEXT NOT NULL,
  agregado_id TEXT NOT NULL,
  secuencia INTEGER NOT NULL,
  evento_id TEXT NOT NULL,
  PRIMARY KEY (restaurante_id, agregado_id, secuencia),
  FOREIGN KEY (restaurante_id, evento_id) REFERENCES evento (restaurante_id, id)
) STRICT;
${inmutable('evento_agregado', 'restaurante_id = NEW.restaurante_id AND agregado_id = NEW.agregado_id AND secuencia = NEW.secuencia')}

CREATE TABLE evento_rechazado (
  restaurante_id TEXT NOT NULL REFERENCES restaurante (id),
  evento_id TEXT NOT NULL,
  dispositivo_id TEXT NOT NULL,
  motivo TEXT NOT NULL,
  contenido TEXT NOT NULL,
  contenido_hash TEXT NOT NULL,
  recibido_en TEXT NOT NULL,
  -- Un mismo id puede rechazarse otra vez con contenido distinto (id_repetido): se guardan ambos.
  PRIMARY KEY (restaurante_id, evento_id, contenido_hash)
) STRICT;
${inmutable('evento_rechazado', 'restaurante_id = NEW.restaurante_id AND evento_id = NEW.evento_id AND contenido_hash = NEW.contenido_hash')}

CREATE TABLE evento_cuarentena (
  restaurante_id TEXT NOT NULL REFERENCES restaurante (id),
  evento_id TEXT NOT NULL,
  dispositivo_id TEXT NOT NULL,
  motivo TEXT NOT NULL,
  contenido TEXT NOT NULL CHECK (json_valid(contenido)),
  recibido_en TEXT NOT NULL,
  resuelto_en TEXT,
  resuelto_por TEXT,
  resolucion TEXT CHECK (resolucion IN ('aceptado', 'descartado')),
  PRIMARY KEY (restaurante_id, evento_id)
) STRICT;

-- ── Proyecciones (se pueden borrar y reconstruir desde los eventos) ─────

CREATE TABLE pedido (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurante_id TEXT NOT NULL REFERENCES restaurante (id),
  canal TEXT NOT NULL CHECK (canal IN ('salon', 'para_llevar', 'domicilio', 'barra')),
  mesa_id TEXT,
  numero_dia INTEGER CHECK (numero_dia >= 1),
  numero_provisional TEXT,
  comensales INTEGER NOT NULL DEFAULT 0 CHECK (comensales >= 0),
  mesero_asignado_id TEXT,
  estado TEXT NOT NULL CHECK (estado IN ('abierto', 'cerrado', 'cancelado')),
  abierto_en TEXT NOT NULL,
  cerrado_en TEXT,
  dia_operativo TEXT,
  pedido_rescate_de TEXT,
  ultima_secuencia INTEGER NOT NULL CHECK (ultima_secuencia >= 1)
) STRICT;
CREATE INDEX pedido_por_estado ON pedido (restaurante_id, estado);
CREATE INDEX pedido_por_mesa ON pedido (mesa_id) WHERE estado = 'abierto';

CREATE TABLE pedido_item (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurante_id TEXT NOT NULL REFERENCES restaurante (id),
  pedido_id TEXT NOT NULL REFERENCES pedido (id) ON DELETE CASCADE,
  orden INTEGER NOT NULL CHECK (orden >= 1),
  producto_id TEXT NOT NULL,
  variante_id TEXT,
  nombre TEXT NOT NULL,
  precio_unitario INTEGER NOT NULL CHECK (precio_unitario BETWEEN 0 AND ${LIMITE_PRECIO}),
  impuesto_tipo TEXT NOT NULL CHECK (impuesto_tipo IN ('inc', 'iva', 'exento')),
  tarifa INTEGER NOT NULL CHECK (tarifa BETWEEN 0 AND 10000),
  cantidad INTEGER NOT NULL CHECK (cantidad BETWEEN 1 AND 999),
  -- Anulación parcial (1 de 3): se conserva la cantidad original para los informes.
  cantidad_anulada INTEGER NOT NULL DEFAULT 0 CHECK (cantidad_anulada BETWEEN 0 AND cantidad),
  comensal INTEGER CHECK (comensal >= 1),
  curso TEXT CHECK (curso IN ('entrada', 'fuerte', 'postre')),
  estado TEXT NOT NULL CHECK (estado IN (${ESTADOS_ITEM})),
  agregado_por TEXT NOT NULL,
  notas TEXT,
  estacion_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(estacion_ids)),
  CHECK (impuesto_tipo <> 'exento' OR tarifa = 0)
) STRICT;
CREATE INDEX pedido_item_por_pedido ON pedido_item (pedido_id, orden);

CREATE TABLE pedido_item_modificador (
  pedido_item_id TEXT NOT NULL REFERENCES pedido_item (id) ON DELETE CASCADE,
  modificador_id TEXT NOT NULL,
  nombre TEXT NOT NULL,
  precio_extra INTEGER NOT NULL CHECK (precio_extra BETWEEN 0 AND ${LIMITE_PRECIO}),
  PRIMARY KEY (pedido_item_id, modificador_id)
) STRICT;

CREATE TABLE conflicto (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  restaurante_id TEXT NOT NULL REFERENCES restaurante (id),
  tipo TEXT NOT NULL CHECK (tipo IN (${TIPOS_CONFLICTO})),
  evento_id TEXT NOT NULL,
  agregado_id TEXT NOT NULL,
  descripcion TEXT NOT NULL,
  detectado_en TEXT NOT NULL,
  resuelto_en TEXT,
  resolucion TEXT,
  UNIQUE (restaurante_id, evento_id)
) STRICT;
`
