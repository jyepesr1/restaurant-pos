import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '@pos/db/node'
import { secret } from './console'

// `pnpm --filter @pos/cloud admin <command>`: what the Faro admin does in the cloud (task 1.10).
// Reads the restaurant from this machine's hub database (with the hub stopped) so it gets the
// same id in the cloud.
//
//   restaurant [slug] creates this hub's restaurant in the cloud, with the short name the panel
//                     asks for (by default from its name: `La Spritzzería` → `la-spritzzeria`)
//   code             gives a code to register the register PC (single use, 24 hours)
//   revoke <hub>     voids a register PC's credential
//
// Needs CLOUD_URL (the Worker's address) and the admin token (asks for it without showing it).

const [command, argument] = process.argv.slice(2)
const cloud = process.env.CLOUD_URL?.replace(/\/$/, '')
if (!cloud || !['restaurant', 'code', 'revoke'].includes(command ?? '')) {
  console.error(
    'Usage: CLOUD_URL=https://faro-api.<your-account>.workers.dev pnpm --filter @pos/cloud admin restaurant [slug] | code | revoke <hub_id>',
  )
  process.exit(1)
}

/** The restaurant in this machine's hub database. */
function localRestaurant(): { id: string; name: string } {
  const dir = process.env.DATA_DIR || fileURLToPath(new URL('../../hub/data', import.meta.url))
  const db = openDatabase(join(dir, 'pos.sqlite'))
  try {
    const row = db.prepare('SELECT id, name FROM restaurants LIMIT 1').get()
    if (!row) throw new Error(`The hub database in ${dir} has no restaurant. Run pnpm seed first.`)
    return { id: String(row.id), name: String(row.name) }
  } finally {
    db.close()
  }
}

const token = await secret('TOKEN_ADMIN', 'Cloud admin token: ')
const request = async (route: string, body: object) => {
  const r = await fetch(`${cloud}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const data = r.status === 204 ? null : await r.json().catch(() => null)
  if (!r.ok) {
    console.error(`The cloud responded with ${r.status}: ${data?.message ?? 'no detail'}`)
    process.exit(1)
  }
  return data
}

if (command === 'restaurant') {
  const rest = localRestaurant()
  const r = await request('/v1/admin/restaurants', {
    ...rest,
    ...(argument ? { slug: argument.trim().toLowerCase() } : {}),
  })
  console.log(
    r.status === 'created'
      ? `Done: "${rest.name}" was created in the cloud (id ${rest.id}).`
      : `"${rest.name}" was already in the cloud (id ${rest.id}). Nothing was changed.`,
  )
  console.log(
    r.slug
      ? `Slug to sign in to the panel: ${r.slug}`
      : 'This restaurant has no slug for the panel yet.',
  )
} else if (command === 'code') {
  const rest = localRestaurant()
  const r = await request('/v1/admin/codes', { restaurant_id: rest.id })
  const expiry = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'America/Bogota',
  }).format(new Date(r.expires_at))
  console.log(`Code to register the cash register PC for "${rest.name}": ${r.code}`)
  console.log(`It can be used only once and expires on ${expiry}.`)
} else {
  if (!argument) {
    console.error('Missing the hub id: pnpm --filter @pos/cloud admin revoke <hub_id>')
    process.exit(1)
  }
  await request('/v1/admin/hubs/revoke', { hub_id: argument })
  console.log(`Done: hub ${argument} can no longer upload anything to the cloud.`)
}
