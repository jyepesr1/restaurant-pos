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

// The owner's panel (task 1.11c-1, docs/PANEL.md): restaurant slug, hub heartbeat, the orders each
// event touches, the hub's read-only snapshots, the people who can sign in to the panel, panel
// sessions and sign-in attempts.
const panel = `
-- The short name the panel asks for at sign-in (\`la-spritzzeria\`). The existing restaurants get
-- one from their name, without accents, in lowercase with dashes; a repeated one carries the end
-- of its id. The API always gives one (createRestaurant); without it a restaurant has no panel.
ALTER TABLE restaurants ADD COLUMN slug text;
WITH base AS (
  SELECT id, created_at,
    coalesce(nullif(trim(both '-' from left(regexp_replace(lower(translate(name,
      'ÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇáàäâãéèëêíìïîóòöôõúùüûñç',
      'AAAAAEEEEIIIIOOOOOUUUUNCaaaaaeeeeiiiiooooouuuunc')), '[^a-z0-9]+', '-', 'g'), 50)), ''),
      'restaurante') AS slug
  FROM restaurants
), numbered AS (
  SELECT id, slug, row_number() OVER (PARTITION BY slug ORDER BY created_at, id) AS n FROM base
)
UPDATE restaurants r
SET slug = CASE WHEN n.n = 1 THEN n.slug ELSE n.slug || '-' || lower(right(r.id, 6)) END
FROM numbered n WHERE n.id = r.id;
ALTER TABLE restaurants ADD CONSTRAINT restaurants_slug_key UNIQUE (slug);
ALTER TABLE restaurants ADD CONSTRAINT restaurants_slug_format
  CHECK (length(slug) <= 60 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- Heartbeat: when the hub last called, and up to which sequence it has (what is missing in the
-- cloud is hub_max_sequence minus contiguous_sequence).
ALTER TABLE hubs ADD COLUMN last_seen_at timestamptz;
ALTER TABLE hubs ADD COLUMN hub_max_sequence bigint CHECK (hub_max_sequence >= 0);
CREATE INDEX hubs_by_location ON hubs (restaurant_id, location_id);

-- The orders (aggregates) each event touches, as in the hub: moving items or merging tables
-- touches several (\`ordersOf()\` of @pos/sync). Reports read an order's events from here.
CREATE TABLE event_aggregates (
  restaurant_id text NOT NULL,
  event_id text NOT NULL,
  aggregate_id text NOT NULL,
  hub_id text NOT NULL REFERENCES hubs (id),
  hub_sequence bigint NOT NULL CHECK (hub_sequence >= 1),
  PRIMARY KEY (restaurant_id, aggregate_id, event_id),
  FOREIGN KEY (restaurant_id, event_id) REFERENCES events (restaurant_id, id)
);
CREATE TRIGGER event_aggregates_append_only BEFORE UPDATE OR DELETE ON event_aggregates
  FOR EACH ROW EXECUTE FUNCTION append_only();
-- The events already stored carry their full content: aggregate_id, related and affects.
INSERT INTO event_aggregates (restaurant_id, event_id, aggregate_id, hub_id, hub_sequence)
SELECT e.restaurant_id, e.id, a.aggregate_id, e.hub_id, e.hub_sequence
FROM events e
CROSS JOIN LATERAL (
  SELECT e.aggregate_id
  UNION
  SELECT x #>> '{}' FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(e.content -> 'related') = 'array' THEN e.content -> 'related' ELSE '[]' END
  ) x WHERE jsonb_typeof(x) = 'string'
  UNION
  SELECT x #>> '{}' FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(e.content -> 'affects') = 'array' THEN e.content -> 'affects' ELSE '[]' END
  ) x WHERE jsonb_typeof(x) = 'string'
) a (aggregate_id)
WHERE a.aggregate_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'
ON CONFLICT DO NOTHING;

-- A register shift's charges (payments, voids and refunds), as the hub looks them up.
CREATE INDEX events_by_shift ON events (restaurant_id, (content #>> '{data,register_shift_id}'))
  WHERE type IN ('PaymentRecorded', 'PaymentVoided', 'RefundRecorded');

-- The last read-only snapshot of each thing that still lives in the hub (catalog, config,
-- people, roles), per restaurant and location.
CREATE TABLE snapshots (
  restaurant_id text NOT NULL REFERENCES restaurants (id),
  location_id text NOT NULL CHECK (length(location_id) = 26),
  kind text NOT NULL CHECK (kind IN ('catalog', 'config', 'people', 'roles', 'remote_users')),
  fingerprint text NOT NULL,
  content jsonb NOT NULL,
  hub_id text NOT NULL REFERENCES hubs (id),
  uploaded_at timestamptz NOT NULL,
  PRIMARY KEY (restaurant_id, location_id, kind)
);

-- Who can sign in to the panel (ADR-013, amendment of 29-oct-2026): active people with a username
-- and password whose role has remote_access. Replaced whole with each snapshot.
CREATE TABLE remote_users (
  restaurant_id text NOT NULL REFERENCES restaurants (id),
  location_id text NOT NULL CHECK (length(location_id) = 26),
  user_id text NOT NULL CHECK (length(user_id) = 26),
  username text NOT NULL,
  name text NOT NULL,
  verifier text NOT NULL,
  permissions text[] NOT NULL,
  PRIMARY KEY (restaurant_id, location_id, user_id),
  UNIQUE (restaurant_id, location_id, username)
);

-- A panel session: the cookie carries id.secret; only the secret's SHA-256 is stored, and the
-- fingerprint of the verifier it signed in with (another password ends the session).
CREATE TABLE panel_sessions (
  id text PRIMARY KEY CHECK (length(id) = 26),
  restaurant_id text NOT NULL REFERENCES restaurants (id),
  user_id text NOT NULL,
  secret_hash text NOT NULL,
  verifier_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX panel_sessions_by_user ON panel_sessions (restaurant_id, user_id);

-- Failed panel sign-ins, per user and per IP: a wait that grows with each failure.
CREATE TABLE panel_attempts (
  restaurant_id text NOT NULL REFERENCES restaurants (id),
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  failures integer NOT NULL CHECK (failures >= 0),
  last_failure_at timestamptz NOT NULL,
  blocked_until timestamptz NOT NULL,
  PRIMARY KEY (restaurant_id, key)
);

-- The cookie only brings the session id: this says which restaurant it is from (and nothing
-- else), so the rest is read under that restaurant's row-level security.
CREATE FUNCTION panel_session_restaurant(session_id text) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT restaurant_id FROM panel_sessions WHERE id = session_id $$;
REVOKE ALL ON FUNCTION panel_session_restaurant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION panel_session_restaurant(text) TO faro_data;

-- A hub's credential fingerprint is not read by the API role: the credential is checked through
-- this function, which returns only the active hub that owns it.
REVOKE SELECT ON hubs FROM faro_data;
GRANT SELECT (id, restaurant_id, location_id, name, instance, created_at, revoked_at,
              contiguous_sequence, last_seen_at, hub_max_sequence) ON hubs TO faro_data;
CREATE FUNCTION hub_by_credential(hash text)
  RETURNS TABLE (id text, restaurant_id text, location_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT h.id, h.restaurant_id, h.location_id FROM hubs h
        WHERE h.credential_hash = hash AND h.revoked_at IS NULL $$;
REVOKE ALL ON FUNCTION hub_by_credential(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_by_credential(text) TO faro_data;

GRANT UPDATE (last_seen_at, hub_max_sequence) ON hubs TO faro_data;
GRANT SELECT, INSERT ON event_aggregates TO faro_data;
GRANT SELECT, INSERT, UPDATE (fingerprint, content, hub_id, uploaded_at) ON snapshots TO faro_data;
GRANT SELECT, INSERT, DELETE ON remote_users TO faro_data;
GRANT SELECT, INSERT, UPDATE (last_used_at, revoked_at) ON panel_sessions TO faro_data;
-- Old attempts (more than a day without failures) are cleared when signing in.
GRANT SELECT, INSERT, DELETE, UPDATE (failures, last_failure_at, blocked_until) ON panel_attempts TO faro_data;

ALTER TABLE event_aggregates ENABLE ROW LEVEL SECURITY;
ALTER TABLE snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE remote_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE panel_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE panel_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY event_aggregates_of_restaurant ON event_aggregates TO faro_data
  USING (restaurant_id = current_setting('faro.restaurant_id', true))
  WITH CHECK (restaurant_id = current_setting('faro.restaurant_id', true));
CREATE POLICY snapshots_of_restaurant ON snapshots TO faro_data
  USING (restaurant_id = current_setting('faro.restaurant_id', true))
  WITH CHECK (restaurant_id = current_setting('faro.restaurant_id', true));
CREATE POLICY remote_users_of_restaurant ON remote_users TO faro_data
  USING (restaurant_id = current_setting('faro.restaurant_id', true))
  WITH CHECK (restaurant_id = current_setting('faro.restaurant_id', true));
CREATE POLICY panel_sessions_of_restaurant ON panel_sessions TO faro_data
  USING (restaurant_id = current_setting('faro.restaurant_id', true))
  WITH CHECK (restaurant_id = current_setting('faro.restaurant_id', true));
CREATE POLICY panel_attempts_of_restaurant ON panel_attempts TO faro_data
  USING (restaurant_id = current_setting('faro.restaurant_id', true))
  WITH CHECK (restaurant_id = current_setting('faro.restaurant_id', true));
`

export const CLOUD_MIGRATIONS: readonly CloudMigration[] = [
  { version: 1, name: 'initial', sql: initial },
  { version: 2, name: 'panel', sql: panel },
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
