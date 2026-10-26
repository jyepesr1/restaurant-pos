// Tarea 1.3b (ADR-013): quien entra a la caja lo hace con usuario y contraseña. Los dos viven
// junto al PIN, en la credencial que solo existe en el hub y nunca se sincroniza. La contraseña
// se guarda como huella lenta con sal (scrypt), nunca en claro. Sin usuario, la persona entra con
// su PIN (meseros); con usuario, su PIN solo sirve para autorizar. El nombre de usuario se guarda
// ya normalizado (minúsculas) y es único entre los vigentes de cada restaurante.

export const sql = `
ALTER TABLE user_credentials ADD COLUMN username TEXT
  CHECK (username IS NULL OR (length(username) BETWEEN 3 AND 40
    AND username = lower(username)));
ALTER TABLE user_credentials ADD COLUMN password_hash TEXT;
ALTER TABLE user_credentials ADD COLUMN password_changed_at TEXT;
CREATE UNIQUE INDEX username_unique_among_current
  ON user_credentials (restaurant_id, username)
  WHERE current = 1 AND username IS NOT NULL;
-- Usuario y contraseña van juntos: uno sin el otro no deja entrar a nadie.
CREATE TRIGGER users_with_password_insert BEFORE INSERT ON user_credentials
WHEN (NEW.username IS NULL) <> (NEW.password_hash IS NULL)
BEGIN SELECT RAISE(ABORT, 'usuario_credencial: usuario y contraseña van juntos'); END;
CREATE TRIGGER users_with_password_update BEFORE UPDATE ON user_credentials
WHEN (NEW.username IS NULL) <> (NEW.password_hash IS NULL)
BEGIN SELECT RAISE(ABORT, 'usuario_credencial: usuario y contraseña van juntos'); END;
`
