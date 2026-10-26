import type { Sql } from './sql'

// Migraciones de la base de la nube (Postgres en Neon, ADR-016). Igual que en el hub (ADR-012):
// código TypeScript con el SQL en texto, numeradas, y nunca se edita una ya aplicada (se
// comprueba por su huella). Se aplican con `pnpm --filter @pos/nube migrar`, no desde el Worker.

export interface MigracionNube {
  version: number
  name: string
  sql: string
}

const initial = `
-- Solo se agregan filas: la base rechaza cambiar o borrar (nada se borra, ADR-005).
CREATE FUNCTION append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%: solo se agregan filas, no se cambian ni se borran', TG_TABLE_NAME;
END $$;

CREATE TABLE restaurants (
  id text PRIMARY KEY CHECK (length(id) = 26),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Un código para registrar un hub: se entrega al instalar el PC de caja, vence y sirve una vez.
-- Solo se guarda su huella.
CREATE TABLE registration_codes (
  fingerprint text PRIMARY KEY,
  restaurant_id text NOT NULL REFERENCES restaurants (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  hub_id text,
  CHECK ((used_at IS NULL) = (hub_id IS NULL))
);

-- El PC de caja de una sede. Su credencial se guarda solo como huella; revocarlo la anula.
CREATE TABLE hubs (
  id text PRIMARY KEY CHECK (length(id) = 26),
  restaurant_id text NOT NULL REFERENCES restaurants (id),
  location_id text NOT NULL CHECK (length(location_id) = 26),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  instancia text NOT NULL CHECK (length(instancia) BETWEEN 1 AND 100),
  credential_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  -- Hasta qué secuencia del hub está todo en la nube, sin huecos desde la 1.
  contiguous_sequence bigint NOT NULL DEFAULT 0 CHECK (contiguous_sequence >= 0)
);
CREATE INDEX hubs_by_restaurant ON hubs (restaurant_id);

-- Los eventos de todos los restaurantes, tal como los aceptó cada hub (ADR-005 y ADR-007). La
-- clave es (restaurante_id, id): reenviar un evento no lo duplica. La columna secuencia es el
-- orden de llegada a la nube (no es el orden de confirmación entre transacciones a la vez: para
-- leer «lo nuevo» se usa (hub_id, secuencia_hub)); secuencia_hub, el que le dio su hub.
CREATE TABLE events (
  restaurant_id text NOT NULL REFERENCES restaurants (id),
  id text NOT NULL CHECK (length(id) = 26),
  hub_id text NOT NULL REFERENCES hubs (id),
  type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  hub_sequence bigint NOT NULL CHECK (hub_sequence >= 1),
  business_day date NOT NULL,
  received_at timestamptz NOT NULL,
  content jsonb NOT NULL,
  fingerprint text NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now(),
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  PRIMARY KEY (restaurant_id, id)
);
CREATE INDEX events_by_hub ON events (hub_id, hub_sequence);
CREATE INDEX events_by_day ON events (restaurant_id, business_day, type);
CREATE INDEX events_by_aggregate ON events (restaurant_id, aggregate_id);
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION append_only();

-- Llegó un id que ya estaba, con otro contenido: no se pisa el guardado; queda para revisión
-- (ADR-007: los conflictos no se descartan, los resuelve una persona).
CREATE TABLE divergent_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id text NOT NULL REFERENCES restaurants (id),
  event_id text NOT NULL,
  hub_id text NOT NULL REFERENCES hubs (id),
  content jsonb NOT NULL,
  fingerprint text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, event_id, fingerprint)
);
CREATE TRIGGER divergent_events_append_only BEFORE UPDATE OR DELETE ON divergent_events
  FOR EACH ROW EXECUTE FUNCTION append_only();

-- Lo que puede hacer la API. El rol con que se conecta (faro_api, creado a mano en Neon con su
-- clave) recibe este rol; nunca se salta la seguridad por fila. Los roles son de todo el servidor:
-- si ya existe, no se vuelve a crear.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'faro_data') THEN
    CREATE ROLE faro_data NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
-- Quien migra también puede pasar a este rol (la API lo hace en cada transacción de un restaurante).
GRANT faro_data TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO faro_data;
GRANT SELECT, INSERT ON restaurants TO faro_data;
-- Solo las columnas que la API cambia: un error no puede tocar el resto.
GRANT SELECT, INSERT, UPDATE (used_at, hub_id) ON registration_codes TO faro_data;
GRANT SELECT, INSERT, UPDATE (credential_hash, revoked_at, contiguous_sequence) ON hubs TO faro_data;
GRANT SELECT, INSERT ON events, divergent_events TO faro_data;

-- Seguridad por fila: los eventos de un restaurante solo se ven y se escriben dentro de una
-- transacción que dijo de qué restaurante es (set_config('faro.restaurante_id', …, true)).
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE divergent_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY events_of_restaurant ON events TO faro_data
  USING (restaurant_id = current_setting('faro.restaurant_id', true))
  WITH CHECK (restaurant_id = current_setting('faro.restaurant_id', true));
CREATE POLICY divergent_events_of_restaurant ON divergent_events TO faro_data
  USING (restaurant_id = current_setting('faro.restaurant_id', true))
  WITH CHECK (restaurant_id = current_setting('faro.restaurant_id', true));
`

export const MIGRACIONES_NUBE: readonly MigracionNube[] = [
  { version: 1, name: 'initial', sql: initial },
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
  CREATE TABLE IF NOT EXISTS migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    fingerprint text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
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
      throw new Error(`Las migraciones van numeradas 1, 2, 3…: falla en «${m.name}»`)
  })
  await sql.query(CREAR_REGISTRO)
  const aplicadas = await sql.query<{ version: number; name: string; fingerprint: string }>(
    'SELECT version, name, fingerprint FROM migrations ORDER BY version',
  )
  for (const fila of aplicadas) {
    const m = migraciones[fila.version - 1]
    if (m && huellaSql(m.sql) !== fila.fingerprint)
      throw new Error(
        `La migración ${fila.version} («${fila.name}») cambió después de aplicarse. Las migraciones publicadas no se editan: crea una nueva.`,
      )
  }
  const hechas: number[] = []
  for (const m of migraciones) {
    const aplicada = await sql.transaccion(async (tx) => {
      // Se bloquea el registro: dos procesos a la vez no aplican la misma migración.
      await tx.query('LOCK TABLE migrations IN EXCLUSIVE MODE')
      const [fila] = await tx.query<{ v: number | null }>(
        'SELECT max(version) AS v FROM migrations',
      )
      if ((fila?.v ?? 0) >= m.version) return false
      await tx.execute(m.sql)
      await tx.query('INSERT INTO migrations (version, name, fingerprint) VALUES ($1, $2, $3)', [
        m.version,
        m.name,
        huellaSql(m.sql),
      ])
      return true
    })
    if (aplicada) hechas.push(m.version)
  }
  return hechas
}
