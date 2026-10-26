import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { abrirBase } from '@pos/db/node'
import { secreto } from './consola'

// `pnpm --filter @pos/nube admin <orden>`: lo que hace el administrador de Faro en la nube
// (tarea 1.10). Lee el restaurante de la base del hub de este equipo (con el hub cerrado) para
// que en la nube quede con el mismo id.
//
//   restaurante      crea en la nube el restaurante de este hub
//   codigo           da un código para registrar el PC de caja (sirve una vez, 24 horas)
//   revocar <hub>    anula la credencial de un PC de caja
//
// Necesita NUBE_URL (la dirección del Worker) y el token de administración (lo pide sin mostrarlo).

const [orden, argumento] = process.argv.slice(2)
const nube = process.env.NUBE_URL?.replace(/\/$/, '')
if (!nube || !['restaurante', 'codigo', 'revocar'].includes(orden ?? '')) {
  console.error(
    'Uso: NUBE_URL=https://faro-api.<tu-cuenta>.workers.dev pnpm --filter @pos/nube admin restaurante | codigo | revocar <hub_id>',
  )
  process.exit(1)
}

/** El restaurante de la base del hub de este equipo. */
function restauranteLocal(): { id: string; nombre: string } {
  const dir = process.env.DIR_DATOS || fileURLToPath(new URL('../../hub/datos', import.meta.url))
  const db = abrirBase(join(dir, 'pos.sqlite'))
  try {
    const fila = db.prepare('SELECT id, nombre FROM restaurante LIMIT 1').get()
    if (!fila)
      throw new Error(`La base del hub en ${dir} no tiene restaurante. Corre primero pnpm seed.`)
    return { id: String(fila.id), nombre: String(fila.nombre) }
  } finally {
    db.close()
  }
}

const token = await secreto('TOKEN_ADMIN', 'Token de administración de la nube: ')
const pedir = async (ruta: string, cuerpo: object) => {
  const r = await fetch(`${nube}${ruta}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(cuerpo),
  })
  const datos = r.status === 204 ? null : await r.json().catch(() => null)
  if (!r.ok) {
    console.error(`La nube respondió ${r.status}: ${datos?.mensaje ?? 'sin detalle'}`)
    process.exit(1)
  }
  return datos
}

if (orden === 'restaurante') {
  const rest = restauranteLocal()
  const r = await pedir('/v1/admin/restaurantes', rest)
  console.log(
    r.estado === 'creado'
      ? `Listo: «${rest.nombre}» quedó creado en la nube (id ${rest.id}).`
      : `«${rest.nombre}» ya estaba en la nube (id ${rest.id}). No se cambió nada.`,
  )
} else if (orden === 'codigo') {
  const rest = restauranteLocal()
  const r = await pedir('/v1/admin/codigos', { restaurante_id: rest.id })
  const vence = new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'America/Bogota',
  }).format(new Date(r.vence_en))
  console.log(`Código para registrar el PC de caja de «${rest.nombre}»: ${r.codigo}`)
  console.log(`Sirve una sola vez y vence el ${vence}.`)
} else {
  if (!argumento) {
    console.error('Falta el id del hub: pnpm --filter @pos/nube admin revocar <hub_id>')
    process.exit(1)
  }
  await pedir('/v1/admin/hubs/revocar', { hub_id: argumento })
  console.log(`Listo: el hub ${argumento} ya no puede subir nada a la nube.`)
}
