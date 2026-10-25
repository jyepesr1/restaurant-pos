import type { Catalogo } from '@pos/sync'
import { useEffect, useMemo, useState } from 'react'
import { Boton } from '../ui/Boton'
import { Etiqueta, TONOS_SUAVES, type Tono } from '../ui/Etiqueta'
import { minutos, pesos } from '../ui/formato'
import { Icono, type NombreIcono } from '../ui/iconos'
import { Grupo, Opcion } from '../ui/Opciones'
import { navegar } from '../ui/ruta'
import { usePedidos, useSala } from './contexto'
import { FiguraElemento, Lienzo, posicion, useEscala } from './LienzoPlano'
import { MarcoSala } from './MarcoSala'
import { CANALES } from './pedido'
import { limites } from './plano'
import { type EstadoMesaDemo, estadoMesa, type PedidoVisible } from './proyeccion'

// Plano de mesas (brief §5, regla 1): la pantalla inicial del mesero. Cada zona o piso con sus
// mesas en su lugar real, y en cada mesa ocupada el estado, el tiempo, el total y quién la
// atiende. En el celular, o si se prefiere, la misma información en lista. Un toque en la mesa
// lleva a su pedido.

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
  const { catalogo, sesion } = useSala()
  const pedidos = usePedidos()
  const ahora = useAhora()
  const [vista, setVista] = useState<Vista>(
    () =>
      (recordado(CLAVE_VISTA) as Vista | null) ??
      (typeof window !== 'undefined' && window.innerWidth < 768 ? 'lista' : 'plano'),
  )
  const [zonaElegida, setZonaElegida] = useState(() => recordado(CLAVE_ZONA))
  const editaCarta = sesion?.permisos.some((p) => p === 'editar_catalogo' || p === 'editar_precios')
  const editaPlano = sesion?.permisos.includes('editar_catalogo')
  const puedePersonal = sesion?.permisos.includes('administrar_usuarios')

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
  const conteo = (estado: EstadoMesaDemo) =>
    [...resumenes.values()].filter((r) => r.estado === estado).length
  const elegirVista = (v: Vista) => {
    setVista(v)
    recordar(CLAVE_VISTA, v)
  }
  const tocar = (mesa: Mesa) => navegar(`/pedido?mesa=${mesa.id}`)

  return (
    <MarcoSala titulo="Salón">
      <div className="mx-auto max-w-6xl p-3">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <Etiqueta tono="libre" icono="circulo">{`${conteo('libre')} libres`}</Etiqueta>
          <Etiqueta tono="proceso" icono="fuego">
            {`${conteo('tomando') + conteo('en_cocina')} con pedido`}
          </Etiqueta>
          <span className="flex-1" />
          <Boton
            variante="secundario"
            icono={vista === 'plano' ? 'lista' : 'plano'}
            onClick={() => elegirVista(vista === 'plano' ? 'lista' : 'plano')}
          >
            {vista === 'plano' ? 'Ver en lista' : 'Ver plano'}
          </Boton>
          {editaPlano && (
            <Boton variante="secundario" onClick={() => navegar('/plano')}>
              Editar plano
            </Boton>
          )}
          {editaCarta && (
            <Boton variante="secundario" onClick={() => navegar('/carta')}>
              Carta
            </Boton>
          )}
          {puedePersonal && (
            <Boton variante="secundario" onClick={() => navegar('/personal')}>
              Personal y roles
            </Boton>
          )}
        </div>

        <PedidosSinMesa catalogo={catalogo} pedidos={pedidos ?? []} />
        <PedidosFueraDelPlano catalogo={catalogo} pedidos={pedidos ?? []} />

        {zonas.length === 0 && (
          <p className="p-6 text-center text-texto-suave">
            Todavía no hay mesas. Quien administra el restaurante las dibuja en «Editar plano».
          </p>
        )}

        {vista === 'lista'
          ? zonas.map((z) => (
              <section key={z.id} className="mb-5" aria-label={z.nombre}>
                {zonas.length > 1 && <h2 className="mb-2 text-lg font-semibold">{z.nombre}</h2>}
                <ul className="flex flex-col gap-2">
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
              <>
                {zonas.length > 1 && (
                  <Grupo etiqueta="Zona" className="mb-3 flex flex-wrap gap-2">
                    {zonas.map((z) => (
                      <Opcion
                        key={z.id}
                        elegida={z.id === zona.id}
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
                <PlanoZona
                  catalogo={catalogo}
                  zonaId={zona.id}
                  nombre={zona.nombre}
                  resumenes={resumenes}
                  alTocar={tocar}
                />
              </>
            )}
      </div>
    </MarcoSala>
  )
}

/**
 * Para llevar, domicilio y barra (brief §4.1): pedidos sin mesa. Un botón por canal los abre, y
 * los que siguen abiertos se ven aquí con su número del día.
 */
function PedidosSinMesa({ catalogo, pedidos }: { catalogo: Catalogo; pedidos: PedidoVisible[] }) {
  const abiertos = pedidos.filter((p) => p.estado.mesaId === null)
  return (
    <section aria-label="Pedidos sin mesa" className="mb-3 flex flex-wrap items-center gap-2">
      {(Object.keys(CANALES) as (keyof typeof CANALES)[]).map((c) => (
        <Boton key={c} icono="mas" onClick={() => navegar(`/pedido?canal=${c}`)}>
          {CANALES[c]}
        </Boton>
      ))}
      {abiertos.map((p) => (
        <Boton
          key={p.estado.id}
          variante="secundario"
          className="border-proceso-fuerte"
          onClick={() => navegar(`/pedido?pedido=${p.estado.id}`)}
        >
          <span>
            {`${CANALES[p.estado.canal as keyof typeof CANALES] ?? 'Pedido'}${p.estado.numeroDia ? ` #${p.estado.numeroDia}` : ''}`}
          </span>
          <span className="cifras text-texto-suave">{pesos(p.total)}</span>
          {catalogo.personal.find((u) => u.id === p.estado.meseroAsignadoId) && (
            <span className="text-texto-suave">
              {catalogo.personal.find((u) => u.id === p.estado.meseroAsignadoId)?.nombre}
            </span>
          )}
        </Boton>
      ))}
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
    ? 'border-borde bg-superficie text-libre-texto'
    : `border-transparent ${TONOS_SUAVES[ESTADOS[r.estado].tono]}`

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
    <button
      type="button"
      onClick={alTocar}
      aria-label={describir(mesa, r)}
      style={tocable}
      className={`flex items-center justify-center border-2 p-1 transition active:scale-95 focus-visible:outline-3 focus-visible:outline-foco ${
        mesa.forma === 'redonda' ? 'rounded-full' : 'rounded-xl'
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
      className="flex min-h-16 w-full items-center gap-3 rounded-2xl border border-borde bg-superficie px-3 text-left hover:bg-superficie-2 focus-visible:outline-3 focus-visible:outline-foco"
    >
      <span className="font-titulo w-12 text-center text-3xl font-bold">{mesa.nombre}</span>
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
