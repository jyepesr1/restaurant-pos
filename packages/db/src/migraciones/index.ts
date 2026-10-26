import { sql as initial } from './0001_inicial'
import { sql as comprobanteAtado } from './0002_comprobante_atado'
import { sql as catalogoCambio } from './0003_catalogo_cambio'
import { sql as elementoPlano } from './0004_elemento_plano'
import { sql as usuarioContrasena } from './0005_usuario_contrasena'
import { sql as tickets } from './0006_comandas'
import { sql as checkout } from './0007_cobro'
import { sql as report } from './0008_informe'

export interface Migracion {
  version: number
  name: string
  sql: string
  /** Para migraciones que reconstruyen tablas: se apagan las claves foráneas mientras corren. */
  sinClavesForaneas?: boolean
}

// Las migraciones son código TypeScript con el SQL en texto (no archivos .sql) para que
// también funcionen donde no hay sistema de archivos, como la nube. Nunca se edita una
// migración ya publicada: los cambios van en una nueva (el runner lo comprueba por su huella).
export const MIGRACIONES: readonly Migracion[] = [
  { version: 1, name: 'initial', sql: initial },
  { version: 2, name: 'bound_approval', sql: comprobanteAtado },
  { version: 3, name: 'catalog_changes', sql: catalogoCambio },
  { version: 4, name: 'floor_plan_elements', sql: elementoPlano },
  { version: 5, name: 'user_password', sql: usuarioContrasena },
  { version: 6, name: 'tickets', sql: tickets },
  { version: 7, name: 'checkout', sql: checkout, sinClavesForaneas: true },
  { version: 8, name: 'report', sql: report, sinClavesForaneas: true },
]
