import type { Sql } from './sql'

// Migraciones de la base de la nube (Postgres en Neon, ADR-016). Igual que en el hub (ADR-012):
// código TypeScript con el SQL en texto, numeradas, y nunca se edita una ya aplicada (se
// comprueba por su huella). Se aplican con `pnpm --filter @pos/nube migrar`, no desde el Worker.

export interface MigracionNube {
  version: number
  nombre: string
  sql: string
}

const inicial = `
-- Solo se agregan filas: la base rechaza cambiar o borrar (nada se borra, ADR-005).
CREATE FUNCTION solo_agregar() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%: solo se agregan filas, no se cambian ni se borran', TG_TABLE_NAME;
END $$;

CREATE TABLE restaurante (
  id text PRIMARY KEY CHECK (length(id) = 26),
  nombre text NOT NULL CHECK (length(nombre) BETWEEN 1 AND 120),
  creado_en timestamptz NOT NULL DEFAULT now()
);

-- Un código para registrar un hub: se entrega al instalar el PC de caja, vence y sirve una vez.
-- Solo se guarda su huella.
CREATE TABLE codigo_registro (
  huella text PRIMARY KEY,
  restaurante_id text NOT NULL REFERENCES restaurante (id),
  creado_en timestamptz NOT NULL DEFAULT now(),
  vence_en timestamptz NOT NULL,
  usado_en timestamptz,
  hub_id text,
  CHECK ((usado_en IS NULL) = (hub_id IS NULL))
);

-- El PC de caja de una sede. Su credencial se guarda solo como huella; revocarlo la anula.
CREATE TABLE hub (
  id text PRIMARY KEY CHECK (length(id) = 26),
  restaurante_id text NOT NULL REFERENCES restaurante (id),
  sede_id text NOT NULL CHECK (length(sede_id) = 26),
  nombre text NOT NULL CHECK (length(nombre) BETWEEN 1 AND 60),
  instancia text NOT NULL CHECK (length(instancia) BETWEEN 1 AND 100),
  credencial_huella text NOT NULL UNIQUE,
  creado_en timestamptz NOT NULL DEFAULT now(),
  revocado_en timestamptz,
  -- Hasta qué secuencia del hub está todo en la nube, sin huecos desde la 1.
  secuencia_contigua bigint NOT NULL DEFAULT 0 CHECK (secuencia_contigua >= 0)
);
CREATE INDEX hub_por_restaurante ON hub (restaurante_id);

-- Los eventos de todos los restaurantes, tal como los aceptó cada hub (ADR-005 y ADR-007). La
-- clave es (restaurante_id, id): reenviar un evento no lo duplica. La columna secuencia es el
-- orden de llegada a la nube (no es el orden de confirmación entre transacciones a la vez: para
-- leer «lo nuevo» se usa (hub_id, secuencia_hub)); secuencia_hub, el que le dio su hub.
CREATE TABLE evento (
  restaurante_id text NOT NULL REFERENCES restaurante (id),
  id text NOT NULL CHECK (length(id) = 26),
  hub_id text NOT NULL REFERENCES hub (id),
  tipo text NOT NULL,
  agregado_tipo text NOT NULL,
  agregado_id text NOT NULL,
  secuencia_hub bigint NOT NULL CHECK (secuencia_hub >= 1),
  dia_operativo date NOT NULL,
  recibido_en timestamptz NOT NULL,
  contenido jsonb NOT NULL,
  huella text NOT NULL,
  guardado_en timestamptz NOT NULL DEFAULT now(),
  secuencia bigint GENERATED ALWAYS AS IDENTITY,
  PRIMARY KEY (restaurante_id, id)
);
CREATE INDEX evento_por_hub ON evento (hub_id, secuencia_hub);
CREATE INDEX evento_por_dia ON evento (restaurante_id, dia_operativo, tipo);
CREATE INDEX evento_por_agregado ON evento (restaurante_id, agregado_id);
CREATE TRIGGER evento_solo_agregar BEFORE UPDATE OR DELETE ON evento
  FOR EACH ROW EXECUTE FUNCTION solo_agregar();

-- Llegó un id que ya estaba, con otro contenido: no se pisa el guardado; queda para revisión
-- (ADR-007: los conflictos no se descartan, los resuelve una persona).
CREATE TABLE evento_distinto (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurante_id text NOT NULL REFERENCES restaurante (id),
  evento_id text NOT NULL,
  hub_id text NOT NULL REFERENCES hub (id),
  contenido jsonb NOT NULL,
  huella text NOT NULL,
  recibido_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurante_id, evento_id, huella)
);
CREATE TRIGGER evento_distinto_solo_agregar BEFORE UPDATE OR DELETE ON evento_distinto
  FOR EACH ROW EXECUTE FUNCTION solo_agregar();

-- Lo que puede hacer la API. El rol con que se conecta (faro_api, creado a mano en Neon con su
-- clave) recibe este rol; nunca se salta la seguridad por fila. Los roles son de todo el servidor:
-- si ya existe, no se vuelve a crear.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'faro_datos') THEN
    CREATE ROLE faro_datos NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
-- Quien migra también puede pasar a este rol (la API lo hace en cada transacción de un restaurante).
GRANT faro_datos TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO faro_datos;
GRANT SELECT, INSERT ON restaurante TO faro_datos;
-- Solo las columnas que la API cambia: un error no puede tocar el resto.
GRANT SELECT, INSERT, UPDATE (usado_en, hub_id) ON codigo_registro TO faro_datos;
GRANT SELECT, INSERT, UPDATE (credencial_huella, revocado_en, secuencia_contigua) ON hub TO faro_datos;
GRANT SELECT, INSERT ON evento, evento_distinto TO faro_datos;

-- Seguridad por fila: los eventos de un restaurante solo se ven y se escriben dentro de una
-- transacción que dijo de qué restaurante es (set_config('faro.restaurante_id', …, true)).
ALTER TABLE evento ENABLE ROW LEVEL SECURITY;
ALTER TABLE evento_distinto ENABLE ROW LEVEL SECURITY;
CREATE POLICY evento_del_restaurante ON evento TO faro_datos
  USING (restaurante_id = current_setting('faro.restaurante_id', true))
  WITH CHECK (restaurante_id = current_setting('faro.restaurante_id', true));
CREATE POLICY evento_distinto_del_restaurante ON evento_distinto TO faro_datos
  USING (restaurante_id = current_setting('faro.restaurante_id', true))
  WITH CHECK (restaurante_id = current_setting('faro.restaurante_id', true));
`

export const MIGRACIONES_NUBE: readonly MigracionNube[] = [
  { version: 1, nombre: 'inicial', sql: inicial },
]

/** Huella FNV-1a de 64 bits del SQL (la misma idea que en `@pos/db`). */
export function huellaSql(sql: string): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(sql)) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

const CREAR_REGISTRO = `
  CREATE TABLE IF NOT EXISTS migracion (
    version integer PRIMARY KEY,
    nombre text NOT NULL,
    huella text NOT NULL,
    aplicada_en timestamptz NOT NULL DEFAULT now()
  )
`

/**
 * Aplica las migraciones que falten, cada una en su transacción. Falla si una ya aplicada cambió.
 * Devuelve las versiones aplicadas.
 */
export async function migrar(
  sql: Sql,
  migraciones: readonly MigracionNube[] = MIGRACIONES_NUBE,
): Promise<number[]> {
  migraciones.forEach((m, i) => {
    if (m.version !== i + 1)
      throw new Error(`Las migraciones van numeradas 1, 2, 3…: falla en «${m.nombre}»`)
  })
  await sql.query(CREAR_REGISTRO)
  const aplicadas = await sql.query<{ version: number; nombre: string; huella: string }>(
    'SELECT version, nombre, huella FROM migracion ORDER BY version',
  )
  for (const fila of aplicadas) {
    const m = migraciones[fila.version - 1]
    if (m && huellaSql(m.sql) !== fila.huella)
      throw new Error(
        `La migración ${fila.version} («${fila.nombre}») cambió después de aplicarse. Las migraciones publicadas no se editan: crea una nueva.`,
      )
  }
  const hechas: number[] = []
  for (const m of migraciones) {
    const aplicada = await sql.transaccion(async (tx) => {
      // Se bloquea el registro: dos procesos a la vez no aplican la misma migración.
      await tx.query('LOCK TABLE migracion IN EXCLUSIVE MODE')
      const [fila] = await tx.query<{ v: number | null }>('SELECT max(version) AS v FROM migracion')
      if ((fila?.v ?? 0) >= m.version) return false
      await tx.ejecutar(m.sql)
      await tx.query('INSERT INTO migracion (version, nombre, huella) VALUES ($1, $2, $3)', [
        m.version,
        m.nombre,
        huellaSql(m.sql),
      ])
      return true
    })
    if (aplicada) hechas.push(m.version)
  }
  return hechas
}
