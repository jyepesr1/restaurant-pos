// Tarea 1.3b (ADR-013): quien entra a la caja lo hace con usuario y contraseña. Los dos viven
// junto al PIN, en la credencial que solo existe en el hub y nunca se sincroniza. La contraseña
// se guarda como huella lenta con sal (scrypt), nunca en claro. Sin usuario, la persona entra con
// su PIN (meseros); con usuario, su PIN solo sirve para autorizar. El nombre de usuario se guarda
// ya normalizado (minúsculas) y es único entre los vigentes de cada restaurante.

export const sql = `
ALTER TABLE usuario_credencial ADD COLUMN nombre_usuario TEXT
  CHECK (nombre_usuario IS NULL OR (length(nombre_usuario) BETWEEN 3 AND 40
    AND nombre_usuario = lower(nombre_usuario)));
ALTER TABLE usuario_credencial ADD COLUMN contrasena_huella TEXT;
ALTER TABLE usuario_credencial ADD COLUMN contrasena_cambiada_en TEXT;
CREATE UNIQUE INDEX usuario_unico_entre_vigentes
  ON usuario_credencial (restaurante_id, nombre_usuario)
  WHERE vigente = 1 AND nombre_usuario IS NOT NULL;
-- Usuario y contraseña van juntos: uno sin el otro no deja entrar a nadie.
CREATE TRIGGER usuario_con_contrasena_insert BEFORE INSERT ON usuario_credencial
WHEN (NEW.nombre_usuario IS NULL) <> (NEW.contrasena_huella IS NULL)
BEGIN SELECT RAISE(ABORT, 'usuario_credencial: usuario y contraseña van juntos'); END;
CREATE TRIGGER usuario_con_contrasena_update BEFORE UPDATE ON usuario_credencial
WHEN (NEW.nombre_usuario IS NULL) <> (NEW.contrasena_huella IS NULL)
BEGIN SELECT RAISE(ABORT, 'usuario_credencial: usuario y contraseña van juntos'); END;
`
