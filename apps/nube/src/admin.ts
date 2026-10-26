import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '@pos/db/node'
import { secret } from './consola'

// `pnpm --filter @pos/nube admin <orden>`: lo que hace el administrador de Faro en la nube
// (tarea 1.10). Lee el restaurante de la base del hub de este equipo (con el hub cerrado) para
// que en la nube quede con el mismo id.
//
//   restaurante      crea en la nube el restaurante de este hub
//   codigo           da un código para registrar el PC de caja (sirve una vez, 24 horas)
//   revocar <hub>    anula la credencial de un PC de caja
//
// Necesita NUBE_URL (la dirección del Worker) y el token de administración (lo pide sin mostrarlo).

const [position, argumento] = process.argv.slice(2)
const nube = process.env.NUBE_URL?.replace(/\/$/, '')
if (!nube || !['restaurant', 'code', 'revoke'].includes(position ?? '')) {
  console.error(
    'Uso: NUBE_URL=https://faro-api.<tu-cuenta>.workers.dev pnpm --filter @pos/nube admin restaurante | codigo | revocar <hub_id>',
  )
  process.exit(1)
}

/** El restaurante de la base del hub de este equipo. */
function restauranteLocal(): { id: string; name: string } {
  const dir = process.env.DATA_DIR || fileURLToPath(new URL('../../hub/datos', import.meta.url))
  const db = openDatabase(join(dir, 'pos.sqlite'))
  try {
    const row = db.prepare('SELECT id, name FROM restaurants LIMIT 1').get()
    if (!row)
      throw new Error(`La base del hub en ${dir} no tiene restaurante. Corre primero pnpm seed.`)
    return { id: String(row.id), name: String(row.name) }
  } finally {
    db.close()
  }
}

const token = await secret('TOKEN_ADMIN', 'Token de administración de la nube: ')
const request = async (route: string, cuerpo: object) => {
  const r = await fetch(`${nube}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(cuerpo),
  })
  const data = r.status === 204 ? null : await r.json().catch(() => null)
  if (!r.ok) {
    console.error(`La nube respondió ${r.status}: ${data?.message ?? 'sin detalle'}`)
    process.exit(1)
  }
  return data
}

if (position === 'restaurant') {
  const rest = restauranteLocal()
  const r = await request('/v1/admin/restaurants', rest)
  console.log(
    r.status === 'created'
      ? `Listo: «${rest.name}» quedó creado en la nube (id ${rest.id}).`
      : `«${rest.name}» ya estaba en la nube (id ${rest.id}). No se cambió nada.`,
  )
} else if (position === 'code') {
  const rest = restauranteLocal()
  const r = await request('/v1/admin/codes', { restaurant_id: rest.id })
  const vence = new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'America/Bogota',
  }).format(new Date(r.expires_at))
  console.log(`Código para registrar el PC de caja de «${rest.name}»: ${r.code}`)
  console.log(`Sirve una sola vez y vence el ${vence}.`)
} else {
  if (!argumento) {
    console.error('Falta el id del hub: pnpm --filter @pos/nube admin revocar <hub_id>')
    process.exit(1)
  }
  await request('/v1/admin/hubs/revoke', { hub_id: argumento })
  console.log(`Listo: el hub ${argumento} ya no puede subir nada a la nube.`)
}
