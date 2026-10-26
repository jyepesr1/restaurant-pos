import type { FastifyInstance } from 'fastify'
import { crearServidor } from '../servidor'
import { type MontajeAcceso, montarAcceso } from './montaje'

// Utilidades de prueba: el montaje de acceso con el servidor Fastify encima, para probar la API
// (`/api/entrar`, `/api/personal/*`) con IP, token y cuerpo a voluntad. Solo para pruebas.

export interface Respuesta {
  statusCode: number
  headers: Record<string, unknown>
  // biome-ignore lint/suspicious/noExplicitAny: respuesta JSON de prueba, sin tipo
  json: () => any
  body: string
}

export type Sesion = { session_id: string; secret: string }

export interface Api extends MontajeAcceso {
  app: FastifyInstance
  cambiosCatalogo: number[]
  post: (url: string, cuerpo: unknown, options?: OpcionesPost) => Promise<Respuesta>
  /** Entra con usuario y contraseña y devuelve lo necesario para llamar a la API de personal. */
  signInAdmin: (
    quien?: 'admin' | 'cashier',
    // biome-ignore lint/suspicious/noExplicitAny: respuesta JSON de prueba, sin tipo
  ) => Promise<{ token: string; session: Sesion; cuerpo: any }>
  /** Cuerpo de `/api/personal/*` con la sesión incluida. */
  conSesion: (s: Sesion, extra: object) => object
  /** Usuario y contraseña del administrador de fábrica. */
  admin: () => { user: string; password: string }
}

export interface OpcionesPost {
  token?: string
  ip?: string
  cabeceras?: Record<string, string>
}

export function montarApi(m: MontajeAcceso = montarAcceso()): Api {
  const cambiosCatalogo: number[] = []
  const app = crearServidor({
    access: m.access,
    catalog: {
      db: m.db,
      restauranteId: m.restauranteId,
      access: m.access,
      clock: m.clock,
      onChange: (v) => cambiosCatalogo.push(v),
    },
  })
  const post: Api['post'] = (url, cuerpo, { token, ip = '10.0.0.20', cabeceras = {} } = {}) =>
    app.inject({
      method: 'POST',
      url,
      payload: cuerpo as object,
      remoteAddress: ip,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...cabeceras },
    }) as unknown as Promise<Respuesta>
  const signInAdmin: Api['signInAdmin'] = async (quien = 'admin') => {
    const p = m.people[quien]
    const r = await post('/api/sign-in', { user: p.user, password: p.password })
    if (r.statusCode !== 201) throw new Error(`No entró: ${r.body}`)
    const cuerpo = r.json()
    return {
      token: cuerpo.device.token,
      session: { session_id: cuerpo.session_id, secret: cuerpo.secret },
      cuerpo,
    }
  }
  return {
    ...m,
    app,
    cambiosCatalogo,
    post,
    signInAdmin,
    conSesion: (s, extra) => ({ ...s, ...extra }),
    admin: () => ({
      user: m.people.admin.user as string,
      password: m.people.admin.password as string,
    }),
  }
}
