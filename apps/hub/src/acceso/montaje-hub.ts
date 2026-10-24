import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { type EventoNuevo, huellaAutorizable, nuevoId } from '@pos/core'
import { aplicarMigraciones } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import { type Conexion, type ControlAcceso, HubSync } from '@pos/sync'
import { AlmacenSqlite } from '@pos/sync/sqlite'
import { expect } from 'vitest'
import { asegurarAdministrador, asegurarRestaurante, asegurarRoles } from './inicial'
import { Intentos } from './intentos'
import { firmado, INICIO, type MontajeAcceso, montarAcceso } from './montaje'
import { cargarClave } from './secretos'
import { ServicioAcceso } from './servicio'

// Utilidades de prueba: el hub de sincronización completo sobre el montaje de acceso, y un hub
// sobre una carpeta de datos real que se puede "apagar" y volver a levantar.

export const item = (
  modificadores: { modificador_id: string; nombre: string; precio_extra: number }[] = [],
) => ({
  item_id: nuevoId(),
  producto_id: nuevoId(),
  variante_id: null,
  nombre: 'Aperol Spritz',
  precio_unitario: 32_000,
  impuesto_tipo: 'inc' as const,
  tarifa: 800,
  cantidad: 1,
  comensal: null,
  curso: null,
  modificadores,
  notas: null,
  catalogo_version: 1,
  precio_canal_id: null,
})

export const ABRIR = { canal: 'salon', mesa_id: null, comensales: 2 }

/** El montaje de acceso con un `HubSync` sobre la misma base. */
export function montarHub(envolver: (a: ControlAcceso) => ControlAcceso = (a) => a) {
  const m = montarAcceso()
  const hub = new HubSync(new AlmacenSqlite(m.db, m.restauranteId), {
    restauranteId: m.restauranteId,
    zonaHoraria: 'America/Bogota',
    inicioDiaOperativo: '06:00',
    instancia: 'hub-1',
    reloj: m.reloj,
    acceso: envolver(m.acceso),
  })
  return { ...m, hub }
}
export type MontajeHub = ReturnType<typeof montarHub>

/** Un pedido abierto por el mesero con un ítem ya enviado a cocina. */
export function pedidoConItemEnviado(
  m: MontajeAcceso & { hub: HubSync },
  modificadores: { modificador_id: string; nombre: string; precio_extra: number }[] = [],
) {
  const { conexion, token } = m.emparejar('mesero')
  const sesion = m.entrar(conexion, 'mesero')
  const pedido = nuevoId()
  const it = item(modificadores)
  const comandaId = nuevoId()
  const en = { agregado_id: pedido }
  const r = m.hub.recibirLote(conexion, [
    m.evento(conexion, sesion, 'PedidoAbierto', ABRIR, en),
    m.evento(conexion, sesion, 'ItemAgregado', it, { ...en, secuencia_base: 1 }),
    m.evento(
      conexion,
      sesion,
      'ItemsEnviados',
      { comandas: [{ comanda_id: comandaId, estacion_id: nuevoId(), item_ids: [it.item_id] }] },
      { ...en, secuencia_base: 2 },
    ),
  ])
  expect(r.resultados.map((x) => x.estado)).toEqual(['confirmado', 'confirmado', 'confirmado'])
  return { conexion, token, sesion, pedido, itemId: it.item_id, comandaId }
}

export const datosAnular = (itemId: string) => ({
  item_id: itemId,
  cantidad: 1,
  ya_preparado: false,
  comanda_id: null,
})

type Sesion = Parameters<typeof firmado>[0]

/** El evento con la firma de esa sesión (como lo deja la app tras crearlo). */
export const firmar = firmado

/**
 * El supervisor autoriza ese evento exacto: devuelve el comprobante y el evento con su
 * `autorizacion_id`, ya firmado de nuevo.
 */
export function autorizarEvento(
  m: Pick<MontajeAcceso, 'acceso'>,
  conexion: Conexion,
  sesion: Sesion & { secreto: string; sesionId: string },
  pin: string,
  evento: EventoNuevo,
  accion = 'anular_item_enviado',
) {
  const a = m.acceso.autorizar(conexion, {
    sesionId: sesion.sesionId,
    secreto: sesion.secreto,
    pin,
    accion,
    agregadoId: evento.agregado_id,
    eventoId: evento.id,
    huella: huellaAutorizable(evento),
  })
  if (!a.ok) throw new Error(a.mensaje)
  return {
    comprobante: a,
    evento: firmar(sesion, { ...evento, autorizacion_id: a.autorizacionId }),
  }
}

export const sumar = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString()

/**
 * Un hub sobre una carpeta de datos real, como lo arma `main.ts`: base en archivo y clave de los
 * PIN en la misma carpeta. `levantar()` es "encender el proceso"; `apagar()`, una caída: la
 * memoria (códigos de emparejamiento, esperas por intentos) se pierde y la carpeta queda.
 */
export function hubEnCarpeta(dirDatos: string) {
  let ms = INICIO
  const reloj = () => new Date(ms).toISOString()
  let abiertas: { close(): void }[] = []
  // El reloj de la prueba es manual: la clave cuenta desde la hora (manual) en que se creó.
  let claveDesde = ''

  function levantar() {
    mkdirSync(dirDatos, { recursive: true })
    const db = abrirBase(join(dirDatos, 'pos.sqlite'))
    abiertas.push(db as unknown as { close(): void })
    aplicarMigraciones(db)
    const { clave, nueva } = cargarClave(dirDatos)
    if (nueva) claveDesde = reloj()
    const restauranteId = asegurarRestaurante(db, reloj())
    const roles = asegurarRoles(db, restauranteId, reloj())
    const acceso = new ServicioAcceso({
      db,
      restauranteId,
      clave,
      reloj,
      intentos: new Intentos(() => ms),
      claveDesde,
    })
    const admin = asegurarAdministrador(db, acceso, roles.admin, nueva)
    const hub = new HubSync(new AlmacenSqlite(db, restauranteId), {
      restauranteId,
      zonaHoraria: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      instancia: 'hub-1',
      reloj,
      acceso,
    })
    return { db, acceso, hub, roles, restauranteId, admin, claveNueva: nueva }
  }

  return {
    levantar,
    apagar() {
      for (const b of abiertas) b.close()
      abiertas = []
    },
    reloj,
    avanzar: (n: number) => {
      ms += n
    },
  }
}
