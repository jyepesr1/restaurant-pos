import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '@pos/db/node'
import { secret } from './console'

// `pnpm --filter @pos/cloud admin <command>`: what the Faro admin does in the cloud (task 1.10).
// Reads the restaurant from this machine's hub database (with the hub stopped) so it gets the
// same id in the cloud.
//
//   restaurant       creates this hub's restaurant in the cloud
//   code             gives a code to register the register PC (single use, 24 hours)
//   revoke <hub>     voids a register PC's credential
//
// Needs CLOUD_URL (the Worker's address) and the admin token (asks for it without showing it).

const [command, argument] = process.argv.slice(2)
const cloud = process.env.CLOUD_URL?.replace(/\/$/, '')
if (!cloud || !['restaurant', 'code', 'revoke'].includes(command ?? '')) {
  console.error(
    'Uso: CLOUD_URL=https://faro-api.<tu-cuenta>.workers.dev pnpm --filter @pos/cloud admin restaurant | code | revoke <hub_id>',
  )
  process.exit(1)
}

/** The restaurant in this machine's hub database. */
function localRestaurant(): { id: string; name: string } {
  const dir = process.env.DATA_DIR || fileURLToPath(new URL('../../hub/data', import.meta.url))
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
const request = async (route: string, body: object) => {
  const r = await fetch(`${cloud}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const data = r.status === 204 ? null : await r.json().catch(() => null)
  if (!r.ok) {
    console.error(`La nube respondió ${r.status}: ${data?.message ?? 'sin detalle'}`)
    process.exit(1)
  }
  return data
}

if (command === 'restaurant') {
  const rest = localRestaurant()
  const r = await request('/v1/admin/restaurants', rest)
  console.log(
    r.status === 'created'
      ? `Listo: «${rest.name}» quedó creado en la nube (id ${rest.id}).`
      : `«${rest.name}» ya estaba en la nube (id ${rest.id}). No se cambió nada.`,
  )
} else if (command === 'code') {
  const rest = localRestaurant()
  const r = await request('/v1/admin/codes', { restaurant_id: rest.id })
  const expiry = new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'America/Bogota',
  }).format(new Date(r.expires_at))
  console.log(`Código para registrar el PC de caja de «${rest.name}»: ${r.code}`)
  console.log(`Sirve una sola vez y vence el ${expiry}.`)
} else {
  if (!argument) {
    console.error('Falta el id del hub: pnpm --filter @pos/cloud admin revoke <hub_id>')
    process.exit(1)
  }
  await request('/v1/admin/hubs/revoke', { hub_id: argument })
  console.log(`Listo: el hub ${argument} ya no puede subir nada a la nube.`)
}
