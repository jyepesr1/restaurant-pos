import type { Catalogo } from '@pos/sync'
import { useEffect, useMemo, useState } from 'react'
import { Etiqueta, TONOS_SUAVES, type Tono } from '../ui/Etiqueta'
import { minutos, pesos } from '../ui/formato'
import { Icono, type NombreIcono } from '../ui/iconos'
import { Grupo, Opcion } from '../ui/Opciones'
import { navegar } from '../ui/ruta'
import { usePedidos, useSala } from './contexto'
import { FiguraElemento, Lienzo, posicion, Sillas, useEscala } from './LienzoPlano'
import { MarcoSala } from './MarcoSala'
import { CANALES } from './pedido'
import { limites } from './plano'
import { type EstadoMesaDemo, estadoMesa, itemsVigentes, type PedidoVisible } from './proyeccion'

// Plano de mesas (brief §5, regla 1): la pantalla inicial del mesero. Cada zona o piso con sus
// mesas en su lugar real y sus sillas, y en cada mesa ocupada el estado, el tiempo, el total y
// quién la atiende. En el celular, o si se prefiere, la misma información en lista. Al lado (en
// la caja) o arriba (en el celular), los pedidos abiertos en tarjetas del color de su estado, y
// los botones para los pedidos sin mesa. Un toque en la mesa o la tarjeta lleva a su pedido.

const ESTADOS: Record<EstadoMesaDemo, { tono: Tono; icono: NombreIcono; texto: string }> = {
  libre: { tono: 'libre', icono: 'circulo', texto: 'Libre' },
  tomando: { tono: 'proceso', icono: 'lapiz', texto: 'Tomando pedido' },
  en_cocina: { tono: 'proceso', icono: 'fuego', texto: 'En preparación' },
}

type Mesa = Catalogo['mesas'][number]
type Vista = 'plano' | 'lista'
const CLAVE_VISTA = 'pos-vista-mesas'
const CLAVE_ZONA = 'pos-zona-mesas'

/** Lo recordado en este equipo; si el almacenamiento no está, se sigue sin él. */
const recordar = (clave: string, valor: string) => {
  try {
    localStorage.setItem(clave, valor)
  } catch {}
}
const recordado = (clave: string) => {
  try {
    return localStorage.getItem(clave)
  } catch {
    return null
  }
}

function useAhora(cadaMs = 30_000) {
  const [ahora, setAhora] = useState(Date.now)
  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), cadaMs)
    return () => clearInterval(t)
  }, [cadaMs])
  return ahora
}

/** Lo que se dice de una mesa: estado, tiempo desde que se abrió, total y quién la atiende. */
interface Resumen {
  estado: EstadoMesaDemo
  pedidos: PedidoVisible[]
  total: number
  minutos: number | null
  mesero: string | null
  porConfirmar: boolean
}

function resumir(pedidos: PedidoVisible[], personal: Catalogo['personal'], ahora: number): Resumen {
  const primero = pedidos[0]
  return {
    estado: estadoMesa(pedidos),
    pedidos,
    total: pedidos.reduce((s, p) => s + p.total, 0),
    minutos: primero ? Math.max(0, (ahora - Date.parse(primero.estado.abiertoEn)) / 60_000) : null,
    mesero: primero
      ? (personal.find((u) => u.id === primero.estado.meseroAsignadoId)?.nombre ?? null)
      : null,
    porConfirmar: pedidos.some((p) => p.porConfirmar),
  }
}

const describir = (mesa: Mesa, r: Resumen) =>
  [
    `Mesa ${mesa.nombre}`,
    ESTADOS[r.estado].texto,
    r.estado !== 'libre' && r.minutos !== null ? minutos(r.minutos) : '',
    r.estado !== 'libre' ? pesos(r.total) : '',
    r.mesero ?? '',
    r.pedidos.length > 1 ? `${r.pedidos.length} pedidos` : '',
    r.porConfirmar ? 'sin confirmar' : '',
  ]
    .filter(Boolean)
    .join(', ')

export function Mesas() {
  const { catalogo } = useSala()
  const pedidos = usePedidos()
  const ahora = useAhora()
  const [vista, setVista] = useState<Vista>(
    () =>
      (['plano', 'lista'] as const).find((v) => v === recordado(CLAVE_VISTA)) ??
      (typeof window !== 'undefined' && window.innerWidth < 768 ? 'lista' : 'plano'),
  )
  const [zonaElegida, setZonaElegida] = useState(() => recordado(CLAVE_ZONA))

  const resumenes = useMemo(() => {
    const deMesa = new Map<string, PedidoVisible[]>()
    for (const p of pedidos ?? [])
      if (p.estado.mesaId) deMesa.set(p.estado.mesaId, [...(deMesa.get(p.estado.mesaId) ?? []), p])
    return new Map(
      (catalogo?.mesas ?? []).map((m) => [
        m.id,
        resumir(deMesa.get(m.id) ?? [], catalogo?.personal ?? [], ahora),
      ]),
    )
  }, [catalogo, pedidos, ahora])

  if (!catalogo) return null
  const zonas = catalogo.zonas
  const pisosDistintos = new Set(zonas.map((z) => z.piso)).size > 1
  const zona = zonas.find((z) => z.id === zonaElegida) ?? zonas[0]
  const elegirVista = (v: Vista) => {
    setVista(v)
    recordar(CLAVE_VISTA, v)
  }
  const tocar = (mesa: Mesa) => navegar(`/pedido?mesa=${mesa.id}`)

  const zonaActual = vista === 'plano' ? zona : undefined
  const enZona = (estado: EstadoMesaDemo) =>
    catalogo.mesas.filter(
      (m) => (!zonaActual || m.zonaId === zonaActual.id) && resumenes.get(m.id)?.estado === estado,
    ).length

  return (
    <MarcoSala titulo="Salón">
      <div className="mx-auto flex max-w-[96rem] flex-col gap-5 p-3 md:p-5 lg:flex-row lg:items-start">
        <PedidosAbiertos catalogo={catalogo} pedidos={pedidos ?? []} ahora={ahora} />

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            {vista === 'plano' && zonas.length > 1 && (
              <Grupo etiqueta="Zona" className="flex flex-wrap gap-2">
                {zonas.map((z) => (
                  <Opcion
                    key={z.id}
                    elegida={z.id === zona?.id}
                    alElegir={() => {
                      setZonaElegida(z.id)
                      recordar(CLAVE_ZONA, z.id)
                    }}
                  >
                    {pisosDistintos ? `${z.nombre} · piso ${z.piso}` : z.nombre}
                  </Opcion>
                ))}
              </Grupo>
            )}
            <span className="flex-1" />
            <Grupo etiqueta="Ver el salón como" className="flex rounded-xl bg-superficie-2 p-1">
              {(['plano', 'lista'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={vista === v}
                  onClick={() => elegirVista(v)}
                  className={`flex min-h-12 items-center gap-2 rounded-lg px-3 font-semibold transition-colors focus-visible:outline-3 focus-visible:outline-foco ${
                    vista === v ? 'bg-superficie text-texto shadow-flota' : 'text-texto-suave'
                  }`}
                >
                  <Icono nombre={v === 'plano' ? 'plano' : 'lista'} className="size-4" />
                  {v === 'plano' ? 'Plano' : 'Lista'}
                </button>
              ))}
            </Grupo>
          </div>

          {/* Qué dice cada color, con cuántas mesas hay así (en la zona que se ve). */}
          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm" aria-label="Estado de las mesas">
            {(['libre', 'tomando', 'en_cocina'] as const).map((estado) => (
              <li key={estado} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`size-3 rounded-full ${estado === 'libre' ? 'bg-libre-fuerte' : 'bg-proceso-fuerte'}`}
                />
                <span className="font-medium">{ESTADOS[estado].texto}</span>
                <span className="cifras text-texto-suave">{enZona(estado)}</span>
              </li>
            ))}
          </ul>

          <PedidosFueraDelPlano catalogo={catalogo} pedidos={pedidos ?? []} />

          {zonas.length === 0 && (
            <div className="rounded-2xl border border-dashed border-borde bg-superficie p-8 text-center">
              <p className="text-lg font-semibold">Todavía no hay mesas</p>
              <p className="mt-1 text-texto-suave">
                Quien administra el restaurante las dibuja en «Plano del salón».
              </p>
            </div>
          )}

          {vista === 'lista'
            ? zonas.map((z) => (
                <section key={z.id} aria-label={z.nombre} className="flex flex-col gap-2">
                  {zonas.length > 1 && <h2 className="text-lg font-semibold">{z.nombre}</h2>}
                  <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {catalogo.mesas
                      .filter((m) => m.zonaId === z.id)
                      .map((m) => (
                        <li key={m.id}>
                          <MesaEnLista
                            mesa={m}
                            r={resumenes.get(m.id) as Resumen}
                            alTocar={() => tocar(m)}
                          />
                        </li>
                      ))}
                  </ul>
                </section>
              ))
            : zona && (
                <PlanoZona
                  catalogo={catalogo}
                  zonaId={zona.id}
                  nombre={zona.nombre}
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
  para_llevar: 'bolsa',
  domicilio: 'moto',
  barra: 'copa',
}

/** Título de un pedido: su mesa o su canal, con el número del día. */
function nombrePedido(catalogo: Catalogo, p: PedidoVisible): string {
  if (p.estado.mesaId) {
    const mesa = catalogo.mesas.find((m) => m.id === p.estado.mesaId)
    return mesa ? `Mesa ${mesa.nombre}` : 'Mesa'
  }
  const canal = CANALES[p.estado.canal as keyof typeof CANALES] ?? 'Pedido'
  return p.estado.numeroDia ? `${canal} #${p.estado.numeroDia}` : canal
}

/**
 * Los pedidos abiertos, del más nuevo al más viejo, en tarjetas del color de su estado, y los
 * botones para abrir uno sin mesa: para llevar, domicilio y barra (brief §4.1). En la caja es una
 * columna al lado del plano; en el celular, una franja que se desliza arriba.
 */
function PedidosAbiertos({
  catalogo,
  pedidos,
  ahora,
}: {
  catalogo: Catalogo
  pedidos: PedidoVisible[]
  ahora: number
}) {
  const abiertos = pedidos
    .filter((p) => itemsVigentes(p.estado).length > 0 || p.estado.mesaId === null)
    .sort((a, b) => Date.parse(b.estado.abiertoEn) - Date.parse(a.estado.abiertoEn))
  return (
    <section
      aria-labelledby="titulo-pedidos"
      className="order-last flex flex-col gap-3 lg:sticky lg:top-24 lg:w-80 lg:shrink-0"
    >
      <div className="flex items-baseline justify-between">
        <h2 id="titulo-pedidos" className="text-lg font-semibold">
          Pedidos abiertos
        </h2>
        <span className="cifras text-texto-suave">{abiertos.length}</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {(Object.keys(CANALES) as (keyof typeof CANALES)[]).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => navegar(`/pedido?canal=${c}`)}
            className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border border-linea bg-superficie px-2 text-sm font-semibold transition-colors hover:border-accion-fuerte hover:text-accion-texto focus-visible:outline-3 focus-visible:outline-foco"
          >
            <Icono nombre={ICONO_CANAL[c]} className="size-5" />
            <span className="leading-tight">{CANALES[c]}</span>
          </button>
        ))}
      </div>
      {abiertos.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-borde p-5 text-center text-sm text-texto-suave">
          Sin pedidos por ahora. Toca una mesa para empezar uno.
        </p>
      ) : (
        <ul className="-mx-3 flex gap-3 overflow-x-auto px-3 pb-1 lg:mx-0 lg:max-h-[calc(100dvh-18rem)] lg:flex-col lg:overflow-y-auto lg:px-0">
          {abiertos.map((p) => {
            const estado = estadoMesa([p])
            const v = ESTADOS[estado]
            const items = itemsVigentes(p.estado).reduce(
              (s, i) => s + i.cantidad - i.cantidadAnulada,
              0,
            )
            const mesero = catalogo.personal.find((u) => u.id === p.estado.meseroAsignadoId)
            const desde = Math.max(0, (ahora - Date.parse(p.estado.abiertoEn)) / 60_000)
            return (
              <li key={p.estado.id} className="w-64 shrink-0 lg:w-auto">
                <button
                  type="button"
                  onClick={() =>
                    navegar(
                      p.estado.mesaId
                        ? `/pedido?mesa=${p.estado.mesaId}&pedido=${p.estado.id}`
                        : `/pedido?pedido=${p.estado.id}`,
                    )
                  }
                  className={`flex w-full flex-col gap-2 rounded-2xl p-4 text-left transition active:scale-[0.98] focus-visible:outline-3 focus-visible:outline-foco ${TONOS_SUAVES[v.tono]}`}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-lg font-bold">{nombrePedido(catalogo, p)}</span>
                    <span className="cifras font-semibold">{pesos(p.total)}</span>
                  </span>
                  <span className="text-sm">
                    {[
                      `${items} ${items === 1 ? 'producto' : 'productos'}`,
                      mesero?.nombre,
                      minutos(desde),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <span className="flex items-center gap-2">
                    <Etiqueta tono={v.tono} icono={p.porConfirmar ? 'reloj' : v.icono} fuerte>
                      {p.porConfirmar ? `${v.texto} · sin confirmar` : v.texto}
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
 * conexión la usaba): no se pierden de vista. Cambiarlos de mesa llega con la tarea 1.5.
 */
function PedidosFueraDelPlano({
  catalogo,
  pedidos,
}: {
  catalogo: Catalogo
  pedidos: PedidoVisible[]
}) {
  const mesas = new Set(catalogo.mesas.map((m) => m.id))
  const fuera = pedidos.filter((p) => p.estado.mesaId !== null && !mesas.has(p.estado.mesaId))
  if (fuera.length === 0) return null
  return (
    <section
      aria-label="Pedidos en mesas que ya no están en el plano"
      className="mb-3 rounded-2xl border-2 border-alerta-fuerte bg-alerta-suave p-3 text-alerta-texto"
    >
      <p className="font-semibold">
        {fuera.length === 1
          ? 'Hay un pedido abierto en una mesa que ya no está en el plano.'
          : `Hay ${fuera.length} pedidos abiertos en mesas que ya no están en el plano.`}{' '}
        Avisa en caja.
      </p>
      <ul className="mt-1">
        {fuera.map((p) => (
          <li key={p.estado.id} className="cifras">
            {[
              catalogo.personal.find((u) => u.id === p.estado.meseroAsignadoId)?.nombre,
              pesos(p.total),
            ]
              .filter(Boolean)
              .join(' · ')}
          </li>
        ))}
      </ul>
    </section>
  )
}

function PlanoZona({
  catalogo,
  zonaId,
  nombre,
  resumenes,
  alTocar,
}: {
  catalogo: Catalogo
  zonaId: string
  nombre: string
  resumenes: Map<string, Resumen>
  alTocar: (m: Mesa) => void
}) {
  const mesas = catalogo.mesas.filter((m) => m.zonaId === zonaId)
  const elementos = catalogo.elementos.filter((e) => e.zonaId === zonaId)
  const caja = limites([...mesas, ...elementos])
  const { ref, escala } = useEscala(caja)
  return (
    <Lienzo caja={caja} escala={escala} refContenedor={ref} etiqueta={`Plano de ${nombre}`}>
      {elementos.map((e) => (
        <div key={e.id} style={posicion(e, caja, escala)} aria-hidden="true">
          <FiguraElemento tipo={e.tipo} texto={e.texto} escala={escala} />
        </div>
      ))}
      {mesas.map((m) => (
        <MesaEnPlano
          key={m.id}
          mesa={m}
          r={resumenes.get(m.id) as Resumen}
          estilo={posicion(m, caja, escala)}
          escala={escala}
          alTocar={() => alTocar(m)}
        />
      ))}
    </Lienzo>
  )
}

const claseMesa = (r: Resumen) =>
  r.estado === 'libre'
    ? 'border-libre-fuerte/45 bg-libre-suave text-libre-texto'
    : `border-proceso-fuerte/45 ${TONOS_SUAVES[ESTADOS[r.estado].tono]}`

const claseSilla = (r: Resumen) =>
  r.estado === 'libre' ? 'bg-libre-fuerte/55' : 'bg-proceso-fuerte/70'

function MesaEnPlano({
  mesa,
  r,
  estilo,
  escala,
  alTocar,
}: {
  mesa: Mesa
  r: Resumen
  estilo: React.CSSProperties
  escala: number
  alTocar: () => void
}) {
  const v = ESTADOS[r.estado]
  // En una mesa chica en pantalla solo cabe el número y el ícono; el resto lo dice la lista.
  const lado = Math.min(mesa.ancho, mesa.alto) * escala
  const detalle = lado >= 80
  const conMesero = lado >= 110
  // Que se pueda tocar con el dedo: al menos 48 px, creciendo alrededor de su centro.
  const crecer = (medida: number, inicio: number) => {
    const extra = Math.max(0, 48 - medida)
    return { inicio: inicio - extra / 2, medida: medida + extra }
  }
  const ancho = crecer(Number(estilo.width), Number(estilo.left))
  const alto = crecer(Number(estilo.height), Number(estilo.top))
  const tocable = {
    ...estilo,
    left: ancho.inicio,
    width: ancho.medida,
    top: alto.inicio,
    height: alto.medida,
  }
  return (
    <>
      <div style={estilo} aria-hidden="true" className="pointer-events-none">
        <Sillas
          forma={mesa.forma}
          ancho={Number(estilo.width)}
          alto={Number(estilo.height)}
          puestos={mesa.capacidad}
          clase={claseSilla(r)}
        />
      </div>
      <button
        type="button"
        onClick={alTocar}
        aria-label={`${describir(mesa, r)}, ${mesa.capacidad} ${mesa.capacidad === 1 ? 'puesto' : 'puestos'}`}
        style={tocable}
        className={`flex items-center justify-center border-2 p-1 shadow-flota transition active:scale-95 focus-visible:outline-3 focus-visible:outline-foco ${
          mesa.forma === 'redonda' ? 'rounded-full' : 'rounded-2xl'
        } ${claseMesa(r)}`}
      >
        {/* El contenido no gira con la mesa: se lee siempre derecho. */}
        <span
          className="flex flex-col items-center text-center leading-tight"
          style={mesa.rotacion ? { transform: `rotate(${-mesa.rotacion}deg)` } : undefined}
        >
          <span className="flex items-center gap-1">
            <span className="font-titulo text-xl font-bold">{mesa.nombre}</span>
            <Icono nombre={r.porConfirmar ? 'reloj' : v.icono} className="size-4" />
          </span>
          {detalle && r.estado !== 'libre' && (
            <span className="cifras text-sm">
              {r.minutos !== null && minutos(r.minutos)}
              <br />
              {pesos(r.total)}
            </span>
          )}
          {conMesero && r.mesero && <span className="max-w-full truncate text-sm">{r.mesero}</span>}
        </span>
      </button>
    </>
  )
}

function MesaEnLista({ mesa, r, alTocar }: { mesa: Mesa; r: Resumen; alTocar: () => void }) {
  const v = ESTADOS[r.estado]
  const ocupada = r.estado !== 'libre'
  return (
    <button
      type="button"
      onClick={alTocar}
      aria-label={describir(mesa, r)}
      className="flex min-h-18 w-full items-center gap-3 rounded-2xl border border-linea bg-superficie px-3 py-2 text-left transition-colors hover:border-borde focus-visible:outline-3 focus-visible:outline-foco"
    >
      <span
        className={`font-titulo flex size-12 shrink-0 items-center justify-center rounded-xl text-2xl font-bold ${claseMesa(r)}`}
      >
        {mesa.nombre}
      </span>
      <span className="flex-1">
        <Etiqueta tono={v.tono} icono={r.porConfirmar ? 'reloj' : v.icono}>
          {r.porConfirmar ? `${v.texto} · sin confirmar` : v.texto}
        </Etiqueta>
        {ocupada && (
          <span className="mt-1 block text-sm text-texto-suave">
            {[
              r.mesero,
              r.minutos !== null ? minutos(r.minutos) : null,
              r.pedidos.length > 1 ? `${r.pedidos.length} pedidos` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
      </span>
      {ocupada && <span className="cifras font-semibold">{pesos(r.total)}</span>}
    </button>
  )
}
