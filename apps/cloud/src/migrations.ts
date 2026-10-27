import type { Sql } from './sql'

// Cloud database migrations (Postgres on Neon, ADR-016). Same as in the hub (ADR-012):
// TypeScript code with the SQL as text, numbered, and one already applied is never edited
// (checked by its fingerprint). Applied with `pnpm --filter @pos/cloud migrate`, not from the
// Worker.

export interface CloudMigration {
  version: number
  name: string
  sql: string
}

const initial = `
-- Rows are only added: the database rejects updates and deletes (nothing is deleted, ADR-005).
CREATE FUNCTION append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%: solo se agregan filas, no se cambian ni se borran', TG_TABLE_NAME;
END $$;

CREATE TABLE restaurants (
  id text PRIMARY KEY CHECK (length(id) = 26),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A code to register a hub: handed out when installing the register PC, expires and works once.
-- Only its fingerprint is stored.
CREATE TABLE registration_codes (
  fingerprint text PRIMARY KEY,
  restaurant_id text NOT NULL REFERENCES restaurants (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  hub_id text,
  CHECK ((used_at IS NULL) = (hub_id IS NULL))
);

-- A location's register PC. Its credential is stored only as a fingerprint; revoking voids it.
CREATE TABLE hubs (
  id text PRIMARY KEY CHECK (length(id) = 26),
  restaurant_id text NOT NULL REFERENCES restaurants (id),
  location_id text NOT NULL CHECK (length(location_id) = 26),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  instance text NOT NULL CHECK (length(instance) BETWEEN 1 AND 100),
  credential_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  -- Up to which hub sequence everything is in the cloud, with no gaps from 1.
  contiguous_sequence bigint NOT NULL DEFAULT 0 CHECK (contiguous_sequence >= 0)
);
CREATE INDEX hubs_by_restaurant ON hubs (restaurant_id);

-- The events of every restaurant, as each hub accepted them (ADR-005 and ADR-007). The key is
-- (restaurant_id, id): resending an event does not duplicate it. The sequence column is the order
-- of arrival in the cloud (not the commit order between concurrent transactions: to read "what is
-- new" use (hub_id, hub_sequence)); hub_sequence is the one its hub gave it.
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

-- An id that already existed arrived with different content: the stored one is not overwritten;
-- it is kept for review (ADR-007: conflicts are not discarded, a person resolves them).
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

-- What the API can do. The role it connects with (faro_api, created by hand in Neon with its
-- password) is granted this role; it never bypasses row-level security. Roles are server-wide:
-- if it already exists, it is not created again.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'faro_data') THEN
    CREATE ROLE faro_data NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
-- Whoever migrates can also switch to this role (the API does it in each restaurant transaction).
GRANT faro_data TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO faro_data;
GRANT SELECT, INSERT ON restaurants TO faro_data;
-- Only the columns the API changes: a bug cannot touch the rest.
GRANT SELECT, INSERT, UPDATE (used_at, hub_id) ON registration_codes TO faro_data;
GRANT SELECT, INSERT, UPDATE (credential_hash, revoked_at, contiguous_sequence) ON hubs TO faro_data;
GRANT SELECT, INSERT ON events, divergent_events TO faro_data;

-- Row-level security: a restaurant's events are only seen and written inside a transaction
-- that stated which restaurant it is for (set_config('faro.restaurant_id', …, true)).
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE divergent_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY events_of_restaurant ON events TO faro_data
  USING (restaurant_id = current_setting('faro.restaurant_id', true))
  WITH CHECK (restaurant_id = current_setting('faro.restaurant_id', true));
CREATE POLICY divergent_events_of_restaurant ON divergent_events TO faro_data
  USING (restaurant_id = current_setting('faro.restaurant_id', true))
  WITH CHECK (restaurant_id = current_setting('faro.restaurant_id', true));
`

export const CLOUD_MIGRATIONS: readonly CloudMigration[] = [
  { version: 1, name: 'initial', sql: initial },
]

/** 64-bit FNV-1a fingerprint of the SQL (the same idea as in `@pos/db`). */
export function sqlFingerprint(sql: string): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(sql)) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

const CREATE_REGISTRY = `
  CREATE TABLE IF NOT EXISTS migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    fingerprint text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`

/**
 * Applies the missing migrations, each in its own transaction. Fails if an applied one changed.
 * Returns the applied versions.
 */
export async function migrate(
  sql: Sql,
  migrations: readonly CloudMigration[] = CLOUD_MIGRATIONS,
): Promise<number[]> {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1)
      throw new Error(`Las migraciones van numeradas 1, 2, 3…: falla en «${m.name}»`)
  })
  await sql.query(CREATE_REGISTRY)
  const appliedMigrations = await sql.query<{ version: number; name: string; fingerprint: string }>(
    'SELECT version, name, fingerprint FROM migrations ORDER BY version',
  )
  for (const row of appliedMigrations) {
    const m = migrations[row.version - 1]
    if (m && sqlFingerprint(m.sql) !== row.fingerprint)
      throw new Error(
        `La migración ${row.version} («${row.name}») cambió después de aplicarse. Las migraciones publicadas no se editan: crea una nueva.`,
      )
  }
  const doneVersions: number[] = []
  for (const m of migrations) {
    const applied = await sql.transaction(async (tx) => {
      // The registry is locked: two concurrent processes do not apply the same migration.
      await tx.query('LOCK TABLE migrations IN EXCLUSIVE MODE')
      const [row] = await tx.query<{ v: number | null }>('SELECT max(version) AS v FROM migrations')
      if ((row?.v ?? 0) >= m.version) return false
      await tx.execute(m.sql)
      await tx.query('INSERT INTO migrations (version, name, fingerprint) VALUES ($1, $2, $3)', [
        m.version,
        m.name,
        sqlFingerprint(m.sql),
      ])
      return true
    })
    if (applied) doneVersions.push(m.version)
  }
  return doneVersions
}
