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

export type Sesion = { sesion_id: string; secreto: string }

export interface Api extends MontajeAcceso {
  app: FastifyInstance
  cambiosCatalogo: number[]
  post: (url: string, cuerpo: unknown, opciones?: OpcionesPost) => Promise<Respuesta>
  /** Entra con usuario y contraseña y devuelve lo necesario para llamar a la API de personal. */
  entrarAdmin: (
    quien?: 'admin' | 'cajero',
    // biome-ignore lint/suspicious/noExplicitAny: respuesta JSON de prueba, sin tipo
  ) => Promise<{ token: string; sesion: Sesion; cuerpo: any }>
  /** Cuerpo de `/api/personal/*` con la sesión incluida. */
  conSesion: (s: Sesion, extra: object) => object
  /** Usuario y contraseña del administrador de fábrica. */
  admin: () => { usuario: string; contrasena: string }
}

export interface OpcionesPost {
  token?: string
  ip?: string
  cabeceras?: Record<string, string>
}

export function montarApi(m: MontajeAcceso = montarAcceso()): Api {
  const cambiosCatalogo: number[] = []
  const app = crearServidor({
    acceso: m.acceso,
    catalogo: {
      db: m.db,
      restauranteId: m.restauranteId,
      acceso: m.acceso,
      reloj: m.reloj,
      alCambiar: (v) => cambiosCatalogo.push(v),
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
  const entrarAdmin: Api['entrarAdmin'] = async (quien = 'admin') => {
    const p = m.personas[quien]
    const r = await post('/api/entrar', { usuario: p.usuario, contrasena: p.contrasena })
    if (r.statusCode !== 201) throw new Error(`No entró: ${r.body}`)
    const cuerpo = r.json()
    return {
      token: cuerpo.equipo.token,
      sesion: { sesion_id: cuerpo.sesion_id, secreto: cuerpo.secreto },
      cuerpo,
    }
  }
  return {
    ...m,
    app,
    cambiosCatalogo,
    post,
    entrarAdmin,
    conSesion: (s, extra) => ({ ...s, ...extra }),
    admin: () => ({
      usuario: m.personas.admin.usuario as string,
      contrasena: m.personas.admin.contrasena as string,
    }),
  }
}
