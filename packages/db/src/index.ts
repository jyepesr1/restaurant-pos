export {
  COLUMNAS_COMUNES,
  TABLAS_INMUTABLES,
  TABLAS_LOCALES,
  TABLAS_PROYECCION,
  TABLAS_VERSIONADAS,
} from './esquema'
export { MIGRACIONES, type Migracion } from './migraciones'
export { aplicarMigraciones, versionActual } from './migrar'
export { type BaseSqlite, enTransaccion, type Fila, type Sentencia, type ValorSql } from './sqlite'
