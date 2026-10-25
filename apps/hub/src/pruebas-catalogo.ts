import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { montarAcceso } from './acceso/montaje'
import { leerCatalogo } from './catalogo'
import { leerCarta } from './seed/carta'
import { sembrar } from './seed/sembrar'
import { crearServidor } from './servidor'

// Montaje de las pruebas del catálogo: un hub con la carta real del piloto sembrada, el servidor
// HTTP con la edición y una caja emparejada. Solo para pruebas.

export const CARTA = leerCarta(
  readFileSync(
    fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
    'utf8',
  ),
)

export function montarCarta() {
  const m = montarAcceso()
  sembrar(
    m.db,
    m.acceso,
    { restauranteId: m.restauranteId, roles: m.roles, carta: CARTA, sinPersonal: true },
    m.reloj(),
  )
  const catalogo = () => leerCatalogo(m.db, m.restauranteId)
  const productos = () => catalogo().categorias.flatMap((c) => c.productos)
  const producto = (nombre: string) => {
    const p = productos().find((x) => x.nombre === nombre)
    if (!p) throw new Error(`No está ${nombre}`)
    return p
  }
  return { ...m, catalogo, productos, producto }
}

export async function montarServidor() {
  const m = montarCarta()
  const avisos: number[] = []
  const app = crearServidor({
    acceso: m.acceso,
    catalogo: {
      db: m.db,
      restauranteId: m.restauranteId,
      acceso: m.acceso,
      alCambiar: (v) => avisos.push(v),
      reloj: m.reloj,
    },
  })
  await app.ready()
  const caja = m.emparejar('caja')
  type Sesion = { sesion_id: string; secreto: string }
  const sesionDe = (quien: keyof typeof m.personas, conexion = caja.conexion): Sesion => {
    const s = m.entrar(conexion, quien)
    return { sesion_id: s.sesionId, secreto: s.secreto }
  }
  const enviar = async (sesion: Sesion, cambios: unknown, token = caja.token, extra = {}) => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/catalogo/cambios',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...sesion, cambios, ...extra },
    })
    return { codigo: r.statusCode, cuerpo: r.json() }
  }
  const editar = (sesion: Sesion, cambios: unknown[]) => enviar(sesion, cambios)
  const edicion = async (token = caja.token) =>
    app.inject({
      method: 'GET',
      url: '/api/catalogo/edicion',
      headers: { authorization: `Bearer ${token}` },
    })
  const impuestoId = String(m.db.prepare('SELECT id FROM impuesto LIMIT 1').get()?.id)
  const categoriaId = m.catalogo().categorias[0]?.id as string
  const historial = () => m.db.prepare('SELECT * FROM catalogo_cambio ORDER BY version').all()
  return {
    ...m,
    app,
    avisos,
    caja,
    sesionDe,
    editar,
    enviar,
    edicion,
    impuestoId,
    categoriaId,
    historial,
  }
}

export type MontajeServidor = Awaited<ReturnType<typeof montarServidor>>
