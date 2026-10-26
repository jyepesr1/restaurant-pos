import type { Catalog } from '@pos/sync'
import { useMemo, useState } from 'react'
import { useAhora } from '../ui/ahora'
import { Etiqueta, TONOS_SUAVES, type Tono } from '../ui/Etiqueta'
import { minutos, pesos } from '../ui/formato'
import { Icono, type NombreIcono } from '../ui/iconos'
import { Grupo, Opcion } from '../ui/Opciones'
import { navegar } from '../ui/ruta'
import { usePedidos, useSala } from './contexto'
import { FiguraElemento, Lienzo, placement, Sillas, useEscala } from './LienzoPlano'
import { MarcoSala } from './MarcoSala'
import { CANALES } from './pedido'
import { limites } from './plano'
import { type EstadoMesaDemo, estadoMesa, itemsVigentes, type PedidoVisible } from './proyeccion'

// Plano de mesas (brief §5, regla 1): la pantalla inicial del mesero. Cada zona o piso con sus
// mesas en su lugar real y sus sillas, y en cada mesa ocupada el estado, el tiempo, el total y
// quién la atiende. En el celular, o si se prefiere, la misma información en lista. Al lado (en
// la caja) o arriba (en el celular), los pedidos abiertos en tarjetas del color de su estado, y
// los botones para los pedidos sin mesa. Un toque en la mesa o la tarjeta lleva a su pedido.

const STATUSES: Record<EstadoMesaDemo, { tono: Tono; icono: NombreIcono; text: string }> = {
  free: { tono: 'free', icono: 'circle', text: 'Libre' },
  taking: { tono: 'progress', icono: 'pencil', text: 'Tomando pedido' },
  ready: { tono: 'free', icono: 'serve', text: 'Listo para llevar' },
  check: { tono: 'action', icono: 'receipt', text: 'Pidió la cuenta' },
  in_kitchen: { tono: 'progress', icono: 'fire', text: 'En preparación' },
  served: { tono: 'neutral', icono: 'check', text: 'Servida' },
}

/** Borde de la mesa y color de sus sillas, por el tono de su estado (clases completas). */
const BORDE: Record<Tono, string> = {
  free: 'border-libre-fuerte/45',
  progress: 'border-proceso-fuerte/45',
  warning: 'border-alerta-fuerte/45',
  action: 'border-accion-fuerte/45',
  neutral: 'border-neutro-fuerte/45',
}
const SILLA: Record<Tono, string> = {
  free: 'bg-libre-fuerte/55',
  progress: 'bg-proceso-fuerte/70',
  warning: 'bg-alerta-fuerte/70',
  action: 'bg-accion-fuerte/60',
  neutral: 'bg-neutro-fuerte/55',
}
/** El halo y la franja que unen en el plano las mesas de un mismo pedido (tarea 1.5). */
const UNION: Record<Tono, string> = {
  free: 'text-libre-fuerte',
  progress: 'text-proceso-fuerte',
  warning: 'text-alerta-fuerte',
  action: 'text-accion-fuerte',
  neutral: 'text-neutro-fuerte',
}
const PUNTO: Record<Tono, string> = {
  free: 'bg-libre-fuerte',
  progress: 'bg-proceso-fuerte',
  warning: 'bg-alerta-fuerte',
  action: 'bg-accion-fuerte',
  neutral: 'bg-neutro-fuerte',
}

type Mesa = Catalog['tables'][number]
type Vista = 'floorPlan' | 'list'
const CLAVE_VISTA = 'pos-tables-view'
const CLAVE_ZONA = 'pos-tables-zone'

/** Lo recordado en este equipo; si el almacenamiento no está, se sigue sin él. */
const recordar = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {}
}
const recordado = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Lo que se dice de una mesa: estado, tiempo desde que se abrió, total y quién la atiende. */
interface Resumen {
  status: EstadoMesaDemo
  orders: PedidoVisible[]
  total: number
  minutos: number | null
  waiter: string | null
  porConfirmar: boolean
  /** En la mesa principal de un grupo de mesas unidas (tarea 1.5), las otras: «5, 6». */
  unidaCon: string | null
  /** En una mesa unida a otra, la principal: ahí se ven el tiempo y el total del grupo. */
  unidaA: string | null
}

function resumir(orders: PedidoVisible[], staff: Catalog['staff'], now: number): Resumen {
  const firstOne = orders[0]
  return {
    status: estadoMesa(orders),
    orders,
    total: orders.reduce((s, p) => s + p.total, 0),
    minutos: firstOne ? Math.max(0, (now - Date.parse(firstOne.status.openedAt)) / 60_000) : null,
    waiter: firstOne
      ? (staff.find((u) => u.id === firstOne.status.assignedWaiterId)?.name ?? null)
      : null,
    porConfirmar: orders.some((p) => p.porConfirmar),
    unidaCon: null,
    unidaA: null,
  }
}

const describir = (table: Mesa, r: Resumen) =>
  [
    `Mesa ${table.name}`,
    STATUSES[r.status].text,
    r.status !== 'free' && !r.unidaA && r.minutos !== null ? minutos(r.minutos) : '',
    r.status !== 'free' && !r.unidaA ? pesos(r.total) : '',
    r.unidaA ? '' : (r.waiter ?? ''),
    r.orders.length > 1 ? `${r.orders.length} pedidos` : '',
    r.unidaCon ? `unida con ${r.unidaCon}` : '',
    r.unidaA ? `unida a la mesa ${r.unidaA}` : '',
    r.porConfirmar ? 'sin confirmar' : '',
  ]
    .filter(Boolean)
    .join(', ')

export function Mesas() {
  const { catalog, device } = useSala()
  const esCaja = device?.type === 'register'
  const orders = usePedidos()
  const now = useAhora()
  const [vista, setVista] = useState<Vista>(
    () =>
      (['floorPlan', 'list'] as const).find((v) => v === recordado(CLAVE_VISTA)) ??
      (typeof window !== 'undefined' && window.innerWidth < 768 ? 'list' : 'floorPlan'),
  )
  const [zonaElegida, setZonaElegida] = useState(() => recordado(CLAVE_ZONA))

  const resumenes = useMemo(() => {
    const deMesa = new Map<string, PedidoVisible[]>()
    // Un grupo con mesas unidas (tarea 1.5) ocupa todas: cada una muestra el mismo pedido.
    for (const p of orders ?? [])
      for (const m of p.status.tableId ? [p.status.tableId, ...p.status.mergedTables] : [])
        deMesa.set(m, [...(deMesa.get(m) ?? []), p])
    // Una mesa del grupo en otra zona no se ve en este plano: se nombra con su zona.
    const nombreDesde = (from: Mesa) => (id: string) => {
      const table = catalog?.tables.find((m) => m.id === id)
      if (!table) return '?'
      const zone = catalog?.zones.find((z) => z.id === table.zoneId)
      return table.zoneId === from.zoneId || !zone ? table.name : `${table.name} (${zone.name})`
    }
    return new Map(
      (catalog?.tables ?? []).map((m) => {
        const name = nombreDesde(m)
        const r = resumir(deMesa.get(m.id) ?? [], catalog?.staff ?? [], now)
        const group = r.orders.find((p) => p.status.mergedTables.length > 0)?.status
        const main = group?.tableId === m.id
        return [
          m.id,
          {
            ...r,
            unidaCon: group && main ? group.mergedTables.map(name).join(', ') : null,
            unidaA: group?.tableId && !main ? name(group.tableId) : null,
          },
        ]
      }),
    )
  }, [catalog, orders, now])

  if (!catalog) return null
  const zones = catalog.zones
  const pisosDistintos = new Set(zones.map((z) => z.level)).size > 1
  const zone = zones.find((z) => z.id === zonaElegida) ?? zones[0]
  const elegirVista = (v: Vista) => {
    setVista(v)
    recordar(CLAVE_VISTA, v)
  }
  /** Una mesa unida a otra abre el pedido del grupo, en su mesa principal. */
  const tocar = (table: Mesa) => {
    const r = resumenes.get(table.id)
    // En la caja, una mesa que pidió la cuenta abre directo la cuenta (un toque menos al cobrar).
    const unico = r?.orders.length === 1 ? r.orders[0] : undefined
    if (esCaja && r?.status === 'check' && unico) {
      navegar(`/check?order=${unico.status.id}`)
      return
    }
    const group = r?.orders.find((p) => p.status.mergedTables.includes(table.id))
    navegar(
      group?.status.tableId
        ? `/order?table=${group.status.tableId}&order=${group.status.id}`
        : `/order?table=${table.id}`,
    )
  }

  const zonaActual = vista === 'floorPlan' ? zone : undefined
  const enZona = (status: EstadoMesaDemo) =>
    catalog.tables.filter(
      (m) => (!zonaActual || m.zoneId === zonaActual.id) && resumenes.get(m.id)?.status === status,
    ).length

  return (
    <MarcoSala title="Salón">
      <div className="mx-auto flex max-w-[96rem] flex-col gap-5 p-3 md:p-5 lg:flex-row lg:items-start">
        <PedidosAbiertos catalog={catalog} orders={orders ?? []} now={now} />

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            {vista === 'floorPlan' && zones.length > 1 && (
              <Grupo etiqueta="Zona" className="flex flex-wrap gap-2">
                {zones.map((z) => (
                  <Opcion
                    key={z.id}
                    elegida={z.id === zone?.id}
                    alElegir={() => {
                      setZonaElegida(z.id)
                      recordar(CLAVE_ZONA, z.id)
                    }}
                  >
                    {pisosDistintos ? `${z.name} · piso ${z.level}` : z.name}
                  </Opcion>
                ))}
              </Grupo>
            )}
            <span className="flex-1" />
            <Grupo etiqueta="Ver el salón como" className="flex rounded-xl bg-superficie-2 p-1">
              {(['floorPlan', 'list'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={vista === v}
                  onClick={() => elegirVista(v)}
                  className={`flex min-h-12 items-center gap-2 rounded-lg px-3 font-semibold transition-colors focus-visible:outline-3 focus-visible:outline-foco ${
                    vista === v ? 'bg-superficie text-texto shadow-flota' : 'text-texto-suave'
                  }`}
                >
                  <Icono name={v === 'floorPlan' ? 'floorPlan' : 'list'} className="size-4" />
                  {v === 'floorPlan' ? 'Plano' : 'Lista'}
                </button>
              ))}
            </Grupo>
          </div>

          {/* Qué dice cada color, con cuántas mesas hay así (en la zona que se ve). */}
          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm" aria-label="Estado de las mesas">
            {(['free', 'taking', 'ready', 'in_kitchen', 'served'] as const).map((status) => (
              <li key={status} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`size-3 rounded-full ${PUNTO[STATUSES[status].tono]}`}
                />
                <span className="font-medium">{STATUSES[status].text}</span>
                <span className="cifras text-texto-suave">{enZona(status)}</span>
              </li>
            ))}
          </ul>

          <PedidosFueraDelPlano catalog={catalog} orders={orders ?? []} />

          {zones.length === 0 && (
            <div className="rounded-2xl border border-dashed border-borde bg-superficie p-8 text-center">
              <p className="text-lg font-semibold">Todavía no hay mesas</p>
              <p className="mt-1 text-texto-suave">
                Quien administra el restaurante las dibuja en «Plano del salón».
              </p>
            </div>
          )}

          {vista === 'list'
            ? zones.map((z) => (
                <section key={z.id} aria-label={z.name} className="flex flex-col gap-2">
                  {zones.length > 1 && <h2 className="text-lg font-semibold">{z.name}</h2>}
                  <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {catalog.tables
                      .filter((m) => m.zoneId === z.id)
                      .map((m) => (
                        <li key={m.id}>
                          <MesaEnLista
                            table={m}
                            r={resumenes.get(m.id) as Resumen}
                            alTocar={() => tocar(m)}
                          />
                        </li>
                      ))}
                  </ul>
                </section>
              ))
            : zone && (
                <PlanoZona
                  catalog={catalog}
                  zoneId={zone.id}
                  name={zone.name}
                  resumenes={resumenes}
                  alTocar={tocar}
                />
              )}
        </div>
      </div>
    </MarcoSala>
  )
}

const ICONO_CANAL: Record<keyof typeof CANALES, NombreIcono> = {
  takeout: 'bag',
  delivery: 'motorcycle',
  bar: 'glass',
}

/** Título de un pedido: su mesa o su canal, con el número del día. */
function nombrePedido(catalog: Catalog, p: PedidoVisible): string {
  if (p.status.tableId) {
    const names = [p.status.tableId, ...p.status.mergedTables].map(
      (id) => catalog.tables.find((m) => m.id === id)?.name ?? '?',
    )
    return `Mesa ${names.join(' + ')}`
  }
  const channel = CANALES[p.status.channel as keyof typeof CANALES] ?? 'Pedido'
  return p.status.dayNumber ? `${channel} #${p.status.dayNumber}` : channel
}

/**
 * Los pedidos abiertos, del más nuevo al más viejo, en tarjetas del color de su estado, y los
 * botones para abrir uno sin mesa: para llevar, domicilio y barra (brief §4.1). En la caja es una
 * columna al lado del plano; en el celular, una franja que se desliza arriba.
 */
function PedidosAbiertos({
  catalog,
  orders,
  now,
}: {
  catalog: Catalog
  orders: PedidoVisible[]
  now: number
}) {
  const openOnes = orders
    .filter((p) => itemsVigentes(p.status).length > 0 || p.status.tableId === null)
    .sort((a, b) => Date.parse(b.status.openedAt) - Date.parse(a.status.openedAt))
  return (
    <section
      aria-labelledby="title-orders"
      className="order-last flex flex-col gap-3 lg:sticky lg:top-24 lg:w-80 lg:shrink-0"
    >
      <div className="flex items-baseline justify-between">
        <h2 id="title-orders" className="text-lg font-semibold">
          Pedidos abiertos
        </h2>
        <span className="cifras text-texto-suave">{openOnes.length}</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {(Object.keys(CANALES) as (keyof typeof CANALES)[]).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => navegar(`/order?channel=${c}`)}
            className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border border-linea bg-superficie px-2 text-sm font-semibold transition-colors hover:border-accion-fuerte hover:text-accion-texto focus-visible:outline-3 focus-visible:outline-foco"
          >
            <Icono name={ICONO_CANAL[c]} className="size-5" />
            <span className="leading-tight">{CANALES[c]}</span>
          </button>
        ))}
      </div>
      {openOnes.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-borde p-5 text-center text-sm text-texto-suave">
          Sin pedidos por ahora. Toca una mesa para empezar uno.
        </p>
      ) : (
        <ul className="-mx-3 flex gap-3 overflow-x-auto px-3 pb-1 lg:mx-0 lg:max-h-[calc(100dvh-18rem)] lg:flex-col lg:overflow-y-auto lg:px-0">
          {openOnes.map((p) => {
            const status = estadoMesa([p])
            const v = STATUSES[status]
            const items = itemsVigentes(p.status).reduce(
              (s, i) => s + i.quantity - i.voidedQuantity,
              0,
            )
            const waiter = catalog.staff.find((u) => u.id === p.status.assignedWaiterId)
            const from = Math.max(0, (now - Date.parse(p.status.openedAt)) / 60_000)
            return (
              <li key={p.status.id} className="w-64 shrink-0 lg:w-auto">
                <button
                  type="button"
                  onClick={() =>
                    navegar(
                      p.status.tableId
                        ? `/order?table=${p.status.tableId}&order=${p.status.id}`
                        : `/order?order=${p.status.id}`,
                    )
                  }
                  className={`flex w-full flex-col gap-2 rounded-2xl p-4 text-left transition active:scale-[0.98] focus-visible:outline-3 focus-visible:outline-foco ${TONOS_SUAVES[v.tono]}`}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-lg font-bold">{nombrePedido(catalog, p)}</span>
                    <span className="cifras font-semibold">{pesos(p.total)}</span>
                  </span>
                  <span className="text-sm">
                    {[
                      `${items} ${items === 1 ? 'producto' : 'productos'}`,
                      waiter?.name,
                      minutos(from),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <span className="flex items-center gap-2">
                    <Etiqueta tono={v.tono} icono={p.porConfirmar ? 'clock' : v.icono} main>
                      {p.porConfirmar ? `${v.text} · sin confirmar` : v.text}
                    </Etiqueta>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/**
 * Pedidos abiertos cuya mesa ya no está en el plano (la archivaron mientras un mesero sin
 * conexión la usaba): no se pierden de vista. Se pasan a otra con «Mesa y pedido → Cambiar de mesa».
 */
function PedidosFueraDelPlano({ catalog, orders }: { catalog: Catalog; orders: PedidoVisible[] }) {
  const tables = new Set(catalog.tables.map((m) => m.id))
  const outside = orders.filter((p) => p.status.tableId !== null && !tables.has(p.status.tableId))
  if (outside.length === 0) return null
  return (
    <section
      aria-label="Pedidos en mesas que ya no están en el plano"
      className="mb-3 rounded-2xl border-2 border-alerta-fuerte bg-alerta-suave p-3 text-alerta-texto"
    >
      <p className="font-semibold">
        {outside.length === 1
          ? 'Hay un pedido abierto en una mesa que ya no está en el plano.'
          : `Hay ${outside.length} pedidos abiertos en mesas que ya no están en el plano.`}{' '}
        Avisa en caja.
      </p>
      <ul className="mt-1">
        {outside.map((p) => (
          <li key={p.status.id} className="cifras">
            {[catalog.staff.find((u) => u.id === p.status.assignedWaiterId)?.name, pesos(p.total)]
              .filter(Boolean)
              .join(' · ')}
          </li>
        ))}
      </ul>
    </section>
  )
}

function PlanoZona({
  catalog,
  zoneId,
  name,
  resumenes,
  alTocar,
}: {
  catalog: Catalog
  zoneId: string
  name: string
  resumenes: Map<string, Resumen>
  alTocar: (m: Mesa) => void
}) {
  const tables = catalog.tables.filter((m) => m.zoneId === zoneId)
  const elements = catalog.elements.filter((e) => e.zoneId === zoneId)
  const register = limites([...tables, ...elements])
  const { ref, escala } = useEscala(register)
  const center = (m: Mesa) => {
    const e = placement(m, register, escala)
    return { x: Number(e.left) + Number(e.width) / 2, y: Number(e.top) + Number(e.height) / 2 }
  }
  // Las mesas de un grupo llevan un halo de su color por debajo, y cada unida una franja hasta su
  // principal; si la franja cruzaría otra mesa, quedan solo los halos y el texto.
  const grupoDe = (m: Mesa) =>
    resumenes
      .get(m.id)
      ?.orders.find((p) => p.status.tableId === m.id || p.status.mergedTables.includes(m.id))
      ?.status
  const enGrupo = tables.filter((m) => (grupoDe(m)?.mergedTables.length ?? 0) > 0)
  const uniones = enGrupo.flatMap((m) => {
    const main = tables.find((x) => x.id === grupoDe(m)?.tableId)
    if (!main || main.id === m.id) return []
    const [de, a] = [center(main), center(m)]
    const cruza = tables.some(
      (x) => x.id !== m.id && x.id !== main.id && cruzaCaja(de, a, placement(x, register, escala)),
    )
    return cruza ? [] : [{ id: m.id, de, a }]
  })
  const grueso = Math.max(8, 20 * escala)
  const tono = (m: Mesa) => UNION[STATUSES[(resumenes.get(m.id) as Resumen).status].tono]
  return (
    <Lienzo register={register} escala={escala} refContenedor={ref} etiqueta={`Plano de ${name}`}>
      {enGrupo.length > 0 && (
        <svg aria-hidden="true" className="pointer-events-none absolute inset-0 size-full">
          {uniones.map((u) => {
            const m = enGrupo.find((x) => x.id === u.id) as Mesa
            return (
              <line
                key={u.id}
                x1={u.de.x}
                y1={u.de.y}
                x2={u.a.x}
                y2={u.a.y}
                stroke="currentColor"
                strokeWidth={grueso}
                strokeLinecap="round"
                className={tono(m)}
              />
            )
          })}
          {enGrupo.map((m) => {
            const e = placement(m, register, escala)
            const [x, y, w, h] = [e.left, e.top, e.width, e.height].map(Number) as [
              number,
              number,
              number,
              number,
            ]
            const halo = grueso / 2
            return (
              <rect
                key={m.id}
                x={x - halo}
                y={y - halo}
                width={w + 2 * halo}
                height={h + 2 * halo}
                rx={m.shape === 'round' ? (Math.min(w, h) + 2 * halo) / 2 : 16 + halo}
                fill="currentColor"
                transform={
                  m.rotation ? `rotate(${m.rotation} ${x + w / 2} ${y + h / 2})` : undefined
                }
                className={tono(m)}
              />
            )
          })}
        </svg>
      )}
      {elements.map((e) => (
        <div key={e.id} style={placement(e, register, escala)} aria-hidden="true">
          <FiguraElemento type={e.type} text={e.text} escala={escala} />
        </div>
      ))}
      {tables.map((m) => (
        <MesaEnPlano
          key={m.id}
          table={m}
          r={resumenes.get(m.id) as Resumen}
          style={placement(m, register, escala)}
          escala={escala}
          alTocar={() => alTocar(m)}
        />
      ))}
    </Lienzo>
  )
}

/** Si el segmento de `de` a `a` pasa por la caja de una mesa (sin contar su giro). */
function cruzaCaja(
  de: { x: number; y: number },
  a: { x: number; y: number },
  register: React.CSSProperties,
): boolean {
  const [x0, y0] = [Number(register.left), Number(register.top)]
  const [x1, y1] = [x0 + Number(register.width), y0 + Number(register.height)]
  // Liang-Barsky: recorta el segmento contra la caja; si algo queda, la cruza.
  const [dx, dy] = [a.x - de.x, a.y - de.y]
  let [t0, t1] = [0, 1]
  for (const [p, q] of [
    [-dx, de.x - x0],
    [dx, x1 - de.x],
    [-dy, de.y - y0],
    [dy, y1 - de.y],
  ] as const) {
    if (p === 0) {
      if (q < 0) return false
    } else {
      const t = q / p
      if (p < 0) t0 = Math.max(t0, t)
      else t1 = Math.min(t1, t)
      if (t0 > t1) return false
    }
  }
  return true
}

const claseMesa = (r: Resumen) =>
  `${BORDE[STATUSES[r.status].tono]} ${TONOS_SUAVES[STATUSES[r.status].tono]}`

const claseSilla = (r: Resumen) => SILLA[STATUSES[r.status].tono]

function MesaEnPlano({
  table,
  r,
  style,
  escala,
  alTocar,
}: {
  table: Mesa
  r: Resumen
  style: React.CSSProperties
  escala: number
  alTocar: () => void
}) {
  const v = STATUSES[r.status]
  // En una mesa chica en pantalla solo cabe el número y el ícono; el resto lo dice la lista.
  const lado = Math.min(table.width, table.height) * escala
  const detalle = lado >= 80
  const conMesero = lado >= 110
  // Que se pueda tocar con el dedo: al menos 48 px, creciendo alrededor de su centro.
  const crecer = (size: number, start: number) => {
    const extra = Math.max(0, 48 - size)
    return { start: start - extra / 2, size: size + extra }
  }
  const width = crecer(Number(style.width), Number(style.left))
  const height = crecer(Number(style.height), Number(style.top))
  const tocable = {
    ...style,
    left: width.start,
    width: width.size,
    top: height.start,
    height: height.size,
  }
  return (
    <>
      <div style={style} aria-hidden="true" className="pointer-events-none">
        <Sillas
          shape={table.shape}
          width={Number(style.width)}
          height={Number(style.height)}
          places={table.capacity}
          cssClass={claseSilla(r)}
        />
      </div>
      <button
        type="button"
        onClick={alTocar}
        aria-label={`${describir(table, r)}, ${table.capacity} ${table.capacity === 1 ? 'puesto' : 'puestos'}`}
        style={tocable}
        className={`flex items-center justify-center border-2 p-1 shadow-flota transition active:scale-95 focus-visible:outline-3 focus-visible:outline-foco ${
          table.shape === 'round' ? 'rounded-full' : 'rounded-2xl'
        } ${claseMesa(r)}`}
      >
        {/* El contenido no gira con la mesa: se lee siempre derecho. */}
        <span
          className="flex flex-col items-center text-center leading-tight"
          style={table.rotation ? { transform: `rotate(${-table.rotation}deg)` } : undefined}
        >
          <span className="flex items-center gap-1">
            <span className="font-titulo text-xl font-bold">{table.name}</span>
            <Icono name={r.porConfirmar ? 'clock' : v.icono} className="size-4" />
          </span>
          {detalle && r.unidaCon && (
            <span className="max-w-full truncate text-sm font-semibold">{`+ ${r.unidaCon}`}</span>
          )}
          {detalle && r.unidaA && (
            <span className="max-w-full truncate text-sm font-semibold">{`con la ${r.unidaA}`}</span>
          )}
          {detalle && r.status !== 'free' && !r.unidaA && (
            <span className="cifras text-sm">
              {r.minutos !== null && minutos(r.minutos)}
              <br />
              {pesos(r.total)}
            </span>
          )}
          {conMesero && r.waiter && !r.unidaA && (
            <span className="max-w-full truncate text-sm">{r.waiter}</span>
          )}
        </span>
      </button>
    </>
  )
}

function MesaEnLista({ table, r, alTocar }: { table: Mesa; r: Resumen; alTocar: () => void }) {
  const v = STATUSES[r.status]
  const takenPath = r.status !== 'free'
  return (
    <button
      type="button"
      onClick={alTocar}
      aria-label={describir(table, r)}
      className="flex min-h-18 w-full items-center gap-3 rounded-2xl border border-linea bg-superficie px-3 py-2 text-left transition-colors hover:border-borde focus-visible:outline-3 focus-visible:outline-foco"
    >
      <span
        className={`font-titulo flex size-12 shrink-0 items-center justify-center rounded-xl text-2xl font-bold ${claseMesa(r)}`}
      >
        {table.name}
      </span>
      <span className="flex-1">
        <Etiqueta tono={v.tono} icono={r.porConfirmar ? 'clock' : v.icono}>
          {r.porConfirmar ? `${v.text} · sin confirmar` : v.text}
        </Etiqueta>
        {takenPath && (
          <span className="mt-1 block text-sm text-texto-suave">
            {[
              r.unidaA ? null : r.waiter,
              r.minutos !== null && !r.unidaA ? minutos(r.minutos) : null,
              r.orders.length > 1 ? `${r.orders.length} pedidos` : null,
              r.unidaCon ? `Unida con ${r.unidaCon}` : null,
              r.unidaA ? `Unida a la mesa ${r.unidaA}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
      </span>
      {takenPath && !r.unidaA && <span className="cifras font-semibold">{pesos(r.total)}</span>}
    </button>
  )
}
