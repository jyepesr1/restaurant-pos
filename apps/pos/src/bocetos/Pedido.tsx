import type { GrupoCarta, ProductoCarta } from '@pos/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { buscar } from '../ui/busqueda'
import { pesos } from '../ui/formato'
import { Icono } from '../ui/iconos'
import { Grupo, Opcion } from '../ui/Opciones'
import { PanelLateral } from '../ui/PanelLateral'
import { navegar } from '../ui/ruta'
import { netoLinea } from './cuenta'
import {
  carta,
  type ItemPedido,
  type Mesa,
  MOTIVOS_ANULACION,
  nuevoItemId,
  productos,
  textoDeBusqueda,
} from './datos'
import { cambiarMesa, useMesaDeLaRuta, useMesas } from './estado'
import { Marco } from './Marco'
import { lineaDe, nombreItem, totalMesa } from './totales'

// Toma de pedido (brief §5, regla 2): tocar productos y "Enviar". Lo que no tiene opciones entra
// con un toque (y se puede deshacer); el mismo producto otra vez suma a su línea. Lo que tiene una
// sola elección (copa o botella, sabor, término) abre el panel y tocar la opción ya lo agrega.

const RESULTADOS = 30

/** Cuántas elecciones pide el producto: variante y grupos obligatorios. */
const elecciones = (p: ProductoCarta) =>
  (p.variantes.length > 0 ? 1 : 0) + p.grupos.filter((g) => g.minimo > 0).length
const necesitaPanel = (p: ProductoCarta) => p.variantes.length > 0 || p.grupos.length > 0

/** Dos ítems son la misma línea si son el mismo producto, igual, para la misma persona, sin enviar. */
const mismaLinea = (a: ItemPedido, b: ItemPedido) =>
  a.enviadoEn === null &&
  !a.anulado &&
  a.producto.clave === b.producto.clave &&
  a.variante === b.variante &&
  a.comensal === b.comensal &&
  a.notas === b.notas &&
  JSON.stringify(a.opciones) === JSON.stringify(b.opciones)

/** Abrir la mesa al agregar el primer producto (no al tocarla en el plano). */
const ocupar = (m: Mesa): Mesa =>
  m.estado === 'libre' || m.estado === 'reservada'
    ? { ...m, estado: 'tomando', abiertaEn: Date.now(), comensales: 2, mesero: 'Mesero 1' }
    : m

export function Pedido() {
  const numero = useMesaDeLaRuta(2)
  const mesa = useMesas().find((m) => m.numero === numero)
  const avisar = useAvisar()
  const [busqueda, setBusqueda] = useState('')
  const [categoria, setCategoria] = useState(carta[0]?.clave ?? '')
  const [comensal, setComensal] = useState<number | null>(null)
  const [elegido, setElegido] = useState<ProductoCarta | null>(null)
  const [editando, setEditando] = useState<string | null>(null)
  const [verPedido, setVerPedido] = useState(false)
  const campoBusqueda = useRef<HTMLInputElement>(null)

  // "/" lleva a la búsqueda (atajo de caja, brief §5, regla 8).
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key !== '/' || (e.target as HTMLElement).closest('input, textarea')) return
      e.preventDefault()
      campoBusqueda.current?.focus()
    }
    window.addEventListener('keydown', alTeclear)
    return () => window.removeEventListener('keydown', alTeclear)
  }, [])

  const encontrados = useMemo(
    () =>
      busqueda.trim()
        ? buscar(productos, busqueda, (p) => textoDeBusqueda.get(p.clave) ?? p.nombre)
        : (carta.find((c) => c.clave === categoria)?.productos ?? []),
    [busqueda, categoria],
  )

  // Si bajan las personas, lo elegido para una que ya no está vuelve a "Mesa".
  const comensales = mesa?.comensales ?? 0
  useEffect(() => {
    if (comensal !== null && comensal > comensales) setComensal(null)
  }, [comensal, comensales])

  if (!mesa) return null
  const items = mesa.items
  const porEnviar = items.filter((i) => i.enviadoEn === null && !i.anulado)
  const enPedido = (p: ProductoCarta) =>
    porEnviar.filter((i) => i.producto.clave === p.clave).reduce((s, i) => s + i.cantidad, 0)

  const agregar = (nuevo: ItemPedido) => {
    const igual = items.find((i) => mismaLinea(i, nuevo))
    if (igual) {
      cambiarMesa(numero, (m) => ({
        ...m,
        items: m.items.map((i) =>
          i.id === igual.id ? { ...i, cantidad: i.cantidad + nuevo.cantidad } : i,
        ),
      }))
      avisar(`${nombreItem(nuevo)}: ${igual.cantidad + nuevo.cantidad}`, () =>
        cambiarMesa(numero, (m) => ({
          ...m,
          items: m.items.map((i) =>
            i.id === igual.id ? { ...i, cantidad: i.cantidad - nuevo.cantidad } : i,
          ),
        })),
      )
      return
    }
    const antes = mesa
    cambiarMesa(numero, (m) => ({ ...ocupar(m), items: [...m.items, nuevo] }))
    avisar(`Agregaste ${nombreItem(nuevo)}`, () =>
      cambiarMesa(numero, (m) =>
        m.items.length === 1 && antes.items.length === 0
          ? antes
          : { ...m, items: m.items.filter((i) => i.id !== nuevo.id) },
      ),
    )
  }

  const tocarProducto = (p: ProductoCarta) => {
    if (necesitaPanel(p)) setElegido(p)
    else agregar(nuevo(p, null, [], comensal))
  }

  const quitar = (item: ItemPedido) => {
    const posicion = items.findIndex((i) => i.id === item.id)
    cambiarMesa(numero, (m) => ({ ...m, items: m.items.filter((i) => i.id !== item.id) }))
    avisar(`Quitaste ${nombreItem(item)}`, () =>
      cambiarMesa(numero, (m) => {
        const copia = [...m.items]
        copia.splice(posicion, 0, item)
        return { ...m, items: copia }
      }),
    )
  }

  const enviar = () => {
    if (porEnviar.length === 0) return
    const ahora = Date.now()
    cambiarMesa(numero, (m) => ({
      ...m,
      estado: 'en_cocina',
      items: m.items.map((i) => (i.enviadoEn === null ? { ...i, enviadoEn: ahora } : i)),
    }))
    navigator.vibrate?.(60)
    avisar(`Enviado a cocina y barra (${porEnviar.length})`)
    setVerPedido(false)
    navegar('/bocetos/plano')
  }

  const pedirCuenta = () => navegar(`/bocetos/precuenta?mesa=${numero}`)
  const itemEditado = items.find((i) => i.id === editando) ?? null

  const ticket = (
    <Ticket
      mesa={mesa}
      comensal={comensal}
      alElegirComensal={setComensal}
      alCambiarComensales={(n) => cambiarMesa(numero, (m) => ({ ...m, comensales: n }))}
      alTocarItem={(i) => setEditando(i.id)}
    />
  )
  const botonEnviar = (
    <Boton
      variante="principal"
      grande
      icono="enviar"
      className="w-full"
      disabled={porEnviar.length === 0}
      onClick={enviar}
    >
      {porEnviar.length === 0 ? 'Enviar' : `Enviar ${porEnviar.length}`}
    </Boton>
  )
  const botonCuenta = (
    <Boton
      variante="secundario"
      grande
      icono="recibo"
      disabled={items.length === 0}
      onClick={pedirCuenta}
    >
      Cuenta
    </Boton>
  )

  return (
    <Marco titulo={`Mesa ${numero}`} volver="/bocetos/plano">
      <div className="mx-auto flex max-w-6xl gap-4 p-3 pb-28 md:pb-3">
        <section className="min-w-0 flex-1" aria-label="Carta">
          <label className="relative block">
            <span className="sr-only">Buscar en la carta</span>
            <Icono
              nombre="buscar"
              className="absolute top-1/2 left-3 -translate-y-1/2 text-texto-suave"
            />
            <input
              ref={campoBusqueda}
              type="search"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar: «hamburgesa», «aperol»…"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="min-h-12 w-full rounded-xl border border-borde bg-superficie pr-3 pl-11 text-lg placeholder:text-texto-suave focus-visible:outline-3 focus-visible:outline-foco"
            />
          </label>
          {!busqueda.trim() && (
            <Grupo
              etiqueta="Categorías"
              className="-mx-3 mt-3 flex gap-2 overflow-x-auto px-3 pb-1"
            >
              {carta.map((c) => (
                <Opcion
                  key={c.clave}
                  elegida={c.clave === categoria}
                  alElegir={() => setCategoria(c.clave)}
                >
                  {c.nombre}
                </Opcion>
              ))}
            </Grupo>
          )}
          <ul className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-3">
            {encontrados.slice(0, RESULTADOS).map((p) => {
              const cantidad = enPedido(p)
              return (
                <li key={p.clave}>
                  <button
                    type="button"
                    onClick={() => tocarProducto(p)}
                    className="relative flex min-h-20 w-full flex-col justify-between rounded-xl border border-borde bg-superficie p-3 text-left hover:bg-superficie-2 active:scale-[0.98] focus-visible:outline-3 focus-visible:outline-foco"
                  >
                    {cantidad > 0 && (
                      <span className="cifras absolute -top-2 -right-2 flex size-7 items-center justify-center rounded-full bg-accion-fuerte text-sm font-bold text-white">
                        {cantidad}
                        <span className="sr-only"> en el pedido</span>
                      </span>
                    )}
                    <span className="font-semibold leading-snug">{p.nombre}</span>
                    <span className="cifras mt-1 flex items-center justify-between text-texto-suave">
                      <span className="font-titulo text-lg">
                        {p.variantes.length > 0 ? `desde ${pesos(p.precio)}` : pesos(p.precio)}
                      </span>
                      {necesitaPanel(p) && (
                        <span className="text-sm whitespace-nowrap">opciones ›</span>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
            {encontrados.length === 0 && (
              <li className="col-span-full p-6 text-center text-texto-suave">
                No hay nada con «{busqueda}».
              </li>
            )}
            {encontrados.length > RESULTADOS && (
              <li className="col-span-full p-3 text-center text-texto-suave">
                {`Hay ${encontrados.length - RESULTADOS} más: escribe un poco más.`}
              </li>
            )}
          </ul>
        </section>

        {/* Tablet y caja: el pedido siempre a la vista. */}
        <aside className="sticky top-20 hidden h-[calc(100dvh-6rem)] w-96 shrink-0 flex-col rounded-2xl border border-borde bg-superficie md:flex">
          {ticket}
          <div className="flex gap-2 border-t border-borde p-3">
            {botonCuenta}
            <div className="flex-1">{botonEnviar}</div>
          </div>
        </aside>
      </div>

      {/* Celular: barra fija abajo, al alcance del pulgar. */}
      <div className="fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-borde bg-superficie p-3 md:hidden">
        <Boton
          variante="secundario"
          grande
          onClick={() => setVerPedido(true)}
          className="flex-1 flex-col gap-0! text-base! leading-tight"
        >
          <span>{`Pedido (${items.filter((i) => !i.anulado).length})`}</span>
          <span className="cifras font-titulo text-lg">{pesos(totalMesa(mesa))}</span>
        </Boton>
        <div className="flex-1">{botonEnviar}</div>
      </div>

      <PanelLateral
        abierto={verPedido}
        titulo={`Pedido · Mesa ${numero}`}
        alCerrar={() => setVerPedido(false)}
        pie={
          <div className="flex gap-2">
            {botonCuenta}
            <div className="flex-1">{botonEnviar}</div>
          </div>
        }
      >
        {ticket}
      </PanelLateral>

      <PanelProducto
        producto={elegido}
        comensal={comensal}
        alCerrar={() => setElegido(null)}
        alAgregar={(item) => {
          agregar(item)
          setElegido(null)
        }}
      />

      <PanelItem
        item={itemEditado}
        comensales={mesa.comensales}
        alCerrar={() => setEditando(null)}
        alGuardar={(item) => {
          cambiarMesa(numero, (m) => ({
            ...m,
            items: m.items.map((i) => (i.id === item.id ? item : i)),
          }))
          setEditando(null)
        }}
        alQuitar={(item) => {
          quitar(item)
          setEditando(null)
        }}
        alAnular={(item, motivo, yaPreparado) => {
          cambiarMesa(numero, (m) => ({
            ...m,
            items: m.items.map((i) =>
              i.id === item.id ? { ...i, anulado: { motivo, yaPreparado } } : i,
            ),
          }))
          avisar(`Anulaste ${nombreItem(item)} (${motivo.toLowerCase()})`)
          setEditando(null)
        }}
      />
    </Marco>
  )
}

function nuevo(
  p: ProductoCarta,
  variante: string | null,
  opciones: ItemPedido['opciones'],
  comensal: number | null,
  cantidad = 1,
  notas = '',
): ItemPedido {
  return {
    id: nuevoItemId(),
    producto: p,
    variante,
    opciones,
    precioUnitario: p.variantes.find((v) => v.nombre === variante)?.precio ?? p.precio,
    cantidad,
    comensal,
    notas,
    enviadoEn: null,
    despachado: false,
    anulado: null,
  }
}

function Ticket({
  mesa,
  comensal,
  alElegirComensal,
  alCambiarComensales,
  alTocarItem,
}: {
  mesa: Mesa
  comensal: number | null
  alElegirComensal: (c: number | null) => void
  alCambiarComensales: (n: number) => void
  alTocarItem: (i: ItemPedido) => void
}) {
  const { items, comensales } = mesa
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-borde p-3">
        <Icono nombre="personas" />
        <span className="font-semibold">{`${comensales} ${comensales === 1 ? 'persona' : 'personas'}`}</span>
        <Boton
          variante="fantasma"
          icono="menos"
          aria-label="Una persona menos"
          disabled={comensales <= 1}
          onClick={() => alCambiarComensales(comensales - 1)}
        />
        <Boton
          variante="fantasma"
          icono="mas"
          aria-label="Una persona más"
          onClick={() => alCambiarComensales(comensales + 1)}
        />
      </div>
      <Grupo
        etiqueta="Para quién es lo próximo que agregues"
        className="flex gap-2 overflow-x-auto border-b border-borde p-3"
      >
        {[null, ...Array.from({ length: comensales }, (_, i) => i + 1)].map((c) => (
          <Opcion
            key={c ?? 'mesa'}
            elegida={comensal === c}
            alElegir={() => alElegirComensal(c)}
            etiqueta={c === null ? 'Para la mesa' : `Para la persona ${c}`}
          >
            {c === null ? 'Mesa' : `P${c}`}
          </Opcion>
        ))}
      </Grupo>
      <ul className="flex-1 overflow-y-auto">
        {items.length === 0 && (
          <li className="p-6 text-center text-texto-suave">Toca un producto para agregarlo.</li>
        )}
        {items.map((i) => (
          <li key={i.id}>
            <button
              type="button"
              onClick={() => !i.anulado && alTocarItem(i)}
              className={`flex min-h-14 w-full items-start gap-3 border-b border-borde px-3 py-2 text-left hover:bg-superficie-2 ${i.anulado ? 'text-texto-suave' : ''}`}
            >
              <span className="cifras w-6 font-semibold">{i.cantidad}</span>
              <span className="flex-1">
                <span className={`font-semibold ${i.anulado ? 'line-through' : ''}`}>
                  {nombreItem(i)}
                </span>
                {i.opciones.length > 0 && (
                  <span className="block text-sm font-semibold text-proceso-texto">
                    {i.opciones.map((o) => o.nombre).join(' · ')}
                  </span>
                )}
                {i.notas && <span className="block text-sm text-texto-suave">«{i.notas}»</span>}
                <span className="block text-sm text-texto-suave">
                  {[
                    i.comensal ? `P${i.comensal}` : 'Mesa',
                    i.anulado
                      ? `anulado: ${i.anulado.motivo.toLowerCase()}`
                      : i.enviadoEn !== null
                        ? 'enviado'
                        : 'sin enviar',
                  ].join(' · ')}
                </span>
              </span>
              <span className={`cifras ${i.anulado ? 'line-through' : ''}`}>
                {pesos(netoLinea(lineaDe(i)))}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="cifras flex justify-between p-3 text-lg font-semibold">
        <span>Total</span>
        <span>{pesos(totalMesa(mesa))}</span>
      </div>
    </div>
  )
}

/** Opciones de un producto: variante, grupos obligatorios, cantidad y notas. */
function PanelProducto({
  producto,
  comensal,
  alCerrar,
  alAgregar,
}: {
  producto: ProductoCarta | null
  comensal: number | null
  alCerrar: () => void
  alAgregar: (item: ItemPedido) => void
}) {
  const [variante, setVariante] = useState<string | null>(null)
  const [opciones, setOpciones] = useState<Record<string, string>>({})
  const [cantidad, setCantidad] = useState(1)
  const [notas, setNotas] = useState('')
  const [abiertoPara, setAbiertoPara] = useState<string | null>(null)

  // Al abrir con otro producto, todo empieza de cero.
  if (producto && abiertoPara !== producto.clave) {
    setAbiertoPara(producto.clave)
    setVariante(null)
    setOpciones({})
    setCantidad(1)
    setNotas('')
  }
  if (!producto) return null

  const unaSola = elecciones(producto) === 1
  const elegidasDe = (o: Record<string, string>) =>
    producto.grupos.flatMap((g) => {
      const x = g.opciones.find((op) => op.nombre === o[g.clave])
      return x ? [x] : []
    })
  const faltan = [
    ...(producto.variantes.length > 0 && !variante ? ['tamaño'] : []),
    ...producto.grupos
      .filter((g) => g.minimo > 0 && !opciones[g.clave])
      .map((g) => g.nombre.toLowerCase()),
  ]
  const precio = producto.variantes.find((v) => v.nombre === variante)?.precio ?? producto.precio
  const neto = netoLinea({
    id: '',
    cantidad,
    precioUnitario: precio,
    extras: elegidasDe(opciones).map((o) => o.precioExtra),
  })

  const cerrar = () => {
    setAbiertoPara(null)
    alCerrar()
  }
  const agregarCon = (v: string | null, o: Record<string, string>) => {
    setAbiertoPara(null)
    alAgregar(nuevo(producto, v, elegidasDe(o), comensal, cantidad, notas.trim()))
  }

  return (
    <PanelLateral
      abierto
      titulo={producto.nombre}
      alCerrar={cerrar}
      pie={
        <Boton
          variante="principal"
          grande
          className="w-full"
          disabled={faltan.length > 0}
          onClick={() => agregarCon(variante, opciones)}
        >
          {faltan.length > 0 ? `Elige ${faltan[0]}` : `Agregar · ${pesos(neto)}`}
        </Boton>
      }
    >
      {producto.descripcion && <p className="mb-4 text-texto-suave">{producto.descripcion}</p>}
      {unaSola && (
        <p className="mb-3 text-sm text-texto-suave">Toca una opción y queda agregada.</p>
      )}
      {producto.variantes.length > 0 && (
        <ListaOpciones
          titulo="Tamaño"
          opciones={producto.variantes.map((v) => ({ nombre: v.nombre, detalle: pesos(v.precio) }))}
          elegida={variante}
          alElegir={(v) => (unaSola ? agregarCon(v, opciones) : setVariante(v))}
        />
      )}
      {producto.grupos.map((g: GrupoCarta) => (
        <ListaOpciones
          key={g.clave}
          titulo={`${g.nombre}${g.minimo > 0 ? ' (obligatorio)' : ''}`}
          opciones={g.opciones.map((o) => ({
            nombre: o.nombre,
            detalle: o.precioExtra ? `+${pesos(o.precioExtra)}` : '',
          }))}
          elegida={opciones[g.clave] ?? null}
          alElegir={(nombre) => {
            const nuevas = { ...opciones, [g.clave]: nombre }
            if (unaSola) agregarCon(variante, nuevas)
            else setOpciones(nuevas)
          }}
        />
      ))}
      <Cantidad valor={cantidad} alCambiar={setCantidad} />
      <label className="block">
        <span className="font-semibold">Notas para cocina</span>
        <input
          value={notas}
          onChange={(e) => setNotas(e.target.value)}
          placeholder="Sin cebolla, bien caliente…"
          className="mt-2 min-h-12 w-full rounded-xl border border-borde bg-superficie px-3 focus-visible:outline-3 focus-visible:outline-foco"
        />
      </label>
    </PanelLateral>
  )
}

function ListaOpciones({
  titulo,
  opciones,
  elegida,
  alElegir,
}: {
  titulo: string
  opciones: { nombre: string; detalle: string }[]
  elegida: string | null
  alElegir: (nombre: string) => void
}) {
  return (
    <fieldset className="mb-5 min-w-0 border-0 p-0">
      <legend className="mb-2 font-semibold">{titulo}</legend>
      <div className="grid grid-cols-2 gap-2">
        {opciones.map((o) => (
          <Opcion
            key={o.nombre}
            forma="tarjeta"
            elegida={elegida === o.nombre}
            detalle={o.detalle}
            alElegir={() => alElegir(o.nombre)}
          >
            {o.nombre}
          </Opcion>
        ))}
      </div>
    </fieldset>
  )
}

function Cantidad({ valor, alCambiar }: { valor: number; alCambiar: (n: number) => void }) {
  return (
    <div className="mb-5 flex items-center gap-3">
      <span className="font-semibold">Cantidad</span>
      <Boton
        icono="menos"
        aria-label="Uno menos"
        disabled={valor <= 1}
        onClick={() => alCambiar(valor - 1)}
      />
      <span className="cifras w-8 text-center text-xl font-semibold">{valor}</span>
      <Boton icono="mas" aria-label="Uno más" onClick={() => alCambiar(valor + 1)} />
    </div>
  )
}

/**
 * Un ítem del pedido. Sin enviar: cambiar cantidad, persona o notas, o quitarlo (con Deshacer).
 * Enviado: solo se anula, con motivo y confirmación, porque cocina ya lo tiene (brief §4.3).
 */
function PanelItem({
  item,
  comensales,
  alCerrar,
  alGuardar,
  alQuitar,
  alAnular,
}: {
  item: ItemPedido | null
  comensales: number
  alCerrar: () => void
  alGuardar: (item: ItemPedido) => void
  alQuitar: (item: ItemPedido) => void
  alAnular: (item: ItemPedido, motivo: string, yaPreparado: boolean) => void
}) {
  const [borrador, setBorrador] = useState<ItemPedido | null>(null)
  const [motivo, setMotivo] = useState<string | null>(null)
  const [yaPreparado, setYaPreparado] = useState(false)
  const [confirmando, setConfirmando] = useState(false)
  if (item && borrador?.id !== item.id) {
    setBorrador(item)
    setMotivo(null)
    setYaPreparado(false)
    setConfirmando(false)
  }
  if (!item || !borrador) return null
  const cerrar = () => {
    setBorrador(null)
    alCerrar()
  }

  if (item.enviadoEn !== null) {
    return (
      <PanelLateral
        abierto
        titulo={`Anular ${nombreItem(item)}`}
        alCerrar={cerrar}
        pie={
          confirmando ? (
            <div className="flex flex-col gap-2">
              <p className="font-semibold">{`¿Anular ${nombreItem(item)}? Queda registrado con el motivo.`}</p>
              <div className="flex gap-2">
                <Boton onClick={() => setConfirmando(false)}>Volver</Boton>
                <Boton
                  variante="peligro"
                  className="flex-1"
                  onClick={() => {
                    setBorrador(null)
                    alAnular(item, motivo as string, yaPreparado)
                  }}
                >
                  Sí, anular
                </Boton>
              </div>
            </div>
          ) : (
            <Boton
              variante="peligro"
              grande
              className="w-full"
              disabled={!motivo}
              onClick={() => setConfirmando(true)}
            >
              {motivo ? 'Anular' : 'Elige el motivo'}
            </Boton>
          )
        }
      >
        <p className="mb-4 text-texto-suave">
          Ya se envió a cocina o barra: no se puede quitar, solo anular. En la Fase 1 lo autoriza el
          gerente con su PIN y la cocina recibe una comanda de anulación.
        </p>
        <fieldset className="mb-5 min-w-0 border-0 p-0">
          <legend className="mb-2 font-semibold">Motivo</legend>
          <div className="grid grid-cols-2 gap-2">
            {MOTIVOS_ANULACION.map((m) => (
              <Opcion key={m} forma="tarjeta" elegida={motivo === m} alElegir={() => setMotivo(m)}>
                {m}
              </Opcion>
            ))}
          </div>
        </fieldset>
        <label className="flex min-h-12 items-center gap-3">
          <input
            type="checkbox"
            className="size-6"
            checked={yaPreparado}
            onChange={(e) => setYaPreparado(e.target.checked)}
          />
          Ya se había preparado (va como merma)
        </label>
      </PanelLateral>
    )
  }

  return (
    <PanelLateral
      abierto
      titulo={nombreItem(item)}
      alCerrar={cerrar}
      pie={
        <div className="flex gap-2">
          <Boton
            variante="peligro"
            icono="cerrar"
            onClick={() => {
              setBorrador(null)
              alQuitar(item)
            }}
          >
            Quitar
          </Boton>
          <Boton
            variante="principal"
            className="flex-1"
            onClick={() => {
              setBorrador(null)
              alGuardar(borrador)
            }}
          >
            Listo
          </Boton>
        </div>
      }
    >
      <Cantidad
        valor={borrador.cantidad}
        alCambiar={(cantidad) => setBorrador({ ...borrador, cantidad })}
      />
      <ListaOpciones
        titulo="Para"
        opciones={['Mesa', ...Array.from({ length: comensales }, (_, i) => `P${i + 1}`)].map(
          (nombre) => ({ nombre, detalle: '' }),
        )}
        elegida={borrador.comensal ? `P${borrador.comensal}` : 'Mesa'}
        alElegir={(n) =>
          setBorrador({ ...borrador, comensal: n === 'Mesa' ? null : Number(n.slice(1)) })
        }
      />
      <label className="block">
        <span className="font-semibold">Notas para cocina</span>
        <input
          value={borrador.notas}
          onChange={(e) => setBorrador({ ...borrador, notas: e.target.value })}
          className="mt-2 min-h-12 w-full rounded-xl border border-borde bg-superficie px-3 focus-visible:outline-3 focus-visible:outline-foco"
        />
      </label>
    </PanelLateral>
  )
}
