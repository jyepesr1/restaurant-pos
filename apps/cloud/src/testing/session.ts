import { newId } from '@pos/core'
import { fingerprint } from '@pos/sync'
import { type ApiEnv, handle } from '../api'
import { cookieFrom, panelRequest, type RemoteUser, remoteUser, slugOf } from './panel'
import type { TestHub, World } from './world'

// Signing in to the panel in the tests: publishes the people who may enter (as the hub does with
// its `remote_users` snapshot) and signs one of them in.

export const PASSWORD = 'clave-de-prueba-1'

/** A new person with those permissions; `publish` uploads the whole list as the hub would. */
export function person(permissions: string[], name = 'Persona') {
  return remoteUser(`u${newId().slice(-8).toLowerCase()}`, PASSWORD, permissions, name)
}

export async function publish(
  m: World,
  h: TestHub,
  people: readonly RemoteUser[],
  environment: Partial<ApiEnv> = {},
) {
  const r = await handle(
    new Request('https://cloud.faro.test/v1/snapshots/remote_users', {
      method: 'PUT',
      headers: { authorization: `Bearer ${h.credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprint: fingerprint(people), content: people }),
    }),
    { sql: m.sql, clock: () => m.clock.now, ...environment },
  )
  if (r.status !== 204) throw new Error(`remote_users snapshot refused: ${r.status}`)
}

/** Signs `user` in (it must be among the published people); returns the cookie value. */
export async function signInAs(m: World, h: TestHub, user: RemoteUser): Promise<string> {
  const r = await panelRequest(m, 'POST', '/v1/panel/sign-in', {
    body: {
      restaurant: await slugOf(m, h.restaurantId),
      username: user.username,
      password: PASSWORD,
    },
  })
  if (r.status !== 200) throw new Error(`sign-in refused: ${r.status}`)
  return cookieFrom(r) as string
}
