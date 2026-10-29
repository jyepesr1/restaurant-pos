import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AccessService } from '../access/service'
import { deviceGuards } from '../printing/routes'
import type { CloudConnection } from './connection'

// Connecting the register PC to the cloud from the register (task 1.11). Only the admin (with
// `manage_devices`, the same as the register's settings) types the code. The upload's status
// travels to the devices over the WebSocket (`cloud` message); here it is also given over HTTP
// for the settings screen when it opens.

export interface CloudRouteOptions {
  access: AccessService
  cloud: CloudConnection
}

const Session = {
  session_id: z.string().length(26),
  secret: z.string().min(1).max(100),
}
const Registration = z.strictObject({ ...Session, code: z.string().min(1).max(40) })
const Read = z.strictObject(Session)

export async function cloudRoutes(app: FastifyInstance, { access, cloud }: CloudRouteOptions) {
  const { withDevice, invalidData, who } = deviceGuards(access)

  app.post('/api/cloud/status', withDevice, async (req, reply) => {
    const data = Read.safeParse(req.body)
    if (!data.success) return invalidData(reply)
    if (!who(req, reply, data.data, ['manage_devices'])) return
    return cloud.status()
  })

  app.post('/api/cloud/register', withDevice, async (req, reply) => {
    const data = Registration.safeParse(req.body)
    if (!data.success) return invalidData(reply, 'Escribe el código que te dio Faro')
    if (!who(req, reply, data.data, ['manage_devices'])) return
    const r = await cloud.register(data.data.code)
    if (r.ok) return cloud.status()
    const status =
      r.code === 'already_connected'
        ? 409
        : r.code === 'invalid_code' || r.code === 'other_restaurant'
          ? 400
          : 503
    return reply.code(status).send({ error: r.code, message: r.message })
  })
}
