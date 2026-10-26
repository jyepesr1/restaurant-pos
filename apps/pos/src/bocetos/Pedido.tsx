import type { MenuGroup, MenuProduct } from '@pos/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { search } from '../ui/busqueda'
import { pesos } from '../ui/formato'
import { Icono } from '../ui/iconos'
import { Grupo, Opcion } from '../ui/Opciones'
import { PanelLateral } from '../ui/PanelLateral'
import { navegar } from '../ui/ruta'
import { netoLinea } from './cuenta'
import {
  type Mesa,
  MOTIVOS_ANULACION,
  menu,
  nuevoItemId,
  type OrderItem,
  products,
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
const elecciones = (p: MenuProduct) =>
  (p.variants.length > 0 ? 1 : 0) + p.groups.filter((g) => g.minimum > 0).length
const necesitaPanel = (p: MenuProduct) => p.variants.length > 0 || p.groups.length > 0

/** Dos ítems son la misma línea si son el mismo producto, igual, para la misma persona, sin enviar. */
const mismaLinea = (a: OrderItem, b: OrderItem) =>
  a.enviadoEn === null &&
  !a.voided &&
  a.product.key === b.product.key &&
  a.variant === b.variant &&
  a.guest === b.guest &&
  a.notes === b.notes &&
  JSON.stringify(a.options) === JSON.stringify(b.options)

/** Abrir la mesa al agregar el primer producto (no al tocarla en el plano). */
const ocupar = (m: Mesa): Mesa =>
  m.status === 'free' || m.status === 'reserved'
    ? { ...m, status: 'taking', abiertaEn: Date.now(), guests: 2, waiter: 'Mesero 1' }
    : m

export function Order() {
  const number = useMesaDeLaRuta(2)
  const table = useMesas().find((m) => m.number === number)
  const notify = useAvisar()
  const [busqueda, setBusqueda] = useState('')
  const [category, setCategoria] = useState(menu[0]?.key ?? '')
  const [guest, setComensal] = useState<number | null>(null)
  const [selectedProduct, setElegido] = useState<MenuProduct | null>(null)
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
        ? search(products, busqueda, (p) => textoDeBusqueda.get(p.key) ?? p.name)
        : (menu.find((c) => c.key === category)?.products ?? []),
    [busqueda, category],
  )

  // Si bajan las personas, lo elegido para una que ya no está vuelve a "Mesa".
  const guests = table?.guests ?? 0
  useEffect(() => {
    if (guest !== null && guest > guests) setComensal(null)
  }, [guest, guests])

  if (!table) return null
  const items = table.items
  const porEnviar = items.filter((i) => i.enviadoEn === null && !i.voided)
  const enPedido = (p: MenuProduct) =>
    porEnviar.filter((i) => i.product.key === p.key).reduce((s, i) => s + i.quantity, 0)

  const add = (fresh: OrderItem) => {
    const equal = items.find((i) => mismaLinea(i, fresh))
    if (equal) {
      cambiarMesa(number, (m) => ({
        ...m,
        items: m.items.map((i) =>
          i.id === equal.id ? { ...i, quantity: i.quantity + fresh.quantity } : i,
        ),
      }))
      notify(`${nombreItem(fresh)}: ${equal.quantity + fresh.quantity}`, () =>
        cambiarMesa(number, (m) => ({
          ...m,
          items: m.items.map((i) =>
            i.id === equal.id ? { ...i, quantity: i.quantity - fresh.quantity } : i,
          ),
        })),
      )
      return
    }
    const before = table
    cambiarMesa(number, (m) => ({ ...ocupar(m), items: [...m.items, fresh] }))
    notify(`Agregaste ${nombreItem(fresh)}`, () =>
      cambiarMesa(number, (m) =>
        m.items.length === 1 && before.items.length === 0
          ? before
          : { ...m, items: m.items.filter((i) => i.id !== fresh.id) },
      ),
    )
  }

  const tocarProducto = (p: MenuProduct) => {
    if (necesitaPanel(p)) setElegido(p)
    else add(fresh(p, null, [], guest))
  }

  const remove = (item: OrderItem) => {
    const placement = items.findIndex((i) => i.id === item.id)
    cambiarMesa(number, (m) => ({ ...m, items: m.items.filter((i) => i.id !== item.id) }))
    notify(`Quitaste ${nombreItem(item)}`, () =>
      cambiarMesa(number, (m) => {
        const copy = [...m.items]
        copy.splice(placement, 0, item)
        return { ...m, items: copy }
      }),
    )
  }

  const send = () => {
    if (porEnviar.length === 0) return
    const now = Date.now()
    cambiarMesa(number, (m) => ({
      ...m,
      status: 'in_kitchen',
      items: m.items.map((i) => (i.enviadoEn === null ? { ...i, enviadoEn: now } : i)),
    }))
    navigator.vibrate?.(60)
    notify(`Enviado a cocina y barra (${porEnviar.length})`)
    setVerPedido(false)
    navegar('/mockups/floor-plan')
  }

  const pedirCuenta = () => navegar(`/mockups/pre-bill?table=${number}`)
  const itemEditado = items.find((i) => i.id === editando) ?? null

  const ticket = (
    <Ticket
      table={table}
      guest={guest}
      alElegirComensal={setComensal}
      alCambiarComensales={(n) => cambiarMesa(number, (m) => ({ ...m, guests: n }))}
      alTocarItem={(i) => setEditando(i.id)}
    />
  )
  const botonEnviar = (
    <Boton
      variant="main"
      large
      icono="send"
      className="w-full"
      disabled={porEnviar.length === 0}
      onClick={send}
    >
      {porEnviar.length === 0 ? 'Enviar' : `Enviar ${porEnviar.length}`}
    </Boton>
  )
  const botonCuenta = (
    <Boton
      variant="secondary"
      large
      icono="receipt"
      disabled={items.length === 0}
      onClick={pedirCuenta}
    >
      Cuenta
    </Boton>
  )

  return (
    <Marco title={`Mesa ${number}`} back="/mockups/floor-plan">
      <div className="mx-auto flex max-w-6xl gap-4 p-3 pb-28 md:pb-3">
        <section className="min-w-0 flex-1" aria-label="Carta">
          <label className="relative block">
            <span className="sr-only">Buscar en la carta</span>
            <Icono
              name="search"
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
              {menu.map((c) => (
                <Opcion
                  key={c.key}
                  elegida={c.key === category}
                  alElegir={() => setCategoria(c.key)}
                >
                  {c.name}
                </Opcion>
              ))}
            </Grupo>
          )}
          <ul className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-3">
            {encontrados.slice(0, RESULTADOS).map((p) => {
              const quantity = enPedido(p)
              return (
                <li key={p.key}>
                  <button
                    type="button"
                    onClick={() => tocarProducto(p)}
                    className="relative flex min-h-20 w-full flex-col justify-between rounded-xl border border-borde bg-superficie p-3 text-left hover:bg-superficie-2 active:scale-[0.98] focus-visible:outline-3 focus-visible:outline-foco"
                  >
                    {quantity > 0 && (
                      <span className="cifras absolute -top-2 -right-2 flex size-7 items-center justify-center rounded-full bg-accion-fuerte text-sm font-bold text-white">
                        {quantity}
                        <span className="sr-only"> en el pedido</span>
                      </span>
                    )}
                    <span className="font-semibold leading-snug">{p.name}</span>
                    <span className="cifras mt-1 flex items-center justify-between text-texto-suave">
                      <span className="font-titulo text-lg">
                        {p.variants.length > 0 ? `desde ${pesos(p.price)}` : pesos(p.price)}
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
          variant="secondary"
          large
          onClick={() => setVerPedido(true)}
          className="flex-1 flex-col gap-0! text-base! leading-tight"
        >
          <span>{`Pedido (${items.filter((i) => !i.voided).length})`}</span>
          <span className="cifras font-titulo text-lg">{pesos(totalMesa(table))}</span>
        </Boton>
        <div className="flex-1">{botonEnviar}</div>
      </div>

      <PanelLateral
        opened={verPedido}
        title={`Pedido · Mesa ${number}`}
        onClose={() => setVerPedido(false)}
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
        product={selectedProduct}
        guest={guest}
        onClose={() => setElegido(null)}
        alAgregar={(item) => {
          add(item)
          setElegido(null)
        }}
      />

      <PanelItem
        item={itemEditado}
        guests={table.guests}
        onClose={() => setEditando(null)}
        onSave={(item) => {
          cambiarMesa(number, (m) => ({
            ...m,
            items: m.items.map((i) => (i.id === item.id ? item : i)),
          }))
          setEditando(null)
        }}
        alQuitar={(item) => {
          remove(item)
          setEditando(null)
        }}
        onVoid={(item, reason, alreadyPrepared) => {
          cambiarMesa(number, (m) => ({
            ...m,
            items: m.items.map((i) =>
              i.id === item.id ? { ...i, voided: { reason, alreadyPrepared } } : i,
            ),
          }))
          notify(`Anulaste ${nombreItem(item)} (${reason.toLowerCase()})`)
          setEditando(null)
        }}
      />
    </Marco>
  )
}

function fresh(
  p: MenuProduct,
  variant: string | null,
  options: OrderItem['options'],
  guest: number | null,
  quantity = 1,
  notes = '',
): OrderItem {
  return {
    id: nuevoItemId(),
    product: p,
    variant,
    options,
    unitPrice: p.variants.find((v) => v.name === variant)?.price ?? p.price,
    quantity,
    guest,
    notes,
    enviadoEn: null,
    despachado: false,
    voided: null,
  }
}

function Ticket({
  table,
  guest,
  alElegirComensal,
  alCambiarComensales,
  alTocarItem,
}: {
  table: Mesa
  guest: number | null
  alElegirComensal: (c: number | null) => void
  alCambiarComensales: (n: number) => void
  alTocarItem: (i: OrderItem) => void
}) {
  const { items, guests } = table
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-borde p-3">
        <Icono name="people" />
        <span className="font-semibold">{`${guests} ${guests === 1 ? 'persona' : 'personas'}`}</span>
        <Boton
          variant="ghost"
          icono="minus"
          aria-label="Una persona menos"
          disabled={guests <= 1}
          onClick={() => alCambiarComensales(guests - 1)}
        />
        <Boton
          variant="ghost"
          icono="more"
          aria-label="Una persona más"
          onClick={() => alCambiarComensales(guests + 1)}
        />
      </div>
      <Grupo
        etiqueta="Para quién es lo próximo que agregues"
        className="flex gap-2 overflow-x-auto border-b border-borde p-3"
      >
        {[null, ...Array.from({ length: guests }, (_, i) => i + 1)].map((c) => (
          <Opcion
            key={c ?? 'table'}
            elegida={guest === c}
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
              onClick={() => !i.voided && alTocarItem(i)}
              className={`flex min-h-14 w-full items-start gap-3 border-b border-borde px-3 py-2 text-left hover:bg-superficie-2 ${i.voided ? 'text-texto-suave' : ''}`}
            >
              <span className="cifras w-6 font-semibold">{i.quantity}</span>
              <span className="flex-1">
                <span className={`font-semibold ${i.voided ? 'line-through' : ''}`}>
                  {nombreItem(i)}
                </span>
                {i.options.length > 0 && (
                  <span className="block text-sm font-semibold text-proceso-texto">
                    {i.options.map((o) => o.name).join(' · ')}
                  </span>
                )}
                {i.notes && <span className="block text-sm text-texto-suave">«{i.notes}»</span>}
                <span className="block text-sm text-texto-suave">
                  {[
                    i.guest ? `P${i.guest}` : 'Mesa',
                    i.voided
                      ? `anulado: ${i.voided.reason.toLowerCase()}`
                      : i.enviadoEn !== null
                        ? 'enviado'
                        : 'sin enviar',
                  ].join(' · ')}
                </span>
              </span>
              <span className={`cifras ${i.voided ? 'line-through' : ''}`}>
                {pesos(netoLinea(lineaDe(i)))}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="cifras flex justify-between p-3 text-lg font-semibold">
        <span>Total</span>
        <span>{pesos(totalMesa(table))}</span>
      </div>
    </div>
  )
}

/** Opciones de un producto: variante, grupos obligatorios, cantidad y notas. */
function PanelProducto({
  product,
  guest,
  onClose,
  alAgregar,
}: {
  product: MenuProduct | null
  guest: number | null
  onClose: () => void
  alAgregar: (item: OrderItem) => void
}) {
  const [variant, setVariante] = useState<string | null>(null)
  const [options, setOpciones] = useState<Record<string, string>>({})
  const [quantity, setCantidad] = useState(1)
  const [notes, setNotas] = useState('')
  const [abiertoPara, setAbiertoPara] = useState<string | null>(null)

  // Al abrir con otro producto, todo empieza de cero.
  if (product && abiertoPara !== product.key) {
    setAbiertoPara(product.key)
    setVariante(null)
    setOpciones({})
    setCantidad(1)
    setNotas('')
  }
  if (!product) return null

  const unaSola = elecciones(product) === 1
  const elegidasDe = (o: Record<string, string>) =>
    product.groups.flatMap((g) => {
      const x = g.options.find((op) => op.name === o[g.key])
      return x ? [x] : []
    })
  const missingOnes = [
    ...(product.variants.length > 0 && !variant ? ['tamaño'] : []),
    ...product.groups
      .filter((g) => g.minimum > 0 && !options[g.key])
      .map((g) => g.name.toLowerCase()),
  ]
  const price = product.variants.find((v) => v.name === variant)?.price ?? product.price
  const net = netoLinea({
    id: '',
    quantity,
    unitPrice: price,
    extras: elegidasDe(options).map((o) => o.extraPrice),
  })

  const close = () => {
    setAbiertoPara(null)
    onClose()
  }
  const agregarCon = (v: string | null, o: Record<string, string>) => {
    setAbiertoPara(null)
    alAgregar(fresh(product, v, elegidasDe(o), guest, quantity, notes.trim()))
  }

  return (
    <PanelLateral
      opened
      title={product.name}
      onClose={close}
      pie={
        <Boton
          variant="main"
          large
          className="w-full"
          disabled={missingOnes.length > 0}
          onClick={() => agregarCon(variant, options)}
        >
          {missingOnes.length > 0 ? `Elige ${missingOnes[0]}` : `Agregar · ${pesos(net)}`}
        </Boton>
      }
    >
      {product.description && <p className="mb-4 text-texto-suave">{product.description}</p>}
      {unaSola && (
        <p className="mb-3 text-sm text-texto-suave">Toca una opción y queda agregada.</p>
      )}
      {product.variants.length > 0 && (
        <ListaOpciones
          title="Tamaño"
          options={product.variants.map((v) => ({ name: v.name, detalle: pesos(v.price) }))}
          elegida={variant}
          alElegir={(v) => (unaSola ? agregarCon(v, options) : setVariante(v))}
        />
      )}
      {product.groups.map((g: MenuGroup) => (
        <ListaOpciones
          key={g.key}
          title={`${g.name}${g.minimum > 0 ? ' (obligatorio)' : ''}`}
          options={g.options.map((o) => ({
            name: o.name,
            detalle: o.extraPrice ? `+${pesos(o.extraPrice)}` : '',
          }))}
          elegida={options[g.key] ?? null}
          alElegir={(name) => {
            const newOnes = { ...options, [g.key]: name }
            if (unaSola) agregarCon(variant, newOnes)
            else setOpciones(newOnes)
          }}
        />
      ))}
      <Quantity value={quantity} onChange={setCantidad} />
      <label className="block">
        <span className="font-semibold">Notas para cocina</span>
        <input
          value={notes}
          onChange={(e) => setNotas(e.target.value)}
          placeholder="Sin cebolla, bien caliente…"
          className="mt-2 min-h-12 w-full rounded-xl border border-borde bg-superficie px-3 focus-visible:outline-3 focus-visible:outline-foco"
        />
      </label>
    </PanelLateral>
  )
}

function ListaOpciones({
  title,
  options,
  elegida,
  alElegir,
}: {
  title: string
  options: { name: string; detalle: string }[]
  elegida: string | null
  alElegir: (name: string) => void
}) {
  return (
    <fieldset className="mb-5 min-w-0 border-0 p-0">
      <legend className="mb-2 font-semibold">{title}</legend>
      <div className="grid grid-cols-2 gap-2">
        {options.map((o) => (
          <Opcion
            key={o.name}
            shape="card"
            elegida={elegida === o.name}
            detalle={o.detalle}
            alElegir={() => alElegir(o.name)}
          >
            {o.name}
          </Opcion>
        ))}
      </div>
    </fieldset>
  )
}

function Quantity({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="mb-5 flex items-center gap-3">
      <span className="font-semibold">Cantidad</span>
      <Boton
        icono="minus"
        aria-label="Uno menos"
        disabled={value <= 1}
        onClick={() => onChange(value - 1)}
      />
      <span className="cifras w-8 text-center text-xl font-semibold">{value}</span>
      <Boton icono="more" aria-label="Uno más" onClick={() => onChange(value + 1)} />
    </div>
  )
}

/**
 * Un ítem del pedido. Sin enviar: cambiar cantidad, persona o notas, o quitarlo (con Deshacer).
 * Enviado: solo se anula, con motivo y confirmación, porque cocina ya lo tiene (brief §4.3).
 */
function PanelItem({
  item,
  guests,
  onClose,
  onSave,
  alQuitar,
  onVoid,
}: {
  item: OrderItem | null
  guests: number
  onClose: () => void
  onSave: (item: OrderItem) => void
  alQuitar: (item: OrderItem) => void
  onVoid: (item: OrderItem, reason: string, alreadyPrepared: boolean) => void
}) {
  const [borrador, setBorrador] = useState<OrderItem | null>(null)
  const [reason, setMotivo] = useState<string | null>(null)
  const [alreadyPrepared, setYaPreparado] = useState(false)
  const [confirmando, setConfirmando] = useState(false)
  if (item && borrador?.id !== item.id) {
    setBorrador(item)
    setMotivo(null)
    setYaPreparado(false)
    setConfirmando(false)
  }
  if (!item || !borrador) return null
  const close = () => {
    setBorrador(null)
    onClose()
  }

  if (item.enviadoEn !== null) {
    return (
      <PanelLateral
        opened
        title={`Anular ${nombreItem(item)}`}
        onClose={close}
        pie={
          confirmando ? (
            <div className="flex flex-col gap-2">
              <p className="font-semibold">{`¿Anular ${nombreItem(item)}? Queda registrado con el motivo.`}</p>
              <div className="flex gap-2">
                <Boton onClick={() => setConfirmando(false)}>Volver</Boton>
                <Boton
                  variant="danger"
                  className="flex-1"
                  onClick={() => {
                    setBorrador(null)
                    onVoid(item, reason as string, alreadyPrepared)
                  }}
                >
                  Sí, anular
                </Boton>
              </div>
            </div>
          ) : (
            <Boton
              variant="danger"
              large
              className="w-full"
              disabled={!reason}
              onClick={() => setConfirmando(true)}
            >
              {reason ? 'Anular' : 'Elige el motivo'}
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
              <Opcion key={m} shape="card" elegida={reason === m} alElegir={() => setMotivo(m)}>
                {m}
              </Opcion>
            ))}
          </div>
        </fieldset>
        <label className="flex min-h-12 items-center gap-3">
          <input
            type="checkbox"
            className="size-6"
            checked={alreadyPrepared}
            onChange={(e) => setYaPreparado(e.target.checked)}
          />
          Ya se había preparado (va como merma)
        </label>
      </PanelLateral>
    )
  }

  return (
    <PanelLateral
      opened
      title={nombreItem(item)}
      onClose={close}
      pie={
        <div className="flex gap-2">
          <Boton
            variant="danger"
            icono="close"
            onClick={() => {
              setBorrador(null)
              alQuitar(item)
            }}
          >
            Quitar
          </Boton>
          <Boton
            variant="main"
            className="flex-1"
            onClick={() => {
              setBorrador(null)
              onSave(borrador)
            }}
          >
            Listo
          </Boton>
        </div>
      }
    >
      <Quantity
        value={borrador.quantity}
        onChange={(quantity) => setBorrador({ ...borrador, quantity })}
      />
      <ListaOpciones
        title="Para"
        options={['Mesa', ...Array.from({ length: guests }, (_, i) => `P${i + 1}`)].map((name) => ({
          name,
          detalle: '',
        }))}
        elegida={borrador.guest ? `P${borrador.guest}` : 'Mesa'}
        alElegir={(n) =>
          setBorrador({ ...borrador, guest: n === 'Mesa' ? null : Number(n.slice(1)) })
        }
      />
      <label className="block">
        <span className="font-semibold">Notas para cocina</span>
        <input
          value={borrador.notes}
          onChange={(e) => setBorrador({ ...borrador, notes: e.target.value })}
          className="mt-2 min-h-12 w-full rounded-xl border border-borde bg-superficie px-3 focus-visible:outline-3 focus-visible:outline-foco"
        />
      </label>
    </PanelLateral>
  )
}
