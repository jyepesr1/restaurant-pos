import { Client } from 'pg'
import { secreto } from './consola'
import { MIGRACIONES_NUBE, migrar } from './migraciones'
import { sqlDePg } from './pg'

// `pnpm --filter @pos/nube migrar`: crea o pone al día las tablas de la base de Neon. Se corre
// desde el equipo del dueño con la cadena de conexión del rol que crea tablas (no la de la API).
// Pide la cadena sin mostrarla; también la toma de DATABASE_URL.

const cadena = await secreto(
  'DATABASE_URL',
  'Pega la cadena de conexión de Neon (rol dueño, sin pooler) y presiona Enter: ',
)
const cliente = new Client({ connectionString: cadena })
try {
  await cliente.connect()
  const hechas = await migrar(sqlDePg(cliente))
  const ultima = MIGRACIONES_NUBE.at(-1)?.version ?? 0
  console.log(
    hechas.length > 0
      ? `Listo: se aplicaron las migraciones ${hechas.join(', ')}. La base está en la versión ${ultima}.`
      : `La base ya estaba al día (versión ${ultima}). No se cambió nada.`,
  )
} catch (e) {
  console.error('No se pudo migrar la base:', e instanceof Error ? e.message : e)
  process.exitCode = 1
} finally {
  await cliente.end().catch(() => {})
}
